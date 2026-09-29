import { and, count, desc, eq, inArray, lt, min, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  deliveryOrderStatusEnum,
  deliveryOrders,
  grievances,
  orderStatusEnum,
  type DeliveryOrderStatus,
  type GrievanceStatus,
  type Order,
  type OrderStatus,
} from "@/server/db/schema";
import { OFFER_TTL_SECONDS } from "./delivery-assignment";
import { SETTLEMENT_HOLD_DAYS } from "./finance";
import { ORDER_STATUS_LABELS } from "./orders";

export const OPS_EXCEPTION_THRESHOLDS = {
  // Minutes a 30-minute express order may sit unaccepted: a sixth of its whole window.
  shopAcceptExpress: 5,
  // Minutes any other order may sit unaccepted before it is flagged.
  shopAcceptOther: 10,
  // Minutes unaccepted after which the order is critical whatever its window.
  shopAcceptCritical: 30,
  // Minutes allowed past the shop's own preparation_time_minutes, counted from acceptance.
  prepGraceAfterPrepTime: 10,
  // Minutes a proposed substitute may wait for the customer; it blocks READY until answered.
  substitutionWait: 10,
  // Minutes READY without a rider: longer than two offer TTLs (2 x 120 s) plus one dispatch sweep tick.
  noRiderWarning: 5,
  // Minutes READY without a rider before it is critical: two more sweep cycles past the warning.
  noRiderCritical: 10,
  // Minutes READY at a shop without platform delivery before the hand-over is overdue.
  selfDeliveryReady: 30,
  // Minutes after a rider accepts before a missing pickup is flagged.
  riderPickupWait: 20,
  // Minutes after which a rider's last shared location counts as stale.
  riderStaleLocation: 5,
  // Minutes after pickup before a drop that has not been started is flagged.
  dropNotStarted: 10,
  // Minutes added to the leg ETA (distance at legSpeedKmh, else the shop's service radius).
  outForDeliveryGrace: 10,
  // Minutes added to the return-leg ETA after a failed drop before a decision is overdue.
  failedDecisionGrace: 15,
  // Return-leg ETA in minutes when the delivery distance is unknown.
  returnLegFallback: 15,
  // Minutes goods may sit back at the shop without a refund decision.
  returnedDecision: 60,
  // Hours after which a dispute is called out as open for over a day.
  disputeWarningHours: 24,
  // Hours after which a dispute is critical: the shop settlement hold (SETTLEMENT_HOLD_DAYS).
  disputeCriticalHours: SETTLEMENT_HOLD_DAYS * 24,
  // Seconds an OFFERED row may exist before the dispatch sweep looks down: two offer TTLs.
  dispatchSweepStaleSeconds: OFFER_TTL_SECONDS * 2,
  // Flat speed for leg ETAs, the same as ASSUMED_AVERAGE_SPEED_KMH in delivery-feasibility.ts.
  legSpeedKmh: 20,
  // Wrong delivery-code attempts that lock the rider out (MAX_OTP_ATTEMPTS in delivery-assignment.ts).
  otpLockAttempts: 5,
} as const;

const T = OPS_EXCEPTION_THRESHOLDS;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const OPS_EXCEPTION_ROW_LIMIT = 300;

export const OPS_EXCEPTION_CATEGORIES = [
  "SHOP_NOT_ACCEPTING",
  "SHOP_SLOW",
  "AWAITING_SUBSTITUTION",
  "NO_RIDER",
  "SELF_DELIVERY_OVERDUE",
  "RIDER_NOT_PICKED_UP",
  "STUCK_AFTER_PICKUP",
  "OTP_LOCKED",
  "FAILED_DELIVERY",
  "RETURNED_PENDING",
  "DISPUTED",
  "LATE",
] as const;

export type OpsExceptionCategory = (typeof OPS_EXCEPTION_CATEGORIES)[number];
export type OpsExceptionSeverity = "WARNING" | "CRITICAL";

export const OPS_EXCEPTION_PRECEDENCE: readonly OpsExceptionCategory[] = [
  "OTP_LOCKED",
  "STUCK_AFTER_PICKUP",
  "RIDER_NOT_PICKED_UP",
  "NO_RIDER",
  "SELF_DELIVERY_OVERDUE",
  "AWAITING_SUBSTITUTION",
  "SHOP_SLOW",
  "SHOP_NOT_ACCEPTING",
  "FAILED_DELIVERY",
  "RETURNED_PENDING",
  "DISPUTED",
  "LATE",
];

export const OPS_EXCEPTION_CATEGORY_LABELS: Record<OpsExceptionCategory, string> = {
  SHOP_NOT_ACCEPTING: "Shop not accepting",
  SHOP_SLOW: "Shop slow to prepare",
  AWAITING_SUBSTITUTION: "Waiting on a substitute",
  NO_RIDER: "No rider",
  SELF_DELIVERY_OVERDUE: "Shop hand-over overdue",
  RIDER_NOT_PICKED_UP: "Rider not picked up",
  STUCK_AFTER_PICKUP: "Stuck after pickup",
  OTP_LOCKED: "Delivery code locked",
  FAILED_DELIVERY: "Failed delivery",
  RETURNED_PENDING: "Returned, no decision",
  DISPUTED: "Disputed",
  LATE: "Past promised time",
};

const CATEGORY_VALUES: readonly string[] = OPS_EXCEPTION_CATEGORIES;

export function isOpsExceptionCategory(value: unknown): value is OpsExceptionCategory {
  return typeof value === "string" && CATEGORY_VALUES.includes(value);
}

export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 6 && rest > 0) return `${hours} h ${rest} min`;
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

type PaymentMethod = Order["paymentMethod"];

export interface OpsExceptionGrievance {
  id: string;
  ticketNumber: string;
  status: GrievanceStatus;
  subject: string;
}

export interface OpsExceptionRow {
  orderId: string;
  orderNumber: string;
  shopId: string;
  shopName: string;
  customerName: string | null;
  orderStatus: OrderStatus;
  category: OpsExceptionCategory;
  severity: OpsExceptionSeverity;
  enteredAt: Date;
  clockLabel: string;
  promisedByAt: Date | null;
  lateByMinutes: number | null;
  dueInMinutes: number | null;
  paymentMethod: PaymentMethod;
  isCod: boolean;
  isPaid: boolean;
  totalPaise: number;
  deliveryStatus: DeliveryOrderStatus | null;
  hasActiveRider: boolean;
  riderName: string | null;
  riderOnline: boolean | null;
  riderLastLocationAt: Date | null;
  otpLocked: boolean;
  failureReason: string | null;
  openGrievance: OpsExceptionGrievance | null;
  detail: string;
}

export interface OpsExceptionCounts {
  total: number;
  critical: number;
}

export interface OpsExceptionHealth {
  dispatchSweepLooksDown: boolean;
  staleOfferCount: number;
  oldestStaleOfferAt: Date | null;
  offerTtlSeconds: number;
  staleAfterSeconds: number;
}

export interface OpsExceptionQueue {
  generatedAt: Date;
  rows: OpsExceptionRow[];
  matchingRows: number;
  capped: boolean;
  rowLimit: number;
  summary: OpsExceptionCounts & { byCategory: Record<OpsExceptionCategory, OpsExceptionCounts> };
  health: OpsExceptionHealth;
}

const ACTIVE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "CONFIRMED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
]);
const LIVE_DELIVERY_STATUSES: ReadonlySet<DeliveryOrderStatus> = new Set<DeliveryOrderStatus>([
  "OFFERED",
  "ACCEPTED",
  "PICKED_UP",
]);

const ORDER_STATUS_VALUES: readonly string[] = orderStatusEnum.enumValues;
const DELIVERY_STATUS_VALUES: readonly string[] = deliveryOrderStatusEnum.enumValues;

function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && ORDER_STATUS_VALUES.includes(value);
}

function isDeliveryStatus(value: unknown): value is DeliveryOrderStatus {
  return typeof value === "string" && DELIVERY_STATUS_VALUES.includes(value);
}

function text(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : String(value);
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function kilometres(value: unknown): number | null {
  const raw = text(value);
  if (raw == null) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

interface CandidateDelivery {
  status: DeliveryOrderStatus;
  offeredAt: number | null;
  acceptedAt: number | null;
  pickedUpAt: number | null;
  outForDeliveryAt: number | null;
  failedAt: number | null;
  failureReason: string | null;
  distanceKm: number | null;
  otpAttempts: number;
  rejectedCount: number;
  riderName: string;
  riderOnline: boolean;
  riderLastLocationAt: number | null;
}

interface CandidateOrder {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  source: string;
  deliveryWindow: string | null;
  paymentMethod: PaymentMethod;
  isPaid: boolean;
  totalPaise: number;
  enteredAt: number;
  acceptedAt: number | null;
  promisedByAt: number | null;
  shopId: string;
  shopName: string;
  shopDeliveryAvailable: boolean;
  shopHasLocation: boolean;
  preparationMinutes: number;
  serviceRadiusKm: number;
  customerName: string | null;
  substitutionSince: number | null;
  delivery: CandidateDelivery | null;
}

function parseCandidate(row: Record<string, unknown>): CandidateOrder | null {
  const status = row.status;
  const orderId = text(row.order_id);
  const orderNumber = text(row.order_number);
  const shopId = text(row.shop_id);
  const enteredAt = num(row.entered_ms);
  if (!isOrderStatus(status) || !orderId || !orderNumber || !shopId || enteredAt == null) return null;

  const deliveryStatus = row.delivery_status;
  const delivery: CandidateDelivery | null = isDeliveryStatus(deliveryStatus)
    ? {
        status: deliveryStatus,
        offeredAt: num(row.offered_ms),
        acceptedAt: num(row.rider_accepted_ms),
        pickedUpAt: num(row.picked_up_ms),
        outForDeliveryAt: num(row.out_for_delivery_ms),
        failedAt: num(row.failed_ms),
        failureReason: text(row.failure_reason),
        distanceKm: kilometres(row.distance_km),
        otpAttempts: num(row.delivery_otp_attempts) ?? 0,
        rejectedCount: num(row.rejected_count) ?? 0,
        riderName: text(row.rider_name) ?? "The rider",
        riderOnline: row.rider_online === true,
        riderLastLocationAt: num(row.rider_location_ms),
      }
    : null;

  return {
    orderId,
    orderNumber,
    status,
    source: text(row.source) ?? "DIRECT",
    deliveryWindow: text(row.delivery_window),
    paymentMethod: row.payment_method === "COD" ? "COD" : "WALLET",
    isPaid: row.is_paid === true,
    totalPaise: Math.round(num(row.total_paise) ?? 0),
    enteredAt,
    acceptedAt: num(row.accepted_ms),
    promisedByAt: num(row.promised_ms),
    shopId,
    shopName: text(row.shop_name) ?? "",
    shopDeliveryAvailable: row.delivery_available === true,
    shopHasLocation: row.shop_has_location === true,
    preparationMinutes: num(row.preparation_time_minutes) ?? 0,
    serviceRadiusKm: num(row.service_radius_km) ?? 0,
    customerName: text(row.customer_name),
    substitutionSince: num(row.substitution_ms),
    delivery,
  };
}

interface Detection {
  severity: OpsExceptionSeverity;
  since: number;
  clockLabel: string;
  detail: string;
}

type Detector = (order: CandidateOrder, now: number) => Detection | null;

const WINDOW_PHRASES: Record<string, string> = {
  EXPRESS_30: "30-minute express order",
  STANDARD_60: "60-minute order",
  SCHEDULED: "scheduled order",
};

function ago(from: number, now: number): string {
  return `${formatElapsed(now - from)} ago`;
}

function riderLegStart(delivery: CandidateDelivery | null): number | null {
  if (!delivery || delivery.status !== "PICKED_UP" || delivery.outForDeliveryAt == null) return null;
  if (delivery.pickedUpAt != null && delivery.outForDeliveryAt < delivery.pickedUpAt) return null;
  return delivery.outForDeliveryAt;
}

function legEtaMinutes(km: number): number {
  return (km / T.legSpeedKmh) * 60;
}

function riderPresence(delivery: CandidateDelivery, now: number): { stale: boolean; sentence: string } {
  const name = delivery.riderName;
  if (!delivery.riderOnline) return { stale: true, sentence: `${name} is offline.` };
  if (delivery.riderLastLocationAt == null) return { stale: true, sentence: `${name} is online but has not shared a location.` };
  const age = now - delivery.riderLastLocationAt;
  if (age > T.riderStaleLocation * MINUTE_MS) {
    return { stale: true, sentence: `${name} is online but their last location is ${formatElapsed(age)} old.` };
  }
  return { stale: false, sentence: `${name} is online and sharing their location.` };
}

function noRiderReason(order: CandidateOrder, now: number): string {
  if (!order.shopHasLocation) return "The shop has no location on file, so no rider can be matched to it.";
  const delivery = order.delivery;
  if (!delivery) return "No rider has been offered this order yet.";
  if (delivery.status === "OFFERED" && delivery.offeredAt != null) {
    const expiresAt = delivery.offeredAt + OFFER_TTL_SECONDS * 1000;
    return now > expiresAt
      ? `The offer to ${delivery.riderName} ran out ${ago(expiresAt, now)} but was not passed to another rider, which the dispatch sweep should have done.`
      : `Offered to ${delivery.riderName} ${ago(delivery.offeredAt, now)}; waiting for an answer.`;
  }
  if (delivery.status === "REJECTED" || delivery.status === "CANCELLED") {
    const declined = delivery.rejectedCount;
    return declined > 0
      ? `${declined} ${declined === 1 ? "rider has" : "riders have"} declined or let the offer run out, and no other eligible rider was free at the last attempt.`
      : "The last rider assignment was cancelled and no rider has been found since.";
  }
  return "No rider is working on this order.";
}

const DETECTORS: Record<OpsExceptionCategory, Detector> = {
  SHOP_NOT_ACCEPTING(order, now) {
    if (order.status !== "CONFIRMED" || order.source !== "DIRECT") return null;
    const waited = now - order.enteredAt;
    const limit = order.deliveryWindow === "EXPRESS_30" ? T.shopAcceptExpress : T.shopAcceptOther;
    if (waited <= limit * MINUTE_MS) return null;
    const cannotMakePromise =
      order.promisedByAt != null && now > order.promisedByAt - order.preparationMinutes * MINUTE_MS;
    const kind = (order.deliveryWindow && WINDOW_PHRASES[order.deliveryWindow]) || "order";
    return {
      severity: waited > T.shopAcceptCritical * MINUTE_MS || cannotMakePromise ? "CRITICAL" : "WARNING",
      since: order.enteredAt,
      clockLabel: "waiting for the shop to accept",
      detail:
        `The shop has not accepted this ${kind} after ${formatElapsed(waited)}.` +
        (cannotMakePromise && order.promisedByAt != null && now <= order.promisedByAt
          ? ` With its ${order.preparationMinutes}-minute preparation time it can no longer be ready by the promised time.`
          : ""),
    };
  },

  SHOP_SLOW(order, now) {
    if (order.status !== "ACCEPTED" && order.status !== "PREPARING") return null;
    if (order.substitutionSince != null) return null;
    const start = order.acceptedAt ?? order.enteredAt;
    if (now <= start + (order.preparationMinutes + T.prepGraceAfterPrepTime) * MINUTE_MS) return null;
    return {
      severity: "WARNING",
      since: start,
      clockLabel: "since the shop accepted",
      detail:
        order.status === "ACCEPTED"
          ? `Accepted ${ago(start, now)} and picking has not started. The shop's preparation time is ${order.preparationMinutes} min.`
          : `Still being prepared ${formatElapsed(now - start)} after acceptance. The shop's preparation time is ${order.preparationMinutes} min.`,
    };
  },

  AWAITING_SUBSTITUTION(order, now) {
    if (order.status !== "PREPARING" || order.substitutionSince == null) return null;
    if (now - order.substitutionSince <= T.substitutionWait * MINUTE_MS) return null;
    return {
      severity: "WARNING",
      since: order.substitutionSince,
      clockLabel: "since a substitute was offered",
      detail: `A substitute was offered to the customer ${ago(order.substitutionSince, now)} with no answer yet. The order cannot be marked ready until they approve or reject it.`,
    };
  },

  NO_RIDER(order, now) {
    if (order.status !== "READY" || !order.shopDeliveryAvailable) return null;
    const waited = now - order.enteredAt;
    if (waited <= T.noRiderWarning * MINUTE_MS) return null;
    return {
      severity: waited >= T.noRiderCritical * MINUTE_MS ? "CRITICAL" : "WARNING",
      since: order.enteredAt,
      clockLabel: "since marked ready",
      detail: noRiderReason(order, now),
    };
  },

  SELF_DELIVERY_OVERDUE(order, now) {
    if (order.status !== "READY" || order.shopDeliveryAvailable) return null;
    const waited = now - order.enteredAt;
    const pastPromise = order.promisedByAt != null && now > order.promisedByAt;
    if (waited <= T.selfDeliveryReady * MINUTE_MS && !pastPromise) return null;
    return {
      severity: "WARNING",
      since: order.enteredAt,
      clockLabel: "since marked ready",
      detail: `This shop does not use platform riders, so it must hand the order over itself. It has been ready for ${formatElapsed(waited)} without going out.`,
    };
  },

  RIDER_NOT_PICKED_UP(order, now) {
    const delivery = order.delivery;
    if (order.status !== "ASSIGNED" || delivery?.status !== "ACCEPTED" || delivery.acceptedAt == null) return null;
    if (now - delivery.acceptedAt <= T.riderPickupWait * MINUTE_MS) return null;
    const presence = riderPresence(delivery, now);
    return {
      severity: presence.stale ? "CRITICAL" : "WARNING",
      since: delivery.acceptedAt,
      clockLabel: "since the rider accepted",
      detail: `${delivery.riderName} accepted ${ago(delivery.acceptedAt, now)} and has not collected the order. ${presence.sentence}`,
    };
  },

  STUCK_AFTER_PICKUP(order, now) {
    const delivery = order.delivery;
    if (order.status === "PICKED_UP") {
      if (delivery?.status !== "PICKED_UP" || delivery.pickedUpAt == null || riderLegStart(delivery) != null) return null;
      if (now - delivery.pickedUpAt <= T.dropNotStarted * MINUTE_MS) return null;
      return {
        severity: "WARNING",
        since: delivery.pickedUpAt,
        clockLabel: "since pickup",
        detail: `${delivery.riderName} picked the order up ${ago(delivery.pickedUpAt, now)} but has not started the drop. ${riderPresence(delivery, now).sentence}`,
      };
    }
    if (order.status !== "OUT_FOR_DELIVERY") return null;
    const start = riderLegStart(delivery) ?? order.enteredAt;
    const knownKm = delivery?.distanceKm ?? null;
    const km = knownKm ?? order.serviceRadiusKm;
    const eta = legEtaMinutes(km);
    if (now <= start + (eta + T.outForDeliveryGrace) * MINUTE_MS) return null;
    const distance = knownKm != null ? `${km.toFixed(1)} km` : `the shop's ${order.serviceRadiusKm} km delivery radius`;
    const expectation = `About ${Math.ceil(eta)} min was expected for ${distance}, plus ${T.outForDeliveryGrace} min grace.`;
    const elapsed = formatElapsed(now - start);
    const carrier =
      delivery?.status === "PICKED_UP"
        ? `${delivery.riderName} has been on the way to the customer for ${elapsed}.`
        : delivery?.status === "OFFERED" || delivery?.status === "ACCEPTED"
          ? `Marked out for delivery ${elapsed} ago while ${delivery.riderName}'s assignment is still ${delivery.status === "OFFERED" ? "an unanswered offer" : "accepted but not picked up"} in the app.`
          : delivery?.status === "FAILED"
            ? `Out for delivery again for ${elapsed} after a failed rider attempt, with no rider assigned in the app.`
            : `The shop is delivering this itself and it has been out for ${elapsed}.`;
    return {
      severity: "WARNING",
      since: start,
      clockLabel: "since it left for the customer",
      detail: `${carrier} ${expectation}`,
    };
  },

  OTP_LOCKED(order, now) {
    const delivery = order.delivery;
    if (order.status !== "PICKED_UP" && order.status !== "OUT_FOR_DELIVERY") return null;
    if (delivery?.status !== "PICKED_UP" || delivery.otpAttempts < T.otpLockAttempts) return null;
    const start = riderLegStart(delivery) ?? order.enteredAt;
    return {
      severity: "CRITICAL",
      since: start,
      clockLabel: "since it left for the customer",
      detail: `The customer's delivery code was entered wrong ${delivery.otpAttempts} times, so ${delivery.riderName} cannot complete the drop in the app. Confirm the delivery once you have proof of hand-over, or cancel. ${riderPresence(delivery, now).sentence}`,
    };
  },

  FAILED_DELIVERY(order, now) {
    if (order.status !== "FAILED") return null;
    const delivery = order.delivery;
    const start = delivery?.status === "FAILED" && delivery.failedAt != null ? delivery.failedAt : order.enteredAt;
    const knownKm = delivery?.distanceKm ?? null;
    const returnEta = knownKm != null ? legEtaMinutes(knownKm) : T.returnLegFallback;
    const decisionDue = start + (returnEta + T.failedDecisionGrace) * MINUTE_MS;
    const reason = delivery?.status === "FAILED" ? delivery.failureReason : null;
    const overdue = now > decisionDue;
    return {
      severity: overdue ? "CRITICAL" : "WARNING",
      since: start,
      clockLabel: "since the delivery failed",
      detail:
        `Delivery failed ${ago(start, now)}${reason ? `: "${reason}"` : "."}` +
        (overdue
          ? " Allowing for the ride back, the goods should be at the shop by now. Mark it returned once the shop confirms, or cancel."
          : ` Allowing for the ride back, the goods should be at the shop in about ${formatElapsed(decisionDue - now)}.`),
    };
  },

  RETURNED_PENDING(order, now) {
    if (order.status !== "RETURNED") return null;
    const waited = now - order.enteredAt;
    return {
      severity: waited >= T.returnedDecision * MINUTE_MS ? "CRITICAL" : "WARNING",
      since: order.enteredAt,
      clockLabel: "since it was returned",
      detail:
        order.isPaid && order.totalPaise > 0
          ? "The goods are back at the shop. The customer stays charged until the order is cancelled; nothing cancels it automatically."
          : "The goods are back at the shop. Nothing was charged; cancel the order to close it and put the stock back.",
    };
  },

  DISPUTED(order, now) {
    if (order.status !== "DISPUTED") return null;
    const age = now - order.enteredAt;
    return {
      severity: age >= T.disputeCriticalHours * HOUR_MS ? "CRITICAL" : "WARNING",
      since: order.enteredAt,
      clockLabel: "under dispute",
      detail:
        `Under dispute for ${formatElapsed(age)}.` +
        (age > T.disputeWarningHours * HOUR_MS ? ` Open for over ${T.disputeWarningHours} h.` : "") +
        " Close it with no refund, or refund the customer in full or in part.",
    };
  },

  LATE(order, now) {
    if (!ACTIVE_STATUSES.has(order.status) || order.promisedByAt == null || now <= order.promisedByAt) return null;
    return {
      severity: "CRITICAL",
      since: order.enteredAt,
      clockLabel: "in this status",
      detail: `Past its promised delivery time by ${formatElapsed(now - order.promisedByAt)} and still ${ORDER_STATUS_LABELS[order.status].toLowerCase()}.`,
    };
  },
};

function classify(order: CandidateOrder, now: number): (Detection & { category: OpsExceptionCategory }) | null {
  for (const category of OPS_EXCEPTION_PRECEDENCE) {
    const hit = DETECTORS[category](order, now);
    if (hit) return { ...hit, category };
  }
  return null;
}

function riderIsRelevant(order: CandidateOrder): boolean {
  const delivery = order.delivery;
  if (!delivery) return false;
  if (LIVE_DELIVERY_STATUSES.has(delivery.status)) return true;
  if (delivery.status === "FAILED") return order.status === "FAILED" || order.status === "RETURNED";
  return delivery.status === "DELIVERED" && order.status === "DISPUTED";
}

function toRow(order: CandidateOrder, hit: Detection & { category: OpsExceptionCategory }, now: number): OpsExceptionRow {
  const promiseApplies = ACTIVE_STATUSES.has(order.status) && order.promisedByAt != null;
  const pastPromise = promiseApplies && order.promisedByAt != null && now > order.promisedByAt;
  const delivery = order.delivery;
  const showRider = riderIsRelevant(order);
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    shopId: order.shopId,
    shopName: order.shopName,
    customerName: order.customerName,
    orderStatus: order.status,
    category: hit.category,
    severity: pastPromise ? "CRITICAL" : hit.severity,
    enteredAt: new Date(hit.since),
    clockLabel: hit.clockLabel,
    promisedByAt: order.promisedByAt != null ? new Date(order.promisedByAt) : null,
    lateByMinutes: pastPromise && order.promisedByAt != null ? Math.floor((now - order.promisedByAt) / MINUTE_MS) : null,
    dueInMinutes:
      promiseApplies && !pastPromise && order.promisedByAt != null
        ? Math.ceil((order.promisedByAt - now) / MINUTE_MS)
        : null,
    paymentMethod: order.paymentMethod,
    isCod: order.paymentMethod === "COD",
    isPaid: order.isPaid,
    totalPaise: order.totalPaise,
    deliveryStatus: delivery?.status ?? null,
    hasActiveRider: delivery != null && LIVE_DELIVERY_STATUSES.has(delivery.status),
    riderName: showRider && delivery ? delivery.riderName : null,
    riderOnline: showRider && delivery ? delivery.riderOnline : null,
    riderLastLocationAt:
      showRider && delivery?.riderLastLocationAt != null ? new Date(delivery.riderLastLocationAt) : null,
    otpLocked: delivery?.status === "PICKED_UP" && delivery.otpAttempts >= T.otpLockAttempts,
    failureReason: delivery?.status === "FAILED" ? delivery.failureReason : null,
    openGrievance: null,
    detail: hit.detail,
  };
}

const CANDIDATES_QUERY = sql`
  select
    o.id as order_id,
    o.order_number,
    o.status,
    o.source,
    o.delivery_window,
    o.payment_method,
    o.total_paise,
    (o.paid_at is not null) as is_paid,
    (extract(epoch from coalesce(h.entered_at, o.created_at)) * 1000)::float8 as entered_ms,
    (extract(epoch from o.accepted_at) * 1000)::float8 as accepted_ms,
    (extract(epoch from o.promised_by_at) * 1000)::float8 as promised_ms,
    s.id as shop_id,
    s.name as shop_name,
    s.delivery_available,
    s.preparation_time_minutes,
    s.service_radius_km,
    (s.latitude is not null and s.longitude is not null) as shop_has_location,
    u.name as customer_name,
    d.status as delivery_status,
    (extract(epoch from d.offered_at) * 1000)::float8 as offered_ms,
    (extract(epoch from d.accepted_at) * 1000)::float8 as rider_accepted_ms,
    (extract(epoch from d.picked_up_at) * 1000)::float8 as picked_up_ms,
    (extract(epoch from d.out_for_delivery_at) * 1000)::float8 as out_for_delivery_ms,
    (extract(epoch from d.failed_at) * 1000)::float8 as failed_ms,
    d.failure_reason,
    d.distance_km,
    d.delivery_otp_attempts,
    coalesce(cardinality(d.rejected_partner_ids), 0) as rejected_count,
    p.full_name as rider_name,
    p.is_online as rider_online,
    (extract(epoch from p.last_location_at) * 1000)::float8 as rider_location_ms,
    case when o.status = 'PREPARING' then (
      select (extract(epoch from min(coalesce(i.fulfilment_updated_at, i.created_at))) * 1000)::float8
      from order_items i
      where i.order_id = o.id and i.fulfilment_status = 'SUBSTITUTION_PROPOSED'
    ) end as substitution_ms
  from orders o
  join shops s on s.id = o.shop_id
  join users u on u.id = o.user_id
  left join delivery_orders d on d.order_id = o.id
  left join delivery_partners p on p.id = d.delivery_partner_id
  left join lateral (
    select max(x.created_at) as entered_at
    from order_status_history x
    where x.order_id = o.id and x.new_status = o.status
  ) h on true
  where o.status in ('CONFIRMED', 'ACCEPTED', 'PREPARING', 'READY', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'FAILED', 'RETURNED', 'DISPUTED')
`;

async function loadDispatchHealth(): Promise<OpsExceptionHealth> {
  const [row] = await db
    .select({ staleOffers: count(), oldestOfferedAt: min(deliveryOrders.offeredAt) })
    .from(deliveryOrders)
    .where(
      and(
        eq(deliveryOrders.status, "OFFERED"),
        lt(deliveryOrders.offeredAt, sql`now() - make_interval(secs => ${T.dispatchSweepStaleSeconds})`),
      ),
    );
  const staleOfferCount = row?.staleOffers ?? 0;
  return {
    dispatchSweepLooksDown: staleOfferCount > 0,
    staleOfferCount,
    oldestStaleOfferAt: row?.oldestOfferedAt ?? null,
    offerTtlSeconds: OFFER_TTL_SECONDS,
    staleAfterSeconds: T.dispatchSweepStaleSeconds,
  };
}

async function loadOpenGrievances(orderIds: string[]): Promise<Map<string, OpsExceptionGrievance>> {
  const found = new Map<string, OpsExceptionGrievance>();
  if (orderIds.length === 0) return found;
  const rows = await db
    .select({
      id: grievances.id,
      orderId: grievances.orderId,
      ticketNumber: grievances.ticketNumber,
      status: grievances.status,
      subject: grievances.subject,
    })
    .from(grievances)
    .where(and(inArray(grievances.orderId, orderIds), inArray(grievances.status, ["OPEN", "IN_PROGRESS"])))
    .orderBy(desc(grievances.createdAt));
  for (const row of rows) {
    if (row.orderId && !found.has(row.orderId)) {
      found.set(row.orderId, { id: row.id, ticketNumber: row.ticketNumber, status: row.status, subject: row.subject });
    }
  }
  return found;
}

function emptyCounts(): Record<OpsExceptionCategory, OpsExceptionCounts> {
  const zero = (): OpsExceptionCounts => ({ total: 0, critical: 0 });
  return {
    SHOP_NOT_ACCEPTING: zero(),
    SHOP_SLOW: zero(),
    AWAITING_SUBSTITUTION: zero(),
    NO_RIDER: zero(),
    SELF_DELIVERY_OVERDUE: zero(),
    RIDER_NOT_PICKED_UP: zero(),
    STUCK_AFTER_PICKUP: zero(),
    OTP_LOCKED: zero(),
    FAILED_DELIVERY: zero(),
    RETURNED_PENDING: zero(),
    DISPUTED: zero(),
    LATE: zero(),
  };
}

export async function listOpsExceptions(options: { category?: OpsExceptionCategory } = {}): Promise<OpsExceptionQueue> {
  const [raw, health] = await Promise.all([
    db.execute<Record<string, unknown>>(CANDIDATES_QUERY),
    loadDispatchHealth(),
  ]);
  const now = Date.now();

  const all: OpsExceptionRow[] = [];
  for (const record of raw) {
    const order = parseCandidate(record);
    if (!order) continue;
    const hit = classify(order, now);
    if (hit) all.push(toRow(order, hit, now));
  }

  const byCategory = emptyCounts();
  let critical = 0;
  for (const row of all) {
    byCategory[row.category].total += 1;
    if (row.severity === "CRITICAL") {
      byCategory[row.category].critical += 1;
      critical += 1;
    }
  }

  const matching = (options.category ? all.filter((r) => r.category === options.category) : all).sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "CRITICAL" ? -1 : 1) ||
      a.enteredAt.getTime() - b.enteredAt.getTime() ||
      a.orderNumber.localeCompare(b.orderNumber),
  );
  const rows = matching.slice(0, OPS_EXCEPTION_ROW_LIMIT);

  const grievancesByOrder = await loadOpenGrievances(
    rows.filter((r) => r.orderStatus === "DISPUTED").map((r) => r.orderId),
  );
  for (const row of rows) row.openGrievance = grievancesByOrder.get(row.orderId) ?? null;

  return {
    generatedAt: new Date(now),
    rows,
    matchingRows: matching.length,
    capped: matching.length > rows.length,
    rowLimit: OPS_EXCEPTION_ROW_LIMIT,
    summary: { total: all.length, critical, byCategory },
    health,
  };
}
