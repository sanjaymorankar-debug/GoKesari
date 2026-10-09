/**
 * End-to-end regression for the 7 Oct 2026 change set (items A–E) and the
 * existing flows around them. Runs against a real Next.js server and a real,
 * seeded PostgreSQL database (E2E_DATABASE_URL — never the integration-test
 * database). Several actors each have their own browser session; database
 * access is used only to arrange data (coordinates, phone numbers, reading
 * the codes a person would read off a screen), never to perform an action
 * under test.
 *
 *   E2E_DATABASE_URL=… CRON_SECRET=… npx playwright test tests/e2e/regression-items-a-e.spec.ts --project=chromium
 *
 * The server must run with BOOTSTRAP_ADMIN_EMAILS=e2e-admin@test.local.
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";
import postgres from "postgres";

const DB_URL = process.env.E2E_DATABASE_URL;
const AUTH_SECRET = process.env.AUTH_SECRET ?? "";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SESSION_COOKIE = BASE_URL.startsWith("https") ? "__Secure-authjs.session-token" : "authjs.session-token";
const CRON_SECRET = process.env.CRON_SECRET ?? "dev-cron-secret-change-me";
const RUN = Date.now().toString(36);
const SHOP_SLUG = "kesari-dairy-farm";
const SHOP_OWNER_EMAIL = "kesari.dairy@example.com";
const ADMIN_EMAIL = "e2e-admin@test.local";
const LAT = 18.5204;
const LNG = 73.8567;

test.skip(!DB_URL || !AUTH_SECRET, "E2E_DATABASE_URL and AUTH_SECRET (the server's) are required");
const sql = postgres(DB_URL ?? "postgres://invalid", { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/* ------------------------------------------------------------- helpers */

interface Actor {
  email: string;
  context: BrowserContext;
  page: Page;
  api: APIRequestContext;
}

/**
 * Signs an actor in. Production builds (what test.gokesari.com runs) have no
 * test login provider, so the session cookie is minted exactly as Auth.js
 * would mint it, with the server's AUTH_SECRET. The app still re-reads the
 * role and status from the database on every request.
 */
async function signIn(browser: Browser, email: string, role: string = "CUSTOMER"): Promise<Actor> {
  let [user] = await sql`select id, name from users where email = ${email}`;
  if (!user) {
    [user] = await sql`insert into users (email, role, name) values (${email}, ${role}, ${"E2E " + email.split("@")[0]})
                       returning id, name`;
    await sql`insert into wallets (user_id) values (${user.id}) on conflict do nothing`;
    if (role !== "CUSTOMER") {
      await sql`insert into user_role_grants (user_id, role, source) values (${user.id}, ${role}, 'ADMIN') on conflict do nothing`.catch(() => {});
    }
  }
  const mobile = `7${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  await sql`update users set profile_completed_at = coalesce(profile_completed_at, now()),
            phone = coalesce(phone, ${mobile}), phone_e164 = coalesce(phone_e164, ${"+91" + mobile}),
            phone_verified_at = coalesce(phone_verified_at, now()) where id = ${user.id}`;
  const value = await encode({ token: { sub: user.id, email, name: user.name }, secret: AUTH_SECRET, salt: SESSION_COOKIE });
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value, url: BASE_URL }]);
  const page = await context.newPage();
  return { email, context, page, api: context.request };
}

/** Funds a wallet the way a settled top-up does: balance and its ledger row move together. */
async function fundWallet(email: string, amountPaise: number) {
  await sql.begin(async (tx) => {
    const [w] = await tx`select w.id, w.user_id, w.balance_paise from wallets w join users u on u.id = w.user_id
                         where u.email = ${email} for update`;
    const previous = Number(w.balance_paise);
    await tx`update wallets set balance_paise = ${previous + amountPaise}, updated_at = now() where id = ${w.id}`;
    await tx`insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise,
             idempotency_key, description)
             values (${w.id}, ${w.user_id}, 'TOP_UP', ${amountPaise}, ${previous}, ${previous + amountPaise},
             ${"e2e-topup-" + Math.random().toString(36).slice(2)}, 'E2E wallet top-up')`;
  });
}

async function call(actor: Actor | APIRequestContext, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, data?: unknown) {
  const api = "api" in actor ? actor.api : actor;
  const res = await api.fetch(url, { method, data, headers: data ? { "Content-Type": "application/json" } : undefined });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}

async function userId(email: string): Promise<string> {
  const [row] = await sql`select id from users where email = ${email}`;
  return row.id as string;
}

const balance = async (email: string) =>
  Number((await sql`select w.balance_paise from wallets w join users u on u.id = w.user_id where u.email = ${email}`)[0].balance_paise);

async function setRule(admin: Actor, key: string, value: unknown) {
  const res = await call(admin, "PUT", "/api/admin/settings", { key, value });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
async function resetRule(admin: Actor, key: string) {
  const res = await call(admin, "DELETE", `/api/admin/settings?key=${encodeURIComponent(key)}`);
  expect([200, 204]).toContain(res.status);
}

/** A customer with a mobile number, a wallet balance and a delivery address at the shop's PIN. */
async function makeCustomer(browser: Browser, label: string, topUpPaise = 500_000): Promise<Actor> {
  const email = `e2e-${label}-${RUN}@test.local`;
  const actor = await signIn(browser, email);
  const id = await userId(email);
  const mobile = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  await sql`update users set phone = ${mobile}, phone_e164 = ${"+91" + mobile}, phone_verified_at = now(),
            name = ${"E2E " + label}, profile_completed_at = now() where id = ${id}`;
  const [shop] = await sql`select pincode from shops where slug = ${SHOP_SLUG}`;
  await sql`insert into addresses (user_id, line1, city, pincode, is_default, address_type, latitude, longitude)
            values (${id}, '2 Test Lane', 'Pune', ${shop.pincode}, true, 'HOME', ${String(LAT + 0.001)}, ${String(LNG + 0.001)})`;
  if (topUpPaise > 0) await fundWallet(email, topUpPaise);
  return actor;
}

async function shopRow() {
  const [shop] = await sql`select * from shops where slug = ${SHOP_SLUG}`;
  return shop;
}

/** First online-sellable product of the seeded shop. */
async function sellable() {
  const [row] = await sql`
    select sp.id, p.name, sp.online_price_paise as price from shop_products sp
    join products p on p.id = sp.product_id join shops s on s.id = sp.shop_id
    where s.slug = ${SHOP_SLUG} and sp.online_sale_enabled and sp.is_active and sp.is_available
      and sp.online_price_paise is not null
    order by sp.online_price_paise asc limit 1`;
  return { shopProductId: row.id as string, name: row.name as string, price: Number(row.price) };
}

async function placeOrder(customer: Actor, quantity = 1, extra: Record<string, unknown> = {}) {
  const product = await sellable();
  const add = await call(customer, "POST", "/api/cart", { shopProductId: product.shopProductId, quantity });
  expect(add.status, JSON.stringify(add.body)).toBeLessThan(300);
  const [address] = await sql`select a.id from addresses a join users u on u.id = a.user_id where u.email = ${customer.email} and a.is_default`;
  const res = await call(customer, "POST", "/api/checkout", {
    requestId: `e2e-${RUN}-${Math.random().toString(36).slice(2)}`,
    addressId: address.id,
    paymentMethod: "WALLET",
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const orderId = res.body.orders[0].id as string;
  const [row] = await sql`select order_number, total_paise, delivery_fee_paise from orders where id = ${orderId}`;
  return { orderId, orderNumber: row.order_number as string, total: Number(row.total_paise), fee: Number(row.delivery_fee_paise), product };
}

const orderStatus = async (orderId: string) => (await sql`select status from orders where id = ${orderId}`)[0].status as string;

/* -------------------------------------------------------------- actors */

let admin: Actor;
let operator: Actor;
let owner: Actor;
let rider: Actor;
let riderPartnerId: string;

// Serial: the actors and their data build on each other. Generous timeouts:
// `next dev` compiles each route on its first visit.
test.describe.configure({ mode: "serial", timeout: 300_000 });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  // The seeded shop: a position, a pickup point, open all day, delivers here.
  await sql`update shops set latitude = ${String(LAT)}, longitude = ${String(LNG)}, pickup_latitude = ${String(LAT)},
            pickup_longitude = ${String(LNG)}, location_verified = true, service_radius_km = 10,
            opening_hours = ${sql.json([0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59" })))},
            orders_paused = false, delivery_available = true, contact_phone = null, whatsapp_number = null
            where slug = ${SHOP_SLUG}`;
  await sql`update shop_products sp set online_stock = 500, offline_stock = 500, track_inventory = false
            from shops s where s.id = sp.shop_id and s.slug = ${SHOP_SLUG}`.catch(async () => {
    await sql`update shop_products sp set online_stock = 500 from shops s where s.id = sp.shop_id and s.slug = ${SHOP_SLUG}`;
  });
  // Riders left online by an earlier run would take this run's offers.
  await sql`update delivery_partners set is_online = false`;
  admin = await signIn(browser, ADMIN_EMAIL, "ADMIN");
  owner = await signIn(browser, SHOP_OWNER_EMAIL);
  operator = await signIn(browser, `e2e-operator-${RUN}@test.local`, "OPERATOR");
});

/* ================================================== baseline smoke */

test("pages load without server errors (public, customer, shop, admin, operator)", async ({ browser }) => {
  const customer = await makeCustomer(browser, "smoke", 0);
  const visit = async (actor: Actor | null, path: string) => {
    const page = actor ? await actor.context.newPage() : await (await browser.newContext()).newPage();
    const res = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(res?.status(), path).toBeLessThan(500);
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("body")).not.toContainText("Internal Server Error");
    await page.close();
  };
  for (const path of ["/", "/signin", "/shops", `/shops/${SHOP_SLUG}`, `/shops/${SHOP_SLUG}/contact`, "/search?q=milk", "/legal/refund-policy"]) {
    await visit(null, path);
  }
  for (const path of ["/cart", "/orders", "/wallet", "/profile", "/returns", "/subscriptions"]) await visit(customer, path);
  for (const path of ["/shop", "/shop/orders", "/shop/catalogue", "/shop/prices", "/shop/inventory", "/shop/finance", "/shop/returns"]) await visit(owner, path);
  for (const path of ["/admin", "/admin/settings", "/admin/orders", "/admin/exceptions", "/admin/finance", "/admin/societies", "/admin/rider-kyc", "/admin/disputes", "/admin/returns", "/admin/cod", "/admin/risk", "/admin/rider-changes"]) {
    await visit(admin, path);
  }
  for (const path of ["/admin", "/admin/orders", "/admin/exceptions", "/admin/societies", "/admin/disputes"]) await visit(operator, path);
});

test("business rules page lists the new rules with their defaults (B)", async () => {
  await admin.page.goto("/admin/settings");
  for (const key of ["cancellation", "shopContact", "societyRiders", "openOrderCheck", "riderFiles", "cod", "walletTopup", "ratings", "marketing", "vouchers", "settlement", "deliveryOtp", "returnPickup", "grievances", "discovery", "catalogue", "uploads", "opsExceptions", "riskRules", "returns", "otp", "images", "suspension"]) {
    await expect(admin.page.getByLabel(`${key} settings (JSON)`, { exact: true })).toBeVisible();
  }
  await expect(admin.page.getByLabel("returns settings (JSON)", { exact: true })).toHaveValue(/"windowHours": 48/);
  // An operator cannot change business rules.
  const res = await call(operator, "PUT", "/api/admin/settings", { key: "ratings", value: { windowDays: 10 } });
  expect(res.status).toBe(403);
});

/* ===================================== order → accept → pack → deliver */

test("rider onboarding: register, admin approves, goes online", async ({ browser }) => {
  const email = `e2e-rider-${RUN}@test.local`;
  rider = await signIn(browser, email);
  const mobile = `8${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const reg = await call(rider, "POST", "/api/delivery-partner", {
    fullName: "E2E Rider",
    mobile,
    vehicleType: "MOTORCYCLE",
    vehicleRegistrationNumber: "MH12AB1234",
    operatingRadiusKm: 10,
    latitude: LAT,
    longitude: LNG,
  });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  riderPartnerId = reg.body.id;
  const approve = await call(admin, "PATCH", `/api/delivery-partner/${riderPartnerId}`, { action: "approve" });
  expect(approve.status, JSON.stringify(approve.body)).toBe(200);
  const online = await call(rider, "PATCH", "/api/delivery-partner/status", { action: "online", latitude: LAT, longitude: LNG });
  expect(online.status, JSON.stringify(online.body)).toBe(200);
});

async function deliverOrder(orderId: string) {
  expect((await call(owner, "POST", `/api/orders/${orderId}/fulfilment`, { action: "accept" })).status).toBe(200);
  expect((await call(owner, "POST", `/api/orders/${orderId}/fulfilment`, { action: "start" })).status).toBe(200);
  const ready = await call(owner, "POST", `/api/orders/${orderId}/fulfilment`, { action: "ready" });
  expect(ready.status, JSON.stringify(ready.body)).toBe(200);
  // Ready → a rider is offered the job automatically.
  let [offer] = await sql`select id, status from delivery_orders where order_id = ${orderId}`;
  if (!offer) {
    const assign = await call(owner, "POST", `/api/orders/${orderId}/assign`, {});
    expect(assign.status, JSON.stringify(assign.body)).toBeLessThan(300);
    [offer] = await sql`select id, status from delivery_orders where order_id = ${orderId}`;
  }
  expect(offer.status).toBe("OFFERED");
  const accept = await call(rider, "PATCH", `/api/delivery-orders/${offer.id}`, { action: "accept" });
  expect(accept.status, JSON.stringify(accept.body)).toBe(200);
  expect(await orderStatus(orderId)).toBe("ASSIGNED");
  const [codes] = await sql`select pickup_code, delivery_otp from delivery_orders where id = ${offer.id}`;
  const pickup = await call(rider, "PATCH", `/api/delivery-orders/${offer.id}`, { action: "pickup", pickupCode: codes.pickup_code ?? undefined });
  expect(pickup.status, JSON.stringify(pickup.body)).toBe(200);
  const start = await call(rider, "PATCH", `/api/delivery-orders/${offer.id}`, { action: "start" });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const [after] = await sql`select delivery_otp from delivery_orders where id = ${offer.id}`;
  return { deliveryOrderId: offer.id as string, otp: (after.delivery_otp ?? codes.delivery_otp) as string | null };
}

test("order → accept → pack → rider → deliver; wallet charged once; delivery code checked (D OTP limit B)", async ({ browser }) => {
  const customer = await makeCustomer(browser, "flow");
  const start = await balance(customer.email);
  const order = await placeOrder(customer);
  expect(await balance(customer.email)).toBe(start - order.total);
  const { deliveryOrderId, otp } = await deliverOrder(order.orderId);
  // A wrong code is refused.
  const wrong = await call(rider, "PATCH", `/api/delivery-orders/${deliveryOrderId}`, { action: "deliver", otp: "000000" });
  expect(wrong.status).toBe(422);
  const done = await call(rider, "PATCH", `/api/delivery-orders/${deliveryOrderId}`, { action: "deliver", otp: otp ?? undefined });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(await orderStatus(order.orderId)).toBe("DELIVERED");
  expect(await balance(customer.email)).toBe(start - order.total);
  await customer.page.goto("/orders");
  await expect(customer.page.getByTestId("order-card").first()).toContainText(/delivered/i);
});

/* ================================================== A — cancellation */

test("A: customer cancels before the shop accepts → full refund incl. delivery fee", async ({ browser }) => {
  const customer = await makeCustomer(browser, "cancel-a");
  const start = await balance(customer.email);
  const order = await placeOrder(customer);
  expect(order.fee).toBeGreaterThan(0);
  const res = await call(customer, "PATCH", `/api/orders/${order.orderId}/status`, { status: "CANCELLED", note: "Changed my mind" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(await orderStatus(order.orderId)).toBe("REFUNDED");
  expect(await balance(customer.email)).toBe(start);
});

test("A: shop cancels while picking (before packing) → full refund incl. delivery fee; customer still blocked by default", async ({ browser }) => {
  const customer = await makeCustomer(browser, "cancel-b");
  const start = await balance(customer.email);
  const order = await placeOrder(customer);
  await call(owner, "POST", `/api/orders/${order.orderId}/fulfilment`, { action: "accept" });
  await call(owner, "POST", `/api/orders/${order.orderId}/fulfilment`, { action: "start" });
  const blocked = await call(customer, "PATCH", `/api/orders/${order.orderId}/status`, { status: "CANCELLED" });
  expect(blocked.status).toBe(409);
  const res = await call(owner, "PATCH", `/api/orders/${order.orderId}/status`, { status: "CANCELLED", note: "Out of stock" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(await balance(customer.email)).toBe(start);
});

test("A: rule cancellation=PREPARING lets the customer cancel while picking, full refund; READY still blocked", async ({ browser }) => {
  await setRule(admin, "cancellation", { customerMayCancelUntil: "PREPARING" });
  try {
    const customer = await makeCustomer(browser, "cancel-c");
    const start = await balance(customer.email);
    const order = await placeOrder(customer);
    await call(owner, "POST", `/api/orders/${order.orderId}/fulfilment`, { action: "accept" });
    await call(owner, "POST", `/api/orders/${order.orderId}/fulfilment`, { action: "start" });
    const res = await call(customer, "PATCH", `/api/orders/${order.orderId}/status`, { status: "CANCELLED", note: "Ordered twice" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await balance(customer.email)).toBe(start);
    const second = await placeOrder(customer);
    await call(owner, "POST", `/api/orders/${second.orderId}/fulfilment`, { action: "accept" });
    await call(owner, "POST", `/api/orders/${second.orderId}/fulfilment`, { action: "start" });
    await call(owner, "POST", `/api/orders/${second.orderId}/fulfilment`, { action: "ready" });
    const packed = await call(customer, "PATCH", `/api/orders/${second.orderId}/status`, { status: "CANCELLED" });
    expect(packed.status).toBe(409);
    await call(owner, "PATCH", `/api/orders/${second.orderId}/status`, { status: "CANCELLED", note: "cleanup" });
  } finally {
    await resetRule(admin, "cancellation");
  }
});

test("A (unchanged): customer cancels after pickup → goods refunded, delivery fee kept", async ({ browser }) => {
  const customer = await makeCustomer(browser, "cancel-d");
  const start = await balance(customer.email);
  const order = await placeOrder(customer);
  await deliverOrder(order.orderId);
  const res = await call(customer, "PATCH", `/api/orders/${order.orderId}/status`, { status: "CANCELLED", note: "Too late" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(await balance(customer.email)).toBe(start - order.fee);
});

/* ====================================== C3 — open order prompt (UI) */

test("C3: an open order is shown before paying; cancel it from the prompt, or ignore and continue", async ({ browser }) => {
  const customer = await makeCustomer(browser, "open-order");
  const first = await placeOrder(customer);
  const product = await sellable();
  await call(customer, "POST", "/api/cart", { shopProductId: product.shopProductId, quantity: 1 });
  const page = customer.page;
  await page.goto("/cart");
  await page.getByRole("button", { name: /Pay from wallet/ }).click();
  const prompt = page.getByTestId("open-order-confirm");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText(first.orderNumber);
  await expect(prompt).toContainText("Confirmed");
  await prompt.getByRole("button", { name: "Cancel this order" }).click();
  await expect(page.getByText(`Order ${first.orderNumber} cancelled`)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => orderStatus(first.orderId)).toBe("REFUNDED");
  // No open order left → paying goes straight through.
  await page.getByRole("button", { name: /Pay from wallet/ }).click();
  await page.waitForURL(/\/orders/, { timeout: 60_000 });

  // A second order while the first is open → "Ignore and continue" places it.
  await call(customer, "POST", "/api/cart", { shopProductId: product.shopProductId, quantity: 1 });
  await page.goto("/cart");
  await page.getByRole("button", { name: /Pay from wallet/ }).click();
  await expect(page.getByTestId("open-order-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Ignore and continue" }).click();
  await page.waitForURL(/\/orders/, { timeout: 60_000 });
  const [{ n }] = await sql`select count(*)::int as n from orders o join users u on u.id = o.user_id
                            where u.email = ${customer.email} and o.status = 'CONFIRMED'`;
  expect(n).toBe(2);
});

/* ======================================== C1 — shop contact numbers */

test("C1: customers see only the shop's own contact numbers, never the registration phone", async () => {
  const shop = await shopRow();
  const page = (await owner.context.browser()!.newContext()).newPage();
  const anon = await page;
  await anon.goto(`/shops/${SHOP_SLUG}/contact`);
  const care = anon.getByTestId("shop-customer-care");
  await expect(care).toBeVisible();
  await expect(care).not.toContainText(shop.phone);
  await expect(care).toContainText("GoKesari customer care");

  // The shopkeeper enters a contact phone and WhatsApp on the dashboard.
  await owner.page.goto("/shop");
  const card = owner.page.getByTestId("shop-customer-contact");
  await card.getByLabel("Shop contact phone").fill("9123456780");
  await card.getByLabel("WhatsApp number").fill("9123456781");
  await card.getByRole("button", { name: "Save contact numbers" }).click();
  await expect(card.getByText("Saved.")).toBeVisible();

  await anon.goto(`/shops/${SHOP_SLUG}/contact`);
  await expect(anon.getByTestId("shop-customer-care")).toContainText("9123456780");
  await expect(anon.getByTestId("shop-customer-care")).toContainText("WhatsApp 9123456781");
  await expect(anon.getByTestId("shop-customer-care")).not.toContainText(shop.phone);
  const html = await anon.content();
  expect(html).not.toContain(shop.phone);
});

/* ======================================== C2 + C5 — societies, riders */

test("C2: an unverified society cannot add a rider (server refuses); once verified it can", async ({ browser }) => {
  const founder = await makeCustomer(browser, "society", 0);
  const created = await call(founder, "POST", "/api/societies", {
    name: `E2E Towers ${RUN}`,
    addressLine1: "1 Tower Road",
    city: "Pune",
    pincode: (await shopRow()).pincode,
    latitude: LAT,
    longitude: LNG,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const societyId = created.body.id;
  const [partner] = await sql`select mobile from delivery_partners where id = ${riderPartnerId}`;
  const refused = await call(founder, "POST", `/api/societies/${societyId}/riders`, { mobile: partner.mobile, preferred: true });
  expect(refused.status).toBe(403);
  expect((await sql`select count(*)::int as n from society_riders where society_id = ${societyId}`)[0].n).toBe(0);
  // UI: the form is replaced by a note.
  await founder.page.goto(`/society/${societyId}`);
  await expect(founder.page.getByTestId("riders-locked")).toBeVisible();

  const verify = await call(operator, "POST", `/api/societies/${societyId}/decision`, { decision: "verify" });
  expect(verify.status, JSON.stringify(verify.body)).toBe(200);
  const added = await call(founder, "POST", `/api/societies/${societyId}/riders`, { mobile: partner.mobile, preferred: true });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  await founder.page.goto(`/society/${societyId}`);
  await expect(founder.page.getByText(/GKR-[0-9A-F]{8}/)).toBeVisible();
  test.info().annotations.push({ type: "societyId", description: societyId });
  (globalThis as Record<string, unknown>).__e2eSociety = { societyId, founderEmail: founder.email, founder };
});

test("C5: rider photo + KYC document upload; access-checked links; ID card lists the society", async ({ browser }) => {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000001f4000001f40802000000" + "00".repeat(64),
    "hex",
  );
  // Photo upload (as the rider) and save on the profile.
  const up = await rider.api.post("/api/images", { multipart: { purpose: "PROFILE_PHOTO", file: { name: "me.png", mimeType: "image/png", buffer: png } } });
  expect(up.status()).toBe(201);
  const photo = await up.json();
  const me = await call(rider, "GET", "/api/delivery-partner/me");
  const save = await call(rider, "PATCH", "/api/delivery-partner/me", {
    fullName: me.body.fullName,
    mobile: me.body.mobile,
    email: me.body.email,
    dateOfBirth: me.body.dateOfBirth,
    profilePhotoUrl: photo.url,
    vehicleType: me.body.vehicleType,
    vehicleRegistrationNumber: me.body.vehicleRegistrationNumber,
    operatingRadiusKm: me.body.operatingRadiusKm,
  });
  expect(save.status, JSON.stringify(save.body)).toBe(200);
  // An outside photo link is refused.
  const outside = await call(rider, "PATCH", "/api/delivery-partner/me", { ...save.body, fullName: me.body.fullName, mobile: me.body.mobile, email: me.body.email, dateOfBirth: me.body.dateOfBirth, vehicleType: me.body.vehicleType, vehicleRegistrationNumber: me.body.vehicleRegistrationNumber, operatingRadiusKm: me.body.operatingRadiusKm, profilePhotoUrl: "https://example.com/me.jpg" });
  expect(outside.status).toBe(422);

  // Unauthenticated / unrelated users get 404 for the photo; the rider, operator, society staff get it.
  const anon = await (await browser.newContext()).request;
  expect((await anon.get(photo.url)).status()).toBe(404);
  const stranger = await makeCustomer(browser, "stranger", 0);
  expect((await stranger.api.get(photo.url)).status()).toBe(404);
  expect((await rider.api.get(photo.url)).status()).toBe(200);
  expect((await operator.api.get(photo.url)).status()).toBe(200);
  const society = (globalThis as Record<string, unknown>).__e2eSociety as { founder: Actor } | undefined;
  if (society) expect((await society.founder.api.get(photo.url)).status()).toBe(200);

  // KYC document: admin only.
  const doc = await rider.api.post("/api/delivery-partner/me/documents", {
    multipart: { docType: "AADHAAR", file: { name: "aadhaar.png", mimeType: "image/png", buffer: png } },
  });
  expect(doc.status()).toBe(201);
  const [row] = await sql`select stored_image_id from delivery_partner_documents where delivery_partner_id = ${riderPartnerId} and replaced_at is null`;
  const fileUrl = `/api/images/${row.stored_image_id}`;
  expect((await anon.get(fileUrl)).status()).toBe(404);
  expect((await rider.api.get(fileUrl)).status()).toBe(404);
  expect((await operator.api.get(fileUrl)).status()).toBe(404);
  expect((await admin.api.get(fileUrl)).status()).toBe(200);
  expect((await call(operator, "GET", "/api/admin/rider-documents")).status).toBe(403);
  await operator.page.goto("/admin/rider-kyc");
  await expect(operator.page).not.toHaveURL(/rider-kyc/);
  await admin.page.goto("/admin/rider-kyc");
  await expect(admin.page.getByTestId("rider-kyc-queue")).toContainText("Aadhaar card");

  // The rider's ID card: photo, name, rider ID, the verified society.
  await rider.page.goto("/gig/id-card");
  const card = rider.page.getByTestId("rider-id-card");
  await expect(card).toBeVisible();
  await expect(rider.page.getByTestId("rider-id-name")).toHaveText("E2E Rider");
  await expect(rider.page.getByTestId("rider-id-code")).toHaveText(/^GKR-[0-9A-F]{8}$/);
  if (society) await expect(rider.page.getByTestId("rider-id-societies")).toContainText(`E2E Towers ${RUN}`);
  await expect(card.getByRole("img", { name: /Photo of E2E Rider/ })).toHaveAttribute("src", photo.url);
});

/* =========================================== C4 — voucher visibility */

test("C4: operators and admins see voucher codes; customers and shop owners are refused", async ({ browser }) => {
  const today = new Date().toISOString().slice(0, 10);
  const code = `E2E${RUN}`.toUpperCase().slice(0, 20);
  const created = await call(admin, "POST", "/api/vouchers", { name: "E2E voucher", code, bonusPercent: 10, startDate: today, endDate: today });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const opList = await call(operator, "GET", "/api/vouchers");
  expect(opList.status).toBe(200);
  expect(JSON.stringify(opList.body)).toContain(code);
  const customer = await makeCustomer(browser, "voucher", 0);
  expect((await call(customer, "GET", "/api/vouchers")).status).toBe(403);
  expect((await call(owner, "GET", "/api/vouchers")).status).toBe(403);
  // Customer top-up with the voucher still works (redemption path).
  const topup = await call(customer, "POST", "/api/wallet/topup", { amountPaise: 10_000, voucherCode: code });
  expect(topup.status, JSON.stringify(topup.body)).toBe(200);
  expect(topup.body.voucherPreview?.bonusPercent).toBe(10);
});

/* ======================================= shop catalogue & inventory */

test("shop product add (duplicate warning) and price / stock update", async () => {
  const [category] = await sql`select c.id from product_categories c
    join shop_product_categories spc on spc.category_id = c.id join shops s on s.id = spc.shop_id
    where s.slug = ${SHOP_SLUG} limit 1`.catch(() => [] as never[]);
  const [anyCategory] = category ? [category] : await sql`select id from product_categories where is_active limit 1`;
  const shop = await shopRow();
  // Random letters: earlier runs' products stay in the database and a near-identical
  // name would (rightly) be caught by the duplicate check this test exercises.
  const word = Array.from({ length: 12 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
  const name = `Paneer ${word}`;
  const first = await call(owner, "POST", "/api/products", {
    shopId: shop.id, categoryId: anyCategory.id, name, unit: "piece", onlineSaleEnabled: true, onlinePricePaise: 9000,
  });
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  const similar = await call(owner, "POST", "/api/products", {
    shopId: shop.id, categoryId: anyCategory.id, name: `${name} 200g`, unit: "piece", onlineSaleEnabled: true, onlinePricePaise: 9000,
  });
  expect(similar.status).toBe(409);
  expect(JSON.stringify(similar.body)).toContain(name);
  const spId = first.body.shopProduct.id;
  const priced = await call(owner, "PATCH", `/api/shop-products/${spId}`, { onlinePricePaise: 9500, onlineStock: 25 });
  expect(priced.status, JSON.stringify(priced.body)).toBeLessThan(300);
});

/* ============================================================ returns */

test("returns: a delivered order can be returned within the 48 h window", async ({ browser }) => {
  const customer = await makeCustomer(browser, "return");
  const order = await placeOrder(customer);
  const { deliveryOrderId, otp } = await deliverOrder(order.orderId);
  expect((await call(rider, "PATCH", `/api/delivery-orders/${deliveryOrderId}`, { action: "deliver", otp: otp ?? undefined })).status).toBe(200);
  const [item] = await sql`select id, quantity_milli from order_items where order_id = ${order.orderId}`;
  const ret = await call(customer, "POST", `/api/orders/${order.orderId}/returns`, {
    reason: "MISSING_ITEM",
    comment: "One packet was missing from the bag.",
    items: [{ orderItemId: item.id, quantityMilli: item.quantity_milli, condition: "UNOPENED" }],
  });
  expect(ret.status, JSON.stringify(ret.body)).toBe(201);
  await customer.page.goto("/returns");
  await expect(customer.page.locator("body")).toContainText(/return/i);
});

/* ==================================== D — 6 Oct features, one by one */

test("D1 time slots: scheduled slots on → a slot is offered and an order books it", async ({ browser }) => {
  await setRule(admin, "scheduledSlots", { enabled: true });
  await setRule(admin, "deliverySlots", { enabled: true });
  try {
    const customer = await makeCustomer(browser, "slots");
    const shop = await shopRow();
    const slots = await call(customer, "GET", `/api/checkout/scheduled-slots?shopId=${shop.id}`);
    expect(slots.status, JSON.stringify(slots.body)).toBe(200);
    const options = slots.body.slots as { key: string; remaining: number | null }[];
    const open = options.find((s) => s.remaining == null || s.remaining > 0);
    expect(open, JSON.stringify(slots.body)).toBeDefined();
    const order = await placeOrder(customer, 1, { deliveryWindows: { [shop.id]: "SCHEDULED" }, scheduledSlots: { [shop.id]: open!.key } });
    const [row] = await sql`select scheduled_slot_start from orders where id = ${order.orderId}`;
    expect(row.scheduled_slot_start).not.toBeNull();
    await call(owner, "PATCH", `/api/orders/${order.orderId}/status`, { status: "CANCELLED", note: "cleanup" });
  } finally {
    await resetRule(admin, "scheduledSlots");
    await resetRule(admin, "deliverySlots");
  }
});

test("D2 rider batching: on → order flow still completes", async ({ browser }) => {
  await setRule(admin, "batching", { enabled: true });
  try {
    const customer = await makeCustomer(browser, "batch");
    const order = await placeOrder(customer);
    const { deliveryOrderId, otp } = await deliverOrder(order.orderId);
    expect((await call(rider, "PATCH", `/api/delivery-orders/${deliveryOrderId}`, { action: "deliver", otp: otp ?? undefined })).status).toBe(200);
    expect(await orderStatus(order.orderId)).toBe("DELIVERED");
  } finally {
    await resetRule(admin, "batching");
  }
});

test("D3 invoices: on → a delivered order gets an invoice the customer can download", async ({ browser }) => {
  await setRule(admin, "invoicing", { enabled: true });
  try {
    const customer = await makeCustomer(browser, "invoice");
    const order = await placeOrder(customer);
    const { deliveryOrderId, otp } = await deliverOrder(order.orderId);
    expect((await call(rider, "PATCH", `/api/delivery-orders/${deliveryOrderId}`, { action: "deliver", otp: otp ?? undefined })).status).toBe(200);
    const [inv] = await sql`select id from tax_invoices where order_id = ${order.orderId}`;
    expect(inv).toBeDefined();
    const pdf = await customer.api.get(`/api/invoices/${inv.id}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("pdf");
    // Another customer cannot download it.
    const other = await makeCustomer(browser, "invoice-other", 0);
    expect((await other.api.get(`/api/invoices/${inv.id}/pdf`)).status()).toBeGreaterThanOrEqual(403);
  } finally {
    await resetRule(admin, "invoicing");
  }
});

test("D4 delivery photos: on → a drop needs a photo first", async ({ browser }) => {
  await setRule(admin, "deliveryProof", { photoRequired: true });
  try {
    const customer = await makeCustomer(browser, "proof");
    const order = await placeOrder(customer);
    const { deliveryOrderId, otp } = await deliverOrder(order.orderId);
    const refused = await call(rider, "PATCH", `/api/delivery-orders/${deliveryOrderId}`, { action: "deliver", otp: otp ?? undefined });
    expect(refused.status).toBe(409);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000001f4000001f40802000000" + "00".repeat(64), "hex");
    const proof = await rider.api.post(`/api/delivery-orders/${deliveryOrderId}/proof`, {
      multipart: { file: { name: "door.png", mimeType: "image/png", buffer: png } },
    });
    expect(proof.status(), await proof.text()).toBeLessThan(300);
    const done = await call(rider, "PATCH", `/api/delivery-orders/${deliveryOrderId}`, { action: "deliver", otp: otp ?? undefined });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  } finally {
    await resetRule(admin, "deliveryProof");
  }
});

test("D5 acceptance timeout: on → an unaccepted order is cancelled by the cron sweep with a full refund", async ({ browser, request }) => {
  await setRule(admin, "shopAcceptance", { enabled: true, acceptMinutes: 1 });
  try {
    const customer = await makeCustomer(browser, "timeout");
    const start = await balance(customer.email);
    const order = await placeOrder(customer);
    const [row] = await sql`select accept_by_at from orders where id = ${order.orderId}`;
    expect(row.accept_by_at).not.toBeNull();
    // The minute passes (moved back rather than waited for).
    await sql`update orders set accept_by_at = now() - interval '1 second' where id = ${order.orderId}`;
    const sweep = await request.post("/api/cron/shop-acceptance", { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(sweep.status()).toBe(200);
    await expect.poll(() => orderStatus(order.orderId)).toBe("REFUNDED");
    expect(await balance(customer.email)).toBe(start);
  } finally {
    await resetRule(admin, "shopAcceptance");
  }
});

test("D6 all five on together (the end state on test): accepted in time, packed, photo + code drop, invoice issued", async ({ browser, request }) => {
  const rules: [string, unknown][] = [
    ["scheduledSlots", { enabled: true }],
    ["deliverySlots", { enabled: true }],
    ["batching", { enabled: true }],
    ["invoicing", { enabled: true }],
    ["deliveryProof", { photoRequired: true }],
    ["shopAcceptance", { enabled: true, acceptMinutes: 10 }],
  ];
  for (const [key, value] of rules) await setRule(admin, key, value);
  try {
    const customer = await makeCustomer(browser, "all-on");
    const start = await balance(customer.email);
    const order = await placeOrder(customer);
    const [row] = await sql`select accept_by_at from orders where id = ${order.orderId}`;
    expect(row.accept_by_at).not.toBeNull();
    // A sweep before the deadline leaves an order alone.
    expect((await request.post("/api/cron/shop-acceptance", { headers: { Authorization: `Bearer ${CRON_SECRET}` } })).status()).toBe(200);
    expect(await orderStatus(order.orderId)).toBe("CONFIRMED");
    const { deliveryOrderId, otp } = await deliverOrder(order.orderId);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000001f4000001f40802000000" + "00".repeat(64), "hex");
    const proof = await rider.api.post(`/api/delivery-orders/${deliveryOrderId}/proof`, {
      multipart: { file: { name: "door.png", mimeType: "image/png", buffer: png } },
    });
    expect(proof.status(), await proof.text()).toBeLessThan(300);
    const done = await call(rider, "PATCH", `/api/delivery-orders/${deliveryOrderId}`, { action: "deliver", otp: otp ?? undefined });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await orderStatus(order.orderId)).toBe("DELIVERED");
    expect(await balance(customer.email)).toBe(start - order.total);
    const [inv] = await sql`select id from tax_invoices where order_id = ${order.orderId}`;
    expect(inv).toBeDefined();
    // The delivery photo opens for the customer, not for a stranger.
    const [p] = await sql`select stored_image_id from delivery_proofs where order_id = ${order.orderId}`;
    expect((await customer.api.get(`/api/images/${p.stored_image_id}`)).status()).toBe(200);
    const stranger = await makeCustomer(browser, "all-on-stranger", 0);
    expect((await stranger.api.get(`/api/images/${p.stored_image_id}`)).status()).toBe(404);
  } finally {
    for (const [key] of rules) await resetRule(admin, key);
  }
});

/* ===================================================== crons, access */

test("every cron answers with the secret and refuses without it", async ({ request }) => {
  // The cron endpoints share a rate limit (RATE_LIMITS.CRON: 30 a minute per
  // client, fixed window). Earlier tests and the other browser project call
  // them too, so start this test's 14 calls in a fresh window.
  await new Promise((resolve) => setTimeout(resolve, 61_000));
  for (const path of ["daily-orders", "delivery-dispatch", "notifications", "risk-rules", "dispute-escalation", "shop-acceptance", "seller-verification"]) {
    expect((await request.post(`/api/cron/${path}`)).status(), path).toBe(403);
    const ok = await request.post(`/api/cron/${path}`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(ok.status(), `${path}: ${await ok.text()}`).toBe(200);
  }
});

test("a customer cannot reach admin screens or admin APIs", async ({ browser }) => {
  const customer = await makeCustomer(browser, "nosy", 0);
  await customer.page.goto("/admin/settings");
  await expect(customer.page).not.toHaveURL(/\/admin\/settings/);
  expect((await call(customer, "GET", "/api/admin/rider-documents")).status).toBe(403);
  expect((await call(customer, "PUT", "/api/admin/settings", { key: "ratings", value: { windowDays: 1 } })).status).toBe(403);
});
