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
 * Owner request, 21-Nov-2026 (fssai-waiver.ts): a food shop an admin approved without its FSSAI
 * licence has until that waiver's due date (rule documentUpload.fssaiWaiverDays, 30) when that is
 * sooner: it is reminded until then and suspended at the first run after, unless a valid licence
 * is on file by then (the same test as the approval gate).
 *
 * Chased: a mandatory document (PAN, GSTIN, Shop Act, FSSAI for food) never given, or one that
 * must be sent again (FAILED / EXPIRED). A document waiting for GoKesari's check
 * (PENDING / MANUAL_REVIEW, the "not GST-registered" declaration included) is the team's to
 * finish, not the owner's, so it is not chased. Once nothing is chased the count starts again.
 *
 * DF-09 (owner, 22-Nov-2026): what is chased beyond the GSTIN / PAN is the admin's choice
 * (shop-document-rules.ts): every document the rules make must-have or "on the promise" for the shop's
 * type — Shop Act, FSSAI for food, a pharmacy's drug licence, a clinic's registration, and any document
 * an admin added — and nothing set to optional. When an admin makes a document needed after a shop went
 * live, that shop is reminded but not suspended for it before the rule's date (live_shops_due_at).
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
import {
  registrationLicenceEntries,
  sellerVerifications,
  shopDocumentReminders,
  shopDocumentWaivers,
  shopLegalDocuments,
  shopRegistrationDrafts,
  shops,
  users,
  type Shop,
} from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { fssaiStatus } from "./document-uploads";
import { latestFssaiDueDates } from "./fssai-waiver";
import { notify } from "./notifications";
import { isMandatory } from "./seller-verification-checks";
import { getRule } from "./settings";
import { documentsDueLabel } from "./shop-document-gate";
import { loadDocumentRuleSet, requirementsFromRuleSet, shopIsDoctorSql } from "./shop-document-rules";
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
  /** Onboarding v2 (owner, 27-Nov-2026): shops this follow-up had suspended, reinstated now their documents are given. */
  reactivated: number;
  /** Reminders all sent, the promised date not reached yet. */
  waiting: number;
  failed: number;
}

export interface ShopMissingDocuments {
  shop: Pick<Shop, "id" | "name" | "registrationNumber" | "ownerId" | "ownerName" | "phone" | "city" | "status" | "approvedAt" | "documentsPromisedAt" | "documentsDueAt" | "shopType">;
  /** Documents the owner has to provide. */
  missing: SellerDocType[];
  /** Licences and admin-added documents the rules need, not uploaded yet (labels). */
  missingLicences: string[];
  /**
   * DF-09: documents made needed after the shop went live, whose date (the rule's live_shops_due_at) has
   * not come: reminded, never a reason to suspend before then.
   */
  upcoming: { label: string; dueAt: Date }[];
  /** Must-have documents among the missing ones (labels): an admin's waiver due date applies to them. */
  mustHaveMissing: string[];
  /** DF-09: the latest rule date (live_shops_due_at, passed) among the documents due now, if any. */
  ruleDueAt: Date | null;
  /** Registered through the wizard: graceDays from going live, however many reminders that is. */
  wizardRegistered: boolean;
  /** Documents waiting for GoKesari's check. */
  withTeam: SellerDocType[];
  remindersSent: number;
  lastReminderOn: string | null;
  /** The promised date has passed. */
  overdue: boolean;
}

/** Live shops with a mandatory document not verified — the admin "Missing documents" list and the job's input. */
export async function shopsMissingDocuments(
  options: { statuses?: Shop["status"][]; now?: Date; shopIds?: string[] } = {},
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
        shopType: shops.shopType,
      },
      sellsFood: sql<boolean>`shop_sells_food(${shops.id}, ${shops.shopType}::text)`,
      isDoctor: shopIsDoctorSql(),
    })
    .from(shops)
    .where(and(inArray(shops.status, statuses), isNull(shops.deletedAt), options.shopIds ? inArray(shops.id, options.shopIds.length ? options.shopIds : ["00000000-0000-0000-0000-000000000000"]) : undefined))
    .orderBy(shops.name);

  const ruleSet = await loadDocumentRuleSet();
  const out: ShopMissingDocuments[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ids = chunk.map((r) => r.shop.id);
    const [documents, reminders, licences, drafts, registered] = await Promise.all([
      db
        .select({ shopId: sellerVerifications.shopId, docType: sellerVerifications.docType, status: sellerVerifications.status })
        .from(sellerVerifications)
        .where(inArray(sellerVerifications.shopId, ids)),
      db
        .select({ shopId: shopDocumentReminders.shopId, sentOn: shopDocumentReminders.sentOn })
        .from(shopDocumentReminders)
        .where(inArray(shopDocumentReminders.shopId, ids)),
      db
        .select({ shopId: shopLegalDocuments.shopId, docType: shopLegalDocuments.docType, licenceKey: shopLegalDocuments.licenceKey, status: shopLegalDocuments.status, expiryDate: shopLegalDocuments.expiryDate })
        .from(shopLegalDocuments)
        .where(inArray(shopLegalDocuments.shopId, ids)),
      db
        .select({ shopId: shopRegistrationDrafts.shopId })
        .from(shopRegistrationDrafts)
        .where(and(inArray(shopRegistrationDrafts.shopId, ids), inArray(shopRegistrationDrafts.status, ["SUBMITTED", "COMPLETED"]))),
      // Onboarding v2: a licence entered, uploaded or scanned at registration (verified, or with GoKesari's team) is
      // given — not chased. Only v2 registrations have these rows, so nothing changes for any other shop.
      db
        .select({ shopId: registrationLicenceEntries.shopId, licenceKey: registrationLicenceEntries.licenceKey })
        .from(registrationLicenceEntries)
        .where(and(inArray(registrationLicenceEntries.shopId, ids), inArray(registrationLicenceEntries.status, ["VERIFIED", "PENDING_OPERATOR"]))),
    ]);
    const wizardShops = new Set(drafts.map((d) => d.shopId));
    // Owner, 28-Nov-2026: an expired licence promised for renewal at registration is chased like a missing promised
    // one — only a licence on file that has not expired counts as given for it.
    const renewals = await (await import("@/server/onboarding-v2/licence-renewals")).openRenewalKeys(ids);
    const todayIso = new Date(now + 330 * 60_000).toISOString().slice(0, 10);
    for (const row of chunk) {
      const status = new Map(documents.filter((d) => d.shopId === row.shop.id).map((d) => [d.docType, d.status as string]));
      const givenAtRegistration = new Set(registered.filter((r) => r.shopId === row.shop.id).map((r) => r.licenceKey));
      // A seller document given at v2 registration and not checked yet counts as with GoKesari's team (WITH_THE_TEAM).
      for (const key of givenAtRegistration) {
        const current = status.get(key as SellerDocType);
        if (current !== "VERIFIED" && !WITH_THE_TEAM.has(current ?? "")) status.set(key as SellerDocType, "PENDING");
      }
      const wizardRegistered = wizardShops.has(row.shop.id);
      // DF-08 (owner, 21-Nov-2026): "PAN / GST" — a wizard shop with either one verified is not chased for the other.
      const identityVerified = wizardRegistered && (status.get("GSTIN") === "VERIFIED" || status.get("PAN") === "VERIFIED");
      const identity = SELLER_DOC_TYPES.filter(
        (d) =>
          (d === "GSTIN" || d === "PAN") &&
          isMandatory(d, { isFoodBusiness: row.sellsFood }) &&
          status.get(d) !== "VERIFIED" &&
          !identityVerified,
      );
      // DF-09: everything else from the admin's rules (optional documents are never chased).
      const needed = requirementsFromRuleSet(ruleSet, row.shop.shopType, row.sellsFood, row.isDoctor).filter((r) => r.level !== "OPTIONAL");
      const sellerNeeded = needed.filter((r) => r.kind === "seller" && status.get(r.key as SellerDocType) !== "VERIFIED");
      const shopLicences = licences.filter((l) => l.shopId === row.shop.id);
      const renewing = renewals.get(row.shop.id);
      const licenceNeeded = needed.filter(
        (r) =>
          r.kind !== "seller" &&
          !givenAtRegistration.has(r.key) &&
          !shopLicences.some(
            (l) =>
              (r.kind === "custom" ? l.docType === "OTHER_LICENCE" && l.licenceKey === r.key : l.docType === r.key && l.licenceKey === "") &&
              (l.status === "SUBMITTED" || l.status === "APPROVED") &&
              (!renewing?.has(r.key) || !l.expiryDate || l.expiryDate >= todayIso),
          ),
      );
      const later = (r: { liveShopsDueAt: Date | null }) => r.liveShopsDueAt !== null && r.liveShopsDueAt.getTime() > now;
      const notVerified: SellerDocType[] = [...identity, ...sellerNeeded.filter((r) => !later(r)).map((r) => r.key as SellerDocType)];
      const licencesDue = licenceNeeded.filter((r) => !later(r));
      const upcoming = [...sellerNeeded, ...licenceNeeded]
        .filter((r) => later(r) && !(r.kind === "seller" && WITH_THE_TEAM.has(status.get(r.key as SellerDocType) ?? "")))
        .map((r) => ({ label: r.kind === "seller" ? SELLER_DOC_LABELS[r.key as SellerDocType] : r.label, dueAt: r.liveShopsDueAt! }));
      if (notVerified.length === 0 && licencesDue.length === 0 && upcoming.length === 0) continue;
      const sent = reminders.filter((r) => r.shopId === row.shop.id).map((r) => String(r.sentOn)).sort();
      const missing = notVerified.filter((d) => !WITH_THE_TEAM.has(status.get(d) ?? ""));
      const mustHaveMissing = [
        ...sellerNeeded.filter((r) => r.level === "MUST_HAVE" && missing.includes(r.key as SellerDocType)).map((r) => SELLER_DOC_LABELS[r.key as SellerDocType]),
        ...licencesDue.filter((r) => r.level === "MUST_HAVE").map((r) => r.label),
      ];
      const ruleDates = [...sellerNeeded, ...licenceNeeded]
        .filter((r) => r.liveShopsDueAt !== null && !later(r))
        .map((r) => r.liveShopsDueAt!.getTime());
      out.push({
        shop: row.shop,
        ruleDueAt: ruleDates.length > 0 ? new Date(Math.max(...ruleDates)) : null,
        missing,
        withTeam: notVerified.filter((d) => WITH_THE_TEAM.has(status.get(d) ?? "")),
        missingLicences: licencesDue.map((r) => r.label),
        upcoming,
        mustHaveMissing,
        wizardRegistered,
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
  const result: ShopDocumentFollowUpResult = { day: today, acting: false, checked: 0, reminded: 0, suspended: 0, cleared: 0, reactivated: 0, waiting: 0, failed: 0 };
  // docs/flows-v3/wave3.md (flag flow_f5): licences given at a v2 registration are in the shop's licence register
  // (back-fill for shops created before), and promised licences given since are marked given — before anyone is chased.
  await (await import("@/server/flows/f5-licences"))
    .backfillRegistrationLicences()
    .catch((error: unknown) => console.error("[shop-document-follow-up] registration licence back-fill failed", error));
  // Onboarding v2 (owner, 27-Nov-2026): every day, the safety net for the automatic reinstatement that follows each
  // document upload — a shop this follow-up suspended whose documents are all given now is live again.
  result.reactivated = await (await import("@/server/onboarding-v2/document-reactivation"))
    .reactivateDocumentSuspensions()
    .catch((error: unknown) => {
      console.error("[shop-document-follow-up] automatic reinstatement failed", error);
      return 0;
    });
  const rule = await getRule("shopDocumentFollowUp");
  if (!rule.enabled || !rule.reminderDaysOfMonth.includes(Number(today.slice(8, 10)))) return result;
  result.acting = true;

  const candidates = await shopsMissingDocuments({ now });
  const isChased = (c: ShopMissingDocuments) => c.missing.length > 0 || c.missingLicences.length > 0 || c.upcoming.length > 0;
  const chased = new Set(candidates.filter(isChased).map((c) => c.shop.id));
  // Documents complete (or only with the team), or the shop no longer live: the count starts again.
  const counted = await db.selectDistinct({ shopId: shopDocumentReminders.shopId }).from(shopDocumentReminders);
  const done = counted.map((r) => r.shopId).filter((id) => !chased.has(id));
  for (let i = 0; i < done.length; i += CHUNK) {
    await db.delete(shopDocumentReminders).where(inArray(shopDocumentReminders.shopId, done.slice(i, i + CHUNK)));
  }
  result.cleared = done.length;

  const chasedIds = candidates.filter(isChased).map((c) => c.shop.id);
  const lastWaiver = await latestWaivers(chasedIds);
  const fssaiDue = await latestFssaiDueDates(chasedIds);
  for (const c of candidates) {
    if (!isChased(c)) continue;
    result.checked += 1;
    try {
      let grace = graceUntil(c.shop, lastWaiver.get(c.shop.id) ?? null, rule.graceDays, c.wizardRegistered);
      // Approved without its must-have documents (FSSAI, or what else the admin made must-have): the waiver's
      // due date, when sooner — unless FSSAI was the only one and a valid licence is on file now.
      const due = fssaiDue.get(c.shop.id);
      let fssaiDeadline = false;
      const onlyFssai = c.mustHaveMissing.length === 1 && c.missing.includes("FSSAI");
      if (
        due &&
        c.mustHaveMissing.length > 0 &&
        (grace === null || due.getTime() < grace.getTime()) &&
        !(onlyFssai && (await fssaiStatus(c.shop)).onFile)
      ) {
        grace = due;
        fssaiDeadline = true;
      }
      const outcome = await followUpShop(c, today, now, rule, grace, fssaiDeadline);
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
  /** Registered through the wizard (owner, 08-Nov-2026): graceDays from going live. */
  wizardRegistered = false,
): Date | null {
  const ends: number[] = [];
  const day = 24 * 60 * 60 * 1000;
  if (wizardRegistered && shop.approvedAt) ends.push(shop.approvedAt.getTime() + graceDays * day);
  if (lastWaiverAt) ends.push(lastWaiverAt.getTime() + graceDays * day);
  if (shop.documentsPromisedAt) {
    const from = shop.approvedAt ?? shop.documentsPromisedAt;
    ends.push(from.getTime() + graceDays * day);
    if (shop.documentsDueAt) ends.push(shop.documentsDueAt.getTime());
  }
  return ends.length > 0 ? new Date(Math.max(...ends)) : null;
}

/** Admins and operators hear of an automatic suspension too (owner, 08-Nov-2026); it never stops the run. */
async function tellStaffOfSuspension(shop: ShopMissingDocuments["shop"], documents: string, today: IsoDate): Promise<void> {
  try {
    const staff = await db.select({ id: users.id }).from(users).where(and(inArray(users.role, ["ADMIN", "OPERATOR"]), eq(users.status, "ACTIVE")));
    for (const person of staff) {
      await notify({
        userId: person.id,
        type: NOTIFICATION_TYPES.SUPPORT_SHOP_SUSPENDED_DOCUMENTS,
        vars: { shopName: shop.name, documents },
        actionUrl: `/admin/shops/${shop.id}`,
        dedupeKey: `shop-documents-suspended:${shop.id}:${today}:${person.id}`,
        mandatory: true,
      });
    }
  } catch (error) {
    console.error("[shop-document-follow-up] staff notice failed", shop.id, error);
  }
}

/**
 * DF-09: a live shop whose only missing documents were made needed after it went live, before their
 * date: it is reminded on each reminder day (the count does not matter) and never suspended for them
 * before the date.
 */
async function remindUpcoming(c: ShopMissingDocuments, today: IsoDate): Promise<"REMINDED" | "DONE_TODAY"> {
  const { shop } = c;
  const reminderNo = c.remindersSent + 1;
  const [row] = await db
    .insert(shopDocumentReminders)
    .values({ shopId: shop.id, sentOn: today, reminderNo, missingDocTypes: c.upcoming.map((u) => u.label) })
    .onConflictDoNothing()
    .returning({ id: shopDocumentReminders.id });
  if (!row) return "DONE_TODAY";
  const first = [...c.upcoming].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
  const dueLabel = formatDisplayDate(todayIn(getEnv().APP_TIMEZONE, first.dueAt));
  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_DOCUMENTS_FOLLOW_UP,
    vars: {
      shopName: shop.name,
      reminderNo,
      maxReminders: "",
      documents: c.upcoming.map((u) => `${u.label} (by ${formatDisplayDate(todayIn(getEnv().APP_TIMEZONE, u.dueAt))})`).join(", "),
      deadline: `GoKesari now needs ${c.upcoming.length > 1 ? "these documents" : "this document"} from shops like yours, as the law requires. Please upload ${c.upcoming.length > 1 ? "them" : "it"} by ${dueLabel}.`,
      warning: `If ${c.upcoming.length > 1 ? "they are" : "it is"} still missing on ${dueLabel}, your shop will be suspended automatically. We will remind you every 15 days until then.`,
    },
    actionUrl: "/shop/legal-documents",
    dedupeKey: `shop-documents-follow-up:${shop.id}:${today}`,
    mandatory: true,
  });
  await recordAudit({
    action: AUDIT_ACTIONS.SHOP_DOCUMENTS_FOLLOW_UP,
    entityType: "shop",
    entityId: shop.id,
    newValue: { outcome: "REMINDED", reminderNo, upcoming: c.upcoming.map((u) => ({ label: u.label, dueAt: u.dueAt.toISOString() })), day: today },
  });
  return "REMINDED";
}

async function followUpShop(
  c: ShopMissingDocuments,
  today: IsoDate,
  now: Date,
  rule: Rule,
  grace: Date | null,
  /** `grace` is the due date of an admin's FSSAI waiver (fssai-waiver.ts). */
  fssaiDeadline = false,
): Promise<"REMINDED" | "SUSPENDED" | "WAITING" | "DONE_TODAY"> {
  const { shop } = c;
  if (c.lastReminderOn === today) return "DONE_TODAY";
  const labels = [...c.missing.map((d) => SELLER_DOC_LABELS[d]), ...c.missingLicences].join(", ");
  const max = rule.remindersBeforeSuspension;
  const graceOver = grace !== null && grace.getTime() <= now.getTime();
  // DF-09: only documents made needed after the shop went live, and their date has not come.
  const onlyUpcoming = c.missing.length === 0 && c.missingLicences.length === 0;
  if (onlyUpcoming) return remindUpcoming(c, today);

  if (graceOver || (grace === null && c.remindersSent >= max)) {
    // A promise is kept until its date, whatever the reminders say.
    if (grace === null && shop.documentsDueAt && shop.documentsDueAt.getTime() > now.getTime()) return "WAITING";
    const reason = fssaiDeadline
      ? `FSSAI licence not uploaded by ${formatDisplayDate(todayIn(getEnv().APP_TIMEZONE, grace!))}, the date set when the shop was approved without it. Missing: ${labels}.`
      : grace && c.wizardRegistered && shop.documentsPromisedAt
      ? `Shop documents promised at registration not uploaded by ${formatDisplayDate(todayIn(getEnv().APP_TIMEZONE, grace))}: ${labels}.`
      : grace
      ? `Shop documents not submitted within ${rule.graceDays} days of approval without them: ${labels}.`
      : c.ruleDueAt
      ? `Shop documents needed for this type of shop not uploaded by ${formatDisplayDate(todayIn(getEnv().APP_TIMEZONE, c.ruleDueAt))}: ${labels}.`
      : `Shop documents not submitted after ${max} reminders: ${labels}.`;
    // Onboarding v2 (owner, 27-Nov-2026): reinstated automatically as soon as the documents are given.
    const automatic = await (await import("@/server/onboarding-v2/roles")).onboardingV2Enabled();
    await suspendShopWithPolicy(
      shop.id,
      {
        reason,
        expectedAction: automatic
          ? `Upload ${labels} on GoKesari (Shop → Verification). Your shop is live again automatically as soon as they are uploaded.`
          : `Upload ${labels} on GoKesari (Shop → Verification). Our team reinstates the shop once they are verified.`,
        mandatoryNotice: true,
        source: "DOCUMENT_FOLLOW_UP",
      },
      null,
    );
    // A reinstated shop starts a fresh count.
    await db.delete(shopDocumentReminders).where(eq(shopDocumentReminders.shopId, shop.id));
    await tellStaffOfSuspension(shop, labels, today);
    await recordAudit({
      action: AUDIT_ACTIONS.SHOP_DOCUMENTS_FOLLOW_UP,
      entityType: "shop",
      entityId: shop.id,
      newValue: { outcome: "SUSPENDED", missing: c.missing, remindersSent: c.remindersSent, day: today, graceUntil: grace?.toISOString() ?? null, fssaiWaiverDue: fssaiDeadline },
    });
    return "SUSPENDED";
  }

  const reminderNo = c.remindersSent + 1;
  // The row first (committed), then the e-mail: a re-run the same day finds the row and sends nothing.
  const [row] = await db
    .insert(shopDocumentReminders)
    .values({ shopId: shop.id, sentOn: today, reminderNo, missingDocTypes: [...c.missing, ...c.missingLicences, ...c.upcoming.map((u) => u.label)] })
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
      documents: [labels, ...c.upcoming.map((u) => `${u.label} (by ${formatDisplayDate(todayIn(getEnv().APP_TIMEZONE, u.dueAt))})`)].filter(Boolean).join(", "),
      deadline: grace
        ? c.wizardRegistered && shop.documentsPromisedAt && !fssaiDeadline
          ? `You promised to upload them when you registered your shop; they are due by ${graceLabel}.`
          : `Your shop went live before its documents; they are due by ${graceLabel}.`
        : shop.documentsDueAt
          ? `You promised to provide them by ${documentsDueLabel(shop.documentsDueAt)}.`
          : "",
      warning: grace
        ? `If they are still missing on ${graceLabel}, your shop will be suspended automatically. We will remind you every 15 days until then.`
        : reminderNo >= max
          ? `This is the last reminder: if they are still missing on ${next}, your shop will be suspended automatically.`
          : `If they are still missing after reminder ${max}, your shop will be suspended automatically.`,
    },
    // A licence file (FSSAI) is uploaded on Upload documents; the verification page takes numbers only.
    actionUrl:
      c.missing.length === 0 ? "/shop/legal-documents" : c.missing.includes("FSSAI") ? `/shop/documents?shop=${shop.id}` : `/shop/verification?shop=${shop.id}`,
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
