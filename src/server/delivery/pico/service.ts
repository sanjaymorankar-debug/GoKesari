/**
 * Pico Xpress — the "gokesari.com delivery partner" (docs/pico-xpress-2026-11; flag
 * delivery_partner_picoxpress_enabled; rule picoXpress).
 *
 * Booking (shop's choice on a ready order):
 *   checks → serviceability (mandatory) → AWBs from the pool → HDMS booking row + shipment row (order locked,
 *   one live delivery per order) → manifest validated locally → POST create. PX_200 or "already exists" =
 *   booked; a refusal releases the AWBs only when Pico confirms nothing was created; a timeout leaves the
 *   booking "unconfirmed" and a retry sends the SAME order id and AWB (never a duplicate shipment).
 * Tracking (webhook, pull, refresh): every status recorded once (AWB + status + time), never moving
 * backwards; the HDMS booking follows, which moves the order through updateOrderStatus — so COD, the
 * finance snapshot, the shop wallet's delivery charge (at delivery, as for every partner delivery), invoices
 * and the existing order notices apply unchanged. Pico-specific notices (rider details, pickup code,
 * attempts, returns, loss) are sent here.
 * Cancel: only while Pico has the shipment as DRAFT or CREATED; Pico's answer is final; AWBs are retired.
 * Provider calls are never made inside a database transaction.
 */
import { randomUUID } from "node:crypto";

import { and, count, desc, eq, inArray, notInArray } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { stateForPincode } from "@/lib/pincode-state";
import { db } from "@/server/db";
import { deliveryBookings, TERMINAL_BOOKING_STATUSES, type DeliveryBooking } from "@/server/db/hdms-schema";
import { deliveryShipmentEvents, deliveryShipments, deliveryLocationPings, type DeliveryShipment } from "@/server/db/pico-schema";
import { addresses, deliveryOrders, orderItems, orders, shops, users, type Order } from "@/server/db/schema";
import { listAudienceUserIds } from "@/server/events/recipients";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import type { RuleValue } from "@/server/config/rules";

import { applyBookingUpdate } from "../bookings";
import { haversineMeters, parsePoint, ROAD_FACTOR } from "../geo";
import { priceDelivery, pricingRuleFor } from "../pricing";
import { zoneForPoint } from "../zones";
import { allocateAwbs, ensureAwbs, markAwbsCancelled, markAwbsUsed, releaseAwbs, topUpIfLow } from "./awb-pool";
import { cancelPicoAwb, checkServiceability, createPicoOrder, trackPico } from "./client";
import { shipmentCodes, newCodeNonce } from "./codes";
import { picoConfig, picoEnvForSite } from "./config";
import { PicoError, friendlyPicoMessage } from "./errors";
import { maskForLog } from "./mask";
import { buildManifest, goodsTotals, GSTIN_RE, needsEwayBill, tenDigitPhone, validateManifest, type ManifestInput, type ManifestItem, type PickupType } from "./payload";
import {
  bookingStatusFor,
  bookingSteps,
  isKnownPicoState,
  isTerminalPicoState,
  parseTrackingPayload,
  picoCancellable,
  picoRank,
  picoStateLabel,
  shouldAdvance,
  type PicoLocationPing,
  type PicoTracking,
} from "./status";

export interface PicoActor {
  id: string | null;
  role: string | null;
}

export type CancelledBy = "CUSTOMER" | "SHOP" | "ADMIN" | "SYSTEM";

/** Shipment states of ours (not Pico's) while the create call has not been confirmed. */
export const BOOKING_UNCONFIRMED = "BOOKING_UNCONFIRMED";
export const BOOKING_FAILED = "BOOKING_FAILED";

const IST = "Asia/Kolkata";
export function istTime(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }) + " IST";
}

/* ------------------------------------------------------------------ switches */

export async function picoEnabled(): Promise<boolean> {
  return isFeatureEnabled("delivery_partner_picoxpress_enabled", { districtCode: null });
}

/** On, configured for this site: the reason it cannot be offered otherwise. */
export async function picoUnavailableReason(): Promise<string | null> {
  if (!(await picoEnabled())) return "The gokesari.com delivery partner is not switched on.";
  const cfg = picoConfig();
  if (!cfg.ok) return "The gokesari.com delivery partner is not set up on this site yet.";
  return null;
}

/* ------------------------------------------------------------- order context */

interface OrderContext {
  order: Order;
  shop: typeof shops.$inferSelect;
  items: ManifestItem[];
  customerName: string;
  customerPhone: string | null;
  customerState: string | null;
  dropPoint: { lat: number; lng: number } | null;
  shopPoint: { lat: number; lng: number } | null;
  paymentType: "COD" | "PREPAID";
  collectiblePaise: number;
}

async function loadContext(orderId: string): Promise<OrderContext> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw notFound("Order");
  const [shop] = await db.select().from(shops).where(eq(shops.id, order.shopId));
  if (!shop) throw notFound("Shop");
  const lines = await db
    .select({
      name: orderItems.productNameSnapshot,
      hsn: orderItems.hsnCode,
      quantityMilli: orderItems.quantityMilli,
      lineTotalPaise: orderItems.lineTotalPaise,
      taxablePaise: orderItems.taxablePaise,
      taxPaise: orderItems.taxPaise,
      gstRateBp: orderItems.gstRateBp,
      status: orderItems.fulfilmentStatus,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const items: ManifestItem[] = lines
    .filter((l) => l.status !== "REMOVED" && l.quantityMilli > 0)
    .map((l) => ({
      title: l.name,
      hsnCode: l.hsn,
      quantityMilli: l.quantityMilli,
      // Lines from before the tax snapshot have no split: the whole line counts as value, tax 0 (refused below).
      taxablePaise: l.taxablePaise ?? l.lineTotalPaise,
      taxPaise: l.taxPaise ?? 0,
      gstRateBp: l.gstRateBp,
    }));
  const [customer] = await db.select({ name: users.name, phone: users.phoneE164, phoneOld: users.phone }).from(users).where(eq(users.id, order.userId));
  const addr = order.addressId ? (await db.select().from(addresses).where(eq(addresses.id, order.addressId)))[0] : undefined;
  const snap = order.deliveryAddressSnapshot;
  const paymentType: "COD" | "PREPAID" = order.paymentMethod === "COD" && !order.codCollectedAt ? "COD" : "PREPAID";
  return {
    order,
    shop,
    items,
    customerName: addr?.recipientName ?? customer?.name ?? "Customer",
    customerPhone: addr?.recipientPhone ?? customer?.phone ?? customer?.phoneOld ?? null,
    customerState: (addr as { state?: string | null } | undefined)?.state ?? stateForPincode(snap?.pincode),
    dropPoint: parsePoint(snap?.latitude, snap?.longitude),
    shopPoint: parsePoint(shop.latitude, shop.longitude),
    paymentType,
    collectiblePaise: paymentType === "COD" ? Math.max(0, order.totalPaise - (order.refundedPaise ?? 0)) : 0,
  };
}

/** The GSTIN sent as the pickup's: the shop's own, or AGTCI's when the owner chose that for PAN-only shops. */
async function sourceGstin(shop: OrderContext["shop"]): Promise<{ gstin: string | null; viaAgtci: boolean }> {
  if (shop.gstin && GSTIN_RE.test(shop.gstin)) return { gstin: shop.gstin, viaAgtci: false };
  const rules = await getRule("picoXpress");
  if (rules.nonGstShops === "USE_AGTCI_GSTIN") return { gstin: rules.billTo.gstNumber, viaAgtci: true };
  return { gstin: null, viaAgtci: false };
}

async function pickupTypeFor(shopType: string | null): Promise<PickupType> {
  const rules = await getRule("picoXpress");
  return (shopType && rules.pickupTypeByShopType[shopType]) || rules.defaultPickupType;
}

async function weightFor(orderId: string, shopType: string | null): Promise<number> {
  const rules = await getRule("picoXpress");
  const fallback = (shopType && rules.boxWeightGramsByShopType[shopType]) || rules.defaultBoxWeightGrams;
  try {
    const { requirementsForOrder } = await import("../allocation");
    const req = await requirementsForOrder(orderId);
    // requirementsForOrder counts 500 g per unit without a declared weight; keep at least the shop type's default box.
    return Math.max(50, Math.round(Math.max(req.weightGrams, fallback)));
  } catch {
    return fallback;
  }
}

function manifestBase(ctx: OrderContext, gstin: string | null, billTo: RuleValue<"picoXpress">["billTo"]) {
  const snap = ctx.order.deliveryAddressSnapshot;
  const shop = ctx.shop;
  return {
    source: {
      personName: shop.ownerName ?? shop.name,
      unitName: shop.name,
      phone: shop.contactPhone ?? shop.phone,
      gstin,
      addressLine1: shop.addressLine1,
      addressLine2: shop.addressLine2 || shop.area || shop.city,
      city: shop.city,
      state: shop.state ?? stateForPincode(shop.pincode),
      pincode: shop.pincode,
      lat: ctx.shopPoint?.lat ?? null,
      lng: ctx.shopPoint?.lng ?? null,
    },
    destination: {
      personName: ctx.customerName,
      unitName: ctx.customerName,
      phone: ctx.customerPhone,
      gstin: null,
      addressLine1: snap?.line1 ?? null,
      addressLine2: snap?.line2 || snap?.area || snap?.city || null,
      addressLine3: snap?.landmark ?? null,
      city: snap?.city ?? null,
      state: ctx.customerState,
      pincode: snap?.pincode ?? null,
      lat: ctx.dropPoint?.lat ?? null,
      lng: ctx.dropPoint?.lng ?? null,
    },
    billTo: {
      personName: billTo.representativePersonName,
      unitName: billTo.unitName,
      phone: billTo.contactNumPrimary,
      gstin: billTo.gstNumber,
      addressLine1: billTo.addressLine1,
      addressLine2: billTo.addressLine2,
      city: billTo.city,
      state: billTo.state,
      pincode: billTo.pincode,
      lat: null,
      lng: null,
    },
  };
}

/* ------------------------------------------------------------ option check */

export interface PicoOptionView {
  /** False while the flag is off or this site has no Pico keys: the choice is not shown at all. */
  enabled: boolean;
  available: boolean;
  /** Why it is not offered (shown under the greyed-out choice). */
  reason: string | null;
  serviceable: boolean | null;
  paymentType: "COD" | "PREPAID";
  collectiblePaise: number;
  goodsTotalPaise: number;
  needsEwayBill: boolean;
  maxBoxes: number;
  /** A live Pico shipment exists for this order. */
  booked: boolean;
}

const serviceabilityCache = new Map<string, { at: number; serviceable: boolean; message: string | null }>();

/**
 * Whether "gokesari.com delivery partner" can be offered for this order now: flag, set-up, local checks, then
 * Pico's serviceability (cached 2 minutes per order and payment type).
 */
export async function picoOptionForOrder(orderId: string): Promise<PicoOptionView> {
  const rules = await getRule("picoXpress");
  const base = (reason: string, ctx?: OrderContext, serviceable: boolean | null = null): PicoOptionView => {
    const totals = ctx ? goodsTotals(ctx.items) : { totalGoodsAmountPaise: 0 };
    return {
      enabled: true,
      available: false,
      reason,
      serviceable,
      paymentType: ctx?.paymentType ?? "PREPAID",
      collectiblePaise: ctx?.collectiblePaise ?? 0,
      goodsTotalPaise: totals.totalGoodsAmountPaise,
      needsEwayBill: needsEwayBill(totals.totalGoodsAmountPaise, rules.ewayBillThresholdPaise),
      maxBoxes: rules.maxBoxes,
      booked: false,
    };
  };
  const off = await picoUnavailableReason();
  if (off) return { ...base(off), enabled: false };
  const ctx = await loadContext(orderId);
  const live = await livePicoShipment(orderId);
  if (live) return { ...base("Already booked with the gokesari.com delivery partner.", ctx, true), booked: true };
  if (!ctx.shop.deliveryAvailable) return base("Switch on delivery in your shop settings to use the delivery partner.", ctx);
  if (!ctx.order.deliveryAddressSnapshot) return base("This order has no delivery address.", ctx);
  if (ctx.order.addressPendingSince) return base("Waiting for the customer's delivery location.", ctx);
  if (!ctx.shopPoint) return base("Set your shop's map pin (My Shop → Address) to use the delivery partner.", ctx);
  if (!ctx.dropPoint) return base("The customer's address has no map location.", ctx);
  const { gstin } = await sourceGstin(ctx.shop);
  if (!gstin) return base("The delivery partner needs your shop's GSTIN; shops registered with PAN only cannot use it yet.", ctx);
  const totals = goodsTotals(ctx.items);
  if (!(totals.goodsTaxAmountPaise > 0)) {
    return base("The delivery partner accepts only orders with GST on the goods; this order has none (GST-free items).", ctx);
  }
  const key = `${orderId}:${ctx.paymentType}`;
  const cached = serviceabilityCache.get(key);
  let answer = cached && Date.now() - cached.at < 120_000 ? cached : null;
  if (!answer) {
    try {
      const r = await checkServiceability(
        { orderId: ctx.order.orderNumber, deliveryLat: ctx.dropPoint.lat, deliveryLng: ctx.dropPoint.lng, pickupLat: ctx.shopPoint.lat, pickupLng: ctx.shopPoint.lng, paymentType: ctx.paymentType },
        { orderId },
      );
      answer = { at: Date.now(), ...r };
      serviceabilityCache.set(key, answer);
      if (serviceabilityCache.size > 2000) serviceabilityCache.delete(serviceabilityCache.keys().next().value!);
    } catch (error) {
      const kind = error instanceof PicoError ? error.kind : "UNKNOWN";
      if (error instanceof PicoError && error.alertsAdmin) await alertOps("Pico Xpress serviceability check failed", `${error.message}`, orderId);
      return base(kind === "NOT_SERVICEABLE" ? friendlyPicoMessage("NOT_SERVICEABLE") : "The delivery partner could not be checked right now. Choose pickup or your own delivery, or try again in a minute.", ctx, false);
    }
  }
  if (!answer.serviceable) {
    return base("The gokesari.com delivery partner does not serve this pickup and delivery address right now. Choose pickup or your own delivery.", ctx, false);
  }
  return { ...base("", ctx, true), available: true, reason: null };
}

/* ------------------------------------------------------------------ booking */

export async function livePicoShipment(orderId: string): Promise<{ booking: DeliveryBooking; shipment: DeliveryShipment } | null> {
  const [row] = await db
    .select({ booking: deliveryBookings, shipment: deliveryShipments })
    .from(deliveryBookings)
    .innerJoin(deliveryShipments, eq(deliveryShipments.bookingId, deliveryBookings.id))
    .where(and(eq(deliveryBookings.orderId, orderId), eq(deliveryBookings.providerCode, "PICO"), notInArray(deliveryBookings.status, [...TERMINAL_BOOKING_STATUSES])))
    .orderBy(desc(deliveryBookings.createdAt))
    .limit(1);
  return row ?? null;
}

export async function latestPicoShipment(orderId: string): Promise<{ booking: DeliveryBooking; shipment: DeliveryShipment } | null> {
  const [row] = await db
    .select({ booking: deliveryBookings, shipment: deliveryShipments })
    .from(deliveryShipments)
    .innerJoin(deliveryBookings, eq(deliveryBookings.id, deliveryShipments.bookingId))
    .where(eq(deliveryShipments.orderId, orderId))
    .orderBy(desc(deliveryShipments.createdAt))
    .limit(1);
  return row ?? null;
}

export interface BookInput {
  ewayBillNo?: string | null;
  numBoxes?: number | null;
}

export interface BookResultView {
  shipmentId: string;
  awbNumber: string;
  picoOrderId: string;
  status: string;
  alreadyBooked: boolean;
}

/** Books the order with Pico. Throws AppError with a message for the shop owner on any refusal. */
export async function bookPicoShipment(orderId: string, actor: PicoActor, input: BookInput = {}): Promise<BookResultView> {
  const off = await picoUnavailableReason();
  if (off) throw conflict(off);
  const rules = await getRule("picoXpress");
  const env = picoEnvForSite();

  // A live shipment: return it, or re-send an unconfirmed create with the same order id and AWB.
  const existing = await livePicoShipment(orderId);
  if (existing) {
    if (existing.shipment.status !== BOOKING_UNCONFIRMED) {
      return { shipmentId: existing.shipment.id, awbNumber: existing.shipment.awbNumber, picoOrderId: existing.shipment.picoOrderId, status: existing.shipment.status, alreadyBooked: true };
    }
    return sendManifest(orderId, existing.booking, existing.shipment, actor);
  }

  const ctx = await loadContext(orderId);
  if (ctx.order.status !== "READY") throw conflict("Mark the order packed and ready before booking the delivery partner.");
  if (!ctx.shop.deliveryAvailable) throw conflict("Switch on delivery in your shop settings to use the delivery partner.");
  if (ctx.order.addressPendingSince) throw conflict("Waiting for the customer's delivery location — book once it is set.");
  const numBoxes = Math.max(1, Math.min(rules.maxBoxes, Math.floor(input.numBoxes ?? 1)));
  const ewayBillNo = input.ewayBillNo?.replace(/\s+/g, "") || null;
  const { gstin } = await sourceGstin(ctx.shop);
  if (!gstin) throw conflict("The delivery partner needs your shop's GSTIN; shops registered with PAN only cannot use it yet. Choose pickup or your own delivery.");

  // Local validation first, with placeholder AWBs, so nothing is allocated for an order Pico would refuse.
  const deadWeightGrams = await weightFor(orderId, ctx.shop.shopType);
  const pickupType = await pickupTypeFor(ctx.shop.shopType);
  const draft: ManifestInput = {
    picoOrderId: ctx.order.orderNumber,
    awbNumber: "000000000000",
    childAwbs: Array.from({ length: numBoxes - 1 }, (_, i) => `00000000000${i}`),
    pickupType,
    pickupOtp: "000000",
    consigneeOtp: "000000",
    ...manifestBase(ctx, gstin, rules.billTo),
    numBoxes,
    deadWeightGrams,
    items: ctx.items,
    invoiceIds: [ctx.order.orderNumber],
    ewayBillNo,
    ewayBillThresholdPaise: rules.ewayBillThresholdPaise,
    collectiblePaise: ctx.collectiblePaise,
    notes: ctx.order.deliveryAddressSnapshot?.deliveryInstructions ?? null,
  };
  const problems = validateManifest(draft);
  if (problems.length) {
    throw validationFailed(`Cannot book the delivery partner: ${problems.map((p) => p.message).join("; ")}.`, {
      fields: Object.fromEntries(problems.map((p) => [p.field, p.message])),
    });
  }

  // Serviceability is mandatory right before manifestation.
  let svc: { serviceable: boolean; message: string | null };
  try {
    svc = await checkServiceability(
      { orderId: ctx.order.orderNumber, deliveryLat: ctx.dropPoint!.lat, deliveryLng: ctx.dropPoint!.lng, pickupLat: ctx.shopPoint!.lat, pickupLng: ctx.shopPoint!.lng, paymentType: ctx.paymentType },
      { orderId },
    );
  } catch (error) {
    if (error instanceof PicoError) {
      if (error.alertsAdmin) await alertOps("Pico Xpress refused the serviceability check", error.message, orderId);
      throw conflict(friendlyPicoMessage(error.kind, error.picoMessage));
    }
    throw error;
  }
  if (!svc.serviceable) throw conflict(friendlyPicoMessage("NOT_SERVICEABLE"));

  // The invoice: issued now (goods leave the shop — CGST s.31), or the order number while invoicing is off.
  let invoiceId = ctx.order.orderNumber;
  try {
    const { issueInvoiceForOrder } = await import("@/server/services/invoices");
    const invoice = await issueInvoiceForOrder(orderId);
    if (invoice?.invoiceNumber) invoiceId = invoice.invoiceNumber;
  } catch (error) {
    console.error("[pico] invoice not issued before booking; using the order number", orderId, error instanceof Error ? error.message : error);
  }

  try {
    await ensureAwbs(env, numBoxes);
  } catch (error) {
    await alertOps("Pico Xpress AWB pool is empty", error instanceof Error ? error.message : "AWB refill failed", orderId);
    throw conflict(friendlyPicoMessage("AWB_NOT_FOUND"));
  }

  // Booking + shipment rows and AWBs, under the order's row lock.
  const zone = ctx.shopPoint ? await zoneForPoint(ctx.shopPoint) : null;
  const distanceM = ctx.shopPoint && ctx.dropPoint ? Math.round(haversineMeters(ctx.shopPoint, ctx.dropPoint) * ROAD_FACTOR) : null;
  const rule = await pricingRuleFor(zone?.id ?? null);
  const pricing = rule && distanceM != null
    ? priceDelivery(rule, { distanceM, weightGrams: deadWeightGrams, basketPaise: ctx.order.subtotalPaise, express: ctx.order.deliveryWindow === "EXPRESS_30", at: new Date() })
    : null;

  const created = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).for("update");
    if (!locked || locked.status !== "READY") throw conflict("The order is no longer ready for pickup.");
    const [riderJob] = await tx
      .select({ id: deliveryOrders.id })
      .from(deliveryOrders)
      .where(and(eq(deliveryOrders.orderId, orderId), inArray(deliveryOrders.status, ["OFFERED", "ACCEPTED", "PICKED_UP"])));
    if (riderJob) throw conflict("A GoKesari rider has been offered this order. Change the delivery plan first.");
    const [live] = await tx
      .select({ id: deliveryBookings.id })
      .from(deliveryBookings)
      .where(and(eq(deliveryBookings.orderId, orderId), notInArray(deliveryBookings.status, [...TERMINAL_BOOKING_STATUSES])));
    if (live) throw conflict("This order already has a live delivery booking.");
    const [{ n: bookingsSoFar }] = await tx.select({ n: count() }).from(deliveryBookings).where(eq(deliveryBookings.orderId, orderId));
    const [{ n: shipmentsSoFar }] = await tx.select({ n: count() }).from(deliveryShipments).where(eq(deliveryShipments.orderId, orderId));
    const shipmentId = randomUUID();
    const [booking] = await tx
      .insert(deliveryBookings)
      .values({
        orderId,
        shopId: ctx.order.shopId,
        channel: "EXTERNAL",
        providerCode: "PICO",
        zoneId: zone?.id ?? null,
        status: "CREATED",
        idempotencyKey: `gk:${orderId}:PICO:${bookingsSoFar + 1}`,
        distanceM,
        pricing,
        createdBy: actor.id,
      })
      .returning();
    const awbs = await allocateAwbs(tx, env, numBoxes, orderId, shipmentId);
    // Pico needs a unique order id per shipment: GK123, then GK123-2, GK123-3 after a cancel and re-booking.
    const picoOrderId = shipmentsSoFar === 0 ? ctx.order.orderNumber : `${ctx.order.orderNumber}-${shipmentsSoFar + 1}`;
    const [shipment] = await tx
      .insert(deliveryShipments)
      .values({
        id: shipmentId,
        bookingId: booking.id,
        orderId,
        shopId: ctx.order.shopId,
        env,
        picoOrderId,
        awbNumber: awbs[0],
        childAwbs: awbs.slice(1),
        paymentType: ctx.paymentType,
        collectiblePaise: ctx.collectiblePaise,
        goodsTotalPaise: goodsTotals(ctx.items).totalGoodsAmountPaise,
        numBoxes,
        deadWeightGrams,
        pickupType,
        ewayBillNo,
        codeNonce: newCodeNonce(),
        status: BOOKING_UNCONFIRMED,
        createdBy: actor.id,
      })
      .returning();
    await tx.update(deliveryBookings).set({ externalRef: awbs[0] }).where(eq(deliveryBookings.id, booking.id));
    return { booking: { ...booking, externalRef: awbs[0] }, shipment, invoiceId };
  });
  topUpIfLow(env);
  return sendManifest(orderId, created.booking, created.shipment, actor, created.invoiceId);
}

/** Builds and sends the manifest for a shipment row (first try, or a retry of an unconfirmed one). */
async function sendManifest(orderId: string, booking: DeliveryBooking, shipment: DeliveryShipment, actor: PicoActor, invoiceId?: string): Promise<BookResultView> {
  const rules = await getRule("picoXpress");
  const ctx = await loadContext(orderId);
  const { gstin } = await sourceGstin(ctx.shop);
  const codes = shipmentCodes(shipment.codeNonce);
  let invoice = invoiceId;
  if (!invoice) {
    const { invoicesForOrders } = await import("@/server/services/invoices");
    invoice = (await invoicesForOrders([orderId])).get(orderId) ?? ctx.order.orderNumber;
  }
  const input: ManifestInput = {
    picoOrderId: shipment.picoOrderId,
    awbNumber: shipment.awbNumber,
    childAwbs: shipment.childAwbs,
    pickupType: shipment.pickupType as PickupType,
    pickupOtp: codes.pickupOtp,
    consigneeOtp: codes.consigneeOtp,
    returnOtp: codes.returnOtp,
    ...manifestBase(ctx, gstin, rules.billTo),
    numBoxes: shipment.numBoxes,
    deadWeightGrams: shipment.deadWeightGrams,
    items: ctx.items,
    invoiceIds: [invoice],
    ewayBillNo: shipment.ewayBillNo,
    ewayBillThresholdPaise: rules.ewayBillThresholdPaise,
    collectiblePaise: shipment.collectiblePaise,
    notes: ctx.order.deliveryAddressSnapshot?.deliveryInstructions ?? null,
  };
  const awbs = [shipment.awbNumber, ...shipment.childAwbs];
  const problems = validateManifest(input);
  if (problems.length) {
    await failBooking(booking, shipment, awbs, "release", problems.map((p) => p.message).join("; "));
    throw validationFailed(`Cannot book the delivery partner: ${problems.map((p) => p.message).join("; ")}.`);
  }

  try {
    await createPicoOrder(buildManifest(input), { orderId, shipmentId: shipment.id });
  } catch (error) {
    if (error instanceof PicoError && error.kind === "ALREADY_EXISTS") {
      // A retry after a timeout: Pico has it already — that is a success.
    } else if (error instanceof PicoError && error.orderNotCreated) {
      // Pico confirmed nothing was created: free the AWBs (or retire them when Pico rejected the numbers).
      const awbProblem = error.kind === "AWB_NOT_ALLOTTED" || error.kind === "AWB_NOT_FOUND";
      await failBooking(booking, shipment, awbs, awbProblem ? "retire" : "release", `${error.pxCode ?? error.kind}: ${error.picoMessage}`);
      if (error.alertsAdmin) await alertOps("Pico Xpress refused a booking", `${error.message} (order ${ctx.order.orderNumber})`, orderId);
      throw conflict(friendlyPicoMessage(error.kind, error.picoMessage));
    } else {
      // Unknown outcome (timeout, 5xx, PX_501): keep the AWBs and the booking; a retry re-sends the same ids.
      await db.update(deliveryShipments).set({ status: BOOKING_UNCONFIRMED, lastReason: error instanceof Error ? error.message.slice(0, 300) : null, updatedAt: new Date() }).where(eq(deliveryShipments.id, shipment.id));
      await alertOps("Pico Xpress booking not confirmed", `Order ${ctx.order.orderNumber}, AWB ${shipment.awbNumber}: ${error instanceof Error ? error.message : "no answer"}. Use Refresh or Retry on Admin → Delivery → Pico Xpress.`, orderId);
      throw conflict("The delivery partner did not confirm the booking in time. Press \"Book again\" in a minute — it will not create a second booking.");
    }
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await markAwbsUsed(awbs, tx);
    await tx.update(deliveryShipments).set({ status: "CREATED", lastEventAt: now, lastReason: null, updatedAt: now }).where(eq(deliveryShipments.id, shipment.id));
    await tx.insert(deliveryShipmentEvents).values({ shipmentId: shipment.id, awbNumber: shipment.awbNumber, status: "CREATED", eventTs: now, source: "SYSTEM" }).onConflictDoNothing();
  });
  await applyBookingUpdate(booking.id, { status: "CREATED", source: "SHOP", note: `Booked with Pico Xpress (AWB ${shipment.awbNumber}, ${shipment.picoOrderId}).` }).catch(() => undefined);
  await announceBooked(ctx, shipment, codes.consigneeOtp);
  void actor;
  return { shipmentId: shipment.id, awbNumber: shipment.awbNumber, picoOrderId: shipment.picoOrderId, status: "CREATED", alreadyBooked: false };
}

async function failBooking(booking: DeliveryBooking, shipment: DeliveryShipment, awbs: string[], awbAction: "release" | "retire", reason: string) {
  const now = new Date();
  if (awbAction === "release") await releaseAwbs(awbs);
  else await markAwbsCancelled(awbs);
  await db.update(deliveryShipments).set({ status: BOOKING_FAILED, lastReason: reason.slice(0, 300), updatedAt: now }).where(eq(deliveryShipments.id, shipment.id));
  // The order stays READY (nothing was picked up); the shop chooses another option.
  await applyBookingUpdate(booking.id, { status: "FAILED", source: "SYSTEM", note: `Pico booking refused: ${reason}`.slice(0, 300), failureReason: reason.slice(0, 300) }).catch(() => undefined);
}

/* ------------------------------------------------------------------- cancel */

/**
 * Cancels the order's live Pico shipment. Only while Pico has it as DRAFT or CREATED (checked here first);
 * Pico's answer is final. On success the booking and shipment are CANCELLED and the AWBs retired.
 */
export async function cancelPicoShipment(orderId: string, by: CancelledBy, reason: string, actor: PicoActor): Promise<{ cancelled: true; awbNumber: string }> {
  const live = await livePicoShipment(orderId);
  if (!live) throw conflict("This order has no live booking with the delivery partner.");
  return cancelShipmentRow(live.booking, live.shipment, by, reason, actor);
}

/**
 * options.booking: "sync" (default) moves the booking and so the order (back to READY when it was ASSIGNED);
 * "skip" leaves the booking row to a caller that closes it itself (the HDMS cancelBooking path).
 */
export async function cancelShipmentRow(booking: DeliveryBooking, shipment: DeliveryShipment, by: CancelledBy, reason: string, actor: PicoActor, options: { booking?: "sync" | "skip" } = {}): Promise<{ cancelled: true; awbNumber: string }> {
  const why = reason.trim().slice(0, 200) || "Cancelled";
  if (shipment.status !== BOOKING_UNCONFIRMED && !picoCancellable(shipment.status)) {
    if (picoRank(shipment.status) >= picoRank("PICKED")) throw conflict("Order already picked up — cannot cancel; raise a return or a dispute.");
    throw conflict("A rider is already on the way for this shipment, so the delivery partner can no longer cancel it. Contact support if it must be stopped.");
  }
  try {
    await cancelPicoAwb(shipment.awbNumber, why, { orderId: shipment.orderId, shipmentId: shipment.id });
  } catch (error) {
    if (error instanceof PicoError) {
      // Pico's answer is final. A shipment Pico never created (unconfirmed booking, "not found") is ours to close.
      if (!(error.kind === "AWB_NOT_FOUND" && shipment.status === BOOKING_UNCONFIRMED)) {
        await refreshPicoShipment(shipment.orderId).catch(() => undefined);
        throw conflict(friendlyPicoMessage(error.kind === "INVALID_INPUT" ? "NOT_CANCELLABLE" : error.kind, error.picoMessage));
      }
    } else throw error;
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await markAwbsCancelled([shipment.awbNumber, ...shipment.childAwbs], tx);
    await tx
      .update(deliveryShipments)
      .set({ status: "CANCELLED", cancelReason: why, cancelledBy: by, partnerPhone: null, lastEventAt: now, updatedAt: now })
      .where(eq(deliveryShipments.id, shipment.id));
    await tx.insert(deliveryShipmentEvents).values({ shipmentId: shipment.id, awbNumber: shipment.awbNumber, status: "CANCELLED", eventTs: now, reason: why, source: "SYSTEM" }).onConflictDoNothing();
  });
  const source = by === "CUSTOMER" ? "CUSTOMER" : by === "SHOP" ? "SHOP" : by === "ADMIN" ? "ADMIN" : "SYSTEM";
  if (options.booking !== "skip") {
    await applyBookingUpdate(booking.id, { status: "CANCELLED", source, note: why, cancelledBy: by });
  }
  await announceCancelled(shipment, why, by);
  void actor;
  return { cancelled: true, awbNumber: shipment.awbNumber };
}

/* --------------------------------------------------------------- tracking */

export interface TrackingResult {
  awbNumber: string;
  result: "APPLIED" | "DUPLICATE" | "UNKNOWN_SHIPMENT" | "IGNORED";
  status: string;
  newEvents: number;
}

/** Pull (doc page 5): the admin / operator "Refresh status" button and the missed-webhook safety net. */
export async function refreshPicoShipment(orderId: string): Promise<TrackingResult | null> {
  const latest = await latestPicoShipment(orderId);
  if (!latest) throw notFound("Delivery partner shipment");
  const raw = await trackPico([latest.shipment.awbNumber], { orderId, shipmentId: latest.shipment.id });
  const parsed = parseTrackingPayload(raw).find((t) => t.awbNumber === latest.shipment.awbNumber);
  if (!parsed) return null;
  return processTracking(parsed, "PULL", maskForLog(raw));
}

/**
 * Applies one tracking payload (webhook or pull): records each status once, moves the shipment forward only,
 * replays the history so missed events are filled in, moves the HDMS booking (and so the order) and sends the
 * Pico-specific notices. Idempotent and out-of-order safe.
 */
export async function processTracking(t: PicoTracking, source: "WEBHOOK" | "PULL", maskedPayload: unknown): Promise<TrackingResult> {
  const [shipment] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.awbNumber, t.awbNumber));
  if (!shipment) {
    await db.insert(deliveryShipmentEvents).values({ awbNumber: t.awbNumber, status: t.status, eventTs: t.history.at(-1)?.at ?? t.createdAt ?? new Date(0), source, rawPayload: maskedPayload as object }).onConflictDoNothing();
    if (!isKnownPicoState(t.status)) console.warn("[pico] unknown status from Pico", t.status);
    return { awbNumber: t.awbNumber, result: "UNKNOWN_SHIPMENT", status: t.status, newEvents: 0 };
  }

  // Every status once: the history, plus the current state when it is not in the history.
  const events = [...t.history];
  if (!events.some((e) => e.status === t.status)) {
    const at = (t.status === "DELIVERED" ? t.ata : null) ?? t.history.at(-1)?.at ?? t.createdAt ?? new Date(0);
    events.push({ status: t.status, at, lat: null, lng: null, reason: null });
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime() || picoRank(a.status) - picoRank(b.status));
  let newEvents = 0;
  const fresh: typeof events = [];
  for (const e of events) {
    if (!isKnownPicoState(e.status)) console.warn("[pico] unknown status from Pico (logged)", e.status, t.awbNumber);
    const [inserted] = await db
      .insert(deliveryShipmentEvents)
      .values({
        shipmentId: shipment.id,
        awbNumber: t.awbNumber,
        status: e.status,
        eventTs: e.at,
        lat: e.lat != null ? e.lat.toFixed(6) : null,
        lng: e.lng != null ? e.lng.toFixed(6) : null,
        reason: e.reason,
        source,
        rawPayload: newEvents === 0 ? (maskedPayload as object) : null,
      })
      .onConflictDoNothing()
      .returning({ id: deliveryShipmentEvents.id });
    if (inserted) {
      newEvents++;
      fresh.push(e);
    }
  }

  // Forward-only: walk the whole history from the stored status.
  let status = shipment.status === BOOKING_UNCONFIRMED ? "CREATED" : shipment.status;
  let lastAt = shipment.lastEventAt;
  const reached: string[] = [];
  for (const e of events) {
    if (shouldAdvance(status, e.status, e.at, lastAt)) {
      status = e.status;
      lastAt = e.at;
      reached.push(e.status);
    }
  }
  const withPlace = [...events].reverse().find((e) => e.lat != null && e.lng != null);
  const lastReason = [...events].reverse().find((e) => e.reason)?.reason ?? null;
  const terminal = isTerminalPicoState(status);
  const now = new Date();
  await db
    .update(deliveryShipments)
    .set({
      status,
      ...(t.partnerName ? { partnerName: t.partnerName } : {}),
      // The rider's number is kept only while the delivery is live (DPDP: no longer than needed).
      ...(terminal ? { partnerPhone: null } : t.partnerPhone ? { partnerPhone: t.partnerPhone } : {}),
      ...(t.trackingUrl ? { trackingUrl: t.trackingUrl } : {}),
      ...(t.pickupEtaMin != null ? { pickupEtaMin: t.pickupEtaMin } : {}),
      ...(t.deliveryEtaMin != null ? { deliveryEtaMin: t.deliveryEtaMin } : {}),
      ...(t.eta ? { eta: t.eta } : {}),
      ...(t.ata ? { ata: t.ata } : {}),
      ...(t.etd ? { etd: t.etd } : {}),
      ...(t.atd ? { atd: t.atd } : {}),
      ...(withPlace && (!shipment.lastLocationAt || withPlace.at >= shipment.lastLocationAt)
        ? { lastLat: withPlace.lat!.toFixed(6), lastLng: withPlace.lng!.toFixed(6), lastLocationAt: withPlace.at }
        : {}),
      ...(lastAt ? { lastEventAt: lastAt } : {}),
      ...(lastReason ? { lastReason: lastReason.slice(0, 300) } : {}),
      updatedAt: now,
    })
    .where(eq(deliveryShipments.id, shipment.id));
  if (status === "CANCELLED" || status === "LOST" || status === "DAMAGED") {
    if (status === "CANCELLED") await markAwbsCancelled([shipment.awbNumber, ...shipment.childAwbs]);
  }

  // The booking (and through it the order) follows Pico's state.
  const target = bookingStatusFor(status);
  const [booking] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.id, shipment.bookingId));
  if (booking && target && !TERMINAL_BOOKING_STATUSES.includes(booking.status)) {
    const etaMinutes = t.deliveryEtaMin ?? t.pickupEtaMin ?? null;
    let current = booking.status;
    for (const step of bookingSteps(current, target)) {
      const applied = await applyBookingUpdate(booking.id, {
        status: step,
        source: source === "WEBHOOK" ? "WEBHOOK" : "POLL",
        note: `Pico Xpress: ${picoStateLabel(status)}${lastReason ? ` — ${lastReason}` : ""}`.slice(0, 300),
        occurredAt: lastAt ?? now,
        riderName: t.partnerName,
        riderPhone: terminal ? null : t.partnerPhone,
        riderLocation: withPlace ? { lat: withPlace.lat!, lng: withPlace.lng! } : null,
        etaMinutes,
        failureReason: step === "FAILED" ? (lastReason ?? picoStateLabel(status)) : null,
        cancelledBy: step === "CANCELLED" ? "PROVIDER" : undefined,
      }).catch((error) => {
        console.error("[pico] booking update failed", booking.id, step, error instanceof Error ? error.message : error);
        return null;
      });
      if (applied?.changed) current = applied.booking.status;
    }
  }

  const [after] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.id, shipment.id));
  for (const s of reached) await announceStatus(after ?? shipment, s, t).catch((error) => console.error("[pico] notice failed", s, error));
  // ATTEMPTED_UNDELIVERED may repeat (re-attempts): a new attempt event is news even without a status move.
  if (!reached.includes("ATTEMPTED_UNDELIVERED") && fresh.some((e) => e.status === "ATTEMPTED_UNDELIVERED")) {
    await announceStatus(after ?? shipment, "ATTEMPTED_UNDELIVERED", t).catch(() => undefined);
  }
  return { awbNumber: t.awbNumber, result: newEvents > 0 || reached.length > 0 ? "APPLIED" : "DUPLICATE", status, newEvents };
}

/** Live location (doc page 7; paid add-on, flag pico_live_location_enabled). */
export async function processLocationPing(p: PicoLocationPing): Promise<"STORED" | "UNKNOWN_SHIPMENT" | "IGNORED"> {
  const [shipment] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.awbNumber, p.awbNumber));
  if (!shipment) return "UNKNOWN_SHIPMENT";
  if (isTerminalPicoState(shipment.status)) return "IGNORED";
  const now = new Date();
  await db.insert(deliveryLocationPings).values({ awbNumber: p.awbNumber, lat: p.lat.toFixed(6), lng: p.lng.toFixed(6), pickupEtaMin: p.pickupEtaMin, deliveryEtaMin: p.deliveryEtaMin, receivedAt: now });
  await db
    .update(deliveryShipments)
    .set({
      lastLat: p.lat.toFixed(6),
      lastLng: p.lng.toFixed(6),
      lastLocationAt: now,
      ...(p.pickupEtaMin != null ? { pickupEtaMin: p.pickupEtaMin } : {}),
      ...(p.deliveryEtaMin != null ? { deliveryEtaMin: p.deliveryEtaMin } : {}),
      ...(p.partnerName ? { partnerName: p.partnerName } : {}),
      ...(p.partnerPhone ? { partnerPhone: p.partnerPhone } : {}),
      updatedAt: now,
    })
    .where(eq(deliveryShipments.id, shipment.id));
  // The customer's map reads the booking's rider position (tracking.ts).
  await db
    .update(deliveryBookings)
    .set({
      riderLat: p.lat.toFixed(6),
      riderLng: p.lng.toFixed(6),
      riderLocationAt: now,
      ...(p.deliveryEtaMin != null || p.pickupEtaMin != null ? { etaAt: new Date(now.getTime() + (p.deliveryEtaMin ?? p.pickupEtaMin ?? 0) * 60_000) } : {}),
      updatedAt: now,
    })
    .where(eq(deliveryBookings.id, shipment.bookingId));
  return "STORED";
}

/** Safety net for missed webhooks (every-minute sweep, flag on): pulls live shipments silent for 5+ minutes. */
export async function sweepSilentShipments(limit = 20): Promise<{ skipped: true } | { pulled: number; changed: number; errors: number }> {
  if (!(await picoEnabled()) || !picoConfig().ok) return { skipped: true };
  const rows = await db
    .select({ orderId: deliveryShipments.orderId, updatedAt: deliveryShipments.updatedAt, status: deliveryShipments.status })
    .from(deliveryShipments)
    .where(notInArray(deliveryShipments.status, ["DELIVERED", "RTO_DELIVERED", "LOST", "DAMAGED", "CANCELLED", BOOKING_FAILED]))
    .orderBy(deliveryShipments.updatedAt)
    .limit(limit * 3);
  const due = rows.filter((r) => Date.now() - r.updatedAt.getTime() > 5 * 60_000).slice(0, limit);
  let changed = 0;
  let errors = 0;
  for (const r of due) {
    try {
      // Touch first so a failing shipment does not block the others.
      await db.update(deliveryShipments).set({ updatedAt: new Date() }).where(eq(deliveryShipments.orderId, r.orderId));
      const res = await refreshPicoShipment(r.orderId);
      if (res?.result === "APPLIED") changed++;
    } catch (error) {
      errors++;
      console.error("[pico] sweep pull failed", r.orderId, error instanceof Error ? error.message : error);
    }
  }
  return { pulled: due.length, changed, errors };
}

/* --------------------------------------------------------------- notices */

async function orderPeople(orderId: string) {
  const [row] = await db
    .select({ orderNumber: orders.orderNumber, buyerId: orders.userId, shopOwnerId: shops.ownerId, shopName: shops.name, shopId: shops.id })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId));
  return row ?? null;
}

export async function alertOps(title: string, body: string, orderId: string | null): Promise<void> {
  try {
    const ids = await listAudienceUserIds("SUPPORT");
    for (const userId of ids.slice(0, 50)) {
      await notify({ userId, type: NOTIFICATION_TYPES.SUPPORT_RIDER_UNASSIGNED, title, body: body.slice(0, 500), actionUrl: "/admin/delivery/pico", dedupeKey: `pico-alert:${title}:${orderId ?? "-"}:${userId}:${new Date().toISOString().slice(0, 13)}` });
    }
  } catch (error) {
    console.error("[pico] could not alert operations", error instanceof Error ? error.message : error);
  }
}

async function announceBooked(ctx: OrderContext, shipment: DeliveryShipment, consigneeOtp: string) {
  const people = await orderPeople(ctx.order.id);
  if (!people) return;
  const pickupOtp = shipmentCodes(shipment.codeNonce).pickupOtp;
  await notify({
    userId: people.shopOwnerId,
    type: NOTIFICATION_TYPES.ORDER_ASSIGNED,
    title: "Delivery partner booked",
    body: `Order ${people.orderNumber} is booked with the gokesari.com delivery partner (AWB ${shipment.awbNumber}). Give the parcel to the rider only after they tell you pickup code ${pickupOtp}.`,
    actionUrl: "/shop/orders",
    dedupeKey: `pico:${shipment.id}:booked:shop`,
  });
  await notify({
    userId: people.buyerId,
    type: NOTIFICATION_TYPES.ORDER_ASSIGNED,
    title: "Your order is booked for delivery",
    body: `${people.shopName} booked a gokesari.com delivery partner for order ${people.orderNumber}. Your delivery code is on My Orders — give it to the rider only when you receive the parcel.`,
    actionUrl: "/orders",
    dedupeKey: `pico:${shipment.id}:booked:buyer`,
  });
  // The code itself goes by e-mail only (never in a stored notice), as for GoKesari riders.
  const { sendDeliveryCodeToBuyer } = await import("@/server/services/delivery-otp");
  await sendDeliveryCodeToBuyer(ctx.order.id, consigneeOtp);
}

async function announceCancelled(shipment: DeliveryShipment, reason: string, by: CancelledBy | "PICO") {
  const people = await orderPeople(shipment.orderId);
  if (!people) return;
  const text = `The delivery partner booking for order ${people.orderNumber} was cancelled${by === "PICO" ? " by the delivery partner" : ""}: ${reason}.`;
  if (by !== "SHOP") {
    await notify({ userId: people.shopOwnerId, type: NOTIFICATION_TYPES.DELIVERY_UNASSIGNED, title: "Delivery partner cancelled", body: `${text} Choose another delivery option for the order.`, actionUrl: "/shop/orders", dedupeKey: `pico:${shipment.id}:cancelled:shop` });
  }
  if (by !== "CUSTOMER") {
    await notify({ userId: people.buyerId, type: NOTIFICATION_TYPES.DELIVERY_UNASSIGNED, title: "Delivery booking changed", body: `${text} The shop will arrange the delivery.`, actionUrl: "/orders", dedupeKey: `pico:${shipment.id}:cancelled:buyer` });
  }
}

async function announceStatus(shipment: DeliveryShipment, status: string, t: PicoTracking) {
  const people = await orderPeople(shipment.orderId);
  if (!people) return;
  const key = (who: string) => `pico:${shipment.id}:${status}:${who}${status === "ATTEMPTED_UNDELIVERED" ? `:${t.history.filter((h) => h.status === status).length}` : ""}`;
  const rider = shipment.partnerName ? `${shipment.partnerName}${shipment.partnerPhone ? ` (${tenDigitPhone(shipment.partnerPhone) ?? shipment.partnerPhone})` : ""}` : "A rider";
  const eta = shipment.eta ? istTime(shipment.eta) : shipment.deliveryEtaMin != null ? `about ${shipment.deliveryEtaMin} min` : null;
  const track = shipment.trackingUrl ? ` Track: ${shipment.trackingUrl}` : "";
  switch (status) {
    case "DP_ASSIGNED":
      await notify({ userId: people.shopOwnerId, type: NOTIFICATION_TYPES.ORDER_ASSIGNED, title: "Rider assigned", body: `${rider} will collect order ${people.orderNumber}${shipment.pickupEtaMin != null ? ` in about ${shipment.pickupEtaMin} min` : ""}.`, actionUrl: "/shop/orders", dedupeKey: key("shop") });
      await notify({ userId: people.buyerId, type: NOTIFICATION_TYPES.ORDER_ASSIGNED, title: "Rider assigned", body: `${rider} is picking up your order ${people.orderNumber} from ${people.shopName}.`, actionUrl: "/orders", dedupeKey: key("buyer") });
      return;
    case "ARRIVED_AT_PICKUP": {
      const pickup = shipmentCodes(shipment.codeNonce).pickupOtp;
      await notify({ userId: people.shopOwnerId, type: NOTIFICATION_TYPES.DELIVERY_RIDER_AT_SHOP, title: "Rider at your shop", body: `${rider} has arrived for order ${people.orderNumber}. Hand over the parcel after the rider tells you pickup code ${pickup}.`, actionUrl: "/shop/orders", dedupeKey: key("shop") });
      return;
    }
    case "OUT_FOR_DELIVERY":
    case "ARRIVED_AT_LOCATION":
      await notify({
        userId: people.buyerId,
        type: NOTIFICATION_TYPES.ORDER_RIDER_ARRIVING,
        title: status === "ARRIVED_AT_LOCATION" ? "Your rider has arrived" : "Out for delivery",
        body: `Order ${people.orderNumber}: ${status === "ARRIVED_AT_LOCATION" ? `${rider} is at your address` : `${rider} is on the way${eta ? `, expected ${eta}` : ""}`}. Keep your delivery code ready.${track}`,
        actionUrl: "/orders",
        dedupeKey: key("buyer"),
      });
      return;
    case "ATTEMPTED_UNDELIVERED": {
      const why = shipment.lastReason ? ` Reason: ${shipment.lastReason}.` : "";
      await notify({ userId: people.buyerId, type: NOTIFICATION_TYPES.ORDER_DELIVERY_FAILED, title: "Delivery attempted", body: `The rider could not deliver order ${people.orderNumber}.${why} The delivery partner will try again or return it to the shop.`, actionUrl: "/orders", dedupeKey: key("buyer") });
      await notify({ userId: people.shopOwnerId, type: NOTIFICATION_TYPES.ORDER_DELIVERY_FAILED, title: "Delivery attempted", body: `Order ${people.orderNumber} could not be delivered.${why}`, actionUrl: "/shop/orders", dedupeKey: key("shop") });
      return;
    }
    case "RTO":
    case "RTO_DELIVERED":
      await notify({
        userId: people.shopOwnerId,
        type: NOTIFICATION_TYPES.ORDER_RETURNED_TO_SHOP,
        title: status === "RTO" ? "Parcel returning to your shop" : "Parcel returned to your shop",
        body: `Order ${people.orderNumber} ${status === "RTO" ? "is being returned to your shop" : "was returned to your shop"} by the delivery partner${shipment.lastReason ? ` (${shipment.lastReason})` : ""}. The customer's refund follows the return policy.`,
        actionUrl: "/shop/orders",
        dedupeKey: key("shop"),
      });
      return;
    case "LOST":
    case "DAMAGED": {
      const label = status === "LOST" ? "lost" : "damaged";
      const { systemTicketHook } = await import("@/server/aftercare/system-ticket-hook");
      const ticket = await systemTicketHook("DELIVERY_PARTNER_INCIDENT", `${shipment.awbNumber}:${status}`, {
        subject: `Delivery partner reports order ${people.orderNumber} ${label}`,
        description: `Pico Xpress reported AWB ${shipment.awbNumber} (${shipment.picoOrderId}) as ${status}${shipment.lastReason ? `: ${shipment.lastReason}` : ""}. Goods value ${formatPaise(shipment.goodsTotalPaise)}. Raise the claim with Pico, settle the customer's refund and the shop's goods value.`,
        shopId: people.shopId,
        orderId: shipment.orderId,
        priority: "HIGH",
      });
      if (ticket) await db.update(deliveryShipments).set({ disputeId: ticket.id }).where(eq(deliveryShipments.id, shipment.id));
      await notify({ userId: people.shopOwnerId, type: NOTIFICATION_TYPES.ORDER_DELIVERY_FAILED, title: `Parcel ${label} in transit`, body: `The delivery partner reported order ${people.orderNumber} as ${label}. A support ticket${ticket ? ` (${ticket.ticketNumber})` : ""} is open; our team will settle it with you.`, actionUrl: "/shop/orders", dedupeKey: key("shop") });
      await notify({ userId: people.buyerId, type: NOTIFICATION_TYPES.ORDER_DELIVERY_FAILED, title: "Problem with your delivery", body: `Your order ${people.orderNumber} was ${label} in transit. Our support team has opened a case and will arrange your refund or a replacement.`, actionUrl: "/orders", dedupeKey: key("buyer") });
      await alertOps(`Pico shipment ${label}`, `Order ${people.orderNumber}, AWB ${shipment.awbNumber}.`, shipment.orderId);
      return;
    }
    case "CANCELLED":
      if (shipment.cancelledBy) return; // we cancelled it: already announced
      await db.update(deliveryShipments).set({ cancelledBy: "PICO", cancelReason: shipment.lastReason ?? "Cancelled by the delivery partner" }).where(eq(deliveryShipments.id, shipment.id));
      await announceCancelled(shipment, shipment.lastReason ?? "no reason given", "PICO");
      return;
    default:
      return;
  }
}
