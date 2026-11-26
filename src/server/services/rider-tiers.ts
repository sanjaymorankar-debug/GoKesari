/**
 * Rider tier badge (Rider App v2, rule riderTiers — OFF by default). Worked out on read, no cron.
 *
 * Metrics over the last 7 days (rolling, from `now`):
 *  - deliveries: delivery_orders DELIVERED with deliveredAt in the period;
 *  - rating: delivery_partners.ratingAvgX100 (the all-time visible average);
 *  - acceptance %: accepted / (accepted + turned down). Each delivery counts once per rider:
 *      accepted   = deliveries this rider accepted in the period (delivery_orders.acceptedAt) plus
 *                   broadcast offers they won (delivery_offer_recipients outcome ACCEPTED);
 *      turned down = deliveries created in the period whose rejected_partner_ids holds the rider
 *                   (declined or let a single offer lapse) plus broadcast offers they DECLINED or
 *                   let EXPIRE — minus any delivery they accepted after all.
 *    A broadcast another rider took first (TAKEN_BY_OTHER) does not count against anyone.
 *  - on-time %: DELIVERED at or before orders.promised_by_at; orders without a promise are left out.
 * No offers / no promised orders in the period = nothing missed (counts as 100 %, shown as "—").
 */
import { and, count, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

import { pct, pickTier, type TierMetrics, type TierNeed, type TierRule } from "@/lib/rider-growth";
import { db } from "@/server/db";
import { deliveryOfferRecipients, deliveryOrders, deliveryPartners, orders } from "@/server/db/schema";
import { getRule } from "./settings";

const PERIOD_DAYS = 7;

export interface RiderTierView {
  enabled: boolean;
  tier: { name: string; extraIncentivePct: number; priority: boolean } | null;
  metrics: TierMetrics & { periodDays: number };
  next: { name: string; needs: TierNeed[] } | null;
  /** Every tier, lowest first, so the page can show the ladder. */
  tiers: TierRule[];
}

/** Last-7-day metrics for many riders at once (a few grouped queries, whatever the count). */
export async function tierMetricsFor(partnerIds: readonly string[], now: Date = new Date()): Promise<Map<string, TierMetrics>> {
  const ids = [...new Set(partnerIds)];
  const out = new Map<string, TierMetrics>();
  if (ids.length === 0) return out;
  const since = new Date(now.getTime() - PERIOD_DAYS * 86_400_000);
  const idArray = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

  const [ratings, delivered, accepted, wonBroadcast, rejected, missedBroadcast] = await Promise.all([
    db
      .select({ id: deliveryPartners.id, ratingX100: deliveryPartners.ratingAvgX100, ratingCount: deliveryPartners.ratingCount })
      .from(deliveryPartners)
      .where(inArray(deliveryPartners.id, ids)),
    db
      .select({
        id: deliveryOrders.deliveryPartnerId,
        n: count(),
        promised: sql<number>`count(*) filter (where ${orders.promisedByAt} is not null)`,
        onTime: sql<number>`count(*) filter (where ${orders.promisedByAt} is not null and ${deliveryOrders.deliveredAt} <= ${orders.promisedByAt})`,
      })
      .from(deliveryOrders)
      .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
      .where(
        and(
          inArray(deliveryOrders.deliveryPartnerId, ids),
          eq(deliveryOrders.status, "DELIVERED"),
          gte(deliveryOrders.deliveredAt, since),
        ),
      )
      .groupBy(deliveryOrders.deliveryPartnerId),
    db
      .select({ id: deliveryOrders.deliveryPartnerId, deliveryOrderId: deliveryOrders.id })
      .from(deliveryOrders)
      .where(and(inArray(deliveryOrders.deliveryPartnerId, ids), isNotNull(deliveryOrders.acceptedAt), gte(deliveryOrders.acceptedAt, since))),
    db
      .select({ id: deliveryOfferRecipients.deliveryPartnerId, deliveryOrderId: deliveryOfferRecipients.deliveryOrderId })
      .from(deliveryOfferRecipients)
      .where(
        and(
          inArray(deliveryOfferRecipients.deliveryPartnerId, ids),
          eq(deliveryOfferRecipients.outcome, "ACCEPTED"),
          gte(deliveryOfferRecipients.offeredAt, since),
        ),
      ),
    db.execute(sql`
      SELECT p.id::text AS id, d.id::text AS delivery_order_id
      FROM ${deliveryOrders} d, unnest(d.rejected_partner_ids) AS p(id)
      WHERE d.rejected_partner_ids && ${idArray} AND p.id = ANY(${idArray}) AND d.created_at >= ${since.toISOString()}
    `),
    db
      .select({ id: deliveryOfferRecipients.deliveryPartnerId, deliveryOrderId: deliveryOfferRecipients.deliveryOrderId })
      .from(deliveryOfferRecipients)
      .where(
        and(
          inArray(deliveryOfferRecipients.deliveryPartnerId, ids),
          inArray(deliveryOfferRecipients.outcome, ["DECLINED", "EXPIRED"]),
          gte(deliveryOfferRecipients.offeredAt, since),
        ),
      ),
  ]);

  const rejectedRows = [...(rejected as unknown as Iterable<{ id: string; delivery_order_id: string }>)];
  const acceptedBy = new Map<string, Set<string>>();
  const missedBy = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, id: string, deliveryOrderId: string) => {
    const set = map.get(id) ?? new Set<string>();
    set.add(deliveryOrderId);
    map.set(id, set);
  };
  for (const r of [...accepted, ...wonBroadcast]) add(acceptedBy, r.id, r.deliveryOrderId);
  for (const r of missedBroadcast) add(missedBy, r.id, r.deliveryOrderId);
  for (const r of rejectedRows) add(missedBy, r.id, r.delivery_order_id);

  for (const id of ids) {
    const rating = ratings.find((r) => r.id === id);
    const d = delivered.find((r) => r.id === id);
    const yes = acceptedBy.get(id) ?? new Set<string>();
    const no = [...(missedBy.get(id) ?? [])].filter((x) => !yes.has(x)).length;
    out.set(id, {
      deliveries: Number(d?.n ?? 0),
      ratingX100: rating && rating.ratingCount > 0 ? rating.ratingX100 : 0,
      ratingCount: rating?.ratingCount ?? 0,
      acceptancePct: pct(yes.size, yes.size + no),
      onTimePct: pct(Number(d?.onTime ?? 0), Number(d?.promised ?? 0)),
    });
  }
  return out;
}

export async function getRiderTier(partnerId: string, now: Date = new Date()): Promise<RiderTierView> {
  const rule = await getRule("riderTiers");
  const metrics = (await tierMetricsFor([partnerId], now)).get(partnerId)!;
  const tiers = rule.tiers as TierRule[];
  if (!rule.enabled) return { enabled: false, tier: null, metrics: { ...metrics, periodDays: PERIOD_DAYS }, next: null, tiers };
  const pick = pickTier(tiers, metrics);
  return {
    enabled: true,
    tier: pick.tier ? { name: pick.tier.name, extraIncentivePct: pick.tier.extraIncentivePct, priority: pick.tier.priority } : null,
    metrics: { ...metrics, periodDays: PERIOD_DAYS },
    next: pick.next,
    tiers,
  };
}

/**
 * For dispatch: the riders among `partnerIds` whose current tier has priority on. Empty while the
 * rule is off. One batch of queries for the whole list.
 */
export async function priorityPartnerIds(partnerIds: readonly string[], now: Date = new Date()): Promise<Set<string>> {
  const out = new Set<string>();
  if (partnerIds.length === 0) return out;
  try {
    const rule = await getRule("riderTiers");
    if (!rule.enabled) return out;
    const tiers = rule.tiers as TierRule[];
    if (!tiers.some((t) => t.priority)) return out;
    const metrics = await tierMetricsFor(partnerIds, now);
    for (const [id, m] of metrics) if (pickTier(tiers, m).tier?.priority) out.add(id);
  } catch (error) {
    // Priority is a nicety: dispatch carries on in its usual order.
    console.error("[rider-tiers] priority lookup failed", error);
  }
  return out;
}
