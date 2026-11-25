/**
 * Shop registration subscription (owner brief 25-Nov-2026 02.02 IST; docs/shop-registration-subscription-2026-11).
 *
 * The registration fee buys one year. Built on the yearly membership that already exists (D-69, 0197):
 *   - expiry = shops.membership_valid_until, extended by every fully paid registration / renewal fee
 *     (shop-membership.ts), the gates that close a lapsed shop, the renewal checkout and receipts (0197);
 *   - this module adds the stored status (UNPAID / ACTIVE / EXPIRING_SOON / GRACE / EXPIRED / EXEMPT), the
 *     admin screen's list and actions (reminder, payment link, expiry change, offline Mark as paid — each
 *     audited with who, when, old value, new value and reason), the reminder schedule (unpaid 1 / 3 / 7 days
 *     then weekly; 30 / 15 days, the last 7 days, the expiry day and every grace day) sent at 09:00 IST by
 *     in-app + push + e-mail in English and Marathi with a Pay Now link, the CC digest, and the owner's card.
 *
 * Event-driven: a payment's capture, a link, an admin change update the status and tell the owner at once.
 * The every-15-minutes job only sends what is due by date (from rule reminderHourIst), expires old links and
 * keeps the stored status in step with the clock.
 */
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import { addDays, daysBetween, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { shopTypeLabel } from "@/lib/shop-types";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  paymentIntents,
  referralCodes,
  shopMembershipPeriods,
  shopPayments,
  shopRegistrationDigests,
  shopRegistrationLinks,
  shopRegistrationMigrationReports,
  shopRegistrationReminders,
  shops,
  users,
  type Shop,
  type ShopRegistrationLink,
  type UserRole,
} from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { createPaymentIntent, getPaymentIntentRow, isLive } from "@/server/payments/intents";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { notify } from "./notifications";
import { registrationFeeDue } from "./registration-fee-payment";
import { getRule } from "./settings";
import {
  membershipStatus,
  offlineFromOf,
  refreshRegistrationStatus,
  refreshRegistrationStatusSafely,
  registrationStatusOf,
  renewalFeeQuote,
  renewalQuoteFrom,
  shopCategorySlugsByShop,
  type RegistrationStatus,
  type RenewalQuote,
} from "./shop-membership";
import { recordPayment } from "./shop-payments";

const DAY_MS = 86_400_000;
const REGISTRATION_PURPOSE = "SHOP_REGISTRATION_FEE" as const;
const RENEWAL_PURPOSE = "SHOP_MEMBERSHIP_RENEWAL" as const;

export interface StaffActor {
  id: string;
  role: UserRole;
}

function tz(): string {
  return getEnv().APP_TIMEZONE;
}

function site(): string {
  return (process.env.APP_BASE_URL ?? process.env.NEXTAUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
}

/** "25 Nov 2026" in IST. */
export function istDay(d: Date | null | undefined): string {
  return d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: tz() }) : "—";
}

/** "25 Nov 2026, 09.00 IST" — every time shown by this module is IST (owner rule). */
export function istTime(d: Date | null | undefined): string {
  if (!d) return "—";
  const date = istDay(d);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz() }).replace(":", ".");
  return `${date}, ${time} IST`;
}

function assertStaff(actor: StaffActor): void {
  if (!can(actor.role, PERMISSIONS.SHOP_REGISTRATION_SUBSCRIPTION_MANAGE)) {
    throw forbidden("Only an admin or an operator can manage shop registrations.");
  }
}

/* ================================================================ pure */

/** Whole days from today (IST) to the expiry date (IST); negative once it passed. Null without an expiry. */
export function daysLeft(until: Date | null, now: Date = new Date(), timeZone = "Asia/Kolkata"): number | null {
  if (!until) return null;
  return daysBetween(todayIn(timeZone, now), todayIn(timeZone, until));
}

export type ReminderPlan = { kind: "UNPAID" | "RENEWAL"; stage: string } | null;

/**
 * Pure: the reminder a shop is due today, by the rule's schedule.
 *  - UNPAID (no expiry, fee owed): on unpaidReminderDays after registration (U1, U3, U7), then every
 *    unpaidRepeatEveryDays (U14, U21 …) until paid.
 *  - RENEWAL: expiryReminderDays before the expiry (E30, E15, E7 … E0 = the expiry day), then every day of
 *    the grace period when graceDaily (G1, G2 …), and once the day the grace ends (X0).
 */
export function reminderPlanFor(
  input: { status: RegistrationStatus; registeredOn: IsoDate; expiresOn: IsoDate | null; offlineOn: IsoDate | null },
  today: IsoDate,
  rule: { unpaidReminderDays: readonly number[]; unpaidRepeatEveryDays: number; expiryReminderDays: readonly number[]; graceDaily: boolean },
): ReminderPlan {
  if (input.status === "EXEMPT") return null;
  if (input.status === "UNPAID") {
    const days = daysBetween(input.registeredOn, today);
    if (days < 0) return null;
    if (rule.unpaidReminderDays.includes(days)) return { kind: "UNPAID", stage: `U${days}` };
    const last = rule.unpaidReminderDays.length ? Math.max(...rule.unpaidReminderDays) : 0;
    if (rule.unpaidRepeatEveryDays > 0 && days > last && (days - last) % rule.unpaidRepeatEveryDays === 0) return { kind: "UNPAID", stage: `U${days}` };
    return null;
  }
  if (!input.expiresOn) return null;
  const days = daysBetween(today, input.expiresOn);
  if (days >= 0) return rule.expiryReminderDays.includes(days) ? { kind: "RENEWAL", stage: `E${days}` } : null;
  if (input.offlineOn && today === input.offlineOn) return { kind: "RENEWAL", stage: "X0" };
  if (rule.graceDaily && input.offlineOn && today < input.offlineOn) return { kind: "RENEWAL", stage: `G${-days}` };
  return null;
}

/** English + Marathi reminder text (owner brief: bilingual, GoKesari branding is the e-mail layout). */
export function reminderText(input: {
  kind: "UNPAID" | "RENEWAL";
  shopName: string;
  status: RegistrationStatus;
  expiresOn: string | null;
  amount: string;
  link: string;
  daysLeft: number | null;
}): { title: string; message: string } {
  if (input.kind === "UNPAID") {
    return {
      title: `Complete your registration payment — ${input.shopName}`,
      message: [
        `${input.shopName}: registration payment pending. Your shop will not receive orders until the registration fee of ${input.amount} is paid. Your registration is valid for 1 year from the day you pay.`,
        `Pay now: ${input.link}`,
        "",
        `${input.shopName}: नोंदणी शुल्क भरणे बाकी आहे. ${input.amount} नोंदणी शुल्क भरेपर्यंत तुमच्या दुकानाला ऑर्डर मिळणार नाहीत. शुल्क भरल्याच्या दिवसापासून नोंदणी 1 वर्षासाठी वैध राहील.`,
        `आत्ताच भरा: ${input.link}`,
      ].join("\n"),
    };
  }
  const when =
    input.status === "EXPIRED"
      ? { en: `expired on ${input.expiresOn}. Your shop is hidden from customers and gets no new orders until you renew.`, mr: `${input.expiresOn} रोजी संपली आहे. नूतनीकरण करेपर्यंत तुमचे दुकान ग्राहकांना दिसणार नाही आणि नवीन ऑर्डर मिळणार नाहीत.` }
      : input.status === "GRACE"
        ? { en: `expired on ${input.expiresOn}. Your shop works during the grace period only — renew now to keep receiving orders.`, mr: `${input.expiresOn} रोजी संपली आहे. सवलत कालावधीतच दुकान सुरू आहे — ऑर्डर मिळत राहण्यासाठी आत्ताच नूतनीकरण करा.` }
        : input.daysLeft === 0
          ? { en: `expires today (${input.expiresOn}).`, mr: `आज (${input.expiresOn}) संपत आहे.` }
          : { en: `expires on ${input.expiresOn} (${input.daysLeft} day${input.daysLeft === 1 ? "" : "s"} left).`, mr: `${input.expiresOn} रोजी संपत आहे (${input.daysLeft} दिवस बाकी).` };
  return {
    title: input.status === "EXPIRED" || input.status === "GRACE" ? `Renew your shop registration — ${input.shopName}` : `Shop registration expires ${input.daysLeft === 0 ? "today" : `in ${input.daysLeft} days`} — ${input.shopName}`,
    message: [
      `${input.shopName}: your GoKesari shop registration ${when.en} Renewal fee: ${input.amount} for 1 more year.`,
      `Renew registration: ${input.link}`,
      "",
      `${input.shopName}: तुमची GoKesari दुकान नोंदणी ${when.mr} नूतनीकरण शुल्क: ${input.amount} (आणखी 1 वर्षासाठी).`,
      `नोंदणीचे नूतनीकरण करा: ${input.link}`,
    ].join("\n"),
  };
}

/* ================================================================ status */

/** Every shop's stored status brought in step with the clock and the rules (one statement). */
export async function syncRegistrationStatuses(): Promise<number> {
  const rule = await getRule("shopMembership");
  const types = rule.exemptShopTypes;
  const exemptType = types.length > 0 ? sql`shops.shop_type::text in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql`false`;
  const cats = rule.exemptCategorySlugs;
  const exemptCategory =
    cats.length > 0
      ? sql`exists (select 1 from shop_category_mapping scm join shop_categories sc on sc.id = scm.category_id where scm.shop_id = shops.id and sc.slug in (${sql.join(cats.map((c) => sql`${c}`), sql`, `)}))`
      : sql`false`;
  const computed = sql`(case
    when shops.membership_exempt or ${exemptType} or ${exemptCategory} then 'EXEMPT'
    when shops.membership_valid_until is null then
      case when shops.fee_payment_status in ('PENDING', 'PARTIALLY_PAID') and coalesce(shops.registration_fee_paise, 0) > shops.amount_paid_paise then 'UNPAID' else 'ACTIVE' end
    when now() < shops.membership_valid_until - make_interval(days => ${rule.reminderDays}) then 'ACTIVE'
    when now() < shops.membership_valid_until then 'EXPIRING_SOON'
    when ${!rule.enabled}
      or shops.membership_valid_until > now() - make_interval(days => coalesce(shops.registration_grace_days, ${rule.graceDays}))
      or coalesce(shops.registration_grace_until > now(), false) then 'GRACE'
    else 'EXPIRED' end)`;
  const result = await db.execute(sql`
    update shops set registration_status = ${computed}, registration_status_at = now()
    where shops.deleted_at is null and shops.registration_status is distinct from ${computed}`);
  return (result as { rowCount?: number }).rowCount ?? 0;
}

/* ================================================================ list */

export const REGISTRATION_FILTERS = ["ALL", "UNPAID", "EXPIRING_30", "EXPIRING_15", "EXPIRING_7", "GRACE", "EXPIRED", "ACTIVE", "EXEMPT"] as const;
export type RegistrationFilter = (typeof REGISTRATION_FILTERS)[number];

export interface RegistrationRow {
  shopId: string;
  shopName: string;
  slug: string;
  registrationNumber: string;
  ownerName: string;
  phone: string;
  email: string | null;
  shopType: string;
  shopTypeLabel: string;
  shopStatus: string;
  area: string;
  city: string;
  pincode: string;
  dealerCode: string | null;
  registeredAt: Date;
  startDate: Date | null;
  expiryDate: Date | null;
  daysLeft: number | null;
  status: RegistrationStatus;
  amountDuePaise: number;
  /** REGISTRATION (fee not paid) or RENEWAL. */
  dueKind: "REGISTRATION" | "RENEWAL";
  lastReminderAt: Date | null;
  link: { id: string; status: string; amountPaise: number; expiresAt: Date; url: string | null; createdAt: Date } | null;
  remindersEnabled: boolean;
  renewalFeeOverridePaise: number | null;
  graceDaysOverride: number | null;
  graceUntil: Date | null;
  lastPaymentAt: Date | null;
}

export interface RegistrationListFilter {
  filter?: RegistrationFilter;
  shopType?: string;
  area?: string;
  dealerCode?: string;
  q?: string;
  limit?: number;
}

/** The admin list: shops by registration status, filters of the brief, newest problem first. */
export async function listShopRegistrations(
  input: RegistrationListFilter = {},
  now = new Date(),
): Promise<{ rows: RegistrationRow[]; counts: Record<RegistrationStatus, number> & { EXPIRING_7: number; EXPIRING_15: number; EXPIRING_30: number } }> {
  const rule = await getRule("shopMembership");
  const conds: SQL[] = [isNull(shops.deletedAt), sql`${shops.status} in ('PENDING_APPROVAL', 'APPROVED', 'SUSPENDED')`];
  if (input.shopType) conds.push(eq(shops.shopType, input.shopType));
  const area = input.area?.trim();
  if (area) conds.push(or(ilike(shops.area, `%${area}%`), ilike(shops.city, `%${area}%`), ilike(shops.pincode, `%${area}%`))!);
  const q = input.q?.trim();
  if (q) conds.push(or(ilike(shops.name, `%${q}%`), ilike(shops.ownerName, `%${q}%`), ilike(shops.phone, `%${q}%`), ilike(shops.registrationNumber, `%${q}%`))!);
  const dealer = input.dealerCode?.trim();
  if (dealer) conds.push(sql`exists (select 1 from referral_codes rc where rc.id = ${shops.referralCodeId} and rc.code ilike ${`%${dealer}%`})`);

  const list = await db
    .select({ shop: shops, ownerEmail: users.email, dealerCode: referralCodes.code })
    .from(shops)
    .leftJoin(users, eq(users.id, shops.ownerId))
    .leftJoin(referralCodes, eq(referralCodes.id, shops.referralCodeId))
    .where(and(...conds))
    .orderBy(sql`${shops.membershipValidUntil} asc nulls first`, desc(shops.createdAt))
    .limit(Math.min(input.limit ?? 3000, 5000));
  const ids = list.map((r) => r.shop.id);
  const [slugs, reminders, links, gstRate, sub] = await Promise.all([
    rule.exemptCategorySlugs.length > 0 ? shopCategorySlugsByShop(ids) : Promise.resolve(new Map<string, string[]>()),
    ids.length
      ? db
          .select({ shopId: shopRegistrationReminders.shopId, at: sql<string>`max(${shopRegistrationReminders.createdAt})` })
          .from(shopRegistrationReminders)
          .where(and(inArray(shopRegistrationReminders.shopId, ids), eq(shopRegistrationReminders.status, "SENT")))
          .groupBy(shopRegistrationReminders.shopId)
      : Promise.resolve([] as { shopId: string; at: string }[]),
    ids.length
      ? db
          .selectDistinctOn([shopRegistrationLinks.shopId])
          .from(shopRegistrationLinks)
          .where(inArray(shopRegistrationLinks.shopId, ids))
          .orderBy(shopRegistrationLinks.shopId, desc(shopRegistrationLinks.createdAt))
      : Promise.resolve([] as ShopRegistrationLink[]),
    registrationGstRate(now),
    getRule("shopRegistrationSubscription"),
  ]);
  const lastReminder = new Map(reminders.map((r) => [r.shopId, r.at ? new Date(r.at) : null]));
  const linkBy = new Map(links.map((l) => [l.shopId, l]));
  const counts = { UNPAID: 0, ACTIVE: 0, EXPIRING_SOON: 0, GRACE: 0, EXPIRED: 0, EXEMPT: 0, EXPIRING_7: 0, EXPIRING_15: 0, EXPIRING_30: 0 };
  const rows: RegistrationRow[] = [];
  for (const { shop, ownerEmail, dealerCode } of list) {
    const status = registrationStatusOf(shop, membershipStatus(shop, rule, now, slugs.get(shop.id) ?? []));
    const left = daysLeft(shop.membershipValidUntil, now, tz());
    counts[status] += 1;
    if (left != null && left >= 0) {
      if (left <= 30) counts.EXPIRING_30 += 1;
      if (left <= 15) counts.EXPIRING_15 += 1;
      if (left <= 7) counts.EXPIRING_7 += 1;
    }
    if (!matchesFilter(input.filter ?? "ALL", status, left)) continue;
    const dueKind = status === "UNPAID" ? "REGISTRATION" : "RENEWAL";
    const amountDuePaise =
      status === "UNPAID" ? registrationFeeDue(shop) : status === "EXEMPT" ? 0 : renewalQuoteFrom(shop, rule, rule.addGst ? gstRate ?? shop.registrationFeeGstRateBp ?? 0 : 0, sub.renewalFeeByShopType).totalPaise;
    const link = linkBy.get(shop.id);
    rows.push({
      shopId: shop.id,
      shopName: shop.name,
      slug: shop.slug,
      registrationNumber: shop.registrationNumber,
      ownerName: shop.ownerName,
      phone: shop.phone,
      email: shop.email || ownerEmail || null,
      shopType: shop.shopType,
      shopTypeLabel: shopTypeLabel(shop.shopType),
      shopStatus: shop.status,
      area: shop.area ?? "",
      city: shop.city,
      pincode: shop.pincode,
      dealerCode: dealerCode ?? null,
      registeredAt: shop.createdAt,
      startDate: shop.registrationStartDate,
      expiryDate: shop.membershipValidUntil,
      daysLeft: left,
      status,
      amountDuePaise,
      dueKind,
      lastReminderAt: lastReminder.get(shop.id) ?? null,
      link: link
        ? { id: link.id, status: link.status === "ACTIVE" && link.expiresAt <= now ? "EXPIRED" : link.status, amountPaise: link.amountPaise, expiresAt: link.expiresAt, url: link.linkUrl, createdAt: link.createdAt }
        : null,
      remindersEnabled: shop.registrationRemindersEnabled,
      renewalFeeOverridePaise: shop.renewalFeePaise,
      graceDaysOverride: shop.registrationGraceDays,
      graceUntil: shop.registrationGraceUntil,
      lastPaymentAt: shop.lastRegistrationPaymentAt,
    });
  }
  return { rows, counts };
}

function matchesFilter(filter: RegistrationFilter, status: RegistrationStatus, left: number | null): boolean {
  switch (filter) {
    case "ALL":
      return true;
    case "EXPIRING_30":
    case "EXPIRING_15":
    case "EXPIRING_7":
      return left != null && left >= 0 && left <= Number(filter.slice(9)) && status !== "EXEMPT";
    default:
      return status === filter;
  }
}

/** The registration fee's GST rate in force (Admin → Statutory), or null when none is found. */
async function registrationGstRate(at: Date): Promise<number | null> {
  try {
    const { registrationFeeGstRateBp } = await import("./registration-fee-coupons");
    return await registrationFeeGstRateBp(at);
  } catch {
    return null;
  }
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : v instanceof Date ? istDay(v) : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The list as CSV (mobiles masked to the last four digits; dates IST). */
export function registrationRowsCsv(rows: RegistrationRow[]): string {
  const header = ["Shop", "Owner", "Mobile", "E-mail", "Shop type", "Dealer code", "Area", "City", "Registered", "Expiry", "Days left", "Status", "Amount due (Rs)", "Last reminder (IST)", "Payment link"];
  const lines = rows.map((r) =>
    [
      r.shopName,
      r.ownerName,
      r.phone ? `******${r.phone.slice(-4)}` : "",
      r.email,
      r.shopTypeLabel,
      r.dealerCode,
      r.area,
      r.city,
      r.registeredAt,
      r.expiryDate,
      r.daysLeft,
      r.status,
      (r.amountDuePaise / 100).toFixed(2),
      r.lastReminderAt ? istTime(r.lastReminderAt) : "",
      r.link ? `${r.link.status} until ${istTime(r.link.expiresAt)}` : "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}

/* ============================================================ amounts */

async function lockedShop(tx: DbClient, shopId: string): Promise<Shop> {
  const [shop] = await tx.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt))).for("update");
  if (!shop) throw notFound("Shop");
  return shop;
}

async function statusOf(shop: Shop, now = new Date()): Promise<RegistrationStatus> {
  const rule = await getRule("shopMembership");
  const slugs = rule.exemptCategorySlugs.length > 0 ? ((await shopCategorySlugsByShop([shop.id])).get(shop.id) ?? []) : [];
  return registrationStatusOf(shop, membershipStatus(shop, rule, now, slugs));
}

/** What the shop owes now: the rest of the registration fee (UNPAID) or the renewal fee. */
export async function amountDue(shop: Shop, now = new Date()): Promise<{ kind: "REGISTRATION" | "RENEWAL"; amountPaise: number; quote: RenewalQuote | null; status: RegistrationStatus }> {
  const status = await statusOf(shop, now);
  if (status === "UNPAID") return { kind: "REGISTRATION", amountPaise: registrationFeeDue(shop), quote: null, status };
  if (status === "EXEMPT") return { kind: "RENEWAL", amountPaise: 0, quote: null, status };
  const quote = await renewalFeeQuote(shop, now);
  return { kind: "RENEWAL", amountPaise: quote.totalPaise, quote, status };
}

/* ============================================================== links */

/** The shop's ACTIVE payment link still in date, or null. */
export async function activeLink(shopId: string, now = new Date(), client: DbClient = db): Promise<ShopRegistrationLink | null> {
  const [row] = await client
    .select()
    .from(shopRegistrationLinks)
    .where(and(eq(shopRegistrationLinks.shopId, shopId), eq(shopRegistrationLinks.status, "ACTIVE")))
    .limit(1);
  return row && row.expiresAt > now ? row : null;
}

async function endLink(tx: DbClient, link: ShopRegistrationLink, status: "CANCELLED" | "EXPIRED" | "PAID", reason: string): Promise<void> {
  await tx
    .update(shopRegistrationLinks)
    .set({ status, endedAt: new Date(), endReason: reason.slice(0, 300) })
    .where(and(eq(shopRegistrationLinks.id, link.id), eq(shopRegistrationLinks.status, "ACTIVE")));
}

/** Best effort: the gateway stops accepting the old link (Cashfree: cancel link). Never throws. */
async function cancelAtGateway(intentId: string): Promise<void> {
  try {
    const intent = await getPaymentIntentRow(intentId);
    if (!intent || !isLive(intent) || !intent.gatewayOrderId) return;
    const { getGatewayByName } = await import("@/server/payments/gateway/registry");
    const gateway = getGatewayByName(intent.gateway) as { cancelPaymentLink?: (id: string) => Promise<void> };
    if (gateway.cancelPaymentLink) await gateway.cancelPaymentLink(intent.gatewayOrderId);
  } catch (error) {
    console.error("[registration-subscription] could not cancel the old link at the gateway", intentId, error);
  }
}

export interface CreateLinkInput {
  /** Rupees in paise; default the amount due. */
  amountPaise?: number | null;
  /** Default rule paymentLinkValidityDays. */
  validityDays?: number | null;
  reason?: string | null;
}

/**
 * Create New Payment Link (admin / operator, or the reminder job): cancels the shop's older active link,
 * creates a payment link at the existing gateway for the amount due (or the amount the admin typed), and
 * sends it to the owner (in-app + push + e-mail). Registration fee for an UNPAID shop, renewal otherwise.
 */
export async function createRegistrationLink(
  shopId: string,
  input: CreateLinkInput,
  actor: StaffActor | null,
  now = new Date(),
): Promise<{ link: ShopRegistrationLink; url: string | null }> {
  if (actor) assertStaff(actor);
  const sub = await getRule("shopRegistrationSubscription");
  const [shop] = await db.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  const due = await amountDue(shop, now);
  if (due.status === "EXEMPT") throw conflict(`${shop.name} is exempt from the registration fee.`);
  const amountPaise = input.amountPaise ?? due.amountPaise;
  if (!Number.isInteger(amountPaise) || amountPaise < 100) throw validationFailed("The amount must be at least ₹1.", { fields: { amountPaise: "Enter an amount of at least ₹1." } });
  const validityDays = Math.min(30, Math.max(1, input.validityDays ?? sub.paymentLinkValidityDays));
  const expiresAt = new Date(now.getTime() + validityDays * DAY_MS);

  // The older link stops first (gateway best effort, then ours), so the owner never has two to pay.
  const old = await activeLink(shop.id, new Date(0));
  if (old) {
    await cancelAtGateway(old.paymentIntentId);
    await endLink(db, old, "CANCELLED", "replaced by a new payment link");
    await recordAudit({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_LINK_CANCELLED,
      entityType: "shop",
      entityId: shop.id,
      previousValue: { linkId: old.id, status: "ACTIVE", amountPaise: old.amountPaise, expiresAt: old.expiresAt.toISOString() },
      newValue: { status: "CANCELLED", reason: "replaced by a new payment link" },
    });
  }

  // An admin's amount for an unpaid registration becomes what is owed (recorded, audited).
  if (due.kind === "REGISTRATION" && amountPaise !== due.amountPaise) {
    await db.update(shops).set({ registrationFeePaise: (shop.amountPaidPaise ?? 0) + amountPaise, updatedAt: now }).where(eq(shops.id, shop.id));
  }
  const [owner] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, shop.ownerId));
  const previous = await db.select({ n: sql<number>`count(*)::int` }).from(shopRegistrationLinks).where(eq(shopRegistrationLinks.shopId, shop.id));
  const periodKey = shop.membershipValidUntil ? shop.membershipValidUntil.toISOString().slice(0, 10) : "none";
  const quote: RenewalQuote | null =
    due.kind === "RENEWAL" ? (due.quote && due.quote.totalPaise === amountPaise ? due.quote : { basePaise: amountPaise, gstRateBp: 0, gstPaise: 0, totalPaise: amountPaise, source: "SHOP_OVERRIDE" }) : null;
  const created = await createPaymentIntent({
    purpose: due.kind === "REGISTRATION" ? REGISTRATION_PURPOSE : RENEWAL_PURPOSE,
    referenceId: shop.id,
    userId: shop.ownerId,
    amountPaise,
    customer: { id: shop.ownerId, name: owner?.name ?? shop.ownerName, email: shop.email || owner?.email || null, phone: shop.phone },
    description: due.kind === "REGISTRATION" ? `GoKesari registration fee (1 year) — ${shop.name}` : `GoKesari registration renewal (1 year) — ${shop.name}`,
    idempotencyKey: `shop-registration-link:${shop.id}:${(previous[0]?.n ?? 0) + 1}:${now.getTime()}`,
    mode: "LINK",
    expiresAt,
    returnPath: due.kind === "REGISTRATION" ? `/shop/registration-fee?shop=${shop.id}` : `/shop/manage/registration?shop=${shop.id}`,
    metadata: due.kind === "RENEWAL" ? { renewal: { periodKey, quote }, registrationLink: true } : { registrationLink: true },
  });
  const url = created.linkUrl ?? created.checkout?.url ?? null;
  const [link] = await db
    .insert(shopRegistrationLinks)
    .values({
      shopId: shop.id,
      paymentIntentId: created.intent.id,
      kind: due.kind,
      amountPaise,
      linkUrl: url,
      expiresAt,
      createdBy: actor?.id ?? null,
      createdVia: actor ? "ADMIN" : "REMINDER",
    })
    .returning();
  await recordAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_LINK_CREATED,
    entityType: "shop",
    entityId: shop.id,
    previousValue: old ? { linkId: old.id, amountPaise: old.amountPaise } : null,
    newValue: { linkId: link.id, kind: due.kind, amountPaise, dueAmountPaise: due.amountPaise, expiresAt: expiresAt.toISOString(), validityDays, reason: input.reason ?? null, via: actor ? "ADMIN" : "REMINDER" },
  });

  if (actor) {
    // Sent to the owner at once (event-driven). Reminders carry their own link in the reminder itself.
    const payUrl = url ?? `${site()}/shop/manage/registration?shop=${shop.id}`;
    const amount = formatPaise(amountPaise);
    const till = istTime(expiresAt);
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_REGISTRATION_PAYMENT_LINK,
      vars: {
        title: due.kind === "REGISTRATION" ? `Pay your registration fee — ${shop.name}` : `Renew your shop registration — ${shop.name}`,
        message: [
          `${shop.name}: pay ${amount} for your GoKesari ${due.kind === "REGISTRATION" ? "registration (valid 1 year from payment)" : "registration renewal (1 more year)"}. The link works until ${till}.`,
          `Pay now: ${payUrl}`,
          "",
          `${shop.name}: GoKesari ${due.kind === "REGISTRATION" ? "नोंदणीसाठी (भरल्यापासून 1 वर्ष वैध)" : "नोंदणी नूतनीकरणासाठी (आणखी 1 वर्ष)"} ${amount} भरा. ही लिंक ${till} पर्यंत चालेल.`,
          `आत्ताच भरा: ${payUrl}`,
        ].join("\n"),
      },
      actionUrl: due.kind === "REGISTRATION" ? `/shop/registration-fee?shop=${shop.id}` : `/shop/manage/registration?shop=${shop.id}`,
      channels: ["PUSH", "EMAIL"],
      mandatory: true,
      dedupeKey: `shop-registration-link:${link.id}`,
      metadata: { shopId: shop.id, linkId: link.id, url: payUrl },
    });
    await db.update(shopRegistrationLinks).set({ sentAt: new Date() }).where(eq(shopRegistrationLinks.id, link.id));
  }
  await refreshRegistrationStatusSafely(shop.id);
  return { link, url };
}

/**
 * In the capture transaction of a registration / renewal payment (purpose-handlers): the link that was paid
 * is PAID, any other active link of the shop is cancelled (the money is in).
 */
export async function markRegistrationLinksPaid(tx: DbClient, shopId: string, intentId: string): Promise<void> {
  // Links are created from payment intents, whose ids are UUIDs; anything else has no link.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intentId)) return;
  await tx
    .update(shopRegistrationLinks)
    .set({ status: "PAID", endedAt: new Date(), endReason: "paid" })
    .where(and(eq(shopRegistrationLinks.paymentIntentId, intentId), inArray(shopRegistrationLinks.status, ["ACTIVE", "EXPIRED", "CANCELLED"])));
  await tx
    .update(shopRegistrationLinks)
    .set({ status: "CANCELLED", endedAt: new Date(), endReason: "fee paid by another payment" })
    .where(and(eq(shopRegistrationLinks.shopId, shopId), eq(shopRegistrationLinks.status, "ACTIVE")));
}

/* ======================================================== confirmation */

/** After a registration / renewal payment committed (online or offline): status, owner told by in-app + push + e-mail. */
export async function afterRegistrationPayment(shopId: string, payment: { id: string; reference: string; amountPaise: number; kind: "REGISTRATION" | "RENEWAL" }): Promise<void> {
  try {
    const status = await refreshRegistrationStatus(shopId);
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    if (!shop || !shop.membershipValidUntil || (status !== "ACTIVE" && status !== "EXPIRING_SOON")) return;
    const until = istDay(shop.membershipValidUntil);
    const amount = formatPaise(payment.amountPaise);
    const [period] = await db
      .select({ id: shopMembershipPeriods.id })
      .from(shopMembershipPeriods)
      .where(and(eq(shopMembershipPeriods.shopPaymentId, payment.id), isNull(shopMembershipPeriods.voidedAt)))
      .limit(1);
    const receipt = period ? `${site()}/shop/membership/receipt/${period.id}` : `${site()}/shop/manage/registration?shop=${shop.id}`;
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_REGISTRATION_CONFIRMED,
      vars: {
        title: payment.kind === "RENEWAL" ? `Registration renewed — ${shop.name}` : `Registration active — ${shop.name}`,
        message: [
          `We received ${amount} for ${shop.name}. Your GoKesari shop registration is active until ${until}. Receipt ${payment.reference}: ${receipt}`,
          "",
          `${shop.name} साठी ${amount} मिळाले. तुमची GoKesari दुकान नोंदणी ${until} पर्यंत सक्रिय आहे. पावती ${payment.reference}: ${receipt}`,
        ].join("\n"),
      },
      actionUrl: period ? `/shop/membership/receipt/${period.id}` : `/shop/manage/registration?shop=${shop.id}`,
      channels: ["PUSH", "EMAIL"],
      dedupeKey: `shop-registration-confirmed:${payment.id}`,
      metadata: { shopId: shop.id, paymentId: payment.id, validUntil: shop.membershipValidUntil.toISOString() },
    });
  } catch (error) {
    console.error("[registration-subscription] confirmation failed", shopId, error);
  }
}

/* ============================================================ reminder */

/** Sends one reminder now (in-app + push + e-mail, English + Marathi) with a Pay Now link. */
async function sendReminder(
  shop: Shop,
  plan: { kind: "UNPAID" | "RENEWAL"; stage: string },
  actor: StaffActor | null,
  today: IsoDate,
  now: Date,
): Promise<{ sent: boolean; reason?: string }> {
  // The automatic one claims its (shop, stage, day) first — a second run the same day sends nothing.
  let reminderId: string | null = null;
  if (!actor) {
    const [claimed] = await db
      .insert(shopRegistrationReminders)
      .values({ shopId: shop.id, kind: plan.kind, stage: plan.stage, dueOn: today })
      .onConflictDoNothing()
      .returning({ id: shopRegistrationReminders.id });
    if (!claimed) return { sent: false, reason: "already sent today" };
    reminderId = claimed.id;
  }
  const sub = await getRule("shopRegistrationSubscription");
  const due = await amountDue(shop, now);
  let link = await activeLink(shop.id, now);
  if (!link && sub.autoCreateLink && due.amountPaise > 0) {
    try {
      link = (await createRegistrationLink(shop.id, {}, null, now)).link;
    } catch (error) {
      // No gateway right now: the reminder still goes, with the owner's page as the Pay Now link.
      console.error("[registration-subscription] auto link failed", shop.id, error);
    }
  }
  const payUrl = link?.linkUrl ?? `${site()}${plan.kind === "UNPAID" ? `/shop/registration-fee?shop=${shop.id}` : `/shop/manage/registration?shop=${shop.id}`}`;
  const text = reminderText({
    kind: plan.kind,
    shopName: shop.name,
    status: due.status,
    expiresOn: shop.membershipValidUntil ? istDay(shop.membershipValidUntil) : null,
    amount: formatPaise(due.amountPaise),
    link: payUrl,
    daysLeft: daysLeft(shop.membershipValidUntil, now, tz()),
  });
  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_REGISTRATION_REMINDER,
    vars: text,
    actionUrl: plan.kind === "UNPAID" ? `/shop/registration-fee?shop=${shop.id}` : `/shop/manage/registration?shop=${shop.id}`,
    channels: ["PUSH", "EMAIL"],
    mandatory: true,
    dedupeKey: actor ? undefined : `shop-registration-reminder:${shop.id}:${plan.stage}:${today}`,
    metadata: { shopId: shop.id, stage: plan.stage, kind: plan.kind, linkId: link?.id ?? null, amountPaise: due.amountPaise },
  });
  if (reminderId) {
    await db.update(shopRegistrationReminders).set({ linkId: link?.id ?? null, detail: text.title.slice(0, 300) }).where(eq(shopRegistrationReminders.id, reminderId));
  } else {
    await db.insert(shopRegistrationReminders).values({ shopId: shop.id, kind: plan.kind, stage: plan.stage, dueOn: today, linkId: link?.id ?? null, sentBy: actor!.id, detail: text.title.slice(0, 300) });
  }
  await recordAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_REMINDER_SENT,
    entityType: "shop",
    entityId: shop.id,
    newValue: { kind: plan.kind, stage: plan.stage, amountPaise: due.amountPaise, linkId: link?.id ?? null, channels: "IN_APP,PUSH,EMAIL", via: actor ? "STAFF" : "SCHEDULE" },
  });
  return { sent: true };
}

/** Send Reminder (one shop or a bulk selection): "complete your registration payment" or "renew your registration". */
export async function sendRegistrationReminders(shopIds: string[], actor: StaffActor, now = new Date()): Promise<{ sent: number; skipped: { shopId: string; reason: string }[] }> {
  assertStaff(actor);
  const ids = [...new Set(shopIds)].slice(0, 500);
  if (ids.length === 0) throw validationFailed("Select at least one shop.");
  const rows = await db.select().from(shops).where(and(inArray(shops.id, ids), isNull(shops.deletedAt)));
  const today = todayIn(tz(), now);
  let sent = 0;
  const skipped: { shopId: string; reason: string }[] = [];
  for (const shop of rows) {
    const status = await statusOf(shop, now);
    if (status === "EXEMPT") {
      skipped.push({ shopId: shop.id, reason: "exempt" });
      continue;
    }
    if (status === "ACTIVE" && shop.membershipValidUntil) {
      skipped.push({ shopId: shop.id, reason: "registration active — nothing due" });
      continue;
    }
    const result = await sendReminder(shop, { kind: status === "UNPAID" ? "UNPAID" : "RENEWAL", stage: "MANUAL" }, actor, today, now);
    if (result.sent) sent += 1;
    else skipped.push({ shopId: shop.id, reason: result.reason ?? "not sent" });
  }
  for (const id of ids) if (!rows.some((r) => r.id === id)) skipped.push({ shopId: id, reason: "shop not found" });
  return { sent, skipped };
}

/* ============================================================== expiry */

export type ExpiryChange =
  | { mode: "EXTEND"; days: number }
  | { mode: "SHORTEN"; days: number }
  | { mode: "SET_DATE"; date: string }
  | { mode: "EXPIRE_NOW" };

/** Pure: the new expiry for a change (dates are IST calendar days, ending at 23.59 IST). */
export function newExpiryFor(current: Date | null, change: ExpiryChange, now: Date, timeZone = "Asia/Kolkata"): Date {
  const endOfIstDay = (iso: string) => new Date(`${iso}T23:59:59+05:30`);
  switch (change.mode) {
    case "EXTEND":
      return new Date((current && current > now ? current : now).getTime() + change.days * DAY_MS);
    case "SHORTEN":
      if (!current) throw validationFailed("This shop has no expiry date to shorten.");
      return new Date(current.getTime() - change.days * DAY_MS);
    case "SET_DATE":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(change.date)) throw validationFailed("Pick a date.");
      return endOfIstDay(change.date);
    case "EXPIRE_NOW":
      return new Date(Math.min(now.getTime(), endOfIstDay(todayIn(timeZone, now)).getTime()));
  }
}

/**
 * Set / Change Registration Expiry: extend, shorten, a custom date or Expire now (no grace). The reason is
 * required; who, when, the old and new expiry are audited; the owner is told at once.
 */
export async function changeRegistrationExpiry(shopId: string, change: ExpiryChange, reason: string, actor: StaffActor, now = new Date()): Promise<Shop> {
  assertStaff(actor);
  const why = reason.trim();
  if (why.length < 5) throw validationFailed("Give a reason (at least 5 characters).", { fields: { reason: "A reason is required." } });
  if ((change.mode === "EXTEND" || change.mode === "SHORTEN") && (!Number.isInteger(change.days) || change.days < 1 || change.days > 3650)) {
    throw validationFailed("Days must be between 1 and 3650.", { fields: { days: "1 to 3650 days." } });
  }
  const updated = await db.transaction(async (tx) => {
    const shop = await lockedShop(tx, shopId);
    const until = newExpiryFor(shop.membershipValidUntil, change, now, tz());
    const expireNow = change.mode === "EXPIRE_NOW";
    const [row] = await tx
      .update(shops)
      .set({
        membershipValidUntil: until,
        registrationStartDate: shop.registrationStartDate ?? (expireNow ? null : now),
        // Expire now: no grace (the shop goes offline now); any other change keeps the usual grace.
        registrationGraceDays: expireNow ? 0 : shop.registrationGraceDays === 0 ? null : shop.registrationGraceDays,
        registrationGraceUntil: null,
        updatedAt: now,
      })
      .where(eq(shops.id, shop.id))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_REGISTRATION_EXPIRY_CHANGED,
        entityType: "shop",
        entityId: shop.id,
        previousValue: { expiry: shop.membershipValidUntil?.toISOString() ?? null, expiryIst: istTime(shop.membershipValidUntil), graceDays: shop.registrationGraceDays, graceUntil: shop.registrationGraceUntil?.toISOString() ?? null },
        newValue: { expiry: until.toISOString(), expiryIst: istTime(until), mode: change.mode, ...("days" in change ? { days: change.days } : {}), ...("date" in change ? { date: change.date } : {}), graceDays: row.registrationGraceDays, reason: why, atIst: istTime(now) },
      },
      tx,
    );
    return row;
  });
  const status = await refreshRegistrationStatus(updated.id, now);
  const date = istDay(updated.membershipValidUntil);
  await notify({
    userId: updated.ownerId,
    type: NOTIFICATION_TYPES.SHOP_REGISTRATION_EXPIRY_CHANGED,
    vars: {
      title: status === "EXPIRED" ? `Shop registration expired — ${updated.name}` : `Registration expiry changed — ${updated.name}`,
      message: [
        status === "EXPIRED"
          ? `GoKesari ended ${updated.name}'s registration on ${date}. Your shop is hidden from customers until you renew. Reason: ${why}`
          : `GoKesari changed ${updated.name}'s registration expiry to ${date}. Reason: ${why}`,
        "",
        status === "EXPIRED"
          ? `GoKesari ने ${updated.name} ची नोंदणी ${date} रोजी संपवली आहे. नूतनीकरण करेपर्यंत दुकान ग्राहकांना दिसणार नाही. कारण: ${why}`
          : `GoKesari ने ${updated.name} च्या नोंदणीची मुदत ${date} केली आहे. कारण: ${why}`,
      ].join("\n"),
    },
    actionUrl: `/shop/manage/registration?shop=${updated.id}`,
    channels: ["PUSH", "EMAIL"],
    mandatory: true,
    metadata: { shopId: updated.id, expiry: updated.membershipValidUntil?.toISOString() ?? null },
  });
  return updated;
}

/* ========================================================= mark as paid */

export interface MarkPaidInput {
  reference: string;
  note: string;
  method: "CASH" | "UPI" | "BANK_TRANSFER" | "CHEQUE" | "OTHER";
  /** Default: the amount due. */
  amountPaise?: number | null;
  /** IST date (YYYY-MM-DD) the money was received; default now. */
  paidOn?: string | null;
}

/**
 * Mark as Paid: a registration / renewal fee received outside the gateway (cash, UPI …). Written to the
 * shop's immutable ledger like any other fee payment (the reference must be new), which extends the expiry
 * (registration: start = payment date; renewal: from the later of the expiry and the payment date).
 */
export async function markRegistrationPaid(shopId: string, input: MarkPaidInput, actor: StaffActor, now = new Date()) {
  assertStaff(actor);
  const reference = input.reference.trim();
  const note = input.note.trim();
  if (reference.length < 3) throw validationFailed("Enter the payment reference number.", { fields: { reference: "Reference number required." } });
  if (note.length < 3) throw validationFailed("Add a note.", { fields: { note: "A note is required." } });
  const [shop] = await db.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  const due = await amountDue(shop, now);
  if (due.status === "EXEMPT") throw conflict(`${shop.name} is exempt from the registration fee.`);
  const amountPaise = input.amountPaise ?? due.amountPaise;
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw validationFailed("Enter the amount received.", { fields: { amountPaise: "Amount required." } });
  const paidAt = input.paidOn && /^\d{4}-\d{2}-\d{2}$/.test(input.paidOn) ? new Date(Math.min(new Date(`${input.paidOn}T12:00:00+05:30`).getTime(), now.getTime())) : now;
  const before = { expiry: shop.membershipValidUntil?.toISOString() ?? null, status: due.status, feePaymentStatus: shop.feePaymentStatus };
  const recorded = await recordPayment(
    {
      shopId: shop.id,
      paymentType: due.kind === "REGISTRATION" ? "REGISTRATION_FEE" : "RENEWAL",
      amountPaise,
      method: input.method,
      transactionId: reference,
      paidAt,
      note: `Marked as paid (${input.method}, ref ${reference}): ${note}`.slice(0, 1000),
      ...(due.kind === "RENEWAL" ? { membership: { quote: due.quote && due.quote.totalPaise === amountPaise ? due.quote : { basePaise: amountPaise, gstRateBp: 0, gstPaise: 0, totalPaise: amountPaise, source: "SHOP_OVERRIDE" as const }, paymentIntentId: null } } : {}),
    },
    actor,
  );
  const link = await activeLink(shop.id, new Date(0));
  if (link) {
    await cancelAtGateway(link.paymentIntentId);
    await endLink(db, link, "CANCELLED", "fee recorded as paid offline");
  }
  const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_MARKED_PAID,
    entityType: "shop",
    entityId: shop.id,
    previousValue: before,
    newValue: {
      kind: due.kind,
      amountPaise,
      method: input.method,
      reference,
      note,
      paymentReference: recorded.payment.reference,
      expiry: after?.membershipValidUntil?.toISOString() ?? null,
      expiryIst: istTime(after?.membershipValidUntil),
      extended: Boolean(recorded.membership?.periodEnd),
      atIst: istTime(now),
    },
  });
  await afterRegistrationPayment(shop.id, { id: recorded.payment.id, reference: recorded.payment.reference, amountPaise, kind: due.kind });
  return { payment: recorded.payment, extendedTo: recorded.membership?.periodEnd ?? null, feePaymentStatus: recorded.feePaymentStatus };
}

/* ======================================================= shop settings */

/** Per-shop settings: reminders on/off, own renewal fee (before GST), own grace days. Audited with a reason. */
export async function updateShopRegistrationSettings(
  shopId: string,
  input: { remindersEnabled?: boolean; renewalFeePaise?: number | null; graceDays?: number | null; reason: string },
  actor: StaffActor,
): Promise<Shop> {
  assertStaff(actor);
  const why = input.reason.trim();
  if (why.length < 5) throw validationFailed("Give a reason (at least 5 characters).", { fields: { reason: "A reason is required." } });
  return db.transaction(async (tx) => {
    const shop = await lockedShop(tx, shopId);
    const patch: Partial<typeof shops.$inferInsert> = { updatedAt: new Date() };
    if (input.remindersEnabled !== undefined) patch.registrationRemindersEnabled = input.remindersEnabled;
    if (input.renewalFeePaise !== undefined) patch.renewalFeePaise = input.renewalFeePaise && input.renewalFeePaise > 0 ? input.renewalFeePaise : null;
    if (input.graceDays !== undefined) patch.registrationGraceDays = input.graceDays;
    const [row] = await tx.update(shops).set(patch).where(eq(shops.id, shop.id)).returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_REGISTRATION_SETTINGS_CHANGED,
        entityType: "shop",
        entityId: shop.id,
        previousValue: { remindersEnabled: shop.registrationRemindersEnabled, renewalFeePaise: shop.renewalFeePaise, graceDays: shop.registrationGraceDays },
        newValue: { remindersEnabled: row.registrationRemindersEnabled, renewalFeePaise: row.renewalFeePaise, graceDays: row.registrationGraceDays, reason: why },
      },
      tx,
    );
    return row;
  });
}

/* ========================================================= audit trail */

/** The registration audit trail of one shop (newest first), every time in IST. */
export async function registrationAuditTrail(shopId: string, limit = 100) {
  const { auditLogs } = await import("@/server/db/schema");
  const actions = [
    AUDIT_ACTIONS.SHOP_REGISTRATION_REMINDER_SENT,
    AUDIT_ACTIONS.SHOP_REGISTRATION_LINK_CREATED,
    AUDIT_ACTIONS.SHOP_REGISTRATION_LINK_CANCELLED,
    AUDIT_ACTIONS.SHOP_REGISTRATION_EXPIRY_CHANGED,
    AUDIT_ACTIONS.SHOP_REGISTRATION_MARKED_PAID,
    AUDIT_ACTIONS.SHOP_REGISTRATION_SETTINGS_CHANGED,
    AUDIT_ACTIONS.SHOP_MEMBERSHIP_PERIOD_OPENED,
    AUDIT_ACTIONS.SHOP_MEMBERSHIP_RENEWAL_PAID,
    AUDIT_ACTIONS.SHOP_MEMBERSHIP_EXEMPTION_CHANGED,
  ];
  const rows = await db
    .select({ log: auditLogs, actorName: users.name, actorEmail: users.email })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(and(eq(auditLogs.entityId, shopId), inArray(auditLogs.action, actions)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  return rows.map(({ log, actorName, actorEmail }) => ({
    id: log.id,
    action: log.action,
    at: log.createdAt,
    atIst: istTime(log.createdAt),
    actor: actorName || actorEmail || (log.actorId ? log.actorId : "System"),
    actorRole: log.actorRole,
    previousValue: log.previousValue,
    newValue: log.newValue,
  }));
}

/* ================================================================ job */

/**
 * The registration job (every 15 minutes, cron every-minute group): statuses in step with the clock, links
 * past their date EXPIRED, open links checked with the gateway, and — from reminderHourIst (09:00 IST) —
 * today's reminders (rule shopMembership.remindersEnabled) and the CC digest. Each reminder is claimed once
 * per shop, stage and day, so a late or repeated run catches up without sending twice.
 */
export async function runRegistrationSubscriptionJob(now: Date = new Date()) {
  const [rule, sub] = await Promise.all([getRule("shopMembership"), getRule("shopRegistrationSubscription")]);
  const out: Record<string, unknown> = {};
  out.statusesChanged = await syncRegistrationStatuses();
  const expired = await db
    .update(shopRegistrationLinks)
    .set({ status: "EXPIRED", endedAt: now, endReason: "link validity ended" })
    .where(and(eq(shopRegistrationLinks.status, "ACTIVE"), lte(shopRegistrationLinks.expiresAt, now)))
    .returning({ id: shopRegistrationLinks.id });
  out.linksExpired = expired.length;
  out.linksChecked = await reconcileOpenLinks(now);

  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz() }).format(now)) % 24;
  if (!rule.remindersEnabled) return { ...out, reminders: "off (rule shopMembership.remindersEnabled)" };
  if (hour < sub.reminderHourIst) return { ...out, reminders: `waiting for ${String(sub.reminderHourIst).padStart(2, "0")}.00 IST` };
  const today = todayIn(tz(), now);
  const sent = await sendDueReminders(now, today);
  out.reminders = sent;
  out.digest = await sendCcDigest(now, today).catch((e) => `failed: ${e instanceof Error ? e.message : String(e)}`);
  return out;
}

async function sendDueReminders(now: Date, today: IsoDate): Promise<{ checked: number; sent: number; failed: number }> {
  const [rule, sub] = await Promise.all([getRule("shopMembership"), getRule("shopRegistrationSubscription")]);
  const maxAhead = Math.max(0, ...sub.expiryReminderDays) + 1;
  const from = new Date(now.getTime() - (rule.graceDays + 60) * DAY_MS);
  const to = new Date(now.getTime() + maxAhead * DAY_MS);
  const candidates = await db
    .select()
    .from(shops)
    .where(
      and(
        isNull(shops.deletedAt),
        eq(shops.registrationRemindersEnabled, true),
        eq(shops.membershipExempt, false),
        or(
          // Unpaid: registered and not paid (pending approval or approved without the fee).
          and(sql`${shops.membershipValidUntil} is null`, inArray(shops.status, ["PENDING_APPROVAL", "APPROVED"]), inArray(shops.feePaymentStatus, ["PENDING", "PARTIALLY_PAID"])),
          and(inArray(shops.status, ["APPROVED", "SUSPENDED"]), gte(shops.membershipValidUntil, from), lte(shops.membershipValidUntil, to)),
        ),
      ),
    );
  const slugs = rule.exemptCategorySlugs.length > 0 ? await shopCategorySlugsByShop(candidates.map((c) => c.id)) : new Map<string, string[]>();
  let sent = 0;
  let failed = 0;
  for (const shop of candidates) {
    const status = registrationStatusOf(shop, membershipStatus(shop, rule, now, slugs.get(shop.id) ?? []));
    const until = shop.membershipValidUntil;
    const plan = reminderPlanFor(
      {
        status,
        registeredOn: todayIn(tz(), shop.createdAt),
        expiresOn: until ? todayIn(tz(), until) : null,
        offlineOn: until ? todayIn(tz(), offlineFromOf(until, shop, rule.graceDays)) : null,
      },
      today,
      sub,
    );
    if (!plan || (plan.kind === "UNPAID" && registrationFeeDue(shop) === 0)) continue;
    try {
      const r = await sendReminder(shop, plan, null, today, now);
      if (r.sent) sent += 1;
    } catch (error) {
      failed += 1;
      console.error("[registration-subscription] reminder failed", shop.id, plan.stage, error);
    }
  }
  return { checked: candidates.length, sent, failed };
}

/** Open links older than 15 minutes are checked with the gateway (a lost webhook is settled within the run). */
async function reconcileOpenLinks(now: Date): Promise<number> {
  const open = await db
    .select({ intentId: shopRegistrationLinks.paymentIntentId })
    .from(shopRegistrationLinks)
    .innerJoin(paymentIntents, eq(paymentIntents.id, shopRegistrationLinks.paymentIntentId))
    .where(and(eq(shopRegistrationLinks.status, "ACTIVE"), lte(shopRegistrationLinks.createdAt, new Date(now.getTime() - 15 * 60_000)), inArray(paymentIntents.status, ["PENDING", "CREATED"])))
    .limit(50);
  if (open.length === 0) return 0;
  const { reconcileIntent } = await import("@/server/payments/processing");
  for (const row of open) await reconcileIntent(row.intentId, "RECONCILE").catch(() => null);
  return open.length;
}

/** Once a day after the reminders: the CC list (default ceo@agtci.com) gets the shops expiring, in grace and expired. */
async function sendCcDigest(now: Date, today: IsoDate): Promise<string> {
  const sub = await getRule("shopRegistrationSubscription");
  if (sub.ccEmails.length === 0) return "no CC list";
  const [claimed] = await db.insert(shopRegistrationDigests).values({ day: today }).onConflictDoNothing().returning({ day: shopRegistrationDigests.day });
  if (!claimed) return "already sent today";
  const { rows, counts } = await listShopRegistrations({ filter: "ALL" }, now);
  const pick = rows.filter((r) => r.status === "GRACE" || r.status === "EXPIRED" || (r.status === "EXPIRING_SOON" && r.daysLeft != null && r.daysLeft <= 7) || r.status === "UNPAID");
  const line = (r: RegistrationRow) =>
    `- ${r.shopName} (${r.shopTypeLabel}, ${r.city}) — ${r.status}${r.expiryDate ? `, expiry ${istDay(r.expiryDate)}` : ""}${r.daysLeft != null ? `, ${r.daysLeft} day(s)` : ""}, due ${formatPaise(r.amountDuePaise)}`;
  const text = [
    `GoKesari shop registrations — ${istDay(now)} (IST)`,
    "",
    `Unpaid ${counts.UNPAID} · Expiring in 30 days ${counts.EXPIRING_30} (7 days: ${counts.EXPIRING_7}) · Grace ${counts.GRACE} · Expired ${counts.EXPIRED} · Active ${counts.ACTIVE}`,
    "",
    ...(pick.length ? pick.slice(0, 200).map(line) : ["Nothing needs attention today."]),
    "",
    `${site()}/admin/shops/registrations`,
  ].join("\n");
  const failures: string[] = [];
  for (const to of sub.ccEmails) {
    await sendEmail({ to, subject: `Shop registrations: ${counts.GRACE} in grace, ${counts.EXPIRED} expired, ${counts.EXPIRING_7} expiring in 7 days`, text }).catch((e) => failures.push(`${to}: ${e instanceof Error ? e.message : String(e)}`));
  }
  await db.update(shopRegistrationDigests).set({ detail: failures.length ? failures.join("; ").slice(0, 500) : `sent to ${sub.ccEmails.length}` }).where(eq(shopRegistrationDigests.day, today));
  return failures.length ? `failed for ${failures.length}` : `sent to ${sub.ccEmails.length}`;
}

/* ============================================================== owner */

export interface OwnerRegistrationView {
  status: RegistrationStatus;
  startDate: Date | null;
  expiryDate: Date | null;
  daysLeft: number | null;
  offlineFrom: Date | null;
  amountDuePaise: number;
  dueKind: "REGISTRATION" | "RENEWAL";
  /** Where Pay Now / Renew goes: the active link, else the owner's own checkout page. */
  payUrl: string;
  payLabel: string;
  enforced: boolean;
}

/** The owner's Shop Registration card and banner. */
export async function ownerRegistrationView(shop: Shop, now = new Date()): Promise<OwnerRegistrationView> {
  const rule = await getRule("shopMembership");
  const slugs = rule.exemptCategorySlugs.length > 0 ? ((await shopCategorySlugsByShop([shop.id])).get(shop.id) ?? []) : [];
  const membership = membershipStatus(shop, rule, now, slugs);
  const status = registrationStatusOf(shop, membership);
  const due = status === "ACTIVE" || status === "EXEMPT" ? { amountPaise: 0, kind: "RENEWAL" as const } : await amountDue(shop, now);
  const link = due.amountPaise > 0 ? await activeLink(shop.id, now) : null;
  const ownPage = status === "UNPAID" ? `/shop/registration-fee?shop=${shop.id}` : `/shop/manage/registration?shop=${shop.id}`;
  return {
    status,
    startDate: shop.registrationStartDate,
    expiryDate: shop.membershipValidUntil,
    daysLeft: daysLeft(shop.membershipValidUntil, now, tz()),
    offlineFrom: membership.offlineFrom,
    amountDuePaise: due.amountPaise,
    dueKind: status === "UNPAID" ? "REGISTRATION" : "RENEWAL",
    payUrl: link?.linkUrl ?? ownPage,
    payLabel: status === "UNPAID" ? "Pay Now" : "Renew Registration",
    enforced: membership.enforced,
  };
}

/** Registration / renewal payments of the shop (newest first) with the receipt of each period. */
export async function registrationPaymentHistory(shopId: string) {
  const payments = await db
    .select({ id: shopPayments.id, reference: shopPayments.reference, type: shopPayments.paymentType, amountPaise: shopPayments.amountPaise, method: shopPayments.method, paidAt: shopPayments.paidAt })
    .from(shopPayments)
    .where(and(eq(shopPayments.shopId, shopId), inArray(shopPayments.paymentType, ["REGISTRATION_FEE", "RENEWAL", "REFUND"])))
    .orderBy(desc(shopPayments.paidAt));
  const periods = payments.length
    ? await db
        .select({ id: shopMembershipPeriods.id, paymentId: shopMembershipPeriods.shopPaymentId, start: shopMembershipPeriods.periodStart, end: shopMembershipPeriods.periodEnd, kind: shopMembershipPeriods.kind })
        .from(shopMembershipPeriods)
        .where(and(eq(shopMembershipPeriods.shopId, shopId), isNull(shopMembershipPeriods.voidedAt)))
    : [];
  const byPayment = new Map(periods.filter((p) => p.paymentId).map((p) => [p.paymentId!, p]));
  return payments.map((p) => {
    const period = byPayment.get(p.id);
    return { ...p, periodStart: period?.start ?? null, periodEnd: period?.end ?? null, receiptPeriodId: period && period.kind !== "LEGACY" ? period.id : null };
  });
}

/** The latest migration report (counts per status when 0203 ran). */
export async function latestMigrationReport() {
  const [row] = await db.select().from(shopRegistrationMigrationReports).orderBy(desc(shopRegistrationMigrationReports.ranAt)).limit(1);
  return row ?? null;
}

/** For tests and the admin "today" summary. */
export function todayIst(now = new Date()): IsoDate {
  return todayIn(tz(), now);
}

export { addDays };

/** The owner's banner / card data, formatted (IST dates, rupees); null when it cannot be read (never breaks a page). */
export async function ownerRegistrationStatus(shop: Shop): Promise<{
  shopId: string;
  status: RegistrationStatus;
  registeredOn: string | null;
  expiryOn: string | null;
  offlineOn: string | null;
  daysLeft: number | null;
  amountDue: string | null;
  payUrl: string;
  payLabel: string;
} | null> {
  try {
    const v = await ownerRegistrationView(shop);
    return {
      shopId: shop.id,
      status: v.status,
      registeredOn: v.startDate ? istDay(v.startDate) : null,
      expiryOn: v.expiryDate ? istDay(v.expiryDate) : null,
      offlineOn: v.offlineFrom ? istDay(v.offlineFrom) : null,
      daysLeft: v.daysLeft,
      amountDue: v.amountDuePaise > 0 ? formatPaise(v.amountDuePaise) : null,
      payUrl: v.payUrl,
      payLabel: v.payLabel,
    };
  } catch (error) {
    console.error("[registration-subscription] owner view failed", shop.id, error);
    return null;
  }
}
