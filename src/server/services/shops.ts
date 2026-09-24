/**
 * Shop service (requirements §8–§10, §15–§16).
 *
 * Two invariants are enforced here and nowhere else:
 *   - A shop is publicly visible only when APPROVED.
 *   - Kesari/Green classification is writable only by OPERATOR/ADMIN, and every
 *     change is recorded with who/when/why.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import type { ShopTypeKey } from "@/lib/shop-types";
import { db } from "@/server/db";
import {
  referralCodes,
  shopClassificationHistory,
  shops,
  users,
  type Classification,
  type FeePaymentStatus,
  type Shop,
  type ShopStatus,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { uniqueSlug } from "./catalogue";
import { resolveLocationVerification } from "./geocoding";
import { attributeShopToCode } from "./referrals";
import { resolveFeeForNewRegistration } from "./registration-fees";

export interface RegisterShopInput {
  name: string;
  ownerName: string;
  phone: string;
  email?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  area?: string | null;
  city: string;
  state?: string | null;
  pincode: string;
  latitude?: string | null;
  longitude?: string | null;
  /** Pickup point, if it differs from the main location (e.g. a mall unit vs. its service entrance). */
  pickupLatitude?: string | null;
  pickupLongitude?: string | null;
  pickupInstructions?: string | null;
  landmark?: string | null;
  shopType: ShopTypeKey;
  logoUrl?: string | null;
  photos?: string[];
  openingHours?: { day: number; open: string; close: string; closed?: boolean }[];
  deliveryAvailable?: boolean;
  deliveryFeePaise?: number;
  freeDeliveryAbovePaise?: number | null;
  description?: string | null;

  /* ------------------------------------------- operator-only fields (§4.1) */
  /**
   * Register the shop on behalf of this user instead of the caller. Honoured
   * only when `privileged` is set — a customer registering their own shop can
   * never populate it, which is what stops a shop being planted on someone else.
   */
  ownerId?: string;
  /** Overrides the fee snapshot taken from the active schedule. */
  registrationFeePaise?: number;
  referralCode?: string | null;
  registrationDate?: string | null;
}

/**
 * Submits a shop registration. Always lands in PENDING_APPROVAL — the caller
 * cannot choose a status, and classification is left null for an operator to
 * assign at approval time (§8, §10).
 */
export async function registerShop(
  input: RegisterShopInput,
  actor: { id: string; role: UserRole },
  /**
   * Set when the caller holds SHOP_REGISTRATION_MANAGE. Only then are the
   * operator-only fields (owner, fee override, referral code) honoured; for a
   * self-service registration they are ignored entirely rather than rejected,
   * so a crafted request body cannot escalate.
   */
  options: { privileged?: boolean } = {},
): Promise<Shop> {
  if (!/^\d{6}$/.test(input.pincode)) {
    throw validationFailed("PIN code must be exactly 6 digits.");
  }
  if (!/^[6-9]\d{9}$/.test(input.phone)) {
    throw validationFailed("Enter a valid 10-digit Indian mobile number.");
  }

  // Never trust a caller-supplied "verified" flag — status is always
  // computed here from whether Google actually confirmed the pin.
  const { locationVerified, locationVerifiedAt, locationSource } =
    await resolveLocationVerification(
      input.latitude != null ? Number(input.latitude) : null,
      input.longitude != null ? Number(input.longitude) : null,
      "shop_registration",
      "shop",
    );

  const privileged = options.privileged === true;
  const ownerId = privileged && input.ownerId ? input.ownerId : actor.id;

  if (privileged && input.ownerId) {
    const owner = await db.query.users.findFirst({
      where: eq(users.id, input.ownerId),
      columns: { id: true },
    });
    if (!owner) throw notFound("Owner");
  }

  // The fee is SNAPSHOTTED here (§12): a later change to the schedule must
  // never alter what this shop was charged.
  const scheduled = await resolveFeeForNewRegistration();
  const registrationFeePaise =
    privileged && input.registrationFeePaise !== undefined
      ? input.registrationFeePaise
      : scheduled.amountPaise;

  if (registrationFeePaise < 0 || !Number.isInteger(registrationFeePaise)) {
    throw validationFailed("Registration fee must be a whole number of paise.");
  }

  const [shop] = await db
    .insert(shops)
    .values({
      ownerId,
      registrationDate:
        (privileged ? input.registrationDate : null) ??
        new Date().toISOString().slice(0, 10),
      registrationFeePaise,
      registrationFeeId: scheduled.feeId,
      feePaymentStatus: registrationFeePaise > 0 ? "PENDING" : "PAID",
      name: input.name.trim(),
      slug: uniqueSlug(input.name),
      ownerName: input.ownerName.trim(),
      phone: input.phone,
      email: input.email ?? null,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2 ?? null,
      area: input.area ?? null,
      city: input.city,
      state: input.state ?? null,
      pincode: input.pincode,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      pickupLatitude: input.pickupLatitude ?? null,
      pickupLongitude: input.pickupLongitude ?? null,
      pickupInstructions: input.pickupInstructions ?? null,
      landmark: input.landmark ?? null,
      locationVerified,
      locationVerifiedAt,
      locationSource,
      shopType: input.shopType,
      logoUrl: input.logoUrl ?? null,
      photos: input.photos ?? [],
      openingHours: input.openingHours ?? [],
      deliveryAvailable: input.deliveryAvailable ?? false,
      deliveryFeePaise: input.deliveryFeePaise ?? 0,
      freeDeliveryAbovePaise: input.freeDeliveryAbovePaise ?? null,
      description: input.description ?? null,
      // Status and classification are deliberately NOT taken from input.
      status: "PENDING_APPROVAL",
      classification: null,
    })
    .returning();

  // Registering a shop promotes a plain customer to SHOP_OWNER — whether they
  // registered it themselves or an operator registered it for them. Operators
  // and admins keep their higher role.
  const [owner] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (owner?.role === "CUSTOMER") {
    await db
      .update(users)
      .set({ role: "SHOP_OWNER", updatedAt: new Date() })
      .where(eq(users.id, ownerId));
  }

  if (privileged && input.referralCode) {
    await attributeShopToCode(shop.id, input.referralCode, actor);
  }

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_REGISTERED,
    entityType: "shop",
    entityId: shop.id,
    newValue: {
      name: shop.name,
      shopType: shop.shopType,
      ownerId,
      registrationNumber: shop.registrationNumber,
      registrationFeePaise: shop.registrationFeePaise,
      onBehalf: ownerId !== actor.id,
    },
  });
  return shop;
}

/**
 * Updates the administrative registration fields the owner may read but never
 * write (§2.5). Requires SHOP_REGISTRATION_MANAGE.
 *
 * The fee is intentionally editable here — an operator correcting a
 * mis-recorded fee is legitimate — but every change is audited, and it never
 * rewrites payments already recorded against the shop.
 */
export async function updateShopRegistration(
  shopId: string,
  patch: {
    registrationFeePaise?: number;
    registrationDate?: string | null;
    feePaymentStatus?: FeePaymentStatus;
    referralCode?: string | null;
  },
  actor: { id: string; role: UserRole },
): Promise<Shop> {
  const current = await db.query.shops.findFirst({
    where: and(eq(shops.id, shopId), isNull(shops.deletedAt)),
  });
  if (!current) throw notFound("Shop");

  if (
    patch.registrationFeePaise !== undefined &&
    (!Number.isInteger(patch.registrationFeePaise) ||
      patch.registrationFeePaise < 0)
  ) {
    throw validationFailed("Registration fee must be a whole number of paise.");
  }

  const [updated] = await db
    .update(shops)
    .set({
      ...(patch.registrationFeePaise !== undefined
        ? { registrationFeePaise: patch.registrationFeePaise }
        : {}),
      ...(patch.registrationDate !== undefined
        ? { registrationDate: patch.registrationDate }
        : {}),
      ...(patch.feePaymentStatus !== undefined
        ? { feePaymentStatus: patch.feePaymentStatus }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning();

  if (patch.referralCode) {
    await attributeShopToCode(shopId, patch.referralCode, actor);
  }

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_UPDATED,
    entityType: "shop",
    entityId: shopId,
    previousValue: {
      registrationFeePaise: current.registrationFeePaise,
      registrationDate: current.registrationDate,
      feePaymentStatus: current.feePaymentStatus,
    },
    newValue: {
      registrationFeePaise: updated.registrationFeePaise,
      registrationDate: updated.registrationDate,
      feePaymentStatus: updated.feePaymentStatus,
      referralCode: patch.referralCode ?? null,
    },
  });
  return updated;
}

/**
 * Sets a shop's seller-transparency and food-compliance fields (Part 58 —
 * Consumer Protection (E-Commerce) Rules 2020, and FSSAI licensing for
 * food-category shops).
 *
 * Deliberately admin/operator-only (SHOP_COMPLIANCE_MANAGE), not owner-
 * editable: a GSTIN or FSSAI number is a verifiable regulatory credential,
 * not a free-text profile field, so it goes through the same review-gated
 * path as classification (§10) rather than the owner's own shop-settings
 * form.
 */
export async function updateShopCompliance(
  shopId: string,
  patch: {
    legalBusinessName?: string | null;
    gstin?: string | null;
    fssaiLicenseNumber?: string | null;
    returnPolicyText?: string | null;
  },
  actor: { id: string; role: UserRole },
): Promise<Shop> {
  const current = await db.query.shops.findFirst({
    where: and(eq(shops.id, shopId), isNull(shops.deletedAt)),
  });
  if (!current) throw notFound("Shop");

  if (patch.gstin && !/^[0-9A-Z]{15}$/.test(patch.gstin)) {
    throw validationFailed("GSTIN must be 15 alphanumeric characters.");
  }

  const [updated] = await db
    .update(shops)
    .set({
      ...(patch.legalBusinessName !== undefined
        ? { legalBusinessName: patch.legalBusinessName }
        : {}),
      ...(patch.gstin !== undefined ? { gstin: patch.gstin } : {}),
      ...(patch.fssaiLicenseNumber !== undefined
        ? { fssaiLicenseNumber: patch.fssaiLicenseNumber }
        : {}),
      ...(patch.returnPolicyText !== undefined
        ? { returnPolicyText: patch.returnPolicyText }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_COMPLIANCE_UPDATED,
    entityType: "shop",
    entityId: shopId,
    previousValue: {
      legalBusinessName: current.legalBusinessName,
      gstin: current.gstin,
      fssaiLicenseNumber: current.fssaiLicenseNumber,
    },
    newValue: {
      legalBusinessName: updated.legalBusinessName,
      gstin: updated.gstin,
      fssaiLicenseNumber: updated.fssaiLicenseNumber,
    },
  });
  return updated;
}

/* ------------------------------------------------------------- approval */

export async function approveShop(
  shopId: string,
  input: { classification: Classification },
  actor: { id: string; role: UserRole },
): Promise<Shop> {
  return db.transaction(async (tx) => {
    const [shop] = await tx
      .select()
      .from(shops)
      .where(eq(shops.id, shopId))
      .for("update");
    if (!shop) throw notFound("Shop");
    if (shop.status === "APPROVED") {
      throw conflict("This shop is already approved.");
    }

    const [updated] = await tx
      .update(shops)
      .set({
        status: "APPROVED",
        classification: input.classification,
        approvedAt: new Date(),
        approvedBy: actor.id,
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(shops.id, shopId))
      .returning();

    await tx.insert(shopClassificationHistory).values({
      shopId,
      previousValue: shop.classification,
      newValue: input.classification,
      changedBy: actor.id,
      reason: "Assigned at approval",
    });

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_APPROVED,
        entityType: "shop",
        entityId: shopId,
        previousValue: { status: shop.status },
        newValue: { status: "APPROVED", classification: input.classification },
      },
      tx,
    );
    return updated;
  });
}

export async function rejectShop(
  shopId: string,
  reason: string,
  actor: { id: string; role: UserRole },
): Promise<Shop> {
  if (!reason.trim()) {
    throw validationFailed("A rejection reason is required.");
  }
  const [updated] = await db
    .update(shops)
    .set({ status: "REJECTED", rejectionReason: reason, updatedAt: new Date() })
    .where(eq(shops.id, shopId))
    .returning();
  if (!updated) throw notFound("Shop");

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_REJECTED,
    entityType: "shop",
    entityId: shopId,
    newValue: { status: "REJECTED", reason },
  });
  return updated;
}

export async function setShopStatus(
  shopId: string,
  status: ShopStatus,
  actor: { id: string; role: UserRole },
  reason?: string,
): Promise<Shop> {
  const [updated] = await db
    .update(shops)
    .set({ status, updatedAt: new Date() })
    .where(eq(shops.id, shopId))
    .returning();
  if (!updated) throw notFound("Shop");

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_SUSPENDED,
    entityType: "shop",
    entityId: shopId,
    newValue: { status, reason },
  });
  return updated;
}

/**
 * Editable subset of a shop's own details — name/contact/address, shop type,
 * opening hours ("shop time"), delivery settings. Status and classification
 * are deliberately excluded: those stay operator/admin-only (§8, §10).
 */
export interface UpdateShopInput {
  name?: string;
  ownerName?: string;
  phone?: string;
  email?: string | null;
  addressLine1?: string;
  addressLine2?: string | null;
  area?: string | null;
  city?: string;
  state?: string | null;
  pincode?: string;
  latitude?: string | null;
  longitude?: string | null;
  pickupLatitude?: string | null;
  pickupLongitude?: string | null;
  pickupInstructions?: string | null;
  landmark?: string | null;
  shopType?: ShopTypeKey;
  logoUrl?: string | null;
  photos?: string[];
  openingHours?: { day: number; open: string; close: string; closed?: boolean }[];
  deliveryAvailable?: boolean;
  deliveryFeePaise?: number;
  freeDeliveryAbovePaise?: number | null;
  /** GS-010 delivery zone, km from the shop pin (1-50). */
  serviceRadiusKm?: number;
  description?: string | null;
}

/** Updates a shop's own editable details, e.g. opening hours (§9 shop time). */
export async function updateShop(
  shopId: string,
  input: UpdateShopInput,
  actor: { id: string; role: UserRole },
): Promise<Shop> {
  if (input.pincode && !/^\d{6}$/.test(input.pincode)) {
    throw validationFailed("PIN code must be exactly 6 digits.");
  }
  if (input.phone && !/^[6-9]\d{9}$/.test(input.phone)) {
    throw validationFailed("Enter a valid 10-digit Indian mobile number.");
  }
  if (
    input.serviceRadiusKm !== undefined &&
    (!Number.isInteger(input.serviceRadiusKm) || input.serviceRadiusKm < 1 || input.serviceRadiusKm > 50)
  ) {
    throw validationFailed("Delivery radius must be a whole number of km between 1 and 50.");
  }

  const [current] = await db
    .select()
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!current) throw notFound("Shop");

  // Only re-verify (and only touch the verification columns) when the main
  // coordinates actually moved — per the "the old location must not continue
  // to be used" rule, this is the one path that can flip locationVerified
  // back to false: a changed pin that fails/skips re-verification means the
  // shop is no longer using a confirmed location for new orders.
  const coordinatesChanged =
    input.latitude !== undefined &&
    input.longitude !== undefined &&
    (input.latitude !== current.latitude || input.longitude !== current.longitude);
  const verification = coordinatesChanged
    ? await resolveLocationVerification(
        input.latitude != null ? Number(input.latitude) : null,
        input.longitude != null ? Number(input.longitude) : null,
        "shop_location_update",
        "shop",
        shopId,
      )
    : null;

  const [updated] = await db
    .update(shops)
    .set({
      ...input,
      ...(verification ?? {}),
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_UPDATED,
    entityType: "shop",
    entityId: shopId,
    previousValue: {
      openingHours: current.openingHours,
      shopType: current.shopType,
      serviceRadiusKm: current.serviceRadiusKm,
      ...(coordinatesChanged
        ? { latitude: current.latitude, longitude: current.longitude, locationVerified: current.locationVerified }
        : {}),
    },
    newValue: {
      openingHours: updated.openingHours,
      shopType: updated.shopType,
      serviceRadiusKm: updated.serviceRadiusKm,
      ...(coordinatesChanged
        ? { latitude: updated.latitude, longitude: updated.longitude, locationVerified: updated.locationVerified }
        : {}),
    },
  });
  return updated;
}

/* ------------------------------------------------------ classification */

/**
 * Changes Kesari/Green (§10).
 *
 * The capability check lives in the route guard, but this function refuses a
 * SHOP_OWNER outright as defence in depth — a mis-wired route must not be able
 * to let an owner reclassify their own shop.
 */
export async function changeClassification(
  shopId: string,
  newValue: Classification,
  reason: string,
  actor: { id: string; role: UserRole },
): Promise<Shop> {
  if (actor.role !== "OPERATOR" && actor.role !== "ADMIN") {
    throw forbidden("Only an operator or administrator can change this.");
  }
  if (!reason.trim()) {
    throw validationFailed("A reason is required when changing classification.");
  }

  return db.transaction(async (tx) => {
    const [shop] = await tx
      .select()
      .from(shops)
      .where(eq(shops.id, shopId))
      .for("update");
    if (!shop) throw notFound("Shop");
    if (shop.classification === newValue) {
      throw conflict(`This shop is already classified as ${newValue}.`);
    }

    const [updated] = await tx
      .update(shops)
      .set({ classification: newValue, updatedAt: new Date() })
      .where(eq(shops.id, shopId))
      .returning();

    await tx.insert(shopClassificationHistory).values({
      shopId,
      previousValue: shop.classification,
      newValue,
      changedBy: actor.id,
      reason,
    });

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_CLASSIFICATION_CHANGED,
        entityType: "shop",
        entityId: shopId,
        previousValue: { classification: shop.classification },
        newValue: { classification: newValue, reason },
      },
      tx,
    );
    return updated;
  });
}

export async function getClassificationHistory(shopId: string) {
  return db
    .select({
      id: shopClassificationHistory.id,
      previousValue: shopClassificationHistory.previousValue,
      newValue: shopClassificationHistory.newValue,
      reason: shopClassificationHistory.reason,
      createdAt: shopClassificationHistory.createdAt,
      changedByName: users.name,
      changedByEmail: users.email,
    })
    .from(shopClassificationHistory)
    .innerJoin(users, eq(shopClassificationHistory.changedBy, users.id))
    .where(eq(shopClassificationHistory.shopId, shopId))
    .orderBy(desc(shopClassificationHistory.createdAt));
}

/* ----------------------------------------------------------- retrieval */

export async function getShopById(shopId: string): Promise<Shop | undefined> {
  return db.query.shops.findFirst({
    where: and(eq(shops.id, shopId), isNull(shops.deletedAt)),
  });
}

export async function getPublicShopBySlug(
  slug: string,
): Promise<Shop | undefined> {
  return db.query.shops.findFirst({
    where: and(
      eq(shops.slug, slug),
      eq(shops.status, "APPROVED"),
      isNull(shops.deletedAt),
    ),
  });
}

export async function listShopsForOwner(ownerId: string): Promise<Shop[]> {
  return db
    .select()
    .from(shops)
    .where(and(eq(shops.ownerId, ownerId), isNull(shops.deletedAt)))
    .orderBy(desc(shops.createdAt));
}

export interface ShopSearchFilters {
  query?: string;
  city?: string;
  area?: string;
  pincode?: string;
  shopType?: ShopTypeKey;
  classification?: Classification;
  deliveryOnly?: boolean;
  /** Only these shops — e.g. the ones that deliver to the customer (serviceability.ts). */
  ids?: readonly string[];
  limit?: number;
  offset?: number;
}

/** Public shop search (§15). Only APPROVED shops are ever returned. */
export async function searchShops(
  filters: ShopSearchFilters = {},
): Promise<Shop[]> {
  if (filters.ids && filters.ids.length === 0) return [];
  const conditions = [
    eq(shops.status, "APPROVED"),
    isNull(shops.deletedAt),
  ];
  if (filters.ids) conditions.push(inArray(shops.id, [...filters.ids]));

  if (filters.query) {
    const term = `%${filters.query}%`;
    conditions.push(
      or(
        ilike(shops.name, term),
        ilike(shops.area, term),
        ilike(shops.city, term),
        ilike(shops.description, term),
      )!,
    );
  }
  if (filters.city) conditions.push(ilike(shops.city, `%${filters.city}%`));
  if (filters.area) conditions.push(ilike(shops.area, `%${filters.area}%`));
  if (filters.pincode) conditions.push(eq(shops.pincode, filters.pincode));
  if (filters.classification) {
    conditions.push(eq(shops.classification, filters.classification));
  }
  if (filters.deliveryOnly) {
    conditions.push(eq(shops.deliveryAvailable, true));
  }
  if (filters.shopType) {
    conditions.push(eq(shops.shopType, filters.shopType));
  }

  return db
    .select()
    .from(shops)
    .where(and(...conditions))
    .orderBy(asc(shops.name))
    .limit(Math.min(filters.limit ?? 24, 100))
    .offset(filters.offset ?? 0);
}

export interface AdminShopFilters {
  query?: string;
  status?: ShopStatus;
  shopType?: ShopTypeKey;
  classification?: Classification;
  feePaymentStatus?: FeePaymentStatus;
  /** Exact registration fee, e.g. "shops where fee = ₹5,000" (§13). */
  registrationFeePaise?: number;
  registrationFeeMinPaise?: number;
  registrationFeeMaxPaise?: number;
  /** "shops where amount paid < registration fee" (§13). */
  underpaidOnly?: boolean;
  referralCode?: string;
  registeredFrom?: string;
  registeredTo?: string;
  limit?: number;
  offset?: number;
}

/**
 * Administrative shop search (§13).
 *
 * Distinct from `searchShops` on purpose: that one is the *public* storefront
 * search and must only ever return APPROVED shops. This one spans every status
 * and exposes financial columns, so it is reachable only behind
 * REPORT_VIEW_OPERATIONAL / SHOP_REGISTRATION_MANAGE.
 */
export async function searchShopsAdmin(filters: AdminShopFilters = {}): Promise<
  (Shop & { referralCode: string | null })[]
> {
  const conditions = [isNull(shops.deletedAt)];

  if (filters.query) {
    const term = `%${filters.query}%`;
    conditions.push(
      or(
        ilike(shops.name, term),
        ilike(shops.ownerName, term),
        ilike(shops.phone, term),
        ilike(shops.registrationNumber, term),
        ilike(shops.city, term),
      )!,
    );
  }
  if (filters.status) conditions.push(eq(shops.status, filters.status));
  if (filters.shopType) conditions.push(eq(shops.shopType, filters.shopType));
  if (filters.classification) {
    conditions.push(eq(shops.classification, filters.classification));
  }
  if (filters.feePaymentStatus) {
    conditions.push(eq(shops.feePaymentStatus, filters.feePaymentStatus));
  }
  if (filters.registrationFeePaise !== undefined) {
    conditions.push(eq(shops.registrationFeePaise, filters.registrationFeePaise));
  }
  if (filters.registrationFeeMinPaise !== undefined) {
    conditions.push(
      gte(shops.registrationFeePaise, filters.registrationFeeMinPaise),
    );
  }
  if (filters.registrationFeeMaxPaise !== undefined) {
    conditions.push(
      lte(shops.registrationFeePaise, filters.registrationFeeMaxPaise),
    );
  }
  if (filters.underpaidOnly) {
    conditions.push(
      sql`${shops.amountPaidPaise} < COALESCE(${shops.registrationFeePaise}, 0)`,
    );
  }
  if (filters.registeredFrom) {
    conditions.push(gte(shops.registrationDate, filters.registeredFrom));
  }
  if (filters.registeredTo) {
    conditions.push(lte(shops.registrationDate, filters.registeredTo));
  }
  if (filters.referralCode) {
    conditions.push(ilike(referralCodes.code, filters.referralCode));
  }

  const rows = await db
    .select({ shop: shops, referralCode: referralCodes.code })
    .from(shops)
    .leftJoin(referralCodes, eq(referralCodes.id, shops.referralCodeId))
    .where(and(...conditions))
    .orderBy(desc(shops.createdAt))
    .limit(Math.min(filters.limit ?? 100, 500))
    .offset(filters.offset ?? 0);

  return rows.map((r) => ({ ...r.shop, referralCode: r.referralCode }));
}

export async function listShopsByStatus(status: ShopStatus): Promise<Shop[]> {
  return db
    .select()
    .from(shops)
    .where(and(eq(shops.status, status), isNull(shops.deletedAt)))
    .orderBy(desc(shops.createdAt));
}

/** Whether the shop is open right now, per its configured opening hours. */
export { isShopOpenNow } from "@/lib/shop-hours";

export async function countShopsByStatus(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: shops.status, count: sql<number>`count(*)::int` })
    .from(shops)
    .where(isNull(shops.deletedAt))
    .groupBy(shops.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
