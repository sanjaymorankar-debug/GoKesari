/**
 * SM-004 per-delivery status — the schedule side.
 *
 * subscription_deliveries holds one row per delivery date. Before the day's
 * order exists, this module decides the row: SCHEDULED (the schedule says a
 * delivery happens), SKIPPED (the customer skipped it, or it falls in a
 * pause), or no row at all (not a delivery day). Once the order exists, a
 * database trigger copies its status in and this module leaves the row alone
 * — the order is the truth from then on (migration 0052).
 *
 * The sync is idempotent and cheap (one subscription, a few days), so every
 * action that can change the schedule simply calls it again.
 */
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { addDays, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import {
  SCHEDULE_ONLY_STATUSES,
  type DeliverySkipReason,
  type SubscriptionDeliveryStatus,
} from "@/lib/subscription-deliveries";
import { db, type DbClient } from "@/server/db";
import {
  orders,
  products,
  shopProducts,
  subscriptionDailyOverrides,
  subscriptionDeliveries,
  subscriptions,
  users,
  type SubscriptionDelivery,
} from "@/server/db/schema";
import { getRule } from "./settings";
import { resolveDelivery, toScheduleInput } from "./subscriptions";

const SCHEDULE_ONLY = SCHEDULE_ONLY_STATUSES as readonly string[];
const LIVE_STATUSES = ["ACTIVE", "PAYMENT_PENDING", "RENEWAL_PENDING"] as const;

interface Desired {
  status: Extract<SubscriptionDeliveryStatus, "SCHEDULED" | "SKIPPED">;
  quantityMilli: number | null;
  reason: DeliverySkipReason | null;
}

/**
 * Writes SCHEDULED / SKIPPED rows for `from` .. `from + horizon - 1` and
 * removes schedule-only rows that are no longer delivery days. Rows that
 * already follow an order are never touched.
 */
export async function syncSubscriptionSchedule(
  subscriptionId: string,
  options: { from?: IsoDate; horizonDays?: number; client?: DbClient } = {},
): Promise<void> {
  const client = options.client ?? db;
  const from = options.from ?? todayIn(getEnv().APP_TIMEZONE);
  const horizon = options.horizonDays ?? (await getRule("subscriptionRenewal")).scheduleHorizonDays;
  const until = addDays(from, horizon); // exclusive

  const subscription = await client.query.subscriptions.findFirst({ where: eq(subscriptions.id, subscriptionId) });
  if (!subscription) return;

  const existing = await client
    .select()
    .from(subscriptionDeliveries)
    .where(and(eq(subscriptionDeliveries.subscriptionId, subscriptionId), gte(subscriptionDeliveries.deliveryDate, from)));
  const byDate = new Map(existing.map((r) => [r.deliveryDate, r]));

  // Not live (draft, cancelled, completed): nothing upcoming is scheduled.
  if (!(LIVE_STATUSES as readonly string[]).includes(subscription.status)) {
    const stale = existing.filter((r) => SCHEDULE_ONLY.includes(r.status)).map((r) => r.id);
    if (stale.length) await client.delete(subscriptionDeliveries).where(inArray(subscriptionDeliveries.id, stale));
    return;
  }

  const overrides = await client
    .select()
    .from(subscriptionDailyOverrides)
    .where(
      and(
        eq(subscriptionDailyOverrides.subscriptionId, subscriptionId),
        gte(subscriptionDailyOverrides.deliveryDate, from),
        lt(subscriptionDailyOverrides.deliveryDate, until),
      ),
    );
  const overrideByDate = new Map(overrides.map((o) => [o.deliveryDate, o]));
  const schedule = toScheduleInput(subscription);

  const toDelete: string[] = [];
  for (let date = from; date < until; date = addDays(date, 1)) {
    const row = byDate.get(date);
    if (row && !SCHEDULE_ONLY.includes(row.status)) continue; // follows its order

    const resolution = resolveDelivery(schedule, date, overrideByDate.get(date));
    let desired: Desired | null = null;
    if (resolution.delivers) desired = { status: "SCHEDULED", quantityMilli: resolution.quantityMilli, reason: null };
    else if (resolution.reason === "SKIPPED") desired = { status: "SKIPPED", quantityMilli: null, reason: "SKIPPED_BY_CUSTOMER" };
    else if (resolution.reason === "PAUSED") desired = { status: "SKIPPED", quantityMilli: null, reason: "PAUSED" };

    if (!desired) {
      if (row) toDelete.push(row.id);
      continue;
    }
    if (row && row.status === desired.status && row.quantityMilli === desired.quantityMilli && row.reason === desired.reason) {
      continue;
    }
    await client
      .insert(subscriptionDeliveries)
      .values({ subscriptionId, deliveryDate: date, ...desired })
      .onConflictDoUpdate({
        target: [subscriptionDeliveries.subscriptionId, subscriptionDeliveries.deliveryDate],
        set: { status: desired.status, quantityMilli: desired.quantityMilli, reason: desired.reason },
        // Never pull a row that already follows an order back to the schedule.
        setWhere: sql`${subscriptionDeliveries.status} IN ('SCHEDULED', 'SKIPPED')`,
      });
  }
  // Schedule-only rows past the horizon (e.g. the horizon was shortened).
  for (const row of existing) {
    if (row.deliveryDate >= until && SCHEDULE_ONLY.includes(row.status)) toDelete.push(row.id);
  }
  if (toDelete.length) await client.delete(subscriptionDeliveries).where(inArray(subscriptionDeliveries.id, toDelete));
}

/**
 * A due delivery could not be generated because the product was unavailable:
 * the date is FAILED (reason UNAVAILABLE) with no order. Only a schedule-only
 * row is changed.
 */
export async function markDeliveryUnavailable(subscriptionId: string, date: IsoDate, client: DbClient = db): Promise<void> {
  await client
    .insert(subscriptionDeliveries)
    .values({ subscriptionId, deliveryDate: date, status: "FAILED", reason: "UNAVAILABLE" })
    .onConflictDoUpdate({
      target: [subscriptionDeliveries.subscriptionId, subscriptionDeliveries.deliveryDate],
      set: { status: "FAILED", reason: "UNAVAILABLE" },
      setWhere: sql`${subscriptionDeliveries.status} IN ('SCHEDULED', 'SKIPPED')`,
    });
}

/** Deliveries of one subscription in a date range, oldest first. */
export async function listDeliveriesForSubscription(
  subscriptionId: string,
  range: { from: IsoDate; until: IsoDate },
): Promise<(SubscriptionDelivery & { orderNumber: string | null })[]> {
  const rows = await db
    .select({ d: subscriptionDeliveries, orderNumber: orders.orderNumber })
    .from(subscriptionDeliveries)
    .leftJoin(orders, eq(orders.id, subscriptionDeliveries.orderId))
    .where(
      and(
        eq(subscriptionDeliveries.subscriptionId, subscriptionId),
        gte(subscriptionDeliveries.deliveryDate, range.from),
        lt(subscriptionDeliveries.deliveryDate, range.until),
      ),
    )
    .orderBy(asc(subscriptionDeliveries.deliveryDate));
  return rows.map((r) => ({ ...r.d, orderNumber: r.orderNumber }));
}

export interface DeliveryListRow {
  delivery: SubscriptionDelivery;
  subscriptionId: string;
  customerName: string | null;
  productName: string;
  unit: string;
  orderNumber: string | null;
  shopId: string;
}

/** A shop's (or, without shopId, every shop's) subscription deliveries in a date range. */
export async function listSubscriptionDeliveries(filter: {
  shopId?: string;
  from: IsoDate;
  until: IsoDate;
  statuses?: SubscriptionDeliveryStatus[];
  limit?: number;
}): Promise<DeliveryListRow[]> {
  const rows = await db
    .select({
      delivery: subscriptionDeliveries,
      subscriptionId: subscriptions.id,
      shopId: subscriptions.shopId,
      customerName: users.name,
      productName: products.name,
      unit: products.unit,
      orderNumber: orders.orderNumber,
    })
    .from(subscriptionDeliveries)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionDeliveries.subscriptionId))
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .innerJoin(shopProducts, eq(shopProducts.id, subscriptions.shopProductId))
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(orders, eq(orders.id, subscriptionDeliveries.orderId))
    .where(
      and(
        filter.shopId ? eq(subscriptions.shopId, filter.shopId) : undefined,
        gte(subscriptionDeliveries.deliveryDate, filter.from),
        lt(subscriptionDeliveries.deliveryDate, filter.until),
        filter.statuses?.length ? inArray(subscriptionDeliveries.status, filter.statuses) : undefined,
      ),
    )
    .orderBy(asc(subscriptionDeliveries.deliveryDate), asc(products.name))
    .limit(Math.min(filter.limit ?? 200, 1000));
  return rows;
}

/** Count of deliveries per status in a date range (admin overview). */
export async function countDeliveriesByStatus(range: { from: IsoDate; until: IsoDate }): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: subscriptionDeliveries.status, n: sql<number>`count(*)::int` })
    .from(subscriptionDeliveries)
    .where(and(gte(subscriptionDeliveries.deliveryDate, range.from), lt(subscriptionDeliveries.deliveryDate, range.until)))
    .groupBy(subscriptionDeliveries.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
