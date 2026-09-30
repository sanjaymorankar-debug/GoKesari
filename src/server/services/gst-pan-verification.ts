/**
 * GST/PAN self-service verification (marketplace GST-readiness follow-up).
 *
 * No GST Suvidha Provider or PAN-verification provider is configured yet
 * (see isGstProviderConfigured()/isPanProviderConfigured() in env.ts).
 * Rather than fake a "verified" result, every submission is stored as
 * PENDING_VERIFICATION with source SELF_DECLARED, and an admin confirms it
 * by hand (checking the government portal themselves) via adminVerifyGst/
 * adminVerifyPan — mirroring the shop-approval review pattern already used
 * elsewhere. Wiring in a real provider later means filling in
 * lookupGstinFromProvider/lookupPanFromProvider; nothing else changes.
 *
 * GST registration is never assumed: a shop starts at gstStatus UNKNOWN and
 * only ever changes because the owner explicitly said "yes" or "no."
 */
import { eq, or } from "drizzle-orm";

import { isGstProviderConfigured, isPanProviderConfigured } from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { decryptPan, encryptPan, maskPan, panBlindIndex } from "@/lib/pan-crypto";
import { parsePanNumber } from "@/lib/shop-identity";
import { db } from "@/server/db";
import { shops, type GstStatus, type PanStatus, type Shop, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import {
  duplicateShopError,
  findRegistrationMatches,
  lockRegistrationKeys,
  recordDuplicateBlocked,
  type DuplicateMatch,
  type RegistrationCandidate,
  type ShopIdentity,
} from "./shop-duplicates";

interface Actor {
  id: string;
  role: UserRole;
}

const GSTIN_PATTERN = /^[0-9A-Z]{15}$/;

async function loadOwnedShop(shopId: string, actor: Actor): Promise<Shop> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");
  if (shop.ownerId !== actor.id && actor.role !== "ADMIN" && actor.role !== "OPERATOR") {
    throw forbidden("This shop does not belong to you.");
  }
  return shop;
}

/**
 * Placeholder for a real GSP integration. Never called today (no provider
 * configured) — kept here so the shape is ready and the TODO is visible.
 */
async function lookupGstinFromProvider(
  gstin: string,
): Promise<{ legalName: string; tradeName: string | null } | null> {
  throw new Error(`No GST provider configured — cannot look up ${gstin}.`);
}

/** Placeholder for a real PAN-verification provider. Never called today. */
async function lookupPanFromProvider(
  panNumber: string,
): Promise<{ holderName: string } | null> {
  throw new Error(`No PAN provider configured — cannot look up ${panNumber}.`);
}

/** Shop owner submits their GSTIN. Auto-verified only if a real provider is configured; otherwise queued for admin review. */
export async function submitGstin(shopId: string, gstin: string, actor: Actor): Promise<Shop> {
  const normalized = gstin.trim().toUpperCase();
  if (!GSTIN_PATTERN.test(normalized)) {
    throw validationFailed("GSTIN must be 15 alphanumeric characters.");
  }
  const shop = await loadOwnedShop(shopId, actor);

  let status: GstStatus = "PENDING_VERIFICATION";
  let legalName = shop.legalBusinessName;
  let tradeName: string | null = shop.gstTradeName;
  let source: "PROVIDER_VERIFIED" | "SELF_DECLARED" = "SELF_DECLARED";
  let verifiedAt: Date | null = null;

  if (isGstProviderConfigured()) {
    const result = await lookupGstinFromProvider(normalized);
    if (result) {
      status = "REGISTERED";
      legalName = result.legalName;
      tradeName = result.tradeName;
      source = "PROVIDER_VERIFIED";
      verifiedAt = new Date();
    } else {
      status = "VERIFICATION_FAILED";
    }
  }

  const [updated] = await db
    .update(shops)
    .set({
      gstin: normalized,
      gstStatus: status,
      legalBusinessName: legalName,
      gstTradeName: tradeName,
      gstVerificationSource: source,
      gstVerifiedAt: verifiedAt,
      gstVerifiedBy: verifiedAt ? null : shop.gstVerifiedBy,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_GST_SUBMITTED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { gstStatus: shop.gstStatus },
    newValue: { gstin: normalized, gstStatus: status },
  });

  return updated;
}

/** Shop owner declares they have no GSTIN. */
export async function setGstNotRegistered(shopId: string, actor: Actor): Promise<Shop> {
  const shop = await loadOwnedShop(shopId, actor);

  const [updated] = await db
    .update(shops)
    .set({
      gstStatus: "NOT_REGISTERED",
      gstin: null,
      gstTradeName: null,
      gstVerificationSource: null,
      gstVerifiedAt: null,
      gstVerifiedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_GST_SUBMITTED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { gstStatus: shop.gstStatus },
    newValue: { gstStatus: "NOT_REGISTERED" },
  });

  return updated;
}

/** Admin confirms a self-declared GSTIN after checking it themselves (no provider configured). */
export async function adminVerifyGst(
  shopId: string,
  actor: Actor,
  correction?: { legalName?: string; tradeName?: string | null },
): Promise<Shop> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");
  if (!shop.gstin) throw conflict("This shop has not submitted a GSTIN.");
  if (shop.gstStatus === "REGISTERED") throw conflict("This GSTIN is already verified.");

  const [updated] = await db
    .update(shops)
    .set({
      gstStatus: "REGISTERED",
      legalBusinessName: correction?.legalName ?? shop.legalBusinessName,
      gstTradeName: correction?.tradeName !== undefined ? correction.tradeName : shop.gstTradeName,
      gstVerificationSource: "ADMIN_VERIFIED",
      gstVerifiedAt: new Date(),
      gstVerifiedBy: actor.id,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_GST_VERIFIED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { gstStatus: shop.gstStatus },
    newValue: { gstStatus: "REGISTERED" },
  });

  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_GST_VERIFIED,
    title: "Your GSTIN has been verified",
    body: `${shop.name}'s GST registration is now confirmed.`,
    actionUrl: "/shop",
  });

  return updated;
}

export async function adminRejectGst(shopId: string, reason: string, actor: Actor): Promise<Shop> {
  if (!reason.trim()) throw validationFailed("A rejection reason is required.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");

  const [updated] = await db
    .update(shops)
    .set({ gstStatus: "VERIFICATION_FAILED", updatedAt: new Date() })
    .where(eq(shops.id, shopId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_GST_REJECTED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { gstStatus: shop.gstStatus },
    newValue: { gstStatus: "VERIFICATION_FAILED", reason },
  });

  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_GST_REJECTED,
    title: "We couldn't verify your GSTIN",
    body: reason.trim(),
    actionUrl: "/shop",
  });

  return updated;
}

/** Shop owner submits their PAN. Encrypted before storage; never kept in plaintext. */
export async function submitPan(
  shopId: string,
  panNumber: string,
  holderName: string,
  actor: Actor,
): Promise<Shop> {
  const parsed = parsePanNumber(panNumber);
  if (!parsed.ok) throw validationFailed(parsed.error);
  const normalized = parsed.value;
  if (!holderName.trim()) throw validationFailed("Enter the name on the PAN card.");

  const shop = await loadOwnedShop(shopId, actor);
  const encrypted = encryptPan(normalized);
  const last4 = normalized.slice(-4);
  const panHash = panBlindIndex(normalized);

  let status: PanStatus = "PENDING_VERIFICATION";
  let source: "PROVIDER_VERIFIED" | "SELF_DECLARED" = "SELF_DECLARED";
  let verifiedAt: Date | null = null;
  let confirmedHolderName = holderName.trim();

  if (isPanProviderConfigured()) {
    const result = await lookupPanFromProvider(normalized);
    if (result) {
      status = "VERIFIED";
      source = "PROVIDER_VERIFIED";
      verifiedAt = new Date();
      confirmedHolderName = result.holderName;
    } else {
      status = "VERIFICATION_FAILED";
    }
  }

  // The same PAN on another live shop at this same place means this shop is a
  // duplicate registration — the rule registerShop() applies, so a PAN left
  // off at registration cannot be added afterwards to slip past it.
  const identity: ShopIdentity = {
    shopAct: null,
    udyamNumber: null,
    pan: { normalized, hash: panHash, last4 },
  };
  const candidate: RegistrationCandidate = {
    ownerId: shop.ownerId,
    name: shop.name,
    addressLine1: shop.addressLine1,
    pincode: shop.pincode,
    identity,
    excludeShopId: shop.id,
    sameOwnerRule: false,
  };

  const outcome = await db.transaction(
    async (tx): Promise<{ kind: "blocked"; match: DuplicateMatch } | { kind: "saved"; shop: Shop }> => {
      await lockRegistrationKeys(tx, candidate);
      const { blocking } = await findRegistrationMatches(tx, candidate);
      if (blocking) return { kind: "blocked", match: blocking };

      const [saved] = await tx
        .update(shops)
        .set({
          panNumberEncrypted: encrypted,
          panLast4: last4,
          panHash,
          panHolderName: confirmedHolderName,
          panStatus: status,
          panVerificationSource: source,
          panVerifiedAt: verifiedAt,
          panVerifiedBy: verifiedAt ? null : shop.panVerifiedBy,
          updatedAt: new Date(),
        })
        .where(eq(shops.id, shopId))
        .returning();
      return { kind: "saved", shop: saved };
    },
  );

  if (outcome.kind === "blocked") {
    await recordDuplicateBlocked(outcome.match, identity, actor, {
      kind: "pan_submission",
      ownerId: shop.ownerId,
    });
    throw duplicateShopError(outcome.match, identity, {
      privileged: actor.role === "ADMIN" || actor.role === "OPERATOR",
      context: "pan_submission",
    });
  }
  const updated = outcome.shop;

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_PAN_SUBMITTED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { panStatus: shop.panStatus },
    // Never log the PAN itself — only the masked form.
    newValue: { panMasked: maskPan(last4), panStatus: status },
  });

  return updated;
}

export async function adminVerifyPan(shopId: string, actor: Actor): Promise<Shop> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");
  if (!shop.panNumberEncrypted) throw conflict("This shop has not submitted a PAN.");
  if (shop.panStatus === "VERIFIED") throw conflict("This PAN is already verified.");

  const [updated] = await db
    .update(shops)
    .set({
      panStatus: "VERIFIED",
      panVerificationSource: "ADMIN_VERIFIED",
      panVerifiedAt: new Date(),
      panVerifiedBy: actor.id,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_PAN_VERIFIED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { panStatus: shop.panStatus },
    newValue: { panStatus: "VERIFIED" },
  });

  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_PAN_VERIFIED,
    title: "Your PAN has been verified",
    body: `${shop.name}'s PAN is now confirmed.`,
    actionUrl: "/shop",
  });

  return updated;
}

export async function adminRejectPan(shopId: string, reason: string, actor: Actor): Promise<Shop> {
  if (!reason.trim()) throw validationFailed("A rejection reason is required.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");

  const [updated] = await db
    .update(shops)
    .set({ panStatus: "VERIFICATION_FAILED", updatedAt: new Date() })
    .where(eq(shops.id, shopId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_PAN_REJECTED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { panStatus: shop.panStatus },
    newValue: { panStatus: "VERIFICATION_FAILED", reason },
  });

  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_PAN_REJECTED,
    title: "We couldn't verify your PAN",
    body: reason.trim(),
    actionUrl: "/shop",
  });

  return updated;
}

/** Shops with a self-declared GSTIN or PAN awaiting admin review. */
export async function listPendingGstPanVerifications(): Promise<Shop[]> {
  return db.query.shops.findMany({
    where: or(eq(shops.gstStatus, "PENDING_VERIFICATION"), eq(shops.panStatus, "PENDING_VERIFICATION")),
    orderBy: (t, { asc }) => asc(t.updatedAt),
    limit: 200,
  });
}

/** Masked PAN for normal display ("XXXXXX1234F") — never the full number. */
export function getMaskedPan(shop: Pick<Shop, "panLast4">): string | null {
  return shop.panLast4 ? maskPan(shop.panLast4) : null;
}

/**
 * Decrypts the full PAN. ADMIN only, and every call is audited — this is
 * the one place the full number is ever reconstructed, so it must never be
 * a silent read.
 */
export async function revealPanForAdmin(shopId: string, actor: Actor): Promise<string> {
  if (actor.role !== "ADMIN") throw forbidden("Only an administrator may reveal a full PAN.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop?.panNumberEncrypted) throw notFound("PAN");

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_PAN_REVEALED,
    entityType: "shop",
    entityId: shopId,
  });

  return decryptPan(shop.panNumberEncrypted);
}
