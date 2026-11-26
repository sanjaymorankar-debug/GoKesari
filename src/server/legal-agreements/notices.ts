/**
 * Notices around agreement versions (docs/seller-agreements-2026-11):
 * - sendChangeNotices: when an English version is published, the owners of the shops it applies to get an
 *   e-mail + app notice — "takes effect on <date>; you will be asked to accept it after that" (30-day notice).
 * - runAgreementSweep (daily cron): starts the grace period for live shops that still have to sign (so it
 *   runs even for owners who do not open Seller Central) and reminds owners two days before it ends.
 */
import { and, eq, isNull, lte, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { legalDocuments, legalShopAgreementStates, shops, type LegalDocumentRow } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { getFeatureFlag, flagCoversShop } from "@/server/services/feature-flags";
import { deliverPending, notify } from "@/server/services/notifications";

import { calendarDate, dateTimeIst } from "./i18n";
import { shopsForTypes } from "./registry";
import { getAgreementStatus, MY_AGREEMENTS_URL, SELLER_AGREEMENTS_FLAG } from "./requirements";

export async function sendChangeNotices(row: LegalDocumentRow): Promise<number> {
  const flag = await getFeatureFlag(SELLER_AGREEMENTS_FLAG);
  if (!flag.enabled) return 0; // nobody is asked while the feature is off; the gate explains on first sign-in.
  const targets = await shopsForTypes(row.appliesToShopTypes);
  const effective = calendarDate(row.effectiveDate);
  let sent = 0;
  for (const shop of targets) {
    if (!(await flagCoversShop(flag, { pincode: shop.pincode }))) continue;
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_AGREEMENT_NOTICE,
      vars: {
        title: `${shop.name}: ${row.title} version ${row.version} from ${effective}`,
        message: [
          `${row.title} version ${row.version} takes effect on ${effective}.${row.changeSummary ? ` What changes: ${row.changeSummary}` : ""} You will be asked to review and accept it in Seller Central after that date.`,
          `${row.title} आवृत्ती ${row.version} दिनांक ${effective} पासून लागू होईल. त्यानंतर सेलर सेंट्रलमध्ये ती वाचून स्वीकारावी लागेल.`,
          `${row.title} संस्करण ${row.version} दिनांक ${effective} से लागू होगा। उसके बाद सेलर सेंट्रल में इसे पढ़कर स्वीकार करना होगा।`,
        ].join("\n"),
      },
      actionUrl: `${MY_AGREEMENTS_URL}?shop=${shop.id}`,
      channels: ["EMAIL", "PUSH"],
      mandatory: true,
      deferDelivery: true,
      dedupeKey: `agreement-notice:${row.id}:${shop.id}`,
    });
    sent += 1;
  }
  await db.update(legalDocuments).set({ noticeSentAt: new Date() }).where(eq(legalDocuments.id, row.id));
  if (sent) void deliverPending().catch((error: unknown) => console.error("[seller-agreements] notice delivery failed", error));
  return sent;
}

export async function runAgreementSweep(now: Date = new Date(), limit = 500): Promise<{ skipped?: true; checked: number; reminders: number }> {
  const flag = await getFeatureFlag(SELLER_AGREEMENTS_FLAG);
  if (!flag.enabled) return { skipped: true, checked: 0, reminders: 0 };

  // Live shops not yet tracked as satisfied: evaluate (starts the grace period when a signature is due).
  const candidates = await db
    .select({ id: shops.id, pincode: shops.pincode })
    .from(shops)
    .leftJoin(legalShopAgreementStates, eq(legalShopAgreementStates.shopId, shops.id))
    .where(and(isNull(shops.deletedAt), eq(shops.status, "APPROVED"), sql`(${legalShopAgreementStates.shopId} IS NULL OR ${legalShopAgreementStates.satisfiedAt} IS NOT NULL)`))
    .orderBy(sql`${legalShopAgreementStates.updatedAt} ASC NULLS FIRST`)
    .limit(limit);
  let checked = 0;
  for (const shop of candidates) {
    if (!(await flagCoversShop(flag, { pincode: shop.pincode }))) continue;
    await getAgreementStatus(shop.id, { now }).catch((error) => console.error("[seller-agreements] sweep status failed", shop.id, error));
    checked += 1;
  }

  // Two days before the grace period ends: one reminder.
  const soon = new Date(now.getTime() + 2 * 86_400_000);
  const due = await db
    .select({ shopId: legalShopAgreementStates.shopId, ownerId: legalShopAgreementStates.ownerUserId, graceUntil: legalShopAgreementStates.graceUntil, name: shops.name })
    .from(legalShopAgreementStates)
    .innerJoin(shops, eq(shops.id, legalShopAgreementStates.shopId))
    .where(and(isNull(legalShopAgreementStates.satisfiedAt), isNull(legalShopAgreementStates.reminderSentAt), lte(legalShopAgreementStates.graceUntil, soon), sql`${legalShopAgreementStates.reason} <> 'REGISTRATION'`));
  let reminders = 0;
  for (const row of due) {
    const by = dateTimeIst(row.graceUntil);
    await notify({
      userId: row.ownerId,
      type: NOTIFICATION_TYPES.SHOP_AGREEMENT_NOTICE,
      vars: {
        title: `${row.name}: sign your agreements by ${by}`,
        message: [
          `${row.name} must sign its gokesari.com agreements by ${by}; after that it can't accept new orders until they are signed. Open My Agreements to review and sign.`,
          `${row.name}: ${by} पर्यंत gokesari.com करारांवर स्वाक्षरी करा; त्यानंतर स्वाक्षरी होईपर्यंत नवीन ऑर्डर स्वीकारता येणार नाहीत.`,
          `${row.name}: ${by} तक gokesari.com अनुबंधों पर हस्ताक्षर करें; उसके बाद हस्ताक्षर होने तक नए ऑर्डर स्वीकार नहीं किए जा सकेंगे।`,
        ].join("\n"),
      },
      actionUrl: `${MY_AGREEMENTS_URL}?shop=${row.shopId}`,
      channels: ["EMAIL", "SMS", "PUSH"],
      mandatory: true,
      dedupeKey: `agreement-reminder:${row.shopId}:${row.graceUntil.toISOString()}`,
    });
    await db.update(legalShopAgreementStates).set({ reminderSentAt: now, updatedAt: now }).where(eq(legalShopAgreementStates.shopId, row.shopId));
    reminders += 1;
  }
  return { checked, reminders };
}
