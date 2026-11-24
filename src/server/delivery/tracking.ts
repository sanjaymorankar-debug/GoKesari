/** Customer-facing tracking of a partner delivery (docs/hdms-2026-11). Only masked rider details leave the server. */
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { deliveryBookings, deliveryProviders, TERMINAL_BOOKING_STATUSES } from "@/server/db/hdms-schema";

import { BOOKING_STATUS_LABELS } from "./bookings";

export interface PartnerTrackingView {
  providerName: string;
  status: string;
  statusLabel: string;
  etaAt: string | null;
  riderName: string | null;
  riderPhoneMasked: string | null;
  trackingUrl: string | null;
  riderLocation: { latitude: number; longitude: number; recordedAt: string } | null;
  finished: boolean;
}

export async function partnerTrackingFor(orderId: string): Promise<PartnerTrackingView | null> {
  const [row] = await db
    .select({ b: deliveryBookings, providerName: deliveryProviders.name })
    .from(deliveryBookings)
    .leftJoin(deliveryProviders, eq(deliveryProviders.code, deliveryBookings.providerCode))
    .where(and(eq(deliveryBookings.orderId, orderId), eq(deliveryBookings.channel, "EXTERNAL")))
    .orderBy(desc(deliveryBookings.createdAt))
    .limit(1);
  if (!row) return null;
  const b = row.b;
  const fresh = b.riderLocationAt && Date.now() - b.riderLocationAt.getTime() <= 10 * 60_000;
  return {
    providerName: row.providerName ?? "Delivery partner",
    status: b.status,
    statusLabel: BOOKING_STATUS_LABELS[b.status],
    etaAt: b.etaAt?.toISOString() ?? null,
    riderName: b.riderName,
    riderPhoneMasked: b.riderPhoneMasked,
    trackingUrl: b.trackingUrl && /^https:\/\//.test(b.trackingUrl) ? b.trackingUrl : null,
    riderLocation:
      fresh && b.riderLat && b.riderLng ? { latitude: Number(b.riderLat), longitude: Number(b.riderLng), recordedAt: b.riderLocationAt!.toISOString() } : null,
    finished: TERMINAL_BOOKING_STATUSES.includes(b.status),
  };
}
