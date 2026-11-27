/**
 * What the shop, the customer and operations see of a Pico shipment (docs/pico-xpress-2026-11). Times are
 * given as ISO (UTC) for the browser plus an IST label. The shop sees its pickup code, the customer their
 * delivery code; the rider's number only while the delivery is live.
 */
import { asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { deliveryShipmentEvents, deliveryShipments, type DeliveryShipment } from "@/server/db/pico-schema";

import { shipmentCodes } from "./codes";
import { tenDigitPhone } from "./payload";
import { BOOKING_FAILED, BOOKING_UNCONFIRMED, istTime } from "./service";
import { isTerminalPicoState, picoCancellable, picoRank, picoStateLabel } from "./status";

export interface PicoTimelineEntry {
  status: string;
  label: string;
  at: string;
  atIst: string;
  reason: string | null;
}

export interface PicoShipmentView {
  shipmentId: string;
  awbNumber: string;
  picoOrderId: string;
  status: string;
  statusLabel: string;
  live: boolean;
  paymentType: "COD" | "PREPAID";
  collectiblePaise: number;
  numBoxes: number;
  rider: { name: string | null; phone: string | null } | null;
  trackingUrl: string | null;
  pickupEtaMin: number | null;
  deliveryEtaMin: number | null;
  eta: string | null;
  etaIst: string | null;
  deliveredAt: string | null;
  deliveredAtIst: string | null;
  location: { lat: number; lng: number; at: string } | null;
  lastReason: string | null;
  cancellable: boolean;
  /** The create call was not confirmed: "Book again" re-sends the same order id and AWB. */
  unconfirmed: boolean;
  bookingFailed: boolean;
  timeline: PicoTimelineEntry[];
  /** Shop only. */
  pickupCode?: string;
  /** Customer only, until delivered. */
  deliveryCode?: string;
}

function liveStatus(s: DeliveryShipment) {
  return s.status !== BOOKING_FAILED && !isTerminalPicoState(s.status);
}

async function timelineFor(shipmentIds: string[]): Promise<Map<string, PicoTimelineEntry[]>> {
  if (shipmentIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(deliveryShipmentEvents)
    .where(inArray(deliveryShipmentEvents.shipmentId, shipmentIds))
    .orderBy(asc(deliveryShipmentEvents.eventTs), asc(deliveryShipmentEvents.receivedAt));
  const out = new Map<string, PicoTimelineEntry[]>();
  for (const r of rows) {
    if (!r.shipmentId) continue;
    const list = out.get(r.shipmentId) ?? [];
    if (list.some((e) => e.status === r.status)) continue; // one line per status (the first time it was reached)
    list.push({ status: r.status, label: picoStateLabel(r.status), at: r.eventTs.toISOString(), atIst: istTime(r.eventTs) ?? "", reason: r.reason });
    out.set(r.shipmentId, list);
  }
  return out;
}

function baseView(s: DeliveryShipment, timeline: PicoTimelineEntry[]): PicoShipmentView {
  const live = liveStatus(s);
  const delivered = s.status === "DELIVERED" ? (s.ata ?? s.lastEventAt) : null;
  return {
    shipmentId: s.id,
    awbNumber: s.awbNumber,
    picoOrderId: s.picoOrderId,
    status: s.status,
    statusLabel: s.status === BOOKING_UNCONFIRMED ? "Booking not confirmed yet" : s.status === BOOKING_FAILED ? "Booking refused" : picoStateLabel(s.status),
    live,
    paymentType: s.paymentType,
    collectiblePaise: s.collectiblePaise,
    numBoxes: s.numBoxes,
    rider: s.partnerName || s.partnerPhone ? { name: s.partnerName, phone: live ? (tenDigitPhone(s.partnerPhone) ?? null) : null } : null,
    trackingUrl: s.trackingUrl,
    pickupEtaMin: live && picoRank(s.status) < picoRank("PICKED") ? s.pickupEtaMin : null,
    deliveryEtaMin: live ? s.deliveryEtaMin : null,
    eta: live ? (s.eta?.toISOString() ?? null) : null,
    etaIst: live ? istTime(s.eta) : null,
    deliveredAt: delivered?.toISOString() ?? null,
    deliveredAtIst: istTime(delivered),
    location: live && s.lastLat && s.lastLng && s.lastLocationAt && Date.now() - s.lastLocationAt.getTime() < 15 * 60_000
      ? { lat: Number(s.lastLat), lng: Number(s.lastLng), at: s.lastLocationAt.toISOString() }
      : null,
    lastReason: s.lastReason,
    cancellable: s.status === BOOKING_UNCONFIRMED || picoCancellable(s.status),
    unconfirmed: s.status === BOOKING_UNCONFIRMED,
    bookingFailed: s.status === BOOKING_FAILED,
    timeline,
  };
}

async function latestShipments(orderIds: string[]): Promise<Map<string, DeliveryShipment>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db.select().from(deliveryShipments).where(inArray(deliveryShipments.orderId, orderIds)).orderBy(desc(deliveryShipments.createdAt));
  const out = new Map<string, DeliveryShipment>();
  for (const r of rows) if (!out.has(r.orderId)) out.set(r.orderId, r);
  return out;
}

export async function shopPicoViews(orderIds: string[]): Promise<Map<string, PicoShipmentView>> {
  const ships = await latestShipments(orderIds);
  const tl = await timelineFor([...ships.values()].map((s) => s.id));
  const out = new Map<string, PicoShipmentView>();
  for (const [orderId, s] of ships) {
    const v = baseView(s, tl.get(s.id) ?? []);
    if (v.live && picoRank(s.status) < picoRank("PICKED")) v.pickupCode = shipmentCodes(s.codeNonce).pickupOtp;
    out.set(orderId, v);
  }
  return out;
}

export async function buyerPicoViews(orderIds: string[]): Promise<Map<string, PicoShipmentView>> {
  const ships = await latestShipments(orderIds);
  const tl = await timelineFor([...ships.values()].map((s) => s.id));
  const out = new Map<string, PicoShipmentView>();
  for (const [orderId, s] of ships) {
    if (s.status === BOOKING_FAILED) continue;
    const v = baseView(s, tl.get(s.id) ?? []);
    if (v.live && s.status !== BOOKING_UNCONFIRMED) v.deliveryCode = shipmentCodes(s.codeNonce).consigneeOtp;
    out.set(orderId, v);
  }
  return out;
}

/** Operations: everything except the two codes. */
export async function adminPicoView(orderId: string): Promise<PicoShipmentView | null> {
  const ships = await latestShipments([orderId]);
  const s = ships.get(orderId);
  if (!s) return null;
  const tl = await timelineFor([s.id]);
  return baseView(s, tl.get(s.id) ?? []);
}

export async function shipmentById(id: string): Promise<DeliveryShipment | null> {
  const [row] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.id, id));
  return row ?? null;
}
