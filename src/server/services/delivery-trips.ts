/**
 * GA-005 rider batching — trip planning.
 *
 * A trip is the set of deliveries one rider carries together
 * (delivery_orders.trip_id). Nothing about the route is stored: the pickup
 * and drop sequence, and the arrival estimate at every drop, are worked out
 * here from the members' current statuses each time they are needed, so a
 * rejected, delivered or failed member simply drops out of the plan.
 *
 * Planning is deliberately simple and explainable (straight-line distance at
 * the platform's assumed speed, like the delivery-window promise): every
 * pickup first, nearest-next from the rider, then every drop, nearest-next
 * from the last pickup. An order joins a trip only when
 *   - the trip has room (batching.maxOrdersPerTrip),
 *   - nothing in it has been picked up yet,
 *   - its shop is within maxPickupDistanceKm of every pickup in the trip,
 *   - its drop lies in the same direction as the trip's drops (bearing from
 *     the pickups within maxDropBearingDegrees; drops very close to the
 *     pickups are fine in any direction), and
 *   - with it added, every member is still delivered by its promised time.
 */
import { and, eq, inArray } from "drizzle-orm";

import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { db, type DbClient } from "@/server/db";
import { deliveryOrders, deliveryPartners, deliveryTrips, orders, shops } from "@/server/db/schema";
import { ACTIVE_ASSIGNMENT_STATUSES } from "./delivery-eligibility";
import { ASSUMED_AVERAGE_SPEED_KMH } from "./routing";
import { getRule } from "./settings";

export interface Point {
  latitude: number;
  longitude: number;
}

export type BatchingRule = Awaited<ReturnType<typeof getRule<"batching">>>;

export interface TripMember {
  deliveryOrderId: string;
  orderId: string;
  orderNumber: string;
  status: string;
  pickup: Point;
  pickupLabel: string;
  drop: Point | null;
  dropLabel: string;
  promisedByAt: Date | null;
}

export interface PlannedStop {
  kind: "PICKUP" | "DROP";
  deliveryOrderId: string;
  orderId: string;
  orderNumber: string;
  label: string;
  done: boolean;
  /** Estimated arrival (null for a stop already done). */
  eta: Date | null;
  /** True when this drop's estimate is after the order's promised time. */
  late: boolean;
}

const PICKED_UP_OR_LATER = new Set(["PICKED_UP", "DELIVERED", "FAILED", "RETURNED"]);
const DROP_DONE = new Set(["DELIVERED", "FAILED", "RETURNED", "CANCELLED", "REJECTED", "EXPIRED"]);

const minutesFor = (km: number) => (km / ASSUMED_AVERAGE_SPEED_KMH) * 60;

/** Initial compass bearing a → b, degrees 0–360. */
export function bearingDegrees(a: Point, b: Point): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.longitude - a.longitude)) * Math.cos(toRad(b.latitude));
  const x =
    Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(toRad(b.longitude - a.longitude));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function centroid(points: Point[]): Point {
  return {
    latitude: points.reduce((s, p) => s + p.latitude, 0) / points.length,
    longitude: points.reduce((s, p) => s + p.longitude, 0) / points.length,
  };
}

/** Nearest-next ordering of `items` starting from `from`. */
function nearestNext<T>(from: Point, items: T[], at: (t: T) => Point): T[] {
  const left = [...items];
  const out: T[] = [];
  let here = from;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i += 1) {
      if (haversineDistanceKm(here, at(left[i])) < haversineDistanceKm(here, at(left[best]))) best = i;
    }
    const [next] = left.splice(best, 1);
    out.push(next);
    here = at(next);
  }
  return out;
}

/**
 * The trip's stop sequence with arrival estimates. `start` is where the
 * rider is now (falls back to the first pickup when unknown).
 */
export function planTrip(
  members: TripMember[],
  options: { start: Point | null; now: Date; stopMinutes: number },
): PlannedStop[] {
  const live = members.filter((m) => !DROP_DONE.has(m.status) || PICKED_UP_OR_LATER.has(m.status));
  if (live.length === 0) return [];
  const toPick = live.filter((m) => !PICKED_UP_OR_LATER.has(m.status));
  const picked = live.filter((m) => PICKED_UP_OR_LATER.has(m.status));
  const start = options.start ?? toPick[0]?.pickup ?? live[0].pickup;

  const stops: PlannedStop[] = [];
  let here = start;
  let clock = options.now.getTime();
  // Pickups already made are shown done, in the order they happened to be listed.
  for (const m of picked) {
    stops.push({ kind: "PICKUP", deliveryOrderId: m.deliveryOrderId, orderId: m.orderId, orderNumber: m.orderNumber, label: m.pickupLabel, done: true, eta: null, late: false });
  }
  for (const m of nearestNext(here, toPick, (x) => x.pickup)) {
    clock += minutesFor(haversineDistanceKm(here, m.pickup)) * 60_000;
    here = m.pickup;
    stops.push({ kind: "PICKUP", deliveryOrderId: m.deliveryOrderId, orderId: m.orderId, orderNumber: m.orderNumber, label: m.pickupLabel, done: false, eta: new Date(clock), late: false });
    clock += options.stopMinutes * 60_000;
  }
  const drops = live.filter((m) => !DROP_DONE.has(m.status));
  const doneDrops = live.filter((m) => DROP_DONE.has(m.status));
  for (const m of doneDrops) {
    stops.push({ kind: "DROP", deliveryOrderId: m.deliveryOrderId, orderId: m.orderId, orderNumber: m.orderNumber, label: m.dropLabel, done: true, eta: null, late: false });
  }
  for (const m of nearestNext(here, drops, (x) => x.drop ?? x.pickup)) {
    const target = m.drop ?? m.pickup;
    clock += minutesFor(haversineDistanceKm(here, target)) * 60_000;
    here = target;
    const eta = new Date(clock);
    stops.push({
      kind: "DROP",
      deliveryOrderId: m.deliveryOrderId,
      orderId: m.orderId,
      orderNumber: m.orderNumber,
      label: m.dropLabel,
      done: false,
      eta,
      late: m.promisedByAt != null && eta.getTime() > m.promisedByAt.getTime(),
    });
    clock += options.stopMinutes * 60_000;
  }
  return stops;
}

export type Compatibility = { ok: true; stops: PlannedStop[] } | { ok: false; reason: string };

/** Can `candidate` join a trip made of `members` (the rider's live deliveries)? */
export function checkBatchCompatibility(
  members: TripMember[],
  candidate: TripMember,
  rule: BatchingRule,
  options: { start: Point | null; now: Date },
): Compatibility {
  const live = members.filter((m) => (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(m.status));
  if (live.length === 0) return { ok: false, reason: "no trip to join" };
  if (live.length + 1 > rule.maxOrdersPerTrip) return { ok: false, reason: "trip is full" };
  if (live.some((m) => m.status === "PICKED_UP")) return { ok: false, reason: "trip already on its way" };
  if (live.some((m) => haversineDistanceKm(m.pickup, candidate.pickup) > rule.maxPickupDistanceKm)) {
    return { ok: false, reason: "pickup too far from the trip's pickups" };
  }
  const hub = centroid([...live.map((m) => m.pickup), candidate.pickup]);
  if (candidate.drop && haversineDistanceKm(hub, candidate.drop) > rule.directionFreeWithinKm) {
    const heading = bearingDegrees(hub, candidate.drop);
    for (const m of live) {
      if (!m.drop || haversineDistanceKm(hub, m.drop) <= rule.directionFreeWithinKm) continue;
      if (angleBetween(heading, bearingDegrees(hub, m.drop)) > rule.maxDropBearingDegrees) {
        return { ok: false, reason: "drop is in a different direction" };
      }
    }
  }
  const stops = planTrip([...live, candidate], { start: options.start, now: options.now, stopMinutes: rule.stopMinutes });
  const late = stops.find((s) => s.late);
  if (late) return { ok: false, reason: `order ${late.orderNumber} would miss its promised time` };
  return { ok: true, stops };
}

/* ------------------------------------------------------------------ data */

function label(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(", ");
}

/** A rider's live deliveries as trip members (offered, accepted or picked up). */
export async function loadRiderMembers(partnerId: string, client: DbClient = db): Promise<(TripMember & { tripId: string | null })[]> {
  const rows = await client
    .select({ d: deliveryOrders, order: orders, shop: shops })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(and(eq(deliveryOrders.deliveryPartnerId, partnerId), inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES)));
  return rows.flatMap((r) => {
    const member = toMember(r.d.id, r.d.status, r.order, r.shop);
    return member ? [{ ...member, tripId: r.d.tripId }] : [];
  });
}

export function toMember(
  deliveryOrderId: string,
  status: string,
  order: typeof orders.$inferSelect,
  shop: typeof shops.$inferSelect,
): TripMember | null {
  const pickup =
    parseCoordinates(shop.pickupLatitude, shop.pickupLongitude) ?? parseCoordinates(shop.latitude, shop.longitude);
  if (!pickup) return null;
  const snap = order.deliveryAddressSnapshot;
  return {
    deliveryOrderId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    status,
    pickup,
    pickupLabel: label([shop.name, shop.addressLine1]),
    drop: parseCoordinates(snap?.latitude ?? null, snap?.longitude ?? null),
    dropLabel: snap ? label([snap.area, snap.city]) : "Customer",
    promisedByAt: order.promisedByAt,
  };
}

/**
 * Puts `deliveryOrderId` into the trip of `members` — their existing trip, or
 * a new one holding all of them. Runs inside the offer's transaction.
 */
export async function joinTrip(
  tx: DbClient,
  partnerId: string,
  deliveryOrderId: string,
  members: { deliveryOrderId: string; tripId: string | null }[],
): Promise<string> {
  let tripId = members.find((m) => m.tripId)?.tripId ?? null;
  if (!tripId) {
    const [trip] = await tx.insert(deliveryTrips).values({ deliveryPartnerId: partnerId }).returning();
    tripId = trip.id;
  }
  const ids = [deliveryOrderId, ...members.map((m) => m.deliveryOrderId)];
  await tx.update(deliveryOrders).set({ tripId }).where(inArray(deliveryOrders.id, ids));
  return tripId;
}

export interface RiderTripView {
  tripId: string;
  stops: (Omit<PlannedStop, "eta"> & { eta: string | null; current: boolean })[];
}

/** The rider's current trip — stops in order with the next one marked — or null when not batched. */
export async function getRiderTrip(userId: string): Promise<RiderTripView | null> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner) return null;
  const live = await loadRiderMembers(partner.id);
  const tripId = live.find((m) => m.tripId)?.tripId;
  if (!tripId) return null;
  const rule = await getRule("batching");
  // Members of the trip that already finished stay on the list as done stops.
  const finishedRows = await db
    .select({ d: deliveryOrders, order: orders, shop: shops })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(and(eq(deliveryOrders.tripId, tripId), inArray(deliveryOrders.status, ["DELIVERED", "FAILED"])));
  const finished = finishedRows.flatMap((r) => {
    const m = toMember(r.d.id, r.d.status, r.order, r.shop);
    return m ? [m] : [];
  });
  const members = [...live.filter((m) => m.tripId === tripId && m.status !== "OFFERED"), ...finished];
  if (members.length < 2) return null;
  const start = parseCoordinates(partner.lastLocationLatitude, partner.lastLocationLongitude);
  const stops = planTrip(members, { start, now: new Date(), stopMinutes: rule.stopMinutes });
  const firstOpen = stops.findIndex((s) => !s.done);
  return {
    tripId,
    stops: stops.map((s, i) => ({ ...s, eta: s.eta ? s.eta.toISOString() : null, current: i === firstOpen })),
  };
}

/**
 * For a batched rider: the delivery whose stop comes next in the trip
 * (pickups before drops). Null when the rider is not on a trip.
 */
export async function nextTripDeliveryId(partnerId: string, client: DbClient = db): Promise<string | null> {
  const live = await loadRiderMembers(partnerId, client);
  const tripId = live.find((m) => m.tripId && m.status !== "OFFERED")?.tripId;
  if (!tripId) return null;
  const members = live.filter((m) => m.tripId === tripId && m.status !== "OFFERED");
  if (members.length < 2) return null;
  const partner = await client.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, partnerId) });
  const rule = await getRule("batching");
  const start = partner ? parseCoordinates(partner.lastLocationLatitude, partner.lastLocationLongitude) : null;
  const next = planTrip(members, { start, now: new Date(), stopMinutes: rule.stopMinutes }).find((s) => !s.done);
  return next?.deliveryOrderId ?? null;
}
