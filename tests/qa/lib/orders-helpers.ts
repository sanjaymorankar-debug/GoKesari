/**
 * Helpers for QA package 5 (orders, fulfilment, dispatch, delivery, returns,
 * support): multi-line checkouts, driving an order to any status, riders on
 * and off line at a chosen spot, stock and wallet reads, rule changes that
 * are always restored, cron calls, a real PNG for photo uploads and — local
 * runs only — fresh accounts minted the way actors.ts mints the world's.
 *
 * Built on lib/flows.ts; nothing here replaces it. Every writing helper calls
 * assertWritable(); db() and cron() refuse anything but a local server.
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { request as playwrightRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import { encode } from "next-auth/jwt";

import { as, pageAs } from "./actors";
import { db } from "./db";
import { messagesTo } from "./mail";
import { addToCart, defaultAddress, deliveryCode, emptyCart, fulfil, offerFor, pickupCode, riderAction, sellable, shopOf, type Listing } from "./flows";
import { anonymous, call, expectStatus, poll, RUN, stash, unstash, why, type Answer } from "./http";
import { blocked, need } from "./record";
import { assertWritable, BASE_URL, IS_LOCAL } from "./target";
import { world, type Role, type WorldListing } from "./world";

export { RUN };

/**
 * stash() under a stable key with a time stamp: RUN changes when Playwright
 * restarts the worker after a failed check, so keys built from it are lost;
 * this one survives the restart but ignores a value older than `maxAgeMs`
 * (a value left by an earlier run).
 */
export function keep<T>(key: string, value: T): T {
  stash(`orders5:${project()}:${key}`, { at: Date.now(), value });
  return value;
}

export function kept<T>(key: string, maxAgeMs = 45 * 60_000): T | undefined {
  const row = unstash<{ at: number; value: T }>(`orders5:${project()}:${key}`);
  if (!row || Date.now() - row.at > maxAgeMs) return undefined;
  return row.value;
}

/** The Playwright project of the running check, so a mobile run never reuses what the desktop run used up. */
function project(): string {
  try {
    return test.info().project.name;
  } catch {
    return "any";
  }
}

/* ------------------------------------------------------------ listings */

type ListingKey = keyof NonNullable<ReturnType<typeof world>["listings"]>;

/** A named listing of the world with its shop (blocks where this site's world has none). */
export async function listingOf(key: ListingKey): Promise<Listing> {
  const preset = world().listings[key] as WorldListing | undefined;
  if (key === "packaged" && !IS_LOCAL) return sellable("A");
  const row = need(preset, `the "${key}" listing in this site's test data`);
  const shopKey = key === "sharedB" || key === "offlineOnly" ? "B" : "A";
  const shop = await shopOf(shopKey);
  return { ...row, shopId: shop.id, shopName: shop.name };
}

/** Online stock of a listing as the shop's public storefront reports it (null when not tracked/listed). */
export async function stockOf(listing: Pick<Listing, "shopId" | "shopProductId">): Promise<number | null> {
  const res = await call(await as("customer"), "GET", `/api/shops/${listing.shopId}/products?limit=100`);
  expectStatus(res, 200, "storefront products");
  const rows = (Array.isArray(res.body) ? res.body : (res.body?.products ?? [])) as { shopProductId: string; onlineStock: number; trackInventory: boolean }[];
  const row = rows.find((r) => r.shopProductId === listing.shopProductId);
  return row ? row.onlineStock : null;
}

/* ------------------------------------------------------------- checkout */

export interface Placed {
  id: string;
  orderNumber: string;
  totalPaise: number;
  status: string;
  requestId: string;
  shopId: string;
}

/**
 * Empties the cart, adds every line (one shop) and checks out. A refusal the
 * site is entitled to make (no stock, out of area) blocks the case.
 */
export async function checkoutLines(
  lines: { listing: Listing; quantity?: number }[],
  options: { role?: Role; method?: "WALLET" | "COD" | "ONLINE"; addressId?: string | null; extra?: Record<string, unknown> } = {},
): Promise<Placed> {
  assertWritable("place an order");
  const role = options.role ?? "customer";
  await emptyCart(role);
  for (const line of lines) {
    const added = await addToCart(role, line.listing.shopProductId, line.quantity ?? 1);
    if (added.status === 409 || added.status === 422) blocked(`"${line.listing.name}" cannot be added to the cart — ${why(added)}`);
    expectStatus(added, [200, 201], `add ${line.listing.name}`);
  }
  const addressId = options.addressId !== undefined ? options.addressId : ((await defaultAddress(role))?.id ?? null);
  const requestId = `qa-${RUN}-${randomUUID().slice(0, 8)}`;
  const shopIds = [...new Set(lines.map((l) => l.listing.shopId))];
  const body = {
    requestId,
    addressId,
    paymentMethod: options.method ?? "WALLET",
    acknowledgeClosedShopIds: shopIds,
    ...options.extra,
  };
  let res = await call(await as(role), "POST", "/api/checkout", body);
  // Checkout allows 15 attempts a minute per customer: wait the window out, as a person would.
  for (let i = 0; i < 2 && res.status === 429; i++) {
    const seconds = Number(res.body?.error?.details?.retryAfterSeconds ?? 30);
    await new Promise((r) => setTimeout(r, Math.min(seconds, 65) * 1000 + 1000));
    res = await call(await as(role), "POST", "/api/checkout", body);
  }
  if (res.status === 402) blocked(`the ${role} wallet is too low for this order — ${why(res)}`);
  if (res.status === 409 || res.status === 422) blocked(`checkout refused — ${why(res)}`);
  expectStatus(res, 201, "checkout");
  const order = res.body.orders?.[0];
  expect(order?.id, "an order was created").toBeTruthy();
  return { id: order.id, orderNumber: order.orderNumber, totalPaise: order.totalPaise, status: order.status, requestId, shopId: order.shopId };
}

/** One unit of shop A's cheapest line (the world's packaged butter locally), wallet-paid. */
export async function placeSimple(options: { role?: Role; quantity?: number; method?: "WALLET" | "COD" } = {}): Promise<Placed> {
  return checkoutLines([{ listing: await listingOf("packaged"), quantity: options.quantity ?? 1 }], options);
}

/* ---------------------------------------------------------------- orders */

export interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalPaise: number;
  subtotalPaise: number;
  deliveryFeePaise: number;
  refundedPaise: number;
  paidAt: string | null;
  cancellationReason: string | null;
  shopId: string;
  items: {
    id: string;
    shopProductId: string;
    productNameSnapshot: string;
    quantityMilli: number;
    lineTotalPaise: number;
    fulfilmentStatus: string;
    substituteShopProductId: string | null;
    substituteLineTotalPaise: number | null;
    fulfilmentNote: string | null;
  }[];
}

/** The order as its customer's /api/orders shows it (the 25 newest). */
export async function orderRow(id: string, role: Role = "customer"): Promise<OrderRow> {
  const res = await call(await as(role), "GET", "/api/orders");
  expectStatus(res, 200, "GET /api/orders");
  const list = (Array.isArray(res.body) ? res.body : (res.body?.orders ?? [])) as OrderRow[];
  const row = list.find((o) => o.id === id);
  expect(row, `order ${id} in the customer's list`).toBeTruthy();
  return row!;
}

export async function statusOf(id: string, role: Role = "customer") {
  return (await orderRow(id, role)).status;
}

/** PATCH /api/orders/{id}/status as `role`. */
export async function setStatus(id: string, status: string, role: Role = "shop", note?: string) {
  assertWritable("change an order status");
  return call(await as(role), "PATCH", `/api/orders/${id}/status`, { status, ...(note ? { note } : {}) });
}

/**
 * Any shop fulfilment action, line-level ones included (flows.fulfil types
 * only accept / start / ready / reject).
 */
export async function shopAct(
  orderId: string,
  action: "accept" | "reject" | "start" | "pick" | "substitute" | "remove" | "ready",
  extra: Record<string, unknown> = {},
  role: Role = "shop",
) {
  assertWritable("act on an order");
  return call(await as(role), "POST", `/api/orders/${orderId}/fulfilment`, { action, ...extra });
}

/** Cleanup: cancels an order through operations (any status that may still be cancelled). Never throws. */
export async function abandon(id: string | undefined | null) {
  if (!id) return;
  try {
    await call(await as("ops"), "PATCH", `/api/orders/${id}/status`, { status: "CANCELLED", note: "QA cleanup" });
  } catch {
    /* best effort */
  }
}

export type Stage = "CONFIRMED" | "ACCEPTED" | "PREPARING" | "READY" | "ASSIGNED" | "PICKED_UP" | "OUT_FOR_DELIVERY" | "DELIVERED";
const STAGES: Stage[] = ["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"];

export interface Driven {
  deliveryOrderId?: string;
  pickupCode?: string | null;
  otp?: string;
}

/**
 * Moves a CONFIRMED order forward to `target` the way the people involved do
 * (shop buttons, rider offer, pickup code from the packing slip, delivery code
 * from the customer). `onStep` runs after each status is reached.
 */
export async function driveTo(
  orderId: string,
  target: Stage,
  options: { rider?: Role; shop?: Role; customer?: Role; from?: Stage; onStep?: (stage: Stage) => Promise<void>; cashCollected?: boolean } = {},
): Promise<Driven> {
  const rider = options.rider ?? "rider";
  const shop = options.shop ?? "shop";
  const out: Driven = {};
  const start = STAGES.indexOf(options.from ?? "CONFIRMED");
  for (const stage of STAGES.slice(start + 1, STAGES.indexOf(target) + 1)) {
    switch (stage) {
      case "ACCEPTED":
        expectStatus(await fulfil(orderId, "accept", {}, shop), 200, "shop accepts");
        break;
      case "PREPARING":
        expectStatus(await fulfil(orderId, "start", {}, shop), 200, "shop starts picking");
        break;
      case "READY":
        expectStatus(await fulfil(orderId, "ready", {}, shop), 200, "shop marks ready");
        break;
      case "ASSIGNED": {
        const offer = await offerFor(orderId, rider, 30_000);
        out.deliveryOrderId = offer.deliveryOrderId;
        if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, rider), 200, "rider accepts");
        break;
      }
      case "PICKED_UP": {
        out.deliveryOrderId ??= (await offerFor(orderId, rider, 5_000)).deliveryOrderId;
        out.pickupCode = await pickupCode(orderId, shop);
        expectStatus(await riderAction(out.deliveryOrderId, "pickup", out.pickupCode ? { pickupCode: out.pickupCode } : {}, rider), 200, "pickup");
        break;
      }
      case "OUT_FOR_DELIVERY":
        out.deliveryOrderId ??= (await offerFor(orderId, rider, 5_000)).deliveryOrderId;
        expectStatus(await riderAction(out.deliveryOrderId, "start", {}, rider), 200, "start delivery");
        break;
      case "DELIVERED": {
        out.deliveryOrderId ??= (await offerFor(orderId, rider, 5_000)).deliveryOrderId;
        out.otp = await buyerCode(orderId, options.customer ?? "customer");
        const extra = options.cashCollected !== undefined ? { cashCollected: options.cashCollected } : {};
        expectStatus(await riderAction(out.deliveryOrderId, "deliver", { otp: out.otp, ...extra }, rider), 200, "deliver");
        break;
      }
      default:
        break;
    }
    if (options.onStep) await options.onStep(stage);
  }
  return out;
}

/**
 * The customer's current delivery code. Locally it is read from the e-mail
 * the start of the drop (or a resend) sent to the local mail catcher, so no
 * resend cooldown is spent; elsewhere a new code is asked for as the order
 * page does (flows.deliveryCode, which waits out the cooldown).
 */
export async function buyerCode(orderId: string, customer: Role = "customer"): Promise<string> {
  if (IS_LOCAL) {
    const email = world().users[customer]?.email;
    const number = (await orderRow(orderId, customer)).orderNumber;
    if (email) {
      for (let i = 0; i < 30; i++) {
        for (const m of messagesTo(email, 0)) {
          if (!m.body.includes(number)) continue;
          const code = m.body.match(new RegExp(`(\\d{4}) is your delivery code for order ${number}`))?.[1] ?? m.body.match(/Delivery code:\s*(\d{4})/)?.[1];
          if (code) return code;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  return deliveryCode(orderId, customer);
}

/** Places a simple order and drives it to `target`. */
export async function orderAt(target: Stage, options: { rider?: Role; quantity?: number } = {}) {
  const placed = await placeSimple({ quantity: options.quantity });
  const driven = await driveTo(placed.id, target, { rider: options.rider });
  return { ...placed, ...driven };
}

/* --------------------------------------------------------------- money */

export async function walletOf(role: Role = "customer"): Promise<number> {
  const res = await call(await as(role), "GET", "/api/wallet");
  expectStatus(res, 200, "GET /api/wallet");
  const value = res.body?.balancePaise ?? res.body?.wallet?.balancePaise;
  expect(typeof value, "wallet balance").toBe("number");
  return value as number;
}

/** Local only: credits a wallet the way a settled top-up does (balance and ledger agree). */
export async function topUp(role: Role, amountPaise: number) {
  if (!IS_LOCAL) return;
  const user = need(world().users[role], `${role} account`);
  await db()`
    with w as (select id, balance_paise from wallets where user_id = ${user.id!} for update)
    , upd as (update wallets set balance_paise = balance_paise + ${amountPaise}, updated_at = now() where id = (select id from w) returning id)
    insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description)
    select w.id, ${user.id!}, 'TOP_UP', ${amountPaise}, w.balance_paise, w.balance_paise + ${amountPaise}, ${`qa-topup-${RUN}-${randomUUID()}`}, 'QA top-up'
    from w`;
}

/** Local only: keeps the customer's wallet above `floor` so a long run never blocks on money. */
export async function ensureWallet(role: Role = "customer", floor = 200_000) {
  if (!IS_LOCAL) return;
  const balance = await walletOf(role);
  if (balance < floor) await topUp(role, floor - balance + 100_000);
}

/* ---------------------------------------------------------- notifications */

export interface Note {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
}

export async function notesFor(role: Role, needle: string | RegExp): Promise<Note[]> {
  const res = await call(await as(role), "GET", "/api/notifications");
  expectStatus(res, 200, "GET /api/notifications");
  const list = (res.body?.notifications ?? []) as Note[];
  return list.filter((n) => (typeof needle === "string" ? `${n.title} ${n.body}`.includes(needle) : needle.test(`${n.title} ${n.body}`)));
}

/* --------------------------------------------------------------- riders */

export function homeSpot() {
  return need(world().location, "the shop A location in this site's test data");
}

/** The rider goes online at a spot (the same request the dashboard sends from the phone's location). */
export async function riderOnline(role: Role, latitude: number, longitude: number) {
  assertWritable("put a rider online");
  return call(await as(role), "PATCH", "/api/delivery-partner/status", { action: "online", latitude, longitude });
}

export async function riderOffline(role: Role) {
  assertWritable("take a rider offline");
  return call(await as(role), "PATCH", "/api/delivery-partner/status", { action: "offline" });
}

/**
 * Local only: exactly these riders online, each at its offset from shop A
 * (degrees; 0.001 ≈ 110 m); every other rider in the database offline. Their
 * live deliveries are cancelled first (through operations), so none is busy.
 */
export async function ridersOnlyOnline(spots: Partial<Record<Role, { dLat: number; dLng: number }>>) {
  if (!IS_LOCAL) blocked("arranging which riders are online needs the local database");
  const home = homeSpot();
  const ids = Object.keys(spots).map((r) => need(world().users[r as Role], `${r} account`).id!);
  await releaseRiders();
  await db()`update delivery_partners set is_online = false where is_online and not (user_id = any(${ids}::uuid[]))`;
  for (const [role, spot] of Object.entries(spots) as [Role, { dLat: number; dLng: number }][]) {
    const userId = need(world().users[role], `${role} account`).id!;
    await db()`update delivery_partners set is_online = true, status = 'APPROVED',
      last_location_latitude = ${String(home.lat + spot.dLat)}, last_location_longitude = ${String(home.lng + spot.dLng)},
      last_location_at = now() where user_id = ${userId}`;
  }
}

/** Local only: no rider online at all. */
export async function noRiderOnline() {
  if (!IS_LOCAL) blocked("taking every rider offline needs the local database");
  await releaseRiders();
  await db()`update delivery_partners set is_online = false where is_online`;
}

/** Local only: cancels (through operations) every live delivery the world's riders hold, so none is busy. */
export async function releaseRiders() {
  if (!IS_LOCAL) return;
  const ids = (["rider", "rider2"] as Role[]).map((r) => world().users[r]?.id).filter(Boolean) as string[];
  const rows = await db()<{ order_id: string }[]>`
    select d.order_id from delivery_orders d join delivery_partners p on p.id = d.delivery_partner_id
    where p.user_id = any(${ids}::uuid[]) and d.status in ('OFFERED','ACCEPTED','PICKED_UP')`;
  for (const r of rows) await abandon(r.order_id);
  // Return pickups hold riders too.
  await db()`update return_pickups set status = 'CANCELLED', updated_at = now()
    where status in ('OFFERED','ACCEPTED','EN_ROUTE') and delivery_partner_id in (select id from delivery_partners where user_id = any(${ids}::uuid[]))`;
}

/** Local only: forget the riders' dispatch history (offers today, declines, failures) so ranking starts level. */
export async function levelRiderHistory() {
  if (!IS_LOCAL) return;
  const ids = (["rider", "rider2"] as Role[]).map((r) => world().users[r]?.id).filter(Boolean) as string[];
  await db()`update delivery_orders set offered_at = offered_at - interval '40 days', updated_at = updated_at - interval '40 days'
    where status not in ('OFFERED','ACCEPTED','PICKED_UP')
      and (delivery_partner_id in (select id from delivery_partners where user_id = any(${ids}::uuid[]))
        or rejected_partner_ids && (select array_agg(id) from delivery_partners where user_id = any(${ids}::uuid[])))`;
}

/**
 * Local only: which world rider holds the order's live offer/assignment
 * (read from the database, so a rider already busy with another job is seen
 * too). Waits up to `waitMs`; null when nobody does.
 */
export async function offeredTo(orderId: string, waitMs = 8_000): Promise<{ rider: Role | "other"; deliveryOrderId: string; status: string } | null> {
  if (!IS_LOCAL) blocked("reading who holds an offer needs the local database");
  const byUser = new Map((["rider", "rider2"] as Role[]).map((r) => [world().users[r]?.id, r]));
  return poll(
    async () => {
      const [row] = await db()<{ id: string; status: string; user_id: string }[]>`
        select d.id, d.status, p.user_id from delivery_orders d join delivery_partners p on p.id = d.delivery_partner_id
        where d.order_id = ${orderId} and d.status in ('OFFERED','ACCEPTED','PICKED_UP')`;
      return row ? { rider: byUser.get(row.user_id) ?? ("other" as const), deliveryOrderId: row.id, status: row.status } : null;
    },
    (v) => v !== null,
    waitMs,
    500,
  );
}

/** Local only: ages a live offer by `seconds` (as if the rider had let it sit that long). */
export async function ageOffer(orderId: string, seconds: number) {
  if (!IS_LOCAL) blocked("aging an offer needs the local database");
  await db()`update delivery_orders set offered_at = offered_at - make_interval(secs => ${seconds}) where order_id = ${orderId} and status = 'OFFERED'`;
}

/** Local only: moves an order's rider search back in time (next try due now, or the search older). */
export async function ageSearch(orderId: string, options: { nextAttemptDue?: boolean; lastAttemptSeconds?: number; startedMinutes?: number } = {}) {
  if (!IS_LOCAL) blocked("aging a rider search needs the local database");
  if (options.nextAttemptDue) await db()`update rider_searches set next_attempt_at = now() - interval '1 second' where order_id = ${orderId}`;
  if (options.lastAttemptSeconds) await db()`update rider_searches set last_attempt_at = last_attempt_at - make_interval(secs => ${options.lastAttemptSeconds}) where order_id = ${orderId}`;
  if (options.startedMinutes) await db()`update rider_searches set started_at = started_at - make_interval(mins => ${options.startedMinutes}) where order_id = ${orderId}`;
}

/** The rider search of an order as the shop's screen reads it. */
export async function searchOf(orderId: string, role: Role = "shop") {
  const res = await call(await as(role), "GET", `/api/orders/${orderId}/assign`);
  expectStatus(res, 200, "rider search status");
  return res.body as { state: string; attempts: number; maxAttempts: number; nextAttemptAt: string | null; stopReason: string | null; message: string; canRetry: boolean; log: { attemptNo: number; outcome: string; createdAt: string; detail: string | null }[] };
}

/**
 * Local only: a second (non-default) address for the customer, `dLat`/`dLng`
 * degrees from shop A, optionally inside a society; returns its id.
 */
export async function extraAddress(role: Role, spot: { dLat: number; dLng: number }, line1: string, societyId: string | null = null) {
  if (!IS_LOCAL) blocked("adding an address directly needs the local database");
  const user = need(world().users[role], `${role} account`);
  const home = homeSpot();
  const [row] = await db()<{ id: string }[]>`
    insert into addresses (user_id, line1, area, city, state, pincode, latitude, longitude, address_type, recipient_name, is_default, location_verified, location_verified_at, location_source, society_id)
    values (${user.id!}, ${line1}, 'Kothrud', 'Pune', 'Maharashtra', ${home.pincode}, ${String(home.lat + spot.dLat)}, ${String(home.lng + spot.dLng)}, 'HOME', 'QA Recipient', false, true, now(), 'qa_seed', ${societyId})
    returning id`;
  return row.id;
}

/** Local only: the customer is an active resident of the world's verified society. */
export async function joinSociety(role: Role = "customer") {
  if (!IS_LOCAL) blocked("society membership is arranged in the local database");
  const society = need(world().society, "the world's society");
  const user = need(world().users[role], `${role} account`);
  await db()`insert into society_members (society_id, user_id, role, status, approved_at)
    select ${society.id}, ${user.id!}, 'RESIDENT', 'ACTIVE', now()
    where not exists (select 1 from society_members where society_id = ${society.id} and user_id = ${user.id!})`;
  await db()`update society_members set status = 'ACTIVE' where society_id = ${society.id} and user_id = ${user.id!}`;
  return society.id;
}

/**
 * Local only: the seed gives every rider the same partner mobile
 * (9876543210), so a society cannot list one of them by number; give each
 * world rider its own (its account's phone).
 */
export async function distinctRiderMobiles() {
  if (!IS_LOCAL) return;
  for (const r of ["rider", "rider2"] as Role[]) {
    const id = world().users[r]?.id;
    if (id) await db()`update delivery_partners p set mobile = u.phone from users u where u.id = p.user_id and p.user_id = ${id} and u.phone is not null`;
  }
}

export async function riderMobile(role: Role): Promise<string> {
  const res = await call(await as(role), "GET", "/api/delivery-partner/me");
  expectStatus(res, 200, `${role} rider profile`);
  return String(res.body?.mobile ?? "");
}

export async function partnerIdOf(role: Role): Promise<string> {
  const res = await call(await as(role), "GET", "/api/delivery-partner/me");
  expectStatus(res, 200, `${role} rider profile`);
  return String(res.body?.id);
}

/** The rider's current active delivery (or null), from the rider's own API. */
export async function activeDelivery(role: Role) {
  const res = await call(await as(role), "GET", "/api/delivery-partner/deliveries");
  expectStatus(res, 200, "GET /api/delivery-partner/deliveries");
  return res.body?.active as { id: string; orderId: string; status: string } | null;
}

/** Waits briefly for the order's offer to land on one of `riders`; returns who got it (or null). */
export async function whoIsOffered(orderId: string, riders: Role[], waitMs = 10_000): Promise<{ rider: Role; deliveryOrderId: string } | null> {
  return poll(
    async () => {
      for (const r of riders) {
        const a = await activeDelivery(r);
        if (a && a.orderId === orderId) return { rider: r, deliveryOrderId: a.id };
      }
      return null;
    },
    (v) => v !== null,
    waitMs,
    1000,
  );
}

/* ----------------------------------------------------------------- rules */

/** Admin overrides a business rule; the returned function restores what was there before. */
export async function withRule(key: string, value: Record<string, unknown>): Promise<() => Promise<void>> {
  assertWritable("change a business rule");
  const admin = await as("admin");
  const before = await call(admin, "GET", "/api/admin/settings");
  expectStatus(before, 200, "GET /api/admin/settings");
  const rule = (before.body?.rules ?? []).find((r: { key: string }) => r.key === key) as { overridden: boolean; value: Record<string, unknown> } | undefined;
  expect(rule, `rule ${key} exists`).toBeTruthy();
  const res = await call(admin, "PUT", "/api/admin/settings", { key, value });
  expectStatus(res, 200, `set rule ${key}`);
  return async () => {
    if (rule!.overridden) await call(admin, "PUT", "/api/admin/settings", { key, value: rule!.value });
    else await call(admin, "DELETE", `/api/admin/settings?key=${encodeURIComponent(key)}`);
  };
}

/** The shop owner changes shop A's settings; the returned function puts the old values back. */
export async function withShopSettings(patch: Record<string, unknown>, shopKey: "A" | "B" = "A", role: Role = shopKey === "A" ? "shop" : "shopB") {
  assertWritable("change shop settings");
  const shop = await shopOf(shopKey);
  const owner = await as(role);
  const current = await call(owner, "PATCH", `/api/shops/${shop.id}`, {});
  expectStatus(current, 200, "read the shop's settings");
  const previous = Object.fromEntries(Object.keys(patch).map((k) => [k, current.body?.[k] ?? null]));
  const res = await call(owner, "PATCH", `/api/shops/${shop.id}`, patch);
  expectStatus(res, 200, `update shop ${shopKey}`);
  return async () => {
    await call(owner, "PATCH", `/api/shops/${shop.id}`, previous);
  };
}

/* ------------------------------------------------------------------ cron */

/** Local only: runs a scheduler endpoint with the local CRON_SECRET. */
export async function cron(path: string): Promise<Answer> {
  if (!IS_LOCAL) blocked("running a cron job needs the local CRON_SECRET");
  const secret = process.env.CRON_SECRET;
  if (!secret) blocked("CRON_SECRET (the local server's) is not set");
  const guest = await anonymous();
  try {
    return await call(guest, "POST", path, {}, { headers: { authorization: `Bearer ${secret}` } });
  } finally {
    await guest.dispose();
  }
}

/* ----------------------------------------------------------------- files */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A real (valid) RGB PNG of the given size, with a little noise so each one differs. */
export function png(width = 160, height = 160): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const seed = Math.floor(Math.random() * 255);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = (x + seed) & 0xff;
      raw[o + 1] = (y * 2) & 0xff;
      raw[o + 2] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A tiny PDF, for "a PDF renamed .jpg" checks. */
export const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");

/** Multipart upload of one file field (plus extra text fields). */
export async function upload(ctx: APIRequestContext, path: string, file: { name: string; mimeType: string; buffer: Buffer }, fields: Record<string, string> = {}) {
  assertWritable("upload a file");
  return call(ctx, "POST", path, undefined, { multipart: { ...fields, file } as never });
}

/** Uploads a return-evidence photo as `role`; returns the image id. */
export async function evidencePhoto(role: Role = "customer"): Promise<string> {
  const res = await upload(await as(role), "/api/images", { name: "evidence.png", mimeType: "image/png", buffer: png() }, { purpose: "RETURN_EVIDENCE" });
  expectStatus(res, 201, "upload a return photo");
  return String(res.body.id);
}

/* ------------------------------------------------- fresh accounts (local) */

const SECURE = BASE_URL.startsWith("https");
const COOKIE = SECURE ? "__Secure-authjs.session-token" : "authjs.session-token";

export interface FreshUser {
  id: string;
  email: string;
  mobile: string;
  ctx: APIRequestContext;
  storage: { cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Lax" }[]; origins: never[] };
}

let freshSeq = 0;

/**
 * Local only: a new customer account (profile complete, terms accepted), as
 * the seed creates the world's, with a session minted from the local
 * AUTH_SECRET exactly like actors.ts does.
 */
export async function freshCustomer(label: string): Promise<FreshUser> {
  if (!IS_LOCAL) blocked("creating a new account needs the local database");
  const secret = process.env.AUTH_SECRET;
  if (!secret) blocked("AUTH_SECRET (the local server's) is not set");
  freshSeq += 1;
  const email = `qa-${label}-${RUN}-${freshSeq}@test.local`.toLowerCase();
  const mobile = `7${String(Date.now() % 1e6).padStart(6, "0")}${String(freshSeq).padStart(3, "0")}`;
  const [row] = await db()<{ id: string }[]>`
    insert into users (email, name, role, phone, phone_e164, email_verified, phone_verified_at, profile_completed_at)
    values (${email}, ${`QA ${label}`}, 'CUSTOMER', ${mobile}, ${`+91${mobile}`}, now(), now(), now()) returning id`;
  await db()`insert into user_consents (user_id, consent_type, version, granted) values (${row.id}, 'TERMS_AND_PRIVACY', '2026-08-21', true)`;
  const value = await encode({ token: { sub: row.id, email, name: label }, secret, salt: COOKIE });
  const url = new URL(BASE_URL);
  const storage = {
    cookies: [{ name: COOKIE, value, domain: url.hostname, path: "/", expires: -1, httpOnly: true, secure: SECURE, sameSite: "Lax" as const }],
    origins: [] as never[],
  };
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: storage, timeout: 60_000 });
  return { id: row.id, email, mobile, ctx, storage };
}

export async function freshPage(browser: Browser, user: FreshUser, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...options, baseURL: BASE_URL, storageState: user.storage });
  return { context, page: await context.newPage() };
}

/** A fresh applicant who has registered as a rider (REGISTERED), optionally approved by an operator. */
export async function freshRider(label: string, options: { approve?: boolean; extra?: Record<string, unknown> } = {}) {
  const user = await freshCustomer(label);
  const res = await call(user.ctx, "POST", "/api/delivery-partner", {
    fullName: `QA ${label}`,
    mobile: user.mobile,
    vehicleType: "MOTORCYCLE",
    vehicleRegistrationNumber: "MH12AB1234",
    latitude: homeSpot().lat,
    longitude: homeSpot().lng,
    operatingRadiusKm: 10,
    ...options.extra,
  });
  expectStatus(res, 201, "rider application");
  const partnerId = String(res.body.id);
  if (options.approve) expectStatus(await call(await as("ops"), "PATCH", `/api/delivery-partner/${partnerId}`, { action: "approve" }), 200, "approve the rider");
  return { ...user, partnerId };
}

/** A fresh user's API session again, from its saved session cookie (e.g. kept across a worker restart). */
export async function freshAgain<T extends Omit<FreshUser, "ctx">>(user: T): Promise<T & { ctx: APIRequestContext }> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: user.storage, timeout: 60_000 });
  return { ...user, ctx };
}

/* -------------------------------------------------------------------- UI */

/** Signed-in page as `role` (close the context when done). */
export { pageAs };

/** The customer's order card on /orders (the right tab). */
export async function customerCard(page: Page, orderNumber: string, tab: "active" | "past" = "active") {
  await page.goto(`/orders?tab=${tab}`);
  const card = page.getByTestId("order-card").filter({ hasText: orderNumber }).first();
  await expect(card, `order ${orderNumber} on /orders?tab=${tab}`).toBeVisible();
  return card;
}

/** The shop's order card on /shop/orders in a tab (newest first). */
export async function shopCard(page: Page, orderNumber: string, tab: "new" | "packing" | "ready" | "out" | "done" | "all" = "all") {
  await page.goto(`/shop/orders?status=${tab}`);
  const card = page.getByTestId("shop-order").filter({ hasText: orderNumber }).first();
  await expect(card, `order ${orderNumber} on /shop/orders?status=${tab}`).toBeVisible();
  return card;
}

/** Long text helpers for the field-level cases. */
export const TEXT = {
  script: "<script>alert(1)</script> & \"quotes\" 'x' %$#",
  marathi: "दुकान आज बंद आहे — माल उपलब्ध नाही",
  hindi: "आज दुकान बंद है",
  long: (n: number) => "x".repeat(n),
};

/* --------------------------------------------------------------- answers */

/** True when the answer is a validation refusal (422) that names the field. */
export function refusedField(res: Answer, field?: string) {
  if (res.status !== 422) return false;
  if (!field) return true;
  return JSON.stringify(res.body ?? {}).includes(field);
}

export { anonymous, call, expectStatus, poll, why, type Answer };
export { deliveryCode, fulfil, offerFor, pickupCode, riderAction };
