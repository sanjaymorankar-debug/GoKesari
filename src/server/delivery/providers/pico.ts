/**
 * Pico Xpress in the HDMS adapter contract (docs/pico-xpress-2026-11). Pico is booked from the shop's delivery
 * choice (pico/service.ts), not by the generic allocation engine, because its manifest needs the GSTIN,
 * invoices, items, AWBs and codes that the generic BookRequest does not carry. The adapter serves the generic
 * paths that already exist for every partner:
 *  - cancel: an order cancelled by the customer / shop / admin closes its live booking (orders.ts →
 *    cancelLiveBookingForCancelledOrder → cancelBooking);
 *  - track: the HDMS poll (hdms_enabled) goes through the same Pico tracking processing as webhooks;
 *  - quote: serviceability only (no fee), so the engine never ranks Pico on price;
 *  - webhooks: Pico calls its own routes (/api/webhooks/picoxpress/*); the generic route refuses it.
 */
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { deliveryBookings } from "@/server/db/hdms-schema";
import { deliveryShipments } from "@/server/db/pico-schema";

import { checkServiceability } from "../pico/client";
import { PicoError } from "../pico/errors";
import { ProviderError, type DeliveryProviderAdapter } from "./types";

export const picoAdapter: DeliveryProviderAdapter = {
  code: "PICO",
  integrated: true,
  async quote(_ctx, req) {
    try {
      const r = await checkServiceability({
        orderId: req.shipment.orderNumber,
        pickupLat: req.pickup.point.lat,
        pickupLng: req.pickup.point.lng,
        deliveryLat: req.drop.point.lat,
        deliveryLng: req.drop.point.lng,
        paymentType: req.shipment.codPaise > 0 ? "COD" : "PREPAID",
      });
      return { serviceable: r.serviceable, reason: r.serviceable ? undefined : (r.message ?? "Not serviceable.") };
    } catch (error) {
      throw new ProviderError(error instanceof Error ? error.message : "Pico check failed.", error instanceof PicoError && error.retryable ? "UNAVAILABLE" : "REJECTED", error instanceof PicoError && error.retryable);
    }
  },
  async book() {
    throw new ProviderError("Pico Xpress is booked from the shop's delivery choice (gokesari.com delivery partner).", "REJECTED", false);
  },
  async track(_ctx, externalRef) {
    const [shipment] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.awbNumber, externalRef));
    if (!shipment) throw new ProviderError(`No Pico shipment for AWB ${externalRef}.`, "BAD_RESPONSE", false);
    const { refreshPicoShipment } = await import("../pico/service");
    await refreshPicoShipment(shipment.orderId);
    const [booking] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.id, shipment.bookingId));
    return { status: booking?.status ?? "CREATED" };
  },
  async cancel(_ctx, externalRef, reason) {
    const [shipment] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.awbNumber, externalRef));
    if (!shipment) return { cancelled: false };
    const [booking] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.id, shipment.bookingId));
    if (!booking) return { cancelled: false };
    const { alertOps, cancelShipmentRow } = await import("../pico/service");
    try {
      // The generic caller moves the booking to CANCELLED itself; only Pico, the shipment and the AWBs here.
      await cancelShipmentRow(booking, shipment, "SYSTEM", reason, { id: null, role: null }, { booking: "skip" });
      return { cancelled: true };
    } catch (error) {
      await alertOps(
        "Pico shipment could not be cancelled",
        `AWB ${externalRef}: ${reason}. Pico refused or could not be reached (${error instanceof Error ? error.message : "error"}). Check the shipment on Admin → Delivery → Pico Xpress and stop it with Pico if needed.`,
        shipment.orderId,
      );
      return { cancelled: false };
    }
  },
  verifyWebhook() {
    // Pico's webhooks have their own routes and token check (pico/webhook-auth.ts).
    return false;
  },
  parseWebhook() {
    return [];
  },
};
