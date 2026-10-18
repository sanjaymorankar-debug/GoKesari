/**
 * Batch 2026-10 — SIGNED-IN journeys on the TEST site (test.gokesari.com),
 * run after the batch is deployed there. API-first: each role is a Playwright
 * request context on a saved session (storage state); a browser page is used
 * only where the product itself needs one (the sandbox payment page's button).
 *
 * THIS SPEC CREATES ORDERS, PAYMENTS (sandbox), REFUNDS, TICKETS, A BROADCAST
 * and a push token — it refuses to run against gokesari.com. It uses the E2E
 * test shop only, one unit at a time, and leaves what it creates as test data.
 *
 *   E2E_BASE_URL=https://test.gokesari.com CHROMIUM_PATH=/opt/pw-browsers/chromium \
 *     npx playwright test tests/e2e/batch-2026-10-signed-in.spec.ts --project=chromium
 *
 * Sessions (never print them): $E2E_AUTH_DIR/$E2E_AUTH_PREFIX-<role>.json,
 * default .e2e-auth/staging-{customer,shop,rider,admin,ops,oplim}.json.
 * Options: E2E_SHOP_NAME (default "E2E Four Features Bakery"),
 * E2E_BROADCAST_MAX_AUDIENCE (default 10 — a broadcast to more people is not
 * sent), E2E_RIDER_WAIT_SECONDS (default 45), E2E_CLOSE_PAYOUT_CYCLE=1 (also
 * POST /api/admin/payouts/cycles — closes the last complete cycle).
 *
 * Results: test-results/batch-2026-10-signed-in-<host>.json
 *   { baseUrl, at, rows: [{ id, step, title, status: pass|fail|blocked, detail }] }
 * A case whose precondition is missing (no stock, no rider online, …) is
 * recorded "blocked" (and shown as skipped) instead of failing the run. Cases
 * share their data through a state file, so a failure never loses what the
 * earlier cases created and never stops the later ones.
 */
import { chromium, expect, request as playwrightRequest, test, type APIRequestContext, type Browser } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import jsQR from "jsqr";
import sharp from "sharp";

const BASE_URL = process.env.E2E_BASE_URL ?? "https://test.gokesari.com";
const HOST = new URL(BASE_URL).host;
const HOSTNAME = new URL(BASE_URL).hostname;
const IS_PROD = HOSTNAME === "gokesari.com" || HOSTNAME === "www.gokesari.com";
const AUTH_DIR = process.env.E2E_AUTH_DIR ?? ".e2e-auth";
const AUTH_PREFIX = process.env.E2E_AUTH_PREFIX ?? "staging";
const SHOP_NAME = process.env.E2E_SHOP_NAME ?? "E2E Four Features Bakery";
const MAX_AUDIENCE = Number(process.env.E2E_BROADCAST_MAX_AUDIENCE ?? 10);
const RIDER_WAIT_MS = Number(process.env.E2E_RIDER_WAIT_SECONDS ?? 45) * 1000;
const CLOSE_PAYOUT_CYCLE = process.env.E2E_CLOSE_PAYOUT_CYCLE === "1";
/** Checkout took 30–38 s on test (D-27, 14 Oct run). */
const SLOW_MS = 120_000;

const OUT_DIR = "test-results";
const RESULT_FILE = join(OUT_DIR, `batch-2026-10-signed-in-${HOST}.json`);
const STATE_FILE = join(OUT_DIR, `.batch-2026-10-signed-in-state-${HOST}.json`);

type Step =
  | "F1.1.2"
  | "F1.7.3/F1.8.4"
  | "F3.3.2"
  | "F4.1.3"
  | "F4.2.2"
  | "F6.1.3"
  | "F6.2.3"
  | "F6.3.3"
  | "F8.4.2"
  | "F9.1.2"
  | "F9.1.4"
  | "F9.2.6"
  | "F10.2.4"
  | "F10.2.5"
  | "F13.1.2"
  | "F15.2.3"
  | "Platform";

type Role = "customer" | "shop" | "rider" | "admin" | "ops" | "oplim";
const ROLE_NAMES: Record<Role, string> = {
  customer: "CUSTOMER",
  shop: "SHOP_OWNER",
  rider: "DELIVERY_PARTNER",
  admin: "ADMIN",
  ops: "OPERATOR",
  oplim: "OPERATOR_LIMITED",
};

interface Row {
  id: string;
  step: Step;
  title: string;
  status: "pass" | "fail" | "blocked";
  detail: string;
}

interface OrderRef {
  id: string;
  orderNumber: string;
  requestId: string;
  method: "ONLINE" | "WALLET";
  intentId: string | null;
  redirectUrl: string | null;
  paid: boolean;
}

/** What the cases hand to each other (kept on disk: a failed case restarts the worker). */
interface Shared {
  users: Partial<Record<Role, { id: string; email: string; role: string }>>;
  shop?: { id: string; name: string };
  product?: { shopProductId: string; name: string; pricePaise: number };
  address?: { id: string; pincode: string | null; city: string | null } | null;
  sandboxUsable?: boolean;
  orderA?: OrderRef;
  orderB?: OrderRef;
  orderC?: OrderRef;
  bPacked?: boolean;
  bDeliveryOrderId?: string;
  bPickedUpByRider?: boolean;
  ticket?: { id: string; ticketNumber: string; note: string };
  otpRequested?: boolean;
  broadcast?: { id: string; title: string };
}

interface StateFile {
  runId: string;
  startedAt: string;
  rows: Row[];
  shared: Shared;
}

const RUN = Date.now().toString(36);

/* ------------------------------------------------------------ state */

function freshState(): StateFile {
  return { runId: RUN, startedAt: new Date().toISOString(), rows: [], shared: { users: {} } };
}

function loadState(): StateFile {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as StateFile;
  } catch {
    return freshState();
  }
}

let state: StateFile = freshState();

function saveState() {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  writeFileSync(RESULT_FILE, JSON.stringify({ baseUrl: BASE_URL, at: new Date().toISOString(), rows: state.rows }, null, 2));
}

const shared = () => state.shared;

/* ----------------------------------------------------- case recording */

class Blocked extends Error {}
/** The case cannot run here (missing data, provider, rider…): recorded as "blocked", not a failure. */
function blocked(reason: string): never {
  throw new Blocked(reason);
}

function record(row: Row) {
  state.rows = [...state.rows.filter((r) => r.id !== row.id), row];
  state.rows.sort((a, b) => a.id.localeCompare(b.id));
  saveState();
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function describeError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join(" | ").slice(0, 600);
}

/**
 * Runs one case, records pass / fail / blocked, then rethrows a failure (or
 * skips a blocked case). The case gets a deadline inside the test's timeout,
 * so a hang is recorded as a failure too, not lost.
 */
async function tc(id: string, step: Step, title: string, body: () => Promise<string | void>) {
  const budget = Math.max(10_000, test.info().timeout - 20_000);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`case did not finish within ${budget / 1000} s`)), budget);
  });
  let outcome: { status: Row["status"]; detail: string };
  try {
    outcome = { status: "pass", detail: (await Promise.race([body(), deadline])) ?? "" };
  } catch (error) {
    if (error instanceof Blocked) {
      record({ id, step, title, status: "blocked", detail: error.message });
      test.skip(true, `blocked: ${error.message}`);
      return;
    }
    record({ id, step, title, status: "fail", detail: describeError(error) });
    throw error;
  } finally {
    clearTimeout(timer);
  }
  record({ id, step, title, ...outcome });
}

/* --------------------------------------------------------- contexts */

const contexts = new Map<Role, APIRequestContext>();

function authFile(role: Role) {
  return join(AUTH_DIR, `${AUTH_PREFIX}-${role}.json`);
}

/** The request context signed in as `role`; blocked when its saved session is missing. */
async function as(role: Role): Promise<APIRequestContext> {
  const existing = contexts.get(role);
  if (existing) return existing;
  const file = authFile(role);
  if (!existsSync(file)) blocked(`no saved ${ROLE_NAMES[role]} session (${file} is missing)`);
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: file, timeout: SLOW_MS });
  contexts.set(role, ctx);
  return ctx;
}

let anonContext: APIRequestContext | null = null;
let browserInstance: Browser | null = null;

/** Chromium for the one step that needs a page (the sandbox payment button); launched on first use. */
async function getBrowser(): Promise<Browser> {
  browserInstance ??= await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  return browserInstance;
}

/** A signed-out request context. */
async function anonymous(): Promise<APIRequestContext> {
  anonContext ??= await playwrightRequest.newContext({ baseURL: BASE_URL, timeout: SLOW_MS });
  return anonContext;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** One API call: status, parsed JSON body (or null), raw text and headers. Never throws on HTTP status. */
async function call(ctx: APIRequestContext, method: Method, path: string, data?: unknown, options: { maxRedirects?: number } = {}) {
  const res = await ctx.fetch(path, {
    method,
    data: data === undefined ? undefined : JSON.stringify(data),
    headers: data === undefined ? undefined : { "content-type": "application/json" },
    maxRedirects: options.maxRedirects ?? 0,
    failOnStatusCode: false,
  });
  const headers = res.headers();
  const buffer = await res.body();
  const text = (headers["content-type"] ?? "").includes("pdf") || (headers["content-type"] ?? "").includes("spreadsheet") ? "" : buffer.toString("utf8");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status(), body, text, headers, buffer };
}

/** "HTTP 409: <message>" for an error answer. */
function why(res: { status: number; body: { error?: { message?: string } } | null; text: string }) {
  return `HTTP ${res.status}: ${res.body?.error?.message ?? res.text.slice(0, 200)}`;
}

function expectStatus(res: { status: number; body: { error?: { message?: string } } | null; text: string }, expected: number | number[], what: string) {
  const list = Array.isArray(expected) ? expected : [expected];
  expect(list, `${what} — ${why(res)}`).toContain(res.status);
}

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, everyMs = 2000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    value = await read();
  }
  return value;
}

/** The signed-in person behind a session (id, email, role) — read from /api/auth/session. */
async function me(role: Role) {
  const known = shared().users[role];
  if (known) return known;
  const res = await call(await as(role), "GET", "/api/auth/session");
  const user = res.body?.user;
  if (res.status !== 200 || !user?.id) blocked(`the saved ${ROLE_NAMES[role]} session is not signed in (expired?) — ${why(res)}`);
  const row = { id: String(user.id), email: String(user.email ?? ""), role: String(user.role ?? "") };
  shared().users[role] = row;
  saveState();
  return row;
}

/* --------------------------------------------------- order helpers */

async function orderOf(id: string) {
  const res = await call(await as("customer"), "GET", "/api/orders");
  expectStatus(res, 200, "GET /api/orders");
  const list = (res.body ?? []) as { id: string; status: string; paidAt: string | null; orderNumber: string; totalPaise: number }[];
  const order = list.find((o) => o.id === id);
  if (!order) throw new Error(`order ${id} is not in the customer's latest orders`);
  return order;
}

/** The test shop, an in-stock product of it and the customer's address — set up by TC-B26-S-003. */
function basket() {
  const s = shared();
  if (!s.shop || !s.product) blocked("no in-stock product of the E2E test shop was found (see TC-B26-S-003)");
  return { shop: s.shop, product: s.product, address: s.address ?? null };
}

/** Empties the customer's cart and puts exactly one unit of the test product in it. */
async function fillCart() {
  const { product } = basket();
  const customer = await as("customer");
  const cleared = await call(customer, "DELETE", "/api/cart");
  expectStatus(cleared, 200, "empty the cart");
  const added = await call(customer, "POST", "/api/cart", { shopProductId: product.shopProductId, quantity: 1 });
  if (added.status === 409 || added.status === 422) blocked(`the test product cannot be added to the cart — ${why(added)}`);
  expectStatus(added, 200, "add 1 unit to the cart");
  const cart = await call(customer, "GET", "/api/cart");
  const lines = (cart.body?.groups ?? []).flatMap((g: { lines: { shopProductId: string; quantity: number }[] }) => g.lines);
  expect(lines.length, "cart lines").toBe(1);
  expect(lines[0].quantity).toBe(1);
}

/** Checkout of the cart (1 unit); ONLINE answers with the payment to complete. */
async function placeOrder(method: "ONLINE" | "WALLET", requestId = `e2e-b26-${RUN}-${randomUUID().slice(0, 8)}`) {
  const { shop, address } = basket();
  await fillCart();
  const res = await call(await as("customer"), "POST", "/api/checkout", {
    requestId,
    addressId: address?.id ?? null,
    paymentMethod: method,
    acknowledgeClosedShopIds: [shop.id],
  });
  if (res.status === 409 || res.status === 422) blocked(`checkout (${method}) refused — ${why(res)}`);
  expectStatus(res, 201, `checkout (${method})`);
  const order = res.body.orders?.[0];
  expect(order?.id, "an order was created").toBeTruthy();
  const ref: OrderRef = {
    id: order.id,
    orderNumber: order.orderNumber,
    requestId,
    method,
    intentId: res.body.payment?.intentId ?? null,
    redirectUrl: res.body.payment?.redirectUrl ?? null,
    paid: method === "WALLET",
  };
  return { ref, body: res.body };
}

/** Presses Pay (success) / Fail on the sandbox payment page, exactly as a tester would. */
async function payInSandbox(redirectUrl: string, outcome: "SUCCESS" | "FAILURE") {
  const context = await (await getBrowser()).newContext({ baseURL: BASE_URL, storageState: authFile("customer") });
  try {
    const page = await context.newPage();
    const res = await page.goto(redirectUrl, { waitUntil: "domcontentloaded" });
    expect(res?.status(), `sandbox page ${redirectUrl}`).toBeLessThan(400);
    await expect(page.getByTestId("sandbox-checkout")).toBeVisible();
    await page.getByTestId(outcome === "SUCCESS" ? "sandbox-pay" : "sandbox-fail").click();
    await page.waitForURL(/\/orders\/payment-return/, { timeout: 60_000 });
    return page.url();
  } finally {
    await context.close();
  }
}

function isSandboxUrl(url: string | null): url is string {
  return Boolean(url && /\/orders\/pay\/sandbox\//.test(url));
}

async function intentStatus(intentId: string) {
  const res = await call(await as("customer"), "GET", `/api/payments/intents/${intentId}`);
  expectStatus(res, 200, "GET /api/payments/intents/[id]");
  return res.body as { status: string; amountPaise: number; refundedPaise: number; orders: { id: string; status: string }[] };
}

/** A paid order: online through the sandbox when it works here, else from the wallet. */
async function placePaidOrder(): Promise<OrderRef> {
  if (shared().sandboxUsable) {
    const { ref } = await placeOrder("ONLINE");
    if (!isSandboxUrl(ref.redirectUrl)) blocked(`the payment page is not the sandbox (${ref.redirectUrl})`);
    await payInSandbox(ref.redirectUrl, "SUCCESS");
    const intent = await poll(() => intentStatus(ref.intentId!), (i) => i.status === "CAPTURED", 30_000);
    expect(intent.status, "payment captured").toBe("CAPTURED");
    return { ...ref, paid: true };
  }
  const { ref } = await placeOrder("WALLET");
  return ref;
}

/* --------------------------------------------------------- QR helper */

/** Reads the pickup QR off the packing slip's server-rendered SVG. */
async function decodeQrSvg(svg: string): Promise<string | null> {
  const { data, info } = await sharp(Buffer.from(svg), { density: 400 })
    .resize(800, 800, { kernel: "nearest", fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height)?.data ?? null;
}

/** GS1 check digit for a 12-digit body (EAN-13). */
function ean13(body12: string) {
  const sum = body12.split("").reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body12 + String((10 - (sum % 10)) % 10);
}

/** Apple's component matching: the first component whose "/" pattern matches decides. */
function aasaOpensInApp(components: { "/"?: string; exclude?: boolean }[], path: string) {
  for (const c of components) {
    const pattern = c["/"];
    if (!pattern) continue;
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    if (re.test(path)) return !c.exclude;
  }
  return false;
}

/* ================================================================ run */

test.describe.configure({ mode: "default", timeout: 300_000 });

test.beforeAll(() => {
  if (IS_PROD) {
    throw new Error(`Refusing to run on ${HOST}: this spec creates orders, payments, tickets and a broadcast. Use test.gokesari.com.`);
  }
  // Worker 0 starts the run; a worker started after a failed case carries on with the saved state.
  const firstWorker = Number(process.env.TEST_WORKER_INDEX ?? 0) === 0;
  state = firstWorker ? freshState() : loadState();
  if (firstWorker) saveState();
});

test.beforeEach(() => {
  test.skip(test.info().project.name === "mobile", "API journeys run once, on the chromium project");
});

test.afterAll(async () => {
  for (const ctx of [...contexts.values(), ...(anonContext ? [anonContext] : [])]) await ctx.dispose().catch(() => {});
  contexts.clear();
  anonContext = null;
  await browserInstance?.close().catch(() => {});
  browserInstance = null;
  if (!IS_PROD) saveState();
});

test.describe(`batch 2026-10 signed-in journeys — ${HOST}`, () => {
  /* --------------------------------------------------- 1. sessions */

  test("TC-B26-S-001 every role's saved session is valid and has its role", () =>
    tc("TC-B26-S-001", "Platform", "Sessions: customer, shop owner, rider, admin, operator", async () => {
      const seen: string[] = [];
      for (const role of ["customer", "shop", "rider", "admin", "ops"] as Role[]) {
        const user = await me(role);
        expect(user.role, `${role} session role`).toBe(ROLE_NAMES[role]);
        seen.push(`${role}=${user.role}`);
      }
      return seen.join(", ");
    }));

  test("TC-B26-S-002 Operator-Limited session is valid", () =>
    tc("TC-B26-S-002", "Platform", "Session: Operator-Limited", async () => {
      const user = await me("oplim");
      expect(user.role).toBe("OPERATOR_LIMITED");
      return `oplim=${user.role}`;
    }));

  /* ----------------------------------------- 2. online payment (sandbox) */

  test("TC-B26-S-003 the E2E test shop has an in-stock product; 1 unit goes in the cart", () =>
    tc("TC-B26-S-003", "F1.7.3/F1.8.4", "Test shop product in stock, added to cart", async () => {
      const customer = await as("customer");
      await me("customer");
      const shops = await call(customer, "GET", `/api/shops?q=${encodeURIComponent(SHOP_NAME)}&limit=24`);
      expectStatus(shops, 200, "shop search");
      const list = (shops.body ?? []) as { id: string; name: string }[];
      const shop = list.find((s) => s.name.toLowerCase() === SHOP_NAME.toLowerCase()) ?? list.find((s) => s.name.toLowerCase().includes(SHOP_NAME.toLowerCase()));
      if (!shop) blocked(`shop "${SHOP_NAME}" is not listed (approved) on ${HOST}`);
      const products = await call(customer, "GET", `/api/shops/${shop.id}/products?limit=100`);
      expectStatus(products, 200, "the shop's storefront");
      type Listing = { shopProductId: string; productName: string; onlinePricePaise: number | null; onlineSaleEnabled: boolean; isAvailable: boolean; trackInventory: boolean; onlineStock: number };
      const sellable = ((products.body ?? []) as Listing[])
        .filter((p) => p.onlineSaleEnabled && p.isAvailable && p.onlinePricePaise != null && p.onlinePricePaise > 0 && (!p.trackInventory || p.onlineStock >= 3))
        .sort((a, b) => (a.onlinePricePaise ?? 0) - (b.onlinePricePaise ?? 0));
      if (sellable.length === 0) blocked(`no product of "${shop.name}" is on sale online with at least 3 in stock`);
      const pick = sellable[0];
      const addresses = await call(customer, "GET", "/api/addresses");
      expectStatus(addresses, 200, "GET /api/addresses");
      const list2 = (addresses.body?.addresses ?? []) as { id: string; isDefault: boolean; pincode: string | null; city: string | null }[];
      const address = list2.find((a) => a.isDefault) ?? list2[0] ?? null;
      state.shared = {
        ...shared(),
        shop: { id: shop.id, name: shop.name },
        product: { shopProductId: pick.shopProductId, name: pick.productName, pricePaise: pick.onlinePricePaise ?? 0 },
        address: address ? { id: address.id, pincode: address.pincode, city: address.city } : null,
      };
      saveState();
      await fillCart();
      return `${shop.name}: ${pick.productName} @ ${pick.onlinePricePaise} paise (stock ${pick.trackInventory ? pick.onlineStock : "untracked"}); address ${address ? address.pincode : "none (pickup)"}`;
    }));

  test("TC-B26-S-004 checkout with ONLINE → order PENDING and a payment intent", () =>
    tc("TC-B26-S-004", "F1.7.3/F1.8.4", "Online checkout: PENDING order + payment intent", async () => {
      const { ref, body } = await placeOrder("ONLINE");
      state.shared.orderA = ref;
      state.shared.sandboxUsable = isSandboxUrl(ref.redirectUrl);
      saveState();
      expect(body.orders[0].paymentMethod).toBe("ONLINE");
      expect(body.orders[0].status).toBe("PENDING");
      expect(ref.intentId, "payment intent id").toBeTruthy();
      expect(["CREATED", "PENDING"]).toContain(body.payment.status);
      expect(body.payment.amountPaise).toBe(body.orders[0].totalPaise);
      expect(ref.redirectUrl, "where to pay").toBeTruthy();
      return `${ref.orderNumber} PENDING, intent ${ref.intentId} ${body.payment.status} ₹${body.payment.amountPaise / 100}, pay at ${ref.redirectUrl}`;
    }));

  test("TC-B26-S-005 a second checkout POST with the same request id makes no second order or intent", () =>
    tc("TC-B26-S-005", "F1.7.3/F1.8.4", "Checkout idempotency: same request id, same intent", async () => {
      const a = shared().orderA;
      if (!a) blocked("no online order from TC-B26-S-004");
      const res = await call(await as("customer"), "POST", "/api/checkout", {
        requestId: a.requestId,
        addressId: shared().address?.id ?? null,
        paymentMethod: "ONLINE",
        acknowledgeClosedShopIds: [shared().shop!.id],
      });
      expectStatus(res, 201, "replayed checkout");
      expect(res.body.deduplicated, "deduplicated").toBe(true);
      expect(res.body.orders.map((o: { id: string }) => o.id)).toEqual([a.id]);
      expect(res.body.payment?.intentId, "same payment intent").toBe(a.intentId);
      return `deduplicated=true, order ${a.orderNumber}, intent ${res.body.payment.intentId}`;
    }));

  test("TC-B26-S-006 sandbox payment (success) → CAPTURED, order CONFIRMED with paidAt", () =>
    tc("TC-B26-S-006", "F1.7.3/F1.8.4", "Sandbox Pay (success): intent CAPTURED, order CONFIRMED + paidAt", async () => {
      const a = shared().orderA;
      if (!a?.intentId) blocked("no online order / intent from TC-B26-S-004");
      if (!isSandboxUrl(a.redirectUrl)) blocked(`the gateway here is not the sandbox (payment page ${a.redirectUrl}) — pay it through the "Sandbox payment" workflow instead`);
      const landed = await payInSandbox(a.redirectUrl, "SUCCESS");
      const intent = await poll(() => intentStatus(a.intentId!), (i) => i.status === "CAPTURED", 30_000);
      expect(intent.status, "intent status").toBe("CAPTURED");
      const order = await orderOf(a.id);
      expect(["CONFIRMED", "ACCEPTED"], `order status ${order.status}`).toContain(order.status);
      expect(order.paidAt, "paidAt").toBeTruthy();
      state.shared.orderA = { ...a, paid: true };
      saveState();
      // After payment the same request id still points at the one, paid intent.
      const replay = await call(await as("customer"), "POST", "/api/checkout", {
        requestId: a.requestId,
        addressId: shared().address?.id ?? null,
        paymentMethod: "ONLINE",
        acknowledgeClosedShopIds: [shared().shop!.id],
      });
      expectStatus(replay, 201, "replay after payment");
      expect(replay.body.payment?.intentId).toBe(a.intentId);
      expect(replay.body.payment?.alreadyPaid).toBe(true);
      return `returned to ${new URL(landed).pathname}; intent CAPTURED; ${a.orderNumber} ${order.status} paidAt ${order.paidAt}; replay → same intent, alreadyPaid`;
    }));

  test("TC-B26-S-007 sandbox payment failure → order PAYMENT_FAILED", () =>
    tc("TC-B26-S-007", "F1.7.3/F1.8.4", "Sandbox Fail: order PAYMENT_FAILED", async () => {
      if (shared().sandboxUsable === false) blocked("the gateway here is not the sandbox (see TC-B26-S-004)");
      const { ref } = await placeOrder("ONLINE");
      state.shared.orderC = ref;
      saveState();
      if (!isSandboxUrl(ref.redirectUrl)) blocked(`the payment page is not the sandbox (${ref.redirectUrl})`);
      await payInSandbox(ref.redirectUrl, "FAILURE");
      const intent = await poll(() => intentStatus(ref.intentId!), (i) => i.status === "FAILED", 30_000);
      expect(intent.status).toBe("FAILED");
      const order = await poll(() => orderOf(ref.id), (o) => o.status === "PAYMENT_FAILED", 20_000);
      expect(order.status).toBe("PAYMENT_FAILED");
      expect(order.paidAt).toBeFalsy();
      return `${ref.orderNumber}: intent FAILED, order PAYMENT_FAILED`;
    }));

  /* -------------------------------------- 3. cancellation and refunds */

  test("TC-B26-S-008 cancellation quote on the paid order is itemised", () =>
    tc("TC-B26-S-008", "F6.1.3", "Cancellation quote: itemised breakdown, refund options", async () => {
      const a = shared().orderA;
      if (!a?.paid) blocked("no paid online order (TC-B26-S-006)");
      const res = await call(await as("customer"), "GET", `/api/orders/${a.id}/cancellation-quote`);
      expectStatus(res, 200, "cancellation quote");
      const q = res.body;
      expect(q.allowed, `allowed (${q.blockedReason})`).toBe(true);
      expect(q.selfService).toBe(true);
      expect(q.breakdown.paid).toBe(true);
      expect(q.breakdown.paidLines.length, "itemised paid lines").toBeGreaterThan(0);
      expect(q.breakdown.stage).toBe("BEFORE_PACKING");
      expect(q.breakdown.deductionsPaise).toBe(0);
      expect(q.breakdown.refundPaise).toBe(q.breakdown.paidPaise);
      const methods = (q.refundMethods as { method: string }[]).map((m) => m.method);
      expect(methods, "refund to the original method offered").toContain("ORIGINAL");
      return `stage ${q.breakdown.stage}; lines ${q.breakdown.paidLines.map((l: { label: string; amountPaise: number }) => `${l.label} ${l.amountPaise}`).join(", ")}; refund ${q.breakdown.refundPaise}; methods ${methods.join("/")}`;
    }));

  test("TC-B26-S-009 customer cancels choosing ORIGINAL → refund with a timeline", () =>
    tc("TC-B26-S-009", "F6.2.3", "Cancel with refund to original method; refunds timeline", async () => {
      const a = shared().orderA;
      if (!a?.paid) blocked("no paid online order (TC-B26-S-006)");
      const customer = await as("customer");
      const quote = await call(customer, "GET", `/api/orders/${a.id}/cancellation-quote`);
      expectStatus(quote, 200, "quote before cancelling");
      const res = await call(customer, "POST", `/api/orders/${a.id}/cancel`, {
        reason: "E2E batch 2026-10 test — refund to original method",
        refundMethod: "ORIGINAL",
        expectedRefundPaise: quote.body.breakdown.refundPaise,
      });
      expectStatus(res, 200, "cancel");
      expect(res.body.refund, "refund recorded").toBeTruthy();
      expect(res.body.refund.method).toBe("ORIGINAL");
      const order = await poll(() => orderOf(a.id), (o) => o.status === "REFUNDED", 20_000);
      expect(["REFUND_PENDING", "REFUNDED"], `order status ${order.status}`).toContain(order.status);
      const refunds = await call(customer, "GET", `/api/orders/${a.id}/refunds`);
      expectStatus(refunds, 200, "refunds");
      const list = refunds.body.refunds as { method: string; status: string; amountPaise: number; timeline: unknown[] }[];
      const original = list.find((r) => r.method === "ORIGINAL");
      expect(original, "ORIGINAL refund listed").toBeTruthy();
      expect(original!.timeline.length, "refund timeline entries").toBeGreaterThan(0);
      return `order ${order.status}; refund ${original!.status} ${original!.amountPaise} paise, ${original!.timeline.length} timeline entries`;
    }));

  test("TC-B26-S-010 second paid order: shop accepts → preparing → ready", () =>
    tc("TC-B26-S-010", "F6.1.3", "Packed order: shop accept, start, ready", async () => {
      await me("shop");
      const b = await placePaidOrder();
      state.shared.orderB = b;
      saveState();
      const shop = await as("shop");
      const accepted = await call(shop, "POST", `/api/orders/${b.id}/fulfilment`, { action: "accept" });
      expectStatus(accepted, 200, "shop accepts");
      const started = await call(shop, "POST", `/api/orders/${b.id}/fulfilment`, { action: "start" });
      expectStatus(started, 200, "shop starts preparing");
      const plan = await call(shop, "GET", `/api/orders/${b.id}/fulfilment-plan`);
      let how = "ready";
      if (plan.status === 200 && plan.body?.enabled) {
        const slotKey = plan.body.days?.[0]?.slots?.[0]?.key as string | undefined;
        if (!slotKey) blocked("no fulfilment time slot is offered now");
        let ready = await call(shop, "POST", `/api/orders/${b.id}/fulfilment-plan`, { option: "GOKESARI_PARTNER", slotKey, markReady: true });
        how = `GoKesari partner, slot ${slotKey}`;
        if (ready.status !== 200) {
          ready = await call(shop, "POST", `/api/orders/${b.id}/fulfilment-plan`, { option: "PICKUP", slotKey, markReady: true });
          how = `pickup, slot ${slotKey} (partner refused)`;
        }
        expectStatus(ready, 200, "mark ready with a plan");
      } else {
        const ready = await call(shop, "POST", `/api/orders/${b.id}/fulfilment`, { action: "ready" });
        expectStatus(ready, 200, "mark ready");
      }
      const order = await orderOf(b.id);
      expect(["READY", "ASSIGNED"]).toContain(order.status);
      state.shared.bPacked = true;
      // Ask for a rider now (today's slots may be over) — the answer carries the delivery's id.
      const assign = await call(shop, "POST", `/api/orders/${b.id}/assign`, {});
      if (assign.status < 300 && assign.body?.id) state.shared.bDeliveryOrderId = assign.body.id;
      saveState();
      const search = assign.status < 300 ? `${assign.status} ${assign.body?.status ?? ""}`.trim() : why(assign);
      return `${b.orderNumber} (${b.method}) ${order.status} via ${how}; "find a rider now" → ${search}`;
    }));

  test("TC-B26-S-011 quote on the packed order shows the after-packing fee", () =>
    tc("TC-B26-S-011", "F6.1.3", "After-packing cancellation fee in the quote", async () => {
      const b = shared().orderB;
      if (!b || !shared().bPacked) blocked("no packed order (TC-B26-S-010)");
      const res = await call(await as("customer"), "GET", `/api/orders/${b.id}/cancellation-quote`);
      expectStatus(res, 200, "quote");
      const q = res.body;
      expect(q.allowed, `allowed (${q.blockedReason})`).toBe(true);
      expect(q.breakdown.stage).toBe("AFTER_PACKING");
      expect(q.breakdown.deductionsPaise, "a fee is deducted").toBeGreaterThan(0);
      expect(q.breakdown.deductions.length).toBeGreaterThan(0);
      expect(q.breakdown.refundPaise).toBe(q.breakdown.paidPaise - q.breakdown.deductionsPaise);
      const fee = await call(await as("shop"), "GET", `/api/shops/${shared().shop!.id}/cancellation-fee`);
      expectStatus(fee, 200, "shop's cancellation-fee settings");
      return `fee ${q.breakdown.deductionsPaise} paise (${q.breakdown.deductions.map((d: { label: string }) => d.label).join(", ")}); refund ${q.breakdown.refundPaise} of ${q.breakdown.paidPaise}`;
    }));

  /* -------------------------------------------- 6. pickup QR, navigation */

  test("TC-B26-S-012 packing slip of the READY order renders a QR (svg)", () =>
    tc("TC-B26-S-012", "F4.1.3", "Packing slip with pickup QR", async () => {
      const b = shared().orderB;
      if (!b || !shared().bPacked) blocked("no packed order (TC-B26-S-010)");
      const res = await call(await as("shop"), "GET", `/shop/orders/${b.id}/packing-slip`);
      expectStatus(res, 200, "packing slip page");
      expect(res.text).toContain('data-testid="packing-slip"');
      expect(res.text).toContain(b.orderNumber);
      const qr = res.text.match(/data-testid="packing-slip-qr"[^>]*>\s*(<svg[\s\S]*?<\/svg>)/);
      expect(qr, "pickup QR svg on the slip (rule pickupQr)").toBeTruthy();
      const payload = await decodeQrSvg(qr![1]).catch(() => null);
      return `slip for ${b.orderNumber}: QR svg ${qr![1].length} chars${payload ? `, decodes (${payload.length} chars)` : ", not decoded"}`;
    }));

  test("TC-B26-S-013 rider navigation for a delivery that is not theirs → 403/404", () =>
    tc("TC-B26-S-013", "F4.2.2", "Navigation refused for someone else's delivery", async () => {
      const rider = await as("rider");
      await me("rider");
      const id = shared().bDeliveryOrderId ?? randomUUID();
      const res = await call(rider, "GET", `/api/delivery-orders/${id}/navigation`);
      expectStatus(res, [403, 404], "navigation for another delivery");
      // The route itself exists (rule on): an unknown id is a 404 with a message, not a page.
      expect(res.body?.error?.message ?? "", "error body").not.toBe("");
      return `${shared().bDeliveryOrderId ? "the packed order's delivery" : "an unknown delivery id"} → ${why(res)}`;
    }));

  test("TC-B26-S-014 rider picks up the READY order by scanning the QR (if offered in time)", () =>
    tc("TC-B26-S-014", "F4.1.3", "Rider pickup by QR scan", async () => {
      const b = shared().orderB;
      if (!b || !shared().bPacked) blocked("no packed order (TC-B26-S-010)");
      const rider = await as("rider");
      // An offer for this order: a broadcast offer, or the single offer as the rider's active job.
      const found = await poll(
        async () => {
          const offers = await call(rider, "GET", "/api/delivery-partner/broadcast-offers");
          const offer = ((offers.body?.offers ?? []) as { broadcastId: string; orderNumber: string; state: string }[]).find((o) => o.orderNumber === b.orderNumber && o.state === "OPEN");
          if (offer) return { kind: "broadcast" as const, id: offer.broadcastId };
          const mine = await call(rider, "GET", "/api/delivery-partner/deliveries");
          const active = mine.body?.active as { id: string; orderId: string; status: string } | null;
          if (active && active.orderId === b.id) return { kind: "single" as const, id: active.id, status: active.status };
          return null;
        },
        (v) => v !== null,
        RIDER_WAIT_MS,
        5000,
      );
      if (!found) blocked(`no offer for ${b.orderNumber} reached the E2E rider within ${RIDER_WAIT_MS / 1000} s (rider offline or not near the shop)`);
      let deliveryId: string;
      if (found.kind === "broadcast") {
        const accepted = await call(rider, "PATCH", `/api/delivery-partner/broadcast-offers/${found.id}`, { action: "accept" });
        expectStatus(accepted, 200, "accept broadcast offer");
        deliveryId = accepted.body.id;
      } else {
        deliveryId = found.id;
        if ("status" in found && found.status === "OFFERED") {
          const accepted = await call(rider, "PATCH", `/api/delivery-orders/${deliveryId}`, { action: "accept" });
          expectStatus(accepted, 200, "accept offer");
        }
      }
      const nav = await call(rider, "GET", `/api/delivery-orders/${deliveryId}/navigation`);
      expectStatus(nav, 200, "navigation for own delivery");
      await call(rider, "PATCH", `/api/delivery-orders/${deliveryId}`, { action: "arrived_shop" });
      const slip = await call(await as("shop"), "GET", `/shop/orders/${b.id}/packing-slip`);
      const svg = slip.text.match(/data-testid="packing-slip-qr"[^>]*>\s*(<svg[\s\S]*?<\/svg>)/)?.[1];
      if (!svg) throw new Error("the packing slip shows no QR to scan");
      const payload = await decodeQrSvg(svg);
      if (!payload) throw new Error("the packing slip QR could not be decoded");
      const scan = await call(rider, "POST", `/api/delivery-orders/${deliveryId}/pickup-scan`, { payload });
      if (scan.status === 200) {
        state.shared.bPickedUpByRider = true;
        saveState();
      }
      expectStatus(scan, 200, "pickup scan");
      expect(scan.body.delivery?.status, "delivery after the scan").toBe("PICKED_UP");
      // Free the test rider again: the parcel goes back to the shop (test data stays).
      const freed = await call(rider, "PATCH", `/api/delivery-orders/${deliveryId}`, { action: "fail", reason: "E2E batch 2026-10 test — parcel returned to the shop" });
      return `accepted (${found.kind}), navigation 200, QR scan → PICKED_UP; rider freed (fail → ${freed.status})`;
    }));

  test("TC-B26-S-015 customer cancels the packed order — the fee is deducted", () =>
    tc("TC-B26-S-015", "F6.1.3", "Cancel after packing: fee kept, rest refunded", async () => {
      const b = shared().orderB;
      if (!b || !shared().bPacked) blocked("no packed order (TC-B26-S-010)");
      if (shared().bPickedUpByRider) blocked("the packed order was picked up by the rider in TC-B26-S-014");
      const customer = await as("customer");
      const quote = await call(customer, "GET", `/api/orders/${b.id}/cancellation-quote`);
      expectStatus(quote, 200, "quote");
      if (!quote.body.allowed) blocked(`cannot cancel now: ${quote.body.blockedReason} (status ${quote.body.status})`);
      if (quote.body.breakdown.stage !== "AFTER_PACKING") blocked(`the order is no longer waiting for pickup (status ${quote.body.status}, stage ${quote.body.breakdown.stage})`);
      const method = (quote.body.refundMethods as { method: string }[]).some((m) => m.method === "WALLET") ? "WALLET" : quote.body.defaultMethod;
      const res = await call(customer, "POST", `/api/orders/${b.id}/cancel`, {
        reason: "E2E batch 2026-10 test — cancel after packing",
        refundMethod: method ?? undefined,
        expectedRefundPaise: quote.body.breakdown.refundPaise,
      });
      expectStatus(res, 200, "cancel after packing");
      expect(res.body.refund?.deductionsPaise, "fee deducted from the refund").toBe(quote.body.breakdown.deductionsPaise);
      expect(res.body.refund?.amountPaise).toBe(quote.body.breakdown.refundPaise);
      return `${b.orderNumber} ${res.body.order.status}; refund ${res.body.refund.amountPaise} (${res.body.refund.method}), fee ${res.body.refund.deductionsPaise}`;
    }));

  /* ----------------------------------------------------- 4. help desk */

  test("TC-B26-S-016 customer raises a ticket → OPEN", () =>
    tc("TC-B26-S-016", "F6.3.3", "Customer raises a support ticket", async () => {
      await me("customer");
      const orderId = shared().orderA?.id ?? null;
      const res = await call(await as("customer"), "POST", "/api/support/tickets", {
        category: orderId ? "ORDER" : "ACCOUNT",
        subject: `E2E batch 2026-10 ticket ${RUN}`,
        description: "E2E test ticket raised by the batch 2026-10 signed-in journey on the test site. Please ignore.",
        orderId,
      });
      expectStatus(res, 201, "raise ticket");
      expect(res.body.status).toBe("OPEN");
      expect(res.body.acknowledgeBy, "SLA acknowledge-by").toBeTruthy();
      state.shared.ticket = { id: res.body.id, ticketNumber: res.body.ticketNumber, note: `E2E internal note ${RUN} — staff only` };
      saveState();
      return `${res.body.ticketNumber} OPEN, acknowledge by ${res.body.acknowledgeBy}`;
    }));

  test("TC-B26-S-017 operator sees it in the queue, acknowledges and assigns it", () =>
    tc("TC-B26-S-017", "F6.3.3", "Operator queue: acknowledge and assign", async () => {
      const t = shared().ticket;
      if (!t) blocked("no ticket (TC-B26-S-016)");
      const ops = await as("ops");
      const opsUser = await me("ops");
      const queue = await call(ops, "GET", `/api/support/tickets?scope=queue&queue=all&q=${encodeURIComponent(t.ticketNumber)}`);
      expectStatus(queue, 200, "support queue");
      expect((queue.body.tickets as { id: string }[]).some((r) => r.id === t.id), "ticket in the queue").toBe(true);
      const ack = await call(ops, "PATCH", `/api/support/tickets/${t.id}`, { action: "status", status: "ACKNOWLEDGED", note: "E2E: acknowledged" });
      expectStatus(ack, 200, "acknowledge");
      expect(ack.body.status).toBe("ACKNOWLEDGED");
      const assign = await call(ops, "PATCH", `/api/support/tickets/${t.id}`, { action: "assign", assigneeId: opsUser.id });
      expectStatus(assign, 200, "assign to self");
      expect(assign.body.assignedToUserId).toBe(opsUser.id);
      return `${t.ticketNumber}: in queue, ACKNOWLEDGED, assigned to the operator`;
    }));

  test("TC-B26-S-018 internal note stays internal; the reply reaches the customer", () =>
    tc("TC-B26-S-018", "F6.3.3", "Internal note hidden, (canned) reply visible", async () => {
      const t = shared().ticket;
      if (!t) blocked("no ticket (TC-B26-S-016)");
      const ops = await as("ops");
      const note = await call(ops, "POST", `/api/support/tickets/${t.id}/messages`, { body: t.note, internal: true });
      expectStatus(note, 201, "internal note");
      const canned = await call(ops, "GET", "/api/support/canned-replies");
      expectStatus(canned, 200, "canned replies");
      const first = (canned.body.replies as { id: string; title?: string; active?: boolean }[]).find((r) => r.active !== false);
      const reply = first
        ? await call(ops, "POST", `/api/support/tickets/${t.id}/messages`, { cannedReplyId: first.id })
        : await call(ops, "POST", `/api/support/tickets/${t.id}/messages`, { body: `E2E reply ${RUN}: we are looking into it.` });
      expectStatus(reply, 201, first ? "canned reply" : "typed reply");
      const seen = await call(await as("customer"), "GET", `/api/support/tickets/${t.id}`);
      expectStatus(seen, 200, "customer reads the ticket");
      const messages = seen.body.messages as { authorKind: string; body: string; internal: boolean }[];
      expect(messages.some((m) => m.body.includes(t.note)), "internal note visible to the customer").toBe(false);
      expect(messages.some((m) => m.internal), "an internal message reached the customer").toBe(false);
      expect(messages.some((m) => m.authorKind === "STAFF"), "support's reply visible").toBe(true);
      const staffView = await call(ops, "GET", `/api/support/tickets/${t.id}`);
      expect((staffView.body.messages as { body: string; internal: boolean }[]).some((m) => m.internal && m.body.includes(t.note)), "note kept for support").toBe(true);
      return `note hidden from customer; ${first ? `canned reply "${first.title ?? first.id}"` : "typed reply (no canned replies)"} visible; status ${reply.body.status}`;
    }));

  test("TC-B26-S-019 resolve → close → CSAT only after close", () =>
    tc("TC-B26-S-019", "F6.3.3", "Resolve, close, CSAT gated on close", async () => {
      const t = shared().ticket;
      if (!t) blocked("no ticket (TC-B26-S-016)");
      const ops = await as("ops");
      const customer = await as("customer");
      const resolved = await call(ops, "PATCH", `/api/support/tickets/${t.id}`, { action: "status", status: "RESOLVED", note: "E2E: resolved by the batch test" });
      expectStatus(resolved, 200, "resolve");
      const early = await call(customer, "POST", `/api/support/tickets/${t.id}/csat`, { rating: 5 });
      expectStatus(early, 409, "CSAT before close is refused");
      const closed = await call(customer, "PATCH", `/api/support/tickets/${t.id}`, { action: "status", status: "CLOSED" });
      expectStatus(closed, 200, "customer closes");
      expect(closed.body.status).toBe("CLOSED");
      const csat = await call(customer, "POST", `/api/support/tickets/${t.id}/csat`, { rating: 5, comment: "E2E batch 2026-10" });
      expectStatus(csat, 201, "CSAT after close");
      return `RESOLVED → CSAT early ${early.status} → CLOSED → CSAT ${csat.status} (rating ${csat.body.rating})`;
    }));

  test("TC-B26-S-020 grievance officer details on /legal/grievance-redressal", () =>
    tc("TC-B26-S-020", "F6.3.3", "Grievance officer published", async () => {
      const res = await call(await anonymous(), "GET", "/legal/grievance-redressal", undefined, { maxRedirects: 3 });
      expectStatus(res, 200, "grievance page");
      const text = res.text.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
      expect(text).toMatch(/Grievance Officer/i);
      const name = text.match(/Name:\s*([^:]+?)\s+Designation:/)?.[1]?.trim();
      const email = text.match(/Email:\s*(\S+@\S+)/)?.[1];
      expect(name, "officer name").toBeTruthy();
      expect(email, "officer email").toBeTruthy();
      return `officer ${name}, ${email}`;
    }));

  /* ------------------------------------ 5. broadcasts, centre, push */

  test("TC-B26-S-021 admin estimates and sends a broadcast to a narrow audience with an expiry", () =>
    tc("TC-B26-S-021", "F3.3.2", "Broadcast: estimate, send (narrow audience, expiry)", async () => {
      await me("customer");
      const pincode = shared().address?.pincode;
      if (!pincode) blocked("the customer has no address with a PIN code — no narrow audience to send to");
      const admin = await as("admin");
      const audience = { roles: ["CUSTOMER"], pincodes: [pincode] };
      const estimate = await call(admin, "POST", "/api/admin/broadcasts/estimate", { audience });
      expectStatus(estimate, 200, "estimate");
      const count = Number(estimate.body.count);
      if (count < 1) blocked(`the audience (customers at PIN ${pincode}) is empty`);
      if (count > MAX_AUDIENCE) blocked(`the audience (customers at PIN ${pincode}) is ${count} people — more than E2E_BROADCAST_MAX_AUDIENCE=${MAX_AUDIENCE}; not sent`);
      const title = `E2E test ${RUN}`;
      const created = await call(admin, "POST", "/api/admin/broadcasts", {
        title,
        message: "Test announcement from the batch 2026-10 signed-in journey (test site). Please ignore.",
        linkUrl: "/notifications",
        audience,
        expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
        action: "draft",
      });
      expectStatus(created, 201, "save draft");
      const id = created.body.broadcast.id as string;
      state.shared.broadcast = { id, title };
      saveState();
      const sent = await call(admin, "POST", `/api/admin/broadcasts/${id}`, { action: "send" });
      expectStatus(sent, 200, "send now");
      const done = await poll(
        async () => (await call(admin, "GET", `/api/admin/broadcasts/${id}`)).body?.broadcast,
        (b) => b?.status === "SENT",
        30_000,
      );
      expect(done?.status).toBe("SENT");
      expect(done.recipientCount).toBe(count);
      return `audience CUSTOMER @ ${pincode}: estimate ${count}, SENT to ${done.recipientCount}, expires ${done.expiresAt}`;
    }));

  test("TC-B26-S-022 customer's notification centre shows it unread; marking read drops the count", () =>
    tc("TC-B26-S-022", "F3.3.2", "Notification centre: unread broadcast, mark read", async () => {
      const b = shared().broadcast;
      if (!b) blocked("no broadcast was sent (TC-B26-S-021)");
      const customer = await as("customer");
      const centre = await poll(
        async () => (await call(customer, "GET", "/api/notifications/centre?filter=unread&pageSize=50")).body,
        (c) => (c?.items ?? []).some((i: { title: string }) => i.title === b.title),
        20_000,
      );
      const item = (centre.items as { id: string; title: string; read: boolean }[]).find((i) => i.title === b.title);
      expect(item, "broadcast in the unread list").toBeTruthy();
      expect(item!.read).toBe(false);
      const before = Number(centre.unread);
      const marked = await call(customer, "PATCH", "/api/notifications", { id: item!.id });
      expectStatus(marked, 200, "mark read");
      const after = await call(customer, "GET", "/api/notifications/centre?filter=all&pageSize=50");
      expect(Number(after.body.unread), "unread count").toBe(before - 1);
      expect((after.body.items as { id: string; read: boolean }[]).find((i) => i.id === item!.id)?.read).toBe(true);
      return `unread ${before} → ${after.body.unread}`;
    }));

  test("TC-B26-S-023 push token register / unregister (mock provider)", () =>
    tc("TC-B26-S-023", "F13.1.2", "Push token register and unregister", async () => {
      const customer = await as("customer");
      const token = `ExponentPushToken[e2e-b26-${RUN}]`;
      const reg = await call(customer, "POST", "/api/push-tokens", { token, platform: "android", appVariant: "preview", deviceName: "E2E batch 2026-10" });
      expectStatus(reg, 200, "register");
      expect(reg.body.registered).toBe(true);
      expect(reg.body.active).toBe(true);
      const again = await call(customer, "POST", "/api/push-tokens", { token, platform: "android", appVariant: "preview" });
      expectStatus(again, 200, "register again (idempotent)");
      expect(again.body.id).toBe(reg.body.id);
      const del = await call(customer, "DELETE", "/api/push-tokens", { token });
      expectStatus(del, 200, "unregister");
      expect(del.body.unregistered).toBeTruthy();
      return `registered ${reg.body.id} (idempotent), unregistered`;
    }));

  test("TC-B26-S-024 rider's broadcast offers answer 200 with a list", () =>
    tc("TC-B26-S-024", "F3.3.2", "Rider broadcast offers list", async () => {
      const res = await call(await as("rider"), "GET", "/api/delivery-partner/broadcast-offers");
      expectStatus(res, 200, "broadcast offers");
      expect(Array.isArray(res.body.offers)).toBe(true);
      return `enabled=${res.body.enabled}, poll ${res.body.pollSeconds}s, ${res.body.offers.length} offers`;
    }));

  /* -------------------------------------- 7. payouts, statutory, invoices */

  test("TC-B26-S-025 admin: payouts screen and payout-cycle endpoint", () =>
    tc("TC-B26-S-025", "F10.2.4", "Admin payouts", async () => {
      const admin = await as("admin");
      const page = await call(admin, "GET", "/admin/payouts");
      expectStatus(page, 200, "/admin/payouts");
      if (CLOSE_PAYOUT_CYCLE) {
        const closed = await call(admin, "POST", "/api/admin/payouts/cycles", {});
        expectStatus(closed, [200, 201], "close payout cycle");
        return `/admin/payouts 200; cycles POST ${closed.status} (${closed.body.cycle ? `batch ${closed.body.batch?.id ?? "?"}, ${closed.body.items} items` : "nothing to close"})`;
      }
      // The route closes a cycle (POST only); without E2E_CLOSE_PAYOUT_CYCLE=1 only its presence is checked.
      const probe = await call(admin, "GET", "/api/admin/payouts/cycles");
      expectStatus(probe, 405, "cycles route present (POST only)");
      return "/admin/payouts 200; /api/admin/payouts/cycles present (GET 405 — set E2E_CLOSE_PAYOUT_CYCLE=1 to close a cycle)";
    }));

  test("TC-B26-S-026 operator gets 403 on payouts and statutory (finance is admin-only)", () =>
    tc("TC-B26-S-026", "F10.2.4", "Operator refused on finance", async () => {
      const ops = await as("ops");
      const cycles = await call(ops, "POST", "/api/admin/payouts/cycles", {});
      expectStatus(cycles, 403, "operator closes a payout cycle");
      const statutory = await call(ops, "GET", "/api/admin/statutory");
      expectStatus(statutory, 403, "operator reads statutory settings");
      const report = await call(ops, "GET", "/api/admin/statutory/reports?type=tcs&period=2026-10&format=json");
      expectStatus(report, 403, "operator exports a statutory report");
      return "payouts 403, statutory 403, reports 403";
    }));

  test("TC-B26-S-027 statutory settings listed, not yet confirmed by the CA", () =>
    tc("TC-B26-S-027", "F10.2.5", "Statutory rows with confirmedByCa false", async () => {
      const res = await call(await as("admin"), "GET", "/api/admin/statutory");
      expectStatus(res, 200, "statutory list");
      const rows = res.body as { key: string; confirmedByCa: boolean }[];
      expect(rows.length, "statutory rows").toBeGreaterThan(0);
      const unconfirmed = rows.filter((r) => r.confirmedByCa === false);
      expect(unconfirmed.length, "rows awaiting CA confirmation").toBeGreaterThan(0);
      return `${rows.length} rows, ${unconfirmed.length} with confirmedByCa=false (${[...new Set(unconfirmed.map((r) => r.key))].join(", ")})`;
    }));

  test("TC-B26-S-028 statutory exports (GSTR-1, TCS, TDS) return data", () =>
    tc("TC-B26-S-028", "F10.2.5", "Statutory report exports", async () => {
      const admin = await as("admin");
      const period = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
      const seen: string[] = [];
      for (const type of ["gstr1", "tcs", "tds"]) {
        const json = await call(admin, "GET", `/api/admin/statutory/reports?type=${type}&period=${period}&format=json`);
        expectStatus(json, 200, `${type} json`);
        expect(json.headers["content-type"]).toContain("application/json");
        expect(json.body, `${type} json body`).not.toBeNull();
        const csv = await call(admin, "GET", `/api/admin/statutory/reports?type=${type}&period=${period}&format=csv`);
        expectStatus(csv, 200, `${type} csv`);
        expect(csv.headers["content-type"]).toContain("text/csv");
        expect(csv.text.length, `${type} csv has a header row`).toBeGreaterThan(0);
        seen.push(`${type}: json ${json.text.length} B, csv ${csv.text.split("\n").filter(Boolean).length} lines`);
      }
      return `${period} — ${seen.join("; ")}`;
    }));

  test("TC-B26-S-029 platform (GoKesari fee) invoices list loads for the admin", () =>
    tc("TC-B26-S-029", "F10.2.5", "Platform invoices list", async () => {
      const res = await call(await as("admin"), "GET", "/admin/platform-invoices");
      expectStatus(res, 200, "/admin/platform-invoices");
      expect(res.text).toMatch(/invoice/i);
      return `HTTP 200, ${res.text.length} B`;
    }));

  /* ------------------------------------------------ 8. Operator-Limited */

  test("TC-B26-S-030 Operator-Limited: board loads, own shops listed", () =>
    tc("TC-B26-S-030", "F8.4.2", "Operator-Limited board and own shops", async () => {
      const oplim = await as("oplim");
      await me("oplim");
      const board = await call(oplim, "GET", "/operator");
      expectStatus(board, 200, "/operator board");
      const shops = await call(oplim, "GET", "/api/operator/shops");
      expectStatus(shops, 200, "/api/operator/shops");
      expect(Array.isArray(shops.body.shops)).toBe(true);
      return `/operator 200; ${shops.body.shops.length} onboarded shops`;
    }));

  test("TC-B26-S-031 Operator-Limited: payouts and settings refused", () =>
    tc("TC-B26-S-031", "F8.4.2", "Operator-Limited refused on payouts / settings", async () => {
      const oplim = await as("oplim");
      const seen: string[] = [];
      for (const [method, path] of [
        ["POST", "/api/admin/payouts/cycles"],
        ["GET", "/api/admin/settings"],
        ["GET", "/api/admin/statutory"],
        ["GET", "/api/admin/broadcasts"],
      ] as [Method, string][]) {
        const res = await call(oplim, method, path, method === "POST" ? {} : undefined);
        expectStatus(res, 403, `${method} ${path}`);
        seen.push(`${path}=${res.status}`);
      }
      return seen.join(", ");
    }));

  test("TC-B26-S-032 customer gets 403 on the operator API", () =>
    tc("TC-B26-S-032", "F8.4.2", "Customer refused on /api/operator/*", async () => {
      const customer = await as("customer");
      const seen: string[] = [];
      for (const path of ["/api/operator/shops", "/api/operator/documents", "/api/operator/onboarding"]) {
        const res = await call(customer, "GET", path);
        expectStatus(res, 403, path);
        seen.push(`${path}=${res.status}`);
      }
      return seen.join(", ");
    }));

  /* ---------------------------------------------- 9. product master */

  test("TC-B26-S-033 product browser search (operator and admin)", () =>
    tc("TC-B26-S-033", "F9.1.4", "Product browser search", async () => {
      const seen: string[] = [];
      for (const role of ["ops", "admin"] as Role[]) {
        const res = await call(await as(role), "GET", "/api/pmd/browser?q=milk&pageSize=5");
        expectStatus(res, 200, `${role} product browser`);
        seen.push(`${role}=200 (${JSON.stringify(res.body).length} B)`);
      }
      const customer = await call(await as("customer"), "GET", "/api/pmd/browser?q=milk");
      expectStatus(customer, 403, "customer product browser");
      return `${seen.join(", ")}, customer=403`;
    }));

  test("TC-B26-S-034 manufacturer template downloads", () =>
    tc("TC-B26-S-034", "F9.1.2", "Manufacturer template (xlsx, csv)", async () => {
      const admin = await as("admin");
      const xlsx = await call(admin, "GET", "/api/pmd/manufacturer/template?format=xlsx");
      expectStatus(xlsx, 200, "xlsx template");
      expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
      expect(xlsx.buffer.subarray(0, 2).toString("latin1"), "xlsx is a zip").toBe("PK");
      const csv = await call(admin, "GET", "/api/pmd/manufacturer/template?format=csv");
      expectStatus(csv, 200, "csv template");
      expect(csv.text.split("\n")[0].length).toBeGreaterThan(0);
      return `xlsx ${xlsx.buffer.length} B, csv header: ${csv.text.split("\n")[0].slice(0, 80)}`;
    }));

  test("TC-B26-S-035 GS1 (mock) look-up returns a record", () =>
    tc("TC-B26-S-035", "F9.1.2", "GS1 DataKart mock look-up", async () => {
      const gtin = ean13("890100100001");
      const res = await call(await as("admin"), "POST", "/api/pmd/sources/lookup", { source: "GS1", gtins: [gtin] });
      if (res.status === 409) blocked(`GS1 look-ups are off here — ${why(res)}`);
      expectStatus(res, 200, "GS1 look-up");
      expect(res.body.found, "records found").toBeGreaterThanOrEqual(1);
      const ops = await call(await as("ops"), "POST", "/api/pmd/sources/lookup", { source: "GS1", gtins: [gtin] });
      expectStatus(ops, 403, "operator look-up (import is admin-only)");
      return `GTIN ${gtin}: mode ${res.body.mode}, found ${res.body.found}, job ${res.body.job?.id ?? "-"}; operator 403`;
    }));

  test("TC-B26-S-036 product-data jobs list", () =>
    tc("TC-B26-S-036", "F9.1.4", "PMD jobs list", async () => {
      const seen: string[] = [];
      for (const role of ["ops", "admin"] as Role[]) {
        const res = await call(await as(role), "GET", "/api/pmd/jobs");
        expectStatus(res, 200, `${role} jobs`);
        expect(Array.isArray(res.body.jobs)).toBe(true);
        seen.push(`${role}: ${res.body.jobs.length} jobs`);
      }
      return seen.join(", ");
    }));

  /* --------------------------------------------------- 10. invoice PDF */

  test("TC-B26-S-037 invoice PDF of a delivered order", () =>
    tc("TC-B26-S-037", "F9.2.6", "Invoice PDF for a DELIVERED order", async () => {
      const customer = await as("customer");
      const orders = await call(customer, "GET", "/api/orders");
      expectStatus(orders, 200, "orders");
      const delivered = ((orders.body ?? []) as { id: string; orderNumber: string; status: string }[]).find((o) => o.status === "DELIVERED");
      if (!delivered) blocked("the customer has no DELIVERED order among the latest 25");
      const issued = await call(customer, "POST", `/api/orders/${delivered.id}/invoice`);
      expectStatus(issued, 200, "invoice for the order");
      const pdf = await call(customer, "GET", issued.body.pdfUrl);
      expectStatus(pdf, 200, "invoice PDF");
      expect(pdf.headers["content-type"]).toContain("application/pdf");
      expect(pdf.buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
      return `${delivered.orderNumber} → ${issued.body.invoiceNumber}, PDF ${pdf.buffer.length} B`;
    }));

  /* ---------------------------------------------------- 11. deep links */

  test("TC-B26-S-038 assetlinks.json names the preview app on the test site", () =>
    tc("TC-B26-S-038", "F15.2.3", "Android assetlinks: preview package", async () => {
      const expected = HOSTNAME === "test.gokesari.com" || HOSTNAME.startsWith("test.") ? "com.gokesari.app.preview" : "com.gokesari.app";
      const res = await call(await anonymous(), "GET", "/.well-known/assetlinks.json");
      expectStatus(res, 200, "assetlinks.json");
      const packages = (res.body as { target: { package_name: string } }[]).map((s) => s.target.package_name);
      expect(packages).toContain(expected);
      return `package ${packages.join(", ")}`;
    }));

  test("TC-B26-S-039 AASA applinks open /support and /orders/ in the app", () =>
    tc("TC-B26-S-039", "F15.2.3", "iOS AASA covers /support and /orders/", async () => {
      const res = await call(await anonymous(), "GET", "/.well-known/apple-app-site-association");
      expectStatus(res, 200, "AASA");
      expect(res.headers["content-type"]).toContain("application/json");
      const details = res.body.applinks.details as { appIDs: string[]; components: { "/"?: string; exclude?: boolean }[] }[];
      expect(details.length).toBeGreaterThan(0);
      const components = details.flatMap((d) => d.components);
      for (const path of ["/support", "/support/tickets/00000000-0000-0000-0000-000000000000", "/orders/00000000-0000-0000-0000-000000000000"]) {
        expect(aasaOpensInApp(components, path), `${path} opens in the app`).toBe(true);
      }
      expect(aasaOpensInApp(components, "/api/orders"), "/api stays on the web").toBe(false);
      return `appIDs ${details.flatMap((d) => d.appIDs).join(", ")}; components ${components.map((c) => `${c.exclude ? "!" : ""}${c["/"]}`).join(" ")}`;
    }));

  /* ------------------------------------------------------- 12. email OTP */

  test("TC-B26-S-040 email OTP request: masked email, 5-minute code, resend cooldown", () =>
    tc("TC-B26-S-040", "F1.1.2", "Email OTP request (no code submitted)", async () => {
      const email = (await me("customer")).email;
      if (!email) blocked("the customer session has no email");
      const anon = await anonymous();
      const info = await call(anon, "GET", "/api/otp/request");
      expectStatus(info, 200, "OTP settings");
      if (info.body.email !== true) blocked("email sign-in codes cannot be sent on this site (no email transport)");
      expect(info.body.expiryMinutes).toBe(5);
      const res = await call(anon, "POST", "/api/otp/request", { email });
      if (res.status === 429) blocked(`a code was requested for this email moments ago — ${why(res)}`);
      expectStatus(res, 200, "request a code");
      expect(res.body.status).toBe("SENT");
      expect(res.body.maskedEmail, "masked email").toMatch(/\*/);
      expect(res.body.expiryMinutes, "code lives 5 minutes").toBe(5);
      expect(res.body.resendAfterSeconds, "resend cooldown").toBeGreaterThan(0);
      state.shared.otpRequested = true;
      saveState();
      const signin = await call(anon, "GET", "/signin", undefined, { maxRedirects: 3 });
      expect(signin.text, "sign-in says the code goes to email").toMatch(/sent to your email/i);
      return `SENT to ${res.body.maskedEmail}; expires in ${res.body.expiryMinutes} min; resend after ${res.body.resendAfterSeconds} s`;
    }));

  test("TC-B26-S-041 an immediate second OTP request is rate-limited", () =>
    tc("TC-B26-S-041", "F1.1.2", "OTP resend cooldown enforced", async () => {
      if (!shared().otpRequested) blocked("no first code was requested (TC-B26-S-040)");
      const email = (await me("customer")).email;
      const res = await call(await anonymous(), "POST", "/api/otp/request", { email });
      expectStatus(res, 429, "second request");
      expect(res.body?.error?.message ?? "").toMatch(/wait|too many/i);
      return why(res);
    }));
});
