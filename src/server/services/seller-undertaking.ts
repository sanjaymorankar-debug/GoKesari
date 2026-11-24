/**
 * Seller undertaking: fresh, safe and compliant goods (docs/seller-undertaking-2026-11).
 *
 * A shop owner has accepted when their LATEST `SELLER_GOODS_UNDERTAKING` consent is a grant for
 * SELLER_UNDERTAKING_VERSION and their LATEST `SELLER_TERMS` consent is a grant for
 * SELLER_TERMS_VERSION (src/lib/legal/seller-undertaking.ts). Bumping either constant therefore
 * asks every owner again — no data change needed.
 *
 * Rows: acceptance is per owner, but it is recorded once per shop the owner owns (both consent
 * types, `user_consents.shop_id` set), so the evidence names each business it covers. An owner with
 * no shop yet gets one row per type with no shop. A shop added later is covered by its owner's
 * acceptance; the registration wizard records rows for the new shop as well.
 *
 * Effects while the flag `seller_undertaking_gate_enabled` is on (and covers the shop's district):
 *   - Seller Central (/shop/…) shows the acknowledgement instead of the page (src/app/shop/layout.tsx);
 *   - the owner's shops cannot accept NEW orders (assertSellerUndertakingAllowsOrders, called by
 *     updateOrderStatus for CONFIRMED → ACCEPTED / PREPARING — the app, the API and WhatsApp all go
 *     through it). Orders already accepted carry on: dispatch, ready, delivery are not checked.
 * Flag off: nothing is asked or refused; registration still records both consents.
 *
 * This is separate from the general policy re-consent gate (PR #530, policy_reconsent_enabled):
 * that one covers the Terms / Privacy Policy / Seller Terms for every signed-in user; this one is
 * the seller's goods undertaking, and it blocks order acceptance.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import { conflict, forbidden } from "@/lib/errors";
import {
  SELLER_TERMS_VERSION,
  SELLER_UNDERTAKING_EFFECTIVE_DATE,
  SELLER_UNDERTAKING_VERSION,
} from "@/lib/legal/seller-undertaking";
import { db, type DbClient } from "@/server/db";
import { shops, userConsents, type ConsentType, type UserConsent, type UserRole } from "@/server/db/schema";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { recordConsent } from "./consents";
import { flagCoversShop, getFeatureFlag, isFeatureEnabledForShop } from "./feature-flags";

export const SELLER_UNDERTAKING_FLAG = "seller_undertaking_gate_enabled" as const;

/** Where an owner accepts: any Seller Central page shows the acknowledgement while it is due. */
export const SELLER_UNDERTAKING_URL = "/shop";

async function latest(userId: string, consentType: ConsentType, client: DbClient = db): Promise<UserConsent | undefined> {
  const [row] = await client
    .select()
    .from(userConsents)
    .where(and(eq(userConsents.userId, userId), eq(userConsents.consentType, consentType)))
    .orderBy(desc(userConsents.createdAt))
    .limit(1);
  return row;
}

/** Both the undertaking and the Seller Terms, at the current versions, latest row a grant. */
export async function hasAcceptedCurrentSellerUndertaking(userId: string): Promise<boolean> {
  const [undertaking, terms] = await Promise.all([latest(userId, "SELLER_GOODS_UNDERTAKING"), latest(userId, "SELLER_TERMS")]);
  return (
    undertaking?.granted === true &&
    undertaking.version === SELLER_UNDERTAKING_VERSION &&
    terms?.granted === true &&
    terms.version === SELLER_TERMS_VERSION
  );
}

async function ownedShops(userId: string, client: DbClient = db) {
  return client
    .select({ id: shops.id, pincode: shops.pincode })
    .from(shops)
    .where(and(eq(shops.ownerId, userId), isNull(shops.deletedAt)));
}

/** Whether the flag is on for at least one of these shops (a flag may be limited to districts). */
async function flagOnForAnyShop(shopList: { pincode: string | null }[]): Promise<boolean> {
  const flag = await getFeatureFlag(SELLER_UNDERTAKING_FLAG);
  if (!flag.enabled) return false;
  for (const shop of shopList) if (await flagCoversShop(flag, shop)) return true;
  return false;
}

export interface SellerUndertakingStatus {
  /** The flag is on for at least one of the owner's shops. */
  gateEnabled: boolean;
  /** Latest grants are for the current versions. */
  accepted: boolean;
  /** The owner must accept now: gate on, owns a shop, not accepted. */
  required: boolean;
  version: string;
  termsVersion: string;
  effectiveDate: string;
  /** ISO (UTC) time of the latest undertaking grant at the current version; shown in IST. */
  acceptedAt: string | null;
}

export async function getSellerUndertakingStatus(userId: string): Promise<SellerUndertakingStatus> {
  const [owned, accepted, undertaking] = await Promise.all([
    ownedShops(userId),
    hasAcceptedCurrentSellerUndertaking(userId),
    latest(userId, "SELLER_GOODS_UNDERTAKING"),
  ]);
  const gateEnabled = owned.length > 0 && (await flagOnForAnyShop(owned));
  return {
    gateEnabled,
    accepted,
    required: gateEnabled && !accepted,
    version: SELLER_UNDERTAKING_VERSION,
    termsVersion: SELLER_TERMS_VERSION,
    effectiveDate: SELLER_UNDERTAKING_EFFECTIVE_DATE,
    acceptedAt: accepted && undertaking ? undertaking.createdAt.toISOString() : null,
  };
}

/** Seller Central's gate: true when this owner must accept before seeing the page. Best-effort false on error. */
export async function sellerUndertakingGateApplies(userId: string): Promise<boolean> {
  return (await getSellerUndertakingStatus(userId)).required;
}

/**
 * Records acceptance of the current undertaking AND the current Seller Terms: one row per type per
 * shop (`shopIds` given, else every live shop the owner owns; no shop → one row per type without a
 * shop). The caller has already checked both boxes were ticked; this records, and audits, the act.
 */
export async function acceptSellerUndertaking(input: {
  userId: string;
  shopIds?: string[];
  ip?: string | null;
  userAgent?: string | null;
  actorRole?: UserRole | null;
  client?: DbClient;
}): Promise<{ recorded: number; shopIds: (string | null)[] }> {
  const write = async (tx: DbClient) => {
    const shopIds: (string | null)[] = input.shopIds?.length ? input.shopIds : (await ownedShops(input.userId, tx)).map((s) => s.id);
    const targets = shopIds.length ? shopIds : [null];
    let recorded = 0;
    for (const shopId of targets) {
      for (const [consentType, version] of [
        ["SELLER_GOODS_UNDERTAKING", SELLER_UNDERTAKING_VERSION],
        ["SELLER_TERMS", SELLER_TERMS_VERSION],
      ] as const) {
        await recordConsent(input.userId, consentType, { version, shopId, ipAddress: input.ip ?? null, userAgent: input.userAgent ?? null, client: tx });
        recorded += 1;
      }
    }
    await recordAudit(
      {
        actorId: input.userId,
        actorRole: input.actorRole ?? null,
        action: AUDIT_ACTIONS.CONSENT_RECORDED,
        entityType: "seller_undertaking",
        entityId: input.userId,
        newValue: { consentTypes: ["SELLER_GOODS_UNDERTAKING", "SELLER_TERMS"], version: SELLER_UNDERTAKING_VERSION, termsVersion: SELLER_TERMS_VERSION, shopIds: targets },
        ipAddress: input.ip ?? null,
        userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
      },
      tx,
    );
    return { recorded, shopIds: targets };
  };
  return input.client ? write(input.client) : db.transaction(write);
}

/**
 * Order acceptance (CONFIRMED → ACCEPTED / PREPARING): refused while the flag is on for the shop and
 * its owner has not accepted the current undertaking. Does nothing with the flag off.
 */
export async function assertSellerUndertakingAllowsOrders(shopId: string): Promise<void> {
  const [shop] = await db.select({ ownerId: shops.ownerId, name: shops.name, pincode: shops.pincode }).from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) return;
  if (!(await isFeatureEnabledForShop(SELLER_UNDERTAKING_FLAG, { pincode: shop.pincode }))) return;
  if (await hasAcceptedCurrentSellerUndertaking(shop.ownerId)) return;
  throw conflict(
    `${shop.name} can't accept new orders until the shop owner accepts the seller undertaking (fresh, non-expired, compliant goods) and the Seller Terms. Open Seller Central (${SELLER_UNDERTAKING_URL}) to read and accept it.`,
    { sellerUndertaking: { required: true, version: SELLER_UNDERTAKING_VERSION, url: SELLER_UNDERTAKING_URL } },
  );
}

/** For the API route: the signed-in user must own at least one live shop. */
export async function assertOwnsAShop(userId: string): Promise<void> {
  if ((await ownedShops(userId)).length === 0) throw forbidden("Only a shop owner can accept the seller undertaking.");
}
