/**
 * Owner decision, 29 Oct 2026 (docs/shop-documents-2026-10): a live shop whose mandatory
 * documents are still missing is chased on the 1st and 15th of every month (India time) —
 * rule shopDocumentFollowUp. Reminders 1, 2 and 3 go to the owner by e-mail and in the app,
 * even when the owner switched shop e-mails off; at the next run after the third, the shop is
 * suspended automatically (suspendShopWithPolicy, no person) and the owner is told why. A shop
 * that promised its documents is not suspended before its promised date.
 *
 * Owner decision, 29 Oct 2026 (later the same day): a shop approved without its documents (a
 * waiver, shop_document_waivers) or on the promise is given graceDays (3 months) instead — from
 * its latest waiver, or from its approval for a promise. It is reminded on every reminder day
 * (every 15 days) until then, however many reminders that is, and suspended at the first run after.
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
import { sellerVerifications, shopDocumentReminders, shopDocumentWaivers, shops, type Shop } from "@/server/db/schema";
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

  const lastWaiver = await latestWaivers(candidates.filter((c) => c.missing.length > 0).map((c) => c.shop.id));
  for (const c of candidates) {
    if (c.missing.length === 0) continue;
    result.checked += 1;
    try {
      const outcome = await followUpShop(c, today, now, rule, graceUntil(c.shop, lastWaiver.get(c.shop.id) ?? null, rule.graceDays));
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

/** Each shop's latest document waiver (an admin's approval without documents). */
async function latestWaivers(shopIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (let i = 0; i < shopIds.length; i += CHUNK) {
    const rows = await db
      .select({ shopId: shopDocumentWaivers.shopId, at: sql<Date>`max(${shopDocumentWaivers.createdAt})`.mapWith((v) => new Date(v)) })
      .from(shopDocumentWaivers)
      .where(inArray(shopDocumentWaivers.shopId, shopIds.slice(i, i + CHUNK)))
      .groupBy(shopDocumentWaivers.shopId);
    for (const r of rows) out.set(r.shopId, r.at);
  }
  return out;
}

/**
 * The end of a waived or promised shop's grace: graceDays after its latest waiver, or after its
 * approval when it promised its documents (never before the promised date). Null for other shops.
 */
export function graceUntil(
  shop: Pick<Shop, "approvedAt" | "documentsPromisedAt" | "documentsDueAt">,
  lastWaiverAt: Date | null,
  graceDays: number,
): Date | null {
  const ends: number[] = [];
  const day = 24 * 60 * 60 * 1000;
  if (lastWaiverAt) ends.push(lastWaiverAt.getTime() + graceDays * day);
  if (shop.documentsPromisedAt) {
    const from = shop.approvedAt ?? shop.documentsPromisedAt;
    ends.push(from.getTime() + graceDays * day);
    if (shop.documentsDueAt) ends.push(shop.documentsDueAt.getTime());
  }
  return ends.length > 0 ? new Date(Math.max(...ends)) : null;
}

async function followUpShop(
  c: ShopMissingDocuments,
  today: IsoDate,
  now: Date,
  rule: Rule,
  grace: Date | null,
): Promise<"REMINDED" | "SUSPENDED" | "WAITING" | "DONE_TODAY"> {
  const { shop } = c;
  if (c.lastReminderOn === today) return "DONE_TODAY";
  const labels = c.missing.map((d) => SELLER_DOC_LABELS[d]).join(", ");
  const max = rule.remindersBeforeSuspension;
  const graceOver = grace !== null && grace.getTime() <= now.getTime();

  if (graceOver || (grace === null && c.remindersSent >= max)) {
    // A promise is kept until its date, whatever the reminders say.
    if (grace === null && shop.documentsDueAt && shop.documentsDueAt.getTime() > now.getTime()) return "WAITING";
    const reason = grace
      ? `Shop documents not submitted within ${rule.graceDays} days of approval without them: ${labels}.`
      : `Shop documents not submitted after ${max} reminders: ${labels}.`;
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
      newValue: { outcome: "SUSPENDED", missing: c.missing, remindersSent: c.remindersSent, day: today, graceUntil: grace?.toISOString() ?? null },
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

  const nextDay = nextFollowUpDay(today, rule.reminderDaysOfMonth);
  const next = formatDisplayDate(nextDay);
  const graceLabel = grace ? formatDisplayDate(todayIn(getEnv().APP_TIMEZONE, grace)) : null;
  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_DOCUMENTS_FOLLOW_UP,
    vars: {
      shopName: shop.name,
      reminderNo,
      maxReminders: grace ? "" : ` of ${max}`,
      documents: labels,
      deadline: grace
        ? `Your shop was approved before its documents; they are due by ${graceLabel}.`
        : shop.documentsDueAt
          ? `You promised to provide them by ${documentsDueLabel(shop.documentsDueAt)}.`
          : "",
      warning: grace
        ? `If they are still missing on ${graceLabel}, your shop will be suspended automatically. We will remind you every 15 days until then.`
        : reminderNo >= max
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
