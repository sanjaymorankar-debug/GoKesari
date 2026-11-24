/**
 * Delivery Booking Management + Tracking Engine (docs/hdms-2026-11).
 *
 * A booking is one delivery partner job for an order. Its status moves only along BOOKING_TRANSITIONS;
 * an event that would move it backwards (late or repeated webhooks, polling) is recorded and ignored.
 * Order effects for partner bookings go through the existing updateOrderStatus (so COD collection,
 * finance snapshot, shop wallet charge, invoices and notifications stay exactly as for GoKesari riders):
 *   ASSIGNED → order ASSIGNED; PICKED_UP → PICKED_UP; IN_TRANSIT → OUT_FOR_DELIVERY; DELIVERED → DELIVERED;
 *   failed or cancelled before pickup → order back to READY and the allocation engine tries again;
 *   failed after pickup → order FAILED; RETURNED → order RETURNED.
 * Provider calls are never made inside a database transaction.
 */
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { canTransition } from "@/lib/state-machines";
import { db } from "@/server/db";
import {
  deliveryBookings,
  deliveryEvents,
  TERMINAL_BOOKING_STATUSES,
  type BookingStatus,
  type DeliveryBooking,
} from "@/server/db/hdms-schema";
import { orders, shops, type OrderStatus } from "@/server/db/schema";

import { callProvider, getProvider } from "./providers/registry";
import type { GeoPoint } from "./providers/types";

export const BOOKING_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  CREATED: ["SEARCHING", "ASSIGNED", "CANCELLED", "FAILED"],
  SEARCHING: ["ASSIGNED", "CANCELLED", "FAILED"],
  // Partners may skip intermediate events (a missed webhook): forward jumps are allowed, backward ones never.
  ASSIGNED: ["SEARCHING", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "CANCELLED", "FAILED"],
  AT_PICKUP: ["ASSIGNED", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "CANCELLED", "FAILED"],
  PICKED_UP: ["IN_TRANSIT", "DELIVERED", "FAILED", "RETURNING"],
  IN_TRANSIT: ["DELIVERED", "FAILED", "RETURNING"],
  RETURNING: ["RETURNED"],
  DELIVERED: [],
  FAILED: ["RETURNING", "RETURNED"],
  RETURNED: [],
  CANCELLED: [],
};

export function canMoveBooking(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

export const PICKED_STATUSES: readonly BookingStatus[] = ["PICKED_UP", "IN_TRANSIT", "RETURNING"];

/** Customer-facing words for a booking status. */
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  CREATED: "Booking delivery partner",
  SEARCHING: "Finding a delivery rider",
  ASSIGNED: "Rider assigned",
  AT_PICKUP: "Rider at the shop",
  PICKED_UP: "Order picked up",
  IN_TRANSIT: "Rider on the way",
  DELIVERED: "Delivered",
  FAILED: "Delivery failed",
  RETURNING: "Returning to shop",
  RETURNED: "Returned to shop",
  CANCELLED: "Delivery cancelled",
};

/** "+919876543210" → "+91 98XXXXXX10": riders' numbers are never shown in full. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return null;
  const local = digits.slice(-10);
  return `+91 ${local.slice(0, 2)}${"X".repeat(Math.max(0, local.length - 4))}${local.slice(-2)}`;
}

export async function liveBookingForOrder(orderId: string): Promise<DeliveryBooking | null> {
  const [row] = await db
    .select()
    .from(deliveryBookings)
    .where(and(eq(deliveryBookings.orderId, orderId), notInArray(deliveryBookings.status, [...TERMINAL_BOOKING_STATUSES])));
  return row ?? null;
}

export async function hasLiveExternalBooking(orderId: string): Promise<boolean> {
  return (await liveBookingForOrder(orderId)) != null;
}

export async function latestBookingForOrder(orderId: string): Promise<DeliveryBooking | null> {
  const [row] = await db
    .select()
    .from(deliveryBookings)
    .where(eq(deliveryBookings.orderId, orderId))
    .orderBy(desc(deliveryBookings.createdAt))
    .limit(1);
  return row ?? null;
}

export interface BookingUpdate {
  status: BookingStatus;
  source: "WEBHOOK" | "POLL" | "SHOP" | "ADMIN" | "SYSTEM" | "CUSTOMER";
  note?: string | null;
  occurredAt?: Date;
  riderName?: string | null;
  riderPhone?: string | null;
  riderLocation?: GeoPoint | null;
  etaMinutes?: number | null;
  failureReason?: string | null;
  finalFeePaise?: number | null;
  cancelledBy?: DeliveryBooking["cancelledBy"];
}

export interface ApplyResult {
  booking: DeliveryBooking;
  changed: boolean;
  /** Set when the order went back to READY and needs a new delivery. */
  needsReallocation: boolean;
}

/**
 * Applies one status update (webhook, poll, shop/admin action). Idempotent: the same status twice,
 * or a move the machine does not allow, only refreshes location/ETA and logs the event.
 */
export async function applyBookingUpdate(bookingId: string, update: BookingUpdate): Promise<ApplyResult> {
  const result = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(deliveryBookings).where(eq(deliveryBookings.id, bookingId)).for("update");
    if (!booking) throw notFound("Delivery booking");
    const now = new Date();
    const move = booking.status !== update.status && canMoveBooking(booking.status, update.status);
    const terminal = TERMINAL_BOOKING_STATUSES.includes(update.status);
    const [updated] = await tx
      .update(deliveryBookings)
      .set({
        ...(move ? { status: update.status } : {}),
        ...(move && terminal ? { terminalAt: now } : {}),
        ...(update.riderName ? { riderName: update.riderName.slice(0, 80) } : {}),
        ...(update.riderPhone ? { riderPhoneMasked: maskPhone(update.riderPhone) } : {}),
        ...(update.riderLocation
          ? { riderLat: update.riderLocation.lat.toFixed(6), riderLng: update.riderLocation.lng.toFixed(6), riderLocationAt: update.occurredAt ?? now }
          : {}),
        ...(update.etaMinutes != null ? { etaAt: new Date(now.getTime() + update.etaMinutes * 60_000) } : {}),
        ...(move && update.failureReason ? { failureReason: update.failureReason.slice(0, 300) } : {}),
        ...(update.finalFeePaise != null ? { finalFeePaise: update.finalFeePaise } : {}),
        ...(move && update.status === "CANCELLED"
          ? { cancelledBy: update.cancelledBy ?? "SYSTEM", cancelReason: update.note?.slice(0, 300) ?? null }
          : {}),
        updatedAt: now,
      })
      .where(eq(deliveryBookings.id, bookingId))
      .returning();
    await tx.insert(deliveryEvents).values({
      bookingId,
      status: update.status,
      source: update.source,
      note: (move ? update.note : `${update.note ?? ""} (ignored: ${booking.status} → ${update.status})`.trim())?.slice(0, 300) ?? null,
      lat: update.riderLocation ? update.riderLocation.lat.toFixed(6) : null,
      lng: update.riderLocation ? update.riderLocation.lng.toFixed(6) : null,
      occurredAt: update.occurredAt ?? now,
    });
    return { before: booking, booking: updated, changed: move };
  });

  let needsReallocation = false;
  if (result.changed && result.booking.channel === "EXTERNAL") {
    needsReallocation = await syncOrderWithBooking(result.booking, result.before.status);
  }
  return { booking: result.booking, changed: result.changed, needsReallocation };
}

const FORWARD_CHAIN: OrderStatus[] = ["READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"];

function orderTargetFor(status: BookingStatus): OrderStatus | null {
  switch (status) {
    case "ASSIGNED":
    case "AT_PICKUP":
      return "ASSIGNED";
    case "PICKED_UP":
      return "PICKED_UP";
    case "IN_TRANSIT":
      return "OUT_FOR_DELIVERY";
    case "DELIVERED":
      return "DELIVERED";
    default:
      return null;
  }
}

/** Moves the order to match a partner booking. Returns true when the order needs a new delivery. */
async function syncOrderWithBooking(booking: DeliveryBooking, previous: BookingStatus): Promise<boolean> {
  const { updateOrderStatus } = await import("@/server/services/orders");
  const [order] = await db.select().from(orders).where(eq(orders.id, booking.orderId));
  if (!order) return false;
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, booking.shopId));
  if (!shop) return false;
  // The shop handed the parcel to its chosen partner: partner updates are recorded as the shop's, with the source in the note.
  const actor = { id: shop.ownerId, role: "SHOP_OWNER" as const };
  const provider = booking.providerCode ?? "partner";
  const step = async (to: OrderStatus, note: string) => {
    const [current] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, booking.orderId));
    if (!current || current.status === to || !canTransition(current.status, to)) return false;
    await updateOrderStatus(booking.orderId, to, actor, note);
    return true;
  };

  const target = orderTargetFor(booking.status);
  if (target) {
    const from = FORWARD_CHAIN.indexOf(order.status);
    const to = FORWARD_CHAIN.indexOf(target);
    if (from < 0 || to <= from) return false; // cancelled, failed or already further: leave it
    for (let i = from + 1; i <= to; i++) {
      await step(FORWARD_CHAIN[i], `${provider}: ${BOOKING_STATUS_LABELS[booking.status]} (ref ${booking.externalRef ?? booking.id})`);
    }
    return false;
  }

  const pickedUp = PICKED_STATUSES.includes(previous) || ["PICKED_UP", "OUT_FOR_DELIVERY"].includes(order.status);
  if ((booking.status === "FAILED" || booking.status === "CANCELLED") && !pickedUp) {
    // Nothing left the shop: the order waits for the next delivery option.
    if (order.status === "ASSIGNED") await step("READY", `${provider}: ${BOOKING_STATUS_LABELS[booking.status]} before pickup — finding another delivery`);
    const [now] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, booking.orderId));
    return now?.status === "READY";
  }
  if (booking.status === "FAILED" || booking.status === "RETURNING") {
    if (order.status === "PICKED_UP") await step("OUT_FOR_DELIVERY", `${provider}: on the way`);
    await step("FAILED", `${provider}: delivery failed${booking.failureReason ? ` — ${booking.failureReason}` : ""}`);
    return false;
  }
  if (booking.status === "RETURNED") {
    if (order.status !== "FAILED") {
      if (order.status === "PICKED_UP") await step("OUT_FOR_DELIVERY", `${provider}: on the way`);
      await step("FAILED", `${provider}: delivery failed`);
    }
    await step("RETURNED", `${provider}: parcel returned to the shop`);
  }
  return false;
}

/**
 * Cancels the order's live partner booking (customer or shop cancelled the order, admin, or a re-plan).
 * Before pickup the partner is asked to cancel; after pickup a partner job cannot be cancelled here.
 */
export async function cancelBooking(
  bookingId: string,
  by: NonNullable<DeliveryBooking["cancelledBy"]>,
  reason: string,
  options: { syncOrder?: boolean } = {},
): Promise<ApplyResult> {
  const [booking] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.id, bookingId));
  if (!booking) throw notFound("Delivery booking");
  if (TERMINAL_BOOKING_STATUSES.includes(booking.status)) return { booking, changed: false, needsReallocation: false };
  if (PICKED_STATUSES.includes(booking.status)) {
    throw conflict("The rider has already picked up this order; it can no longer be cancelled with the delivery partner. Ask for a return instead.");
  }
  if (booking.channel === "EXTERNAL" && booking.providerCode && booking.externalRef) {
    const provider = await getProvider(booking.providerCode);
    if (provider) {
      const res = await callProvider(provider, { operation: "cancel", bookingId }, (a, ctx) => a.cancel(ctx, booking.externalRef!, reason));
      if (!res.cancelled) throw conflict(`${provider.name} refused the cancellation (the rider may be at the shop already).`);
      if (res.feePaise != null && res.feePaise > 0) {
        await db.update(deliveryBookings).set({ finalFeePaise: res.feePaise }).where(eq(deliveryBookings.id, bookingId));
      }
    }
  }
  const applied = await applyBookingUpdate(bookingId, { status: "CANCELLED", source: by === "PROVIDER" ? "WEBHOOK" : by === "CUSTOMER" ? "CUSTOMER" : by === "SHOP" ? "SHOP" : by === "ADMIN" ? "ADMIN" : "SYSTEM", note: reason, cancelledBy: by });
  if (options.syncOrder === false) return { ...applied, needsReallocation: false };
  return applied;
}

/** Called after an order is cancelled: closes its live partner booking (never throws). */
export async function cancelLiveBookingForCancelledOrder(orderId: string, by: "CUSTOMER" | "SHOP" | "ADMIN" | "SYSTEM", reason: string): Promise<void> {
  try {
    const live = await liveBookingForOrder(orderId);
    if (!live) return;
    await cancelBooking(live.id, by, `Order cancelled: ${reason}`.slice(0, 300), { syncOrder: false });
  } catch (error) {
    console.error("[delivery] could not cancel the partner booking of cancelled order", orderId, error);
  }
}

/** Polls partners for active bookings (cron; webhooks are the primary path). */
export async function pollActiveBookings(limit = 50): Promise<{ polled: number; changed: number; errors: number }> {
  const rows = await db
    .select()
    .from(deliveryBookings)
    .where(
      and(
        eq(deliveryBookings.channel, "EXTERNAL"),
        inArray(deliveryBookings.status, ["CREATED", "SEARCHING", "ASSIGNED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "RETURNING"]),
        sql`${deliveryBookings.externalRef} IS NOT NULL`,
        sql`(${deliveryBookings.lastPolledAt} IS NULL OR ${deliveryBookings.lastPolledAt} < now() - interval '45 seconds')`,
      ),
    )
    .orderBy(deliveryBookings.lastPolledAt)
    .limit(limit);
  let changed = 0;
  let errors = 0;
  const { reallocateAfterBookingEnded } = await import("./allocation");
  for (const b of rows) {
    await db.update(deliveryBookings).set({ lastPolledAt: new Date() }).where(eq(deliveryBookings.id, b.id));
    try {
      const provider = await getProvider(b.providerCode!);
      if (!provider) continue;
      const t = await callProvider(provider, { operation: "track", bookingId: b.id, retries: 0 }, (a, ctx) => a.track(ctx, b.externalRef!));
      const r = await applyBookingUpdate(b.id, {
        status: t.status,
        source: "POLL",
        riderName: t.riderName,
        riderPhone: t.riderPhone,
        riderLocation: t.riderLocation,
        etaMinutes: t.etaMinutes,
        failureReason: t.failureReason,
        finalFeePaise: t.finalFeePaise,
      });
      if (r.changed) changed++;
      if (r.needsReallocation) await reallocateAfterBookingEnded(r.booking);
    } catch (error) {
      errors++;
      console.error("[delivery] poll failed for booking", b.id, error instanceof Error ? error.message : error);
    }
  }
  return { polled: rows.length, changed, errors };
}
