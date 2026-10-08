/**
 * SM-002 shop onboarding stages — server side.
 *
 * The stage itself is stored on shops.lifecycle_status and kept current by the
 * database (migration 0051: KYC_PENDING → PAYMENT_PENDING → VERIFIED). This
 * module adds what the screens need around it — which mandatory documents
 * are still missing and how much fee is owed — and the approval gate.
 */
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

import { SELLER_DOC_LABELS, SELLER_DOC_TYPES, type SellerDocType } from "@/lib/kyc/doc-formats";
import { isOnboardingStage, type OnboardingFacts } from "@/lib/shop-onboarding";
import { SHOP_LIFECYCLE_STATUSES, type ShopLifecycleStatus } from "@/lib/status-models";
import { db, type DbClient } from "@/server/db";
import { sellerVerifications, shops, type Shop } from "@/server/db/schema";
import { isMandatory } from "./seller-verification-checks";
import { getRule } from "./settings";

export interface ShopOnboarding extends OnboardingFacts {
  shopId: string;
  kycComplete: boolean;
  missingDocTypes: SellerDocType[];
}

/** Onboarding facts for shops awaiting approval (others are skipped). */
export async function getShopOnboarding(
  shopIds: string[],
  client: DbClient = db,
): Promise<Map<string, ShopOnboarding>> {
  const result = new Map<string, ShopOnboarding>();
  if (shopIds.length === 0) return result;
  const rows = await client
    .select({
      id: shops.id,
      lifecycleStatus: shops.lifecycleStatus,
      registrationFeePaise: shops.registrationFeePaise,
      amountPaidPaise: shops.amountPaidPaise,
      feePaymentStatus: shops.feePaymentStatus,
      sellsFood: sql<boolean>`shop_sells_food(${shops.id}, ${shops.shopType}::text)`,
    })
    .from(shops)
    .where(inArray(shops.id, shopIds));
  const verified = await client
    .select({ shopId: sellerVerifications.shopId, docType: sellerVerifications.docType })
    .from(sellerVerifications)
    .where(and(inArray(sellerVerifications.shopId, shopIds), eq(sellerVerifications.status, "VERIFIED")));

  for (const row of rows) {
    if (!isOnboardingStage(row.lifecycleStatus)) continue;
    const have = new Set(verified.filter((v) => v.shopId === row.id).map((v) => v.docType));
    const missingDocTypes = SELLER_DOC_TYPES.filter(
      (d) => isMandatory(d, { isFoodBusiness: row.sellsFood }) && !have.has(d),
    );
    result.set(row.id, {
      shopId: row.id,
      stage: row.lifecycleStatus,
      kycComplete: missingDocTypes.length === 0,
      missingDocTypes,
      missingDocuments: missingDocTypes.map((d) => SELLER_DOC_LABELS[d]),
      feeOutstandingPaise:
        row.feePaymentStatus === "PAID" ? 0 : Math.max(0, (row.registrationFeePaise ?? 0) - row.amountPaidPaise),
    });
  }
  return result;
}

/** Shops per lifecycle status (live shops only), for counts and filters. */
export async function countShopsByLifecycle(): Promise<Record<ShopLifecycleStatus, number>> {
  const rows = await db
    .select({ status: shops.lifecycleStatus, n: count() })
    .from(shops)
    .where(isNull(shops.deletedAt))
    .groupBy(shops.lifecycleStatus);
  const counts = Object.fromEntries(SHOP_LIFECYCLE_STATUSES.map((s) => [s, 0])) as Record<ShopLifecycleStatus, number>;
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

/**
 * Approval gate (SM-002): a shop goes live only from VERIFIED — every
 * mandatory seller document verified and the fee settled. The database
 * refuses KYC_PENDING/PAYMENT_PENDING → ACTIVE anyway; this gives the
 * operator the reason in words, and covers approving a REJECTED shop
 * directly. Follows the same switch as the lifecycle trigger
 * (statusModels.enforceTransitions), so one setting turns both off.
 *
 * Returns null when the shop may be approved on documents; the fee check
 * stays in shops.ts (GS-008) with its own wording.
 */
export async function onboardingApprovalBlocker(shop: Shop, client: DbClient = db): Promise<string | null> {
  const rule = await getRule("statusModels");
  if (!rule.enforceTransitions) return null;
  const missing = await missingMandatoryDocuments(shop, client);
  if (missing.length === 0) return null;
  return `${shop.name} cannot be approved until its seller documents are verified. Not yet verified: ${missing
    .map((d) => SELLER_DOC_LABELS[d])
    .join(", ")}.`;
}

/** Mandatory seller documents not yet VERIFIED for this shop (whatever the statusModels rule says). */
export async function missingMandatoryDocuments(shop: Pick<Shop, "id" | "shopType">, client: DbClient = db) {
  const [row] = await client
    .select({ sellsFood: sql<boolean>`shop_sells_food(${shop.id}, ${shop.shopType}::text)` })
    .from(shops)
    .where(eq(shops.id, shop.id));
  const verified = await client
    .select({ docType: sellerVerifications.docType })
    .from(sellerVerifications)
    .where(and(eq(sellerVerifications.shopId, shop.id), eq(sellerVerifications.status, "VERIFIED")));
  const have = new Set(verified.map((v) => v.docType));
  return SELLER_DOC_TYPES.filter((d) => isMandatory(d, { isFoodBusiness: row?.sellsFood ?? false }) && !have.has(d));
}
