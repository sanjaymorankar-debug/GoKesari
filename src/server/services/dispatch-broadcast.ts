/**
 * Broadcast rider offers with radius widening (F3.3.2, GAP-004 —
 * batch-2026-10 WS-B). Rule `dispatchBroadcast`; with it off (the default)
 * nothing here runs and the single-offer flow in delivery-assignment.ts is
 * exactly as before.
 *
 * How it works, on top of the single offer:
 *  1. The timeout-sweep (every minute) finds a single offer nobody accepted
 *     within `singleOfferSeconds`. Its delivery row moves OFFERED → REJECTED
 *     ("broadcast") and a delivery_offer_broadcasts row opens with the first
 *     radius. Every eligible rider within that radius of the shop gets a
 *     recipient row and a notification (event delivery.broadcast_step). The
 *     original rider is one of them.
 *  2. Every `stepSeconds` the radius widens to the next value (up to
 *     `maxRadiusKm`), reaching more riders. After the last step the broadcast
 *     expires and the normal rider search carries on (dispatchReadyOrder).
 *  3. A rider accepts: ONE conditional UPDATE on the broadcast row
 *     (`status = 'OPEN'` → TAKEN) is the lock — two riders accepting at the
 *     same moment serialise on that row, the second finds it TAKEN and gets
 *     "Offer taken". The winner's transaction then hands the delivery row to
 *     them and runs the existing accept (acceptOfferInTransaction: ACCEPTED,
 *     pickup code, order ASSIGNED, events); everyone else's recipient row
 *     becomes TAKEN_BY_OTHER and they are told at once (delivery.offer_taken).
 *
 * Eligibility is the existing one (delivery-eligibility.ts): approved, online,
 * not deleted, within the rider's own operating radius, free — or busy within
 * the dispatch busy-rider fallback — never a rider who declined this order,
 * and only a society's riders when the society is exclusive.
 */
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound } from "@/lib/errors";
import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOfferBroadcasts,
  deliveryOfferRecipients,
  deliveryOrders,
  deliveryPartners,
  orders,
  shops,
  type DeliveryOfferBroadcast,
  type DeliveryOrder,
  type Order,
  type Shop,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { acceptOfferInTransaction, dispatchReadyOrder } from "./delivery-assignment";
import { previewEarning } from "./delivery-earnings";
import { countActiveAssignments, findEligiblePartnersNearShop } from "./delivery-eligibility";
import { getRule } from "./settings";
import { getSocietyDispatchRules, notifySocietySecurity } from "./societies";

type BroadcastRule = Awaited<ReturnType<typeof getBroadcastRule>>;

function getBroadcastRule() {
  return getRule("dispatchBroadcast");
}

const SYSTEM = { id: null, role: null } as const;

/** The radii actually used: the rule's list, capped at maxRadiusKm (never empty). */
export function effectiveRadiiKm(rule: { radiiKm: number[]; maxRadiusKm: number }): number[] {
  const radii = rule.radiiKm.filter((r) => r <= rule.maxRadiusKm);
  return radii.length > 0 ? radii : [rule.maxRadiusKm];
}

/** Seconds the first rider has before a single offer is broadcast (never longer than the offer itself lives). */
export async function singleOfferWindowSeconds(): Promise<number> {
  const [rule, dispatch] = await Promise.all([getBroadcastRule(), getRule("dispatch")]);
  return Math.min(rule.singleOfferSeconds, dispatch.offerTtlSeconds);
}

/** What the rider dashboard needs to know about broadcasting; null when the rule is off. */
export async function getRiderBroadcastSettings(): Promise<{ pollSeconds: number; singleOfferSeconds: number } | null> {
  const rule = await getBroadcastRule();
  if (!rule.enabled) return null;
  return { pollSeconds: rule.riderPollSeconds, singleOfferSeconds: await singleOfferWindowSeconds() };
}

const offerTakenError = () =>
  conflict("Offer taken — another rider accepted this order first.", { reason: "OFFER_TAKEN" });

class SupersededError extends Error {}

/* ------------------------------------------------------------------ sweep */

export interface BroadcastSweepResult {
  enabled: boolean;
  started: number;
  widened: number;
  expired: number;
  closed: number;
}

/**
 * Timeout-sweep step: turn stale single offers into broadcasts, widen open
 * broadcasts whose step is over, and end the ones past their last step.
 * Idempotent; overlapping runs are safe (every move is a conditional UPDATE).
 */
export async function runBroadcastSweep(now: Date = new Date()): Promise<BroadcastSweepResult> {
  const rule = await getBroadcastRule();
  const result: BroadcastSweepResult = { enabled: rule.enabled, started: 0, widened: 0, expired: 0, closed: 0 };
  if (!rule.enabled) return result;
  const radii = effectiveRadiiKm(rule);

  // 1. Single offers nobody accepted in time.
  const cutoff = new Date(now.getTime() - (await singleOfferWindowSeconds()) * 1000);
  const stale = await db
    .select({ delivery: deliveryOrders, order: orders, shop: shops })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        eq(deliveryOrders.status, "OFFERED"),
        // A batched offer (GA-005) belongs to one rider's trip — it keeps the single-offer flow.
        isNull(deliveryOrders.tripId),
        lte(deliveryOrders.offeredAt, cutoff),
        eq(orders.status, "READY"),
      ),
    )
    .limit(100);
  for (const { delivery, order, shop } of stale) {
    try {
      if (await startBroadcast(delivery, order, shop, rule, radii, cutoff, now)) result.started += 1;
    } catch (error) {
      console.error("[dispatch-broadcast] could not start broadcast", delivery.id, error);
    }
  }

  // 2. Open broadcasts whose current step is over.
  const due = await db
    .select()
    .from(deliveryOfferBroadcasts)
    .where(and(eq(deliveryOfferBroadcasts.status, "OPEN"), lte(deliveryOfferBroadcasts.nextStepAt, now)))
    .limit(100);
  for (const broadcast of due) {
    try {
      const outcome = await advanceBroadcast(broadcast, rule, radii, now);
      if (outcome === "WIDENED") result.widened += 1;
      else if (outcome === "EXPIRED") result.expired += 1;
      else if (outcome === "CLOSED") result.closed += 1;
    } catch (error) {
      console.error("[dispatch-broadcast] could not advance broadcast", broadcast.id, error);
    }
  }
  return result;
}

async function startBroadcast(
  delivery: DeliveryOrder,
  order: Order,
  shop: Shop,
  rule: BroadcastRule,
  radii: number[],
  cutoff: Date,
  now: Date,
): Promise<boolean> {
  const shopCoords = parseCoordinates(shop.latitude, shop.longitude);
  if (!shopCoords) return false;
  const radiusKm = radii[0];

  return db.transaction(async (tx) => {
    // The single offer ends here — unless its rider accepted in the meantime.
    const [converted] = await tx
      .update(deliveryOrders)
      .set({
        status: "REJECTED",
        cancelledAt: now,
        cancellationReason: "Offer broadcast to riders nearby",
        updatedAt: now,
      })
      .where(
        and(eq(deliveryOrders.id, delivery.id), eq(deliveryOrders.status, "OFFERED"), lte(deliveryOrders.offeredAt, cutoff)),
      )
      .returning();
    if (!converted) return false;

    const [broadcast] = await tx
      .insert(deliveryOfferBroadcasts)
      .values({
        orderId: order.id,
        deliveryOrderId: delivery.id,
        status: "OPEN",
        step: 0,
        radiusM: Math.round(radiusKm * 1000),
        originalPartnerId: delivery.deliveryPartnerId,
        startedAt: now,
        nextStepAt: new Date(now.getTime() + rule.stepSeconds * 1000),
      })
      .returning();

    const recipients = await addRecipients(tx, {
      broadcast,
      order,
      shopCoords,
      declined: converted.rejectedPartnerIds,
      step: 0,
      radiusKm,
      maxRecipients: rule.maxRecipientsPerStep,
      holderPartnerId: delivery.deliveryPartnerId,
      now,
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.DELIVERY_OFFER_BROADCAST,
        entityType: "delivery_order",
        entityId: delivery.id,
        previousValue: { status: "OFFERED", deliveryPartnerId: delivery.deliveryPartnerId },
        newValue: { broadcastId: broadcast.id, step: 0, radiusKm, recipients: recipients.length },
      },
      tx,
    );
    await emitEvent(
      {
        type: "delivery.broadcast_step",
        subjectId: delivery.id,
        orderId: order.id,
        transition: { from: "OFFERED", to: "REJECTED" },
        actor: SYSTEM,
        payload: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          buyerId: order.userId,
          shopOwnerId: shop.ownerId,
          shopLabel: shop.name,
          riderUserId: null,
          broadcastId: broadcast.id,
          step: 0,
          radiusKm,
          recipients,
        },
        idempotencyKey: `broadcast-step:${broadcast.id}:0`,
      },
      tx,
    );
    return true;
  });
}

/** Adds this step's riders (nearest first) and returns who was newly reached. */
async function addRecipients(
  tx: DbClient,
  input: {
    broadcast: DeliveryOfferBroadcast;
    order: Order;
    shopCoords: { latitude: number; longitude: number };
    declined: readonly string[];
    step: number;
    radiusKm: number;
    maxRecipients: number;
    /** The rider who held the single offer: always reached at step 0. */
    holderPartnerId?: string;
    now: Date;
  },
): Promise<{ userId: string; distanceKm: number }[]> {
  const dispatch = await getRule("dispatch");
  const busyCap = dispatch.busyRidersAsFallback ? dispatch.maxActiveDeliveriesPerRider : 0;
  const eligible = await findEligiblePartnersNearShop(input.shopCoords, tx, busyCap ? { includeBusyUpTo: busyCap } : {});
  const society = await getSocietyDispatchRules(input.order.societyId, tx);
  const already = new Set(
    (
      await tx
        .select({ id: deliveryOfferRecipients.deliveryPartnerId })
        .from(deliveryOfferRecipients)
        .where(eq(deliveryOfferRecipients.broadcastId, input.broadcast.id))
    ).map((r) => r.id),
  );
  const declined = new Set(input.declined);
  const allowed = (partnerId: string) =>
    !declined.has(partnerId) && !already.has(partnerId) && (!society?.exclusive || society.riders.has(partnerId));

  // The original rider does not take one of the step's places (added below).
  const picked = eligible
    .filter((c) => c.distanceToShopKm <= input.radiusKm && allowed(c.partner.id) && c.partner.id !== input.holderPartnerId)
    .slice(0, input.maxRecipients)
    .map((c) => ({ partnerId: c.partner.id, userId: c.partner.userId, distanceKm: c.distanceToShopKm }));

  if (input.holderPartnerId && allowed(input.holderPartnerId)) {
    const holder = await tx.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, input.holderPartnerId) });
    const coords = holder ? parseCoordinates(holder.lastLocationLatitude, holder.lastLocationLongitude) : null;
    if (holder && holder.status === "APPROVED" && holder.isOnline && !holder.deletedAt) {
      picked.unshift({
        partnerId: holder.id,
        userId: holder.userId,
        distanceKm: coords ? haversineDistanceKm(input.shopCoords, coords) : 0,
      });
    }
  }
  if (picked.length === 0) return [];

  const inserted = await tx
    .insert(deliveryOfferRecipients)
    .values(
      picked.map((p) => ({
        broadcastId: input.broadcast.id,
        orderId: input.order.id,
        deliveryOrderId: input.broadcast.deliveryOrderId,
        deliveryPartnerId: p.partnerId,
        radiusStep: input.step,
        distanceToShopKm: p.distanceKm.toFixed(2),
        offeredAt: input.now,
      })),
    )
    .onConflictDoNothing()
    .returning({ partnerId: deliveryOfferRecipients.deliveryPartnerId });
  const added = new Set(inserted.map((r) => r.partnerId));
  return picked
    .filter((p) => added.has(p.partnerId))
    .map((p) => ({ userId: p.userId, distanceKm: Math.round(p.distanceKm * 10) / 10 }));
}

async function advanceBroadcast(
  broadcast: DeliveryOfferBroadcast,
  rule: BroadcastRule,
  radii: number[],
  now: Date,
): Promise<"WIDENED" | "EXPIRED" | "CLOSED" | null> {
  const [row] = await db
    .select({ order: orders, shop: shops, delivery: deliveryOrders })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .innerJoin(deliveryOrders, eq(deliveryOrders.id, broadcast.deliveryOrderId))
    .where(eq(orders.id, broadcast.orderId));
  if (!row || row.order.status !== "READY") {
    return (await closeBroadcast(broadcast.id, "CANCELLED", "The order is no longer waiting for a rider.", now)) ? "CLOSED" : null;
  }
  if (row.delivery.status !== "REJECTED" && row.delivery.status !== "CANCELLED") {
    // Someone (operations' reassign) offered the order to a rider directly meanwhile.
    return (await closeBroadcast(broadcast.id, "CANCELLED", "Superseded by a direct offer.", now)) ? "CLOSED" : null;
  }
  const shopCoords = parseCoordinates(row.shop.latitude, row.shop.longitude);

  const nextStep = broadcast.step + 1;
  if (nextStep < radii.length && shopCoords) {
    const radiusKm = radii[nextStep];
    const widened = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(deliveryOfferBroadcasts)
        .set({
          step: nextStep,
          radiusM: Math.round(radiusKm * 1000),
          nextStepAt: new Date(now.getTime() + rule.stepSeconds * 1000),
          updatedAt: now,
        })
        .where(
          and(
            eq(deliveryOfferBroadcasts.id, broadcast.id),
            eq(deliveryOfferBroadcasts.status, "OPEN"),
            eq(deliveryOfferBroadcasts.step, broadcast.step),
          ),
        )
        .returning();
      if (!claimed) return false;
      const recipients = await addRecipients(tx, {
        broadcast: claimed,
        order: row.order,
        shopCoords,
        declined: row.delivery.rejectedPartnerIds,
        step: nextStep,
        radiusKm,
        maxRecipients: rule.maxRecipientsPerStep,
        now,
      });
      if (recipients.length > 0) {
        await emitEvent(
          {
            type: "delivery.broadcast_step",
            subjectId: row.delivery.id,
            orderId: row.order.id,
            actor: SYSTEM,
            payload: {
              orderId: row.order.id,
              orderNumber: row.order.orderNumber,
              buyerId: row.order.userId,
              shopOwnerId: row.shop.ownerId,
              shopLabel: row.shop.name,
              riderUserId: null,
              broadcastId: broadcast.id,
              step: nextStep,
              radiusKm,
              recipients,
            },
            idempotencyKey: `broadcast-step:${broadcast.id}:${nextStep}`,
          },
          tx,
        );
      }
      return true;
    });
    return widened ? "WIDENED" : null;
  }

  // Past the last step: nobody accepted.
  const expired = await db.transaction(async (tx) => {
    const closed = await closeBroadcast(broadcast.id, "EXPIRED", "No rider accepted within the broadcast.", now, tx);
    if (!closed) return false;
    // GA-009: the rider who let the single offer lapse is not offered this order again.
    if (broadcast.originalPartnerId) {
      await tx
        .update(deliveryOrders)
        .set({
          rejectedPartnerIds: sql`array_append(${deliveryOrders.rejectedPartnerIds}, ${broadcast.originalPartnerId}::uuid)`,
          updatedAt: now,
        })
        .where(
          and(
            eq(deliveryOrders.id, broadcast.deliveryOrderId),
            inArray(deliveryOrders.status, ["REJECTED", "CANCELLED"]),
            sql`NOT (${broadcast.originalPartnerId}::uuid = ANY(${deliveryOrders.rejectedPartnerIds}))`,
          ),
        );
    }
    return true;
  });
  if (!expired) return null;
  // The normal search carries on (retry pace and limits of rule dispatch).
  await dispatchReadyOrder(broadcast.orderId, SYSTEM, "REOFFER").catch((error) => {
    console.error("[dispatch-broadcast] re-offer after broadcast failed", broadcast.orderId, error);
  });
  return "EXPIRED";
}

/** Ends an open broadcast; riders still holding it see it expire. False when it was no longer open. */
async function closeBroadcast(
  broadcastId: string,
  status: "EXPIRED" | "CANCELLED",
  reason: string,
  now: Date,
  client: DbClient = db,
): Promise<boolean> {
  const [closed] = await client
    .update(deliveryOfferBroadcasts)
    .set({ status, closedAt: now, closeReason: reason, updatedAt: now })
    .where(and(eq(deliveryOfferBroadcasts.id, broadcastId), eq(deliveryOfferBroadcasts.status, "OPEN")))
    .returning();
  if (!closed) return false;
  await client
    .update(deliveryOfferRecipients)
    .set({ outcome: "EXPIRED", outcomeAt: now })
    .where(and(eq(deliveryOfferRecipients.broadcastId, broadcastId), eq(deliveryOfferRecipients.outcome, "OFFERED")));
  await recordAudit(
    {
      action: AUDIT_ACTIONS.DELIVERY_BROADCAST_CLOSED,
      entityType: "delivery_order",
      entityId: closed.deliveryOrderId,
      newValue: { broadcastId, status, reason },
    },
    client,
  );
  return true;
}

/** TC-DSP-011: a cancelled order's open broadcast ends with it; riders holding it see it expire. */
export async function closeOpenBroadcastsForOrder(orderId: string, reason: string, client: DbClient = db): Promise<number> {
  const open = await client
    .select({ id: deliveryOfferBroadcasts.id })
    .from(deliveryOfferBroadcasts)
    .where(and(eq(deliveryOfferBroadcasts.orderId, orderId), eq(deliveryOfferBroadcasts.status, "OPEN")));
  let closed = 0;
  for (const broadcast of open) {
    if (await closeBroadcast(broadcast.id, "CANCELLED", reason, new Date(), client)) closed += 1;
  }
  return closed;
}

/* ------------------------------------------------------------- rider side */

async function loadRecipient(broadcastId: string, partnerUserId: string) {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, partnerUserId) });
  if (!partner || partner.status !== "APPROVED" || partner.deletedAt) {
    throw forbidden("Only an approved delivery partner can take delivery offers.");
  }
  const [recipient] = await db
    .select()
    .from(deliveryOfferRecipients)
    .where(and(eq(deliveryOfferRecipients.broadcastId, broadcastId), eq(deliveryOfferRecipients.deliveryPartnerId, partner.id)));
  if (!recipient) throw forbidden("This offer was not sent to you.");
  const [broadcast] = await db.select().from(deliveryOfferBroadcasts).where(eq(deliveryOfferBroadcasts.id, broadcastId));
  if (!broadcast) throw notFound("Delivery offer");
  return { partner, recipient, broadcast };
}

/**
 * First acceptance wins. The conditional UPDATE of the broadcast row from
 * OPEN to TAKEN is the lock: of two riders accepting at once exactly one
 * matches it; the other gets "Offer taken". Everything else — the delivery row
 * handed to the winner, the existing accept, the losers told — happens in the
 * winner's transaction, so a failure anywhere leaves the broadcast open.
 */
export async function acceptBroadcastOffer(broadcastId: string, partnerUserId: string): Promise<DeliveryOrder> {
  const { partner, recipient, broadcast } = await loadRecipient(broadcastId, partnerUserId);
  if (recipient.outcome === "DECLINED") throw conflict("You declined this offer.");
  if (broadcast.status === "EXPIRED" || broadcast.status === "CANCELLED") {
    throw conflict("This offer has expired.", { reason: "OFFER_EXPIRED" });
  }
  if (broadcast.status !== "OPEN") throw offerTakenError();

  const dispatch = await getRule("dispatch");
  const cap = dispatch.busyRidersAsFallback ? dispatch.maxActiveDeliveriesPerRider : 1;

  let accepted: DeliveryOrder;
  try {
    accepted = await db.transaction(async (tx) => {
      const now = new Date();
      // Same per-rider lock as assignNearestPartner, so a rider never ends up over their limit.
      await tx.select({ id: deliveryPartners.id }).from(deliveryPartners).where(eq(deliveryPartners.id, partner.id)).for("update");
      if ((await countActiveAssignments(partner.id, tx)) >= cap) {
        throw conflict("Finish your current delivery before taking another one.");
      }

      // THE lock — first acceptance wins.
      const [claimed] = await tx
        .update(deliveryOfferBroadcasts)
        .set({ status: "TAKEN", winnerPartnerId: partner.id, takenAt: now, closedAt: now, closeReason: "Accepted", updatedAt: now })
        .where(and(eq(deliveryOfferBroadcasts.id, broadcastId), eq(deliveryOfferBroadcasts.status, "OPEN")))
        .returning();
      if (!claimed) throw offerTakenError();

      // The order's delivery row becomes this rider's offer (REJECTED → OFFERED,
      // an allowed move) and is accepted at once through the existing path.
      const [offer] = await tx
        .update(deliveryOrders)
        .set({
          status: "OFFERED",
          deliveryPartnerId: partner.id,
          offeredAt: now,
          acceptedAt: null,
          cancelledAt: null,
          cancellationReason: null,
          pickupDurationSeconds: null,
          tripId: null,
          updatedAt: now,
        })
        .where(and(eq(deliveryOrders.id, claimed.deliveryOrderId), inArray(deliveryOrders.status, ["REJECTED", "CANCELLED"])))
        .returning();
      if (!offer) throw new SupersededError();
      const result = await acceptOfferInTransaction(tx, offer, partnerUserId, null);

      await tx
        .update(deliveryOfferRecipients)
        .set({ outcome: "ACCEPTED", outcomeAt: now })
        .where(eq(deliveryOfferRecipients.id, recipient.id));
      const losers = await tx
        .update(deliveryOfferRecipients)
        .set({ outcome: "TAKEN_BY_OTHER", outcomeAt: now })
        .where(and(eq(deliveryOfferRecipients.broadcastId, broadcastId), eq(deliveryOfferRecipients.outcome, "OFFERED")))
        .returning({ partnerId: deliveryOfferRecipients.deliveryPartnerId });
      const loserUserIds = losers.length
        ? (
            await tx
              .select({ userId: deliveryPartners.userId })
              .from(deliveryPartners)
              .where(inArray(deliveryPartners.id, losers.map((l) => l.partnerId)))
          ).map((r) => r.userId)
        : [];

      const [order] = await tx
        .select({ orderNumber: orders.orderNumber, buyerId: orders.userId, shopOwnerId: shops.ownerId })
        .from(orders)
        .innerJoin(shops, eq(shops.id, orders.shopId))
        .where(eq(orders.id, claimed.orderId));
      await emitEvent(
        {
          type: "delivery.offer_taken",
          subjectId: claimed.deliveryOrderId,
          orderId: claimed.orderId,
          actor: { id: partnerUserId, role: "DELIVERY_PARTNER" },
          payload: {
            orderId: claimed.orderId,
            orderNumber: order?.orderNumber ?? "",
            buyerId: order?.buyerId ?? "",
            shopOwnerId: order?.shopOwnerId ?? null,
            riderUserId: partnerUserId,
            broadcastId,
            loserUserIds,
          },
          idempotencyKey: `broadcast-taken:${broadcastId}`,
        },
        tx,
      );
      await recordAudit(
        {
          actorId: partnerUserId,
          actorRole: "DELIVERY_PARTNER",
          action: AUDIT_ACTIONS.DELIVERY_BROADCAST_ACCEPTED,
          entityType: "delivery_order",
          entityId: claimed.deliveryOrderId,
          newValue: { broadcastId, step: claimed.step, radiusM: claimed.radiusM, others: loserUserIds.length },
        },
        tx,
      );
      return result;
    });
  } catch (error) {
    if (error instanceof SupersededError) {
      await closeBroadcast(broadcastId, "CANCELLED", "Superseded by a direct offer.", new Date());
      throw offerTakenError();
    }
    throw error;
  }

  await notifySocietySecurity(accepted.orderId).catch((error) => {
    console.error("[dispatch-broadcast] society security notification failed", accepted.orderId, error);
  });
  return accepted;
}

/** The rider passes on a broadcast offer; they are not offered this order again (GA-009). */
export async function declineBroadcastOffer(broadcastId: string, partnerUserId: string): Promise<void> {
  const { partner, recipient, broadcast } = await loadRecipient(broadcastId, partnerUserId);
  if (recipient.outcome !== "OFFERED") return;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(deliveryOfferRecipients)
      .set({ outcome: "DECLINED", outcomeAt: now })
      .where(and(eq(deliveryOfferRecipients.id, recipient.id), eq(deliveryOfferRecipients.outcome, "OFFERED")));
    await tx
      .update(deliveryOrders)
      .set({ rejectedPartnerIds: sql`array_append(${deliveryOrders.rejectedPartnerIds}, ${partner.id}::uuid)` })
      .where(
        and(
          eq(deliveryOrders.id, broadcast.deliveryOrderId),
          sql`NOT (${partner.id}::uuid = ANY(${deliveryOrders.rejectedPartnerIds}))`,
        ),
      );
  });
}

export interface RiderBroadcastOffer {
  broadcastId: string;
  /** OPEN: can still be accepted. TAKEN: another rider got it first. EXPIRED: nobody / the order moved on. */
  state: "OPEN" | "TAKEN" | "EXPIRED";
  orderNumber: string;
  shopName: string;
  shopArea: string;
  /** Rider → shop when the offer went out (straight line). */
  distanceToShopKm: number | null;
  /** Shop → customer leg. */
  deliveryLegKm: number | null;
  /** What the delivery would earn, from the earnings rules (null when it cannot be worked out). */
  earningsPaise: number | null;
  /** When the offer stops being open (end of the last radius step). */
  expiresAt: string | null;
  secondsLeft: number | null;
}

/** The signed-in rider's open broadcast offers, plus recently taken/expired ones ("Offer taken"). */
export async function listMyBroadcastOffers(userId: string, now: Date = new Date()): Promise<RiderBroadcastOffer[]> {
  const rule = await getBroadcastRule();
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner) return [];
  const radii = effectiveRadiiKm(rule);
  const noticeFrom = new Date(now.getTime() - rule.takenNoticeSeconds * 1000);

  const rows = await db
    .select({
      recipient: deliveryOfferRecipients,
      broadcast: deliveryOfferBroadcasts,
      orderNumber: orders.orderNumber,
      subtotalPaise: orders.subtotalPaise,
      shopName: shops.name,
      shopArea: shops.city,
      legKm: deliveryOrders.distanceKm,
    })
    .from(deliveryOfferRecipients)
    .innerJoin(deliveryOfferBroadcasts, eq(deliveryOfferBroadcasts.id, deliveryOfferRecipients.broadcastId))
    .innerJoin(orders, eq(orders.id, deliveryOfferRecipients.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .innerJoin(deliveryOrders, eq(deliveryOrders.id, deliveryOfferRecipients.deliveryOrderId))
    .where(
      and(
        eq(deliveryOfferRecipients.deliveryPartnerId, partner.id),
        or(
          and(eq(deliveryOfferRecipients.outcome, "OFFERED"), eq(deliveryOfferBroadcasts.status, "OPEN")),
          and(
            inArray(deliveryOfferRecipients.outcome, ["TAKEN_BY_OTHER", "EXPIRED"]),
            gt(deliveryOfferRecipients.outcomeAt, noticeFrom),
          ),
        ),
      ),
    )
    .orderBy(desc(deliveryOfferRecipients.offeredAt))
    .limit(20);

  const unseen = rows.filter((r) => r.recipient.outcome === "OFFERED" && !r.recipient.seenAt).map((r) => r.recipient.id);
  if (unseen.length > 0) {
    await db.update(deliveryOfferRecipients).set({ seenAt: now }).where(inArray(deliveryOfferRecipients.id, unseen));
  }

  const offers: RiderBroadcastOffer[] = [];
  for (const r of rows) {
    const open = r.recipient.outcome === "OFFERED";
    const stepsLeft = Math.max(0, radii.length - 1 - r.broadcast.step);
    const expires = open ? new Date(r.broadcast.nextStepAt.getTime() + stepsLeft * rule.stepSeconds * 1000) : null;
    const legKm = r.legKm != null ? Number(r.legKm) : null;
    let earningsPaise: number | null = null;
    if (open && legKm != null && Number.isFinite(legKm)) {
      earningsPaise = await previewEarning({ distanceKm: legKm, orderSubtotalPaise: r.subtotalPaise, at: now })
        .then((e) => e.totalPaise)
        .catch(() => null);
    }
    offers.push({
      broadcastId: r.broadcast.id,
      state: open ? "OPEN" : r.recipient.outcome === "TAKEN_BY_OTHER" ? "TAKEN" : "EXPIRED",
      orderNumber: r.orderNumber,
      shopName: r.shopName,
      shopArea: r.shopArea,
      distanceToShopKm: r.recipient.distanceToShopKm != null ? Number(r.recipient.distanceToShopKm) : null,
      deliveryLegKm: legKm != null && Number.isFinite(legKm) ? Math.round(legKm * 10) / 10 : null,
      earningsPaise,
      expiresAt: expires ? expires.toISOString() : null,
      secondsLeft: expires ? Math.max(0, Math.round((expires.getTime() - now.getTime()) / 1000)) : null,
    });
  }
  return offers;
}
