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
import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  orders,
  shops,
  type DeliveryOrder,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { ACTIVE_ASSIGNMENT_STATUSES, findEligiblePartnersNearShop } from "./delivery-eligibility";
import { creditDeliveryEarnings } from "./delivery-earnings";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { updateOrderStatus } from "./orders";
import { getSocietyDeliveryNotes, getSocietyDispatchRules, notifySocietySecurity } from "./societies";

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

/** How long a rider has to accept an offer before it moves to the next rider (GA-009). */
export const OFFER_TTL_SECONDS = 120;
/** Wrong delivery-OTP attempts before only an operator can confirm the drop. */
const MAX_OTP_ATTEMPTS = 5;

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
  return [...pool].sort((a, b) => score(a) - score(b));
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

  return db.transaction(async (tx) => {
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
    const candidates = await rankCandidates(
      await findEligiblePartnersNearShop(shopCoords, tx),
      await getSocietyDispatchRules(order.societyId, tx),
      tx,
    );
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

      const stillBusy = await tx.query.deliveryOrders.findFirst({
        where: and(
          eq(deliveryOrders.deliveryPartnerId, candidate.partner.id),
          inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES),
        ),
      });
      if (stillBusy) continue; // lost the race for this partner — try the next nearest

      const legDistanceKm = customerCoords
        ? haversineDistanceKm(shopCoords, customerCoords)
        : candidate.distanceToShopKm;

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
      };

      const [deliveryOrder] = existing
        ? await tx
            .update(deliveryOrders)
            .set(values)
            .where(eq(deliveryOrders.id, existing.id))
            .returning()
        : await tx
            .insert(deliveryOrders)
            .values({ orderId, ...values })
            .returning();

      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.DELIVERY_ORDER_OFFERED,
          entityType: "delivery_order",
          entityId: deliveryOrder.id,
          newValue: { orderId, deliveryPartnerId: candidate.partner.id, distanceKm: legDistanceKm },
        },
        tx,
      );

      await notify(
        {
          userId: candidate.partner.userId,
          type: NOTIFICATION_TYPES.DELIVERY_OFFERED,
          title: "New delivery offer",
          body: `A delivery is available near you (~${legDistanceKm.toFixed(1)} km).`,
          actionUrl: "/delivery-partner",
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
 * DEF-04 fix: the UPDATE's own WHERE clause enforces `status = 'OFFERED'`
 * instead of a separate, unguarded SELECT-then-UPDATE — so two concurrent
 * calls (a double-tap, a client retry) can no longer both pass a check and
 * both write. Whichever one's UPDATE actually matches a row wins; the other
 * gets zero rows back and a clean conflict.
 */
export async function acceptDeliveryOffer(deliveryOrderId: string, partnerUserId: string): Promise<DeliveryOrder> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, partnerUserId); // ownership check
  const actor: Actor = { id: partnerUserId, role: "DELIVERY_PARTNER" };

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
          sql`${deliveryOrders.offeredAt} > now() - make_interval(secs => ${OFFER_TTL_SECONDS})`,
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
    await updateOrderStatus(row.orderId, "ASSIGNED", actor, "Rider accepted", tx);

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

  // GA-009: move straight on to the next nearest rider.
  await dispatchReadyOrder(updated.orderId, { id: null, role: null }).catch((error) => {
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
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, row.orderId));
    if (order?.status === "ASSIGNED") {
      await updateOrderStatus(row.orderId, "PICKED_UP", actor, "Picked up by rider", tx);
    } else {
      await updateOrderStatus(row.orderId, "OUT_FOR_DELIVERY", actor, undefined, tx);
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

/** DEF-04 fix — same one-transaction shape as markPickedUp, see above; earnings are credited inside it too, so a rolled-back delivery can never leave a dangling earnings row. */
export async function markDelivered(
  deliveryOrderId: string,
  actor: Actor,
  otp?: string,
): Promise<DeliveryOrder> {
  const row = await loadOwnDeliveryOrder(deliveryOrderId, actor.id); // ownership check

  // GS-043: the customer's OTP confirms the drop. A delivery picked up
  // before OTPs existed (no code, no start-of-drop time) keeps the old flow.
  if (row.status === "PICKED_UP" && row.pickupCode && !row.outForDeliveryAt) {
    throw conflict("Start the delivery before marking it delivered.");
  }
  if (row.deliveryOtp) {
    if (row.deliveryOtpAttempts >= MAX_OTP_ATTEMPTS) {
      throw conflict("Too many wrong codes — ask operations to confirm this delivery.");
    }
    if (otp?.trim() !== row.deliveryOtp) {
      await db
        .update(deliveryOrders)
        .set({ deliveryOtpAttempts: sql`${deliveryOrders.deliveryOtpAttempts} + 1`, updatedAt: new Date() })
        .where(eq(deliveryOrders.id, deliveryOrderId));
      throw validationFailed("That delivery code does not match. Ask the customer for the code in their order.");
    }
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deliveryOrders)
      .set({
        status: "DELIVERED",
        deliveredAt: new Date(),
        deliveryConfirmation: row.deliveryOtp ? "CUSTOMER_OTP" : null,
        updatedAt: new Date(),
      })
      .where(and(eq(deliveryOrders.id, deliveryOrderId), eq(deliveryOrders.status, "PICKED_UP")))
      .returning();
    if (!updated) throw conflict("This delivery must be picked up before it can be marked delivered.");

    await updateOrderStatus(row.orderId, "DELIVERED", actor, undefined, tx);
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
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deliveryOrders)
      .set({
        outForDeliveryAt: new Date(),
        deliveryOtp: fourDigitCode(),
        deliveryOtpAttempts: 0,
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

    await updateOrderStatus(row.orderId, "OUT_FOR_DELIVERY", actor, "On the way to the customer", tx);
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
    return updated;
  });
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
      .set({ status: "FAILED", failedAt: new Date(), failureReason: trimmed, updatedAt: new Date() })
      .where(and(eq(deliveryOrders.id, deliveryOrderId), eq(deliveryOrders.status, "PICKED_UP")))
      .returning();
    if (!updated) throw conflict("Only a picked-up delivery can be marked failed.");

    await updateOrderStatus(row.orderId, "FAILED", actor, trimmed, tx);
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

  const order = await db.query.orders.findFirst({ where: eq(orders.id, row.orderId) });
  const shop = order ? await db.query.shops.findFirst({ where: eq(shops.id, order.shopId) }) : null;
  if (order && shop) {
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.ORDER_DELIVERY_FAILED,
      title: "Delivery failed",
      body: `Order ${order.orderNumber} could not be delivered: ${trimmed}. The rider will bring it back.`,
      actionUrl: "/shop/orders",
    });
  }
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
): Promise<DeliveryOrder> {
  const note = proofNote.trim();
  if (note.length < 5) throw validationFailed("Record how the delivery was confirmed.");

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deliveryOrders)
      .set({
        status: "DELIVERED",
        deliveredAt: new Date(),
        deliveryConfirmation: "OPERATOR_OVERRIDE",
        proofNote: note,
        updatedAt: new Date(),
      })
      .where(and(eq(deliveryOrders.orderId, orderId), eq(deliveryOrders.status, "PICKED_UP")))
      .returning();
    if (!updated) throw conflict("This order has no picked-up delivery to confirm.");

    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    if (order?.status === "PICKED_UP") {
      await updateOrderStatus(orderId, "OUT_FOR_DELIVERY", actor, "Operator confirmation", tx);
    }
    await updateOrderStatus(orderId, "DELIVERED", actor, `Confirmed by operations: ${note}`, tx);
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

/**
 * Asks for a rider for a READY order (GA-006). Used right after the shop
 * marks an order ready, after a rejection, and by the dispatch cron. Returns
 * null — never throws — when there is nothing to do or nobody is free; the
 * shop is told once and the cron keeps retrying (GA-009).
 */
export async function dispatchReadyOrder(orderId: string, actor: DispatchActor): Promise<DeliveryOrder | null> {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order || order.status !== "READY") return null;
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, order.shopId) });
  if (!shop?.deliveryAvailable) return null; // pickup-only / shop hands over itself

  const existing = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, orderId) });
  if (existing && (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(existing.status)) return null;

  try {
    return await assignNearestPartner(orderId, actor);
  } catch (error) {
    if (!(error instanceof Error) || !/No delivery partner|no verified location/i.test(error.message)) throw error;
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.DELIVERY_UNASSIGNED,
      title: "Looking for a rider",
      body: `No rider has taken order ${order.orderNumber} yet — we keep trying automatically. ${error.message}`,
      actionUrl: "/shop/orders",
      dedupeKey: `delivery-unassigned:${orderId}`,
    });
    return null;
  }
}

/**
 * Offers nobody answered within OFFER_TTL_SECONDS count as declined: the
 * rider is remembered on the row and the order goes to the next rider.
 */
export async function expireStaleOffers(): Promise<number> {
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
        lt(deliveryOrders.offeredAt, sql`now() - make_interval(secs => ${OFFER_TTL_SECONDS})`),
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
    await dispatchReadyOrder(row.orderId, { id: null, role: null }).catch((error) => {
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
    const result = await dispatchReadyOrder(id, { id: null, role: null }).catch((error) => {
      console.error("[delivery] dispatch sweep failed", id, error);
      return null;
    });
    if (result) offered += 1;
  }
  return { expired, attempted: waiting.length, offered };
}

export type RiderDeliveryView = Omit<DeliveryOrder, "pickupCode" | "deliveryOtp" | "rejectedPartnerIds"> & {
  needsPickupCode: boolean;
  needsDeliveryOtp: boolean;
};

/**
 * Strips the handover codes from a delivery row before a rider sees it (API
 * responses, history). The shop gives the pickup code, the customer gives
 * the OTP — a rider who could read either could confirm a handover alone.
 */
export function toRiderView(row: DeliveryOrder): RiderDeliveryView {
  const { pickupCode, deliveryOtp, rejectedPartnerIds: _rejected, ...safe } = row;
  void _rejected;
  return { ...safe, needsPickupCode: pickupCode != null, needsDeliveryOtp: deliveryOtp != null };
}

/**
 * The rider's view of their active job. The pickup code and the customer's
 * OTP are deliberately NOT included — the rider must get them from the shop
 * and the customer, or the handover checks mean nothing. Only flags saying
 * which code is expected are exposed.
 */
export interface ActiveDeliveryDetail
  extends Omit<DeliveryOrder, "pickupCode" | "deliveryOtp" | "rejectedPartnerIds"> {
  needsPickupCode: boolean;
  needsDeliveryOtp: boolean;
  orderNumber: string;
  orderTotalPaise: number;
  shopName: string;
  shopAddress: string;
  customerAddress: string | null;
  /** Landmark / the customer's own delivery instructions (GS-047). */
  customerNotes: string | null;
  /** Society gate / parking / access notes for society deliveries (GS-047). */
  societyName: string | null;
  societyInstructions: string | null;
}

/** Enriched view for the delivery-partner dashboard — pickup/drop details a rider needs, no map integration. */
export async function getMyActiveDeliveryDetail(userId: string): Promise<ActiveDeliveryDetail | null> {
  const active = await getMyActiveDeliveryOrder(userId);
  if (!active) return null;

  const [row] = await db
    .select({
      orderNumber: orders.orderNumber,
      orderTotalPaise: orders.totalPaise,
      deliveryAddressSnapshot: orders.deliveryAddressSnapshot,
      societyId: orders.societyId,
      shopName: shops.name,
      addressLine1: shops.addressLine1,
      addressLine2: shops.addressLine2,
      city: shops.city,
    })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(eq(orders.id, active.orderId));
  if (!row) return null;

  // Only the rider holding this active job gets the society's gate notes.
  const society = await getSocietyDeliveryNotes(row.societyId);
  const customerAddress = row.deliveryAddressSnapshot
    ? [row.deliveryAddressSnapshot.line1, row.deliveryAddressSnapshot.area, row.deliveryAddressSnapshot.city]
        .filter(Boolean)
        .join(", ")
    : null;

  // Strip both codes before this leaves the server (see ActiveDeliveryDetail).
  const { pickupCode, deliveryOtp, rejectedPartnerIds: _rejected, ...safe } = active;
  void _rejected;
  return {
    ...safe,
    needsPickupCode: pickupCode != null,
    needsDeliveryOtp: deliveryOtp != null,
    orderNumber: row.orderNumber,
    orderTotalPaise: row.orderTotalPaise,
    shopName: row.shopName,
    shopAddress: [row.addressLine1, row.addressLine2, row.city].filter(Boolean).join(", "),
    customerAddress,
    customerNotes:
      [row.deliveryAddressSnapshot?.landmark, row.deliveryAddressSnapshot?.deliveryInstructions]
        .filter(Boolean)
        .join(" · ") || null,
    societyName: society?.name ?? null,
    societyInstructions: society?.instructions ?? null,
  };
}

export async function getMyActiveDeliveryOrder(userId: string): Promise<DeliveryOrder | null> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner) return null;

  const row = await db.query.deliveryOrders.findFirst({
    where: and(
      eq(deliveryOrders.deliveryPartnerId, partner.id),
      inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES),
    ),
    orderBy: desc(deliveryOrders.offeredAt),
  });
  return row ?? null;
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
