/**
 * Available Deliveries — the rider job board (Rider App v2, rule riderJobBoard, OFF by default).
 *
 * An online, verified rider browses open jobs near them and picks one. A job is an order waiting
 * for a rider that is not held by anyone right now:
 *   - an OPEN broadcast offer (rule dispatchBroadcast) — accepting goes through the broadcast's own
 *     lock (acceptBroadcastOffer), so the board and the broadcast never both win;
 *   - a READY order whose single offer was turned down or lapsed and is not being broadcast —
 *     accepting is ONE conditional UPDATE of the delivery row (REJECTED/CANCELLED → OFFERED to this
 *     rider), then the existing accept. Of two riders pressing Accept at once exactly one matches;
 *     the other gets "Taken".
 * Only jobs within the rider's operating radius (capped by maxRadiusKm), allowed by the society and
 * not declined by this rider are listed, nearest shop first. The rider sees what THEY earn and the
 * cash to collect on COD — never the customer's delivery fee, the order total, commission, shop
 * charges or anyone else's pay (tests/unit/rider-privacy.test.ts).
 */
import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { db } from "@/server/db";
import {
  deliveryOfferBroadcasts,
  deliveryOfferRecipients,
  deliveryOrders,
  deliveryPartners,
  orderItems,
  orders,
  shops,
  type DeliveryOrder,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { acceptOfferInTransaction } from "./delivery-assignment";
import { previewEarning } from "./delivery-earnings";
import { blockedPartnerIds, countActiveAssignments } from "./delivery-eligibility";
import { acceptBroadcastOffer, declineBroadcastOffer, effectiveRadiiKm } from "./dispatch-broadcast";
import { loadQuoteKit, payPlansEnabled, quoteWithKit } from "./rider-pay-plans";
import { getRule } from "./settings";
import { getSocietyDispatchRules } from "./societies";

export const PASS_REASONS = ["TOO_FAR", "VEHICLE_ISSUE", "ENDING_SHIFT", "OTHER"] as const;
export type PassReason = (typeof PASS_REASONS)[number];

/** The pay lines a rider may see for their own job. */
export interface RiderPayBreakdown {
  basePaise: number;
  distancePaise: number;
  firstMilePaise: number;
  surgePaise: number;
  bonusPaise: number;
  minTopUpPaise: number;
}

export interface RiderJob {
  /** "b:<broadcastId>" or "d:<deliveryOrderId>". */
  jobId: string;
  orderNumber: string;
  shopName: string;
  shopArea: string;
  /** Rider → shop, km (straight line from the rider's last position). */
  pickupKm: number | null;
  /** Shop → customer, km. */
  deliveryKm: number | null;
  totalKm: number | null;
  etaMinutes: number | null;
  itemsCount: number;
  cod: boolean;
  /** Cash to collect at the door (COD only). */
  cashToCollectPaise: number | null;
  surgeTags: string[];
  /** What this rider earns (the quote locked on accept when pay plans are on). */
  earnPaise: number | null;
  breakdown: RiderPayBreakdown | null;
  /** When an open broadcast stops; null = open until someone takes it. */
  expiresAt: string | null;
  readySince: string | null;
}

export interface JobBoard {
  enabled: boolean;
  /** Why the list is empty for this rider (offline, not verified …), or null. */
  blockedReason: "OFF" | "NOT_RIDER" | "NOT_VERIFIED" | "OFFLINE" | "NO_LOCATION" | null;
  pollSeconds: number;
  jobs: RiderJob[];
}

const AVERAGE_SPEED_KMH = 20;
const round1 = (n: number) => Math.round(n * 10) / 10;

async function loadRider(userId: string) {
  return db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
}

export async function listOpenJobs(userId: string, now: Date = new Date()): Promise<JobBoard> {
  const rule = await getRule("riderJobBoard");
  const base = { enabled: rule.enabled, pollSeconds: rule.pollSeconds, jobs: [] as RiderJob[] };
  if (!rule.enabled) return { ...base, blockedReason: "OFF" };
  const rider = await loadRider(userId);
  if (!rider || rider.deletedAt) return { ...base, blockedReason: "NOT_RIDER" };
  if (rider.status !== "APPROVED") return { ...base, blockedReason: "NOT_VERIFIED" };
  if (!rider.isOnline || rider.availability === "OFFLINE") return { ...base, blockedReason: "OFFLINE" };
  const riderPoint = parseCoordinates(rider.lastLocationLatitude, rider.lastLocationLongitude);
  if (!riderPoint) return { ...base, blockedReason: "NO_LOCATION" };
  const radiusKm = Math.min(rider.operatingRadiusKm, rule.maxRadiusKm);

  // Orders waiting for a rider: an open broadcast, or a delivery row nobody holds (turned down / lapsed).
  const openBroadcast = and(eq(deliveryOfferBroadcasts.orderId, orders.id), eq(deliveryOfferBroadcasts.status, "OPEN"));
  const rows = await db
    .select({
      delivery: deliveryOrders,
      orderNumber: orders.orderNumber,
      subtotalPaise: orders.subtotalPaise,
      totalPaise: orders.totalPaise,
      paymentMethod: orders.paymentMethod,
      societyId: orders.societyId,
      updatedAt: orders.updatedAt,
      shopName: shops.name,
      shopArea: shops.addressLine2,
      shopCity: shops.city,
      shopLat: shops.latitude,
      shopLng: shops.longitude,
      broadcastId: deliveryOfferBroadcasts.id,
      broadcastStep: deliveryOfferBroadcasts.step,
      broadcastNextStepAt: deliveryOfferBroadcasts.nextStepAt,
    })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .leftJoin(deliveryOfferBroadcasts, openBroadcast)
    .where(
      and(
        eq(orders.status, "READY"),
        inArray(deliveryOrders.status, ["REJECTED", "CANCELLED"]),
        isNull(deliveryOrders.tripId),
        sql`NOT (${rider.id}::uuid = ANY(${deliveryOrders.rejectedPartnerIds}))`,
        // A rider who declined the broadcast is not shown it again.
        notExists(
          db
            .select({ one: sql`1` })
            .from(deliveryOfferRecipients)
            .where(
              and(
                eq(deliveryOfferRecipients.deliveryOrderId, deliveryOrders.id),
                eq(deliveryOfferRecipients.deliveryPartnerId, rider.id),
                eq(deliveryOfferRecipients.outcome, "DECLINED"),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(orders.updatedAt))
    .limit(500);

  // Distance filter first (cheap), then society rules for the few left.
  const near = rows
    .map((r) => {
      const shopPoint = parseCoordinates(r.shopLat, r.shopLng);
      return { r, shopPoint, pickupKm: shopPoint ? haversineDistanceKm(riderPoint, shopPoint) : null };
    })
    .filter((x) => x.pickupKm != null && x.pickupKm <= radiusKm)
    .sort((a, b) => (a.pickupKm ?? 0) - (b.pickupKm ?? 0));

  const societyIds = [...new Set(near.map((x) => x.r.societyId).filter((id): id is string => Boolean(id)))];
  const societyOk = new Map<string, boolean>();
  for (const id of societyIds) {
    const [blocked, rules] = await Promise.all([blockedPartnerIds(id), getSocietyDispatchRules(id)]);
    societyOk.set(id, !blocked.has(rider.id) && (!rules?.exclusive || rules.riders.has(rider.id)));
  }
  const allowed = near.filter((x) => !x.r.societyId || societyOk.get(x.r.societyId) !== false).slice(0, rule.maxJobs);
  if (allowed.length === 0) return { ...base, blockedReason: null };

  const itemCounts = new Map(
    (
      await db
        .select({ orderId: orderItems.orderId, n: sql<number>`count(*)::int` })
        .from(orderItems)
        .where(inArray(orderItems.orderId, allowed.map((x) => x.r.delivery.orderId)))
        .groupBy(orderItems.orderId)
    ).map((r) => [r.orderId, r.n]),
  );

  const plansOn = await payPlansEnabled();
  const kit = plansOn ? await loadQuoteKit(now) : null;
  const broadcastRule = await getRule("dispatchBroadcast");
  const radii = effectiveRadiiKm(broadcastRule);

  const jobs: RiderJob[] = [];
  for (const { r, shopPoint, pickupKm } of allowed) {
    const legKmRaw = r.delivery.distanceKm != null ? Number(r.delivery.distanceKm) : null;
    const legKm = legKmRaw != null && Number.isFinite(legKmRaw) ? legKmRaw : null;
    let earnPaise: number | null = null;
    let breakdown: RiderPayBreakdown | null = null;
    let surgeTags: string[] = [];
    if (kit) {
      const ctx = quoteWithKit(kit, { shop: { city: r.shopCity, point: shopPoint }, legKm, riderPoint });
      if (ctx) {
        const q = ctx.quote;
        earnPaise = q.quotePaise;
        surgeTags = q.surgeLabels;
        breakdown = {
          basePaise: q.basePaise,
          distancePaise: q.lastMilePaise + q.extraDropPaise - q.capCutPaise,
          firstMilePaise: q.firstMilePaise,
          surgePaise: q.surgePaise,
          bonusPaise: q.longDistancePaise,
          minTopUpPaise: q.minTopUpPaise + q.roundingPaise,
        };
      }
    } else if (legKm != null) {
      earnPaise = await previewEarning({ distanceKm: legKm, orderSubtotalPaise: r.subtotalPaise, at: now })
        .then((e) => e.totalPaise)
        .catch(() => null);
    }
    const totalKm = pickupKm != null && legKm != null ? round1(pickupKm + legKm) : null;
    const stepsLeft = r.broadcastId ? Math.max(0, radii.length - 1 - (r.broadcastStep ?? 0)) : 0;
    const expires =
      r.broadcastId && r.broadcastNextStepAt ? new Date(r.broadcastNextStepAt.getTime() + stepsLeft * broadcastRule.stepSeconds * 1000) : null;
    jobs.push({
      jobId: r.broadcastId ? `b:${r.broadcastId}` : `d:${r.delivery.id}`,
      orderNumber: r.orderNumber,
      shopName: r.shopName,
      shopArea: [r.shopArea, r.shopCity].filter(Boolean).join(", "),
      pickupKm: pickupKm != null ? round1(pickupKm) : null,
      deliveryKm: legKm != null ? round1(legKm) : null,
      totalKm,
      etaMinutes: totalKm != null ? Math.max(5, Math.round((totalKm / AVERAGE_SPEED_KMH) * 60)) : null,
      itemsCount: itemCounts.get(r.delivery.orderId) ?? 0,
      cod: r.paymentMethod === "COD",
      cashToCollectPaise: r.paymentMethod === "COD" ? r.totalPaise : null,
      surgeTags,
      earnPaise,
      breakdown,
      expiresAt: expires ? expires.toISOString() : null,
      readySince: r.updatedAt.toISOString(),
    });
  }
  return { ...base, blockedReason: null, jobs };
}

function parseJobId(jobId: string): { kind: "b" | "d"; id: string } {
  const m = /^([bd]):([0-9a-f-]{36})$/i.exec(jobId);
  if (!m) throw validationFailed("Unknown job.");
  return { kind: m[1].toLowerCase() as "b" | "d", id: m[2] };
}

const takenError = () => conflict("Taken — another rider accepted this job first.", { reason: "OFFER_TAKEN" });

/** First rider to accept wins. Returns the accepted delivery (with its locked quote when pay plans are on). */
export async function acceptJob(userId: string, jobId: string): Promise<DeliveryOrder> {
  const rule = await getRule("riderJobBoard");
  if (!rule.enabled) throw forbidden("The Available Deliveries list is switched off.");
  const rider = await loadRider(userId);
  if (!rider || rider.deletedAt || rider.status !== "APPROVED") throw forbidden("Only an approved delivery partner can take jobs.");
  if (!rider.isOnline || rider.availability === "OFFLINE") throw conflict("Go online to take a job.");
  const job = parseJobId(jobId);

  let accepted: DeliveryOrder;
  if (job.kind === "b") {
    const broadcast = await db.query.deliveryOfferBroadcasts.findFirst({ where: eq(deliveryOfferBroadcasts.id, job.id) });
    if (!broadcast) throw notFound("Job");
    if (broadcast.status !== "OPEN") throw takenError();
    // The rider picked it from the board: they join the broadcast's recipients, then its own lock decides.
    await db
      .insert(deliveryOfferRecipients)
      .values({
        broadcastId: broadcast.id,
        orderId: broadcast.orderId,
        deliveryOrderId: broadcast.deliveryOrderId,
        deliveryPartnerId: rider.id,
        radiusStep: broadcast.step,
        offeredAt: new Date(),
      })
      .onConflictDoNothing();
    accepted = await acceptBroadcastOffer(broadcast.id, userId);
  } else {
    const dispatch = await getRule("dispatch");
    const cap = dispatch.busyRidersAsFallback ? dispatch.maxActiveDeliveriesPerRider : 1;
    accepted = await db.transaction(async (tx) => {
      const now = new Date();
      await tx.select({ id: deliveryPartners.id }).from(deliveryPartners).where(eq(deliveryPartners.id, rider.id)).for("update");
      if ((await countActiveAssignments(rider.id, tx)) >= cap) throw conflict("Finish your current delivery before taking another one.");
      // THE lock: only a row nobody holds, for an order still waiting and not being broadcast.
      const [offer] = await tx
        .update(deliveryOrders)
        .set({
          status: "OFFERED",
          deliveryPartnerId: rider.id,
          offeredAt: now,
          acceptedAt: null,
          cancelledAt: null,
          cancellationReason: null,
          pickupDurationSeconds: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(deliveryOrders.id, job.id),
            inArray(deliveryOrders.status, ["REJECTED", "CANCELLED"]),
            isNull(deliveryOrders.tripId),
            sql`NOT (${rider.id}::uuid = ANY(${deliveryOrders.rejectedPartnerIds}))`,
            sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${deliveryOrders.orderId} AND ${orders.status} = 'READY')`,
            sql`NOT EXISTS (SELECT 1 FROM ${deliveryOfferBroadcasts} b WHERE b.order_id = ${deliveryOrders.orderId} AND b.status = 'OPEN')`,
          ),
        )
        .returning();
      if (!offer) throw takenError();
      return acceptOfferInTransaction(tx, offer, userId, null);
    });
  }

  await recordAudit({
    actorId: userId,
    actorRole: "DELIVERY_PARTNER",
    action: AUDIT_ACTIONS.RIDER_JOB_ACCEPTED,
    entityType: "delivery_order",
    entityId: accepted.id,
    newValue: { jobId, quotePaise: accepted.quotePaise ?? null },
  });
  return accepted;
}

/** The rider passes on a job with a reason; it is not shown to them again (feeds the declined-rider list). */
export async function passJob(userId: string, jobId: string, reason: PassReason, note?: string | null): Promise<void> {
  if (!PASS_REASONS.includes(reason)) throw validationFailed("Pick a reason.");
  const rider = await loadRider(userId);
  if (!rider || rider.deletedAt) throw forbidden("Only a delivery partner can pass on jobs.");
  const job = parseJobId(jobId);
  let deliveryOrderId: string;
  if (job.kind === "b") {
    const broadcast = await db.query.deliveryOfferBroadcasts.findFirst({ where: eq(deliveryOfferBroadcasts.id, job.id) });
    if (!broadcast) throw notFound("Job");
    deliveryOrderId = broadcast.deliveryOrderId;
    await db
      .insert(deliveryOfferRecipients)
      .values({
        broadcastId: broadcast.id,
        orderId: broadcast.orderId,
        deliveryOrderId: broadcast.deliveryOrderId,
        deliveryPartnerId: rider.id,
        radiusStep: broadcast.step,
        offeredAt: new Date(),
      })
      .onConflictDoNothing();
    await declineBroadcastOffer(broadcast.id, userId);
  } else {
    deliveryOrderId = job.id;
    await db
      .update(deliveryOrders)
      .set({ rejectedPartnerIds: sql`array_append(${deliveryOrders.rejectedPartnerIds}, ${rider.id}::uuid)` })
      .where(and(eq(deliveryOrders.id, job.id), sql`NOT (${rider.id}::uuid = ANY(${deliveryOrders.rejectedPartnerIds}))`));
  }
  await recordAudit({
    actorId: userId,
    actorRole: "DELIVERY_PARTNER",
    action: AUDIT_ACTIONS.RIDER_JOB_PASSED,
    entityType: "delivery_order",
    entityId: deliveryOrderId,
    newValue: { jobId, reason, note: note?.trim() || null },
  });
}

/** "You earn ₹X" for the rider's own single offer (G1): the quote they would lock by accepting. */
export async function quoteForOwnOffer(
  delivery: Pick<DeliveryOrder, "orderId" | "distanceKm" | "quotePaise" | "quoteBreakdown" | "deliveryPartnerId">,
  orderSubtotalPaise: number,
): Promise<{ earnPaise: number | null; breakdown: RiderPayBreakdown | null; locked: boolean }> {
  if (delivery.quotePaise != null && delivery.quoteBreakdown) {
    const q = delivery.quoteBreakdown;
    return { earnPaise: delivery.quotePaise, breakdown: toRiderBreakdown(q), locked: true };
  }
  if (await payPlansEnabled()) {
    const [rider] = await db
      .select({ lat: deliveryPartners.lastLocationLatitude, lng: deliveryPartners.lastLocationLongitude })
      .from(deliveryPartners)
      .where(eq(deliveryPartners.id, delivery.deliveryPartnerId));
    const [row] = await db
      .select({ city: shops.city, latitude: shops.latitude, longitude: shops.longitude })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(eq(orders.id, delivery.orderId));
    if (row) {
      const kit = await loadQuoteKit();
      const legKm = delivery.distanceKm != null ? Number(delivery.distanceKm) : null;
      const ctx = quoteWithKit(kit, {
        shop: { city: row.city, point: parseCoordinates(row.latitude, row.longitude) },
        legKm: legKm != null && Number.isFinite(legKm) ? legKm : null,
        riderPoint: parseCoordinates(rider?.lat ?? null, rider?.lng ?? null),
      });
      if (ctx) return { earnPaise: ctx.quote.quotePaise, breakdown: toRiderBreakdown(ctx.quote), locked: false };
    }
  }
  const legKm = delivery.distanceKm != null ? Number(delivery.distanceKm) : NaN;
  if (!Number.isFinite(legKm)) return { earnPaise: null, breakdown: null, locked: false };
  const preview = await previewEarning({ distanceKm: legKm, orderSubtotalPaise, at: new Date() }).catch(() => null);
  return { earnPaise: preview?.totalPaise ?? null, breakdown: null, locked: false };
}

function toRiderBreakdown(q: import("@/lib/rider-pay-plan").PayQuote): RiderPayBreakdown {
  return {
    basePaise: q.basePaise,
    distancePaise: q.lastMilePaise + q.extraDropPaise - q.capCutPaise,
    firstMilePaise: q.firstMilePaise,
    surgePaise: q.surgePaise,
    bonusPaise: q.longDistancePaise,
    minTopUpPaise: q.minTopUpPaise + q.roundingPaise,
  };
}
