/**
 * Delivery Allocation Engine (docs/hdms-2026-11). Behind flag hdms_enabled; rule deliveryAllocation.
 *
 * For a READY order that needs delivery:
 *  1. shop and customer coordinates → distance (straight line × road factor) and zone;
 *  2. product delivery requirements (weight, refrigeration, fragile, max delivery minutes, perishable);
 *  3. channels in rule order: SHOP_RIDER (an available rider of the shop's own — the shop is told to send
 *     them), GOKESARI_RIDER (the existing rider dispatch), EXTERNAL (every enabled partner quoted in parallel);
 *  4. partner quotes filtered (serviceable, capability, distance, reliability, max delivery time) and ranked
 *     by fee + ETA + reliability weights — never by price alone;
 *  5. the best partner booked with an idempotency key; a failed booking tries the next one.
 * Duplicate bookings are impossible: the order row is locked while the booking row is created, a partial
 * unique index allows one live booking per order, and an order with a live GoKesari rider job is refused.
 * Scheduled orders (milk/newspaper subscriptions, chosen time slots) are left to their own scheduled flow.
 */
import { and, eq, inArray, notInArray } from "drizzle-orm";

import { deployedSiteKind } from "@/lib/env";
import { db } from "@/server/db";
import {
  deliveryAllocationRuns,
  deliveryBookings,
  deliveryProviders,
  deliveryQuotes,
  productDeliveryAttributes,
  TERMINAL_BOOKING_STATUSES,
  type DeliveryBooking,
  type DeliveryChannel,
  type DeliveryProvider,
  type DeliveryZone,
} from "@/server/db/hdms-schema";
import {
  addresses,
  deliveryOrders,
  orderItems,
  orders,
  productSubcategories,
  products,
  shopDeliveryStaff,
  shopProducts,
  shops,
  subscriptionDeliveries,
  subscriptionOrders,
  users,
} from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

import { applyBookingUpdate } from "./bookings";
import { haversineMeters, parsePoint, ROAD_FACTOR } from "./geo";
import { priceDelivery, pricingRuleFor } from "./pricing";
import { callProvider, circuitAllows } from "./providers/registry";
import { ProviderError, type BookRequest, type DeliveryParty, type QuoteResult } from "./providers/types";
import { zoneForPoint, zoneIsOpen } from "./zones";

export type AllocationTrigger = "NO_INTERNAL_RIDER" | "MANUAL_ADMIN" | "MANUAL_SHOP" | "REALLOCATE";

export interface DeliveryRequirements {
  weightGrams: number;
  refrigeration: boolean;
  fragile: boolean;
  perishable: boolean;
  maxDeliveryMinutes: number | null;
  itemCount: number;
}

export interface Candidate {
  channel: DeliveryChannel;
  providerCode: string | null;
  serviceable: boolean;
  feePaise: number | null;
  etaMinutes: number | null;
  reliabilityX100: number | null;
  reason: string | null;
  score: number | null;
}

export interface AllocationResult {
  outcome: "BOOKED" | "INTERNAL" | "NO_CANDIDATE" | "SKIPPED" | "ERROR";
  channel: DeliveryChannel | null;
  providerCode: string | null;
  booking: DeliveryBooking | null;
  detail: string;
  candidates: Candidate[];
}

/** Ranks serviceable candidates by weighted fee / ETA / reliability (higher is better). Pure. */
export function rankCandidates(
  candidates: Candidate[],
  weights: { fee: number; eta: number; reliability: number },
): Candidate[] {
  const ok = candidates.filter((c) => c.serviceable && c.feePaise != null && c.etaMinutes != null);
  if (ok.length === 0) return [];
  const minFee = Math.max(1, Math.min(...ok.map((c) => c.feePaise!)));
  const minEta = Math.max(1, Math.min(...ok.map((c) => c.etaMinutes!)));
  const total = weights.fee + weights.eta + weights.reliability || 1;
  return ok
    .map((c) => {
      const feeN = minFee / Math.max(1, c.feePaise!);
      const etaN = minEta / Math.max(1, c.etaMinutes!);
      const relN = (c.reliabilityX100 ?? 0) / 10000;
      const score = (weights.fee * feeN + weights.eta * etaN + weights.reliability * relN) / total;
      return { ...c, score: Math.round(score * 10000) / 10000 };
    })
    .sort((a, b) => b.score! - a.score! || a.feePaise! - b.feePaise!);
}

/** Why a partner quote cannot be used for this order, or null. Pure. */
export function partnerRejection(
  provider: Pick<DeliveryProvider, "capabilities" | "reliabilityX100">,
  quote: QuoteResult,
  req: DeliveryRequirements,
  distanceM: number,
  minReliabilityPercent: number,
): string | null {
  if (!quote.serviceable) return quote.reason ?? "Not serviceable.";
  const caps = provider.capabilities ?? {};
  if (req.refrigeration && !caps.refrigerated) return "Needs refrigerated delivery.";
  if (caps.maxWeightKg != null && req.weightGrams > caps.maxWeightKg * 1000) return `Heavier than ${caps.maxWeightKg} kg.`;
  if (caps.maxDistanceKm != null && distanceM > caps.maxDistanceKm * 1000) return `Farther than ${caps.maxDistanceKm} km.`;
  if (provider.reliabilityX100 < minReliabilityPercent * 100) return "Reliability below the minimum.";
  if (req.maxDeliveryMinutes != null && quote.etaMinutes != null && quote.etaMinutes > req.maxDeliveryMinutes) {
    return `ETA ${quote.etaMinutes} min is over the ${req.maxDeliveryMinutes} min the items allow.`;
  }
  return null;
}

export async function requirementsForOrder(orderId: string): Promise<DeliveryRequirements> {
  const rows = await db
    .select({
      quantityMilli: orderItems.quantityMilli,
      attrs: productDeliveryAttributes,
      perishableSub: productSubcategories.isPerishable,
    })
    .from(orderItems)
    .innerJoin(shopProducts, eq(shopProducts.id, orderItems.shopProductId))
    .leftJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(productSubcategories, eq(productSubcategories.id, products.subcategoryId))
    .leftJoin(productDeliveryAttributes, eq(productDeliveryAttributes.productId, shopProducts.productId))
    .where(eq(orderItems.orderId, orderId));
  const req: DeliveryRequirements = { weightGrams: 0, refrigeration: false, fragile: false, perishable: false, maxDeliveryMinutes: null, itemCount: rows.length };
  for (const r of rows) {
    const qty = Math.max(1, Math.ceil(r.quantityMilli / 1000));
    // Unknown weight counts 500 g per unit — enough to keep heavy baskets off two-wheeler limits only when declared.
    req.weightGrams += (r.attrs?.weightGrams ?? 500) * qty;
    if (r.attrs?.refrigerationRequired) req.refrigeration = true;
    if (r.attrs?.fragile) req.fragile = true;
    if (r.attrs?.perishable || r.attrs?.temperatureSensitive || r.perishableSub) req.perishable = true;
    if (r.attrs?.maxDeliveryMinutes != null) {
      req.maxDeliveryMinutes = req.maxDeliveryMinutes == null ? r.attrs.maxDeliveryMinutes : Math.min(req.maxDeliveryMinutes, r.attrs.maxDeliveryMinutes);
    }
  }
  return req;
}

/** Subscription (milk, newspaper) and chosen-slot orders follow the scheduled-delivery workflow, never instant allocation. */
export async function isScheduledOrder(order: { id: string; deliveryWindow: string | null }): Promise<boolean> {
  if (order.deliveryWindow === "SCHEDULED") return true;
  const [sub] = await db.select({ id: subscriptionOrders.id }).from(subscriptionOrders).where(eq(subscriptionOrders.orderId, order.id)).limit(1);
  if (sub) return true;
  const [del] = await db.select({ id: subscriptionDeliveries.id }).from(subscriptionDeliveries).where(eq(subscriptionDeliveries.orderId, order.id)).limit(1);
  return Boolean(del);
}

/** Promised minutes for a distance from the rule's ETA bands (upper end). */
export function etaBandMinutes(distanceM: number, bands: { upToKm: number; minMinutes: number; maxMinutes: number }[]): { min: number; max: number } | null {
  const km = distanceM / 1000;
  const band = [...bands].sort((a, b) => a.upToKm - b.upToKm).find((b) => km <= b.upToKm);
  return band ? { min: band.minMinutes, max: band.maxMinutes } : null;
}

async function recordRun(
  orderId: string,
  trigger: AllocationTrigger,
  result: AllocationResult,
  distanceM: number | null,
  requirements: Partial<DeliveryRequirements>,
): Promise<void> {
  try {
    const [run] = await db
      .insert(deliveryAllocationRuns)
      .values({
        orderId,
        trigger,
        outcome: result.outcome,
        chosenChannel: result.channel,
        chosenProvider: result.providerCode,
        bookingId: result.booking?.id ?? null,
        distanceM,
        requirements: requirements as Record<string, unknown>,
        detail: result.detail.slice(0, 500),
      })
      .returning({ id: deliveryAllocationRuns.id });
    if (run && result.candidates.length) {
      await db.insert(deliveryQuotes).values(
        result.candidates.map((c) => ({
          runId: run.id,
          channel: c.channel,
          providerCode: c.providerCode,
          serviceable: c.serviceable,
          feePaise: c.feePaise,
          etaMinutes: c.etaMinutes,
          reliabilityX100: c.reliabilityX100,
          score: c.score != null ? c.score.toFixed(4) : null,
          rejectedReason: c.reason?.slice(0, 300) ?? null,
        })),
      );
    }
  } catch (error) {
    console.error("[allocation] could not record run", orderId, error);
  }
}

interface AllocateOptions {
  actorId?: string | null;
  /** Partners not to try again (a failed or cancelled earlier booking). */
  excludeProviders?: string[];
  /** Only partners (the GoKesari rider search already failed). */
  externalOnly?: boolean;
}

/** Runs one allocation for an order. Never throws for business outcomes; returns what happened. */
export async function allocateOrder(orderId: string, trigger: AllocationTrigger, options: AllocateOptions = {}): Promise<AllocationResult> {
  const none = (outcome: AllocationResult["outcome"], detail: string, candidates: Candidate[] = []): AllocationResult => ({
    outcome,
    channel: null,
    providerCode: null,
    booking: null,
    detail,
    candidates,
  });
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return none("SKIPPED", "Order not found.");
  const districtCode = null;
  if (!(await isFeatureEnabled("hdms_enabled", { districtCode }))) return none("SKIPPED", "Delivery management (hdms_enabled) is off.");
  if (order.status !== "READY") {
    const r = none("SKIPPED", `Order is ${order.status}, not ready for pickup.`);
    await recordRun(orderId, trigger, r, null, {});
    return r;
  }
  if (await isScheduledOrder(order)) {
    const r = none("SKIPPED", "Scheduled / subscription delivery: handled by the scheduled-delivery workflow.");
    await recordRun(orderId, trigger, r, null, {});
    return r;
  }
  const [shop] = await db.select().from(shops).where(eq(shops.id, order.shopId));
  if (!shop || !shop.deliveryAvailable) return none("SKIPPED", "Shop does not deliver.");
  const shopPoint = parsePoint(shop.latitude, shop.longitude);
  const snap = order.deliveryAddressSnapshot;
  const dropPoint = parsePoint(snap?.latitude, snap?.longitude);
  if (!shopPoint || !dropPoint) {
    const r = none("NO_CANDIDATE", "Shop or delivery address has no verified location.");
    await recordRun(orderId, trigger, r, null, {});
    return r;
  }
  const distanceM = Math.round(haversineMeters(shopPoint, dropPoint) * ROAD_FACTOR);
  const req = await requirementsForOrder(orderId);
  const rules = await getRule("deliveryAllocation");
  const candidates: Candidate[] = [];
  const zone = await zoneForPoint(shopPoint);

  for (const channel of rules.channelOrder) {
    if (channel === "SHOP_RIDER" && !options.externalOnly) {
      const staff = await db
        .select({ id: shopDeliveryStaff.id, name: shopDeliveryStaff.name })
        .from(shopDeliveryStaff)
        .where(and(eq(shopDeliveryStaff.shopId, shop.id), eq(shopDeliveryStaff.isActive, true), eq(shopDeliveryStaff.isAvailable, true)));
      const usable = staff.length > 0 && shop.deliveryChoice === "OWN_STAFF";
      candidates.push({ channel, providerCode: null, serviceable: usable, feePaise: null, etaMinutes: null, reliabilityX100: null, score: null, reason: usable ? null : staff.length ? "Shop uses GoKesari riders." : "No available shop rider." });
      if (usable) {
        const r: AllocationResult = { outcome: "INTERNAL", channel, providerCode: null, booking: null, detail: `Shop rider available (${staff[0].name}); the shop sends its own rider.`, candidates };
        await recordRun(orderId, trigger, r, distanceM, req);
        return r;
      }
    }
    if (channel === "GOKESARI_RIDER" && !options.externalOnly) {
      const { dispatchReadyOrder } = await import("@/server/services/delivery-assignment");
      const offer = await dispatchReadyOrder(orderId, { id: options.actorId ?? null, role: null }, trigger === "MANUAL_SHOP" ? "SHOP_MANUAL" : "SWEEP").catch(() => null);
      candidates.push({ channel, providerCode: null, serviceable: Boolean(offer), feePaise: null, etaMinutes: null, reliabilityX100: null, score: null, reason: offer ? null : "No GoKesari rider free nearby." });
      if (offer) {
        const r: AllocationResult = { outcome: "INTERNAL", channel, providerCode: null, booking: null, detail: "Offered to the nearest GoKesari rider.", candidates };
        await recordRun(orderId, trigger, r, distanceM, req);
        return r;
      }
    }
    if (channel === "EXTERNAL") {
      const result = await allocateExternal(order, shop, shopPoint, dropPoint, distanceM, req, zone, options, candidates);
      await recordRun(orderId, trigger, result, distanceM, req);
      return result;
    }
  }
  const r = none("NO_CANDIDATE", "No delivery option is available.", candidates);
  await recordRun(orderId, trigger, r, distanceM, req);
  return r;
}

type OrderRow = typeof orders.$inferSelect;
type ShopRow = typeof shops.$inferSelect;

async function allocateExternal(
  order: OrderRow,
  shop: ShopRow,
  shopPoint: { lat: number; lng: number },
  dropPoint: { lat: number; lng: number },
  distanceM: number,
  req: DeliveryRequirements,
  zone: DeliveryZone | null,
  options: AllocateOptions,
  candidates: Candidate[],
): Promise<AllocationResult> {
  const rules = await getRule("deliveryAllocation");
  const fail = (detail: string): AllocationResult => ({ outcome: "NO_CANDIDATE", channel: "EXTERNAL", providerCode: null, booking: null, detail, candidates });
  if (!zone) return fail("The shop is outside every delivery zone.");
  if (!zoneIsOpen(zone)) return fail(`Zone ${zone.name} is suspended${zone.suspendedReason ? `: ${zone.suspendedReason}` : ""}.`);
  if (distanceM > Number(zone.maxDeliveryKm) * 1000) return fail(`Delivery is ${(distanceM / 1000).toFixed(1)} km; zone ${zone.name} allows ${Number(zone.maxDeliveryKm)} km.`);

  const isProduction = deployedSiteKind() === "production";
  const providers = (await db.select().from(deliveryProviders).where(eq(deliveryProviders.enabled, true))).filter(
    (p) =>
      !(options.excludeProviders ?? []).includes(p.code) &&
      p.capabilities?.integrated !== false &&
      // The sandbox simulator never runs on the live site; live bookings never run outside it.
      !(isProduction && (p.capabilities?.sandboxOnly || p.environment === "SANDBOX")) &&
      !(!isProduction && p.environment === "PRODUCTION"),
  );
  if (providers.length === 0) return fail("No delivery partner is enabled for this environment.");

  const [customer] = await db.select({ name: users.name, phone: users.phone }).from(users).where(eq(users.id, order.userId));
  const addr = order.addressId ? (await db.select().from(addresses).where(eq(addresses.id, order.addressId)))[0] : undefined;
  const snap = order.deliveryAddressSnapshot!;
  const pickup: DeliveryParty = {
    name: shop.name,
    phone: shop.phone,
    address: [shop.addressLine1, shop.addressLine2, shop.city].filter(Boolean).join(", "),
    pincode: shop.pincode,
    point: shopPoint,
  };
  const drop: DeliveryParty = {
    name: addr?.recipientName ?? customer?.name ?? "Customer",
    phone: addr?.recipientPhone ?? customer?.phone ?? "",
    address: [snap.line1, snap.line2, snap.area, snap.landmark, snap.city].filter(Boolean).join(", "),
    pincode: snap.pincode ?? null,
    point: dropPoint,
  };
  const quoteReq = {
    pickup,
    drop,
    distanceM,
    shipment: {
      orderNumber: order.orderNumber,
      orderValuePaise: order.totalPaise,
      weightGrams: req.weightGrams,
      codPaise: order.paymentMethod === "COD" ? order.totalPaise : 0,
      requiresRefrigeration: req.refrigeration,
      fragile: req.fragile,
      itemCount: req.itemCount,
    },
  };

  // Quote every enabled partner in parallel within the quote budget.
  const quoted = await Promise.all(
    providers.map(async (p) => {
      if (!circuitAllows(p, rules.circuitCooldownSeconds)) {
        return { p, quote: { serviceable: false, reason: "Paused after repeated failures (circuit open)." } as QuoteResult };
      }
      try {
        const quote = await callProvider(p, { operation: "quote", retries: 0, timeoutMs: Math.min(p.timeoutMs, rules.quoteTimeoutMs) }, (a, ctx) => a.quote(ctx, quoteReq));
        return { p, quote };
      } catch (error) {
        const msg = error instanceof ProviderError ? `${error.code}: ${error.message}` : "Quote failed.";
        return { p, quote: { serviceable: false, reason: msg } as QuoteResult };
      }
    }),
  );
  const partnerCandidates: Candidate[] = quoted.map(({ p, quote }) => {
    const reason = partnerRejection(p, quote, req, distanceM, rules.minReliabilityPercent);
    return {
      channel: "EXTERNAL",
      providerCode: p.code,
      serviceable: reason == null,
      feePaise: quote.feePaise ?? null,
      etaMinutes: quote.etaMinutes ?? null,
      reliabilityX100: p.reliabilityX100,
      reason,
      score: null,
    };
  });
  const ranked = rankCandidates(partnerCandidates, { fee: rules.weightFee, eta: rules.weightEta, reliability: rules.weightReliability });
  for (const c of partnerCandidates) {
    const r = ranked.find((x) => x.providerCode === c.providerCode);
    candidates.push(r ?? c);
  }
  if (ranked.length === 0) return fail("No delivery partner can take this order right now.");

  // Customer/shop/GoKesari split of the delivery cost, from the pricing rule (kept on the booking).
  const rule = await pricingRuleFor(zone.id);
  const tried: string[] = [];
  for (const choice of ranked) {
    const provider = providers.find((p) => p.code === choice.providerCode)!;
    const pricing = rule
      ? priceDelivery(rule, { distanceM, weightGrams: req.weightGrams, basketPaise: order.subtotalPaise, express: order.deliveryWindow === "EXPRESS_30", at: new Date() })
      : null;
    const booking = await createBookingRow(order, provider, zone, distanceM, choice, pricing, options.actorId ?? null);
    if (!booking) {
      return { outcome: "SKIPPED", channel: "EXTERNAL", providerCode: null, booking: null, detail: "The order already has a live delivery (duplicate prevented).", candidates };
    }
    try {
      const bookReq: BookRequest = { ...quoteReq, idempotencyKey: booking.idempotencyKey };
      const res = await callProvider(provider, { operation: "book", bookingId: booking.id, retries: 2 }, (a, ctx) => a.book(ctx, bookReq));
      await db
        .update(deliveryBookings)
        .set({ externalRef: res.externalRef, trackingUrl: res.trackingUrl ?? null, quotedFeePaise: res.feePaise ?? choice.feePaise, updatedAt: new Date() })
        .where(eq(deliveryBookings.id, booking.id));
      const applied = await applyBookingUpdate(booking.id, {
        status: res.status === "CREATED" ? "SEARCHING" : res.status,
        source: "SYSTEM",
        note: `Booked with ${provider.name} (score ${choice.score}).`,
        etaMinutes: res.etaMinutes ?? choice.etaMinutes,
      });
      return {
        outcome: "BOOKED",
        channel: "EXTERNAL",
        providerCode: provider.code,
        booking: applied.booking,
        detail: `Booked with ${provider.name}${tried.length ? ` after ${tried.join(", ")} failed` : ""}.`,
        candidates,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Booking failed.";
      tried.push(provider.name);
      await applyBookingUpdate(booking.id, { status: "FAILED", source: "SYSTEM", note: `Booking failed: ${msg}`, failureReason: msg }).catch(() => undefined);
    }
  }
  return { outcome: "ERROR", channel: "EXTERNAL", providerCode: null, booking: null, detail: `Every partner refused the booking (${tried.join(", ")}).`, candidates };
}

/** Creates the booking row under the order's row lock; null when a live delivery already exists. */
async function createBookingRow(
  order: OrderRow,
  provider: DeliveryProvider,
  zone: DeliveryZone,
  distanceM: number,
  choice: Candidate,
  pricing: ReturnType<typeof priceDelivery> | null,
  actorId: string | null,
): Promise<DeliveryBooking | null> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id)).for("update");
    if (!locked || locked.status !== "READY") return null;
    const [riderJob] = await tx
      .select({ id: deliveryOrders.id })
      .from(deliveryOrders)
      .where(and(eq(deliveryOrders.orderId, order.id), inArray(deliveryOrders.status, ["OFFERED", "ACCEPTED", "PICKED_UP"])));
    if (riderJob) return null;
    const [live] = await tx
      .select({ id: deliveryBookings.id })
      .from(deliveryBookings)
      .where(and(eq(deliveryBookings.orderId, order.id), notInArray(deliveryBookings.status, [...TERMINAL_BOOKING_STATUSES])));
    if (live) return null;
    const n = (await tx.select({ id: deliveryBookings.id }).from(deliveryBookings).where(eq(deliveryBookings.orderId, order.id))).length + 1;
    const [row] = await tx
      .insert(deliveryBookings)
      .values({
        orderId: order.id,
        shopId: order.shopId,
        channel: "EXTERNAL",
        providerCode: provider.code,
        zoneId: zone.id,
        status: "CREATED",
        idempotencyKey: `gk:${order.id}:${provider.code}:${n}`,
        distanceM,
        quotedFeePaise: choice.feePaise,
        // The rule's split of the delivery fee (customer / shop / GoKesari); what the partner charges GoKesari is quoted_fee_paise.
        pricing,
        createdBy: actorId,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  });
}

/**
 * After a partner booking ended before pickup (failed / cancelled by the partner), tries the next partner.
 * The same partner is not retried for this order.
 */
export async function reallocateAfterBookingEnded(booking: DeliveryBooking): Promise<AllocationResult | null> {
  if (booking.cancelledBy === "CUSTOMER" || booking.cancelledBy === "SHOP" || booking.cancelledBy === "ADMIN") return null;
  const previous = await db
    .select({ code: deliveryBookings.providerCode })
    .from(deliveryBookings)
    .where(and(eq(deliveryBookings.orderId, booking.orderId), inArray(deliveryBookings.status, ["FAILED", "CANCELLED"])));
  return allocateOrder(booking.orderId, "REALLOCATE", {
    externalOnly: true,
    excludeProviders: previous.map((p) => p.code).filter((c): c is NonNullable<typeof c> => Boolean(c)),
  });
}

/**
 * Hook from the GoKesari rider search (delivery-assignment.ts): no rider took the order after
 * `externalAfterRiderAttempts` attempts → book a delivery partner. Never throws.
 */
export async function maybeBookPartnerAfterRiderSearch(orderId: string, riderAttempts: number): Promise<AllocationResult | null> {
  try {
    if (!(await isFeatureEnabled("hdms_enabled", { districtCode: null }))) return null;
    const rules = await getRule("deliveryAllocation");
    if (!rules.channelOrder.includes("EXTERNAL")) return null;
    if (riderAttempts < rules.externalAfterRiderAttempts) return null;
    return await allocateOrder(orderId, "NO_INTERNAL_RIDER", { externalOnly: true });
  } catch (error) {
    console.error("[allocation] partner fallback failed for order", orderId, error);
    return null;
  }
}
