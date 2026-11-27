/**
 * Pico Xpress tracking payloads (doc pages 5, 6, 7) → our shapes (docs/pico-xpress-2026-11). Pure.
 *
 * Tolerant on purpose: the docs' field table and its sample disagree (shipmentState vs orderStatus,
 * shipmentCreatedTime vs createdTimestamp), the pull API answers a list, timestamps are epoch ms. Unknown
 * statuses are kept and logged, never rejected.
 */
import type { BookingStatus } from "@/server/db/hdms-schema";
import { PICO_STATES, type PicoState } from "@/server/db/pico-schema";

export interface PicoHistoryEntry {
  status: string;
  at: Date;
  lat: number | null;
  lng: number | null;
  reason: string | null;
}

export interface PicoTracking {
  awbNumber: string;
  status: string;
  createdAt: Date | null;
  trackingUrl: string | null;
  eta: Date | null;
  ata: Date | null;
  etd: Date | null;
  atd: Date | null;
  partnerName: string | null;
  partnerPhone: string | null;
  pickupEtaMin: number | null;
  deliveryEtaMin: number | null;
  history: PicoHistoryEntry[];
}

export interface PicoLocationPing {
  awbNumber: string;
  lat: number;
  lng: number;
  partnerName: string | null;
  partnerPhone: string | null;
  pickupEtaMin: number | null;
  deliveryEtaMin: number | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
/** Epoch ms (or seconds, or an ISO string) → Date; null for nonsense or out-of-range values. */
export function picoTime(v: unknown): Date | null {
  if (typeof v === "string" && v.trim() && !/^\d+$/.test(v.trim())) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const n = num(v);
  if (n == null || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n; // seconds were sent
  if (ms > 4102444800000) return null; // after 2100
  return new Date(ms);
}
const lat = (v: unknown) => {
  const n = num(v);
  return n != null && n >= -90 && n <= 90 && n !== 0 ? n : null;
};
const lng = (v: unknown) => {
  const n = num(v);
  return n != null && n >= -180 && n <= 180 && n !== 0 ? n : null;
};
const minutes = (v: unknown) => {
  const n = num(v);
  return n != null && n >= 0 && n < 100_000 ? Math.round(n) : null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Uppercase, underscores, letters only: what we store as a status (unknown ones too). */
export function normaliseStatus(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const clean = s.toUpperCase().replace(/[\s-]+/g, "_").replace(/[^A-Z_]/g, "");
  return clean ? clean.slice(0, 40) : null;
}

export function isKnownPicoState(s: string): s is PicoState {
  return (PICO_STATES as readonly string[]).includes(s);
}

/** One tracking object (a webhook body, or one element of the pull list) → PicoTracking, or null without an AWB. */
export function parseTrackingObject(raw: unknown): PicoTracking | null {
  const o = obj(raw);
  if (!o) return null;
  const awbNumber = str(o.awbNumber) ?? str(o.awb) ?? str(o.awb_number);
  if (!awbNumber || !/^[A-Za-z0-9-]{4,40}$/.test(awbNumber)) return null;
  const historyRaw = Array.isArray(o.statusHistory) ? o.statusHistory : Array.isArray(o.status_history) ? o.status_history : [];
  const history: PicoHistoryEntry[] = [];
  for (const h of historyRaw.slice(0, 100)) {
    const e = obj(h);
    if (!e) continue;
    const status = normaliseStatus(e.status ?? e.state);
    const at = picoTime(e.timeStamp ?? e.timestamp ?? e.time);
    if (!status || !at) continue;
    history.push({ status, at, lat: lat(e.lat), lng: lng(e.lng), reason: str(e.reason)?.slice(0, 300) ?? null });
  }
  history.sort((a, b) => a.at.getTime() - b.at.getTime() || picoRank(a.status) - picoRank(b.status));
  const partner = obj(o.partnerDetails);
  const estimates = obj(o.fulfillmentEstimates) ?? obj(o.fulfilmentEstimates);
  const status = normaliseStatus(o.orderStatus ?? o.shipmentState ?? o.status) ?? history.at(-1)?.status ?? null;
  if (!status) return null;
  const url = str(o.trackingUrl);
  return {
    awbNumber,
    status,
    createdAt: picoTime(o.createdTimestamp ?? o.shipmentCreatedTime),
    trackingUrl: url && /^https:\/\/[^\s]+$/i.test(url) ? url.slice(0, 500) : null,
    eta: picoTime(o.eta),
    ata: picoTime(o.ata),
    etd: picoTime(o.etd),
    atd: picoTime(o.atd),
    partnerName: str(partner?.name)?.slice(0, 80) ?? null,
    partnerPhone: str(partner?.contactNumber ?? partner?.phone)?.replace(/[^\d+]/g, "").slice(-13) || null,
    pickupEtaMin: minutes(estimates?.pickupEtaInMinutes),
    deliveryEtaMin: minutes(estimates?.deliveryEtaInMinutes),
    history,
  };
}

/** A webhook body or a pull `response`: one object, a list, or an object holding a list. */
export function parseTrackingPayload(raw: unknown): PicoTracking[] {
  if (Array.isArray(raw)) return raw.slice(0, 200).map(parseTrackingObject).filter((t): t is PicoTracking => t != null);
  const o = obj(raw);
  if (!o) return [];
  const one = parseTrackingObject(o);
  if (one) return [one];
  for (const v of Object.values(o)) if (Array.isArray(v)) return parseTrackingPayload(v);
  return [];
}

export function parseLocationPayload(raw: unknown): PicoLocationPing | null {
  const o = obj(raw);
  if (!o) return null;
  const awbNumber = str(o.awbNumber);
  const loc = obj(o.partnerLocation);
  const la = lat(loc?.lat);
  const ln = lng(loc?.lng);
  if (!awbNumber || !/^[A-Za-z0-9-]{4,40}$/.test(awbNumber) || la == null || ln == null) return null;
  const partner = obj(o.partnerDetails);
  const estimates = obj(o.fulfillmentEstimates);
  return {
    awbNumber,
    lat: la,
    lng: ln,
    partnerName: str(partner?.name)?.slice(0, 80) ?? null,
    partnerPhone: str(partner?.contactNumber)?.replace(/[^\d+]/g, "").slice(-13) || null,
    pickupEtaMin: minutes(estimates?.pickupEtaInMinutes),
    deliveryEtaMin: minutes(estimates?.deliveryEtaInMinutes),
  };
}

/**
 * Lifecycle order. A shipment's status never moves to a lower rank (late or repeated webhooks);
 * equal ranks (out for delivery ↔ attempted, a re-attempt) follow the newer event. Unknown = -1 (never applied).
 */
const RANK: Record<PicoState, number> = {
  DRAFT: 0,
  CREATED: 1,
  DP_ASSIGNED: 2,
  ARRIVED_AT_PICKUP: 3,
  PICKED: 4,
  OUT_FOR_DELIVERY: 5,
  ATTEMPTED_UNDELIVERED: 5,
  ARRIVED_AT_LOCATION: 6,
  RTO: 7,
  DELIVERED: 10,
  RTO_DELIVERED: 10,
  LOST: 10,
  DAMAGED: 10,
  CANCELLED: 10,
};
export function picoRank(status: string): number {
  return isKnownPicoState(status) ? RANK[status] : -1;
}
export const TERMINAL_PICO_STATES: readonly PicoState[] = ["DELIVERED", "RTO_DELIVERED", "LOST", "DAMAGED", "CANCELLED"];
export function isTerminalPicoState(status: string): boolean {
  return (TERMINAL_PICO_STATES as readonly string[]).includes(status);
}

/** Whether the shipment's stored status should move to `next` (event at `nextAt`, last event at `lastAt`). */
export function shouldAdvance(current: string, next: string, nextAt: Date, lastAt: Date | null): boolean {
  if (!isKnownPicoState(next)) return false;
  if (isTerminalPicoState(current)) return false;
  const from = picoRank(current);
  const to = picoRank(next);
  if (to > from) return true;
  if (to === from && current !== next) return lastAt == null || nextAt.getTime() >= lastAt.getTime();
  return false;
}

/** Pico state → HDMS booking status; null = no booking change (attempted, draft, unknown). */
export function bookingStatusFor(status: string): BookingStatus | null {
  switch (status) {
    case "DRAFT":
    case "CREATED":
      return "CREATED";
    case "DP_ASSIGNED":
      return "ASSIGNED";
    case "ARRIVED_AT_PICKUP":
      return "AT_PICKUP";
    case "PICKED":
      return "PICKED_UP";
    case "OUT_FOR_DELIVERY":
    case "ARRIVED_AT_LOCATION":
      return "IN_TRANSIT";
    case "DELIVERED":
      return "DELIVERED";
    case "RTO":
      return "RETURNING";
    case "RTO_DELIVERED":
      return "RETURNED";
    case "LOST":
    case "DAMAGED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return null;
  }
}

const FORWARD: BookingStatus[] = ["CREATED", "ASSIGNED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "DELIVERED"];

/**
 * The booking statuses to apply, in order, to go from `from` to `to` when Pico skipped events (a missed
 * webhook): forward moves walk the chain; RTO after a missed pickup passes through PICKED_UP; anything
 * else is applied directly (the booking state machine ignores what it does not allow).
 */
export function bookingSteps(from: BookingStatus, to: BookingStatus): BookingStatus[] {
  if (from === to) return [];
  const a = FORWARD.indexOf(from);
  const b = FORWARD.indexOf(to);
  if (a >= 0 && b > a) return FORWARD.slice(a + 1, b + 1);
  if ((to === "RETURNING" || to === "RETURNED") && a >= 0 && a < FORWARD.indexOf("PICKED_UP")) {
    return [...FORWARD.slice(a + 1, FORWARD.indexOf("PICKED_UP") + 1), ...(to === "RETURNED" ? (["RETURNING", "RETURNED"] as BookingStatus[]) : (["RETURNING"] as BookingStatus[]))];
  }
  if (to === "RETURNED" && (from === "PICKED_UP" || from === "IN_TRANSIT" || from === "FAILED")) return ["RETURNING", "RETURNED"];
  return [to];
}

/** Customer / shop words for a Pico state (unknown ones shown as Pico sent them). */
export const PICO_STATE_LABELS: Record<PicoState, string> = {
  DRAFT: "Booking the delivery partner",
  CREATED: "Delivery partner booked",
  DP_ASSIGNED: "Rider assigned",
  ARRIVED_AT_PICKUP: "Rider at the shop",
  PICKED: "Picked up",
  OUT_FOR_DELIVERY: "Out for delivery",
  ARRIVED_AT_LOCATION: "Rider has arrived",
  ATTEMPTED_UNDELIVERED: "Delivery attempted",
  DELIVERED: "Delivered",
  RTO: "Returning to the shop",
  RTO_DELIVERED: "Returned to the shop",
  LOST: "Lost in transit",
  CANCELLED: "Cancelled",
  DAMAGED: "Damaged in transit",
};
export function picoStateLabel(status: string): string {
  return isKnownPicoState(status) ? PICO_STATE_LABELS[status] : status.replace(/_/g, " ").toLowerCase();
}

/** Cancel is allowed only before pickup: while Pico still has the shipment as DRAFT or CREATED. */
export function picoCancellable(status: string): boolean {
  return status === "DRAFT" || status === "CREATED";
}
