/**
 * SM-004 renewal: RENEWAL_PENDING and the end of a subscription's term.
 *
 * Two things make a live subscription "renewal pending" (rule
 * subscriptionRenewal):
 *   TERM_END     its end date is within termEndNoticeDays
 *   PAYMENT_DUE  the wallet will not cover the deliveries of the next
 *                paymentDueDays days (all of the customer's subscriptions
 *                draw on one wallet, so they are judged together)
 * Deliveries continue while renewal is pending. TERM_END wins over
 * PAYMENT_DUE. A PAYMENT_PENDING subscription (a delivery already failed)
 * keeps that status — it is the stronger signal. A subscription whose end
 * date has passed completes (lifecycle EXPIRED).
 *
 * evaluateRenewals() runs with the daily order run; refreshPaymentDue() runs
 * after a wallet top-up so the warning clears at once.
 */
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { addDays, daysBetween, todayIn, type IsoDate } from "@/lib/dates";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { formatPaise, lineTotalPaise } from "@/lib/money";
import { db } from "@/server/db";
import { shopProducts, subscriptionDailyOverrides, subscriptions, wallets, type Subscription, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";
import { syncSubscriptionSchedule } from "./subscription-schedule";
import { recordSubscriptionEvent, refreshNextDeliveryDate, resolveDelivery, toScheduleInput } from "./subscriptions";

/** Statuses that still deliver. */
const LIVE = ["ACTIVE", "PAYMENT_PENDING", "RENEWAL_PENDING"] as const;
/** Statuses renewal may move to/from (PAYMENT_PENDING is left alone). */
const RENEWABLE = ["ACTIVE", "RENEWAL_PENDING"] as const;

export interface RenewalResult {
  completed: number;
  termEnd: number;
  paymentDue: number;
  cleared: number;
}

async function setRenewal(
  sub: Subscription,
  next: { status: "ACTIVE" | "RENEWAL_PENDING"; reason: "TERM_END" | "PAYMENT_DUE" | null; dueDate: IsoDate | null },
  note: string,
): Promise<boolean> {
  if (sub.status === next.status && sub.renewalReason === next.reason && sub.renewalDueDate === next.dueDate) return false;
  const [updated] = await db
    .update(subscriptions)
    .set({ status: next.status, renewalReason: next.reason, renewalDueDate: next.dueDate, updatedAt: new Date() })
    .where(and(eq(subscriptions.id, sub.id), inArray(subscriptions.status, [...RENEWABLE])))
    .returning();
  if (!updated) return false;
  if (sub.status !== next.status) {
    await recordSubscriptionEvent({
      subscriptionId: sub.id,
      action: next.status === "RENEWAL_PENDING" ? "RENEWAL_DUE" : "RENEWAL_CLEARED",
      fromStatus: sub.status,
      toStatus: next.status,
      note,
    });
  }
  return true;
}

/** Completes subscriptions whose end date has passed. */
async function completeEnded(today: IsoDate): Promise<number> {
  const ended = await db
    .select()
    .from(subscriptions)
    .where(and(inArray(subscriptions.status, [...LIVE, "PAUSED"]), isNotNull(subscriptions.endDate), lt(subscriptions.endDate, today)));
  let n = 0;
  for (const sub of ended) {
    const [done] = await db
      .update(subscriptions)
      .set({ status: "COMPLETED", renewalReason: null, renewalDueDate: null, nextDeliveryDate: null, updatedAt: new Date() })
      .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.status, sub.status)))
      .returning();
    if (!done) continue;
    n += 1;
    await syncSubscriptionSchedule(sub.id, { from: today });
    await recordSubscriptionEvent({
      subscriptionId: sub.id,
      action: "COMPLETED",
      fromStatus: sub.status,
      toStatus: "COMPLETED",
      note: `Ended ${sub.endDate}`,
    });
    await notify({
      userId: sub.userId,
      type: NOTIFICATION_TYPES.SUBSCRIPTION_COMPLETED,
      title: "Subscription ended",
      body: `Your subscription ended on ${sub.endDate}. Start a new one any time from the shop.`,
      actionUrl: `/subscriptions/${sub.id}`,
      dedupeKey: `sub-completed:${sub.id}`,
    });
  }
  return n;
}

/**
 * The first date in [from, from + days) whose cumulative delivery cost,
 * across all of `userId`'s live subscriptions, is more than the wallet holds;
 * null when the wallet covers the whole window. Uses today's prices, like the
 * wallet forecast (§37).
 */
export async function firstUncoveredDeliveryDate(
  userId: string,
  from: IsoDate,
  days: number,
): Promise<{ date: IsoDate; shortfallPaise: number; subscriptionIds: string[] } | null> {
  const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) });
  const balance = wallet?.balancePaise ?? 0;
  const subs = await db
    .select({ sub: subscriptions, price: shopProducts.onlinePricePaise })
    .from(subscriptions)
    .innerJoin(shopProducts, eq(shopProducts.id, subscriptions.shopProductId))
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, [...LIVE])));
  if (subs.length === 0) return null;
  const overrides = await db
    .select()
    .from(subscriptionDailyOverrides)
    .where(
      and(
        inArray(
          subscriptionDailyOverrides.subscriptionId,
          subs.map((s) => s.sub.id),
        ),
        sql`${subscriptionDailyOverrides.deliveryDate} >= ${from}`,
      ),
    );

  let spent = 0;
  for (let i = 0; i < days; i += 1) {
    const date = addDays(from, i);
    const dueToday: string[] = [];
    for (const { sub, price } of subs) {
      const override = overrides.find((o) => o.subscriptionId === sub.id && o.deliveryDate === date);
      const r = resolveDelivery(toScheduleInput(sub), date, override);
      if (r.delivers && price) {
        spent += lineTotalPaise(price, r.quantityMilli);
        dueToday.push(sub.id);
      }
    }
    if (spent > balance) return { date, shortfallPaise: spent - balance, subscriptionIds: dueToday };
  }
  return null;
}

/** Re-judges PAYMENT_DUE for one customer (e.g. right after a top-up). */
export async function refreshPaymentDue(userId: string, today?: IsoDate): Promise<{ marked: number; cleared: number }> {
  const rule = await getRule("subscriptionRenewal");
  const day = today ?? todayIn(getEnv().APP_TIMEZONE);
  const subs = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, [...RENEWABLE])));
  let marked = 0;
  let cleared = 0;
  const gap = rule.paymentDueEnabled ? await firstUncoveredDeliveryDate(userId, addDays(day, 1), rule.paymentDueDays) : null;

  for (const sub of subs) {
    if (sub.renewalReason === "TERM_END") continue; // term end wins
    if (gap) {
      if (await setRenewal(sub, { status: "RENEWAL_PENDING", reason: "PAYMENT_DUE", dueDate: gap.date }, `Wallet short by ${formatPaise(gap.shortfallPaise)} for ${gap.date}`)) {
        marked += 1;
        if (sub.status !== "RENEWAL_PENDING") {
          await notify({
            userId,
            type: NOTIFICATION_TYPES.SUBSCRIPTION_RENEWAL_DUE,
            title: "Top up to keep your deliveries coming",
            body: `Your wallet is ${formatPaise(gap.shortfallPaise)} short for the delivery on ${gap.date}. Add money to renew your subscription.`,
            actionUrl: "/wallet",
            dedupeKey: `renewal-payment:${sub.id}:${gap.date}`,
          });
        }
      }
    } else if (sub.status === "RENEWAL_PENDING" && sub.renewalReason === "PAYMENT_DUE") {
      if (await setRenewal(sub, { status: "ACTIVE", reason: null, dueDate: null }, "Wallet covers the next deliveries")) cleared += 1;
    }
  }
  return { marked, cleared };
}

/** The daily pass: complete ended terms, flag term ends, judge payment due. */
export async function evaluateRenewals(today?: IsoDate): Promise<RenewalResult> {
  const rule = await getRule("subscriptionRenewal");
  const day = today ?? todayIn(getEnv().APP_TIMEZONE);
  const result: RenewalResult = { completed: await completeEnded(day), termEnd: 0, paymentDue: 0, cleared: 0 };

  const live = await db.select().from(subscriptions).where(inArray(subscriptions.status, [...RENEWABLE]));
  for (const sub of live) {
    const termDue =
      rule.termEndEnabled && sub.endDate !== null && sub.endDate >= day && daysBetween(day, sub.endDate) <= rule.termEndNoticeDays;
    if (termDue) {
      if (await setRenewal(sub, { status: "RENEWAL_PENDING", reason: "TERM_END", dueDate: sub.endDate }, `Ends ${sub.endDate}`)) {
        result.termEnd += 1;
        await notify({
          userId: sub.userId,
          type: NOTIFICATION_TYPES.SUBSCRIPTION_RENEWAL_DUE,
          title: "Your subscription ends soon",
          body: `Deliveries stop after ${sub.endDate}. Renew to keep them coming.`,
          actionUrl: `/subscriptions/${sub.id}`,
          dedupeKey: `renewal-term:${sub.id}:${sub.endDate}`,
        });
      }
    } else if (sub.renewalReason === "TERM_END") {
      // The end date moved out of the notice window (or the rule was switched off).
      if (await setRenewal(sub, { status: "ACTIVE", reason: null, dueDate: null }, "End date no longer near")) result.cleared += 1;
    }
  }

  const customers = [...new Set(live.map((s) => s.userId))];
  for (const userId of customers) {
    const r = await refreshPaymentDue(userId, day);
    result.paymentDue += r.marked;
    result.cleared += r.cleared;
  }
  return result;
}

/**
 * Renews a subscription (SM-004). TERM_END: sets a later end date — the one
 * given, null for no end, or by default the same length as the current term.
 * PAYMENT_DUE: only succeeds once the wallet covers the payment window.
 */
export async function renewSubscription(
  subscriptionId: string,
  input: { endDate?: IsoDate | null },
  actor: { id: string; role: UserRole },
): Promise<Subscription> {
  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.id, subscriptionId) });
  if (!sub) throw notFound("Subscription");
  if (!(["ACTIVE", "RENEWAL_PENDING", "PAYMENT_PENDING"] as string[]).includes(sub.status)) {
    throw conflict(`A ${sub.status.toLowerCase().replace(/_/g, " ")} subscription cannot be renewed.`);
  }
  const rule = await getRule("subscriptionRenewal");
  const today = todayIn(getEnv().APP_TIMEZONE);

  let endDate = sub.endDate;
  if (input.endDate !== undefined || sub.renewalReason === "TERM_END") {
    if (input.endDate === null) endDate = null;
    else if (input.endDate) {
      if (sub.endDate && input.endDate <= sub.endDate) throw validationFailed("Choose an end date after the current one.");
      if (input.endDate < today) throw validationFailed("The new end date must be in the future.");
      endDate = input.endDate;
    } else if (sub.endDate) {
      const term = Math.max(7, daysBetween(sub.startDate, sub.endDate) + 1);
      endDate = addDays(sub.endDate, term);
    }
  }

  const gap = rule.paymentDueEnabled ? await firstUncoveredDeliveryDate(sub.userId, addDays(today, 1), rule.paymentDueDays) : null;
  if (gap && sub.renewalReason === "PAYMENT_DUE" && input.endDate === undefined) {
    throw conflict(`Add ${formatPaise(gap.shortfallPaise)} to your wallet to renew — it does not cover the delivery on ${gap.date}.`);
  }
  const termStillDue =
    rule.termEndEnabled && endDate !== null && daysBetween(today, endDate) <= rule.termEndNoticeDays;
  const next =
    termStillDue
      ? { status: "RENEWAL_PENDING" as const, renewalReason: "TERM_END" as const, renewalDueDate: endDate }
      : gap
        ? { status: "RENEWAL_PENDING" as const, renewalReason: "PAYMENT_DUE" as const, renewalDueDate: gap.date }
        : { status: (sub.status === "PAYMENT_PENDING" ? "PAYMENT_PENDING" : "ACTIVE") as Subscription["status"], renewalReason: null, renewalDueDate: null };

  const [updated] = await db
    .update(subscriptions)
    .set({ endDate, ...next, statusActorId: actor.id, updatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  await refreshNextDeliveryDate(subscriptionId);
  await syncSubscriptionSchedule(subscriptionId);

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUBSCRIPTION_RENEWED,
    entityType: "subscription",
    entityId: subscriptionId,
    previousValue: { endDate: sub.endDate, status: sub.status },
    newValue: { endDate, status: updated.status },
  });
  await recordSubscriptionEvent({
    subscriptionId,
    action: "RENEWED",
    fromStatus: sub.status,
    toStatus: updated.status,
    note: endDate ? `Now ends ${endDate}` : "No end date",
    actorId: actor.id,
  });
  await notify({
    userId: sub.userId,
    type: NOTIFICATION_TYPES.SUBSCRIPTION_RENEWED,
    title: "Subscription renewed",
    body: endDate ? `Deliveries continue until ${endDate}.` : "Deliveries continue with no end date.",
    actionUrl: `/subscriptions/${subscriptionId}`,
  });
  return updated;
}
