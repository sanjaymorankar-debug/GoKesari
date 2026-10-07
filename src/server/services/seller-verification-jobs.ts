/**
 * Seller verification sweep (Part 3.8–3.9), run daily by
 * POST /api/cron/seller-verification. Each step is idempotent, so a missed
 * or repeated run is harmless:
 *
 *   1. retry documents left PENDING because the vendor was down;
 *   2. re-check verified GSTINs every `gstRecheckDays` (cancellations);
 *   3. warn sellers `expiryWarningDays` before an FSSAI / Shop Act expiry
 *      (once per document per expiry date);
 *   4. mark documents past their expiry date EXPIRED;
 *   5. take an approved shop offline when a mandatory document has expired
 *      (after `suspendGraceDays`) or been cancelled at source. Open orders
 *      are held for an operator, never auto-refunded (suspendShopWithPolicy
 *      with no actor).
 *   6. erase verification data of shops closed longer than
 *      `retentionDaysAfterClosure` (DPDP Act 2023 s.8(7)).
 *
 * Each step is capped per run so a vendor outage can't turn one run into
 * thousands of paid calls.
 */
import { and, eq, inArray, isNotNull, lt, lte, gte, sql } from "drizzle-orm";

import { SELLER_DOC_LABELS } from "@/lib/kyc/doc-formats";
import { db } from "@/server/db";
import { sellerVerificationEvents, sellerVerifications, shops } from "@/server/db/schema";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { eraseShopVerificationData, recheckVerification, shopFacts, shopsDueForVerificationErasure } from "./seller-verification";
import { isMandatory } from "./seller-verification-checks";
import { getRule } from "./settings";
import { suspendShopWithPolicy } from "./shop-suspension";

const MAX_VENDOR_CALLS_PER_STEP = 50;
const DAY_MS = 86_400_000;

/** Error codes meaning the government record itself says the document is no longer good. */
const LAPSED_AT_SOURCE = ["document_cancelled", "document_suspended", "document_inactive"];

export interface SweepResult {
  pendingRetried: number;
  gstRechecked: number;
  expiryWarnings: number;
  expired: number;
  shopsSuspended: number;
  shopsErased: number;
  errors: string[];
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function runSellerVerificationSweep(now: Date = new Date()): Promise<SweepResult> {
  const rule = await getRule("sellerVerification");
  const result: SweepResult = { pendingRetried: 0, gstRechecked: 0, expiryWarnings: 0, expired: 0, shopsSuspended: 0, shopsErased: 0, errors: [] };
  const todayIso = isoDay(now);

  const recheckAll = async (ids: string[], counter: "pendingRetried" | "gstRechecked") => {
    for (const id of ids) {
      try {
        await recheckVerification(id, null);
        result[counter] += 1;
      } catch (error) {
        result.errors.push(`${counter} ${id}: ${(error as Error).message}`);
      }
    }
  };

  // 1. Vendor was down (or misconfigured, now fixed) — try again.
  const pending = await db
    .select({ id: sellerVerifications.id })
    .from(sellerVerifications)
    .where(
      and(
        eq(sellerVerifications.status, "PENDING"),
        isNotNull(sellerVerifications.numberEncrypted),
        lt(sellerVerifications.lastAttemptAt, new Date(now.getTime() - rule.pendingRetryMinutes * 60_000)),
      ),
    )
    .limit(MAX_VENDOR_CALLS_PER_STEP);
  await recheckAll(pending.map((r) => r.id), "pendingRetried");

  // 2. Periodic GSTIN re-check.
  const gst = await db
    .select({ id: sellerVerifications.id })
    .from(sellerVerifications)
    .where(
      and(
        eq(sellerVerifications.docType, "GSTIN"),
        eq(sellerVerifications.status, "VERIFIED"),
        isNotNull(sellerVerifications.numberEncrypted),
        lt(sellerVerifications.lastAttemptAt, new Date(now.getTime() - rule.gstRecheckDays * DAY_MS)),
      ),
    )
    .limit(MAX_VENDOR_CALLS_PER_STEP);
  await recheckAll(gst.map((r) => r.id), "gstRechecked");

  // 3. Expiry warnings.
  const warnUntil = isoDay(new Date(now.getTime() + rule.expiryWarningDays * DAY_MS));
  const expiring = await db
    .select({ v: sellerVerifications, shop: shops })
    .from(sellerVerifications)
    .innerJoin(shops, eq(shops.id, sellerVerifications.shopId))
    .where(
      and(
        eq(sellerVerifications.status, "VERIFIED"),
        inArray(sellerVerifications.docType, ["FSSAI", "SHOP_ACT"]),
        gte(sellerVerifications.validUntil, todayIso),
        lte(sellerVerifications.validUntil, warnUntil),
        sql`NOT EXISTS (SELECT 1 FROM ${sellerVerificationEvents} e
              WHERE e.verification_id = ${sellerVerifications.id}
                AND e.event_type = 'EXPIRY_WARNING'
                AND e.note = ${sellerVerifications.validUntil}::text)`,
      ),
    );
  for (const { v, shop } of expiring) {
    const label = SELLER_DOC_LABELS[v.docType];
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_DOCUMENT_EXPIRING,
      title: `${label} expires on ${v.validUntil}`,
      body: `${shop.name}'s ${label} expires on ${v.validUntil}. Renew it and submit the new one before then, or your shop will be taken offline.`,
      actionUrl: "/shop/verification",
      dedupeKey: `seller-doc-expiring:${v.id}:${v.validUntil}`,
    });
    await db.insert(sellerVerificationEvents).values({
      verificationId: v.id,
      shopId: v.shopId,
      docType: v.docType,
      eventType: "EXPIRY_WARNING",
      note: v.validUntil,
    });
    result.expiryWarnings += 1;
  }

  // 4. Past expiry → EXPIRED.
  const lapsed = await db
    .update(sellerVerifications)
    .set({ status: "EXPIRED", lastErrorCode: "document_expired", updatedAt: now })
    .where(and(eq(sellerVerifications.status, "VERIFIED"), lt(sellerVerifications.validUntil, todayIso)))
    .returning();
  for (const v of lapsed) {
    await db.insert(sellerVerificationEvents).values({
      verificationId: v.id,
      shopId: v.shopId,
      docType: v.docType,
      eventType: "EXPIRED",
      fromStatus: "VERIFIED",
      toStatus: "EXPIRED",
      note: v.validUntil,
    });
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, v.shopId), columns: { ownerId: true, name: true } });
    if (shop) {
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.SHOP_DOCUMENT_ATTENTION,
        title: `${SELLER_DOC_LABELS[v.docType]} has expired`,
        body: `${shop.name}'s ${SELLER_DOC_LABELS[v.docType]} expired on ${v.validUntil}. Submit the renewed document to keep selling.`,
        actionUrl: "/shop/verification",
        dedupeKey: `seller-doc-expired:${v.id}:${v.validUntil}`,
      });
    }
  }
  result.expired = lapsed.length;

  // 5. Mandatory document lapsed → take the shop offline.
  if (rule.autoSuspendOnLapse) {
    const graceCutoff = isoDay(new Date(now.getTime() - rule.suspendGraceDays * DAY_MS));
    const candidates = await db
      .select({ v: sellerVerifications, shop: shops })
      .from(sellerVerifications)
      .innerJoin(shops, eq(shops.id, sellerVerifications.shopId))
      .where(
        and(
          eq(shops.status, "APPROVED"),
          sql`${shops.deletedAt} IS NULL`,
          sql`(
            (${sellerVerifications.status} = 'EXPIRED' AND ${sellerVerifications.validUntil} < ${graceCutoff})
            OR (${sellerVerifications.status} IN ('FAILED', 'EXPIRED')
                AND ${sellerVerifications.lastErrorCode} IN (${sql.join(LAPSED_AT_SOURCE.map((c) => sql`${c}`), sql`, `)}))
          )`,
        ),
      );
    const done = new Set<string>();
    for (const { v, shop } of candidates) {
      if (done.has(shop.id)) continue;
      const facts = await shopFacts(shop);
      if (!isMandatory(v.docType, facts)) continue;
      const label = SELLER_DOC_LABELS[v.docType];
      const why = v.status === "EXPIRED" ? `expired on ${v.validUntil}` : "is no longer valid in the government record";
      try {
        const { suspension } = await suspendShopWithPolicy(
          shop.id,
          {
            reason: `Mandatory document lapsed: ${label} (${v.numberMasked ?? "on file"}) ${why}.`,
            expectedAction: `Submit a valid ${label} under Shop → Verification. Your shop is reinstated after it is verified.`,
          },
          null,
        );
        await db.insert(sellerVerificationEvents).values({
          verificationId: v.id,
          shopId: shop.id,
          docType: v.docType,
          eventType: "SHOP_SUSPENDED",
          note: suspension.id,
        });
        done.add(shop.id);
        result.shopsSuspended += 1;
      } catch (error) {
        result.errors.push(`suspend ${shop.id}: ${(error as Error).message}`);
      }
    }
  }

  // 6. Retention period over → erase.
  for (const shopId of await shopsDueForVerificationErasure(rule.retentionDaysAfterClosure, now)) {
    try {
      await eraseShopVerificationData(shopId, `Retention period of ${rule.retentionDaysAfterClosure} days after closing ended.`, null);
      result.shopsErased += 1;
    } catch (error) {
      result.errors.push(`erase ${shopId}: ${(error as Error).message}`);
    }
  }

  return result;
}
