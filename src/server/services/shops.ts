/**
 * Shop service (requirements §8–§10, §15–§16).
 *
 * Two invariants are enforced here and nowhere else:
 *   - A shop is publicly visible only when APPROVED.
 *   - Kesari/Green classification is writable only by OPERATOR/ADMIN, and every
 *     change is recorded with who/when/why.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { parseGstin } from "@/lib/shop-identity";
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
import { grantRole } from "./roles";
import { uniqueSlug } from "./catalogue";
import { resolveLocationVerification } from "./geocoding";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { attributeShopToCode } from "./referrals";
import { applyShopCategories } from "./shop-categories";
import { resolveFeeForNewRegistration } from "./registration-fees";
import { getRule } from "./settings";
import { missingMandatoryDocuments, onboardingApprovalBlocker } from "./shop-onboarding";
import { assertLegalDocsAllowApproval } from "./legal-documents";
import { emitEvent } from "@/server/events/emit";
import {
  duplicateShopError,
  findRegistrationMatches,
  isShopActUniqueViolation,
  lockRegistrationKeys,
  maskedIdentifiers,
  parseShopIdentifiers,
  recordDuplicateBlocked,
  shopIdentityColumns,
  type DuplicateMatch,
  type DuplicateMatchReason,
  type RegistrationCandidate,
} from "./shop-duplicates";

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
  /** Shop categories chosen by the owner (many per shop). POST /api/shops requires at least one. */
  categoryIds?: string[];
  logoUrl?: string | null;
  photos?: string[];
  openingHours?: { day: number; open: string; close: string; closed?: boolean }[];
  deliveryAvailable?: boolean;
  deliveryFeePaise?: number;
  freeDeliveryAbovePaise?: number | null;
  description?: string | null;

  /* --------------------------- business identifiers (shop-duplicates.ts).
   * Each optional here; POST /api/shops requires at least one. Checked
   * against every existing registration before a new one is created. */
  /** Shop Act / Gumasta licence number. */
  shopActNumber?: string | null;
  /** Encrypted at rest; compared only through its blind index. */
  panNumber?: string | null;
  /** Name on the PAN card — required with panNumber, as on the /shop PAN form. */
  panHolderName?: string | null;
  /** Udyam number, or an old Udyog Aadhaar number. */
  udyamNumber?: string | null;
  /** GSTIN, self-declared at registration — queued for GST verification like the /shop GST form. */
  gstin?: string | null;

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
 * A registration result. `resubmitted` is true when the account's own
 * REJECTED registration of the same shop was updated and sent back for
 * review, instead of a new shop being created.
 */
export type RegisterShopResult = Shop & { resubmitted: boolean };

/**
 * Columns a shop row carries for the platform's own use: the PAN ciphertext
 * and its blind index, the Shop Act matching key, and staff and internal ids.
 * No API response sends them, not even to the shop's owner or staff — their
 * screens show the masked PAN (`panLast4`) and the statuses instead.
 */
const INTERNAL_SHOP_KEYS = [
  "panNumberEncrypted",
  "panHash",
  "shopActKey",
  "approvedBy",
  "gstVerifiedBy",
  "panVerifiedBy",
  "statusActorId",
  "registrationFeeId",
  "referralCodeId",
] as const;
const INTERNAL_SHOP_KEY_SET: ReadonlySet<string> = new Set(INTERNAL_SHOP_KEYS);

/** A shop as its owner and staff receive it from the API. */
export type ShopView<T extends Shop = Shop> = Omit<T, (typeof INTERNAL_SHOP_KEYS)[number]>;

/** Every route that returns a shop row to its owner or staff maps it through this. */
export function toShopView<T extends Shop>(shop: T): ShopView<T> {
  return Object.fromEntries(
    Object.entries(shop).filter(([key]) => !INTERNAL_SHOP_KEY_SET.has(key)),
  ) as ShopView<T>;
}

/**
 * What anyone may see of a shop: the fields a shop card shows. Public
 * listings select only these, so the owner's contact details, address, fee
 * and tax details never leave the database for a storefront page or the
 * public API.
 */
const publicShopColumns = {
  id: shops.id,
  slug: shops.slug,
  name: shops.name,
  logoUrl: shops.logoUrl,
  ownerName: shops.ownerName,
  area: shops.area,
  city: shops.city,
  pincode: shops.pincode,
  shopType: shops.shopType,
  classification: shops.classification,
  deliveryAvailable: shops.deliveryAvailable,
  openingHours: shops.openingHours,
  ratingAvgX100: shops.ratingAvgX100,
  ratingCount: shops.ratingCount,
};

export type PublicShop = Pick<Shop, keyof typeof publicShopColumns>;

/**
 * Submits a shop registration. Always lands in PENDING_APPROVAL — the caller
 * cannot choose a status, and classification is left null for an operator to
 * assign at approval time (§8, §10).
 *
 * The same shop cannot be registered twice (see shop-duplicates.ts): a live
 * registration with the same Shop Act licence — or the same PAN or Udyam
 * number at the same place, or the same account's shop of the same name at
 * the same PIN code — refuses the submission with a 409. The account's own
 * REJECTED registration of the shop is updated and resubmitted instead of a
 * new row being created.
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
): Promise<RegisterShopResult> {
  if (!/^\d{6}$/.test(input.pincode)) {
    throw validationFailed("PIN code must be exactly 6 digits.");
  }
  if (!/^[6-9]\d{9}$/.test(input.phone)) {
    throw validationFailed("Enter a valid 10-digit Indian mobile number.");
  }

  // An invalid identifier is a field error, never silently dropped — and it
  // is caught before anything slow (geocoding) runs.
  const identity = parseShopIdentifiers(input);
  let gstin: string | null = null;
  if (input.gstin?.trim()) {
    const parsed = parseGstin(input.gstin);
    if (!parsed.ok) {
      throw validationFailed("Please check the highlighted fields.", {
        fields: { gstin: parsed.error },
      });
    }
    gstin = parsed.value;
  }
  // Stored as submitGstin() stores an owner's GSTIN: self-declared, awaiting
  // verification. Absent, nothing is written, so a resubmission keeps what is on file.
  const gstColumns = gstin
    ? {
        gstin,
        gstStatus: "PENDING_VERIFICATION" as const,
        gstVerificationSource: "SELF_DECLARED" as const,
        gstVerifiedAt: null,
      }
    : {};
  const panHolderName = input.panHolderName?.trim() ?? "";
  if (identity.pan && !panHolderName) {
    throw validationFailed("Please check the highlighted fields.", {
      fields: { panHolderName: "Enter the name on the PAN card." },
    });
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

  // What the owner typed — shared by a new registration and a resubmission.
  const details = {
    name: input.name.trim(),
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
  };

  const candidate: RegistrationCandidate = {
    ownerId,
    name: details.name,
    addressLine1: details.addressLine1,
    pincode: details.pincode,
    identity,
  };
  // Registering a shop promotes a plain customer to SHOP_OWNER — whether they
  // registered it themselves or an operator registered it for them. Operators
  // and admins keep their higher role.
  // GS-003: SHOP_OWNER is granted alongside any role the owner already holds
  // (a rider or society admin can also run a shop and switch between them).
  const roleGrant = {
    source: "SHOP_REGISTRATION" as const,
    grantedBy: actor.id,
    activateIfCustomer: true,
  };

  type Outcome =
    | { kind: "blocked"; match: DuplicateMatch }
    | { kind: "created"; shop: Shop }
    | { kind: "resubmitted"; shop: Shop; previous: Shop; matchedOn: DuplicateMatchReason };

  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      // Lock, then look: a simultaneous second submission of the same shop
      // (a double-click, a second tab) waits here, then sees this one.
      await lockRegistrationKeys(tx, candidate);
      const { blocking, rejectedOwn } = await findRegistrationMatches(tx, candidate);
      if (blocking) return { kind: "blocked", match: blocking };

      if (rejectedOwn) {
        const [previous] = await tx
          .select()
          .from(shops)
          .where(eq(shops.id, rejectedOwn.shop.id))
          .for("update");
        // Re-sending the PAN already on file must not reset its verification.
        const samePan = identity.pan !== null && previous.panHash === identity.pan.hash;
        const [shop] = await tx
          .update(shops)
          .set({
            ...details,
            ...shopIdentityColumns(samePan ? { ...identity, pan: null } : identity, panHolderName),
            // Likewise the GSTIN already on file keeps its verification.
            ...(previous.gstin === gstin ? {} : gstColumns),
            // Registration number, fee snapshot, payments and slug stay as
            // they were: this is the same registration going back for review.
            status: "PENDING_APPROVAL",
            statusActorId: ownerId,
            rejectionReason: null,
            updatedAt: new Date(),
          })
          .where(eq(shops.id, previous.id))
          .returning();
        await grantRole(ownerId, "SHOP_OWNER", roleGrant, tx);
        if (input.categoryIds) await applyShopCategories(tx, shop.id, input.categoryIds);
        return { kind: "resubmitted", shop, previous, matchedOn: rejectedOwn.reason };
      }

      const [shop] = await tx
        .insert(shops)
        .values({
          ownerId,
          registrationDate:
            (privileged ? input.registrationDate : null) ??
            new Date().toISOString().slice(0, 10),
          registrationFeePaise,
          registrationFeeId: scheduled.feeId,
          feePaymentStatus: registrationFeePaise > 0 ? "PENDING" : "PAID",
          slug: uniqueSlug(input.name),
          ...details,
          ...shopIdentityColumns(identity, panHolderName),
          ...gstColumns,
          // Status and classification are deliberately NOT taken from input.
          status: "PENDING_APPROVAL",
          statusActorId: ownerId,
          classification: null,
        })
        .returning();
      await grantRole(ownerId, "SHOP_OWNER", roleGrant, tx);
      if (input.categoryIds) await applyShopCategories(tx, shop.id, input.categoryIds);
      return { kind: "created", shop };
    });
  } catch (error) {
    // Unreachable for two registrations racing each other — the lock
    // serialises them. Kept for a write that bypassed the lock, e.g. an
    // operator re-approving a rejected shop with the same licence meanwhile.
    if (!isShopActUniqueViolation(error)) throw error;
    const { blocking } = await findRegistrationMatches(db, candidate);
    if (!blocking) {
      throw conflict("This Shop Act licence number is already registered to another shop.");
    }
    outcome = { kind: "blocked", match: blocking };
  }

  if (outcome.kind === "blocked") {
    await recordDuplicateBlocked(outcome.match, identity, actor, {
      kind: "registration",
      ownerId,
    });
    throw duplicateShopError(outcome.match, identity, { privileged });
  }

  if (outcome.kind === "resubmitted") {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_RESUBMITTED,
      entityType: "shop",
      entityId: outcome.shop.id,
      previousValue: {
        status: outcome.previous.status,
        rejectionReason: outcome.previous.rejectionReason,
      },
      newValue: {
        status: outcome.shop.status,
        matchedOn: outcome.matchedOn,
        onBehalf: ownerId !== actor.id,
        identifiers: maskedIdentifiers(identity),
      },
    });
    return { ...outcome.shop, resubmitted: true };
  }

  const shop = outcome.shop;
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
      identifiers: maskedIdentifiers(identity),
    },
  });
  return { ...shop, resubmitted: false };
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

/**
 * Approving a REJECTED shop puts it back among live registrations, where its
 * Shop Act licence must still be unique (shops_shop_act_key_active_unique).
 */
const SHOP_ACT_TAKEN_MESSAGE =
  "Another live shop already has this Shop Act licence number. Resolve the duplicate first.";

/**
 * GS-008: a shop cannot go live until its registration fee is settled.
 *
 * `feePaymentStatus` is the single verified signal — it is derived from the
 * `shop_payments` ledger by `recomputeShopSettlement`, never set by hand, and a
 * waived fee (snapshot of 0) is already written as PAID at registration. So the
 * gate is one equality check, and waiving a fee stays the way to let a shop
 * through without money changing hands.
 *
 * Only the PENDING_APPROVAL -> APPROVED transition is gated. Shops approved
 * before this gate existed keep their status; nothing is retroactively revoked.
 */
function assertRegistrationFeeSettled(shop: Shop): void {
  if (shop.feePaymentStatus === "PAID") return;

  const fee = shop.registrationFeePaise ?? 0;
  const outstanding = Math.max(0, fee - shop.amountPaidPaise);
  const detail =
    shop.feePaymentStatus === "CANCELLED"
      ? "This registration was cancelled."
      : shop.feePaymentStatus === "REFUNDED"
        ? "The registration fee was refunded."
        : `${formatPaise(shop.amountPaidPaise)} of ${formatPaise(fee)} collected — ${formatPaise(outstanding)} outstanding.`;

  throw conflict(
    `${shop.name} cannot be approved until its registration fee is settled. ${detail} Record the payment first, or set the fee to zero to waive it.`,
    { feePaymentStatus: shop.feePaymentStatus, registrationFeePaise: fee, amountPaidPaise: shop.amountPaidPaise },
  );
}

export async function approveShop(
  shopId: string,
  input: { classification: Classification },
  actor: { id: string; role: UserRole },
): Promise<Shop> {
  let approved: Shop;
  try {
    approved = await approveShopTransaction(shopId, input, actor);
  } catch (error) {
    if (isShopActUniqueViolation(error)) throw conflict(SHOP_ACT_TAKEN_MESSAGE);
    throw error;
  }

  // The duplicate-registration message promises the owner a notification.
  await notify({
    userId: approved.ownerId,
    type: NOTIFICATION_TYPES.SHOP_APPROVED,
    title: "Your shop is approved",
    body: `${approved.name} is now live on GoKesari.`,
    actionUrl: "/shop",
  });
  return approved;
}

/**
 * Event layer: approves a pending shop without a person the moment nothing
 * blocks it — every mandatory seller document VERIFIED and the registration
 * fee settled — when rule sellerVerification.autoApproveShop is on. Called
 * after a document is verified and after a fee payment. Returns false, and
 * changes nothing, when the rule is off or anything is still outstanding.
 */
export async function autoApproveShopIfReady(shopId: string): Promise<boolean> {
  const rule = await getRule("sellerVerification");
  if (!rule.autoApproveShop) return false;
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || shop.status !== "PENDING_APPROVAL" || shop.feePaymentStatus !== "PAID") return false;
  if ((await missingMandatoryDocuments(shop)).length > 0) return false;

  let approved: Shop;
  try {
    approved = await approveShopTransaction(
      shopId,
      { classification: shop.classification ?? rule.autoApproveClassification },
      { id: null, role: null },
    );
  } catch (error) {
    // Approved by someone else meanwhile, or a blocker appeared: leave it to a person.
    if (error instanceof AppError && error.code === "CONFLICT") return false;
    throw error;
  }
  await recordAudit({
    action: AUDIT_ACTIONS.SHOP_AUTO_APPROVED,
    entityType: "shop",
    entityId: shopId,
    newValue: { classification: approved.classification },
  });
  await notify({
    userId: approved.ownerId,
    type: NOTIFICATION_TYPES.SHOP_APPROVED,
    title: "Your shop is approved",
    body: `${approved.name} is now live on GoKesari.`,
    actionUrl: "/shop",
  });
  await emitEvent({
    type: "shop.auto_approved",
    subjectId: shopId,
    payload: { shopName: approved.name },
    idempotencyKey: `shop-auto-approved:${shopId}:${approved.approvedAt?.toISOString()}`,
  });
  return true;
}

function approveShopTransaction(
  shopId: string,
  input: { classification: Classification },
  /** `id: null` — approved automatically (autoApproveShopIfReady). */
  actor: { id: string | null; role: UserRole | null },
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
    // SM-002: documents, then fee — the order of the onboarding stages.
    const blocker = await onboardingApprovalBlocker(shop, tx);
    if (blocker) throw conflict(blocker, { lifecycleStatus: shop.lifecycleStatus });
    assertRegistrationFeeSettled(shop);
    // Mandatory legal documents (FSSAI / drug licence / medical registration) are submitted.
    await assertLegalDocsAllowApproval(shop, tx);

    const [updated] = await tx
      .update(shops)
      .set({
        status: "APPROVED",
        statusActorId: actor.id,
        classification: input.classification,
        approvedAt: new Date(),
        approvedBy: actor.id,
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(shops.id, shopId))
      .returning();

    // An automatic approval has nobody to record as the changer; its audit row says what was assigned.
    if (actor.id) {
      await tx.insert(shopClassificationHistory).values({
        shopId,
        previousValue: shop.classification,
        newValue: input.classification,
        changedBy: actor.id,
        reason: "Assigned at approval",
      });
    }

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
    .set({ status: "REJECTED", rejectionReason: reason, statusActorId: actor.id, updatedAt: new Date() })
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

  await notify({
    userId: updated.ownerId,
    type: NOTIFICATION_TYPES.SHOP_REJECTED,
    title: "Your shop registration wasn't approved",
    body: `${reason.trim().replace(/[.\s]+$/, "")}. You can correct the details and resubmit from My Shop.`,
    actionUrl: "/shop",
  });
  return updated;
}

export async function setShopStatus(
  shopId: string,
  status: ShopStatus,
  actor: { id: string; role: UserRole },
  reason?: string,
): Promise<Shop> {
  let updated: Shop | undefined;
  try {
    [updated] = await db
      .update(shops)
      .set({ status, statusActorId: actor.id, updatedAt: new Date() })
      .where(eq(shops.id, shopId))
      .returning();
  } catch (error) {
    if (isShopActUniqueViolation(error)) throw conflict(SHOP_ACT_TAKEN_MESSAGE);
    throw error;
  }
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
 * Suspends an approved shop. Delegates to the suspension policy service
 * (open orders are judged by status, the owner is notified). Imported lazily:
 * that service uses orders.ts, which already depends on this module.
 */
export async function suspendShop(
  shopId: string,
  reason: string,
  actor: { id: string; role: UserRole },
): Promise<Shop> {
  const { suspendShopWithPolicy } = await import("./shop-suspension");
  return (await suspendShopWithPolicy(shopId, { reason }, actor)).shop;
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
  /** C1: the shop's customer contact number and WhatsApp number (null clears). */
  contactPhone?: string | null;
  whatsappNumber?: string | null;
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
  /** Extra PIN codes the shop delivers to, on top of its radius. */
  deliveryPincodes?: string[];
  /** Minimum order subtotal in paise (0 = none). */
  minOrderPaise?: number;
  /** Pause new orders without leaving the marketplace. */
  ordersPaused?: boolean;
  /** GS-030: accept cash on delivery (within the platform's COD limits). */
  codEnabled?: boolean;
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
  if (input.contactPhone && !/^[6-9]\d{9}$/.test(input.contactPhone)) {
    throw validationFailed("Enter a valid 10-digit Indian mobile number for the shop's contact phone.");
  }
  if (input.whatsappNumber && !/^[6-9]\d{9}$/.test(input.whatsappNumber)) {
    throw validationFailed("Enter a valid 10-digit Indian mobile number for WhatsApp.");
  }
  if (
    input.serviceRadiusKm !== undefined &&
    (!Number.isInteger(input.serviceRadiusKm) || input.serviceRadiusKm < 1 || input.serviceRadiusKm > 50)
  ) {
    throw validationFailed("Delivery radius must be a whole number of km between 1 and 50.");
  }
  if (input.deliveryPincodes) {
    if (input.deliveryPincodes.length > 50 || input.deliveryPincodes.some((p) => !/^\d{6}$/.test(p))) {
      throw validationFailed("Delivery zones must be up to 50 six-digit PIN codes.");
    }
    input.deliveryPincodes = [...new Set(input.deliveryPincodes)];
  }
  if (input.minOrderPaise !== undefined && (!Number.isInteger(input.minOrderPaise) || input.minOrderPaise < 0)) {
    throw validationFailed("Minimum order must be a whole, non-negative amount.");
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
      statusActorId: actor.id,
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
      deliveryPincodes: current.deliveryPincodes,
      minOrderPaise: current.minOrderPaise,
      ordersPaused: current.ordersPaused,
      codEnabled: current.codEnabled,
      ...(input.contactPhone !== undefined ? { contactPhone: current.contactPhone } : {}),
      ...(input.whatsappNumber !== undefined ? { whatsappNumber: current.whatsappNumber } : {}),
      ...(coordinatesChanged
        ? { latitude: current.latitude, longitude: current.longitude, locationVerified: current.locationVerified }
        : {}),
    },
    newValue: {
      openingHours: updated.openingHours,
      shopType: updated.shopType,
      serviceRadiusKm: updated.serviceRadiusKm,
      deliveryPincodes: updated.deliveryPincodes,
      minOrderPaise: updated.minOrderPaise,
      ordersPaused: updated.ordersPaused,
      codEnabled: updated.codEnabled,
      ...(input.contactPhone !== undefined ? { contactPhone: updated.contactPhone } : {}),
      ...(input.whatsappNumber !== undefined ? { whatsappNumber: updated.whatsappNumber } : {}),
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

/** An APPROVED shop's public columns — what GET /api/shops/[id] shows anyone. */
export async function getPublicShopById(shopId: string): Promise<PublicShop | undefined> {
  const [shop] = await db
    .select(publicShopColumns)
    .from(shops)
    .where(and(eq(shops.id, shopId), eq(shops.status, "APPROVED"), isNull(shops.deletedAt)))
    .limit(1);
  return shop;
}

/**
 * C1 (rule shopContact): the phone numbers a customer may see for a shop.
 * SHOP_CONTACT: only the contact phone / WhatsApp number the shopkeeper
 * entered for customers — never the registration phone or the owner's login
 * number; with neither entered, `usePlatformCare` asks the page to show
 * GoKesari customer care instead. REGISTERED_PHONE: the original behaviour.
 */
export async function shopCustomerContact(
  shop: Pick<Shop, "phone" | "contactPhone" | "whatsappNumber">,
): Promise<{ phone: string | null; whatsapp: string | null; usePlatformCare: boolean }> {
  const { customerVisible } = await getRule("shopContact");
  if (customerVisible === "REGISTERED_PHONE") {
    return { phone: shop.phone, whatsapp: null, usePlatformCare: false };
  }
  const phone = shop.contactPhone || null;
  const whatsapp = shop.whatsappNumber || null;
  return { phone, whatsapp, usePlatformCare: !phone && !whatsapp };
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
  /** Internal filter: shops tagged with this shop category (not shown to customers as browsing). */
  categoryId?: string;
  /** Only these shops — e.g. the ones that deliver to the customer (serviceability.ts). */
  ids?: readonly string[];
  limit?: number;
  offset?: number;
}

/**
 * Public shop search (§15). Only APPROVED shops are ever returned, and only
 * their public columns. Staff screens that need more use searchShopsAdmin.
 */
export async function searchShops(
  filters: ShopSearchFilters = {},
): Promise<PublicShop[]> {
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
        // A shop's categories also make it findable ("dairy" finds a shop tagged Dairy).
        sql`exists (select 1 from shop_category_mapping m join shop_categories c on c.id = m.category_id
          where m.shop_id = ${shops.id} and c.status = 'ACTIVE' and c.name ilike ${term})`,
      )!,
    );
  }
  if (filters.categoryId) {
    conditions.push(
      sql`exists (select 1 from shop_category_mapping m where m.shop_id = ${shops.id} and m.category_id = ${filters.categoryId})`,
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
    .select(publicShopColumns)
    .from(shops)
    .where(and(...conditions))
    .orderBy(asc(shops.name))
    .limit(Math.min(filters.limit ?? 24, 100))
    .offset(filters.offset ?? 0);
}

export interface AdminShopFilters {
  query?: string;
  status?: ShopStatus;
  /** SM-002: lifecycle status, e.g. KYC_PENDING / PAYMENT_PENDING / VERIFIED. */
  lifecycleStatus?: Shop["lifecycleStatus"];
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
  if (filters.lifecycleStatus) conditions.push(eq(shops.lifecycleStatus, filters.lifecycleStatus));
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
