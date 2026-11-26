/**
 * Many GSTINs per shop (owner, 25-Nov-2026).
 *
 * The main GSTIN stays on shops.gstin. A chain registered in several states adds its other GSTINs
 * after the shop is live, in Shop settings → GST registrations: any PAN, each checked with the KYC
 * vendor, no fee. One GSTIN per state per shop. A GSTIN another account holds is refused, as at
 * signup. An order delivered in a state where the shop has a VERIFIED extra GSTIN is invoiced
 * under it (invoices.ts, invoiceGstinFor); search, stock and delivery stay on the main address.
 */
import { and, desc, eq, gte, isNull } from "drizzle-orm";

import { SELLER_VERIFICATION_CONSENT_VERSION } from "@/lib/kyc/consent";
import { parseSellerDocNumber } from "@/lib/kyc/doc-formats";
import { conflict, forbidden, notFound, validationFailed, AppError } from "@/lib/errors";
import { gstState } from "@/lib/gst-states";
import { decryptSecret, docBlindIndex, encryptSecret } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import { shopGstRegistrations, shops, type Shop, type ShopGstRegistration, type ShopGstRegistrationStatus, type UserRole } from "@/server/db/schema";
import { verifyDocument } from "@/server/kyc";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { gstinHeldByOtherOwner } from "./shop-duplicates";

interface Actor {
  id: string;
  role: UserRole;
}

/** Paid vendor checks one shop may start in an hour from this screen. */
export const GST_REGISTRATION_CHECKS_PER_HOUR = 10;

export interface ShopGstRegistrationView {
  id: string;
  gstinMasked: string;
  stateCode: string;
  stateName: string | null;
  status: ShopGstRegistrationStatus;
  legalName: string | null;
  tradeName: string | null;
  outletAddress: string | null;
  message: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

export interface ShopGstRegistrationsView {
  main: { gstin: string | null; stateCode: string | null; stateName: string | null; legalName: string | null };
  registrations: ShopGstRegistrationView[];
  canAdd: boolean;
  /** Why the owner cannot add one yet (shop not live, no main GSTIN). */
  blockedReason: string | null;
}

const MESSAGES: Record<string, string> = {
  not_found_at_source: "This GSTIN was not found on the GST portal. Check the number and try again.",
  doc_inactive: "This GSTIN is cancelled or inactive on the GST portal.",
  vendor_timeout: "The government source did not answer. We will not use this GSTIN on invoices until it is verified; remove it and add it again later.",
  name_not_returned: "The GST portal returned no business name. GoKesari's team will check it.",
};

function messageFor(row: ShopGstRegistration): string | null {
  if (row.status === "VERIFIED") return null;
  if (row.lastErrorCode && MESSAGES[row.lastErrorCode]) return MESSAGES[row.lastErrorCode];
  if (row.status === "MANUAL_REVIEW") return "GoKesari's team will check this GSTIN. It is not used on invoices until then.";
  if (row.status === "FAILED") return "This GSTIN could not be verified. Remove it and check the number.";
  return "Not verified yet. It is not used on invoices until then.";
}

function toView(row: ShopGstRegistration): ShopGstRegistrationView {
  return {
    id: row.id,
    gstinMasked: row.gstinMasked,
    stateCode: row.stateCode,
    stateName: gstState(row.stateCode)?.name ?? null,
    status: row.status,
    legalName: row.legalName,
    tradeName: row.tradeName,
    outletAddress: row.outletAddress,
    message: messageFor(row),
    createdAt: row.createdAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
}

async function loadShop(shopId: string): Promise<Shop> {
  const shop = await db.query.shops.findFirst({ where: and(eq(shops.id, shopId), isNull(shops.deletedAt)) });
  if (!shop) throw notFound("Shop");
  return shop;
}

function addBlockedReason(shop: Shop): string | null {
  if (shop.status !== "APPROVED") return "You can add more GSTINs once your shop is live.";
  if (!shop.gstin) return "Add your shop's main GSTIN first (Shop settings → GST).";
  return null;
}

async function activeRows(shopId: string, client: DbClient = db): Promise<ShopGstRegistration[]> {
  return client
    .select()
    .from(shopGstRegistrations)
    .where(and(eq(shopGstRegistrations.shopId, shopId), isNull(shopGstRegistrations.removedAt)))
    .orderBy(shopGstRegistrations.stateCode);
}

/** The shop's main GSTIN and its extra ones (owner and admin; access is checked by the route). */
export async function listShopGstRegistrations(shopId: string): Promise<ShopGstRegistrationsView> {
  const shop = await loadShop(shopId);
  const rows = await activeRows(shopId);
  const blockedReason = addBlockedReason(shop);
  const main = shop.gstin ? gstState(shop.gstin) : null;
  return {
    main: { gstin: shop.gstin, stateCode: main?.code ?? null, stateName: main?.name ?? null, legalName: shop.legalBusinessName },
    registrations: rows.map(toView),
    canAdd: blockedReason === null,
    blockedReason,
  };
}

/** The owner adds a GSTIN of another state; it is checked with the vendor at once. */
export async function addShopGstRegistration(input: { shopId: string; gstin: string; consentGiven: boolean; actor: Actor }): Promise<ShopGstRegistrationsView> {
  const parsed = parseSellerDocNumber("GSTIN", input.gstin);
  if (!parsed.ok) throw validationFailed("Please check the highlighted fields.", { fields: { gstin: parsed.error } });
  if (!input.consentGiven) throw validationFailed("Please agree to the verification consent before we check this number.");
  const doc = parsed.value;
  const shop = await loadShop(input.shopId);
  if (shop.ownerId !== input.actor.id) throw forbidden("Only the shop's owner can add a GSTIN.");
  const blocked = addBlockedReason(shop);
  if (blocked) throw conflict(blocked, { reason: "SHOP_NOT_READY" });

  const stateCode = doc.normalized.slice(0, 2);
  const state = gstState(stateCode);
  if (!state) throw validationFailed("Please check the highlighted fields.", { fields: { gstin: "The first two digits are not an Indian state code." } });
  if (shop.gstin === doc.normalized) throw conflict("This is already your shop's main GSTIN.", { fields: { gstin: "This is your main GSTIN." } });
  if (shop.gstin && shop.gstin.slice(0, 2) === stateCode) {
    throw conflict(`Your main GSTIN already covers ${state.name}. Add a GSTIN of another state.`, { fields: { gstin: `Your main GSTIN is for ${state.name}.` } });
  }
  const held = await gstinHeldByOtherOwner(doc.normalized, shop.ownerId);
  if (held) {
    throw conflict("This GSTIN is already registered on GoKesari by another account. If it is yours, contact support.", {
      reason: "DUPLICATE_SHOP",
      fields: { gstin: "This GSTIN is already registered." },
    });
  }

  const hash = docBlindIndex("GSTIN", doc.normalized);
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    // One owner, two tabs: the shop row is the lock.
    await tx.select({ id: shops.id }).from(shops).where(eq(shops.id, shop.id)).for("update");
    const existing = await activeRows(shop.id, tx);
    const same = existing.find((r) => r.gstinHash === hash);
    if (same) throw conflict("This GSTIN is already on your shop.", { fields: { gstin: "Already added." } });
    const inState = existing.find((r) => r.stateCode === stateCode);
    if (inState) {
      throw conflict(`Your shop already has a GSTIN for ${state.name} (${inState.gstinMasked}). Remove it first to add another.`, {
        fields: { gstin: `Already have one for ${state.name}.` },
      });
    }
    const recent = await tx
      .select({ id: shopGstRegistrations.id })
      .from(shopGstRegistrations)
      .where(and(eq(shopGstRegistrations.shopId, shop.id), gte(shopGstRegistrations.createdAt, new Date(now.getTime() - 3_600_000))));
    if (recent.length >= GST_REGISTRATION_CHECKS_PER_HOUR) throw new AppError("RATE_LIMITED", "Too many checks in the last hour. Please try again later.");
    const [created] = await tx
      .insert(shopGstRegistrations)
      .values({
        shopId: shop.id,
        gstinEncrypted: encryptSecret(doc.normalized),
        gstinMasked: doc.masked,
        gstinHash: hash,
        stateCode,
        status: "PENDING",
        consentGivenAt: now,
        consentVersion: SELLER_VERIFICATION_CONSENT_VERSION,
        addedBy: input.actor.id,
      })
      .returning();
    return created;
  });

  // The paid call runs outside the transaction; a retry with the same key is not billed twice.
  const result = await verifyDocument("GSTIN", doc.normalized, {}, `shop-gst:${row.id}`);
  const record = result.record;
  let status: ShopGstRegistrationStatus = result.status === "VERIFIED" ? "VERIFIED" : result.status === "FAILED" || result.status === "EXPIRED" ? "FAILED" : result.status === "MANUAL_REVIEW" ? "MANUAL_REVIEW" : "PENDING";
  let errorCode = result.errorCode;
  if (status === "VERIFIED" && !record?.name && !record?.tradeName) {
    status = "MANUAL_REVIEW";
    errorCode = "name_not_returned";
  }
  if (record && record.docStatus !== "active" && status === "VERIFIED") {
    status = "FAILED";
    errorCode = "doc_inactive";
  }
  const checkedAt = new Date();
  await db
    .update(shopGstRegistrations)
    .set({
      status,
      lastErrorCode: errorCode,
      legalName: record?.name ?? null,
      tradeName: record?.tradeName ?? null,
      outletAddress: record?.address ?? null,
      outletPincode: record?.pincode ?? null,
      providerId: result.providerId,
      providerRef: result.rawRef,
      verifiedAt: status === "VERIFIED" ? checkedAt : null,
      updatedAt: checkedAt,
    })
    .where(eq(shopGstRegistrations.id, row.id));

  await recordAudit({
    actorId: input.actor.id,
    actorRole: input.actor.role,
    action: AUDIT_ACTIONS.SHOP_GST_REGISTRATION_ADDED,
    entityType: "shop",
    entityId: shop.id,
    newValue: { registrationId: row.id, gstin: doc.masked, stateCode, status },
  });
  return listShopGstRegistrations(shop.id);
}

/** The owner (or an admin) removes an extra GSTIN; later invoices use the main GSTIN for that state. */
export async function removeShopGstRegistration(input: { shopId: string; registrationId: string; actor: Actor; privileged: boolean }): Promise<ShopGstRegistrationsView> {
  const shop = await loadShop(input.shopId);
  if (!input.privileged && shop.ownerId !== input.actor.id) throw forbidden("This shop does not belong to you.");
  const [row] = await db
    .select()
    .from(shopGstRegistrations)
    .where(and(eq(shopGstRegistrations.id, input.registrationId), eq(shopGstRegistrations.shopId, shop.id), isNull(shopGstRegistrations.removedAt)));
  if (!row) throw notFound("GST registration");
  const now = new Date();
  await db
    .update(shopGstRegistrations)
    .set({ removedAt: now, removedBy: input.actor.id, updatedAt: now })
    .where(eq(shopGstRegistrations.id, row.id));
  await recordAudit({
    actorId: input.actor.id,
    actorRole: input.actor.role,
    action: AUDIT_ACTIONS.SHOP_GST_REGISTRATION_REMOVED,
    entityType: "shop",
    entityId: shop.id,
    previousValue: { registrationId: row.id, gstin: row.gstinMasked, stateCode: row.stateCode, status: row.status },
  });
  return listShopGstRegistrations(shop.id);
}

/**
 * The extra GSTIN an invoice uses: the shop's VERIFIED GSTIN for the delivery state (a two-digit
 * GST state code or a two-letter code), or null → the main GSTIN.
 */
export async function invoiceGstinFor(
  shopId: string,
  deliveryState: string | null,
  client: DbClient = db,
): Promise<{ gstin: string; stateCode: string; legalName: string | null; tradeName: string | null; outletAddress: string | null } | null> {
  const state = gstState(deliveryState);
  if (!state) return null;
  const [row] = await client
    .select()
    .from(shopGstRegistrations)
    .where(
      and(
        eq(shopGstRegistrations.shopId, shopId),
        eq(shopGstRegistrations.stateCode, state.code),
        eq(shopGstRegistrations.status, "VERIFIED"),
        isNull(shopGstRegistrations.removedAt),
      ),
    )
    .orderBy(desc(shopGstRegistrations.verifiedAt))
    .limit(1);
  if (!row) return null;
  return { gstin: decryptSecret(row.gstinEncrypted), stateCode: row.stateCode, legalName: row.legalName, tradeName: row.tradeName, outletAddress: row.outletAddress };
}
