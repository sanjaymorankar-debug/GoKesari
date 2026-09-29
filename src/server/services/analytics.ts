/**
 * Marketplace KPIs (GS-069, KPI-001…KPI-015, NAV-018).
 *
 * Every figure is computed on read from the operational tables — orders and
 * their status history, deliveries, rider sessions, subscriptions, campaigns
 * — for a date window in the app time zone. Nothing is stored, so a KPI can
 * never drift from the data behind it. Scope: the whole marketplace, or one
 * shop (the shop's own dashboard); rider and retention KPIs are
 * marketplace-only.
 *
 * Definitions (documented for QA and the business):
 *  - placed order       — reached CONFIRMED (paid, or COD accepted), created in the window
 *  - KPI-002 fill rate  — placed orders later DELIVERED ÷ placed; item fill rate = lines not removed ÷ lines
 *  - KPI-003 acceptance — CONFIRMED → shop ACCEPTED (or PREPARING when the accept step was skipped)
 *  - KPI-004 pick-pack  — accepted → READY
 *  - KPI-005 assignment — READY → a rider ACCEPTED the delivery
 *  - KPI-006 delivery   — rider pickup → delivered; also CONFIRMED → DELIVERED end to end
 *  - KPI-007 on time    — delivered by the promised time, among orders that had a promise
 *  - KPI-008 cancelled  — placed orders that were cancelled ÷ placed
 *  - KPI-009 refunds    — placed orders with any refund ÷ placed; refunded value ÷ placed value
 *  - KPI-010 repeat     — customers with 2+ placed orders in the window ÷ customers with 1+
 *  - KPI-011 retention  — subscriptions live at the window start and not cancelled by its end ÷ live at start
 *  - KPI-012 rider acceptance — offers accepted ÷ (accepted + declined/expired)
 *  - KPI-013 utilisation — time on a delivery ÷ time online (rider sessions)
 *  - KPI-014 shop retention — shops with a delivered order in the previous window that have one again ÷ those shops
 *  - KPI-015 marketing conversion — campaign recipients who ordered from the shop within the attribution days ÷ recipients
 */
import { and, count, countDistinct, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import { addDays, assertIsoDate, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { validationFailed } from "@/lib/errors";
import { RIDER_IDLE_CAP_MINUTES } from "@/lib/rider-sessions";
import { db } from "@/server/db";
import { deliveryOrders, deliveryPartners, orders, type OrderStatus } from "@/server/db/schema";
import { ACTIVE_ASSIGNMENT_STATUSES } from "./delivery-eligibility";

export interface KpiWindow {
  from: IsoDate;
  /** Exclusive. */
  to: IsoDate;
  shopId?: string | null;
}

export interface Duration {
  count: number;
  avgMinutes: number | null;
  medianMinutes: number | null;
}

export interface MarketplaceKpis {
  from: IsoDate;
  to: IsoDate;
  shopId: string | null;
  orders: {
    placed: number;
    placedValuePaise: number;
    delivered: number;
    cancelled: number;
    refunded: number;
    refundedValuePaise: number;
  };
  fillRate: number | null;
  itemFillRate: number | null;
  shopAcceptance: Duration;
  pickPack: Duration;
  assignment: Duration;
  riderDelivery: Duration;
  endToEnd: Duration;
  onTime: { promised: number; onTime: number; rate: number | null };
  cancellationRate: number | null;
  refundRate: number | null;
  refundValueRate: number | null;
  customers: { ordering: number; repeat: number; returning: number; repeatRate: number | null };
  subscriptions: { liveAtStart: number; retained: number; retention: number | null; newInWindow: number; cancelledInWindow: number };
  riders: {
    offersAccepted: number;
    offersDeclined: number;
    acceptanceRate: number | null;
    onlineHours: number;
    busyHours: number;
    utilisation: number | null;
  } | null;
  shopRetention: { previousActive: number; retained: number; rate: number | null } | null;
  marketing: { campaigns: number; recipients: number; opened: number; converted: number; conversionRate: number | null; revenuePaise: number };
  gmvTrend: { day: IsoDate; gmvPaise: number; orders: number }[];
}

type Row = Record<string, unknown>;

async function one(query: SQL): Promise<Row> {
  const result = (await db.execute(query)) as unknown as Row[];
  return result[0] ?? {};
}

async function all(query: SQL): Promise<Row[]> {
  return (await db.execute(query)) as unknown as Row[];
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const nullableNumber = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);

function duration(row: Row): Duration {
  return { count: n(row.count), avgMinutes: nullableNumber(row.avg), medianMinutes: nullableNumber(row.median) };
}

/** Aggregates minutes between two timestamps over a set, as count / avg / median. */
function durationSelect(start: SQL, end: SQL): SQL {
  const minutes = sql`extract(epoch from (${end} - ${start})) / 60.0`;
  return sql`count(*)::int as count, avg(${minutes}) as avg,
    percentile_cont(0.5) within group (order by ${minutes}) as median`;
}

export function defaultWindow(days = 30, today?: IsoDate): { from: IsoDate; to: IsoDate } {
  const end = today ?? todayIn(getEnv().APP_TIMEZONE);
  const to = addDays(end, 1);
  return { from: addDays(to, -days), to };
}

export async function getMarketplaceKpis(window: KpiWindow): Promise<MarketplaceKpis> {
  const from = assertIsoDate(window.from);
  const to = assertIsoDate(window.to);
  if (to <= from) throw validationFailed("The end date must be after the start date.");
  const shopId = window.shopId ?? null;
  const tz = getEnv().APP_TIMEZONE;

  const start = sql`((${from})::date::timestamp at time zone ${tz})`;
  const end = sql`((${to})::date::timestamp at time zone ${tz})`;
  const shopFilter = (alias: string) => (shopId ? sql`and ${sql.raw(alias)}.shop_id = ${shopId}` : sql``);
  const confirmedAt = (alias: string) =>
    sql`(select min(h.created_at) from order_status_history h where h.order_id = ${sql.raw(alias)}.id and h.new_status = 'CONFIRMED')`;
  const reached = (alias: string, status: string) =>
    sql`exists (select 1 from order_status_history h where h.order_id = ${sql.raw(alias)}.id and h.new_status = ${status})`;
  const reachedAt = (alias: string, status: string) =>
    sql`(select min(h.created_at) from order_status_history h where h.order_id = ${sql.raw(alias)}.id and h.new_status = ${status})`;

  // Orders placed in the window (reached CONFIRMED).
  const placed = sql`(select o.* from orders o
    where o.created_at >= ${start} and o.created_at < ${end} ${shopFilter("o")} and ${reached("o", "CONFIRMED")})`;

  const ordersRow = await one(sql`
    select count(*)::int as placed,
      coalesce(sum(p.total_paise + p.refunded_paise), 0)::bigint as placed_value,
      count(*) filter (where ${reached("p", "DELIVERED")})::int as delivered,
      count(*) filter (where ${reached("p", "CANCELLED")})::int as cancelled,
      count(*) filter (where p.refunded_paise > 0 or p.status = 'REFUNDED')::int as refunded,
      coalesce(sum(case when p.status = 'REFUNDED' then p.total_paise + p.refunded_paise else p.refunded_paise end), 0)::bigint as refunded_value
    from ${placed} p`);

  const itemsRow = await one(sql`
    select count(*)::int as lines, count(*) filter (where i.fulfilment_status <> 'REMOVED')::int as kept
    from order_items i join ${placed} p on p.id = i.order_id`);

  const acceptance = await one(sql`
    select ${durationSelect(confirmedAt("o"), sql`coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")})`)}
    from orders o
    where coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")}) >= ${start}
      and coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")}) < ${end} ${shopFilter("o")}
      and ${confirmedAt("o")} is not null`);

  const pickPack = await one(sql`
    select ${durationSelect(sql`coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")})`, sql`o.packed_at`)}
    from orders o
    where o.packed_at >= ${start} and o.packed_at < ${end} ${shopFilter("o")}
      and coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")}) is not null`);

  const assignment = await one(sql`
    select ${durationSelect(sql`o.packed_at`, sql`d.accepted_at`)}
    from delivery_orders d join orders o on o.id = d.order_id
    where d.accepted_at >= ${start} and d.accepted_at < ${end} ${shopFilter("o")}
      and o.packed_at is not null and d.accepted_at >= o.packed_at`);

  const riderDelivery = await one(sql`
    select ${durationSelect(sql`d.picked_up_at`, sql`d.delivered_at`)}
    from delivery_orders d join orders o on o.id = d.order_id
    where d.status = 'DELIVERED' and d.delivered_at >= ${start} and d.delivered_at < ${end} ${shopFilter("o")}
      and d.picked_up_at is not null`);

  const endToEnd = await one(sql`
    select ${durationSelect(confirmedAt("o"), reachedAt("o", "DELIVERED"))}
    from orders o
    where ${reachedAt("o", "DELIVERED")} >= ${start} and ${reachedAt("o", "DELIVERED")} < ${end} ${shopFilter("o")}
      and ${confirmedAt("o")} is not null`);

  const onTime = await one(sql`
    select count(*)::int as promised,
      count(*) filter (where ${reachedAt("o", "DELIVERED")} <= o.promised_by_at)::int as on_time
    from orders o
    where o.promised_by_at is not null and ${reachedAt("o", "DELIVERED")} >= ${start}
      and ${reachedAt("o", "DELIVERED")} < ${end} ${shopFilter("o")}`);

  const customers = await one(sql`
    select count(*)::int as ordering,
      count(*) filter (where c.orders >= 2)::int as repeat,
      count(*) filter (where c.earlier)::int as returning
    from (
      select p.user_id, count(*) as orders,
        bool_or(exists (select 1 from orders e where e.user_id = p.user_id and e.created_at < ${start}
          ${shopId ? sql`and e.shop_id = ${shopId}` : sql``} and ${reached("e", "CONFIRMED")})) as earlier
      from ${placed} p group by p.user_id
    ) c`);

  const subs = await one(sql`
    select
      count(*) filter (where s.created_at < ${start} and (s.cancelled_at is null or s.cancelled_at >= ${start})
        and s.status <> 'COMPLETED')::int as live_at_start,
      count(*) filter (where s.created_at < ${start} and (s.cancelled_at is null or s.cancelled_at >= ${end})
        and s.status <> 'COMPLETED')::int as retained,
      count(*) filter (where s.created_at >= ${start} and s.created_at < ${end})::int as new_in_window,
      count(*) filter (where s.cancelled_at >= ${start} and s.cancelled_at < ${end})::int as cancelled_in_window
    from subscriptions s where true ${shopFilter("s")}`);

  const marketing = await one(sql`
    select count(distinct c.id)::int as campaigns, count(r.id)::int as recipients,
      count(r.id) filter (where exists (select 1 from notifications nt where nt.dedupe_key = r.notification_key and nt.read_at is not null))::int as opened,
      count(r.id) filter (where conv.first_order is not null)::int as converted,
      coalesce(sum(conv.value), 0)::bigint as revenue
    from marketing_campaigns c
    join campaign_recipients r on r.campaign_id = c.id
    left join lateral (
      select min(o.created_at) as first_order, sum(o.total_paise) as value
      from orders o
      where o.user_id = r.user_id and o.shop_id = c.shop_id and o.created_at >= r.sent_at
        and o.created_at < r.sent_at + make_interval(days => c.attribution_days) and ${reached("o", "CONFIRMED")}
    ) conv on true
    where c.sent_at >= ${start} and c.sent_at < ${end} ${shopFilter("c")}`);

  const trend = await all(sql`
    select to_char(f.delivered_at at time zone ${tz}, 'YYYY-MM-DD') as day,
      coalesce(sum(f.gmv_paise), 0)::bigint as gmv, count(*)::int as orders
    from order_financials f
    where f.delivered_at >= ${start} and f.delivered_at < ${end} ${shopFilter("f")}
    group by 1 order by 1`);

  let riders: MarketplaceKpis["riders"] = null;
  let shopRetention: MarketplaceKpis["shopRetention"] = null;
  if (!shopId) {
    const offers = await one(sql`
      select count(*) filter (where d.accepted_at is not null)::int as accepted,
        coalesce(sum(cardinality(d.rejected_partner_ids)), 0)::int as declined
      from delivery_orders d where d.offered_at >= ${start} and d.offered_at < ${end}`);
    const online = await one(sql`
      select coalesce(sum(extract(epoch from (
        least(coalesce(s.ended_at, least(now(), greatest(p.last_location_at, s.started_at) + make_interval(mins => ${RIDER_IDLE_CAP_MINUTES}))), ${end})
        - greatest(s.started_at, ${start})))), 0) / 3600.0 as hours
      from delivery_partner_sessions s join delivery_partners p on p.id = s.delivery_partner_id
      where s.started_at < ${end} and coalesce(s.ended_at, now()) > ${start}`);
    const busy = await one(sql`
      select coalesce(sum(extract(epoch from (
        least(coalesce(d.delivered_at, d.failed_at, d.cancelled_at, now()), ${end}) - greatest(d.accepted_at, ${start})))), 0) / 3600.0 as hours
      from delivery_orders d
      where d.accepted_at is not null and d.accepted_at < ${end}
        and coalesce(d.delivered_at, d.failed_at, d.cancelled_at, now()) > ${start}`);
    const accepted = n(offers.accepted);
    const declined = n(offers.declined);
    const onlineHours = Math.round(Math.max(0, n(online.hours)) * 10) / 10;
    const busyHours = Math.round(Math.max(0, n(busy.hours)) * 10) / 10;
    riders = {
      offersAccepted: accepted,
      offersDeclined: declined,
      acceptanceRate: ratio(accepted, accepted + declined),
      onlineHours,
      busyHours,
      utilisation: onlineHours > 0 ? Math.min(1, Math.round((busyHours / onlineHours) * 1000) / 1000) : null,
    };

    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
    const prevStart = sql`((${addDays(from, -days)})::date::timestamp at time zone ${tz})`;
    const retention = await one(sql`
      with prev as (select distinct shop_id from order_financials where delivered_at >= ${prevStart} and delivered_at < ${start}),
           cur as (select distinct shop_id from order_financials where delivered_at >= ${start} and delivered_at < ${end})
      select (select count(*) from prev)::int as previous_active,
             (select count(*) from prev join cur using (shop_id))::int as retained`);
    shopRetention = {
      previousActive: n(retention.previous_active),
      retained: n(retention.retained),
      rate: ratio(n(retention.retained), n(retention.previous_active)),
    };
  }

  const placedCount = n(ordersRow.placed);
  const placedValue = n(ordersRow.placed_value);
  const liveAtStart = n(subs.live_at_start);
  const recipients = n(marketing.recipients);
  return {
    from,
    to,
    shopId,
    orders: {
      placed: placedCount,
      placedValuePaise: placedValue,
      delivered: n(ordersRow.delivered),
      cancelled: n(ordersRow.cancelled),
      refunded: n(ordersRow.refunded),
      refundedValuePaise: n(ordersRow.refunded_value),
    },
    fillRate: ratio(n(ordersRow.delivered), placedCount),
    itemFillRate: ratio(n(itemsRow.kept), n(itemsRow.lines)),
    shopAcceptance: duration(acceptance),
    pickPack: duration(pickPack),
    assignment: duration(assignment),
    riderDelivery: duration(riderDelivery),
    endToEnd: duration(endToEnd),
    onTime: { promised: n(onTime.promised), onTime: n(onTime.on_time), rate: ratio(n(onTime.on_time), n(onTime.promised)) },
    cancellationRate: ratio(n(ordersRow.cancelled), placedCount),
    refundRate: ratio(n(ordersRow.refunded), placedCount),
    refundValueRate: ratio(n(ordersRow.refunded_value), placedValue),
    customers: {
      ordering: n(customers.ordering),
      repeat: n(customers.repeat),
      returning: n(customers.returning),
      repeatRate: ratio(n(customers.repeat), n(customers.ordering)),
    },
    subscriptions: {
      liveAtStart,
      retained: n(subs.retained),
      retention: ratio(n(subs.retained), liveAtStart),
      newInWindow: n(subs.new_in_window),
      cancelledInWindow: n(subs.cancelled_in_window),
    },
    riders,
    shopRetention,
    marketing: {
      campaigns: n(marketing.campaigns),
      recipients,
      opened: n(marketing.opened),
      converted: n(marketing.converted),
      conversionRate: ratio(n(marketing.converted), recipients),
      revenuePaise: n(marketing.revenue),
    },
    gmvTrend: trend.map((t) => ({ day: String(t.day), gmvPaise: n(t.gmv), orders: n(t.orders) })),
  };
}

export const IN_FLIGHT_ORDER_STATUSES = [
  "CONFIRMED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "FAILED",
] as const satisfies readonly OrderStatus[];

export type InFlightOrderStatus = (typeof IN_FLIGHT_ORDER_STATUSES)[number];

export interface LiveOperations {
  inFlight: { status: InFlightOrderStatus; count: number }[];
  /** Approved, marked online, not deleted — the same predicate dispatch uses. */
  ridersOnline: number;
  ridersBusy: number;
}

/** Point-in-time snapshot, not windowed: orders in flight right now and riders online right now. */
export async function getLiveOperations(): Promise<LiveOperations> {
  const onlineRider = and(
    eq(deliveryPartners.status, "APPROVED"),
    eq(deliveryPartners.isOnline, true),
    isNull(deliveryPartners.deletedAt),
  );
  const [statusRows, onlineRows, busyRows] = await Promise.all([
    db
      .select({ status: orders.status, count: count() })
      .from(orders)
      .where(inArray(orders.status, IN_FLIGHT_ORDER_STATUSES))
      .groupBy(orders.status),
    db.select({ value: count() }).from(deliveryPartners).where(onlineRider),
    db
      .select({ value: countDistinct(deliveryOrders.deliveryPartnerId) })
      .from(deliveryOrders)
      .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryOrders.deliveryPartnerId))
      .where(and(onlineRider, inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES))),
  ]);
  const byStatus = new Map<OrderStatus, number>(statusRows.map((r) => [r.status, r.count]));
  return {
    inFlight: IN_FLIGHT_ORDER_STATUSES.map((status) => ({ status, count: byStatus.get(status) ?? 0 })),
    ridersOnline: onlineRows[0]?.value ?? 0,
    ridersBusy: busyRows[0]?.value ?? 0,
  };
}
