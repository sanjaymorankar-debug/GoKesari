/**
 * Journeys that many cases share — a cart, a checkout, the shop packing an
 * order, a rider delivering it — through the site's own APIs, as the people
 * involved would. They work on the local server and on the test site alike:
 * the pickup code is read off the shop's packing slip and the delivery code
 * is the one the customer's order page asks for, so no database is needed.
 *
 * Every helper that writes calls assertWritable(); none runs on production.
 */
import { expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { as, me } from "./actors";
import { db } from "./db";
import { call, expectStatus, poll, RUN, why, type Answer } from "./http";
import { blocked, need } from "./record";
import { assertWritable, IS_LOCAL } from "./target";
import { world, type Role, type WorldListing } from "./world";

/* ------------------------------------------------------------ discovery */

export interface Listing extends WorldListing {
  shopId: string;
  shopName: string;
}

interface StorefrontRow {
  shopProductId: string;
  productId: string;
  productName: string;
  onlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  isAvailable: boolean;
  trackInventory: boolean;
  onlineStock: number;
  mrpPaise?: number | null;
}

/** The shop of the world by key (A by default), with its id resolved through the public API on the sites. */
export async function shopOf(key: "A" | "B" | "C" = "A") {
  const shop = need(world().shops[key], `shop ${key} in this site's test data`);
  if (shop.id) return { id: shop.id, name: shop.name, slug: shop.slug ?? "" };
  const res = await call(await as("customer"), "GET", `/api/shops?q=${encodeURIComponent(shop.name)}&limit=24`);
  expectStatus(res, 200, "shop search");
  const list = (Array.isArray(res.body) ? res.body : (res.body?.shops ?? [])) as { id: string; name: string; slug: string }[];
  const found = list.find((s) => s.name.toLowerCase() === shop.name.toLowerCase()) ?? list.find((s) => s.name.toLowerCase().includes(shop.name.toLowerCase()));
  if (!found) blocked(`shop "${shop.name}" is not listed (approved) on this site`);
  shop.id = found.id;
  shop.slug = found.slug;
  return { id: found.id, name: found.name, slug: found.slug };
}

/**
 * An in-stock, online-priced listing of a shop: the cheapest by default, or
 * the priciest (a basket that outgrows a wallet in few units). Locally the
 * world's packaged listing (cheapest) or its premium one (priciest).
 */
export async function sellable(key: "A" | "B" = "A", minStock = 3, pick: "cheapest" | "priciest" = "cheapest"): Promise<Listing> {
  const shop = await shopOf(key);
  const preset = key === "A" ? (pick === "priciest" ? world().listings.premium : world().listings.packaged) : world().listings.sharedB;
  if (preset && IS_LOCAL) return { ...preset, shopId: shop.id, shopName: shop.name };
  // Operations see stock counts; a customer sees only whether a product is in stock (TC-SPI-027).
  const res = await call(await as("ops"), "GET", `/api/shops/${shop.id}/products?limit=100`);
  expectStatus(res, 200, "the shop's storefront");
  const rows = (Array.isArray(res.body) ? res.body : (res.body?.products ?? [])) as StorefrontRow[];
  const sorted = rows
    .filter((p) => p.onlineSaleEnabled && p.isAvailable && (p.onlinePricePaise ?? 0) > 0 && (!p.trackInventory || p.onlineStock >= minStock))
    .sort((a, b) => (a.onlinePricePaise ?? 0) - (b.onlinePricePaise ?? 0));
  const row = pick === "priciest" ? sorted.at(-1) : sorted[0];
  if (!row) blocked(`no product of "${shop.name}" is on sale online with ${minStock}+ in stock`);
  return {
    shopProductId: row.shopProductId,
    productId: row.productId,
    name: row.productName,
    pricePaise: row.onlinePricePaise,
    mrpPaise: row.mrpPaise ?? null,
    stock: row.trackInventory ? row.onlineStock : undefined,
    shopId: shop.id,
    shopName: shop.name,
  };
}

/** The customer's default address id (its own on the sites, the seeded one locally). */
export async function defaultAddress(role: Role = "customer"): Promise<{ id: string; pincode: string | null } | null> {
  const res = await call(await as(role), "GET", "/api/addresses");
  expectStatus(res, 200, "GET /api/addresses");
  const list = (res.body?.addresses ?? res.body ?? []) as { id: string; isDefault: boolean; pincode: string | null }[];
  const address = list.find((a) => a.isDefault) ?? list[0];
  return address ? { id: address.id, pincode: address.pincode } : null;
}

/* ------------------------------------------------------------- the cart */

export async function emptyCart(role: Role = "customer") {
  assertWritable("empty a cart");
  const res = await call(await as(role), "DELETE", "/api/cart");
  expectStatus(res, [200, 204], "empty the cart");
}

export async function addToCart(role: Role, shopProductId: string, quantity = 1): Promise<Answer> {
  assertWritable("add to a cart");
  return call(await as(role), "POST", "/api/cart", { shopProductId, quantity });
}

export async function cartLines(role: Role = "customer") {
  const res = await call(await as(role), "GET", "/api/cart");
  expectStatus(res, 200, "GET /api/cart");
  return ((res.body?.groups ?? []) as { shopId: string; lines: { cartItemId: string; shopProductId: string; quantity: number; unitPricePaise?: number }[] }[]).flatMap((g) =>
    g.lines.map((l) => ({ ...l, id: l.cartItemId, shopId: g.shopId })),
  );
}

/* ------------------------------------------------------------- checkout */

export interface PlacedOrder {
  id: string;
  orderNumber: string;
  totalPaise: number;
  status: string;
  requestId: string;
  body: Answer["body"];
  listing: Listing;
}

/**
 * Empties the cart, adds `quantity` of a sellable listing and checks out.
 * Refusals the site is entitled to make (no stock, closed) block the case.
 */
export async function placeOrder(
  options: { role?: Role; method?: "WALLET" | "ONLINE" | "COD"; quantity?: number; listing?: Listing; extra?: Record<string, unknown> } = {},
): Promise<PlacedOrder> {
  assertWritable("place an order");
  const role = options.role ?? "customer";
  const listing = options.listing ?? (await sellable("A"));
  await emptyCart(role);
  const added = await addToCart(role, listing.shopProductId, options.quantity ?? 1);
  if (added.status === 409 || added.status === 422) blocked(`"${listing.name}" cannot be added to the cart — ${why(added)}`);
  expectStatus(added, [200, 201], "add to cart");
  const address = await defaultAddress(role);
  const requestId = `qa-${RUN}-${randomUUID().slice(0, 8)}`;
  const res = await call(await as(role), "POST", "/api/checkout", {
    requestId,
    addressId: address?.id ?? null,
    paymentMethod: options.method ?? "WALLET",
    acknowledgeClosedShopIds: [listing.shopId],
    ...options.extra,
  });
  if (res.status === 409 || res.status === 422) blocked(`checkout (${options.method ?? "WALLET"}) refused — ${why(res)}`);
  expectStatus(res, 201, "checkout");
  const order = res.body.orders?.[0];
  expect(order?.id, "an order was created").toBeTruthy();
  return { id: order.id, orderNumber: order.orderNumber, totalPaise: order.totalPaise, status: order.status, requestId, body: res.body, listing };
}

export async function orderAs(role: Role, id: string) {
  const res = await call(await as(role), "GET", "/api/orders");
  expectStatus(res, 200, "GET /api/orders");
  const list = (Array.isArray(res.body) ? res.body : (res.body?.orders ?? [])) as { id: string; status: string; paidAt: string | null; orderNumber: string; totalPaise: number }[];
  return list.find((o) => o.id === id) ?? null;
}

export async function walletBalance(role: Role = "customer"): Promise<number> {
  const res = await call(await as(role), "GET", "/api/wallet");
  expectStatus(res, 200, "GET /api/wallet");
  const value = res.body?.balancePaise ?? res.body?.wallet?.balancePaise;
  expect(typeof value, `wallet balance in ${JSON.stringify(res.body).slice(0, 200)}`).toBe("number");
  return value as number;
}

/* ----------------------------------------------------------- fulfilment */

export async function fulfil(orderId: string, action: "accept" | "start" | "ready" | "reject", extra: Record<string, unknown> = {}, role: Role = "shop") {
  assertWritable("act on an order");
  const res = await call(await as(role), "POST", `/api/orders/${orderId}/fulfilment`, { action, ...extra });
  // With rule fulfilmentOptions on (as on the test site) READY needs a delivery plan first:
  // choose a GoKesari delivery partner for the earliest slot, in the same step the shop page uses.
  if (action === "ready" && res.status === 409 && res.body?.error?.details?.needsFulfilmentChoice) return readyWithPartner(orderId, role);
  return res;
}

/** Marks a PREPARING order ready with plan "GoKesari delivery partner, earliest slot" (POST fulfilment-plan, markReady). */
export async function readyWithPartner(orderId: string, role: Role = "shop") {
  const ctx = await as(role);
  const options = await call(ctx, "GET", `/api/orders/${orderId}/fulfilment-plan`);
  expectStatus(options, 200, "delivery plan options");
  const slotKey = (options.body?.days as { slots: { key: string }[] }[] | undefined)?.[0]?.slots[0]?.key;
  if (!slotKey) throw new Error(`no delivery slot can be chosen now for order ${orderId} (${JSON.stringify(options.body).slice(0, 200)})`);
  return call(ctx, "POST", `/api/orders/${orderId}/fulfilment-plan`, { option: "GOKESARI_PARTNER", slotKey, markReady: true });
}

/** accept → start → ready, each expected to succeed. */
export async function packOrder(orderId: string, role: Role = "shop") {
  for (const action of ["accept", "start", "ready"] as const) {
    const res = await fulfil(orderId, action, {}, role);
    expectStatus(res, 200, `shop ${action}`);
  }
}

/* -------------------------------------------------------------- delivery */

export interface Offer {
  deliveryOrderId: string;
  status: string;
}

/** The rider's current offer/assignment for an order (waits for dispatch up to `waitMs`). */
export async function offerFor(orderId: string, rider: Role = "rider", waitMs = 45_000): Promise<Offer> {
  const ctx = await as(rider);
  const found = await poll(
    async () => {
      const res = await call(ctx, "GET", "/api/delivery-partner/deliveries");
      if (res.status !== 200) return null;
      const active = res.body?.active as { id: string; orderId: string; status: string } | null;
      return active && active.orderId === orderId ? { deliveryOrderId: active.id, status: active.status } : null;
    },
    (v) => v !== null,
    waitMs,
  );
  if (!found) blocked(`no delivery offer reached the ${rider} for order ${orderId} within ${waitMs / 1000} s (rider offline or busy?)`);
  return found;
}

export async function riderAction(deliveryOrderId: string, action: string, extra: Record<string, unknown> = {}, rider: Role = "rider") {
  assertWritable("act on a delivery");
  return call(await as(rider), "PATCH", `/api/delivery-orders/${deliveryOrderId}`, { action, ...extra });
}

/** The 4-digit pickup code, as the shop reads it off the packing slip. */
export async function pickupCode(orderId: string, shop: Role = "shop"): Promise<string | null> {
  const res = await call(await as(shop), "GET", `/shop/orders/${orderId}/packing-slip`, undefined, { maxRedirects: 3 });
  expectStatus(res, 200, "packing slip");
  return res.text.match(/Pickup code:\s*(?:<!-- -->)?\s*<span[^>]*>(\d{4,8})<\/span>/)?.[1] ?? null;
}

/** A fresh delivery code, as the customer's order page asks for one (returned once). */
export async function deliveryCode(orderId: string, customer: Role = "customer"): Promise<string> {
  assertWritable("request a delivery code");
  let res = await call(await as(customer), "POST", `/api/orders/${orderId}/delivery-code`, {});
  // A code was already sent when the delivery started; a new one waits out the resend cooldown.
  for (let i = 0; i < 2 && res.status === 429; i++) {
    const seconds = Number(res.body?.error?.message?.match(/(\d+)\s*seconds?/)?.[1] ?? 60);
    await new Promise((r) => setTimeout(r, Math.min(seconds, 120) * 1000 + 1500));
    res = await call(await as(customer), "POST", `/api/orders/${orderId}/delivery-code`, {});
  }
  expectStatus(res, 200, "new delivery code");
  const code = res.body?.code ?? res.body?.otp ?? res.body?.deliveryCode;
  if (!code) blocked(`the delivery-code answer carries no code (${JSON.stringify(res.body).slice(0, 120)})`);
  return String(code);
}

/**
 * The whole delivery leg: the rider accepts the offer, picks up with the
 * shop's code, starts and delivers with the customer's code.
 */
export async function deliver(orderId: string, options: { rider?: Role; customer?: Role; shop?: Role; cashCollected?: boolean } = {}) {
  const rider = options.rider ?? "rider";
  const offer = await offerFor(orderId, rider);
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, rider), 200, "rider accepts");
  const code = await pickupCode(orderId, options.shop ?? "shop");
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, rider), 200, "pickup");
  expectStatus(await riderAction(offer.deliveryOrderId, "start", {}, rider), 200, "start delivery");
  const otp = await deliveryCode(orderId, options.customer ?? "customer");
  const done = await riderAction(offer.deliveryOrderId, "deliver", { otp, ...(options.cashCollected !== undefined ? { cashCollected: options.cashCollected } : {}) }, rider);
  expectStatus(done, 200, "deliver");
  return { deliveryOrderId: offer.deliveryOrderId };
}

/** Riders other than `keep` go offline locally, so this run's offer goes to the rider the case expects. */
export async function onlyRiderOnline(keep: Role = "rider") {
  if (!IS_LOCAL) return;
  const keepUser = need(world().users[keep], `${keep} account`);
  await db()`update delivery_partners set is_online = (user_id = ${keepUser.id!}) where is_online or user_id = ${keepUser.id!}`;
  await db()`update delivery_partners set last_location_latitude = ${String(world().location!.lat + 0.001)}, last_location_longitude = ${String(world().location!.lng + 0.001)}, last_location_at = now() where user_id = ${keepUser.id!}`;
}

/** Signed-in user id (works on every target). */
export async function userId(role: Role) {
  return (await me(role)).id;
}

export type { APIRequestContext };
