/**
 * Delivery assignment (delivery-system Part 58 follow-up, Slice C).
 *
 * Deliberately the simplest workable dispatch: when a shop marks an order
 * READY, offer it to the single nearest online, approved, not-already-busy
 * delivery partner within their own operating radius — ranked by Haversine
 * distance on stored coordinates, never a Google Routes/Distance Matrix
 * call (see haversine.ts). No batching, no scoring engine, no zones — those
 * are Phase 2 once real usage data exists to tune them.
 *
 * Two distinct distances matter here and are not interchangeable:
 *  - partner → shop: who's nearest, decides who gets the offer and feeds
 *    delivery-feasibility.ts's window promise.
 *  - shop → customer: the actual delivery leg, persisted as
 *    deliveryOrders.distanceKm and used by delivery-earnings.ts's distance
 *    fee. Falls back to the assignment distance only when the order has no
 *    verified customer location on file.
 */
import { randomInt } from "node:crypto";

import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { parseCoordinates } from "@/lib/geo/haversine";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  dispatchAttempts,
  orders,
  riderSearches,
  shops,
  societies,
  type DeliveryOrder,
  type DispatchAttempt,
  type RiderSearch,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { ACTIVE_ASSIGNMENT_STATUSES, countActiveAssignments, findEligiblePartnersNearShop } from "./delivery-eligibility";
import { creditDeliveryEarnings } from "./delivery-earnings";
import { updateMyLocation } from "./delivery-partners";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { updateOrderStatus } from "./orders";
import { emitEvent } from "@/server/events/emit";
import type { DeliveryEventPayload } from "@/server/events/catalog";
import { assertDeliveryProof, hasDeliveryProof, isDeliveryProofRequired } from "./delivery-proofs";
import { checkBatchCompatibility, joinTrip, loadRiderMembers, nextTripDeliveryId, toMember } from "./delivery-trips";
import { getRoute } from "./routing";
import { scheduledDispatchFrom } from "./scheduled-slots";
import { checkDeliveryCode, freshCodeFields, generateDeliveryCode, needsDeliveryCode, sendDeliveryCodeToBuyer } from "./delivery-otp";
import { getRule } from "./settings";
import { suspensionRecordFor } from "./shop-suspension-guard";
import {
  getSocietyDeliveryNotes,
  getSocietyDispatchRules,
  notifySocietySecurity,
  societyStaffUserIds,
} from "./societies";

interface Actor {
  id: string;
  role: UserRole;
}

/**
 * Who started a dispatch. `id: null` is the system (cron re-offer after an
 * expiry or rejection) — recorded in the audit log without a user.
 */
interface DispatchActor {
  id: string | null;
  role: UserRole | null;
}

/**
 * Default offer lifetime (GA-009). The live value is the `dispatch` rule's
 * `offerTtlSeconds` — read it with getOfferTtlSeconds(); this constant is only
 * the code default, kept for callers that need a value without a query.
 */
export const OFFER_TTL_SECONDS = 120;

export async function getOfferTtlSeconds(): Promise<number> {
  return (await getRule("dispatch")).offerTtlSeconds;
}

/**
 * Candidate ranking (lower score wins). Distance in km is the base; the rest
 * are small, explainable nudges so tuning later is a config change:
 *  - GA-002 society-listed / preferred riders move ahead for that society;
 *  - GA-007 reliability (0..1, completions vs failures/declines, last 30 days);
 *  - GA-008 fairness: each offer already received today costs a little.
 * GA-001 exclusivity is a filter, not a weight (see rankCandidates).
 */
export const DISPATCH_WEIGHTS = {
  societyListedKm: 1.5,
  societyPreferredKm: 1.5,
  unreliabilityKm: 2,
  perOfferTodayKm: 0.3,
} as const;

type Candidate = Awaited<ReturnType<typeof findEligiblePartnersNearShop>>[number];

/** GA-001/002/007/008: filter to a society's riders when exclusive, then score and sort. */
async function rankCandidates(
  candidates: Candidate[],
  rules: Awaited<ReturnType<typeof getSocietyDispatchRules>>,
  client: DbClient,
  /** GA-005: busy riders whose trip this order fits, and how much nearer that makes them. */
  batch: { compatible: Set<string>; preferenceKm: number } = { compatible: new Set(), preferenceKm: 0 },
): Promise<Candidate[]> {
  const pool = rules?.exclusive ? candidates.filter((c) => rules.riders.has(c.partner.id)) : candidates;
  if (pool.length <= 1) return pool;

  const ids = pool.map((c) => c.partner.id);
  const stats = await client
    .select({
      partnerId: deliveryPartners.id,
      delivered: sql<number>`(select count(*)::int from ${deliveryOrders} d where d.delivery_partner_id = ${deliveryPartners.id}
        and d.status = 'DELIVERED' and d.updated_at > now() - interval '30 days')`,
      failed: sql<number>`(select count(*)::int from ${deliveryOrders} d where d.delivery_partner_id = ${deliveryPartners.id}
        and d.status = 'FAILED' and d.updated_at > now() - interval '30 days')`,
      declined: sql<number>`(select count(*)::int from ${deliveryOrders} d where ${deliveryPartners.id} = any(d.rejected_partner_ids)
        and d.updated_at > now() - interval '30 days')`,
      offersToday: sql<number>`(select count(*)::int from ${deliveryOrders} d where (d.delivery_partner_id = ${deliveryPartners.id}
        or ${deliveryPartners.id} = any(d.rejected_partner_ids)) and d.offered_at > date_trunc('day', now()))`,
    })
    .from(deliveryPartners)
    .where(inArray(deliveryPartners.id, ids));
  const byId = new Map(stats.map((row) => [row.partnerId, row]));

  const score = (c: Candidate) => {
    const st = byId.get(c.partner.id);
    // Laplace-smoothed so a new rider starts near 1, not 0.
    const reliability = st ? (st.delivered + 1) / (st.delivered + st.failed + st.declined + 1) : 1;
    const listed = rules?.riders.has(c.partner.id) ?? false;
    const preferred = rules?.riders.get(c.partner.id) ?? false;
    return (
      c.distanceToShopKm -
      (listed ? DISPATCH_WEIGHTS.societyListedKm : 0) -
      (preferred ? DISPATCH_WEIGHTS.societyPreferredKm : 0) +
      (1 - Math.min(reliability, 1)) * DISPATCH_WEIGHTS.unreliabilityKm +
      (st?.offersToday ?? 0) * DISPATCH_WEIGHTS.perOfferTodayKm
    );
  };
  // F3: a free rider always ranks ahead of a busy one; score orders within each group.
  // GA-005: a busy rider on a trip this order fits counts as free, and is
  // preferred over a free rider up to batch.preferenceKm further away.
  const busy = (c: Candidate) => c.activeCount > 0 && !batch.compatible.has(c.partner.id);
  const batchScore = (c: Candidate) => score(c) - (batch.compatible.has(c.partner.id) ? batch.preferenceKm : 0);
  return [...pool].sort((a, b) => Number(busy(a)) - Number(busy(b)) || batchScore(a) - batchScore(b));
}

/** 4-digit code; crypto-random so it cannot be predicted from timing. */
function fourDigitCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}

export { ACTIVE_ASSIGNMENT_STATUSES, findEligiblePartnersNearShop };

/**
 * Assigns the nearest eligible partner to a READY order. Throws (rather than
 * leaving the order silently unassigned) when nobody is available, so the
 * calling UI can surface "no rider available — retry" per the brief's
 * failsafe requirement (§21) instead of an order stranding without anyone
 * noticing.
 *
 * DEF-03 fix: the whole read-candidates-then-write-offer sequence runs
 * inside one transaction, and each candidate partner's own row is locked
 * (`FOR UPDATE`) before trusting their busy status. Two orders racing for
 * the same nearest idle partner now serialize on that partner's lock —
 * whichever transaction commits first wins the partner, and the second sees
 * the fresh OFFERED row and moves on to its next-nearest candidate — instead
 * of both reading "idle" and both succeeding.
 */
export async function assignNearestPartner(orderId: string, actor: DispatchActor): Promise<DeliveryOrder> {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) throw notFound("Order");
  if (order.status !== "READY") {
    throw conflict("Only an order marked READY can be assigned to a delivery partner.");
  }

  const shop = await db.query.shops.findFirst({ where: eq(shops.id, order.shopId) });
  if (!shop) throw notFound("Shop");
  const shopCoords = parseCoordinates(shop.latitude, shop.longitude);
  if (!shopCoords) throw conflict("This shop has no verified location on file yet.");

  const customerCoords = parseCoordinates(
    order.deliveryAddressSnapshot?.latitude ?? null,
    order.deliveryAddressSnapshot?.longitude ?? null,
  );

  // F4: shop → customer road route, fetched before the transaction so no
  // network call happens while rows are locked. Straight-line when routing is
  // off or fails — the same distance as before.
  const legRoute = customerCoords
    ? await getRoute(shopCoords, customerCoords, { purpose: "delivery_leg", entityType: "order", entityId: orderId })
    : null;

  const offered = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(deliveryOrders)
      .where(eq(deliveryOrders.orderId, orderId))
      .for("update");
    if (existing && (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(existing.status)) {
      throw conflict("This order already has an active delivery assignment.");
    }

    // Nearest-first candidate list, re-evaluated fresh inside the
    // transaction (not carried over from an earlier read) so it reflects
    // whatever earlier concurrent assignments have already committed.
    // F3: with busyRidersAsFallback on, busy riders stay in, ranked last.
    const dispatchRule = await getRule("dispatch");
    const busyCap = dispatchRule.busyRidersAsFallback ? dispatchRule.maxActiveDeliveriesPerRider : 0;
    // GA-005: with batching on, riders with room on a trip are looked at too.
    const batching = await getRule("batching");
    const batchCap = batching.enabled ? batching.maxOrdersPerTrip : 0;
    const includeBusyUpTo = Math.max(busyCap, batchCap);
    const eligible = await findEligiblePartnersNearShop(shopCoords, tx, includeBusyUpTo ? { includeBusyUpTo } : {});
    const newMember = batchCap ? toMember("new", "OFFERED", order, shop) : null;
    const compatible = new Set<string>();
    if (newMember) {
      for (const c of eligible) {
        if (c.activeCount === 0) continue;
        const members = await loadRiderMembers(c.partner.id, tx);
        const start = parseCoordinates(c.partner.lastLocationLatitude, c.partner.lastLocationLongitude);
        if (checkBatchCompatibility(members, newMember, batching, { start, now: new Date() }).ok) compatible.add(c.partner.id);
      }
    }
    // A busy rider stays a candidate only for a trip this order fits, or as the F3 fallback.
    const pool = eligible.filter(
      (c) => c.activeCount === 0 || compatible.has(c.partner.id) || (busyCap > 0 && c.activeCount < busyCap),
    );
    const candidates = await rankCandidates(pool, await getSocietyDispatchRules(order.societyId, tx), tx, {
      compatible,
      preferenceKm: batching.batchPreferenceKm,
    });
    // GA-009 fallback: a rider who declined this order, or let the offer
    // expire, is never offered it again.
    const declined = new Set(existing?.rejectedPartnerIds ?? []);

    for (const candidate of candidates) {
      if (declined.has(candidate.partner.id)) continue;
      // Lock the PARTNER's own row — it always exists (created at
      // registration), unlike a not-yet-busy partner's deliveryOrders row,
      // which may not exist yet to lock. A concurrent assignment attempt for
      // this same partner blocks here until the first one commits or
      // rolls back.
      const [lockedPartner] = await tx
        .select({ id: deliveryPartners.id })
        .from(deliveryPartners)
        .where(eq(deliveryPartners.id, candidate.partner.id))
        .for("update");
      if (!lockedPartner) continue;

      // GA-005: re-check the trip fit under the rider's lock with fresh data.
      let tripMembers: Awaited<ReturnType<typeof loadRiderMembers>> | null = null;
      if (compatible.has(candidate.partner.id) && newMember) {
        tripMembers = await loadRiderMembers(candidate.partner.id, tx);
        const start = parseCoordinates(candidate.partner.lastLocationLatitude, candidate.partner.lastLocationLongitude);
        if (!checkBatchCompatibility(tripMembers, newMember, batching, { start, now: new Date() }).ok) continue;
      } else if (busyCap) {
        // F3: re-count under the partner lock; a race may have filled them up.
        if ((await countActiveAssignments(candidate.partner.id, tx)) >= busyCap) continue;
      } else {
        const stillBusy = await tx.query.deliveryOrders.findFirst({
          where: and(
            eq(deliveryOrders.deliveryPartnerId, candidate.partner.id),
            inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES),
          ),
        });
        if (stillBusy) continue; // lost the race for this partner — try the next nearest
      }

      const legDistanceKm = legRoute ? legRoute.distanceKm : candidate.distanceToShopKm;

      const values = {
        deliveryPartnerId: candidate.partner.id,
        status: "OFFERED" as const,
        distanceKm: String(legDistanceKm),
        offeredAt: new Date(),
        acceptedAt: null,
        pickedUpAt: null,
        deliveredAt: null,
        cancelledAt: null,
        cancellationReason: null,
        updatedAt: new Date(),
        routeSource: legRoute?.source ?? null,
        legDurationSeconds: legRoute ? Math.round(legRoute.durationSeconds) : null,
        pickupDurationSeconds: null,
        // GA-005: a re-offer starts outside any earlier rider's trip.
        tripId: null,
      };

      let [deliveryOrder] = existing
        ? await tx
            .update(deliveryOrders)
            .set(values)
            .where(eq(deliveryOrders.id, existing.id))
            .returning()
        : await tx
            .insert(deliveryOrders)
            .values({ orderId, ...values })
            .returning();
      if (tripMembers) {
        const tripId = await joinTrip(tx, candidate.partner.id, deliveryOrder.id, tripMembers);
        deliveryOrder = { ...deliveryOrder, tripId };
      }

      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.DELIVERY_ORDER_OFFERED,
          entityType: "delivery_order",
          entityId: deliveryOrder.id,
          newValue: {
            orderId,
            deliveryPartnerId: candidate.partner.id,
            distanceKm: legDistanceKm,
            ...(deliveryOrder.tripId ? { tripId: deliveryOrder.tripId, batched: true } : {}),
          },
        },
        tx,
      );

      // Event layer: the rider gets the offer; the customer and the shop hear
      // once per order that a rider is being found.
      await emitEvent(
        {
          type: "delivery.offered",
          subjectId: deliveryOrder.id,
          orderId,
          transition: { from: existing?.status ?? null, to: "OFFERED" },
          actor,
          payload: {
            orderId,
            orderNumber: order.orderNumber,
            buyerId: order.userId,
            shopOwnerId: shop.ownerId,
            riderUserId: candidate.partner.userId,
            distanceKm: legDistanceKm,
            batched: Boolean(deliveryOrder.tripId),
          },
        },
        tx,
      );

      return deliveryOrder;
    }

    throw conflict(
      order.societyId
        ? "No delivery partner allowed by this society is currently available for this order."
        : "No delivery partner is currently available for this order.",
    );
  });

  // F4: rider → shop travel time for the rider's and customer's estimates.
  // Best effort, after commit; a failure here never undoes the offer.
  const rider = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, offered.deliveryPartnerId) });
  const riderCoords = rider ? parseCoordinates(rider.lastLocationLatitude, rider.lastLocationLongitude) : null;
  if (!riderCoords) return offered;
  try {
    const pickup = await getRoute(riderCoords, shopCoords, { purpose: "delivery_pickup", entityType: "order", entityId: orderId });
    const [withPickup] = await db
      .update(deliveryOrders)
      .set({ pickupDurationSeconds: Math.round(pickup.durationSeconds) })
      .where(and(eq(deliveryOrders.id, offered.id), eq(deliveryOrders.deliveryPartnerId, offered.deliveryPartnerId)))
      .returning();
    return withPickup ?? offered;
  } catch (error) {
    console.error("[dispatch] pickup estimate failed", error);
    return offered;
  }
}

/** Cancels any in-flight assignment (if present) and re-runs assignment. Admin/operator manual override. */
export async function reassignOrder(orderId: string, actor: Actor, reason?: string): Promise<DeliveryOrder> {
  const existing = await db.query.deliveryOrders.findFirst({
    where: eq(deliveryOrders.orderId, orderId),
  });
  // The goods are with the rider once picked up — reassigning then would
  // strand them; use the failed-delivery / return path instead.
  if (existing?.status === "PICKED_UP") {
    throw conflict("This order has already been picked up and cannot be reassigned.");
  }
  if (existing && existing.status === "ACCEPTED") {
    const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    if (order?.status === "ASSIGNED") {
      await updateOrderStatus(orderId, "READY", actor, reason?.trim() || "Reassigning rider");
    }
  }
  if (existing && (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(existing.status)) {
    await db
      .update(deliveryOrders)
      .set({
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancellationReason: reason?.trim() || "Reassigned",
        updatedAt: new Date(),
      })
      .where(eq(deliveryOrders.id, existing.id));

    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.DELIVERY_ORDER_CANCELLED,
      entityType: "delivery_order",
      entityId: existing.id,
      previousValue: { status: existing.status },
      newValue: { status: "CANCELLED", reason },
    });
    const ctx = await deliveryEventContext(orderId, existing.deliveryPartnerId);
    await emitEvent({
      type: "delivery.cancelled",
      subjectId: existing.id,
      orderId,
      transition: { from: existing.status, to: "CANCELLED" },
      actor,
      payload: { ...ctx, reason: reason?.trim() || "The order was given to another rider." },
    });
  }

  return assignNearestPartner(orderId, actor);
}

async function loadOwnDeliveryOrder(deliveryOrderId: string, partnerUserId: string): Promise<DeliveryOrder> {
  const row = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.id, deliveryOrderId) });
  if (!row) throw notFound("Delivery assignment");
  const partner = await db.query.deliveryPartners.findFirst({
    where: eq(deliveryPartners.id, row.deliveryPartnerId),
  });
  if (!partner || partner.userId !== partnerUserId) {
    throw forbidden("This delivery assignment does not belong to you.");
  }
  return row;
}

/**
 * Live tracking (event layer): the rider's phone posts its position for one
 * delivery while the drop is under way, every `tracking.riderPingSeconds`.
 * Only the rider holding the delivery may post (403 otherwise). Before the
 * drop starts, and once it is over — delivered, failed or cancelled — nothing
 * is stored and the answer says `sharing: false` so the phone stops. Only the
 * rider's latest position is kept (on their own record, as for matching); no
 * trail of the trip is stored.
 */
export async function recordDeliveryLocation(
  deliveryOrderId: string,
  partnerUserId: string,
  latitude: number,
  longitude: number,
): Promise<{ sharing: boolean; shared: boolean; nextPingSeconds: number }> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, partnerUserId);
  const { riderPingSeconds } = await getRule("tracking");
  if (row.status !== "PICKED_UP" || !row.outForDeliveryAt) {
    return { sharing: false, shared: true, nextPingSeconds: riderPingSeconds };
  }
  // false when the rider is offline on the server: the phone then resyncs.
  const shared = await updateMyLocation(partnerUserId, latitude, longitude);
  return { sharing: shared, shared, nextPingSeconds: riderPingSeconds };
}

/** Event layer: the people an assignment's events concern. */
async function deliveryEventContext(
  orderId: string,
  partnerId: string | null,
  client: DbClient = db,
): Promise<Omit<DeliveryEventPayload, "reason"> & { riderName: string | null; shopName: string }> {
  const [row] = await client
    .select({ orderNumber: orders.orderNumber, buyerId: orders.userId, shopOwnerId: shops.ownerId, shopName: shops.name })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId));
  const [rider] = partnerId
    ? await client
        .select({ userId: deliveryPartners.userId, name: deliveryPartners.fullName })
        .from(deliveryPartners)
        .where(eq(deliveryPartners.id, partnerId))
    : [];
  return {
    orderId,
    orderNumber: row?.orderNumber ?? "",
    buyerId: row?.buyerId ?? "",
    shopOwnerId: row?.shopOwnerId ?? null,
    shopName: row?.shopName ?? "the shop",
    riderUserId: rider?.userId ?? null,
    riderName: rider?.name ?? null,
  };
}

/** Event layer: what the order's own events say about the rider. */
const riderFacts = (ctx: { riderUserId: string | null; riderName: string | null }) => ({
  riderUserId: ctx.riderUserId,
  riderName: ctx.riderName ?? "Your rider",
});

/**
 * DEF-04 fix: the UPDATE's own WHERE clause enforces `status = 'OFFERED'`
 * instead of a separate, unguarded SELECT-then-UPDATE — so two concurrent
 * calls (a double-tap, a client retry) can no longer both pass a check and
 * both write. Whichever one's UPDATE actually matches a row wins; the other
 * gets zero rows back and a clean conflict.
 */
export async function acceptDeliveryOffer(deliveryOrderId: string, partnerUserId: string): Promise<DeliveryOrder> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, partnerUserId); // ownership check
  const actor: Actor = { id: partnerUserId, role: "DELIVERY_PARTNER" };
  const offerTtlSeconds = await getOfferTtlSeconds();

  // Slice 4: accepting also moves the order READY → ASSIGNED and issues the
  // pickup code the shop reads out at handover — in one transaction, so a
  // cancelled order can never end up with an accepted rider.
  const accepted = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deliveryOrders)
      .set({ status: "ACCEPTED", acceptedAt: new Date(), pickupCode: fourDigitCode(), updatedAt: new Date() })
      .where(
        and(
          eq(deliveryOrders.id, deliveryOrderId),
          eq(deliveryOrders.status, "OFFERED"),
          sql`${deliveryOrders.offeredAt} > now() - make_interval(secs => ${offerTtlSeconds})`,
        ),
      )
      .returning();
    if (!updated) throw conflict("This delivery offer is no longer available.");

    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, row.orderId));
    // Only a READY order can take a rider — not one the shop has already
    // sent out itself, cancelled, or given to another rider.
    if (order?.status !== "READY") {
      throw conflict("This order is no longer waiting for a rider.");
    }
    const ctx = await deliveryEventContext(row.orderId, row.deliveryPartnerId, tx);
    await emitEvent(
      {
        type: "delivery.accepted",
        subjectId: deliveryOrderId,
        orderId: row.orderId,
        transition: { from: "OFFERED", to: "ACCEPTED" },
        actor,
        payload: ctx,
      },
      tx,
    );
    await updateOrderStatus(row.orderId, "ASSIGNED", actor, "Rider accepted", tx, riderFacts(ctx));
    // The search is over: a rider has the order.
    await tx
      .update(riderSearches)
      .set({ status: "ASSIGNED", stopReason: "RIDER_ACCEPTED", stoppedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(riderSearches.orderId, row.orderId), eq(riderSearches.status, "SEARCHING")));

    await recordAudit(
      {
        actorId: partnerUserId,
        actorRole: "DELIVERY_PARTNER",
        action: AUDIT_ACTIONS.DELIVERY_ORDER_ACCEPTED,
        entityType: "delivery_order",
        entityId: deliveryOrderId,
        newValue: { status: "ACCEPTED" },
      },
      tx,
    );
    return updated;
  });
  // GS-046: society security desk hears who is coming (after commit; never blocks the accept).
  await notifySocietySecurity(row.orderId).catch((error) => {
    console.error("[delivery] society security notification failed", row.orderId, error);
  });
  return accepted;
}

/** DEF-04 fix — same status-guarded UPDATE as acceptDeliveryOffer, see above. */
export async function rejectDeliveryOffer(
  deliveryOrderId: string,
  partnerUserId: string,
  reason?: string,
): Promise<DeliveryOrder> {
  await loadOwnDeliveryOrder(deliveryOrderId, partnerUserId); // ownership check

  const [updated] = await db
    .update(deliveryOrders)
    .set({
      status: "REJECTED",
      cancelledAt: new Date(),
      cancellationReason: reason?.trim() || null,
      rejectedPartnerIds: sql`array_append(${deliveryOrders.rejectedPartnerIds}, ${deliveryOrders.deliveryPartnerId})`,
      updatedAt: new Date(),
    })
    .where(and(eq(deliveryOrders.id, deliveryOrderId), eq(deliveryOrders.status, "OFFERED")))
    .returning();
  if (!updated) throw conflict("This delivery offer is no longer available.");

  await recordAudit({
    actorId: partnerUserId,
    action: AUDIT_ACTIONS.DELIVERY_ORDER_REJECTED,
    entityType: "delivery_order",
    entityId: deliveryOrderId,
    newValue: { status: "REJECTED", reason },
  });
  await emitEvent({
    type: "delivery.rejected",
    subjectId: deliveryOrderId,
    orderId: updated.orderId,
    transition: { from: "OFFERED", to: "REJECTED" },
    actor: { id: partnerUserId, role: "DELIVERY_PARTNER" },
    payload: { ...(await deliveryEventContext(updated.orderId, updated.deliveryPartnerId)), reason: reason?.trim() || null },
  });

  // GA-009: move straight on to the next nearest rider.
  await dispatchReadyOrder(updated.orderId, { id: null, role: null }, "REOFFER").catch((error) => {
    console.error("[delivery] re-offer after rejection failed", updated.orderId, error);
  });
  return updated;
}

/**
 * DEF-04 fix: the deliveryOrders transition and the order's own status
 * transition now happen in ONE transaction instead of two independent ones —
 * previously a failure between them (including, per DEF-08, a customer
 * cancelling the order at the exact moment the rider is mid-delivery) left
 * deliveryOrders and orders permanently disagreeing about what happened.
 */
export async function markPickedUp(
  deliveryOrderId: string,
  actor: Actor,
  pickupCode?: string,
): Promise<DeliveryOrder> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, actor.id); // ownership check
  // GS-041: the shop reads the code to the rider. Rows accepted before the
  // code existed have none and keep the old one-tap pickup.
  if (row.pickupCode && pickupCode?.trim() !== row.pickupCode) {
    throw validationFailed("That pickup code does not match. Ask the shop for the code shown on the order.");
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deliveryOrders)
      .set({ status: "PICKED_UP", pickedUpAt: new Date(), updatedAt: new Date() })
      .where(and(eq(deliveryOrders.id, deliveryOrderId), eq(deliveryOrders.status, "ACCEPTED")))
      .returning();
    if (!updated) throw conflict("This delivery must be accepted before it can be marked picked up.");

    // ASSIGNED → PICKED_UP (the rider then starts the drop). An order still
    // READY was accepted before ASSIGNED existed — it keeps the old jump
    // straight to OUT_FOR_DELIVERY.
    const ctx = await deliveryEventContext(row.orderId, row.deliveryPartnerId, tx);
    await emitEvent(
      {
        type: "delivery.picked_up",
        subjectId: deliveryOrderId,
        orderId: row.orderId,
        transition: { from: "ACCEPTED", to: "PICKED_UP" },
        actor,
        payload: ctx,
      },
      tx,
    );
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, row.orderId));
    if (order?.status === "ASSIGNED") {
      await updateOrderStatus(row.orderId, "PICKED_UP", actor, "Picked up by rider", tx, riderFacts(ctx));
    } else {
      await updateOrderStatus(row.orderId, "OUT_FOR_DELIVERY", actor, undefined, tx, riderFacts(ctx));
    }

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DELIVERY_ORDER_PICKED_UP,
        entityType: "delivery_order",
        entityId: deliveryOrderId,
        newValue: { status: "PICKED_UP" },
      },
      tx,
    );

    return updated;
  });
}

/**
 * DEF-04 fix — same one-transaction shape as markPickedUp, see above; earnings
 * are credited inside it too, so a rolled-back delivery can never leave a
 * dangling earnings row. The order's DELIVERED transition (orders.ts) also
 * debits the shop wallet in this transaction (rule shopWallet).
 *
 * Only the rider holding the delivery gets here (loadOwnDeliveryOrder). The
 * customer's code is checked by delivery-otp.ts (wrong codes counted, the
 * limit locks the drop and raises a ticket); the code is spent in the same
 * UPDATE that marks the drop delivered, and only if it is still the code that
 * was checked. A repeated submit after success returns the delivery as it is —
 * the order is completed and charged once.
 */
export async function markDelivered(
  deliveryOrderId: string,
  actor: Actor,
  otp?: string,
  /** GS-030: the rider confirms the cash was collected — required for a COD order. */
  cashCollected?: boolean,
): Promise<DeliveryOrder> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, actor.id); // ownership check
  if (row.status === "DELIVERED") return row; // double submit: already done, nothing more to charge
  await assertCashConfirmed(row.orderId, cashCollected);
  // NEW-007: with photo proof on, a photo at the door comes first.
  if (row.status === "PICKED_UP") await assertDeliveryProof(deliveryOrderId);

  // GS-043: the customer's OTP confirms the drop. A delivery picked up
  // before OTPs existed (no code, no start-of-drop time) keeps the old flow.
  if (row.status === "PICKED_UP" && row.pickupCode && !row.outForDeliveryAt) {
    throw conflict("Start the delivery before marking it delivered.");
  }
  const withCode = row.status === "PICKED_UP" && needsDeliveryCode(row);
  if (withCode) await checkDeliveryCode(row, otp, actor);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deliveryOrders)
      .set({
        status: "DELIVERED",
        deliveredAt: new Date(),
        deliveryConfirmation: withCode ? "CUSTOMER_OTP" : null,
        // The code is spent: it can never confirm anything again.
        deliveryOtpHash: null,
        deliveryOtp: null,
        deliveryOtpUsedAt: withCode ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deliveryOrders.id, deliveryOrderId),
          eq(deliveryOrders.status, "PICKED_UP"),
          isNull(deliveryOrders.deliveryOtpLockedAt),
          // Still the code that was checked — not one the customer replaced meanwhile.
          withCode
            ? row.deliveryOtpHash
              ? eq(deliveryOrders.deliveryOtpHash, row.deliveryOtpHash)
              : eq(deliveryOrders.deliveryOtp, row.deliveryOtp!)
            : undefined,
        ),
      )
      .returning();
    if (!updated) {
      const [current] = await tx.select().from(deliveryOrders).where(eq(deliveryOrders.id, deliveryOrderId));
      // A concurrent submit of the same code won: report its result, charge nothing again.
      if (current?.status === "DELIVERED") return current;
      if (current?.deliveryOtpLockedAt) throw conflict("Too many wrong codes — this delivery is locked. Operations will confirm it.");
      if (current?.status === "PICKED_UP" && withCode) {
        throw conflict("The customer asked for a new delivery code. Ask them for the latest one.");
      }
      throw conflict("This delivery must be picked up before it can be marked delivered.");
    }

    const ctx = await deliveryEventContext(row.orderId, row.deliveryPartnerId, tx);
    await emitEvent(
      {
        type: "delivery.delivered",
        subjectId: deliveryOrderId,
        orderId: row.orderId,
        transition: { from: "PICKED_UP", to: "DELIVERED" },
        actor,
        payload: ctx,
      },
      tx,
    );
    await updateOrderStatus(row.orderId, "DELIVERED", actor, undefined, tx, riderFacts(ctx));
    await creditDeliveryEarnings(deliveryOrderId, tx);

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DELIVERY_ORDER_DELIVERED,
        entityType: "delivery_order",
        entityId: deliveryOrderId,
        newValue: { status: "DELIVERED" },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Rider leaves the shop for the customer: PICKED_UP → OUT_FOR_DELIVERY and
 * the customer's delivery OTP is issued (shown only in their order).
 */
export async function startDelivery(deliveryOrderId: string, actor: Actor): Promise<DeliveryOrder> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, actor.id);
  // A fresh code for this drop: only its hash is stored; the code itself is
  // emailed to the customer once the drop has started (below).
  const code = generateDeliveryCode();
  const started = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deliveryOrders)
      .set({
        outForDeliveryAt: new Date(),
        ...freshCodeFields(deliveryOrderId, code),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deliveryOrders.id, deliveryOrderId),
          eq(deliveryOrders.status, "PICKED_UP"),
          isNull(deliveryOrders.outForDeliveryAt),
        ),
      )
      .returning();
    if (!updated) throw conflict("This delivery is not waiting to start.");

    const ctx = await deliveryEventContext(row.orderId, row.deliveryPartnerId, tx);
    // Not a delivery status of its own (out_for_delivery_at on a PICKED_UP row); live tracking starts here.
    await emitEvent(
      { type: "delivery.started", subjectId: deliveryOrderId, orderId: row.orderId, actor, payload: ctx },
      tx,
    );
    await updateOrderStatus(row.orderId, "OUT_FOR_DELIVERY", actor, "On the way to the customer", tx, riderFacts(ctx));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DELIVERY_ORDER_OUT_FOR_DELIVERY,
        entityType: "delivery_order",
        entityId: deliveryOrderId,
        newValue: { outForDeliveryAt: updated.outForDeliveryAt },
      },
      tx,
    );
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DELIVERY_CODE_SENT,
        entityType: "delivery_order",
        entityId: deliveryOrderId,
        newValue: { reason: "drop_started" },
      },
      tx,
    );
    return updated;
  });
  // After commit; never fails the start (the customer can get a new code).
  await sendDeliveryCodeToBuyer(row.orderId, code);
  return started;
}

/**
 * Checkpoint: the rider has reached the shop. No order-status change (the
 * order stays ASSIGNED until the pickup code is entered); the shop is told so
 * it can have the parcel and the pickup code ready. Idempotent.
 */
export async function markArrivedAtShop(deliveryOrderId: string, actor: Actor): Promise<DeliveryOrder> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, actor.id);
  if (row.status !== "ACCEPTED") throw conflict("Accept the delivery before marking arrival at the shop.");
  if (row.arrivedAtShopAt) return row;

  const [updated] = await db
    .update(deliveryOrders)
    .set({ arrivedAtShopAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(deliveryOrders.id, deliveryOrderId),
        eq(deliveryOrders.status, "ACCEPTED"),
        isNull(deliveryOrders.arrivedAtShopAt),
      ),
    )
    .returning();
  if (!updated) return (await loadOwnDeliveryOrder(deliveryOrderId, actor.id)) ?? row;

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DELIVERY_ARRIVED_AT_SHOP,
    entityType: "delivery_order",
    entityId: deliveryOrderId,
  });
  const [order] = await db.select().from(orders).where(eq(orders.id, row.orderId));
  const shop = order ? await db.query.shops.findFirst({ where: eq(shops.id, order.shopId) }) : null;
  if (order && shop) {
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.DELIVERY_RIDER_AT_SHOP,
      title: "Rider has arrived",
      body: `The rider for order ${order.orderNumber} is at your shop. Hand over the parcel once they read out the pickup code.`,
      actionUrl: "/shop/orders",
      dedupeKey: `rider-at-shop:${deliveryOrderId}`,
    });
  }
  return updated;
}

const GATE_CUSTOMER_MESSAGE: Record<string, string> = {
  OPEN: "Your rider has arrived. Please keep your delivery code ready.",
  CALL_RESIDENT: "Your rider is at the gate. Security may call you to approve entry — please pick up.",
  PRE_APPROVAL: "Your rider is at the gate. Please approve their entry with security.",
  DROP_AT_GATE: "Your rider is at the gate with your order. Please come down to collect it and share your delivery code.",
};

/**
 * Checkpoint: the rider has reached the customer's door or society gate.
 * Only after the drop has started (PICKED_UP + out for delivery). Tells the
 * customer — with what the society's gate will ask of them — and, when the
 * society turned security notices on, the gate. Idempotent.
 */
export async function markArrivedAtCustomer(deliveryOrderId: string, actor: Actor): Promise<DeliveryOrder> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, actor.id);
  if (row.status !== "PICKED_UP") throw conflict("Pick up the order before marking arrival at the customer.");
  if (row.pickupCode && !row.outForDeliveryAt) throw conflict("Start the delivery before marking arrival.");
  if (row.arrivedAtCustomerAt) return row;

  const [updated] = await db
    .update(deliveryOrders)
    .set({ arrivedAtCustomerAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(deliveryOrders.id, deliveryOrderId),
        eq(deliveryOrders.status, "PICKED_UP"),
        isNull(deliveryOrders.arrivedAtCustomerAt),
      ),
    )
    .returning();
  if (!updated) return row;

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DELIVERY_ARRIVED_AT_CUSTOMER,
    entityType: "delivery_order",
    entityId: deliveryOrderId,
  });

  const [order] = await db.select().from(orders).where(eq(orders.id, row.orderId));
  if (order) {
    const society = order.societyId
      ? await db.query.societies.findFirst({ where: eq(societies.id, order.societyId) })
      : null;
    const gated = society?.status === "VERIFIED";
    if (!gated || society.notifyCustomerAtGate) {
      await notify({
        userId: order.userId,
        type: NOTIFICATION_TYPES.ORDER_RIDER_ARRIVING,
        title: "Your rider has arrived",
        body: `Order ${order.orderNumber}: ${GATE_CUSTOMER_MESSAGE[gated ? society.gateEntryMode : "OPEN"]}`,
        actionUrl: "/orders",
        dedupeKey: `rider-arrived:${deliveryOrderId}`,
      });
    }
    if (gated && society.securityNotifyEnabled) {
      for (const userId of await societyStaffUserIds(society.id)) {
        await notify({
          userId,
          type: NOTIFICATION_TYPES.SOCIETY_SECURITY_ALERT,
          title: "Delivery rider at the gate",
          body: `The rider for order ${order.orderNumber} has arrived. Entry mode: ${society.gateEntryMode.replace(/_/g, " ").toLowerCase()}.`,
          actionUrl: `/society/${society.id}`,
          dedupeKey: `society-gate-arrival:${deliveryOrderId}:${userId}`,
        });
      }
    }
  }
  return updated;
}

/**
 * The drop could not be completed (customer unavailable, wrong address…).
 * The order becomes FAILED for the shop/operations to retry or mark
 * RETURNED; the rider is still paid for the trip.
 */
export async function markDeliveryFailed(
  deliveryOrderId: string,
  actor: Actor,
  reason: string,
): Promise<DeliveryOrder> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, actor.id);
  const trimmed = reason.trim();
  if (!trimmed) throw validationFailed("Say why the delivery could not be completed.");

  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deliveryOrders)
      .set({
        status: "FAILED",
        failedAt: new Date(),
        failureReason: trimmed,
        // The customer's code dies with the drop.
        deliveryOtpHash: null,
        deliveryOtp: null,
        updatedAt: new Date(),
      })
      .where(and(eq(deliveryOrders.id, deliveryOrderId), eq(deliveryOrders.status, "PICKED_UP")))
      .returning();
    if (!updated) throw conflict("Only a picked-up delivery can be marked failed.");

    const ctx = await deliveryEventContext(row.orderId, row.deliveryPartnerId, tx);
    await emitEvent(
      {
        type: "delivery.failed",
        subjectId: deliveryOrderId,
        orderId: row.orderId,
        transition: { from: "PICKED_UP", to: "FAILED" },
        actor,
        payload: { ...ctx, reason: trimmed },
      },
      tx,
    );
    // The order event tells the customer and the shop, with the reason.
    await updateOrderStatus(row.orderId, "FAILED", actor, trimmed, tx, { ...riderFacts(ctx), reason: trimmed });
    await creditDeliveryEarnings(deliveryOrderId, tx);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DELIVERY_ORDER_FAILED,
        entityType: "delivery_order",
        entityId: deliveryOrderId,
        newValue: { status: "FAILED", reason: trimmed },
      },
      tx,
    );
    return updated;
  });
  return result;
}

/**
 * Operations confirms a drop the customer could not confirm by OTP (phone
 * dead, OTP attempts used up). Requires a proof note; always audited.
 */
export async function confirmDeliveryByOperator(
  orderId: string,
  actor: Actor,
  proofNote: string,
  /** GS-030: for a COD order, operations confirms the rider collected the cash. */
  cashCollected?: boolean,
): Promise<DeliveryOrder> {
  const note = proofNote.trim();
  if (note.length < 5) throw validationFailed("Record how the delivery was confirmed.");
  await assertCashConfirmed(orderId, cashCollected);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deliveryOrders)
      .set({
        status: "DELIVERED",
        deliveredAt: new Date(),
        deliveryConfirmation: "OPERATOR_OVERRIDE",
        proofNote: note,
        deliveryOtpHash: null,
        deliveryOtp: null,
        updatedAt: new Date(),
      })
      .where(and(eq(deliveryOrders.orderId, orderId), eq(deliveryOrders.status, "PICKED_UP")))
      .returning();
    if (!updated) throw conflict("This order has no picked-up delivery to confirm.");

    const ctx = await deliveryEventContext(orderId, updated.deliveryPartnerId, tx);
    await emitEvent(
      {
        type: "delivery.delivered",
        subjectId: updated.id,
        orderId,
        transition: { from: "PICKED_UP", to: "DELIVERED" },
        actor,
        payload: { ...ctx, reason: note },
      },
      tx,
    );
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    if (order?.status === "PICKED_UP") {
      await updateOrderStatus(orderId, "OUT_FOR_DELIVERY", actor, "Operator confirmation", tx);
    }
    // The rider is told the drop is confirmed, as for a code-confirmed one.
    await updateOrderStatus(orderId, "DELIVERED", actor, `Confirmed by operations: ${note}`, tx, riderFacts(ctx));
    await creditDeliveryEarnings(updated.id, tx);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DELIVERY_CONFIRMED_BY_OPERATOR,
        entityType: "delivery_order",
        entityId: updated.id,
        newValue: { orderId, proofNote: note },
      },
      tx,
    );
    return updated;
  });
}

/** A COD order cannot be marked delivered until the cash is confirmed (GS-030). */
async function assertCashConfirmed(orderId: string, cashCollected: boolean | undefined): Promise<void> {
  const [order] = await db
    .select({ paymentMethod: orders.paymentMethod, totalPaise: orders.totalPaise })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (order?.paymentMethod === "COD" && cashCollected !== true) {
    throw validationFailed(`Collect ₹${(order.totalPaise / 100).toFixed(2)} in cash and confirm it before marking this order delivered.`);
  }
}

/* ------------------------------------------------------ find-rider search */

export type DispatchTrigger = "SHOP_MANUAL" | "AUTO_READY" | "SWEEP" | "REOFFER";
type StopReason = NonNullable<RiderSearch["stopReason"]>;
type DispatchRules = Awaited<ReturnType<typeof getDispatchRules>>;

function getDispatchRules() {
  return getRule("dispatch");
}

const STOP_MESSAGES: Record<StopReason, string> = {
  RIDER_ACCEPTED: "A rider has accepted this order.",
  ORDER_CANCELLED: "The order was cancelled, so the search stopped.",
  ORDER_NOT_READY: "The order is no longer waiting for a rider.",
  WINDOW_EXPIRED: "The promised delivery time has passed, so automatic search stopped.",
  RETRY_LIMIT: "No rider accepted after the maximum number of attempts.",
  TIME_LIMIT: "No rider accepted within the search time limit.",
  STOPPED_BY_SHOP: "You stopped the search.",
};

async function logAttempt(
  search: Pick<RiderSearch, "id" | "orderId">,
  attemptNo: number,
  trigger: DispatchTrigger,
  outcome: DispatchAttempt["outcome"],
  extra: { deliveryOrderId?: string; deliveryPartnerId?: string; detail?: string } = {},
): Promise<void> {
  try {
    await db.insert(dispatchAttempts).values({
      orderId: search.orderId,
      searchId: search.id,
      attemptNo,
      trigger,
      outcome,
      deliveryOrderId: extra.deliveryOrderId ?? null,
      deliveryPartnerId: extra.deliveryPartnerId ?? null,
      detail: extra.detail?.slice(0, 300) ?? null,
    });
  } catch (error) {
    // The log must never break dispatch.
    console.error("[delivery] could not log dispatch attempt", error);
  }
}

async function closeSearch(searchId: string, reason: StopReason): Promise<void> {
  await db
    .update(riderSearches)
    .set({
      status: reason === "RIDER_ACCEPTED" ? "ASSIGNED" : "STOPPED",
      stopReason: reason,
      stoppedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(riderSearches.id, searchId), eq(riderSearches.status, "SEARCHING")));
}

/** Why a search must not continue, or null. Checked before every attempt. */
function stopReasonFor(
  order: { status: string; promisedByAt: Date | null },
  search: RiderSearch,
  rules: DispatchRules,
  now: Date,
): StopReason | null {
  if (order.status === "CANCELLED") return "ORDER_CANCELLED";
  if (order.status !== "READY") return "ORDER_NOT_READY";
  if (search.attempts >= search.maxAttempts) return "RETRY_LIMIT";
  if (now.getTime() - search.startedAt.getTime() > rules.maxSearchMinutes * 60_000) return "TIME_LIMIT";
  if (order.promisedByAt && now.getTime() > order.promisedByAt.getTime() + rules.windowGraceMinutes * 60_000) {
    return "WINDOW_EXPIRED";
  }
  return null;
}

/** Creates the search row, or restarts a finished one when the shop asks again. */
async function ensureSearch(
  orderId: string,
  trigger: DispatchTrigger,
  actorId: string | null,
  rules: DispatchRules,
): Promise<RiderSearch> {
  const now = new Date();
  const [existing] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, orderId));
  if (!existing) {
    const [created] = await db
      .insert(riderSearches)
      .values({ orderId, maxAttempts: rules.maxAttempts, startedBy: actorId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [raced] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, orderId));
    return raced;
  }
  if (trigger === "SHOP_MANUAL" && existing.status !== "SEARCHING") {
    const [restarted] = await db
      .update(riderSearches)
      .set({
        status: "SEARCHING",
        stopReason: null,
        stoppedAt: null,
        attempts: 0,
        maxAttempts: rules.maxAttempts,
        startedAt: now,
        lastAttemptAt: null,
        nextAttemptAt: null,
        startedBy: actorId,
        updatedAt: now,
      })
      .where(eq(riderSearches.id, existing.id))
      .returning();
    return restarted;
  }
  return existing;
}

/**
 * Asks for a rider for a READY order (GA-006). Used right after the shop
 * marks an order ready, after a rejection/expiry, by the dispatch cron, and
 * by the shop's "Find rider now". Returns null — never throws — when there is
 * nothing to do or nobody is free.
 *
 * Every call is one bounded step of a search (rider_searches):
 *  - automatic attempts are paced by `dispatch.retryIntervalSeconds`;
 *  - the search stops on acceptance, cancellation, an expired delivery window,
 *    `maxAttempts`, or `maxSearchMinutes` — all configurable;
 *  - each attempt is logged (dispatch_attempts); the shop hears when it fails
 *    and when the search gives up. Only a manual press restarts a stopped search.
 * Duplicate assignment is impossible regardless: assignNearestPartner locks the
 * order's row and the rider's row and refuses a second active assignment.
 */
export async function dispatchReadyOrder(
  orderId: string,
  actor: DispatchActor,
  trigger: DispatchTrigger = "AUTO_READY",
): Promise<DeliveryOrder | null> {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) return null;
  const rules = await getDispatchRules();

  if (order.status !== "READY") {
    // Cancelled, already assigned, delivered...: close any open search and stop.
    const [open] = await db
      .select()
      .from(riderSearches)
      .where(and(eq(riderSearches.orderId, orderId), eq(riderSearches.status, "SEARCHING")));
    if (open) {
      const reason: StopReason =
        order.status === "CANCELLED"
          ? "ORDER_CANCELLED"
          : ["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"].includes(order.status)
            ? "RIDER_ACCEPTED"
            : "ORDER_NOT_READY";
      await closeSearch(open.id, reason);
      await logAttempt(open, open.attempts, trigger, "STOPPED", { detail: STOP_MESSAGES[reason] });
    }
    return null;
  }

  const shop = await db.query.shops.findFirst({ where: eq(shops.id, order.shopId) });
  if (!shop?.deliveryAvailable) return null; // pickup-only / shop hands over itself
  // GS-027: an order for a chosen delivery time looks for a rider only shortly
  // before its slot (the dispatch sweep tries again); the shop's own "Find
  // rider now" goes straight through.
  if (trigger !== "SHOP_MANUAL") {
    const from = await scheduledDispatchFrom(order);
    if (from && Date.now() < from.getTime()) return null;
  }
  // An order the suspension policy holds for review is not sent to a rider until an operator decides.
  const held = await suspensionRecordFor(db, order.shopId, order.id);
  if (held.record?.outcome === "AWAITING_REVIEW") return null;

  const active = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, orderId) });
  if (active && (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(active.status)) return null;

  const search = await ensureSearch(orderId, trigger, actor.id, rules);
  if (search.status !== "SEARCHING") return null; // finished: only a manual retry restarts it

  const now = new Date();
  const stop = stopReasonFor(order, search, rules, now);
  if (stop) {
    await closeSearch(search.id, stop);
    await logAttempt(search, search.attempts, trigger, "STOPPED", { detail: STOP_MESSAGES[stop] });
    if (stop === "RETRY_LIMIT" || stop === "TIME_LIMIT" || stop === "WINDOW_EXPIRED") {
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.DELIVERY_SEARCH_STOPPED,
        title: "No rider found",
        body: `Order ${order.orderNumber}: ${STOP_MESSAGES[stop]} Press "Find rider now" to try again, or deliver it yourself.`,
        actionUrl: "/shop/orders",
        dedupeKey: `rider-search-stopped:${search.id}`,
      });
    }
    return null;
  }

  // Automatic sweeps respect the retry interval; a rejection/expiry re-offer and manual presses go straight through.
  if (trigger === "SWEEP" && search.nextAttemptAt && search.nextAttemptAt.getTime() > now.getTime()) return null;

  const attemptNo = search.attempts + 1;
  await db
    .update(riderSearches)
    .set({
      attempts: attemptNo,
      lastAttemptAt: now,
      nextAttemptAt: new Date(now.getTime() + rules.retryIntervalSeconds * 1000),
      updatedAt: now,
    })
    .where(eq(riderSearches.id, search.id));

  try {
    const offer = await assignNearestPartner(orderId, actor);
    await logAttempt(search, attemptNo, trigger, "OFFERED", {
      deliveryOrderId: offer.id,
      deliveryPartnerId: offer.deliveryPartnerId,
    });
    return offer;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Matching failed.";
    const noRider = /No delivery partner|no verified location/i.test(message);
    await logAttempt(search, attemptNo, trigger, noRider ? "NO_RIDER" : "ERROR", { detail: message });
    if (!noRider) throw error;
    if (attemptNo >= rules.notifyShopAfterAttempts) {
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.DELIVERY_UNASSIGNED,
        title: "Looking for a rider",
        body: `No rider has taken order ${order.orderNumber} yet — we keep trying automatically (attempt ${attemptNo} of ${search.maxAttempts}). ${message}`,
        actionUrl: "/shop/orders",
        dedupeKey: `delivery-unassigned:${search.id}`,
      });
    }
    return null;
  }
}

export interface RiderSearchStatus {
  state: "NOT_STARTED" | "SEARCHING" | "OFFERED" | "ASSIGNED" | "STOPPED";
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  stopReason: StopReason | null;
  /** Plain-language line for the shop operator. */
  message: string;
  /** True when pressing "Find rider now" would do something useful. */
  canRetry: boolean;
  /** Latest attempts, without the rider or delivery each one offered. */
  log: Pick<DispatchAttempt, "attemptNo" | "trigger" | "outcome" | "detail" | "createdAt">[];
}

/** What the shop operator sees for an order that needs a rider. */
export async function getRiderSearchStatus(orderId: string): Promise<RiderSearchStatus> {
  const [search] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, orderId));
  const delivery = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, orderId) });
  const log = await db
    .select({
      attemptNo: dispatchAttempts.attemptNo,
      trigger: dispatchAttempts.trigger,
      outcome: dispatchAttempts.outcome,
      detail: dispatchAttempts.detail,
      createdAt: dispatchAttempts.createdAt,
    })
    .from(dispatchAttempts)
    .where(eq(dispatchAttempts.orderId, orderId))
    .orderBy(desc(dispatchAttempts.createdAt))
    .limit(10);
  const rules = await getDispatchRules();
  const base = {
    attempts: search?.attempts ?? 0,
    maxAttempts: search?.maxAttempts ?? rules.maxAttempts,
    nextAttemptAt: search?.nextAttemptAt ?? null,
    stopReason: search?.stopReason ?? null,
    log,
  };

  if (delivery && ["ACCEPTED", "PICKED_UP"].includes(delivery.status)) {
    return { ...base, state: "ASSIGNED", message: "A rider has accepted this order.", canRetry: false };
  }
  if (delivery?.status === "OFFERED") {
    return { ...base, state: "OFFERED", message: "Offer sent to a rider — waiting for them to accept.", canRetry: false };
  }
  if (!search) {
    return { ...base, state: "NOT_STARTED", message: "No rider search has started for this order yet.", canRetry: true };
  }
  if (search.status === "SEARCHING") {
    return {
      ...base,
      state: "SEARCHING",
      message: `Looking for a rider — attempt ${search.attempts} of ${search.maxAttempts}${
        search.nextAttemptAt ? "; the next try is automatic" : ""
      }.`,
      canRetry: true,
    };
  }
  if (search.status === "ASSIGNED") {
    return { ...base, state: "ASSIGNED", message: STOP_MESSAGES.RIDER_ACCEPTED, canRetry: false };
  }
  return {
    ...base,
    state: "STOPPED",
    message: search.stopReason ? STOP_MESSAGES[search.stopReason] : "The search has stopped.",
    canRetry: true,
  };
}

/**
 * The shop's "Find rider now". Restarts a stopped search, makes one attempt
 * immediately, and leaves automatic retries running. Throws a conflict — like
 * the previous single-shot behaviour — when nobody can be offered the order
 * right now, but the retries continue in the background.
 */
export async function findRiderNow(orderId: string, actor: Actor): Promise<DeliveryOrder> {
  const rules = await getDispatchRules();
  const [search] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, orderId));
  if (search?.status === "SEARCHING" && search.lastAttemptAt) {
    const wait = Math.ceil((search.lastAttemptAt.getTime() + rules.manualCooldownSeconds * 1000 - Date.now()) / 1000);
    if (wait > 0) throw conflict(`A rider search just ran. Please wait ${wait}s before pressing again.`);
  }

  const offer = await dispatchReadyOrder(orderId, actor, "SHOP_MANUAL");
  if (offer) return offer;

  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) throw notFound("Order");
  if (order.status !== "READY") {
    throw conflict("Only an order marked READY can be assigned to a delivery partner.");
  }
  const active = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, orderId) });
  if (active && (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(active.status)) {
    throw conflict("This order already has an active delivery assignment.");
  }
  const status = await getRiderSearchStatus(orderId);
  throw conflict(`No delivery partner is currently available for this order. ${status.message}`);
}

/** The shop stops the search (it will deliver the order itself). */
export async function stopRiderSearch(orderId: string, actor: Actor): Promise<void> {
  const [open] = await db
    .select()
    .from(riderSearches)
    .where(and(eq(riderSearches.orderId, orderId), eq(riderSearches.status, "SEARCHING")));
  if (!open) return;
  await closeSearch(open.id, "STOPPED_BY_SHOP");
  await logAttempt(open, open.attempts, "SHOP_MANUAL", "STOPPED", { detail: STOP_MESSAGES.STOPPED_BY_SHOP });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_SEARCH_STOPPED,
    entityType: "order",
    entityId: orderId,
  });
}

/**
 * Offers nobody answered within OFFER_TTL_SECONDS count as declined: the
 * rider is remembered on the row and the order goes to the next rider.
 */
export async function expireStaleOffers(): Promise<number> {
  const offerTtlSeconds = await getOfferTtlSeconds();
  const expired = await db
    .update(deliveryOrders)
    .set({
      status: "REJECTED",
      cancelledAt: new Date(),
      cancellationReason: "Offer expired",
      rejectedPartnerIds: sql`array_append(${deliveryOrders.rejectedPartnerIds}, ${deliveryOrders.deliveryPartnerId})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveryOrders.status, "OFFERED"),
        lt(deliveryOrders.offeredAt, sql`now() - make_interval(secs => ${offerTtlSeconds})`),
      ),
    )
    .returning();

  for (const row of expired) {
    await recordAudit({
      action: AUDIT_ACTIONS.DELIVERY_OFFER_EXPIRED,
      entityType: "delivery_order",
      entityId: row.id,
      newValue: { deliveryPartnerId: row.deliveryPartnerId },
    });
    await emitEvent({
      type: "delivery.offer_expired",
      subjectId: row.id,
      orderId: row.orderId,
      transition: { from: "OFFERED", to: "REJECTED" },
      actor: { id: null, role: null },
      payload: await deliveryEventContext(row.orderId, row.deliveryPartnerId),
    }).catch((error) => console.error("[delivery] offer-expired event failed", row.id, error));
    await dispatchReadyOrder(row.orderId, { id: null, role: null }, "REOFFER").catch((error) => {
      console.error("[delivery] re-offer after expiry failed", row.orderId, error);
    });
  }
  return expired.length;
}

/** Cron sweep: expire stale offers, then retry every READY order that has no rider working on it. */
export async function runDispatchSweep(): Promise<{ expired: number; attempted: number; offered: number }> {
  const expired = await expireStaleOffers();
  const waiting = await db
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(and(eq(orders.status, "READY"), eq(shops.deliveryAvailable, true)))
    .limit(200);

  let offered = 0;
  for (const { id } of waiting) {
    const result = await dispatchReadyOrder(id, { id: null, role: null }, "SWEEP").catch((error) => {
      console.error("[delivery] dispatch sweep failed", id, error);
      return null;
    });
    if (result) offered += 1;
  }
  return { expired, attempted: waiting.length, offered };
}

/**
 * Event layer (Y): a READY order whose rider search started more than
 * `dispatch.alertSupportAfterMinutes` ago and still has no rider — searching
 * or given up — is raised with support, once per search. Offers carry on
 * meanwhile; this only makes sure a person looks. Run by the timeout-sweep.
 */
export async function alertOverdueRiderSearches(now: Date = new Date()): Promise<number> {
  const rules = await getDispatchRules();
  const cutoff = new Date(now.getTime() - rules.alertSupportAfterMinutes * 60_000);
  const overdue = await db
    .select({ search: riderSearches, order: orders, shop: shops })
    .from(riderSearches)
    .innerJoin(orders, eq(orders.id, riderSearches.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        isNull(riderSearches.supportAlertedAt),
        lt(riderSearches.startedAt, cutoff),
        inArray(riderSearches.status, ["SEARCHING", "STOPPED"]),
        eq(orders.status, "READY"),
      ),
    )
    .limit(100);

  let alerted = 0;
  for (const { search, order, shop } of overdue) {
    const [claimed] = await db
      .update(riderSearches)
      .set({ supportAlertedAt: now, updatedAt: now })
      .where(and(eq(riderSearches.id, search.id), isNull(riderSearches.supportAlertedAt)))
      .returning({ id: riderSearches.id });
    if (!claimed) continue;
    const minutes = Math.floor((now.getTime() - search.startedAt.getTime()) / 60_000);
    await recordAudit({
      action: AUDIT_ACTIONS.RIDER_SEARCH_SUPPORT_ALERTED,
      entityType: "order",
      entityId: order.id,
      newValue: { searchId: search.id, minutes, attempts: search.attempts },
    });
    await emitEvent({
      type: "delivery.search_overdue",
      subjectId: search.id,
      orderId: order.id,
      actor: { id: null, role: null },
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        buyerId: order.userId,
        shopOwnerId: shop.ownerId,
        shopName: shop.name,
        riderUserId: null,
        minutes,
        attempts: search.attempts,
      },
      idempotencyKey: `rider-search-overdue:${search.id}`,
    });
    alerted += 1;
  }
  return alerted;
}

/** Delivery-row fields a rider must never see: the handover codes and who declined before. */
type SecretDeliveryFields = "pickupCode" | "deliveryOtp" | "deliveryOtpHash" | "rejectedPartnerIds";

export type RiderDeliveryView = Omit<DeliveryOrder, SecretDeliveryFields> & {
  needsPickupCode: boolean;
  needsDeliveryOtp: boolean;
  /** Too many wrong codes: only operations can confirm this drop now. */
  deliveryCodeLocked: boolean;
};

function stripSecrets(row: DeliveryOrder): RiderDeliveryView {
  const { pickupCode, deliveryOtp: _otp, deliveryOtpHash: _hash, rejectedPartnerIds: _rejected, ...safe } = row;
  void _otp;
  void _hash;
  void _rejected;
  return {
    ...safe,
    needsPickupCode: pickupCode != null,
    needsDeliveryOtp: needsDeliveryCode(row),
    deliveryCodeLocked: row.deliveryOtpLockedAt != null,
  };
}

/**
 * Strips the handover codes from a delivery row before a rider sees it (API
 * responses, history). The shop gives the pickup code, the customer gives
 * the OTP — a rider who could read either could confirm a handover alone.
 */
export function toRiderView(row: DeliveryOrder): RiderDeliveryView {
  return stripSecrets(row);
}

/**
 * What the shop or operations get back from a rider request: the offer's
 * state only — not which rider was offered it, who declined before, or the
 * handover codes. The shop reads its pickup code from its order list.
 */
export function toAssignmentView(row: DeliveryOrder): Pick<DeliveryOrder, "id" | "status" | "offeredAt"> {
  return { id: row.id, status: row.status, offeredAt: row.offeredAt };
}

/**
 * The rider's view of their active job. The pickup code and the customer's
 * OTP are deliberately NOT included — the rider must get them from the shop
 * and the customer, or the handover checks mean nothing. Only flags saying
 * which code is expected are exposed.
 *
 * Privacy: until the parcel is picked up the rider sees only the customer's
 * area (enough to judge the trip); the full address, coordinates and
 * navigation link to the door appear from PICKED_UP. The customer's name and
 * phone number are never included.
 */
export interface DeliveryPlace {
  label: string;
  latitude: number | null;
  longitude: number | null;
  /** A maps deep link the rider's phone opens in its navigation app. */
  navigationUrl: string | null;
  notes: string | null;
}

export interface ActiveDeliveryDetail extends RiderDeliveryView {
  orderNumber: string;
  orderTotalPaise: number;
  /** GS-030: cash to collect at the door (null when the order is prepaid). */
  cashToCollectPaise: number | null;
  /** GS-027: the delivery time the customer chose (IST slot), or null for "deliver now". */
  scheduledSlot: { start: string; end: string } | null;
  /** NEW-007: a photo at the door is needed before "Mark delivered", and whether one is in. */
  proofRequired: boolean;
  proofUploaded: boolean;
  shopName: string;
  shopAddress: string;
  customerAddress: string | null;
  /** Landmark / the customer's own delivery instructions (GS-047). */
  customerNotes: string | null;
  /** Society gate / parking / access notes for society deliveries (GS-047). */
  societyName: string | null;
  societyInstructions: string | null;
  /** Where to collect the order. */
  pickup: DeliveryPlace;
  /** Where to drop it; `precise` is false while only the area is shown. */
  drop: DeliveryPlace & { precise: boolean };
  /** Society gate arrangement; null for non-society deliveries. */
  gate: {
    entryMode: string;
    contactName: string | null;
    contactPhone: string | null;
  } | null;
}

function navigationUrl(lat: number | null, lng: number | null, addressText: string): string | null {
  const destination = lat != null && lng != null ? `${lat},${lng}` : addressText ? encodeURIComponent(addressText) : null;
  return destination ? `https://www.google.com/maps/dir/?api=1&destination=${destination}` : null;
}

/** Enriched view for the delivery-partner dashboard — pickup/drop details a rider needs, with navigation links. */
export async function getMyActiveDeliveryDetail(userId: string): Promise<ActiveDeliveryDetail | null> {
  const active = await getMyActiveDeliveryOrder(userId);
  if (!active) return null;

  const [row] = await db
    .select({
      orderNumber: orders.orderNumber,
      orderTotalPaise: orders.totalPaise,
      paymentMethod: orders.paymentMethod,
      scheduledSlotStart: orders.scheduledSlotStart,
      scheduledSlotEnd: orders.scheduledSlotEnd,
      deliveryAddressSnapshot: orders.deliveryAddressSnapshot,
      societyId: orders.societyId,
      shopName: shops.name,
      addressLine1: shops.addressLine1,
      addressLine2: shops.addressLine2,
      city: shops.city,
      shopLatitude: shops.latitude,
      shopLongitude: shops.longitude,
      pickupLatitude: shops.pickupLatitude,
      pickupLongitude: shops.pickupLongitude,
      pickupInstructions: shops.pickupInstructions,
    })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(eq(orders.id, active.orderId));
  if (!row) return null;

  // Only the rider holding this active job gets the society's gate notes.
  const society = await getSocietyDeliveryNotes(row.societyId);
  const snapshot = row.deliveryAddressSnapshot;
  const pickedUp = active.status === "PICKED_UP";
  const fullAddress = snapshot ? [snapshot.line1, snapshot.area, snapshot.city].filter(Boolean).join(", ") : null;
  const areaOnly = snapshot ? [snapshot.area, snapshot.city].filter(Boolean).join(", ") : null;
  const customerAddress = pickedUp ? fullAddress : areaOnly;
  const customerNotes =
    pickedUp && snapshot
      ? [snapshot.landmark, snapshot.deliveryInstructions].filter(Boolean).join(" · ") || null
      : null;

  const dropCoords = pickedUp ? parseCoordinates(snapshot?.latitude ?? null, snapshot?.longitude ?? null) : null;
  const pickupCoords =
    parseCoordinates(row.pickupLatitude, row.pickupLongitude) ?? parseCoordinates(row.shopLatitude, row.shopLongitude);
  const shopAddress = [row.addressLine1, row.addressLine2, row.city].filter(Boolean).join(", ");

  // Strip both codes before this leaves the server (see ActiveDeliveryDetail).
  return {
    ...stripSecrets(active),
    orderNumber: row.orderNumber,
    orderTotalPaise: row.orderTotalPaise,
    cashToCollectPaise: row.paymentMethod === "COD" ? row.orderTotalPaise : null,
    scheduledSlot:
      row.scheduledSlotStart && row.scheduledSlotEnd
        ? { start: row.scheduledSlotStart.toISOString(), end: row.scheduledSlotEnd.toISOString() }
        : null,
    proofRequired: await isDeliveryProofRequired(),
    proofUploaded: await hasDeliveryProof(active.id),
    shopName: row.shopName,
    shopAddress,
    customerAddress,
    customerNotes,
    societyName: society?.name ?? null,
    societyInstructions: pickedUp ? (society?.instructions ?? null) : null,
    pickup: {
      label: `${row.shopName} — ${shopAddress}`,
      latitude: pickupCoords?.latitude ?? null,
      longitude: pickupCoords?.longitude ?? null,
      navigationUrl: navigationUrl(pickupCoords?.latitude ?? null, pickupCoords?.longitude ?? null, `${row.shopName} ${shopAddress}`),
      notes: row.pickupInstructions,
    },
    drop: {
      label: customerAddress ?? "Address on order details",
      latitude: dropCoords?.latitude ?? null,
      longitude: dropCoords?.longitude ?? null,
      navigationUrl: pickedUp ? navigationUrl(dropCoords?.latitude ?? null, dropCoords?.longitude ?? null, fullAddress ?? "") : null,
      notes: customerNotes,
      precise: pickedUp,
    },
    gate: society
      ? { entryMode: society.entryMode, contactName: society.contactName, contactPhone: society.contactPhone }
      : null,
  };
}

export async function getMyActiveDeliveryOrder(userId: string): Promise<DeliveryOrder | null> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner) return null;

  // GA-005: on a batched trip the main card follows the trip's stop order
  // (every pickup first, then the drops), not simply the furthest-along job.
  const nextInTrip = await nextTripDeliveryId(partner.id);
  if (nextInTrip) {
    const row = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.id, nextInTrip) });
    if (row) return row;
  }

  const row = await db.query.deliveryOrders.findFirst({
    where: and(
      eq(deliveryOrders.deliveryPartnerId, partner.id),
      inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES),
    ),
    // F3: a rider may hold more than one delivery; the one already under way
    // stays the main card (picked up, then accepted, then offered).
    orderBy: [
      sql`CASE ${deliveryOrders.status} WHEN 'PICKED_UP' THEN 0 WHEN 'ACCEPTED' THEN 1 ELSE 2 END`,
      desc(deliveryOrders.offeredAt),
    ],
  });
  return row ?? null;
}

/** F3: the rider's other live deliveries besides the main one — normally none. */
export async function getMyOtherActiveDeliveries(
  userId: string,
): Promise<{ id: string; status: string; orderNumber: string; shopName: string; distanceKm: string | null; offeredAt: Date | null }[]> {
  const main = await getMyActiveDeliveryOrder(userId);
  if (!main) return [];
  const rows = await db
    .select({
      id: deliveryOrders.id,
      status: deliveryOrders.status,
      orderNumber: orders.orderNumber,
      shopName: shops.name,
      distanceKm: deliveryOrders.distanceKm,
      offeredAt: deliveryOrders.offeredAt,
    })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        eq(deliveryOrders.deliveryPartnerId, main.deliveryPartnerId),
        inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES),
        sql`${deliveryOrders.id} <> ${main.id}`,
      ),
    )
    .orderBy(desc(deliveryOrders.offeredAt));
  return rows;
}

export async function listMyDeliveryHistory(userId: string, limit = 30): Promise<DeliveryOrder[]> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner) return [];

  return db
    .select()
    .from(deliveryOrders)
    .where(eq(deliveryOrders.deliveryPartnerId, partner.id))
    .orderBy(desc(deliveryOrders.createdAt))
    .limit(limit);
}

export async function getDeliveryOrderForOrder(orderId: string): Promise<DeliveryOrder | null> {
  const row = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, orderId) });
  return row ?? null;
}

export interface DeliveryOrderWithPartnerName extends DeliveryOrder {
  partnerName: string;
}

/** Bulk lookup for a list page — avoids one query per order. */
export async function getDeliveryOrdersForOrders(
  orderIds: readonly string[],
): Promise<Map<string, DeliveryOrderWithPartnerName>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({
      deliveryOrder: deliveryOrders,
      partnerName: deliveryPartners.fullName,
    })
    .from(deliveryOrders)
    .innerJoin(deliveryPartners, eq(deliveryOrders.deliveryPartnerId, deliveryPartners.id))
    .where(inArray(deliveryOrders.orderId, orderIds));
  return new Map(
    rows.map((row) => [row.deliveryOrder.orderId, { ...row.deliveryOrder, partnerName: row.partnerName }]),
  );
}
