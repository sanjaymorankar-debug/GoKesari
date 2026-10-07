/**
 * "Tomorrow's delivery" — the home page's summary of what the customer's
 * subscriptions will bring tomorrow, and whether the wallet covers it.
 *
 * Read-only. Every figure comes from the same schedule engine the
 * subscription pages and the daily generation run use (resolveDelivery), so
 * the card can never promise a delivery the run would not make.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";

import { addDays, hourIn, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { lineTotalPaise, MILLI_PER_UNIT } from "@/lib/money";
import { db } from "@/server/db";
import { subscriptionDailyOverrides, subscriptionOrders, wallets } from "@/server/db/schema";
import {
  isDeliveringStatus,
  listSubscriptionsForUser,
  resolveDelivery,
  toScheduleInput,
} from "@/server/services/subscriptions";

/** How far ahead to look for the delivery day after tomorrow. */
const LOOKAHEAD_DAYS = 14;

const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface TomorrowLine {
  subscriptionId: string;
  productName: string;
  shopName: string;
  /** "Daily" or "Mon, Wed, Fri". */
  scheduleLabel: string;
  unit: string;
  /** Tomorrow's quantity; the standing quantity when the line is skipped. */
  quantityMilli: number;
  standingQuantityMilli: number;
  /** One tap of − or + changes the quantity by this much. */
  stepMilli: number;
  unitPricePaise: number | null;
  skipped: boolean;
  /** The order for tomorrow already exists, so the line can no longer change. */
  locked: boolean;
}

export interface TomorrowDelivery {
  date: IsoDate;
  lines: TomorrowLine[];
  walletBalancePaise: number;
  /** Local hour (0–23) after which tomorrow's orders start being prepared. */
  cutoffHour: number;
  /** The customer can still change tomorrow: before the cut-off, and something is unlocked. */
  beforeCutoff: boolean;
  /** The next delivery day after tomorrow and what it costs, when there is one. */
  following: { date: IsoDate; costPaise: number } | null;
}

function scheduleLabel(frequency: "DAILY" | "WEEKLY", weekdays: number[]): string {
  if (frequency === "DAILY" || weekdays.length === 7) return "Daily";
  return [...weekdays]
    .sort((a, b) => a - b)
    .map((d) => WEEKDAY_SHORT[d - 1])
    .filter(Boolean)
    .join(", ");
}

/**
 * Quantity step for the − / + buttons. Loose goods sold by the litre or
 * kilogram move in halves (the same step the subscription page uses);
 * anything counted or pre-packed moves one pack at a time.
 */
function stepFor(unit: string, unitSizeMilli: number): number {
  if (unit === "L" || unit === "kg") return MILLI_PER_UNIT / 2;
  return unitSizeMilli > 0 ? unitSizeMilli : MILLI_PER_UNIT;
}

/**
 * Tomorrow's subscription deliveries for a customer, or null when nothing is
 * scheduled for tomorrow (no subscriptions, a non-delivery day, a pause).
 * A day the customer skipped is still returned, so the skip can be undone.
 */
export async function getTomorrowDelivery(
  userId: string,
  now: Date = new Date(),
): Promise<TomorrowDelivery | null> {
  const env = getEnv();
  const today = todayIn(env.APP_TIMEZONE, now);
  const tomorrow = addDays(today, 1);
  const horizonEnd = addDays(tomorrow, LOOKAHEAD_DAYS);

  const subs = (await listSubscriptionsForUser(userId)).filter((s) => isDeliveringStatus(s.status));
  if (subs.length === 0) return null;
  const ids = subs.map((s) => s.id);

  const [overrides, generated, wallet] = await Promise.all([
    db
      .select()
      .from(subscriptionDailyOverrides)
      .where(
        and(
          inArray(subscriptionDailyOverrides.subscriptionId, ids),
          gte(subscriptionDailyOverrides.deliveryDate, tomorrow),
          lte(subscriptionDailyOverrides.deliveryDate, horizonEnd),
        ),
      ),
    db
      .select({ subscriptionId: subscriptionOrders.subscriptionId, status: subscriptionOrders.status })
      .from(subscriptionOrders)
      .where(
        and(inArray(subscriptionOrders.subscriptionId, ids), eq(subscriptionOrders.deliveryDate, tomorrow)),
      ),
    db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }),
  ]);
  const overrideFor = (subscriptionId: string, date: IsoDate) =>
    overrides.find((o) => o.subscriptionId === subscriptionId && o.deliveryDate === date);
  const lockedIds = new Set(
    generated.filter((g) => g.status !== "WALLET_INSUFFICIENT").map((g) => g.subscriptionId),
  );

  const lines: TomorrowLine[] = [];
  for (const sub of subs) {
    const result = resolveDelivery(toScheduleInput(sub), tomorrow, overrideFor(sub.id, tomorrow));
    if (!result.delivers && result.reason !== "SKIPPED") continue;
    lines.push({
      subscriptionId: sub.id,
      productName: sub.productName,
      shopName: sub.shopName,
      scheduleLabel: scheduleLabel(sub.frequency, sub.weekdays),
      unit: sub.unit,
      quantityMilli: result.delivers ? result.quantityMilli : sub.quantityMilli,
      standingQuantityMilli: sub.quantityMilli,
      stepMilli: stepFor(sub.unit, sub.unitSizeMilli),
      unitPricePaise: sub.currentUnitPricePaise,
      skipped: !result.delivers,
      locked: lockedIds.has(sub.id),
    });
  }
  if (lines.length === 0) return null;

  // The next day after tomorrow on which anything is delivered, and its cost.
  let following: TomorrowDelivery["following"] = null;
  for (let i = 1; i <= LOOKAHEAD_DAYS && !following; i += 1) {
    const date = addDays(tomorrow, i);
    let cost = 0;
    let delivers = false;
    for (const sub of subs) {
      const result = resolveDelivery(toScheduleInput(sub), date, overrideFor(sub.id, date));
      if (!result.delivers) continue;
      delivers = true;
      if (sub.currentUnitPricePaise) cost += lineTotalPaise(sub.currentUnitPricePaise, result.quantityMilli);
    }
    if (delivers) following = { date, costPaise: cost };
  }

  const hour = hourIn(env.APP_TIMEZONE, now);

  return {
    date: tomorrow,
    lines,
    walletBalancePaise: wallet?.balancePaise ?? 0,
    cutoffHour: env.SUBSCRIPTION_CUTOFF_HOUR,
    beforeCutoff: hour < env.SUBSCRIPTION_CUTOFF_HOUR && lines.some((l) => !l.locked),
    following,
  };
}
