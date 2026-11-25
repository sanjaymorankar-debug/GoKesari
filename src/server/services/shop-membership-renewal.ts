/**
 * Yearly shop membership renewal (modules 8 + 9; owner brief 23-Nov-2026;
 * docs/shop-membership-renewal-2026-11).
 *
 *  - Checkout: the owner pays the renewal online (payment-intent purpose
 *    SHOP_MEMBERSHIP_RENEWAL) while rule shopMembership.renewalCheckoutEnabled
 *    is on, from renewalWindowDays before the end (DUE_SOON / GRACE / LAPSED).
 *    One payment per shop and period: the idempotency key names the period
 *    (the current end date), a live checkout is reused, and a renewal already
 *    captured for the period refuses a new one.
 *  - Capture (purpose-handlers.ts): the fee goes on the shop's immutable ledger
 *    (shop_payments RENEWAL, method ONLINE), idempotent on the gateway payment;
 *    recordPayment extends the membership from the current end. A payment for
 *    a period already renewed (two checkouts paid) is recorded as an
 *    ADJUSTMENT, extends nothing and is flagged for a refund.
 *  - Reminders (daily cron, rule remindersEnabled): reminderDays / 7 / 1 / 0
 *    days before the end and when the grace ends, once each (notifications.dedupe_key).
 *  - Admin: the membership report (state, expiry, CSV) and the per-shop exemption (audited).
 *
 * Switching the rule switches off never closes or suspends anyone: renewal
 * checkout off only stops new checkouts; reminders off sends nothing.
 */
import { and, asc, eq, gte, ilike, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { daysBetween, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import type { RuleValue } from "@/server/config/rules";
import { db, type DbClient } from "@/server/db";
import { paymentIntents, shopMembershipPeriods, shopPayments, shops, type PaymentIntentRow, type Shop, type UserRole } from "@/server/db/schema";
import { flagPaymentForSupport } from "@/server/payments/intent-store";
import { createPaymentIntent, getPaymentIntentRow, isLive, listIntentsFor, redirectUrlOf, type PaymentIntentRef } from "@/server/payments/intents";
import type { AfterCommit } from "@/server/payments/purpose-handlers";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { notify } from "./notifications";
import { registrationFeeDue } from "./registration-fee-payment";
import { getRule } from "./settings";
import {
  isMembershipExempt,
  listMembershipPeriods,
  membershipStatus,
  renewalFeeQuote,
  shopCategorySlugsByShop,
  type MembershipState,
  type MembershipStatus,
  type RenewalQuote,
} from "./shop-membership";
import { recordPayment } from "./shop-payments";

export const RENEWAL_PURPOSE = "SHOP_MEMBERSHIP_RENEWAL" as const;
const DAY_MS = 86_400_000;

interface Actor {
  id: string;
  role: UserRole;
}

interface Owner {
  id: string;
  name: string | null;
  email: string;
}

type RenewalRule = RuleValue<"shopMembership">;

/* ================================================================ pure */

/** The period a renewal pays for: the current end date (YYYY-MM-DD, UTC), or "none". */
export function renewalPeriodKey(validUntil: Date | null): string {
  return validUntil ? validUntil.toISOString().slice(0, 10) : "none";
}

export type RenewalRefusal = "CHECKOUT_OFF" | "EXEMPT" | "NO_END_DATE" | "TOO_EARLY" | "NOT_LIVE" | "REGISTRATION_FEE_DUE" | "NOTHING_TO_PAY";

/** Pure: can the owner start a renewal now? Null when yes, else why not. */
export function renewalRefusal(
  input: { status: MembershipStatus; shopStatus: string; registrationFeeDuePaise: number; totalPaise: number },
  rule: Pick<RenewalRule, "renewalCheckoutEnabled" | "renewalWindowDays">,
  now: Date = new Date(),
): RenewalRefusal | null {
  if (!rule.renewalCheckoutEnabled) return "CHECKOUT_OFF";
  if (input.status.state === "EXEMPT") return "EXEMPT";
  if (input.shopStatus !== "APPROVED" && input.shopStatus !== "SUSPENDED") return "NOT_LIVE";
  if (input.registrationFeeDuePaise > 0) return "REGISTRATION_FEE_DUE";
  const until = input.status.validUntil;
  if (!until) return "NO_END_DATE";
  const inWindow = until.getTime() - now.getTime() <= rule.renewalWindowDays * DAY_MS;
  const due = input.status.state === "DUE_SOON" || input.status.state === "GRACE" || input.status.state === "LAPSED";
  if (!inWindow && !due) return "TOO_EARLY";
  if (input.totalPaise <= 0) return "NOTHING_TO_PAY";
  return null;
}

export const RENEWAL_REFUSAL_TEXT: Record<RenewalRefusal, string> = {
  CHECKOUT_OFF: "Online renewal is not open yet. GoKesari's team will tell you how to renew.",
  EXEMPT: "This shop does not need a membership renewal.",
  NO_END_DATE: "This shop's membership has no end date, so there is nothing to renew.",
  TOO_EARLY: "Renewal opens closer to the end of your membership.",
  NOT_LIVE: "Only a live shop can renew its membership.",
  REGISTRATION_FEE_DUE: "Pay the rest of your registration fee first.",
  NOTHING_TO_PAY: "There is no renewal fee to pay.",
};

export type ReminderStage = `D${number}` | "GRACE_END";

/**
 * Pure: the reminder due today for a membership ending on `until` — the most urgent stage reached
 * (reminderDays, 7, 1 and 0 days before the end; the grace end), so a missed day still sends the
 * next one. Null outside the reminder span (more than reminderDays ahead, or days past the grace).
 */
export function reminderStageFor(until: Date, now: Date, rule: Pick<RenewalRule, "reminderDays" | "graceDays">, timeZone = "Asia/Kolkata"): ReminderStage | null {
  const days = daysBetween(todayIn(timeZone, now), todayIn(timeZone, until));
  if (days < 0) {
    // After the end: one notice when the grace ends, sent up to three days late.
    return days <= -rule.graceDays && days >= -rule.graceDays - 3 ? "GRACE_END" : null;
  }
  const stages = [...new Set([rule.reminderDays, 7, 1, 0])].filter((d) => d <= rule.reminderDays).sort((a, b) => a - b);
  const stage = stages.find((d) => days <= d);
  return stage === undefined ? null : `D${stage}`;
}

/* =============================================================== owner */

async function ownShop(shopId: string, ownerId: string): Promise<Shop> {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.ownerId !== ownerId || shop.deletedAt) throw notFound("Shop");
  return shop;
}

/** The shop's membership status with every exemption applied. */
export async function shopMembershipStatus(shop: Shop, rule?: RenewalRule, now = new Date()): Promise<MembershipStatus> {
  const r = rule ?? (await getRule("shopMembership"));
  const slugs = (r.exemptCategorySlugs.length > 0 ? (await shopCategorySlugsByShop([shop.id])).get(shop.id) : undefined) ?? [];
  return membershipStatus(shop, r, now, slugs);
}

export interface RenewalView {
  status: MembershipStatus;
  periodMonths: number;
  graceDays: number;
  quote: RenewalQuote;
  /** Null when Renew now may be pressed. */
  refusal: RenewalRefusal | null;
  refusalText: string | null;
  checkoutEnabled: boolean;
  latestAttempt: { id: string; status: string; amountPaise: number; live: boolean; periodKey: string | null } | null;
  history: {
    id: string;
    kind: string;
    periodStart: Date;
    periodEnd: Date;
    feePaise: number;
    voidedAt: Date | null;
    voidReason: string | null;
    paymentReference: string | null;
    paidAt: Date | null;
    method: string | null;
  }[];
}

/** Everything the owner's Registration page shows about the membership. */
export async function membershipRenewalView(shop: Shop, ownerId: string, now = new Date()): Promise<RenewalView> {
  const rule = await getRule("shopMembership");
  const [status, quote, periods, intents] = await Promise.all([
    shopMembershipStatus(shop, rule, now),
    renewalFeeQuote(shop, now),
    listMembershipPeriods(shop.id),
    listIntentsFor(RENEWAL_PURPOSE, shop.id),
  ]);
  const refusal = renewalRefusal({ status, shopStatus: shop.status, registrationFeeDuePaise: registrationFeeDue(shop), totalPaise: quote.totalPaise }, rule, now);
  const latest = intents.find((row) => row.userId === ownerId) ?? null;
  const paymentIds = periods.map((p) => p.shopPaymentId).filter((id): id is string => Boolean(id));
  const payments = paymentIds.length
    ? await db
        .select({ id: shopPayments.id, reference: shopPayments.reference, paidAt: shopPayments.paidAt, method: shopPayments.method })
        .from(shopPayments)
        .where(sql`${shopPayments.id} in (${sql.join(paymentIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const byId = new Map(payments.map((p) => [p.id, p]));
  return {
    status,
    periodMonths: rule.periodMonths,
    graceDays: rule.graceDays,
    quote,
    refusal,
    refusalText: refusal ? RENEWAL_REFUSAL_TEXT[refusal] : null,
    checkoutEnabled: rule.renewalCheckoutEnabled,
    latestAttempt: latest
      ? { id: latest.id, status: latest.status, amountPaise: latest.amountPaise, live: isLive(latest), periodKey: periodKeyOf(latest) }
      : null,
    history: periods.map((p) => {
      const pay = p.shopPaymentId ? byId.get(p.shopPaymentId) : undefined;
      return {
        id: p.id,
        kind: p.kind,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        feePaise: p.feePaise,
        voidedAt: p.voidedAt,
        voidReason: p.voidReason,
        paymentReference: pay?.reference ?? null,
        paidAt: pay?.paidAt ?? null,
        method: pay?.method ?? null,
      };
    }),
  };
}

function periodKeyOf(row: Pick<PaymentIntentRow, "metadata">): string | null {
  const renewal = (row.metadata as { renewal?: { periodKey?: unknown } } | null)?.renewal;
  return typeof renewal?.periodKey === "string" ? renewal.periodKey : null;
}

function quoteOf(row: Pick<PaymentIntentRow, "metadata">): RenewalQuote | null {
  const q = (row.metadata as { renewal?: { quote?: RenewalQuote } } | null)?.renewal?.quote;
  return q && typeof q.totalPaise === "number" ? q : null;
}

/**
 * Renew now: starts (or reopens) the online checkout for the current period's renewal fee.
 * Refused while rule renewalCheckoutEnabled is off, for an exempt shop, before the window,
 * and while the registration fee is still owed.
 */
export async function startMembershipRenewalCheckout(
  shopId: string,
  owner: Owner,
  now = new Date(),
): Promise<{ intentId: string; amountPaise: number; redirectUrl: string }> {
  const rule = await getRule("shopMembership");
  if (!rule.renewalCheckoutEnabled) throw conflict(RENEWAL_REFUSAL_TEXT.CHECKOUT_OFF);
  const shop = await ownShop(shopId, owner.id);
  const status = await shopMembershipStatus(shop, rule, now);
  const quote = await renewalFeeQuote(shop, now);
  const refusal = renewalRefusal({ status, shopStatus: shop.status, registrationFeeDuePaise: registrationFeeDue(shop), totalPaise: quote.totalPaise }, rule, now);
  if (refusal) throw conflict(RENEWAL_REFUSAL_TEXT[refusal]);

  const periodKey = renewalPeriodKey(shop.membershipValidUntil);
  const previous = await listIntentsFor(RENEWAL_PURPOSE, shop.id);
  const samePeriod = previous.filter((row) => periodKeyOf(row) === periodKey);
  // Paid already (the capture is being applied): never a second charge for the same period.
  if (samePeriod.some((row) => row.status === "CAPTURED" || row.status === "AUTHORIZED")) {
    throw conflict("Your renewal payment was received and is being applied. Refresh in a minute.");
  }
  // A checkout still open for this owner, period and amount is reused.
  const open = samePeriod.find((row) => isLive(row) && row.userId === owner.id && row.amountPaise === quote.totalPaise && row.mode === "CHECKOUT");
  const openUrl = open ? redirectUrlOf(open) : null;
  if (open && openUrl) return { intentId: open.id, amountPaise: open.amountPaise, redirectUrl: openUrl };

  const created = await createPaymentIntent({
    purpose: RENEWAL_PURPOSE,
    referenceId: shop.id,
    userId: owner.id,
    amountPaise: quote.totalPaise,
    customer: { id: owner.id, name: owner.name ?? shop.ownerName, email: owner.email || shop.email, phone: shop.phone },
    description: `GoKesari membership renewal (${rule.periodMonths} months) — ${shop.name}`,
    // Shop + period + attempt: two presses at once charge once; after a failed attempt the count moved on.
    idempotencyKey: `shop-membership-renewal:${shop.id}:${periodKey}:${samePeriod.length}`,
    mode: "CHECKOUT",
    returnPath: `/shop/manage/registration?shop=${shop.id}`,
  });
  // What the period's fee was made of, for the capture and the receipt.
  await db
    .update(paymentIntents)
    .set({ metadata: sql`coalesce(${paymentIntents.metadata}, '{}'::jsonb) || ${JSON.stringify({ renewal: { periodKey, quote } })}::jsonb` })
    .where(eq(paymentIntents.id, created.intent.id));
  await recordAudit({
    actorId: owner.id,
    actorRole: "SHOP_OWNER",
    action: AUDIT_ACTIONS.SHOP_MEMBERSHIP_RENEWAL_STARTED,
    entityType: "shop",
    entityId: shop.id,
    newValue: { intentId: created.intent.id, periodKey, amountPaise: quote.totalPaise, quote },
  });
  const checkout = created.checkout;
  const redirectUrl = checkout ? (checkout.kind === "HOSTED_URL" ? checkout.url : (checkout.url ?? null)) : null;
  if (!redirectUrl) throw conflict("Online payment is not available right now. Please try again in a few minutes.");
  return { intentId: created.intent.id, amountPaise: quote.totalPaise, redirectUrl };
}

/** Back from the gateway (`?intent=`): asks the gateway how the owner's own renewal payment went. */
export async function checkMembershipRenewalPayment(shopId: string, intentId: string | null, ownerId: string): Promise<void> {
  await ownShop(shopId, ownerId);
  if (!intentId || !/^[0-9a-f-]{36}$/i.test(intentId)) return;
  const intent = await getPaymentIntentRow(intentId);
  if (!intent || intent.purpose !== RENEWAL_PURPOSE || intent.referenceId !== shopId || intent.userId !== ownerId || !isLive(intent)) return;
  try {
    const { reconcileIntent } = await import("@/server/payments/processing");
    await reconcileIntent(intent.id);
  } catch (error) {
    // The webhook and the reconciliation job settle it anyway; the page says "checking".
    console.error("[membership-renewal] could not check the payment with the gateway", intent.id, error);
  }
}

/* ============================================================== capture */

/**
 * CAPTURED handler for SHOP_MEMBERSHIP_RENEWAL (purpose-handlers.ts), inside the capture transaction.
 * Idempotent on the gateway payment: a replayed capture finds its ledger row and does nothing.
 */
export async function onShopMembershipRenewalCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: AfterCommit): Promise<void> {
  const transactionId = `${intent.gateway}:${intent.gatewayPaymentId ?? intent.id}`;
  const [shop] = await client.select().from(shops).where(eq(shops.id, intent.referenceId)).for("update");
  const [row] = await client.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
  if (!shop || !row) {
    await recordAudit({ action: AUDIT_ACTIONS.SHOP_MEMBERSHIP_RENEWAL_PAID, entityType: "payment_intent", entityId: intent.id, newValue: { problem: "shop_not_found", referenceId: intent.referenceId } }, client);
    if (row) await flagPaymentForSupport(client, row, "Membership renewal paid for a shop that no longer exists — refund it.", "renewal-no-shop");
    return;
  }
  const [already] = await client
    .select({ id: shopPayments.id })
    .from(shopPayments)
    .where(and(eq(shopPayments.shopId, shop.id), eq(shopPayments.transactionId, transactionId)));
  if (already) return;

  const actor = { id: intent.userId ?? shop.ownerId, role: "SHOP_OWNER" as const };
  const test = intent.gateway === "SANDBOX" ? " — test payment" : "";
  const paidFor = periodKeyOf(row);
  // Two checkouts paid for one period: the money is recorded, the membership is not extended twice.
  if (paidFor !== null && paidFor !== renewalPeriodKey(shop.membershipValidUntil)) {
    await recordPayment(
      {
        shopId: shop.id,
        paymentType: "ADJUSTMENT",
        amountPaise: intent.amountPaise,
        method: "ONLINE",
        transactionId,
        note: `Duplicate membership renewal payment (period ending ${paidFor} already renewed; payment intent ${intent.id}, ${intent.gateway}${test}) — to be refunded.`,
      },
      actor,
      client,
    );
    await recordAudit({ action: AUDIT_ACTIONS.SHOP_MEMBERSHIP_RENEWAL_PAID, entityType: "shop", entityId: shop.id, newValue: { intentId: intent.id, problem: "duplicate_period", periodKey: paidFor } }, client);
    await flagPaymentForSupport(client, row, "A second membership renewal was paid for the same period — refund it.", "renewal-duplicate");
    return;
  }

  const recorded = await recordPayment(
    {
      shopId: shop.id,
      paymentType: "RENEWAL",
      amountPaise: intent.amountPaise,
      method: "ONLINE",
      transactionId,
      note: `Membership renewal paid online (payment intent ${intent.id}, ${intent.gateway}${test}).`,
      membership: { quote: quoteOf(row), paymentIntentId: intent.id },
    },
    actor,
    client,
  );
  const extendedTo = recorded.membership?.periodEnd ?? null;
  // 0209 registration subscription: the link that was paid (if any) is PAID, other open links end.
  await (await import("./shop-registration-subscription")).markRegistrationLinksPaid(client, shop.id, intent.id);
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SHOP_MEMBERSHIP_RENEWAL_PAID,
      entityType: "shop",
      entityId: shop.id,
      newValue: { intentId: intent.id, reference: recorded.payment.reference, amountPaise: intent.amountPaise, validUntil: extendedTo?.toISOString() ?? null },
    },
    client,
  );
  // Paid but not enough to cover the period (an earlier refund left the fees short): a person looks at it.
  if (!extendedTo) await flagPaymentForSupport(client, row, "Membership renewal paid but the membership was not extended (fees short after a refund) — check the shop's payments.", "renewal-not-extended");

  const finish = async () => {
    // 0209: renewal commission only while rule shopRegistrationSubscription.payCommissionOnRenewals is on (default off).
    if ((await getRule("shopRegistrationSubscription")).payCommissionOnRenewals) {
      const { accrueRenewalCommissionSafely } = await import("@/server/dealers/tiered");
      await accrueRenewalCommissionSafely(recorded.payment.id, actor);
    }
    const { afterRegistrationPayment } = await import("./shop-registration-subscription");
    if (extendedTo) {
      // 0209: status + confirmation by in-app, push and e-mail (English + Marathi) with the receipt.
      await afterRegistrationPayment(shop.id, { id: recorded.payment.id, reference: recorded.payment.reference, amountPaise: intent.amountPaise, kind: "RENEWAL" });
    } else {
      await (await import("./shop-membership")).refreshRegistrationStatusSafely(shop.id);
    }
  };
  const run = () => finish().catch((e) => console.error("[membership-renewal] after-capture step failed", shop.id, e));
  if (client === db) await run();
  else if (afterCommit) afterCommit(run);
  else setTimeout(() => void run(), 2_000).unref?.();
}

function istDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: getEnv().APP_TIMEZONE });
}

/* ============================================================ reminders */

/**
 * Daily (cron): renewal reminders, in-app + e-mail, while rule remindersEnabled is on. Live shops with an
 * end date in the reminder span; exempt shops are skipped. Each stage once per period (dedupe key).
 */
export async function runMembershipRenewalReminders(now: Date = new Date()): Promise<{ skipped?: string; checked: number; sent: number }> {
  const rule = await getRule("shopMembership");
  if (!rule.remindersEnabled) return { skipped: "remindersEnabled is off", checked: 0, sent: 0 };
  const from = new Date(now.getTime() - (rule.graceDays + 4) * DAY_MS);
  const to = new Date(now.getTime() + (rule.reminderDays + 1) * DAY_MS);
  const rows = await db
    .select()
    .from(shops)
    .where(
      and(
        eq(shops.status, "APPROVED"),
        isNull(shops.deletedAt),
        eq(shops.membershipExempt, false),
        isNotNull(shops.membershipValidUntil),
        gte(shops.membershipValidUntil, from),
        lte(shops.membershipValidUntil, to),
      ),
    );
  const slugs = rule.exemptCategorySlugs.length > 0 ? await shopCategorySlugsByShop(rows.map((r) => r.id)) : new Map<string, string[]>();
  const tz = getEnv().APP_TIMEZONE;
  let sent = 0;
  for (const shop of rows) {
    if (isMembershipExempt(shop, rule, slugs.get(shop.id) ?? [])) continue;
    const until = shop.membershipValidUntil!;
    const stage = reminderStageFor(until, now, rule, tz);
    if (!stage) continue;
    const offlineFrom = new Date(until.getTime() + rule.graceDays * DAY_MS);
    const days = daysBetween(todayIn(tz, now), todayIn(tz, until));
    const headline =
      stage === "GRACE_END" ? "Your membership grace period has ended" : days > 0 ? `Your membership ends in ${days} day${days === 1 ? "" : "s"}` : "Your membership ends today";
    const consequence = !rule.enabled
      ? ""
      : stage === "GRACE_END"
        ? " Customers cannot order from your shop until you renew."
        : ` Renew before ${istDate(offlineFrom)} so customers can keep ordering.`;
    const message =
      stage === "GRACE_END"
        ? `${shop.name}'s yearly membership ended on ${istDate(until)}.${consequence}`
        : `${shop.name}'s yearly membership ${days > 0 ? `ends on ${istDate(until)}` : "ends today"}.${consequence}`;
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_MEMBERSHIP_RENEWAL_DUE,
      vars: { headline, shopName: shop.name, message },
      actionUrl: `/shop/manage/registration?shop=${shop.id}`,
      channels: ["EMAIL"],
      dedupeKey: `shop-membership-reminder:${shop.id}:${renewalPeriodKey(until)}:${stage}`,
      metadata: { shopId: shop.id, stage, validUntil: until.toISOString() },
    });
    sent += 1;
  }
  return { checked: rows.length, sent };
}

/* =============================================================== admin */

export const MEMBERSHIP_REPORT_STATES = ["ALL", "ACTIVE", "DUE_SOON", "GRACE", "LAPSED", "NONE", "EXEMPT"] as const;
export type MembershipReportState = (typeof MEMBERSHIP_REPORT_STATES)[number];

export interface MembershipReportRow {
  shopId: string;
  shopName: string;
  registrationNumber: string;
  shopType: string;
  shopStatus: string;
  phone: string;
  city: string;
  validUntil: Date | null;
  state: MembershipState;
  enforced: boolean;
  exempt: boolean;
  /** The admin's per-shop exemption (the rule's shop-type / category exemption is not switched here). */
  manualExempt: boolean;
  exemptReason: string | null;
  exemptSetAt: Date | null;
  lastRenewalAt: Date | null;
}

/** Shops by membership state and end date (admin report), newest end last. */
export async function membershipReport(
  filter: { state?: MembershipReportState; q?: string; endsWithinDays?: number | null; limit?: number } = {},
  now = new Date(),
): Promise<{ rows: MembershipReportRow[]; counts: Record<MembershipState, number>; rule: RenewalRule }> {
  const rule = await getRule("shopMembership");
  const conds = [isNull(shops.deletedAt), or(eq(shops.status, "APPROVED"), eq(shops.status, "SUSPENDED"), eq(shops.status, "PENDING_APPROVAL"))];
  const q = filter.q?.trim();
  if (q) conds.push(or(ilike(shops.name, `%${q}%`), ilike(shops.registrationNumber, `%${q}%`), ilike(shops.phone, `%${q}%`)));
  if (filter.endsWithinDays != null) conds.push(isNotNull(shops.membershipValidUntil), lte(shops.membershipValidUntil, new Date(now.getTime() + filter.endsWithinDays * DAY_MS)));
  const list = await db
    .select()
    .from(shops)
    .where(and(...conds))
    .orderBy(sql`${shops.membershipValidUntil} asc nulls last`, asc(shops.name))
    .limit(Math.min(filter.limit ?? 2000, 5000));
  const ids = list.map((s) => s.id);
  const [slugs, last] = await Promise.all([
    rule.exemptCategorySlugs.length > 0 ? shopCategorySlugsByShop(ids) : Promise.resolve(new Map<string, string[]>()),
    ids.length
      ? db
          .select({ shopId: shopMembershipPeriods.shopId, at: sql<Date>`max(${shopMembershipPeriods.createdAt})` })
          .from(shopMembershipPeriods)
          .where(and(isNull(shopMembershipPeriods.voidedAt), eq(shopMembershipPeriods.kind, "RENEWAL"), sql`${shopMembershipPeriods.shopId} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`))
          .groupBy(shopMembershipPeriods.shopId)
      : Promise.resolve([] as { shopId: string; at: Date }[]),
  ]);
  const lastBy = new Map(last.map((r) => [r.shopId, r.at ? new Date(r.at) : null]));
  const counts: Record<MembershipState, number> = { NONE: 0, ACTIVE: 0, DUE_SOON: 0, GRACE: 0, LAPSED: 0, EXEMPT: 0 };
  const rows: MembershipReportRow[] = [];
  for (const shop of list) {
    const status = membershipStatus(shop, rule, now, slugs.get(shop.id) ?? []);
    counts[status.state] += 1;
    if (filter.state && filter.state !== "ALL" && status.state !== filter.state) continue;
    rows.push({
      shopId: shop.id,
      shopName: shop.name,
      registrationNumber: shop.registrationNumber,
      shopType: shop.shopType,
      shopStatus: shop.status,
      phone: shop.phone,
      city: shop.city,
      validUntil: shop.membershipValidUntil,
      state: status.state,
      enforced: status.enforced,
      exempt: status.state === "EXEMPT",
      manualExempt: shop.membershipExempt,
      exemptReason: shop.membershipExempt ? shop.membershipExemptReason : status.state === "EXEMPT" ? "By shop type or category (rule shopMembership)" : null,
      exemptSetAt: shop.membershipExemptSetAt,
      lastRenewalAt: lastBy.get(shop.id) ?? null,
    });
  }
  return { rows, counts, rule };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  // Formula injection: a cell starting with = + - @ is read as text.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The report as CSV (mobile numbers masked to the last four digits). */
export function membershipReportCsv(rows: MembershipReportRow[]): string {
  const header = ["Shop", "Registration no.", "Shop type", "Shop status", "City", "Mobile", "Membership state", "Valid until", "Enforced", "Exempt", "Exemption reason", "Last renewal"];
  const lines = rows.map((r) =>
    [r.shopName, r.registrationNumber, r.shopType, r.shopStatus, r.city, r.phone ? `******${r.phone.slice(-4)}` : "", r.state, r.validUntil, r.enforced ? "yes" : "no", r.exempt ? "yes" : "no", r.exemptReason, r.lastRenewalAt]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}

/** Admin: exempt one shop from the membership (or end the exemption). Audited; ADMIN only. */
export async function setMembershipExemption(shopId: string, input: { exempt: boolean; reason: string }, actor: Actor): Promise<Shop> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change a shop's membership exemption.");
  const reason = input.reason.trim();
  if (reason.length < 5) throw validationFailed("Give a reason (at least 5 characters).", { fields: { reason: "Give a reason." } });
  return db.transaction(async (tx) => {
    const [shop] = await tx.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt))).for("update");
    if (!shop) throw notFound("Shop");
    if (shop.membershipExempt === input.exempt) throw conflict(input.exempt ? `${shop.name} is already exempt.` : `${shop.name} is not exempt.`);
    const now = new Date();
    const [updated] = await tx
      .update(shops)
      .set({ membershipExempt: input.exempt, membershipExemptReason: reason, membershipExemptSetBy: actor.id, membershipExemptSetAt: now, updatedAt: now })
      .where(eq(shops.id, shop.id))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_MEMBERSHIP_EXEMPTION_CHANGED,
        entityType: "shop",
        entityId: shop.id,
        previousValue: { exempt: shop.membershipExempt, reason: shop.membershipExemptReason },
        newValue: { exempt: input.exempt, reason },
      },
      tx,
    );
    return updated;
  });
}

/* ============================================================= receipt */

export interface RenewalReceipt {
  period: typeof shopMembershipPeriods.$inferSelect;
  shop: Pick<Shop, "id" | "name" | "registrationNumber" | "ownerName" | "addressLine1" | "city" | "pincode" | "gstin" | "ownerId">;
  payment: { reference: string; paidAt: Date; method: string; transactionId: string | null; amountPaise: number } | null;
}

/** A renewal period's receipt — the owner's own shop, or any for staff who may view payments. */
export async function membershipReceipt(periodId: string, viewer: { id: string; canViewAny: boolean }): Promise<RenewalReceipt> {
  const [period] = await db.select().from(shopMembershipPeriods).where(eq(shopMembershipPeriods.id, periodId));
  if (!period || period.kind === "LEGACY") throw notFound("Receipt");
  const [shop] = await db
    .select({ id: shops.id, name: shops.name, registrationNumber: shops.registrationNumber, ownerName: shops.ownerName, addressLine1: shops.addressLine1, city: shops.city, pincode: shops.pincode, gstin: shops.gstin, ownerId: shops.ownerId })
    .from(shops)
    .where(eq(shops.id, period.shopId));
  if (!shop || (shop.ownerId !== viewer.id && !viewer.canViewAny)) throw notFound("Receipt");
  const [payment] = period.shopPaymentId
    ? await db
        .select({ reference: shopPayments.reference, paidAt: shopPayments.paidAt, method: shopPayments.method, transactionId: shopPayments.transactionId, amountPaise: shopPayments.amountPaise })
        .from(shopPayments)
        .where(eq(shopPayments.id, period.shopPaymentId))
    : [];
  return { period, shop, payment: payment ?? null };
}
