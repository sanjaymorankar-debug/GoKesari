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
import {
  and,
  count,
  countDistinct,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";

import { addDays, assertIsoDate, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { validationFailed } from "@/lib/errors";
import { RIDER_IDLE_CAP_MINUTES } from "@/lib/rider-sessions";
import { db } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  orders,
  type OrderStatus,
} from "@/server/db/schema";
import { ACTIVE_ASSIGNMENT_STATUSES } from "./delivery-eligibility";
import { row, rows } from "@/server/db/raw";

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
  customers: {
    ordering: number;
    repeat: number;
    returning: number;
    repeatRate: number | null;
  };
  subscriptions: {
    liveAtStart: number;
    retained: number;
    retention: number | null;
    newInWindow: number;
    cancelledInWindow: number;
  };
  riders: {
    offersAccepted: number;
    offersDeclined: number;
    acceptanceRate: number | null;
    onlineHours: number;
    busyHours: number;
    utilisation: number | null;
  } | null;
  shopRetention: {
    previousActive: number;
    retained: number;
    rate: number | null;
  } | null;
  marketing: {
    campaigns: number;
    recipients: number;
    opened: number;
    converted: number;
    conversionRate: number | null;
    revenuePaise: number;
  };
  gmvTrend: { day: IsoDate; gmvPaise: number; orders: number }[];
}

type Row = Record<string, unknown>;

async function one(query: SQL): Promise<Row> {
  return row<Row>(await db.execute(query)) ?? {};
}

async function all(query: SQL): Promise<Row[]> {
  return rows<Row>(await db.execute(query));
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const nullableNumber = (v: unknown) =>
  v == null ? null : Math.round(Number(v) * 10) / 10;
const ratio = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 1000) / 1000 : null;

function duration(row: Row): Duration {
  return {
    count: n(row.count),
    avgMinutes: nullableNumber(row.avg),
    medianMinutes: nullableNumber(row.median),
  };
}

/**
 * count / avg / median of the minutes between two timestamps over a set.
 *
 * `body` carries the `from ... where ...` the three statistics are taken over,
 * so this builds a whole query rather than a select-list. The median forces
 * that: Postgres had `percentile_cont(0.5) WITHIN GROUP (ORDER BY x)`, which
 * MySQL 8 does not have at all and MariaDB offers only as a window function, so
 * on neither engine can it sit in a plain aggregate list. Ranking the rows and
 * averaging the middle one — or the middle two, when the count is even — is
 * portable to both and gives the value percentile_cont gave.
 *
 * `rn * 2 in (c, c + 1, c + 2)` is that middle: for an odd count it admits only
 * rn = (c + 1) / 2, and for an even count exactly rn = c / 2 and c / 2 + 1.
 *
 * The minutes themselves are TIMESTAMPDIFF, not a subtraction: `a - b` on two
 * MySQL DATETIMEs is arithmetic on their YYYYMMDDHHMMSS digits, not an
 * interval, so it does not mean what the Postgres original meant.
 */
function durationQuery(start: SQL, end: SQL, body: SQL): SQL {
  const minutes = sql`TIMESTAMPDIFF(SECOND, ${start}, ${end}) / 60.0`;
  return sql`
    select CAST(count(*) AS SIGNED) as count, avg(m) as avg,
      avg(case when rn * 2 in (c, c + 1, c + 2) then m end) as median
    from (
      select m, row_number() over (order by m) as rn, count(*) over () as c
      from (select ${minutes} as m ${body}) t
    ) x`;
}

export function defaultWindow(
  days = 30,
  today?: IsoDate,
): { from: IsoDate; to: IsoDate } {
  const end = today ?? todayIn(getEnv().APP_TIMEZONE);
  const to = addDays(end, 1);
  return { from: addDays(to, -days), to };
}

export async function getMarketplaceKpis(
  window: KpiWindow,
): Promise<MarketplaceKpis> {
  const from = assertIsoDate(window.from);
  const to = assertIsoDate(window.to);
  if (to <= from)
    throw validationFailed("The end date must be after the start date.");
  const shopId = window.shopId ?? null;
  const tz = getEnv().APP_TIMEZONE;

  // local midnight in `tz` -> the UTC instant it corresponds to (see
  // finance.ts startOf for the same conversion)
  const start = sql`CONVERT_TZ(CAST(${from} AS DATETIME), ${tz}, '+00:00')`;
  const end = sql`CONVERT_TZ(CAST(${to} AS DATETIME), ${tz}, '+00:00')`;
  const shopFilter = (alias: string) =>
    shopId ? sql`and ${sql.raw(alias)}.shop_id = ${shopId}` : sql``;
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
    select CAST(count(*) AS SIGNED) as placed,
      CAST(coalesce(sum(p.total_paise + p.refunded_paise), 0) AS SIGNED) as placed_value,
      CAST(count(case when ${reached("p", "DELIVERED")} then 1 end) AS SIGNED) as delivered,
      CAST(count(case when ${reached("p", "CANCELLED")} then 1 end) AS SIGNED) as cancelled,
      CAST(count(case when p.refunded_paise > 0 or p.status = 'REFUNDED' then 1 end) AS SIGNED) as refunded,
      CAST(coalesce(sum(case when p.status = 'REFUNDED' then p.total_paise + p.refunded_paise else p.refunded_paise end), 0) AS SIGNED) as refunded_value
    from ${placed} p`);

  const itemsRow = await one(sql`
    select CAST(count(*) AS SIGNED) as lines, CAST(count(case when i.fulfilment_status <> 'REMOVED' then 1 end) AS SIGNED) as kept
    from order_items i join ${placed} p on p.id = i.order_id`);

  const acceptance = await one(
    durationQuery(
      confirmedAt("o"),
      sql`coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")})`,
      sql`from orders o
      where coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")}) >= ${start}
        and coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")}) < ${end} ${shopFilter("o")}
        and ${confirmedAt("o")} is not null`,
    ),
  );

  const pickPack = await one(
    durationQuery(
      sql`coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")})`,
      sql`o.packed_at`,
      sql`from orders o
      where o.packed_at >= ${start} and o.packed_at < ${end} ${shopFilter("o")}
        and coalesce(o.accepted_at, ${reachedAt("o", "PREPARING")}) is not null`,
    ),
  );

  const assignment = await one(
    durationQuery(
      sql`o.packed_at`,
      sql`d.accepted_at`,
      sql`from delivery_orders d join orders o on o.id = d.order_id
      where d.accepted_at >= ${start} and d.accepted_at < ${end} ${shopFilter("o")}
        and o.packed_at is not null and d.accepted_at >= o.packed_at`,
    ),
  );

  const riderDelivery = await one(
    durationQuery(
      sql`d.picked_up_at`,
      sql`d.delivered_at`,
      sql`from delivery_orders d join orders o on o.id = d.order_id
      where d.status = 'DELIVERED' and d.delivered_at >= ${start} and d.delivered_at < ${end} ${shopFilter("o")}
        and d.picked_up_at is not null`,
    ),
  );

  const endToEnd = await one(
    durationQuery(
      confirmedAt("o"),
      reachedAt("o", "DELIVERED"),
      sql`from orders o
      where ${reachedAt("o", "DELIVERED")} >= ${start} and ${reachedAt("o", "DELIVERED")} < ${end} ${shopFilter("o")}
        and ${confirmedAt("o")} is not null`,
    ),
  );

  const onTime = await one(sql`
    select CAST(count(*) AS SIGNED) as promised,
      CAST(count(case when ${reachedAt("o", "DELIVERED")} <= o.promised_by_at then 1 end) AS SIGNED) as on_time
    from orders o
    where o.promised_by_at is not null and ${reachedAt("o", "DELIVERED")} >= ${start}
      and ${reachedAt("o", "DELIVERED")} < ${end} ${shopFilter("o")}`);

  const customers = await one(sql`
    select CAST(count(*) AS SIGNED) as ordering,
      CAST(count(case when c.orders >= 2 then 1 end) AS SIGNED) as repeat,
      CAST(count(case when c.earlier then 1 end) AS SIGNED) as returning
    from (
      select p.user_id, count(*) as orders,
        max(exists (select 1 from orders e where e.user_id = p.user_id and e.created_at < ${start}
          ${shopId ? sql`and e.shop_id = ${shopId}` : sql``} and ${reached("e", "CONFIRMED")})) as earlier
      from ${placed} p group by p.user_id
    ) c`);

  const subs = await one(sql`
    select
      CAST(count(case when s.created_at < ${start} and (s.cancelled_at is null or s.cancelled_at >= ${start})
        and s.status <> 'COMPLETED' then 1 end) AS SIGNED) as live_at_start,
      CAST(count(case when s.created_at < ${start} and (s.cancelled_at is null or s.cancelled_at >= ${end})
        and s.status <> 'COMPLETED' then 1 end) AS SIGNED) as retained,
      CAST(count(case when s.created_at >= ${start} and s.created_at < ${end} then 1 end) AS SIGNED) as new_in_window,
      CAST(count(case when s.cancelled_at >= ${start} and s.cancelled_at < ${end} then 1 end) AS SIGNED) as cancelled_in_window
    from subscriptions s where true ${shopFilter("s")}`);

  // The attributed-orders aggregate was a LEFT JOIN LATERAL. MySQL 8 supports
  // LATERAL but MariaDB does not at all, so it becomes two correlated scalar
  // subqueries over the same predicate — same values, portable to both.
  const attributed = sql`from orders o
      where o.user_id = r.user_id and o.shop_id = c.shop_id and o.created_at >= r.sent_at
        and o.created_at < r.sent_at + interval c.attribution_days day and ${reached("o", "CONFIRMED")}`;
  const marketing = await one(sql`
    select CAST(count(distinct c.id) AS SIGNED) as campaigns, CAST(count(r.id) AS SIGNED) as recipients,
      CAST(count(case when exists (select 1 from notifications nt where nt.dedupe_key = r.notification_key and nt.read_at is not null) then r.id end) AS SIGNED) as opened,
      CAST(count(case when (select min(o.created_at) ${attributed}) is not null then r.id end) AS SIGNED) as converted,
      CAST(coalesce(sum((select sum(o.total_paise) ${attributed})), 0) AS SIGNED) as revenue
    from marketing_campaigns c
    join campaign_recipients r on r.campaign_id = c.id
    where c.sent_at >= ${start} and c.sent_at < ${end} ${shopFilter("c")}`);

  const trend = await all(sql`
    select DATE_FORMAT(CONVERT_TZ(f.delivered_at, '+00:00', ${tz}), '%Y-%m-%d') as day,
      CAST(coalesce(sum(f.gmv_paise), 0) AS SIGNED) as gmv, CAST(count(*) AS SIGNED) as orders
    from order_financials f
    where f.delivered_at >= ${start} and f.delivered_at < ${end} ${shopFilter("f")}
    group by 1 order by 1`);

  let riders: MarketplaceKpis["riders"] = null;
  let shopRetention: MarketplaceKpis["shopRetention"] = null;
  if (!shopId) {
    const offers = await one(sql`
      select CAST(count(case when d.accepted_at is not null then 1 end) AS SIGNED) as accepted,
        CAST(coalesce(sum(JSON_LENGTH(d.rejected_partner_ids)), 0) AS SIGNED) as declined
      from delivery_orders d where d.offered_at >= ${start} and d.offered_at < ${end}`);
    // An open session ends at last heartbeat + idle cap; rows count only if that effective end falls inside the window.
    // The CROSS JOIN LATERAL existed only to name this one expression, which
    // MariaDB cannot do, so it is inlined at both places it was referenced.
    //
    // `greatest(p.last_location_at, ...)` also needed a coalesce: Postgres
    // ignores NULL arguments to GREATEST/LEAST and returns the largest
    // non-NULL, while MySQL returns NULL if any argument is NULL — which here
    // would have silently dropped every rider who has never sent a location.
    const sessionEnd = sql`least(
          coalesce(s.ended_at, least(now(), greatest(coalesce(p.last_location_at, s.started_at), s.started_at) + interval ${RIDER_IDLE_CAP_MINUTES} minute)),
          ${end}
        )`;
    const windowStart = sql`greatest(s.started_at, ${start})`;
    const online = await one(sql`
      select coalesce(sum(greatest(0, TIMESTAMPDIFF(SECOND, ${windowStart}, ${sessionEnd}))), 0) / 3600.0 as hours
      from delivery_partner_sessions s
      join delivery_partners p on p.id = s.delivery_partner_id
      where s.started_at < ${end} and ${sessionEnd} > ${windowStart}`);
    const busy = await one(sql`
      select coalesce(sum(TIMESTAMPDIFF(
        SECOND,
        greatest(d.accepted_at, ${start}),
        least(coalesce(d.delivered_at, d.failed_at, d.cancelled_at, now()), ${end}))), 0) / 3600.0 as hours
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
      utilisation:
        onlineHours > 0
          ? Math.min(1, Math.round((busyHours / onlineHours) * 1000) / 1000)
          : null,
    };

    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
    const prevStart = sql`CONVERT_TZ(CAST(${addDays(from, -days)} AS DATETIME), ${tz}, '+00:00')`;
    const retention = await one(sql`
      with prev as (select distinct shop_id from order_financials where delivered_at >= ${prevStart} and delivered_at < ${start}),
           cur as (select distinct shop_id from order_financials where delivered_at >= ${start} and delivered_at < ${end})
      select CAST((select count(*) from prev) AS SIGNED) as previous_active,
             CAST((select count(*) from prev join cur using (shop_id)) AS SIGNED) as retained`);
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
    onTime: {
      promised: n(onTime.promised),
      onTime: n(onTime.on_time),
      rate: ratio(n(onTime.on_time), n(onTime.promised)),
    },
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
    gmvTrend: trend.map((t) => ({
      day: String(t.day),
      gmvPaise: n(t.gmv),
      orders: n(t.orders),
    })),
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
      .innerJoin(
        deliveryPartners,
        eq(deliveryPartners.id, deliveryOrders.deliveryPartnerId),
      )
      .where(
        and(
          onlineRider,
          inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES),
        ),
      ),
  ]);
  const byStatus = new Map<OrderStatus, number>(
    statusRows.map((r) => [r.status, r.count]),
  );
  return {
    inFlight: IN_FLIGHT_ORDER_STATUSES.map((status) => ({
      status,
      count: byStatus.get(status) ?? 0,
    })),
    ridersOnline: onlineRows[0]?.value ?? 0,
    ridersBusy: busyRows[0]?.value ?? 0,
  };
}
