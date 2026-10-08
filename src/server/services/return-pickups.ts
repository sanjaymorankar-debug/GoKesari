/**
 * Return pickups — a rider collects approved goods from the customer and
 * brings them back to the shop.
 *
 * Matching mirrors delivery dispatch in miniature: the nearest eligible rider
 * to the customer gets an offer that lapses after `dispatch.offerTtlSeconds`;
 * declined or lapsed riders are never re-offered that pickup; attempts are
 * bounded by `dispatch.maxAttempts`, then the shop/operations are told and can
 * retry. A rider never sees the handover code — the customer reads it out.
 */
import { randomInt } from "node:crypto";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { parseCoordinates } from "@/lib/geo/haversine";
import { db, type DbClient } from "@/server/db";
import {
  deliveryPartners,
  orders,
  returnItems,
  returnPickups,
  returnRequests,
  shops,
  type ReturnPickup,
  type ReturnRequest,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { creditReturnPickupEarning } from "./delivery-earnings";
import { findEligiblePartnersNearShop } from "./delivery-eligibility";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { transitionReturn } from "./return-transition";
import { getRule } from "./settings";
import { getSocietyDispatchRules } from "./societies";

interface Actor {
  id: string;
  role: UserRole;
}

/** A pickup in one of these is "live": a rider is, or will be, working on it. */
export const LIVE_PICKUP_STATUSES = ["PENDING", "OFFERED", "ACCEPTED", "EN_ROUTE"] as const;
const RIDER_BUSY_PICKUP_STATUSES = ["OFFERED", "ACCEPTED", "EN_ROUTE"] as const;

const fourDigitCode = () => String(randomInt(0, 10_000)).padStart(4, "0");

/** Creates the pending pickup for an approved return (inside the approval's transaction). */
export async function createPickup(returnId: string, client: DbClient = db): Promise<ReturnPickup> {
  const [live] = await client
    .select()
    .from(returnPickups)
    .where(and(eq(returnPickups.returnId, returnId), inArray(returnPickups.status, [...LIVE_PICKUP_STATUSES])));
  if (live) return live;
  const [created] = await client.insert(returnPickups).values({ returnId, handoverCode: fourDigitCode() }).returning();
  return created;
}

async function loadOwnPickup(pickupId: string, partnerUserId: string) {
  const [row] = await db
    .select({ pickup: returnPickups, partnerUserId: deliveryPartners.userId })
    .from(returnPickups)
    .leftJoin(deliveryPartners, eq(returnPickups.deliveryPartnerId, deliveryPartners.id))
    .where(eq(returnPickups.id, pickupId));
  if (!row) throw notFound("Return pickup");
  if (row.partnerUserId !== partnerUserId) throw forbidden("This pickup does not belong to you.");
  return row.pickup;
}

/**
 * Offers a PENDING pickup to the nearest eligible rider. Returns null (never
 * throws) when nobody is available; the sweep tries again later.
 */
export async function offerPickup(pickupId: string): Promise<ReturnPickup | null> {
  const dispatch = await getRule("dispatch");

  const [pickup] = await db.select().from(returnPickups).where(eq(returnPickups.id, pickupId));
  if (!pickup || pickup.status !== "PENDING") return null;
  const [ret] = await db.select().from(returnRequests).where(eq(returnRequests.id, pickup.returnId));
  if (!ret || ret.status !== "APPROVED") return null;
  if (pickup.attempts >= dispatch.maxAttempts) return null;

  const coords = parseCoordinates(
    (ret.pickupAddress?.latitude as string | null | undefined) ?? null,
    (ret.pickupAddress?.longitude as string | null | undefined) ?? null,
  );
  const [order] = await db.select().from(orders).where(eq(orders.id, ret.orderId));
  const [shop] = await db.select().from(shops).where(eq(shops.id, ret.shopId));
  // Without a pinned customer location, search around the shop instead.
  const origin = coords ?? parseCoordinates(shop?.latitude ?? null, shop?.longitude ?? null);
  if (!origin || !order) return null;

  const offered = await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(returnPickups).where(eq(returnPickups.id, pickupId)).for("update");
    if (!fresh || fresh.status !== "PENDING") return null;

    const rules = await getSocietyDispatchRules(order.societyId, tx);
    let candidates = await findEligiblePartnersNearShop(origin, tx);
    if (rules?.exclusive) candidates = candidates.filter((c) => rules.riders.has(c.partner.id));
    const declined = new Set(fresh.rejectedPartnerIds);

    for (const candidate of candidates) {
      if (declined.has(candidate.partner.id)) continue;
      const [locked] = await tx
        .select({ id: deliveryPartners.id })
        .from(deliveryPartners)
        .where(eq(deliveryPartners.id, candidate.partner.id))
        .for("update");
      if (!locked) continue;
      const [busy] = await tx
        .select({ id: returnPickups.id })
        .from(returnPickups)
        .where(
          and(
            eq(returnPickups.deliveryPartnerId, candidate.partner.id),
            inArray(returnPickups.status, [...RIDER_BUSY_PICKUP_STATUSES]),
          ),
        );
      if (busy) continue;

      const [updated] = await tx
        .update(returnPickups)
        .set({
          deliveryPartnerId: candidate.partner.id,
          status: "OFFERED",
          offeredAt: new Date(),
          attempts: fresh.attempts + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(returnPickups.id, pickupId), eq(returnPickups.status, "PENDING")))
        .returning();
      if (!updated) return null;
      await recordAudit(
        {
          actorId: null,
          action: AUDIT_ACTIONS.RETURN_PICKUP_OFFERED,
          entityType: "return_pickup",
          entityId: pickupId,
          newValue: { returnId: ret.id, deliveryPartnerId: candidate.partner.id },
        },
        tx,
      );
      await notify(
        {
          userId: candidate.partner.userId,
          type: NOTIFICATION_TYPES.RETURN_PICKUP_OFFERED,
          title: "New return pickup",
          body: `A customer return needs collecting near you (~${candidate.distanceToShopKm.toFixed(1)} km away).`,
          actionUrl: "/delivery-partner",
        },
        tx,
      );
      return updated;
    }
    return null;
  });

  if (!offered) await noteNoRider(pickupId, ret, shop?.ownerId ?? null, dispatch.maxAttempts);
  return offered;
}

/** Tells the shop once the pickup has been tried `maxAttempts` times without a taker. */
async function noteNoRider(pickupId: string, ret: ReturnRequest, shopOwnerId: string | null, maxAttempts: number) {
  const [pickup] = await db.select().from(returnPickups).where(eq(returnPickups.id, pickupId));
  if (!pickup || pickup.status !== "PENDING" || pickup.attempts < maxAttempts || !shopOwnerId) return;
  await notify({
    userId: shopOwnerId,
    type: NOTIFICATION_TYPES.RETURN_PICKUP_UNASSIGNED,
    title: "No rider for a return pickup",
    body: `No rider accepted the pickup for return ${ret.returnNumber}. Retry the pickup or ask the customer to bring the goods to you.`,
    actionUrl: "/shop/returns",
    dedupeKey: `return-pickup-unassigned:${pickupId}:${pickup.attempts}`,
  });
}

/** Rider accepts an offer that is still fresh: the return becomes "pickup assigned". */
export async function acceptPickup(pickupId: string, partnerUserId: string): Promise<ReturnPickup> {
  const own = await loadOwnPickup(pickupId, partnerUserId);
  const ttl = (await getRule("dispatch")).offerTtlSeconds;
  const actor = { id: partnerUserId, role: "DELIVERY_PARTNER" as UserRole };

  const accepted = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(returnPickups)
      .set({ status: "ACCEPTED", acceptedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(returnPickups.id, pickupId),
          eq(returnPickups.status, "OFFERED"),
          sql`${returnPickups.offeredAt} > now() - make_interval(secs => ${ttl})`,
        ),
      )
      .returning();
    if (!updated) throw conflict("This pickup offer is no longer available.");
    const [ret] = await tx.select().from(returnRequests).where(eq(returnRequests.id, own.returnId)).for("update");
    await transitionReturn(tx, ret, "PICKUP_ASSIGNED", actor, "Rider accepted the pickup");
    return { pickup: updated, ret };
  });

  await tellCustomerAndShop(accepted.ret, NOTIFICATION_TYPES.RETURN_PICKUP_ASSIGNED, "Pickup arranged", (n) =>
    `A rider will collect the goods for return ${n}. Keep your handover code ready.`,
  );
  return accepted.pickup;
}

/** Rider declines: remembered so they are not asked again; the next rider is tried. */
export async function rejectPickup(pickupId: string, partnerUserId: string, reason?: string): Promise<ReturnPickup> {
  await loadOwnPickup(pickupId, partnerUserId);
  const [updated] = await db
    .update(returnPickups)
    .set({
      status: "PENDING",
      rejectedPartnerIds: sql`array_append(${returnPickups.rejectedPartnerIds}, ${returnPickups.deliveryPartnerId})`,
      deliveryPartnerId: null,
      offeredAt: null,
      failureReason: reason?.trim() || null,
      updatedAt: new Date(),
    })
    .where(and(eq(returnPickups.id, pickupId), eq(returnPickups.status, "OFFERED")))
    .returning();
  if (!updated) throw conflict("This pickup offer is no longer available.");
  await offerPickup(pickupId).catch((error) => console.error("[returns] re-offer failed", pickupId, error));
  return updated;
}

/** Rider is heading to the customer. */
export async function startPickup(pickupId: string, partnerUserId: string): Promise<ReturnPickup> {
  const own = await loadOwnPickup(pickupId, partnerUserId);
  const actor = { id: partnerUserId, role: "DELIVERY_PARTNER" as UserRole };
  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(returnPickups)
      .set({ status: "EN_ROUTE", enRouteAt: new Date(), updatedAt: new Date() })
      .where(and(eq(returnPickups.id, pickupId), eq(returnPickups.status, "ACCEPTED")))
      .returning();
    if (!updated) throw conflict("Accept the pickup before setting off.");
    const [ret] = await tx.select().from(returnRequests).where(eq(returnRequests.id, own.returnId)).for("update");
    await transitionReturn(tx, ret, "RIDER_EN_ROUTE", actor, "Rider is on the way");
    return { updated, ret };
  });
  await tellCustomerAndShop(
    result.ret,
    NOTIFICATION_TYPES.RETURN_RIDER_EN_ROUTE,
    "Rider on the way",
    (n) => `Your rider for return ${n} is on the way. Give them your handover code when they arrive.`,
    false,
  );
  return result.updated;
}

/** Rider hands over nothing but takes the goods: the customer's handover code is required. */
export async function confirmPickup(pickupId: string, partnerUserId: string, code: string): Promise<ReturnPickup> {
  const own = await loadOwnPickup(pickupId, partnerUserId);
  const rules = await getRule("returns");
  if (own.status !== "EN_ROUTE") throw conflict("Set off for the customer before confirming the pickup.");
  if (own.handoverAttempts >= rules.maxHandoverAttempts) {
    throw conflict("Too many wrong codes — ask operations to complete this pickup.");
  }
  if (code.trim() !== own.handoverCode) {
    await db
      .update(returnPickups)
      .set({ handoverAttempts: sql`${returnPickups.handoverAttempts} + 1`, updatedAt: new Date() })
      .where(eq(returnPickups.id, pickupId));
    throw validationFailed("That handover code does not match. Ask the customer for the code shown in their return.");
  }
  return completePickup(pickupId, { id: partnerUserId, role: "DELIVERY_PARTNER" }, "Handed over with the customer's code");
}

/** Operations completes a pickup the code could not (customer's phone dead, attempts used up). */
export async function completePickupByOperator(returnId: string, actor: Actor, note: string): Promise<ReturnPickup> {
  const trimmed = note.trim();
  if (trimmed.length < 5) throw validationFailed("Record how the pickup was confirmed.");
  const [pickup] = await db
    .select()
    .from(returnPickups)
    .where(and(eq(returnPickups.returnId, returnId), eq(returnPickups.status, "EN_ROUTE")));
  if (!pickup) throw conflict("This return has no pickup in progress to complete.");
  return completePickup(pickup.id, actor, `Confirmed by operations: ${trimmed}`);
}

async function completePickup(pickupId: string, actor: Actor, note: string): Promise<ReturnPickup> {
  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(returnPickups)
      .set({ status: "PICKED_UP", pickedUpAt: new Date(), updatedAt: new Date() })
      .where(and(eq(returnPickups.id, pickupId), eq(returnPickups.status, "EN_ROUTE")))
      .returning();
    if (!updated) throw conflict("This pickup is not in progress.");
    const [ret] = await tx.select().from(returnRequests).where(eq(returnRequests.id, updated.returnId)).for("update");
    await transitionReturn(tx, ret, "PICKUP_COMPLETED", actor, note);
    if (updated.deliveryPartnerId) {
      await creditReturnPickupEarning(pickupId, updated.deliveryPartnerId, ret.orderId, tx);
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RETURN_PICKUP_UPDATED,
        entityType: "return_pickup",
        entityId: pickupId,
        newValue: { status: "PICKED_UP" },
      },
      tx,
    );
    return { updated, ret };
  });
  await tellCustomerAndShop(result.ret, NOTIFICATION_TYPES.RETURN_PICKED_UP, "Goods collected", (n) =>
    `The goods for return ${n} have been collected and are heading back to the shop.`,
  );
  return result.updated;
}

/** Rider could not collect (customer not available…): the return goes back to APPROVED for a new pickup. */
export async function failPickup(pickupId: string, partnerUserId: string, reason: string): Promise<ReturnPickup> {
  const own = await loadOwnPickup(pickupId, partnerUserId);
  const trimmed = reason.trim();
  if (!trimmed) throw validationFailed("Say why the pickup could not be completed.");
  const actor = { id: partnerUserId, role: "DELIVERY_PARTNER" as UserRole };
  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(returnPickups)
      .set({ status: "FAILED", failedAt: new Date(), failureReason: trimmed, updatedAt: new Date() })
      .where(and(eq(returnPickups.id, pickupId), inArray(returnPickups.status, ["ACCEPTED", "EN_ROUTE"])))
      .returning();
    if (!updated) throw conflict("This pickup is not in progress.");
    const [ret] = await tx.select().from(returnRequests).where(eq(returnRequests.id, own.returnId)).for("update");
    await transitionReturn(tx, ret, "APPROVED", actor, `Pickup failed: ${trimmed}`);
    return { updated, ret };
  });
  await tellCustomerAndShop(result.ret, NOTIFICATION_TYPES.RETURN_PICKUP_FAILED, "Pickup could not be completed", (n) =>
    `The pickup for return ${n} could not be completed (${trimmed}). The shop can arrange another pickup.`,
  );
  return result.updated;
}

/** Shop/operations starts a fresh pickup after a failed one, or after the search gave up. */
export async function retryPickup(returnId: string): Promise<ReturnPickup> {
  const [ret] = await db.select().from(returnRequests).where(eq(returnRequests.id, returnId));
  if (!ret) throw notFound("Return");
  if (ret.status !== "APPROVED" || !ret.pickupRequired) throw conflict("This return is not waiting for a pickup.");
  const [live] = await db
    .select()
    .from(returnPickups)
    .where(and(eq(returnPickups.returnId, returnId), inArray(returnPickups.status, [...LIVE_PICKUP_STATUSES])));
  const pickup = live
    ? (await db
        .update(returnPickups)
        .set({ attempts: 0, rejectedPartnerIds: [], updatedAt: new Date() })
        .where(eq(returnPickups.id, live.id))
        .returning())[0]
    : await createPickup(returnId);
  return (await offerPickup(pickup.id)) ?? pickup;
}

/** Cancels any live pickup (the return was cancelled or its pickup mode changed). */
export async function cancelLivePickup(returnId: string, client: DbClient = db): Promise<void> {
  await client
    .update(returnPickups)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(returnPickups.returnId, returnId), inArray(returnPickups.status, [...LIVE_PICKUP_STATUSES])));
}

/** Customer picks (or changes) the time they will be ready — moves the return to "pickup scheduled". */
export async function scheduleReturnPickup(returnId: string, userId: string, when: Date): Promise<ReturnPickup> {
  const now = Date.now();
  if (when.getTime() < now - 60_000) throw validationFailed("Choose a time in the future.");
  if (when.getTime() > now + 3 * 24 * 3_600_000) throw validationFailed("Choose a time within the next 3 days.");
  const [ret] = await db.select().from(returnRequests).where(eq(returnRequests.id, returnId));
  if (!ret) throw notFound("Return");
  if (ret.userId !== userId) throw forbidden("This return does not belong to you.");
  const [pickup] = await db
    .select()
    .from(returnPickups)
    .where(and(eq(returnPickups.returnId, returnId), inArray(returnPickups.status, [...LIVE_PICKUP_STATUSES])));
  if (!pickup) throw conflict("There is no pickup to schedule for this return.");

  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(returnRequests).where(eq(returnRequests.id, returnId)).for("update");
    const [updated] = await tx
      .update(returnPickups)
      .set({ scheduledFor: when, updatedAt: new Date() })
      .where(eq(returnPickups.id, pickup.id))
      .returning();
    if (locked.status === "PICKUP_ASSIGNED") {
      await transitionReturn(tx, locked, "PICKUP_SCHEDULED", { id: userId, role: "CUSTOMER" }, `Ready from ${when.toISOString()}`);
    }
    return updated;
  });
}

/** What a rider sees of their live return pickup. No handover code, and only the area until they set off. */
export interface ActiveReturnPickup {
  id: string;
  status: string;
  returnNumber: string;
  scheduledFor: Date | null;
  needsHandoverCode: boolean;
  shopName: string;
  shopAddress: string;
  itemSummary: string;
  customerAddress: string | null;
  customerNotes: string | null;
  navigationUrl: string | null;
  shopNavigationUrl: string | null;
}

export async function getMyActiveReturnPickup(userId: string): Promise<ActiveReturnPickup | null> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner) return null;
  const [row] = await db
    .select({ pickup: returnPickups, ret: returnRequests, shop: shops })
    .from(returnPickups)
    .innerJoin(returnRequests, eq(returnPickups.returnId, returnRequests.id))
    .innerJoin(shops, eq(returnRequests.shopId, shops.id))
    .where(and(eq(returnPickups.deliveryPartnerId, partner.id), inArray(returnPickups.status, [...RIDER_BUSY_PICKUP_STATUSES])));
  if (!row) return null;

  const items = await db
    .select({ quantityMilli: returnItems.quantityMilli })
    .from(returnItems)
    .where(eq(returnItems.returnId, row.ret.id));
  const address = row.ret.pickupAddress as Record<string, string | null> | null;
  const precise = row.pickup.status === "EN_ROUTE";
  const lat = address?.latitude ?? null;
  const lng = address?.longitude ?? null;
  const full = address ? [address.line1, address.area, address.city].filter(Boolean).join(", ") : null;
  const areaOnly = address ? [address.area, address.city].filter(Boolean).join(", ") : null;
  const dir = (a: string | null, b: string | null, text: string) =>
    a && b
      ? `https://www.google.com/maps/dir/?api=1&destination=${a},${b}`
      : text
        ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}`
        : null;

  return {
    id: row.pickup.id,
    status: row.pickup.status,
    returnNumber: row.ret.returnNumber,
    scheduledFor: row.pickup.scheduledFor,
    needsHandoverCode: true,
    shopName: row.shop.name,
    shopAddress: [row.shop.addressLine1, row.shop.addressLine2, row.shop.city].filter(Boolean).join(", "),
    itemSummary: `${items.length} item${items.length === 1 ? "" : "s"} to collect`,
    customerAddress: precise ? full : areaOnly,
    customerNotes: precise && address ? ([address.landmark, address.deliveryInstructions].filter(Boolean).join(" · ") || null) : null,
    navigationUrl: precise ? dir(lat, lng, full ?? "") : null,
    shopNavigationUrl: dir(row.shop.latitude, row.shop.longitude, `${row.shop.name} ${row.shop.addressLine1}`),
  };
}

/** Cron: lapse stale offers back to the pool and re-offer every pickup still waiting for a rider. */
export async function runReturnPickupSweep(): Promise<{ expired: number; offered: number }> {
  const dispatch = await getRule("dispatch");
  const expired = await db
    .update(returnPickups)
    .set({
      status: "PENDING",
      rejectedPartnerIds: sql`array_append(${returnPickups.rejectedPartnerIds}, ${returnPickups.deliveryPartnerId})`,
      deliveryPartnerId: null,
      offeredAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(returnPickups.status, "OFFERED"),
        lt(returnPickups.offeredAt, sql`now() - make_interval(secs => ${dispatch.offerTtlSeconds})`),
      ),
    )
    .returning({ id: returnPickups.id });

  const waiting = await db
    .select({ id: returnPickups.id })
    .from(returnPickups)
    .innerJoin(returnRequests, eq(returnPickups.returnId, returnRequests.id))
    .where(
      and(
        eq(returnPickups.status, "PENDING"),
        eq(returnRequests.status, "APPROVED"),
        lt(returnPickups.attempts, dispatch.maxAttempts),
        // Paced by the same retry interval as delivery dispatch.
        lt(returnPickups.updatedAt, sql`now() - make_interval(secs => ${dispatch.retryIntervalSeconds})`),
      ),
    )
    .limit(100);

  let offered = 0;
  for (const { id } of waiting) {
    const result = await offerPickup(id).catch((error) => {
      console.error("[returns] pickup sweep failed", id, error);
      return null;
    });
    if (result) offered += 1;
  }
  return { expired: expired.length, offered };
}

async function tellCustomerAndShop(
  ret: ReturnRequest,
  type: (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES],
  title: string,
  body: (returnNumber: string) => string,
  alsoShop = true,
): Promise<void> {
  await notify({
    userId: ret.userId,
    type,
    title,
    body: body(ret.returnNumber),
    actionUrl: `/returns/${ret.id}`,
  });
  if (!alsoShop) return;
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, ret.shopId));
  if (shop) {
    await notify({
      userId: shop.ownerId,
      type,
      title,
      body: body(ret.returnNumber),
      actionUrl: "/shop/returns",
    });
  }
}
