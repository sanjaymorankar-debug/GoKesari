/**
 * Helpers for package 7 — finance, settlement and rider earnings, sell /
 * purchase / inventory, their field checks and the end-to-end scenarios
 * (tests/qa/signed-in/finance-*.spec.ts, tests/qa/local/finance-*.spec.ts,
 * tests/qa/scenarios/SC-*.spec.ts).
 *
 * Everything here composes lib/flows.ts and the site's own APIs. The parts
 * that read or arrange the local database (db()) are only called by
 * "local"-tier checks; each such function says so.
 *
 * Workarounds for the shared lib (reported in the package-7 report):
 *  - flows.deliver() asks the customer for a NEW delivery code, which waits
 *    out the 60 s resend cooldown on every delivery. Locally the code the
 *    rider's "start" e-mailed to the customer is read from the mail catcher
 *    instead (deliverOrder below); on the sites it falls back to flows.
 *  - flows.orderAs() only sees the newest 25 orders of /api/orders; the
 *    customers here place many, so orderDetail() pages through them.
 */
import { expect, request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { encode } from "next-auth/jwt";

import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";

import { as, me, pageAs } from "./actors";
import { db } from "./db";
import {
  addToCart,
  defaultAddress,
  deliveryCode,
  emptyCart,
  fulfil,
  offerFor,
  onlyRiderOnline,
  packOrder,
  pickupCode,
  riderAction,
  sellable,
  walletBalance,
  type Listing,
  type PlacedOrder,
} from "./flows";
import { call, expectStatus, poll, RUN, why, type Answer, type Method } from "./http";
import { messagesTo, waitForCode } from "./mail";
import { blocked, need } from "./record";
import { assertWritable, BASE_URL, IS_LOCAL } from "./target";
import { world, type Role, type WorldListing } from "./world";

export type { Listing, PlacedOrder };

/* ---------------------------------------------------------------- calls */

/** One API call as `role` (never throws on a status). */
export async function api(role: Role, method: Method, path: string, data?: unknown, options: Parameters<typeof call>[4] = {}): Promise<Answer> {
  if (method !== "GET") assertWritable(`${method} ${path}`);
  return call(await as(role), method, path, data, options);
}

/** A fresh request id for idempotent writes. */
export const rid = (tag = "x") => `qa-${RUN}-${tag}-${randomUUID().slice(0, 8)}`;

export const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

/** An amount as the site's <Money> shows it: "₹44" for whole rupees, "₹70.50" otherwise (formatPaiseCompact). */
export function shown(paise: number): string {
  return paise % 100 === 0
    ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100)
    : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100);
}

/* -------------------------------------------------------------- world */

type ListingKey = "packaged" | "milk" | "loose" | "unpricedLoose" | "offlineOnly" | "sharedA" | "sharedB" | "lowStock" | "premium";

/** A world listing with its shop resolved (B for sharedB / offlineOnly, else A). */
export function listingOf(key: ListingKey): Listing {
  const l = need(world().listings[key], `the "${key}" listing in this site's test data`) as WorldListing;
  const shopKey = key === "sharedB" || key === "offlineOnly" ? "B" : "A";
  const shop = need(world().shops[shopKey], `shop ${shopKey}`);
  return { ...l, shopId: need(shop.id, `shop ${shopKey}'s id`), shopName: shop.name };
}

export function shopId(key: "A" | "B" | "C" | "pending" = "A"): string {
  return need(need(world().shops[key], `shop ${key} in this site's test data`).id, `shop ${key}'s id`);
}

export function userOf(role: Role) {
  return need(world().users[role], `the ${role} account in this site's test data`);
}

/* -------------------------------------------------------------- rules */

interface RuleRow {
  key: string;
  value: Record<string, unknown>;
  overridden: boolean;
}

/** A business rule's effective value and whether an admin override is stored. */
export async function ruleState(key: string): Promise<RuleRow> {
  const res = await api("admin", "GET", "/api/admin/settings");
  expectStatus(res, 200, "GET /api/admin/settings");
  const row = (res.body.rules as RuleRow[]).find((r) => r.key === key);
  if (!row) throw new Error(`no rule "${key}"`);
  return row;
}

/**
 * Overrides rules (partial values are completed from the defaults) and
 * returns the function that puts every one back as it was. Local tier only:
 * a rule is global for the whole site.
 */
export async function setRules(changes: Record<string, Record<string, unknown>>): Promise<() => Promise<void>> {
  if (!IS_LOCAL) blocked("changing /admin/settings is for the local server only");
  const previous: RuleRow[] = [];
  const restore = async () => {
    for (const p of previous.reverse()) {
      const res = p.overridden
        ? await api("admin", "PUT", "/api/admin/settings", { key: p.key, value: p.value })
        : await api("admin", "DELETE", `/api/admin/settings?key=${encodeURIComponent(p.key)}`);
      expectStatus(res, 200, `restore rule ${p.key}`);
    }
  };
  try {
    for (const [key, value] of Object.entries(changes)) {
      const before = await ruleState(key);
      previous.push(before);
      const res = await api("admin", "PUT", "/api/admin/settings", { key, value: { ...before.value, ...value } });
      expectStatus(res, 200, `set rule ${key}`);
    }
  } catch (error) {
    await restore();
    throw error;
  }
  return restore;
}

/** Runs `body` with the rules changed, and always restores them. */
export async function withRules<T>(changes: Record<string, Record<string, unknown>>, body: () => Promise<T>): Promise<T> {
  const restore = await setRules(changes);
  try {
    return await body();
  } finally {
    await restore();
  }
}

/* --------------------------------------------------------- commission */

/** Local: ids of the active commission rates, to put back after a check that sets its own. */
export async function commissionSnapshot(): Promise<string[]> {
  const rows = await db()<{ id: string }[]>`select id from commission_rates where is_active`;
  return rows.map((r) => r.id);
}

/** Local: deactivates every rate set since the snapshot and re-activates the snapshot's. */
export async function restoreCommission(active: string[]) {
  await db()`update commission_rates set is_active = false where is_active`;
  if (active.length) await db()`update commission_rates set is_active = true where id = any(${active})`;
}

export async function setCommission(scope: "DEFAULT" | "SHOP_TYPE" | "SHOP", rateBp: number, target: { shopType?: string; shopId?: string } = {}) {
  const res = await api("admin", "POST", "/api/finance/commission-rates", {
    scope,
    shopType: target.shopType ?? null,
    shopId: target.shopId ?? null,
    rateBp,
    note: `QA ${RUN}`,
  });
  expectStatus(res, 201, `set ${scope} commission ${rateBp} bp`);
  return res.body as { id: string; rateBp: number; scope: string };
}

/* ------------------------------------------------------------- orders */

/** The customer's order with its items (pages through /api/orders, newest first). */
export async function orderDetail(role: Role, orderId: string) {
  const res = await api(role, "GET", "/api/orders");
  expectStatus(res, 200, "GET /api/orders");
  const list = (Array.isArray(res.body) ? res.body : (res.body?.orders ?? [])) as OrderRow[];
  const found = list.find((o) => o.id === orderId);
  if (found) return found;
  if (IS_LOCAL) {
    const [row] = await db()<{ status: string; total_paise: number; subtotal_paise: number; refunded_paise: number; order_number: string; delivery_fee_paise: number }[]>`
      select status, total_paise::int, subtotal_paise::int, refunded_paise::int, order_number, delivery_fee_paise::int from orders where id = ${orderId}`;
    if (row) {
      return {
        id: orderId,
        status: row.status,
        totalPaise: row.total_paise,
        subtotalPaise: row.subtotal_paise,
        refundedPaise: row.refunded_paise,
        orderNumber: row.order_number,
        deliveryFeePaise: row.delivery_fee_paise,
        items: [],
      } as unknown as OrderRow;
    }
  }
  return null;
}

export interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalPaise: number;
  subtotalPaise: number;
  deliveryFeePaise: number;
  refundedPaise: number;
  paymentMethod: string;
  paidAt: string | null;
  shopId: string;
  shopName: string;
  items: {
    id: string;
    shopProductId: string;
    productNameSnapshot: string;
    unitSnapshot: string;
    unitPricePaise: number;
    quantityMilli: number;
    lineTotalPaise: number;
    fulfilmentStatus: string;
    substituteLineTotalPaise: number | null;
  }[];
}

export async function statusOf(orderId: string, role: Role = "customer") {
  return (await orderDetail(role, orderId))?.status ?? "missing";
}

/**
 * Checkout is limited to 15 attempts a minute per account (RATE_LIMITS.CHECKOUT);
 * the journeys here place many orders, so they keep to 12 a minute and, if
 * the limit is hit anyway (a restarted worker forgets its count), wait it out.
 */
const recentCheckouts = new Map<Role, number[]>();
async function paceCheckout(role: Role) {
  const now = Date.now();
  const list = (recentCheckouts.get(role) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 12) await new Promise((r) => setTimeout(r, 60_000 - (now - list[0]) + 500));
  list.push(Date.now());
  recentCheckouts.set(role, list.filter((t) => Date.now() - t < 60_000));
}

export async function postCheckout(role: Role, body: Record<string, unknown>): Promise<Answer> {
  await paceCheckout(role);
  let res = await api(role, "POST", "/api/checkout", body);
  for (let i = 0; i < 4 && res.status === 429; i++) {
    await new Promise((r) => setTimeout(r, 20_000));
    res = await api(role, "POST", "/api/checkout", body);
  }
  return res;
}

/**
 * Cart with several lines from one or more shops, then one checkout.
 * Refusals the site may make (no stock) block the case.
 */
export async function checkoutLines(
  lines: { listing: Listing; quantity: number }[],
  options: { role?: Role; method?: "WALLET" | "ONLINE" | "COD"; extra?: Record<string, unknown>; requestId?: string; noTopUp?: boolean } = {},
): Promise<{ res: Answer; requestId: string; orders: { id: string; orderNumber: string; totalPaise: number; status: string; shopId: string }[] }> {
  const role = options.role ?? "customer";
  await emptyCart(role);
  for (const l of lines) {
    const added = await addToCart(role, l.listing.shopProductId, l.quantity);
    if (added.status === 409 || added.status === 422) blocked(`"${l.listing.name}" × ${l.quantity} cannot be added to the cart — ${why(added)}`);
    expectStatus(added, [200, 201], `add ${l.listing.name}`);
  }
  const address = await defaultAddress(role);
  const requestId = options.requestId ?? rid("co");
  const body = {
    requestId,
    addressId: address?.id ?? null,
    paymentMethod: options.method ?? "WALLET",
    acknowledgeClosedShopIds: [...new Set(lines.map((l) => l.listing.shopId))],
    ...options.extra,
  };
  let res = await postCheckout(role, body);
  // The journeys spend the seeded ₹5,000 quickly; locally the wallet is topped up as a settled gateway top-up would.
  if (res.status === 402 && IS_LOCAL && (options.method ?? "WALLET") === "WALLET" && !options.noTopUp) {
    await arrangeGatewayTopUp(role, 500_000);
    res = await postCheckout(role, body);
  }
  return { res, requestId, orders: (res.body?.orders ?? []) as { id: string; orderNumber: string; totalPaise: number; status: string; shopId: string }[] };
}

/** One-shop wallet order of `quantity` × `listing` (201 expected). */
export async function buy(listing: Listing, quantity = 1, options: { role?: Role; method?: "WALLET" | "ONLINE" | "COD"; extra?: Record<string, unknown> } = {}) {
  const out = await checkoutLines([{ listing, quantity }], options);
  if (out.res.status === 409 || out.res.status === 422 || out.res.status === 402) blocked(`checkout refused — ${why(out.res)}`);
  expectStatus(out.res, 201, "checkout");
  const order = out.orders[0];
  expect(order?.id, "an order was created").toBeTruthy();
  return { ...order, requestId: out.requestId, listing, body: out.res.body } as PlacedOrder & { shopId: string };
}

/** Any shop fulfilment action (flows.fulfil types only accept / start / ready / reject). */
export async function shopAction(
  orderId: string,
  action: "accept" | "start" | "ready" | "reject" | "pick" | "remove" | "substitute",
  extra: Record<string, unknown> = {},
  role: Role = "shop",
): Promise<Answer> {
  return api(role, "POST", `/api/orders/${orderId}/fulfilment`, { action, ...extra });
}

/* ------------------------------------------------------------ delivery */

/** The delivery code the rider's "start" e-mailed to the customer (local mail catcher), else a new one from the order page. */
export async function deliveryCodeFor(orderId: string, customer: Role, since: number): Promise<string> {
  if (IS_LOCAL) {
    const email = userOf(customer).email;
    const order = await orderDetail(customer, orderId);
    const found = await poll(
      async () => {
        for (const m of messagesTo(email, since)) {
          const subject = m.body.match(/(\d{4}) is your delivery code for order ([A-Z0-9-]+)/);
          if (subject && (!order || subject[2] === order.orderNumber)) return subject[1];
          const text = m.body.match(/order ([A-Z0-9-]+)[^\n]*is on the way[\s\S]{0,200}?Delivery code:\s*(\d{4})/);
          if (text && (!order || text[1] === order.orderNumber)) return text[2];
        }
        return null;
      },
      (v) => v !== null,
      15_000,
      500,
    );
    if (found) return found;
  }
  return deliveryCode(orderId, customer);
}

/** Rider accepts the offer, picks up with the shop's code, starts and delivers with the customer's code. */
export async function deliverOrder(orderId: string, options: { rider?: Role; customer?: Role; shop?: Role; cashCollected?: boolean } = {}) {
  const rider = options.rider ?? "rider";
  const offer = await offerFor(orderId, rider);
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, rider), 200, "rider accepts");
  const code = await pickupCode(orderId, options.shop ?? "shop");
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, rider), 200, "pickup");
  const since = Date.now() - 2000;
  expectStatus(await riderAction(offer.deliveryOrderId, "start", {}, rider), 200, "start delivery");
  const otp = await deliveryCodeFor(orderId, options.customer ?? "customer", since);
  const done = await riderAction(offer.deliveryOrderId, "deliver", { otp, ...(options.cashCollected !== undefined ? { cashCollected: options.cashCollected } : {}) }, rider);
  expectStatus(done, 200, "deliver");
  return { deliveryOrderId: offer.deliveryOrderId };
}

/** Picks up and starts the drop (OUT_FOR_DELIVERY), without delivering. */
export async function pickUpAndStart(orderId: string, options: { rider?: Role; shop?: Role } = {}) {
  const rider = options.rider ?? "rider";
  const offer = await offerFor(orderId, rider);
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, rider), 200, "rider accepts");
  const code = await pickupCode(orderId, options.shop ?? "shop");
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, rider), 200, "pickup");
  expectStatus(await riderAction(offer.deliveryOrderId, "start", {}, rider), 200, "start delivery");
  return { deliveryOrderId: offer.deliveryOrderId };
}

/**
 * Local: frees a rider of any delivery left active by an earlier failed check
 * (so this run's offer can reach them) and puts them online at shop A.
 */
export async function freeRider(rider: Role = "rider") {
  if (!IS_LOCAL) return;
  const user = userOf(rider);
  await db()`update delivery_orders set status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'QA reset', updated_at = now()
    where delivery_partner_id = (select id from delivery_partners where user_id = ${user.id!})
      and status in ('OFFERED', 'ACCEPTED', 'PICKED_UP')`;
  await onlyRiderOnline(rider);
}

/** Places, packs and delivers one wallet order (the whole of TC-ORD-001 in one call). */
export async function deliveredOrder(options: { listing?: Listing; quantity?: number; role?: Role; rider?: Role; method?: "WALLET" | "COD" | "ONLINE"; beforeReady?: (order: PlacedOrder & { shopId: string }) => Promise<void> } = {}) {
  const rider = options.rider ?? "rider";
  await freeRider(rider);
  const listing = options.listing ?? (await sellable("A"));
  await stockUp(listing, (options.quantity ?? 1) + 2);
  const order = await buy(listing, options.quantity ?? 1, { role: options.role, method: options.method });
  const shop: Role = listing.shopId === world().shops.B?.id ? "shopB" : listing.shopId === world().shops.C?.id ? "shopC" : "shop";
  if (options.beforeReady) {
    expectStatus(await fulfil(order.id, "accept", {}, shop), 200, "shop accepts");
    expectStatus(await fulfil(order.id, "start", {}, shop), 200, "shop starts");
    await options.beforeReady(order);
    expectStatus(await fulfil(order.id, "ready", {}, shop), 200, "shop ready");
  } else {
    await packOrder(order.id, shop);
  }
  const { deliveryOrderId } = await deliverOrder(order.id, {
    rider,
    customer: options.role ?? "customer",
    shop,
    ...(options.method === "COD" ? { cashCollected: true } : {}),
  });
  return { ...order, deliveryOrderId, shopRole: shop };
}

/**
 * Local: one wallet order delivered by `rider` over a leg of `km` km (the
 * shop-to-customer distance the earning is paid on is set on the offered leg,
 * as the routing service would have measured it). Returns the order and the
 * rider's earning with its breakdown lines.
 */
export async function deliveryOver(km: number, options: { rider?: Role; listing?: Listing } = {}) {
  const rider = options.rider ?? "rider";
  await freeRider(rider);
  const listing = options.listing ?? (await sellable("A"));
  const order = await buy(listing, 1);
  await packOrder(order.id, shopRoleOf(listing));
  const offer = await offerFor(order.id, rider);
  await db()`update delivery_orders set distance_km = ${String(km)} where id = ${offer.deliveryOrderId}`;
  await deliverOrder(order.id, { rider, shop: shopRoleOf(listing) });
  return { ...order, deliveryOrderId: offer.deliveryOrderId, earning: await earningOf(offer.deliveryOrderId, rider) };
}

export interface EarningLine {
  component: string;
  amountPaise: number;
  description: string;
}

/** The rider's own statement entry for a delivery (GET /api/delivery-partner/earnings). */
export async function earningOf(deliveryOrderId: string, rider: Role = "rider") {
  const res = await api(rider, "GET", "/api/delivery-partner/earnings");
  expectStatus(res, 200, "rider statement");
  const e = (res.body.statement as { id: string; deliveryOrderId: string | null; totalPaise: number; slotId: string | null; lines: EarningLine[] }[]).find((x) => x.deliveryOrderId === deliveryOrderId);
  return need(e, `the earning of delivery ${deliveryOrderId} in the rider's statement`);
}

/**
 * Local: tops a listing's online stock up to 50 when it has fallen below
 * `min` — the world's listings are shared by many journeys and would
 * otherwise run out during a long run. (A restock as the owner would do it.)
 */
export async function stockUp(listing: Listing, min = 3) {
  if (!IS_LOCAL) return;
  await db()`update shop_products set online_stock = 50, is_available = true where id = ${listing.shopProductId} and track_inventory and online_stock < ${min}`;
}

export function shopRoleOf(listing: Listing): Role {
  return listing.shopId === world().shops.B?.id ? "shopB" : listing.shopId === world().shops.C?.id ? "shopC" : "shop";
}

/* ------------------------------------------------------------- finance */

export interface Trace {
  order: { id: string; orderNumber: string; status: string; subtotalPaise: number; deliveryFeePaise: number; totalPaise: number; refundedPaise: number; shopId: string };
  payment: { method: string; amountPaise: number; reference: string } | null;
  walletEntries: { id: string; type: string; amountPaise: number; description: string }[];
  snapshot: {
    goodsPaise: number;
    gmvPaise: number;
    deliveryFeePaise: number;
    commissionRateBp: number;
    commissionPaise: number;
    shopPayablePaise: number;
    settlementId: string | null;
    deliveredAt: string;
  } | null;
  adjustments: { id: string; type: string; amountPaise: number; customerRefundPaise: number; status: string }[];
  ledger: { entryType: string; entityType: string; direction: string; amountPaise: number; idempotencyKey: string }[];
  reconciliation: { checkType: string; status: string }[];
  settlement: { id: string; status: string } | null;
  riderEarning: { totalPaise: number; payoutId: string | null } | null;
}

/** The admin's money trace of one order (GET /api/finance/orders/{orderNumber}). */
export async function trace(orderNumber: string): Promise<Trace> {
  const res = await api("admin", "GET", `/api/finance/orders/${encodeURIComponent(orderNumber)}`);
  expectStatus(res, 200, `money trace of ${orderNumber}`);
  return res.body as Trace;
}

/** Local: how many finance snapshots an order has (the table allows one; the check proves it). */
export async function snapshotCount(orderId: string): Promise<number> {
  const [row] = await db()<{ n: number }[]>`select count(*)::int as n from order_financials where order_id = ${orderId}`;
  return row.n;
}

/** IST date (YYYY-MM-DD) of a moment. */
export function istDate(at: Date = new Date()): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week before this one (IST) — the default settlement week — and a moment inside it. */
export function lastWeek() {
  const today = istDate();
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7; // Monday = 1
  const thisMonday = addDaysIso(today, -(weekday - 1));
  const start = addDaysIso(thisMonday, -7);
  return { start, end: thisMonday, thisMonday, inside: new Date(`${addDaysIso(start, 2)}T06:30:00Z`) /* Wednesday, noon IST */ };
}

/**
 * Local: dates an order's delivery (and its rider earning) back to `at`, as
 * if it had been delivered then — the settlement hold and the weekly batch
 * windows look at these times.
 */
export async function ageDelivery(orderId: string, at: Date = lastWeek().inside) {
  await db()`update order_financials set delivered_at = ${at} where order_id = ${orderId}`;
  await db()`update delivery_partner_earnings set created_at = ${at}
    where delivery_order_id in (select id from delivery_orders where order_id = ${orderId})`;
}

export interface Settlement {
  id: string;
  shopId: string;
  status: string;
  periodStart: string;
  orderCount: number;
  goodsPaise: number;
  commissionPaise: number;
  refundsPaise: number;
  adjustmentsPaise: number;
  netPayablePaise: number;
  paymentReference: string | null;
}

export async function settlements(): Promise<{ settlement: Settlement; shopName: string }[]> {
  const res = await api("admin", "GET", "/api/finance/settlements");
  expectStatus(res, 200, "GET /api/finance/settlements");
  return res.body;
}

export interface Payout {
  id: string;
  deliveryPartnerId: string;
  status: string;
  earningsCount: number;
  grossPaise: number;
  adjustmentsPaise: number;
  amountPaise: number;
}

export async function payouts(): Promise<{ payout: Payout; partnerName: string }[]> {
  const res = await api("admin", "GET", "/api/finance/rider-payouts");
  expectStatus(res, 200, "GET /api/finance/rider-payouts");
  return res.body;
}

export async function partnerId(rider: Role = "rider"): Promise<string> {
  if (IS_LOCAL) {
    const [row] = await db()<{ id: string }[]>`select id from delivery_partners where user_id = ${userOf(rider).id!}`;
    return need(row?.id, `${rider}'s delivery partner profile`);
  }
  const res = await api(rider, "GET", "/api/delivery-partner/me");
  return need(res.body?.id ?? res.body?.partner?.id, `${rider}'s delivery partner profile`) as string;
}

/* ----------------------------------------------------------- inventory */

export interface InventoryRow {
  shopProductId: string;
  productName: string;
  unit: string;
  onlinePricePaise: number | null;
  available: number;
  reserved: number;
  onHand: number;
  status: string;
  thresholds: { lowStock: number; reorderLevel: number | null; reorderQuantity: number | null; source: Record<string, string> };
  own: { lowStockThreshold: number; reorderLevel: number | null; reorderQuantity: number | null };
}

/** The owner's inventory (GET /api/shops/{id}/inventory). */
export async function inventory(owner: Role = "shop", shop: "A" | "B" | "C" = "A") {
  const res = await api(owner, "GET", `/api/shops/${shopId(shop)}/inventory`);
  expectStatus(res, 200, "GET inventory");
  return res.body as { dashboard: Record<string, number>; rows: InventoryRow[] };
}

export async function inventoryRow(shopProductId: string, owner: Role = "shop", shop: "A" | "B" | "C" = "A"): Promise<InventoryRow> {
  const row = (await inventory(owner, shop)).rows.find((r) => r.shopProductId === shopProductId);
  return need(row, `listing ${shopProductId} on the inventory page`);
}

/** Available (online) stock of a listing, as the owner's inventory shows it. */
export async function stockOf(shopProductId: string, owner: Role = "shop", shop: "A" | "B" | "C" = "A"): Promise<number> {
  return (await inventoryRow(shopProductId, owner, shop)).available;
}

/** Owner sets the online stock of a listing (PATCH /api/shop-products/{id}). */
export async function setStock(shopProductId: string, onlineStock: number, owner: Role = "shop") {
  const res = await api(owner, "PATCH", `/api/shop-products/${shopProductId}`, { onlineStock });
  expectStatus(res, 200, `set stock to ${onlineStock}`);
  return res.body;
}

export interface Movement {
  delta_units: number;
  previous_units: number;
  new_units: number;
  reason: string;
  order_id: string | null;
  created_by: string | null;
  channel: string;
  created_at: Date;
}

/** Local: the stock movements of a listing since `since`, oldest first. */
export async function movements(shopProductId: string, since: Date = new Date(Date.now() - 3600_000)): Promise<Movement[]> {
  return db()<Movement[]>`select delta_units, previous_units, new_units, reason, order_id, created_by, channel, created_at
    from inventory_movements where shop_product_id = ${shopProductId} and created_at >= ${since} order by created_at, id`;
}

/** Local: online stock straight from the listing row. */
export async function dbStock(shopProductId: string): Promise<number> {
  const [row] = await db()<{ online_stock: number }[]>`select online_stock from shop_products where id = ${shopProductId}`;
  return row.online_stock;
}

/**
 * Local: a fresh listing for one check — a new master product in the QA
 * category, listed at shop A (or B) with the given price and stock, so the
 * check's stock arithmetic starts from a known figure and touches no other
 * check's listing. Loose goods sell in steps of `unitSizeMilli` (250 = 250 g).
 */
export async function freshListing(options: {
  name?: string;
  shop?: "A" | "B" | "C";
  pricePaise?: number | null;
  stock?: number;
  mrpPaise?: number | null;
  kind?: "PACKAGED" | "LOOSE";
  unit?: string;
  unitSizeMilli?: number;
  gstRateBp?: number | null;
  hsn?: string | null;
  onlineSaleEnabled?: boolean;
  productId?: string;
} = {}): Promise<Listing & { categoryId: string }> {
  const w = world() as ReturnType<typeof world> & { category?: { id: string } };
  const categoryId = need(w.category?.id, "the QA category in this site's test data");
  const shop = options.shop ?? "A";
  const name = `${options.name ?? "QA Item"} ${RUN}-${randomUUID().slice(0, 4)}`;
  let productId = options.productId;
  if (!productId) {
    const [product] = await db()<{ id: string }[]>`
      insert into products (category_id, name, slug, unit, unit_size_milli, subscribable, kind, mrp_paise, mrp_source, mrp_verification_status, mrp_updated_at,
                            approval_status, is_active, gst_rate_bp, hsn_code)
      values (${categoryId}, ${name}, ${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}, ${options.unit ?? (options.kind === "LOOSE" ? "kg" : "piece")},
              ${options.unitSizeMilli ?? 1000}, false, ${options.kind ?? "PACKAGED"},
              ${options.mrpPaise ?? null}, ${options.mrpPaise != null ? "ADMIN" : null}, ${options.mrpPaise != null ? "VERIFIED" : "UNVERIFIED"},
              ${options.mrpPaise != null ? new Date() : null}, 'APPROVED', true, ${options.gstRateBp ?? null}, ${options.hsn ?? null})
      returning id`;
    productId = product.id;
  }
  const price = options.pricePaise === undefined ? 5000 : options.pricePaise;
  const [sp] = await db()<{ id: string }[]>`
    insert into shop_products (shop_id, product_id, online_sale_enabled, offline_sale_enabled, online_price_paise, online_stock, track_inventory, is_active, is_available)
    values (${shopId(shop)}, ${productId}, ${options.onlineSaleEnabled ?? price != null}, false, ${price}, ${options.stock ?? 100}, true, true, true)
    returning id`;
  const shopRow = need(world().shops[shop], `shop ${shop}`);
  return {
    shopProductId: sp.id,
    productId,
    name,
    pricePaise: price,
    mrpPaise: options.mrpPaise ?? null,
    stock: options.stock ?? 100,
    shopId: shopId(shop),
    shopName: shopRow.name,
    categoryId,
  };
}

/** Local: audit rows of an action (optionally for one entity) written since `since`. */
export async function auditRows(action: string, since: Date, entityId?: string) {
  return entityId
    ? db()<{ action: string; entity_id: string; actor_id: string | null; new_value: unknown; previous_value: unknown }[]>`
        select action, entity_id, actor_id, new_value, previous_value from audit_logs where action = ${action} and entity_id = ${entityId} and created_at >= ${since} order by created_at`
    : db()<{ action: string; entity_id: string; actor_id: string | null; new_value: unknown; previous_value: unknown }[]>`
        select action, entity_id, actor_id, new_value, previous_value from audit_logs where action = ${action} and created_at >= ${since} order by created_at`;
}

/**
 * Local: a gateway wallet top-up as a settled Cashfree payment leaves it — the
 * payments row SUCCESS and, unless `credited` is false, the wallet credited by
 * the same amount (the local build cannot reach a gateway to make one).
 */
export async function arrangeGatewayTopUp(role: Role, amountPaise: number, credited = true): Promise<{ paymentId: string; gatewayOrderId: string }> {
  const user = userOf(role);
  const gatewayOrderId = `qa_${RUN}_${randomUUID().slice(0, 8)}`;
  const [payment] = await db()<{ id: string }[]>`
    insert into payments (user_id, gateway, gateway_order_id, gateway_payment_id, amount_paise, status, purpose)
    values (${user.id!}, 'MOCK', ${gatewayOrderId}, ${`pay_${gatewayOrderId}`}, ${amountPaise}, 'SUCCESS', 'WALLET_TOPUP') returning id`;
  if (credited) {
    await db()`
      with w as (select id, balance_paise from wallets where user_id = ${user.id!} for update)
      , upd as (update wallets set balance_paise = balance_paise + ${amountPaise}, updated_at = now() where id = (select id from w) returning id)
      insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description, payment_id)
      select w.id, ${user.id!}, 'TOP_UP', ${amountPaise}, w.balance_paise, w.balance_paise + ${amountPaise}, ${"qa-topup-" + gatewayOrderId}, 'QA gateway top-up', ${payment.id} from w`;
  }
  return { paymentId: payment.id, gatewayOrderId };
}

/** Local: all riders but `keep` offline, and `keep` too when null (no rider can be offered). */
export async function ridersOffline() {
  await db()`update delivery_partners set is_online = false where is_online`;
}

/** Runs a scheduled job now, as the server's crontab would (POST /api/cron/<job> with the cron secret). Local only. */
export async function cron(job: string, body: unknown = {}): Promise<Answer> {
  if (!IS_LOCAL) blocked("running scheduled jobs by hand is for the local server only");
  const secret = need(process.env.CRON_SECRET, "CRON_SECRET (the local server's)");
  const guest = await (await import("./http")).anonymous();
  try {
    return await call(guest, "POST", `/api/cron/${job}`, body, { headers: { authorization: `Bearer ${secret}` } });
  } finally {
    await guest.dispose();
  }
}

export interface NotificationRow {
  type: string;
  title: string;
  body: string;
  created_at: Date;
}

/** Local: in-app notifications to `role` since `since` that mention `text` (an order number…). */
export async function notificationsOf(role: Role, text: string, since: Date): Promise<NotificationRow[]> {
  return db()<NotificationRow[]>`select type, title, body, created_at from notifications
    where user_id = ${userOf(role).id!} and created_at >= ${since} and (body like ${`%${text}%`} or title like ${`%${text}%`}) order by created_at, id`;
}

/** Pays an ONLINE checkout on the sandbox gateway's page, as the customer would (UPI by default). */
export async function payOnSandbox(browser: Browser, role: Role, redirectUrl: string, outcome: "SUCCESS" | "FAILURE" | "EXPIRE" = "SUCCESS", method: "UPI" | "CARD" | "NETBANKING" = "UPI") {
  const { context, page } = await pageAs(browser, role);
  try {
    await page.goto(redirectUrl);
    await expect(page.getByTestId("sandbox-checkout")).toBeVisible();
    await page.locator(`input[name=method][value=${method}]`).check().catch(() => {});
    await page.getByTestId(outcome === "SUCCESS" ? "sandbox-pay" : outcome === "FAILURE" ? "sandbox-fail" : "sandbox-expire").click();
    await page.waitForURL(/payment-return|\/orders/, { timeout: 30_000 }).catch(() => {});
  } finally {
    await context.close();
  }
}

/** Local: makes sure `role` has at least `minPaise` in the wallet (a settled gateway top-up), so a check can measure a debit. */
export async function ensureFunds(role: Role, minPaise = 200_000) {
  if (!IS_LOCAL) return;
  const balance = await walletBalance(role);
  if (balance < minPaise) await arrangeGatewayTopUp(role, minPaise - balance + 100_000);
}

/** Local: what the wallet paid for an order (the order's debits, positive). */
export async function walletDebitOf(orderId: string): Promise<number> {
  const [row] = await db()<{ paid: number }[]>`select coalesce(-sum(amount_paise), 0)::int as paid from wallet_transactions where order_id = ${orderId} and amount_paise < 0`;
  return row.paid;
}

/** The listing's card on /shop/manage/products (searched by name; the list is paged). */
export async function productCard(page: import("@playwright/test").Page, name: string) {
  await page.getByLabel("Find a product").fill(name);
  return page.getByText(name, { exact: true }).locator("xpath=ancestor::div[.//button[normalize-space()='Edit']][1]");
}

/* ---------------------------------------------------------------- pages */

/** Opens `path` as `role` and hands the page to `body`; the context is always closed. */
export async function asPage<T>(
  browser: Browser,
  role: Role,
  path: string,
  body: (page: import("@playwright/test").Page) => Promise<T>,
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<T> {
  const { context, page } = await pageAs(browser, role, options);
  try {
    const res = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(res?.status() ?? 0, `${path} as ${role}`).toBeLessThan(400);
    return await body(page);
  } finally {
    await context.close();
  }
}

/** "₹1,234.50" style amounts in a text, as paise. */
export function paiseIn(text: string): number[] {
  return [...text.matchAll(/₹\s?([\d,]+(?:\.\d{1,2})?)/g)].map((m) => Math.round(Number(m[1].replace(/,/g, "")) * 100));
}

/* ------------------------------------------------- people beyond the world */

/**
 * A new local account for a journey that needs someone the world does not
 * have (a resident, a second marketing customer, a new shop owner…). Created
 * in the local database as the seed creates its accounts (profile done, terms
 * accepted, a mobile of its own, a wallet, optionally funded and with an
 * address ~1 km from shop A), and signed in with a session minted with the
 * local AUTH_SECRET. Local tier only.
 */
export interface Person {
  id: string;
  email: string;
  mobile: string;
  addressId: string | null;
  ctx: APIRequestContext;
}

const SECURE = BASE_URL.startsWith("https");
const SESSION_COOKIE = SECURE ? "__Secure-authjs.session-token" : "authjs.session-token";
let personSeq = 0;

async function sessionState(userId: string, email: string) {
  const secret = need(process.env.AUTH_SECRET, "AUTH_SECRET (the local server's)");
  const value = await encode({ token: { sub: userId, email, name: "qa" }, secret, salt: SESSION_COOKIE });
  return {
    cookies: [{ name: SESSION_COOKIE, value, domain: new URL(BASE_URL).hostname, path: "/", expires: -1, httpOnly: true, secure: SECURE, sameSite: "Lax" as const }],
    origins: [],
  };
}

export function freshMobile() {
  personSeq += 1;
  return `6${String(Date.now() % 1e6).padStart(6, "0")}${String(personSeq % 1000).padStart(3, "0")}`;
}

export async function freshPerson(label: string, options: { walletPaise?: number; address?: boolean; marketing?: boolean; name?: string } = {}): Promise<Person> {
  if (!IS_LOCAL) blocked("new accounts are created in the local database only");
  const sql = db();
  const mobile = freshMobile();
  const email = `qa-${label}-${RUN}-${randomUUID().slice(0, 6)}@test.local`;
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, name, role, status, email_verified, profile_completed_at, phone, phone_e164, phone_verified_at)
    values (${email}, ${options.name ?? `QA ${label}`}, 'CUSTOMER', 'ACTIVE', now(), now(), ${mobile}, ${`+91${mobile}`}, now()) returning id`;
  await sql`insert into user_consents (user_id, consent_type, version, granted) values (${user.id}, 'TERMS_AND_PRIVACY', ${CURRENT_POLICY_VERSION}, true)`;
  if (options.marketing) await sql`insert into user_consents (user_id, consent_type, version, granted) values (${user.id}, 'MARKETING_COMMUNICATIONS', ${CURRENT_POLICY_VERSION}, true)`;
  await sql`insert into wallets (user_id, balance_paise) values (${user.id}, 0) on conflict do nothing`;
  if (options.walletPaise) {
    await sql`
      with w as (select id, balance_paise from wallets where user_id = ${user.id} for update)
      , upd as (update wallets set balance_paise = balance_paise + ${options.walletPaise}, updated_at = now() where id = (select id from w) returning id)
      insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description)
      select w.id, ${user.id}, 'TOP_UP', ${options.walletPaise}, w.balance_paise, w.balance_paise + ${options.walletPaise}, ${`qa-topup-${RUN}-${user.id}`}, 'QA top-up' from w`;
  }
  let addressId: string | null = null;
  if (options.address) {
    const home = world().location ?? { pincode: "411038", lat: 18.5074, lng: 73.8077 };
    const [row] = await sql<{ id: string }[]>`
      insert into addresses (user_id, line1, area, city, state, pincode, latitude, longitude, address_type, recipient_name, is_default, location_verified, location_verified_at, location_source)
      values (${user.id}, ${`QA ${label} flat ${personSeq}`}, 'Kothrud', 'Pune', 'Maharashtra', ${home.pincode}, ${String(home.lat + 0.009)}, ${String(home.lng)}, 'HOME', ${options.name ?? `QA ${label}`},
        true, true, now(), 'MANUAL_ENTRY') returning id`;
    addressId = row.id;
  }
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: await sessionState(user.id, email), timeout: 120_000 });
  return { id: user.id, email, mobile, addressId, ctx };
}

/** A browser page signed in as `person` (close the context when done). */
export async function personPage(browser: Browser, person: { id: string; email: string }, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...options, baseURL: BASE_URL, storageState: await sessionState(person.id, person.email) });
  return { context, page: await context.newPage() };
}

/** One wallet / COD order by `person` of `quantity` × `listing` (cart → checkout). */
export async function personBuys(person: Person, listing: Listing, quantity = 1, options: { method?: "WALLET" | "COD" | "ONLINE"; extra?: Record<string, unknown> } = {}) {
  await call(person.ctx, "DELETE", "/api/cart");
  const added = await call(person.ctx, "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity });
  if (added.status === 409 || added.status === 422) blocked(`"${listing.name}" × ${quantity} cannot be added to the cart — ${why(added)}`);
  expectStatus(added, [200, 201], `add ${listing.name}`);
  const res = await call(person.ctx, "POST", "/api/checkout", {
    requestId: rid("pco"),
    addressId: person.addressId,
    paymentMethod: options.method ?? "WALLET",
    acknowledgeClosedShopIds: [listing.shopId],
    ...options.extra,
  });
  return { res, order: (res.body?.orders ?? [])[0] as { id: string; orderNumber: string; totalPaise: number; status: string } | undefined };
}

/** The delivery code the rider's "start" e-mailed to `email` for `orderNumber` (local mail catcher). */
export async function mailedDeliveryCode(email: string, orderNumber: string, since: number): Promise<string> {
  const found = await poll(
    async () => {
      for (const m of messagesTo(email, since)) {
        const subject = m.body.match(/(\d{4}) is your delivery code for order ([A-Z0-9-]+)/);
        if (subject && subject[2] === orderNumber) return subject[1];
      }
      return null;
    },
    (v) => v !== null,
    20_000,
    500,
  );
  return need(found, `the delivery code mailed to ${email} for ${orderNumber}`);
}

/** Rider accepts, picks up, starts and delivers `person`'s order with the code mailed to them. */
export async function deliverToPerson(
  orderId: string,
  orderNumber: string,
  person: { email: string },
  options: { rider?: Role; shop?: Role; owner?: APIRequestContext; cashCollected?: boolean } = {},
) {
  const rider = options.rider ?? "rider";
  const offer = await offerFor(orderId, rider);
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, rider), 200, "rider accepts");
  const code = options.owner ? await slipCode(options.owner, orderId) : await pickupCode(orderId, options.shop ?? "shop");
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, rider), 200, "pickup");
  const since = Date.now() - 2000;
  expectStatus(await riderAction(offer.deliveryOrderId, "start", {}, rider), 200, "start delivery");
  const otp = await mailedDeliveryCode(person.email, orderNumber, since);
  const done = await riderAction(offer.deliveryOrderId, "deliver", { otp, ...(options.cashCollected !== undefined ? { cashCollected: options.cashCollected } : {}) }, rider);
  expectStatus(done, 200, "deliver");
  return { deliveryOrderId: offer.deliveryOrderId };
}

/** A small valid PNG (w × h, flat grey) for photo uploads. */
export function testPng(w = 200, h = 200): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const body = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([l, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* -------------------------------------------- shop onboarding (journeys) */

let idSeq = 0;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function letters(n: number, length: number) {
  let out = "";
  let v = Math.abs(Math.floor(n));
  for (let i = 0; i < length; i++) {
    out = LETTERS[v % 26] + out;
    v = Math.floor(v / 26);
  }
  return out;
}

/** A PAN (AAAPA9999A, an individual's) no other registration of this run uses. */
export function newPan(): string {
  idSeq += 1;
  const n = (parseInt(RUN, 36) % 1e9) * 41 + idSeq + Date.now() % 997;
  return `${letters(n, 3)}P${letters(n * 7, 1)}${String((n * 13) % 10000).padStart(4, "0")}${letters(n * 3, 1)}`;
}

export function newShopAct(): string {
  idSeq += 1;
  return `MH-PUNE-${RUN.toUpperCase()}-F${String(idSeq).padStart(3, "0")}${String(Date.now() % 1000).padStart(3, "0")}`;
}

/** A checksum-valid GSTIN for `pan` (state 27). */
export function gstinOf(pan: string): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const first14 = `27${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = chars.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return first14 + chars[(36 - (sum % 36)) % 36];
}

/** A one-page PDF whose text layer holds `lines` (as a GST certificate or an e-PAN carries one). */
export function textPdf(lines: string[]): Buffer {
  const escape = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const text = lines.map((l, i) => `${i === 0 ? "" : "T* "}(${escape(l)}) Tj`).join(" ");
  const stream = `BT /F1 12 Tf 50 800 Td 16 TL ${text} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A shop category (business kind) id by name, e.g. "Stationery Store". */
export async function shopCategory(name: string): Promise<string> {
  const res = await api("customer", "GET", "/api/shop-categories");
  expectStatus(res, 200, "GET /api/shop-categories");
  return need(((res.body?.categories ?? []) as { id: string; name: string }[]).find((c) => c.name.toLowerCase() === name.toLowerCase()), `shop category "${name}"`).id;
}

/** A valid self-service registration (a stationery shop beside shop A) with fresh identifiers. */
export async function shopRegistration(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const home = world().location ?? { pincode: "411038", lat: 18.5074, lng: 73.8077 };
  idSeq += 1;
  return {
    name: `QA Journey Shop ${RUN} ${idSeq}`,
    ownerName: "QA Journey Owner",
    phone: freshMobile(),
    email: null,
    addressLine1: `${idSeq} QA Journey Lane, Paud Road`,
    area: "Kothrud",
    city: "Pune",
    state: "Maharashtra",
    pincode: home.pincode,
    latitude: String(home.lat),
    longitude: String(home.lng + 0.002),
    shopType: "STATIONERY_STORE",
    categoryIds: [await shopCategory("Stationery Store")],
    shopActNumber: newShopAct(),
    deliveryAvailable: true,
    deliveryFeePaise: 2000,
    openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59" })),
    ...overrides,
  };
}

/** Lifecycle of a shop as stored (local). */
export async function shopStage(shopId: string) {
  const [row] = await db()<{ status: string; lifecycle_status: string; fee_payment_status: string; registration_fee_paise: number | null; classification: string | null; rejection_reason: string | null }[]>`
    select status, lifecycle_status, fee_payment_status, registration_fee_paise::int as registration_fee_paise, classification, rejection_reason from shops where id = ${shopId}`;
  return need(row, `shop ${shopId}`);
}

/** The pickup code on a shop's packing slip, read with the owner's own session. */
export async function slipCode(owner: APIRequestContext, orderId: string): Promise<string | null> {
  const res = await call(owner, "GET", `/shop/orders/${orderId}/packing-slip`, undefined, { maxRedirects: 3 });
  expectStatus(res, 200, "packing slip");
  return res.text.match(/Pickup code:\s*(?:<!-- -->)?\s*<span[^>]*>(\d{4,8})<\/span>/)?.[1] ?? null;
}

/**
 * Whether the /search page shows `who` (an API context with a default
 * address) the shop called `name`. The page lists only shops that deliver to
 * the customer's location unless "all" is asked for; the search is for the
 * name without its first word, so the query echoed on the page is not a match.
 */
export async function searchShows(who: APIRequestContext, name: string): Promise<boolean> {
  const q = name.split(" ").slice(1).join(" ");
  const res = await call(who, "GET", `/search?q=${encodeURIComponent(q)}`);
  expectStatus(res, 200, "the search page");
  // Shop names are stored title-cased ("mvm7" → "Mvm7"), so compare without case.
  const html = res.text.toLowerCase();
  const want = name.toLowerCase();
  return html.includes(`>${want}<`) || html.includes(`view shop: ${want}"`);
}

/**
 * Local: an approved shop of a new owner beside shop A (approvedShop, no
 * products yet) or a selling one (sellingShop) — registered
 * through the site, its documents and fee arranged as operations would have
 * left them (seller_verifications VERIFIED, fee PAID), approved by operations,
 * and the world's QA category added by the owner (every product of it listed
 * at stock 100). `listing` is its cheapest priced listing.
 */
export async function approvedShop(label: string) {
  const owner = await freshPerson(`${label}-owner`);
  const body = await shopRegistration();
  const reg = await call(owner.ctx, "POST", "/api/shops", body);
  expectStatus(reg, [200, 201], "register the shop");
  const id = reg.body.id as string;
  for (const docType of ["PAN", "GSTIN", "SHOP_ACT", "FSSAI"]) {
    await db()`insert into seller_verifications (shop_id, doc_type, status, verified_at) values (${id}, ${docType}, 'VERIFIED', now())
      on conflict (shop_id, doc_type) do update set status = 'VERIFIED', verified_at = now(), updated_at = now()`;
  }
  await db()`update shops set fee_payment_status = 'PAID', registration_fee_paise = 0 where id = ${id} and fee_payment_status <> 'PAID'`;
  expectStatus(await api("ops", "POST", `/api/shops/${id}/approve`, { classification: "GREEN" }), 200, "approve the shop");
  const [shop] = await db()<{ name: string; slug: string }[]>`select name, slug from shops where id = ${id}`;
  return { owner, shopId: id, name: shop.name, slug: shop.slug };
}

export async function sellingShop(label: string) {
  const { owner, shopId: id } = await approvedShop(label);
  const category = need((world() as unknown as { category?: { id: string } }).category?.id, "the world's QA category");
  expectStatus(await call(owner.ctx, "POST", `/api/shops/${id}/product-categories`, { categoryId: category }), [200, 201], "the owner adds the QA category");
  const own = await call(owner.ctx, "GET", `/api/shops/${id}/products`);
  expectStatus(own, 200, "the owner's listings");
  const rows = ((Array.isArray(own.body) ? own.body : own.body.products) as { id: string; productId: string; onlinePricePaise: number | null; onlineSaleEnabled: boolean; product: { name: string; kind: string } }[])
    .filter((l) => l.onlineSaleEnabled && (l.onlinePricePaise ?? 0) > 0 && l.product.kind === "PACKAGED")
    .sort((a, b) => (a.onlinePricePaise ?? 0) - (b.onlinePricePaise ?? 0));
  const cheapest = need(rows[0], "a priced listing in the new shop");
  const [shop] = await db()<{ name: string }[]>`select name from shops where id = ${id}`;
  const listing: Listing = {
    shopProductId: cheapest.id,
    productId: cheapest.productId,
    name: cheapest.product.name,
    pricePaise: cheapest.onlinePricePaise,
    stock: 100,
    shopId: id,
    shopName: shop.name,
  } as Listing;
  return { owner, shopId: id, name: shop.name, listing, listings: rows };
}

/** A fulfilment action by a new shop's owner. */
export async function ownerAction(owner: APIRequestContext, orderId: string, action: "accept" | "start" | "ready" | "reject", extra: Record<string, unknown> = {}) {
  return call(owner, "POST", `/api/orders/${orderId}/fulfilment`, { action, ...extra });
}

/* ---------------------------------------------------- sign-in on the page */

let ipSeq = 0;
/** A browser context of its own (client IP of its own, no session); close it when done. */
export async function guestPage(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  ipSeq += 1;
  const ip = `10.${70 + (ipSeq % 50)}.${Math.floor(Math.random() * 250)}.${(Date.now() % 250) + 1}`;
  const context = await browser.newContext({ ...options, baseURL: BASE_URL, extraHTTPHeaders: { "x-forwarded-for": ip, ...(options.extraHTTPHeaders ?? {}) } });
  return { context, page: await context.newPage() };
}

/** Opens /signin and ticks "I agree" until Get code is enabled (the page hydrates first). */
export async function openSignInPage(page: Page, path = "/signin") {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  if (!(await page.getByLabel("Mobile number or email").count())) {
    if (!/\/signin/.test(page.url())) throw new Error(`${path} did not show the sign-in page (now at ${page.url()} — still signed in?)`);
    blocked("the sign-in code form is not shown on this server");
  }
  const agree = page.getByTestId("signin-consent").getByRole("checkbox");
  const getCode = page.getByRole("button", { name: "Get code" });
  for (let i = 0; i < 30 && !(await getCode.isEnabled().catch(() => false)); i++) {
    if (!(await agree.isChecked().catch(() => false))) await agree.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
  await expect(getCode, "Get code is enabled once 'I agree' is ticked").toBeEnabled();
}

/** Local: moves an email's sign-in codes back past the 60 s resend cooldown (a person waiting a minute). */
export async function ageLoginCodes(email: string) {
  await db()`update login_otps set created_at = created_at - interval '61 seconds' where email = ${email.toLowerCase()}`;
}

/**
 * Signs in on the page with a code mailed to `email` (local mail catcher):
 * `identifier` is the email, or a mobile number that signs up from the code
 * step with `email` ("Sign up with your email"). Returns once the page has
 * left /signin.
 */
export async function signInOnPage(page: Page, identifier: string, email: string, options: { path?: string; signUp?: boolean } = {}) {
  await ageLoginCodes(email);
  await openSignInPage(page, options.path ?? "/signin");
  await page.getByLabel("Mobile number or email").fill(identifier);
  let since = Date.now();
  await page.getByRole("button", { name: "Get code" }).click();
  await expect(page.getByTestId("otp-sent-to"), "the code step opens").toBeVisible();
  if (options.signUp) {
    await page.getByRole("button", { name: "Sign up with your email" }).click();
    await page.getByLabel("Email address").fill(email);
    since = Date.now();
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByTestId("otp-sent-to")).toContainText("***@");
  }
  const code = await waitForCode(email.toLowerCase(), since);
  await page.getByLabel("One-time code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
}

const ACCOUNT_MENUS = ["account-button", "board-account", "seller-account-button", "account-dropdown"];

/** Signs out from whichever account menu the page's header has; waits until the session cookie is gone. */
export async function signOutOnPage(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const id of ACCOUNT_MENUS) {
      const button = page.getByTestId(id).locator("visible=true").first();
      if (await button.count()) {
        if (!(await button.click({ timeout: 5000 }).then(() => true, () => false))) continue;
        const out = page.getByRole("button", { name: /^Sign out$/ }).or(page.getByRole("menuitem", { name: /Sign out/ })).locator("visible=true").first();
        if (!(await out.isVisible().catch(() => false))) await page.waitForTimeout(500);
        await expect(out, "Sign out in the account menu").toBeVisible();
        await out.click();
        await expect.poll(async () => (await page.context().cookies()).some((c) => c.name === SESSION_COOKIE), { message: "the session cookie is cleared", timeout: 30_000 }).toBe(false);
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        return id;
      }
    }
    const menu = page.getByRole("button", { name: /Open menu/i }).first();
    if (await menu.isVisible().catch(() => false)) {
      await menu.click();
      const out = page.getByRole("button", { name: /^Sign out$/ }).first();
      if (await out.isVisible().catch(() => false)) {
        await out.click();
        await expect.poll(async () => (await page.context().cookies()).some((c) => c.name === SESSION_COOKIE), { message: "the session cookie is cleared", timeout: 30_000 }).toBe(false);
        return "open-menu";
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`no account menu with Sign out on ${page.url()}`);
}

/** A session cookie for `person` that has already expired (a session left idle past its lifetime). */
export async function expiredSession(person: { id: string; email: string }) {
  const secret = need(process.env.AUTH_SECRET, "AUTH_SECRET (the local server's)");
  // Expired an hour ago (Auth.js allows a few seconds of clock skew when it reads a session).
  const value = await encode({ token: { sub: person.id, email: person.email, name: "qa" }, secret, salt: SESSION_COOKIE, maxAge: -3600 });
  return { name: SESSION_COOKIE, value, domain: new URL(BASE_URL).hostname, path: "/", expires: -1, httpOnly: true, secure: SECURE, sameSite: "Lax" as const };
}

/**
 * Local: settles a MOCK wallet top-up the customer started (POST
 * /api/wallet/topup) as the gateway would: the payment SUCCESS and the wallet
 * credited once. The local production build has no gateway to pay at and
 * /api/dev/settle-topup answers 404 there.
 */
export async function settleTopUp(userId: string, gatewayOrderId: string) {
  const [payment] = await db()<{ id: string; amount: number }[]>`
    update payments set status = 'SUCCESS', gateway_payment_id = ${`pay_${gatewayOrderId}`}, updated_at = now()
    where gateway_order_id = ${gatewayOrderId} and user_id = ${userId} and status = 'CREATED' returning id, amount_paise::int as amount`;
  need(payment, `the created top-up ${gatewayOrderId}`);
  await db()`
    with w as (select id, balance_paise from wallets where user_id = ${userId} for update)
    , upd as (update wallets set balance_paise = balance_paise + ${payment.amount}, updated_at = now() where id = (select id from w) returning id)
    insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description, payment_id)
    select w.id, ${userId}, 'TOP_UP', ${payment.amount}, w.balance_paise, w.balance_paise + ${payment.amount}, ${`qa-settle-${gatewayOrderId}`}, 'Wallet top-up', ${payment.id} from w`;
  return payment.amount;
}

export { me, walletBalance, emptyCart, addToCart, fulfil, packOrder, offerFor, riderAction, pickupCode, defaultAddress, sellable, onlyRiderOnline };
