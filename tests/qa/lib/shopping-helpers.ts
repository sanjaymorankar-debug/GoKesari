/**
 * Helpers for the shopping package (location & addresses, discovery, cart &
 * checkout): business rules and shop settings changed and restored,
 * addresses at a set distance from shop A, a rate-limit-aware checkout,
 * browser pages with their own cookie jar, and the cart page's pay flow with
 * its prompts.
 *
 * Works around two things in the shared lib without changing it:
 *   - as(role) caches one context per role for the whole worker, so a
 *     POST /api/location through it would change discovery for every later
 *     check; the specs set a location only in browser contexts of their own
 *     (signedPage / browser.newContext), never through as(role).
 *   - flows.placeOrder() empties the cart and always sends
 *     acknowledgeClosedShopIds; checkoutAs() here sends exactly the body the
 *     case needs and waits out the 15-a-minute checkout limit.
 */
import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { as, storageFor } from "./actors";
import { db } from "./db";
import { shopListings } from "./flows";
import { call, expectStatus, RUN, why, type Answer } from "./http";
import { blocked, need } from "./record";
import { assertWritable, BASE_URL } from "./target";
import { world, type Role, type WorldListing } from "./world";

export const SIGNED = { tier: "signed" as const, timeout: 240_000 };
export const LOCAL = { tier: "local" as const, timeout: 240_000 };

/* ---------------------------------------------------------------- world */

export function listing(key: Parameters<typeof needListing>[0]): WorldListing {
  return needListing(key);
}

function needListing(key: "packaged" | "milk" | "loose" | "unpricedLoose" | "offlineOnly" | "sharedA" | "sharedB" | "lowStock" | "premium"): WorldListing {
  return need(world().listings[key], `the "${key}" listing of the test data`);
}

export function shopId(key: "A" | "B" | "C" | "pending" = "A"): string {
  const shop = need(world().shops[key], `shop ${key} in this site's test data`);
  return need(shop.id, `the id of shop ${key} (local test data)`);
}

export function shopName(key: "A" | "B" | "C" | "pending" = "A"): string {
  return need(world().shops[key], `shop ${key}`).name;
}

export function shopSlug(key: "A" | "B" | "C" | "pending" = "A"): string {
  return need(need(world().shops[key], `shop ${key}`).slug, `the slug of shop ${key}`);
}

export const OWNER: Record<"A" | "B" | "C", Role> = { A: "shop", B: "shopB", C: "shopC" };

/** Shop A's position (the world's location). */
export function home() {
  return need(world().location, "the test data's location (shop A's coordinates)");
}

/** Haversine km per degree of latitude (R = 6371 km). */
export const KM_PER_DEG_LAT = (Math.PI * 6371) / 180;

/** A point `km` due north of shop A (straight-line distance exactly `km`). */
export function pointNorth(km: number) {
  const h = home();
  return { latitude: Number((h.lat + km / KM_PER_DEG_LAT).toFixed(6)), longitude: h.lng };
}

/* ---------------------------------------------------------------- rules */

interface RuleRow {
  key: string;
  value: Record<string, unknown>;
  overridden: boolean;
}

async function rulesNow(): Promise<RuleRow[]> {
  const res = await call(await as("admin"), "GET", "/api/admin/settings");
  expectStatus(res, 200, "GET /api/admin/settings");
  return res.body.rules as RuleRow[];
}

/** Sets business rules (admin), runs `fn`, and restores each rule as it was. */
export async function withRules<T>(changes: Record<string, Record<string, unknown>>, fn: () => Promise<T>): Promise<T> {
  assertWritable("change business rules");
  const before = await rulesNow();
  const admin = await as("admin");
  try {
    for (const [key, value] of Object.entries(changes)) {
      const current = before.find((r) => r.key === key);
      if (!current) throw new Error(`no business rule "${key}"`);
      const res = await call(admin, "PUT", "/api/admin/settings", { key, value: { ...current.value, ...value } });
      expectStatus(res, 200, `set rule ${key}`);
    }
    return await fn();
  } finally {
    for (const key of Object.keys(changes)) {
      const was = before.find((r) => r.key === key)!;
      const res = was.overridden
        ? await call(admin, "PUT", "/api/admin/settings", { key, value: was.value })
        : await call(admin, "DELETE", `/api/admin/settings?key=${encodeURIComponent(key)}`);
      if (res.status !== 200) console.error(`[shopping-helpers] could not restore rule ${key}: ${why(res)}`);
    }
  }
}

/* ---------------------------------------------------------- shop settings */

export const SHOP_FIELDS = [
  "serviceRadiusKm",
  "deliveryPincodes",
  "minOrderPaise",
  "ordersPaused",
  "deliveryAvailable",
  "deliveryFeePaise",
  "freeDeliveryAbovePaise",
  "openingHours",
  "codEnabled",
] as const;
type ShopField = (typeof SHOP_FIELDS)[number];
export type ShopPatch = Partial<Record<ShopField, unknown>>;

/** The owner's view of the shop (GET /api/shops/:id). */
export async function shopAsOwner(key: "A" | "B" | "C" = "A") {
  const res = await call(await as(OWNER[key]), "GET", `/api/shops/${shopId(key)}`);
  expectStatus(res, 200, `GET shop ${key} as its owner`);
  return res.body as Record<string, unknown> & { serviceRadiusKm: number; deliveryPincodes: string[]; minOrderPaise: number; ordersPaused: boolean; deliveryAvailable: boolean; openingHours: unknown[] };
}

export async function patchShop(key: "A" | "B" | "C", patch: ShopPatch): Promise<Answer> {
  assertWritable("change a shop's settings");
  return call(await as(OWNER[key]), "PATCH", `/api/shops/${shopId(key)}`, patch);
}

/** Changes shop settings as the owner, runs `fn`, and puts the changed fields back. */
export async function withShop<T>(key: "A" | "B" | "C", patch: ShopPatch, fn: () => Promise<T>): Promise<T> {
  const before = await shopAsOwner(key);
  const restore: ShopPatch = {};
  for (const field of Object.keys(patch) as ShopField[]) restore[field] = before[field] ?? null;
  const res = await patchShop(key, patch);
  expectStatus(res, 200, `shop ${key} settings ${JSON.stringify(patch).slice(0, 120)}`);
  try {
    return await fn();
  } finally {
    const back = await patchShop(key, restore);
    if (back.status !== 200) console.error(`[shopping-helpers] could not restore shop ${key}: ${why(back)}`);
  }
}

/** Opening hours (IST) that make a shop closed right now: today closed, every other day open. */
export function hoursClosedNow(now = new Date()) {
  const istDay = new Date(now.getTime() + 330 * 60_000).getUTCDay();
  return [0, 1, 2, 3, 4, 5, 6].map((day) => (day === istDay ? { day, open: "00:00", close: "00:01", closed: true } : { day, open: "06:00", close: "22:00" }));
}

/** IST weekday and minutes now. */
export function istNow(now = new Date()) {
  const shifted = new Date(now.getTime() + 330 * 60_000);
  return { day: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

export const hhmm = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/* ------------------------------------------------------- listing updates */

export async function patchListing(owner: Role, shopProductId: string, patch: Record<string, unknown>): Promise<Answer> {
  assertWritable("change a listing");
  return call(await as(owner), "PATCH", `/api/shop-products/${shopProductId}`, patch);
}

/** Changes a listing as its shop's owner, runs `fn`, restores the changed fields from the storefront view. */
export async function withListing<T>(owner: Role, shopKey: "A" | "B", item: WorldListing, patch: Record<string, unknown>, restore: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  void shopKey;
  const res = await patchListing(owner, item.shopProductId, patch);
  expectStatus(res, 200, `listing ${item.name} ${JSON.stringify(patch)}`);
  try {
    return await fn();
  } finally {
    const back = await patchListing(owner, item.shopProductId, restore);
    if (back.status !== 200) console.error(`[shopping-helpers] could not restore listing ${item.name}: ${why(back)}`);
  }
}

/* -------------------------------------------------------------- addresses */

export interface AddressInput {
  line1: string;
  city: string;
  pincode: string;
  line2?: string | null;
  area?: string | null;
  state?: string | null;
  label?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  addressType?: "HOME" | "WORK" | "OTHER";
  landmark?: string | null;
  deliveryInstructions?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isDefault?: boolean;
}

export interface SavedAddress extends Required<Pick<AddressInput, "line1" | "city" | "pincode">> {
  id: string;
  isDefault: boolean;
  line2: string | null;
  area: string | null;
  state: string | null;
  label: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  addressType: string;
  landmark: string | null;
  deliveryInstructions: string | null;
  latitude: string | null;
  longitude: string | null;
  locationVerifiedAt: string | null;
  societyId: string | null;
}

/** A valid address body near shop A (overridable). */
export function addressBody(extra: Partial<AddressInput> = {}): AddressInput {
  const h = home();
  return {
    line1: `QA ${RUN} Lane ${randomUUID().slice(0, 4)}`,
    area: "Kothrud",
    city: "Pune",
    state: "Maharashtra",
    pincode: h.pincode,
    latitude: h.lat + 0.005,
    longitude: h.lng,
    addressType: "OTHER",
    ...extra,
  };
}

export async function postAddress(role: Role, body: unknown): Promise<Answer> {
  assertWritable("save an address");
  return call(await as(role), "POST", "/api/addresses", body);
}

export async function createAddress(role: Role, extra: Partial<AddressInput> = {}): Promise<SavedAddress> {
  const res = await postAddress(role, addressBody(extra));
  expectStatus(res, 201, "create an address");
  return res.body as SavedAddress;
}

export async function listAddresses(role: Role): Promise<SavedAddress[]> {
  const res = await call(await as(role), "GET", "/api/addresses");
  expectStatus(res, 200, "GET /api/addresses");
  return res.body.addresses as SavedAddress[];
}

export async function removeAddress(role: Role, id: string) {
  const res = await call(await as(role), "DELETE", `/api/addresses/${id}`);
  if (![204, 404].includes(res.status)) console.error(`[shopping-helpers] could not delete address ${id}: ${why(res)}`);
}

/** Creates addresses, runs `fn`, deletes them again and puts the default flag back on the address that had it. */
export async function withAddresses<T>(role: Role, list: Partial<AddressInput>[], fn: (saved: SavedAddress[]) => Promise<T>): Promise<T> {
  const before = await listAddresses(role);
  const saved: SavedAddress[] = [];
  try {
    for (const extra of list) saved.push(await createAddress(role, extra));
    return await fn(saved);
  } finally {
    for (const a of saved) await removeAddress(role, a.id);
    const wasDefault = before.find((a) => a.isDefault);
    const now = await listAddresses(role);
    const current = now.find((a) => a.id === wasDefault?.id);
    if (wasDefault && current && !current.isDefault) await setDefault(role, current);
  }
}

/** PATCH the same fields back with isDefault true. */
export async function setDefault(role: Role, a: SavedAddress): Promise<Answer> {
  return call(await as(role), "PATCH", `/api/addresses/${a.id}`, {
    ...addressFields(a),
    isDefault: true,
  });
}

/** The editable fields of a saved address, as the PATCH body takes them. */
export function addressFields(a: SavedAddress): AddressInput {
  return {
    label: a.label,
    recipientName: a.recipientName,
    recipientPhone: a.recipientPhone,
    addressType: a.addressType as AddressInput["addressType"],
    line1: a.line1,
    line2: a.line2,
    area: a.area,
    city: a.city,
    state: a.state,
    pincode: a.pincode,
    landmark: a.landmark,
    deliveryInstructions: a.deliveryInstructions,
    latitude: a.latitude != null ? Number(a.latitude) : null,
    longitude: a.longitude != null ? Number(a.longitude) : null,
  };
}

/* ------------------------------------------------------------------ cart */

export interface CartLineView {
  cartItemId: string;
  shopProductId: string;
  productName: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  purchasable: boolean;
  unavailableReason: string | null;
}

export interface CartGroupView {
  shop: { id: string; name: string; slug: string; deliveryFeePaise: number };
  lines: CartLineView[];
  subtotalPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
}

export interface CartView {
  groups: CartGroupView[];
  itemCount: number;
  subtotalPaise: number;
  deliveryFeePaise: number;
  grandTotalPaise: number;
  hasUnavailableItems: boolean;
}

export async function cartOf(role: Role = "customer"): Promise<CartView> {
  const res = await call(await as(role), "GET", "/api/cart");
  expectStatus(res, 200, "GET /api/cart");
  return res.body as CartView;
}

export async function clearCart(role: Role = "customer") {
  assertWritable("empty a cart");
  expectStatus(await call(await as(role), "DELETE", "/api/cart"), [200, 204], "empty the cart");
}

export async function add(role: Role, shopProductId: string, quantity: number): Promise<Answer> {
  assertWritable("add to a cart");
  return call(await as(role), "POST", "/api/cart", { shopProductId, quantity });
}

/** Empties the cart and adds the given lines (each expected to succeed). */
export async function fillCart(role: Role, lines: { item: WorldListing | { shopProductId: string; name: string }; quantity: number }[]) {
  await clearCart(role);
  for (const { item, quantity } of lines) {
    const res = await add(role, item.shopProductId, quantity);
    if (res.status === 409) blocked(`"${item.name}" cannot be added — ${why(res)}`);
    expectStatus(res, 200, `add ${quantity} × ${item.name}`);
  }
  return cartOf(role);
}

export interface ShopCheck {
  shopId: string;
  shopName: string;
  eligible: boolean;
  distanceKm: number | null;
  deliveryFeePaise: number;
  minOrderPaise: number;
  shortfallPaise: number;
  issues: { code: string; blocking: boolean; message: string; action: string }[];
}

export async function validateCart(role: Role, addressId?: string, ctx?: APIRequestContext): Promise<{ ok: boolean; shops: ShopCheck[] }> {
  const res = await call(ctx ?? (await as(role)), "GET", `/api/cart/validate${addressId ? `?addressId=${addressId}` : ""}`);
  expectStatus(res, 200, "GET /api/cart/validate");
  return res.body;
}

/* -------------------------------------------------------------- checkout */

const checkoutTimes = new Map<string, number[]>();

/**
 * POST /api/checkout with exactly `body` (a request id is added when absent).
 * Stays under the 15-a-minute limit per user and, on a 429, waits it out once.
 */
export async function checkoutAs(role: Role, body: Record<string, unknown>, ctx?: APIRequestContext): Promise<Answer> {
  assertWritable("check out");
  const times = (checkoutTimes.get(role) ?? []).filter((t) => Date.now() - t < 61_000);
  if (times.length >= 13) {
    const wait = 61_000 - (Date.now() - times[0]);
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
  const payload = { requestId: `qa-${RUN}-${randomUUID().slice(0, 12)}`, ...body };
  const send = async () => {
    const list = (checkoutTimes.get(role) ?? []).filter((t) => Date.now() - t < 61_000);
    list.push(Date.now());
    checkoutTimes.set(role, list);
    return call(ctx ?? (await as(role)), "POST", "/api/checkout", payload);
  };
  let res = await send();
  if (res.status === 429) {
    const seconds = Number(res.body?.error?.details?.retryAfterSeconds ?? 60);
    await new Promise((r) => setTimeout(r, Math.min(seconds, 65) * 1000 + 1000));
    res = await send();
  }
  return res;
}

/** The address id checkout should use for `role` (the world's default address). */
export async function homeAddressId(role: Role = "customer"): Promise<string> {
  const known = world().addresses?.[role];
  if (known) return known;
  const list = await listAddresses(role);
  const found = list.find((a) => a.isDefault) ?? list[0];
  if (!found) blocked(`the ${role} account has no saved address`);
  return found.id;
}

export interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalPaise: number;
  subtotalPaise?: number;
  deliveryFeePaise?: number;
  discountPaise?: number;
  couponCode?: string | null;
  notes?: string | null;
  shopId?: string;
  orderGroupId?: string | null;
  scheduledSlotStart?: string | null;
  deliveryWindow?: string | null;
  items?: { productNameSnapshot: string; quantityMilli: number; unitPricePaise: number; lineTotalPaise: number; id: string }[];
}

export async function ordersOf(role: Role = "customer"): Promise<OrderRow[]> {
  const res = await call(await as(role), "GET", "/api/orders");
  expectStatus(res, 200, "GET /api/orders");
  return (Array.isArray(res.body) ? res.body : (res.body?.orders ?? [])) as OrderRow[];
}

export async function orderOf(role: Role, id: string): Promise<OrderRow | undefined> {
  return (await ordersOf(role)).find((o) => o.id === id);
}

/** Cancels the customer's own CONFIRMED order (full refund); quiet when it can no longer be cancelled. */
export async function cancelOwn(role: Role, orderId: string) {
  const res = await call(await as(role), "PATCH", `/api/orders/${orderId}/status`, { status: "CANCELLED", note: "QA clean-up" });
  return res;
}

/** The shop cancels an order of its own shop (any open status). */
export async function cancelAsShop(owner: Role, orderId: string) {
  return call(await as(owner), "PATCH", `/api/orders/${orderId}/status`, { status: "CANCELLED", note: "QA clean-up" });
}

export async function walletOf(role: Role = "customer"): Promise<number> {
  const res = await call(await as(role), "GET", "/api/wallet");
  expectStatus(res, 200, "GET /api/wallet");
  return (res.body?.balancePaise ?? res.body?.wallet?.balancePaise) as number;
}

/** Storefront row of one listing (public products API of its shop). */
export async function storefrontRow(shopKey: "A" | "B", shopProductId: string) {
  return (await shopListings(shopId(shopKey))).find((r) => r.shopProductId === shopProductId) ?? null;
}

/* ------------------------------------------------------- a second buyer */

/**
 * Local only: customer 2 with a mobile number (database) and an address next
 * to shop A, for checks that need two customers who can both check out;
 * both are removed again afterwards.
 */
export async function withSecondBuyer<T>(fn: (addressId: string) => Promise<T>): Promise<T> {
  const user = need(world().users.customer2, "customer 2");
  const phone = `+9177${String(Date.now()).slice(-8)}`;
  await db()`update users set phone = ${phone.slice(3)}, phone_e164 = ${phone} where id = ${user.id!}`;
  const address = await createAddress("customer2", { line1: `QA buyer 2 ${RUN}` });
  try {
    return await fn(address.id);
  } finally {
    await removeAddress("customer2", address.id);
    await db()`update users set phone = null, phone_e164 = null where id = ${user.id!}`;
    await clearCart("customer2");
  }
}

/* -------------------------------------------------------------- the page */

export async function signedPage(browser: Browser, role: Role, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext({ ...options, baseURL: BASE_URL, storageState: await storageFor(role) });
  const page = await context.newPage();
  return { context, page };
}

/** Errors in the page (uncaught) and React hydration complaints. */
export function watchPage(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && /#418|#423|#425|hydrat/i.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  return errors;
}

/** Opens a page and fails on an error page or a 5xx. */
export async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(res?.status() ?? 0, `${path} answered ${res?.status()}`).toBeLessThan(500);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await expect(page.locator("body"), `${path} shows an error page`).not.toContainText(/Something went wrong|Application error|Internal Server Error/i);
  return res;
}

/**
 * Presses the cart's pay button and answers the prompts in front of it: the
 * open-order notice ("Ignore and continue") and, when `closed` says so, the
 * closed-shop question. Returns the page's error text or null.
 */
export async function payOnCartPage(page: Page, closed: "yes" | "no" | "none" = "none") {
  await page.getByRole("button", { name: /Pay from wallet|Place order/ }).click();
  const ignore = page.getByRole("button", { name: "Ignore and continue" });
  const closedYes = page.getByRole("button", { name: "Yes, continue" });
  await expect(ignore.or(closedYes).or(page.locator("text=/Placing order/")).first()).toBeVisible({ timeout: 10_000 }).catch(() => {});
  if (await ignore.isVisible().catch(() => false)) await ignore.click();
  if (closed !== "none") {
    await expect(closedYes).toBeVisible();
    await page.getByRole("button", { name: closed === "yes" ? "Yes, continue" : "No, go back" }).click();
  }
}

/** A cart line's row on /cart. */
export function cartLine(page: Page, productName: string) {
  return page.locator("li").filter({ hasText: productName }).first();
}

/** The shop group card on /cart (by shop name). */
export function cartGroup(page: Page, shop: string) {
  return page.locator("div.overflow-hidden").filter({ has: page.getByRole("link", { name: shop, exact: true }) }).first();
}

/** A paise amount exactly as <Money> renders it ("₹58", "₹1,234.50"). */
export function rupees(paise: number) {
  const whole = paise % 100 === 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(paise / 100);
}

export type { Answer };
