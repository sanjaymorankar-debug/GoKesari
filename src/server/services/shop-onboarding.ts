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
import { sellerVerifications, shopDocumentWaivers, shops, type Shop } from "@/server/db/schema";
import { isMandatory } from "./seller-verification-checks";
import { getRule } from "./settings";

export interface ShopOnboarding extends OnboardingFacts {
  shopId: string;
  kycComplete: boolean;
  missingDocTypes: SellerDocType[];
}

/** Statuses that mean the owner sent the document and it waits for a check. */
const IN_REVIEW = new Set(["PENDING", "MANUAL_REVIEW"]);
/** Statuses that mean the owner has to send it again. */
const SEND_AGAIN = new Set(["FAILED", "EXPIRED"]);

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
  const documents = await client
    .select({ shopId: sellerVerifications.shopId, docType: sellerVerifications.docType, status: sellerVerifications.status })
    .from(sellerVerifications)
    .where(inArray(sellerVerifications.shopId, shopIds));

  for (const row of rows) {
    if (!isOnboardingStage(row.lifecycleStatus)) continue;
    const status = new Map(documents.filter((v) => v.shopId === row.id).map((v) => [v.docType, v.status]));
    const missingDocTypes = SELLER_DOC_TYPES.filter(
      (d) => isMandatory(d, { isFoodBusiness: row.sellsFood }) && status.get(d) !== "VERIFIED",
    );
    const labels = (pick: (s: string | undefined) => boolean) =>
      missingDocTypes.filter((d) => pick(status.get(d))).map((d) => SELLER_DOC_LABELS[d]);
    result.set(row.id, {
      shopId: row.id,
      stage: row.lifecycleStatus,
      kycComplete: missingDocTypes.length === 0,
      missingDocTypes,
      missingDocuments: missingDocTypes.map((d) => SELLER_DOC_LABELS[d]),
      notUploadedDocuments: labels((s) => !s || s === "NOT_SUBMITTED"),
      inReviewDocuments: labels((s) => !!s && IN_REVIEW.has(s)),
      sendAgainDocuments: labels((s) => !!s && SEND_AGAIN.has(s)),
      documentsUploaded: [...status.values()].filter((s) => s !== "NOT_SUBMITTED").length,
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
  if (await hasDocumentWaiver(shop.id, client)) return null;
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

/** An admin approved this shop without its seller documents (0109). Commission milestones ignore it. */
export async function hasDocumentWaiver(shopId: string, client: DbClient = db): Promise<boolean> {
  const [row] = await client
    .select({ id: shopDocumentWaivers.id })
    .from(shopDocumentWaivers)
    .where(eq(shopDocumentWaivers.shopId, shopId))
    .limit(1);
  return Boolean(row);
}
