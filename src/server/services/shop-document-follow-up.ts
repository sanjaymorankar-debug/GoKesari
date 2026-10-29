/**
 * Owner decision, 29 Oct 2026 (docs/shop-documents-2026-10): a live shop whose mandatory
 * documents are still missing is chased on the 1st and 15th of every month (India time) —
 * rule shopDocumentFollowUp. Reminders 1, 2 and 3 go to the owner by e-mail and in the app,
 * even when the owner switched shop e-mails off; at the next run after the third, the shop is
 * suspended automatically (suspendShopWithPolicy, no person) and the owner is told why. A shop
 * that promised its documents is not suspended before its promised date.
 *
 * Chased: a mandatory document (PAN, GSTIN, Shop Act, FSSAI for food) never given, or one that
 * must be sent again (FAILED / EXPIRED). A document waiting for GoKesari's check
 * (PENDING / MANUAL_REVIEW, the "not GST-registered" declaration included) is the team's to
 * finish, not the owner's, so it is not chased. Once nothing is chased the count starts again.
 *
 * Runs from the daily cron (05:00 IST) and does nothing on other days. A second run on the same
 * day sends nothing more: one reminder row per shop per day (shop_document_reminders), and the
 * e-mail is written once per shop and day (dedupe key) after that row is committed.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { addDays, formatDisplayDate, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { SELLER_DOC_LABELS, SELLER_DOC_TYPES, type SellerDocType } from "@/lib/kyc/doc-formats";
import type { RuleValue } from "@/server/config/rules";
import { db } from "@/server/db";
import { sellerVerifications, shopDocumentReminders, shops, type Shop } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { notify } from "./notifications";
import { isMandatory } from "./seller-verification-checks";
import { getRule } from "./settings";
import { documentsDueLabel } from "./shop-document-gate";
import { suspendShopWithPolicy } from "./shop-suspension";

/** The owner sent it and it waits for GoKesari's check: not chased. */
const WITH_THE_TEAM = new Set(["PENDING", "MANUAL_REVIEW"]);
const CHUNK = 500;

export interface ShopDocumentFollowUpResult {
  day: IsoDate;
  /** False on a day that is not a reminder day, or with the rule switched off. */
  acting: boolean;
  checked: number;
  reminded: number;
  suspended: number;
  /** Shops whose documents are complete now: their reminder count was cleared. */
  cleared: number;
  /** Reminders all sent, the promised date not reached yet. */
  waiting: number;
  failed: number;
}

export interface ShopMissingDocuments {
  shop: Pick<Shop, "id" | "name" | "registrationNumber" | "ownerId" | "ownerName" | "phone" | "city" | "status" | "approvedAt" | "documentsPromisedAt" | "documentsDueAt">;
  /** Documents the owner has to provide. */
  missing: SellerDocType[];
  /** Documents waiting for GoKesari's check. */
  withTeam: SellerDocType[];
  remindersSent: number;
  lastReminderOn: string | null;
  /** The promised date has passed. */
  overdue: boolean;
}

/** Live shops with a mandatory document not verified — the admin "Missing documents" list and the job's input. */
export async function shopsMissingDocuments(
  options: { statuses?: Shop["status"][]; now?: Date } = {},
): Promise<ShopMissingDocuments[]> {
  const statuses = options.statuses ?? ["APPROVED"];
  const now = (options.now ?? new Date()).getTime();
  const rows = await db
    .select({
      shop: {
        id: shops.id,
        name: shops.name,
        registrationNumber: shops.registrationNumber,
        ownerId: shops.ownerId,
        ownerName: shops.ownerName,
        phone: shops.phone,
        city: shops.city,
        status: shops.status,
        approvedAt: shops.approvedAt,
        documentsPromisedAt: shops.documentsPromisedAt,
        documentsDueAt: shops.documentsDueAt,
      },
      sellsFood: sql<boolean>`shop_sells_food(${shops.id}, ${shops.shopType}::text)`,
    })
    .from(shops)
    .where(and(inArray(shops.status, statuses), isNull(shops.deletedAt)))
    .orderBy(shops.name);

  const out: ShopMissingDocuments[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ids = chunk.map((r) => r.shop.id);
    const [documents, reminders] = await Promise.all([
      db
        .select({ shopId: sellerVerifications.shopId, docType: sellerVerifications.docType, status: sellerVerifications.status })
        .from(sellerVerifications)
        .where(inArray(sellerVerifications.shopId, ids)),
      db
        .select({ shopId: shopDocumentReminders.shopId, sentOn: shopDocumentReminders.sentOn })
        .from(shopDocumentReminders)
        .where(inArray(shopDocumentReminders.shopId, ids)),
    ]);
    for (const row of chunk) {
      const status = new Map(documents.filter((d) => d.shopId === row.shop.id).map((d) => [d.docType, d.status as string]));
      const notVerified = SELLER_DOC_TYPES.filter(
        (d) => isMandatory(d, { isFoodBusiness: row.sellsFood }) && status.get(d) !== "VERIFIED",
      );
      if (notVerified.length === 0) continue;
      const sent = reminders.filter((r) => r.shopId === row.shop.id).map((r) => String(r.sentOn)).sort();
      out.push({
        shop: row.shop,
        missing: notVerified.filter((d) => !WITH_THE_TEAM.has(status.get(d) ?? "")),
        withTeam: notVerified.filter((d) => WITH_THE_TEAM.has(status.get(d) ?? "")),
        remindersSent: sent.length,
        lastReminderOn: sent.at(-1) ?? null,
        overdue: row.shop.documentsDueAt !== null && row.shop.documentsDueAt.getTime() < now,
      });
    }
  }
  return out;
}

/** The next reminder day after `today` (1st / 15th by default). */
export function nextFollowUpDay(today: IsoDate, days: readonly number[]): IsoDate {
  for (let n = 1; n <= 62; n += 1) {
    const day = addDays(today, n);
    if (days.includes(Number(day.slice(8, 10)))) return day;
  }
  return addDays(today, 31);
}

export async function runShopDocumentFollowUp(
  today: IsoDate = todayIn(getEnv().APP_TIMEZONE),
  now: Date = new Date(),
): Promise<ShopDocumentFollowUpResult> {
  const result: ShopDocumentFollowUpResult = { day: today, acting: false, checked: 0, reminded: 0, suspended: 0, cleared: 0, waiting: 0, failed: 0 };
  const rule = await getRule("shopDocumentFollowUp");
  if (!rule.enabled || !rule.reminderDaysOfMonth.includes(Number(today.slice(8, 10)))) return result;
  result.acting = true;

  const candidates = await shopsMissingDocuments();
  const chased = new Set(candidates.filter((c) => c.missing.length > 0).map((c) => c.shop.id));
  // Documents complete (or only with the team), or the shop no longer live: the count starts again.
  const counted = await db.selectDistinct({ shopId: shopDocumentReminders.shopId }).from(shopDocumentReminders);
  const done = counted.map((r) => r.shopId).filter((id) => !chased.has(id));
  for (let i = 0; i < done.length; i += CHUNK) {
    await db.delete(shopDocumentReminders).where(inArray(shopDocumentReminders.shopId, done.slice(i, i + CHUNK)));
  }
  result.cleared = done.length;

  for (const c of candidates) {
    if (c.missing.length === 0) continue;
    result.checked += 1;
    try {
      const outcome = await followUpShop(c, today, now, rule);
      if (outcome === "REMINDED") result.reminded += 1;
      else if (outcome === "SUSPENDED") result.suspended += 1;
      else if (outcome === "WAITING") result.waiting += 1;
    } catch (error) {
      result.failed += 1;
      console.error("[shop-document-follow-up] shop failed", c.shop.id, error);
    }
  }
  return result;
}

type Rule = RuleValue<"shopDocumentFollowUp">;

async function followUpShop(
  c: ShopMissingDocuments,
  today: IsoDate,
  now: Date,
  rule: Rule,
): Promise<"REMINDED" | "SUSPENDED" | "WAITING" | "DONE_TODAY"> {
  const { shop } = c;
  if (c.lastReminderOn === today) return "DONE_TODAY";
  const labels = c.missing.map((d) => SELLER_DOC_LABELS[d]).join(", ");
  const max = rule.remindersBeforeSuspension;

  if (c.remindersSent >= max) {
    // A promise is kept until its date, whatever the reminders say.
    if (shop.documentsDueAt && shop.documentsDueAt.getTime() > now.getTime()) return "WAITING";
    const reason = `Shop documents not submitted after ${max} reminders: ${labels}.`;
    await suspendShopWithPolicy(
      shop.id,
      {
        reason,
        expectedAction: `Upload ${labels} on GoKesari (Shop → Verification). Our team reinstates the shop once they are verified.`,
        mandatoryNotice: true,
      },
      null,
    );
    // A reinstated shop starts a fresh count.
    await db.delete(shopDocumentReminders).where(eq(shopDocumentReminders.shopId, shop.id));
    await recordAudit({
      action: AUDIT_ACTIONS.SHOP_DOCUMENTS_FOLLOW_UP,
      entityType: "shop",
      entityId: shop.id,
      newValue: { outcome: "SUSPENDED", missing: c.missing, remindersSent: c.remindersSent, day: today },
    });
    return "SUSPENDED";
  }

  const reminderNo = c.remindersSent + 1;
  // The row first (committed), then the e-mail: a re-run the same day finds the row and sends nothing.
  const [row] = await db
    .insert(shopDocumentReminders)
    .values({ shopId: shop.id, sentOn: today, reminderNo, missingDocTypes: c.missing })
    .onConflictDoNothing()
    .returning({ id: shopDocumentReminders.id });
  if (!row) return "DONE_TODAY";

  const next = formatDisplayDate(nextFollowUpDay(today, rule.reminderDaysOfMonth));
  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_DOCUMENTS_FOLLOW_UP,
    vars: {
      shopName: shop.name,
      reminderNo,
      maxReminders: max,
      documents: labels,
      deadline: shop.documentsDueAt ? `You promised to provide them by ${documentsDueLabel(shop.documentsDueAt)}.` : "",
      warning:
        reminderNo >= max
          ? `This is the last reminder: if they are still missing on ${next}, your shop will be suspended automatically.`
          : `If they are still missing after reminder ${max}, your shop will be suspended automatically.`,
    },
    actionUrl: `/shop/verification?shop=${shop.id}`,
    dedupeKey: `shop-documents-follow-up:${shop.id}:${today}`,
    mandatory: true,
  });
  await recordAudit({
    action: AUDIT_ACTIONS.SHOP_DOCUMENTS_FOLLOW_UP,
    entityType: "shop",
    entityId: shop.id,
    newValue: { outcome: "REMINDED", reminderNo, missing: c.missing, day: today },
  });
  return "REMINDED";
}
