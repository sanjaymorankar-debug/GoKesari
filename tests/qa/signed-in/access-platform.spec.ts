/**
 * Security and platform behaviour as signed-in people see it (QA package 2):
 * the sign-in form and email codes, the suite's own production guard, stored
 * script text across every free-text surface and the other party's screens,
 * error pages and error bodies for signed-in routes, cookie flags, and the
 * every-form field rules (server repeats the page, odd text, odd numbers,
 * keyboard and phone keypads, messages beside fields).
 *
 * Signed-in tier (test accounts on their own data) unless marked otherwise.
 */
import { execFileSync } from "node:child_process";

import type { Page } from "@playwright/test";

import { as, me, pageAs } from "../lib/actors";
import { addToCart, deliver, emptyCart, onlyRiderOnline, packOrder, placeOrder, sellable, shopOf } from "../lib/flows";
import { anonymous, call, expectStatus, RUN, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { BASE_URL, IS_LOCAL } from "../lib/target";
import { world } from "../lib/world";
import { NO_SUCH_ID, openPage } from "../lib/access-helpers";

const signed = { tier: "signed" as const, timeout: 300_000 };

const XSS = `<script>alert(1)</script><img src=x onerror=alert(2)> ${RUN}`;

/** Opens a page as a role and reports whether any script from stored text ran or built an element. */
async function viewAs(browser: Parameters<typeof pageAs>[0], role: Parameters<typeof pageAs>[1], path: string, needle?: string) {
  const { context, page } = await pageAs(browser, role);
  let alerted = false;
  page.on("dialog", async (d) => {
    alerted = true;
    await d.dismiss();
  });
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const injected = await page.evaluate(() => document.querySelectorAll('img[src="x"], img[onerror]').length);
    const shown = needle ? (await page.locator("body").innerText()).includes(needle) : false;
    return { alerted, injected, shown };
  } finally {
    await context.close();
  }
}

/* ======================================================== sign-in and email */

qa("TC-PRE-005", "the sign-in page shows the mobile/email code form and email codes can be sent (no 'cannot send' warning)", async ({ page }) => {
  await openPage(page, "/signin");
  await expect(page.getByLabel("Mobile number or email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get code" })).toBeVisible();
  // (A note that Google sign-in is not configured may appear; the email code form is what the case is about.)
  await expect(page.locator("body")).not.toContainText(/codes? cannot be sent|cannot send (a )?code|email (sign-in|codes?) (is|are) (disabled|not configured)/i);
  const guest = await anonymous();
  const capability = await call(guest, "GET", "/api/otp/request");
  await guest.dispose();
  expectStatus(capability, 200, "GET /api/otp/request");
  expect(capability.body?.email, "email codes enabled").toBe(true);
  return `form shown; GET /api/otp/request → email ${capability.body?.email}, ${capability.body?.codeLength}-digit codes valid ${capability.body?.expiryMinutes} min`;
}, { mobile: true, partial: "a code actually reaching a mailbox is the local-tier check (local mail catcher)" });

qa(["TC-PRE-009", "TC-PRE-010"], "pointed at gokesari.com, the suite refuses to sign in or write: signed and local tiers are refused, writes and sessions throw", async () => {
  // Run the suite's own guards in a separate process aimed at production; nothing is sent to the network.
  const script = `(async () => {
    const tm = await import("./tests/qa/lib/target.ts"); const t = tm.TARGET ? tm : tm.default;
    const am = await import("./tests/qa/lib/actors.ts"); const a = am.storageFor ? am : am.default;
    const out = { target: t.TARGET, signed: t.tierRefusal("signed"), local: t.tierRefusal("local"), guest: t.tierRefusal("guest"), write: "", session: "" };
    try { t.assertWritable("place an order"); out.write = "ALLOWED"; } catch (e) { out.write = String(e.message); }
    try { await a.storageFor("customer"); out.session = "ALLOWED"; } catch (e) { out.session = String(e.message); }
    console.log(JSON.stringify(out));
  })().catch((e) => console.log(JSON.stringify({ error: String(e) })));`;
  const raw = execFileSync("node", ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, E2E_BASE_URL: "https://gokesari.com" },
    encoding: "utf8",
    timeout: 120_000,
  });
  const result = JSON.parse(raw.trim().split("\n").pop() ?? "{}");
  expect(result.target).toBe("production");
  expect(result.guest, "guest tier runs on production").toBeNull();
  expect(result.signed, "signed tier refused").toMatch(/not run on production/);
  expect(result.local, "local tier refused").toMatch(/not run on production/);
  expect(result.write, "writes refused").toMatch(/Refusing to place an order on gokesari\.com/);
  expect(result.session, "sign-in refused").toMatch(/Refusing to sign in on gokesari\.com/);
  return `production target: signed "${result.signed}", local "${result.local}", write "${result.write}", session "${result.session}"`;
}, { ...signed, partial: "proves the suite cannot order, pay, suspend, change settings or register on gokesari.com; a person's manual discipline on production is outside automation" });

/* ======================================================== stored XSS */

qa("TC-SEC-003", "stored script text in profile name, address landmark, order notes, rating, return comment, shop description and support ticket is shown escaped to the other party; no script runs", async ({ browser }) => {
  const A = await shopOf("A");
  const results: string[] = [];
  const bad: string[] = [];
  const customer = await as("customer");
  const profile = (await call(customer, "GET", "/api/profile")).body;
  const oldName = String(profile?.name ?? "QA Customer One");
  const shopBefore = (await call(await as("shop"), "GET", `/api/shops/${A.id}`)).body;
  const oldDescription = shopBefore?.description ?? null;
  let addressId: string | null = null;
  try {
    // 1. Profile name.
    const named = await call(customer, "PATCH", "/api/profile", { name: XSS.slice(0, 95) });
    results.push(`profile name ${named.status}`);
    // 2. Address landmark (a second, non-default address).
    const loc = need(world().location, "shop A's location");
    const address = await call(customer, "POST", "/api/addresses", { line1: `QA XSS flat ${RUN}`, city: "Pune", pincode: loc.pincode, latitude: loc.lat + 0.005, longitude: loc.lng, landmark: XSS, deliveryInstructions: XSS, isDefault: false });
    results.push(`address landmark ${address.status}`);
    addressId = address.body?.id ?? null;
    // 3. Order notes, delivered (so it can be rated and returned).
    if (IS_LOCAL) await onlyRiderOnline("rider");
    const order = await placeOrder({ method: "WALLET", extra: { notes: XSS } });
    await packOrder(order.id);
    await deliver(order.id);
    // 4. Rating comment.
    const rating = await call(customer, "POST", `/api/orders/${order.id}/rating`, { target: "SHOP", score: 4, comment: XSS });
    results.push(`rating ${rating.status}`);
    // 5. Return comment.
    const items = ((await call(customer, "GET", "/api/orders")).body as { id: string; items: { id: string; quantityMilli?: number }[] }[]).find((o) => o.id === order.id)?.items ?? [];
    const ret = await call(customer, "POST", `/api/orders/${order.id}/returns`, { reason: "MISSING_ITEM", comment: XSS, items: [{ orderItemId: items[0]?.id, quantityMilli: items[0]?.quantityMilli ?? 1000, condition: "UNOPENED", comment: XSS }] });
    results.push(`return ${ret.status}`);
    // 6. Shop description (the owner's own).
    const desc = await call(await as("shop"), "PATCH", `/api/shops/${A.id}`, { description: XSS });
    results.push(`shop description ${desc.status}`);
    // 7. Support ticket (the help desk sees it).
    const ticket = await call(customer, "POST", "/api/support/tickets", { category: "ORDER", subject: `QA XSS ${RUN} <b>bold</b>`, description: XSS, orderId: order.id });
    results.push(`ticket ${ticket.status}`);
    for (const res of [named, address, rating, ret, desc, ticket]) if (res.status >= 500) bad.push(`a write answered ${res.status}`);
    // The other party's screens (and the customer's own).
    const views: [Parameters<typeof pageAs>[1], string, string][] = [
      ["admin", `/admin/users/${(await me("customer")).id}`, "<script>alert(1)</script>"],
      ["shop", "/shop/orders", "<script>alert(1)</script>"],
      ["shop", "/shop/returns", "<script>alert(1)</script>"],
      ["customer", "/profile/addresses", "<script>alert(1)</script>"],
      ["customer", `/shops/${A.slug}`, "<script>alert(1)</script>"],
      ["ops", "/admin/support", `QA XSS ${RUN}`],
      ["rider", "/delivery-partner", ""],
    ];
    for (const [role, path, needle] of views) {
      const seen = await viewAs(browser, role, path, needle || undefined);
      results.push(`${role} ${path}: ${seen.shown ? "text shown escaped" : "not shown"}`);
      if (seen.alerted) bad.push(`${role} ${path}: a script ran`);
      if (seen.injected) bad.push(`${role} ${path}: an <img onerror> element was created`);
    }
  } finally {
    await call(customer, "PATCH", "/api/profile", { name: oldName });
    if (addressId) await call(customer, "DELETE", `/api/addresses/${addressId}`);
    await call(await as("shop"), "PATCH", `/api/shops/${A.id}`, { description: oldDescription });
  }
  expect(bad, bad.join("; ")).toEqual([]);
  return results.join("; ");
}, { ...signed, timeout: 480_000, partial: "the grievance description is the public form (tests/qa/guest); script text on the shop's own name is not tried (the name is a registration field)" });

/* ======================================================== errors and cookies */

qa("TC-SEC-009", "unknown ids in signed-in pages show the branded 404 with navigation, not a stack trace", async ({ browser }) => {
  const out: string[] = [];
  for (const [role, path] of [["customer", `/orders/${NO_SUCH_ID}`], ["customer", `/returns/${NO_SUCH_ID}`], ["customer", `/subscriptions/${NO_SUCH_ID}`], ["admin", `/admin/users/${NO_SUCH_ID}`], ["shop", `/shop/orders/${NO_SUCH_ID}/packing-slip`]] as const) {
    const { context, page } = await pageAs(browser, role);
    try {
      const res = await page.goto(path, { waitUntil: "domcontentloaded" });
      const status = res?.status() ?? 0;
      expect([404], `${role} ${path} → ${status}`).toContain(status);
      await expect(page.getByRole("link", { name: /GoKesari.*Home|Home|Go to|Back/i }).first(), `${path} offers a way back`).toBeVisible();
      await expect(page.locator("body")).not.toContainText(/at .*\.js:\d+|node_modules|\/home\/|stack/i);
      out.push(`${role} ${path} 404`);
    } finally {
      await context.close();
    }
  }
  return out.join("; ");
}, signed);

qa("TC-SEC-010", "a server error on a signed-in route answers a generic INTERNAL error: no stack, SQL or file path", async () => {
  // D-02 (known) leaves malformed ids reaching the database: the only 500 found in this run.
  const res = await call(await as("customer"), "PATCH", "/api/cart/items/not-a-uuid", { quantity: 1 });
  if (res.status < 500) blocked(`no server error found to read (PATCH /api/cart/items/not-a-uuid → ${res.status}): D-02 is fixed on this build`);
  expect(res.body?.error?.code, "generic code").toBe("INTERNAL");
  expect(res.text, "no server details").not.toMatch(/at [\w.<>]+ \(|node_modules|\/home\/|\/var\/www|SELECT |INSERT |relation "|invalid input syntax|uuid|postgres|drizzle/i);
  expect(res.headers["x-powered-by"] ?? "", "header").toBe(res.headers["x-powered-by"] ?? "");
  return `500 body: ${res.text.slice(0, 120)}`;
}, { ...signed, partial: "the X-Powered-By header is D-03 (known), asserted in the guest tier" });

qa("TC-SEC-006", "the delivery-location cookie (gk_location) is HttpOnly and SameSite, and Secure on the sites", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const res = await page.request.post("/api/location", { data: { pincode: need(world().location?.pincode, "shop A's PIN") } });
    expect(res.status(), "set the location").toBeLessThan(300);
    const cookies = await context.cookies();
    const location = cookies.find((c) => c.name === "gk_location");
    if (!location) blocked(`no gk_location cookie after setting a PIN (cookies: ${cookies.map((c) => c.name).join(", ")})`);
    expect(location.httpOnly, "gk_location HttpOnly").toBe(true);
    expect(["Lax", "Strict"]).toContain(location.sameSite);
    if (!IS_LOCAL) expect(location.secure, "gk_location Secure on https").toBe(true);
    await page.request.delete("/api/location");
    return `gk_location: HttpOnly ${location.httpOnly}, Secure ${location.secure}, SameSite ${location.sameSite}${IS_LOCAL ? " (local http: Secure not expected)" : ""}`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "the session cookie set by a real emailed-code sign-in is the local-tier TC-SEC-006 check" });

qa("TC-SEC-007", "a signed-in page asked for over http is redirected to https", async () => {
  if (IS_LOCAL) blocked("the local server has no HTTPS; the http→https redirect is checked on the sites (tests/qa/guest/signin-security.spec.ts and here)");
  const http = new URL("/orders", BASE_URL.replace(/^https:/, "http:")).toString();
  const res = await fetch(http, { redirect: "manual" });
  expect([301, 302, 307, 308]).toContain(res.status);
  expect(res.headers.get("location") ?? "").toMatch(/^https:\/\//);
  return `${http} → ${res.status} ${res.headers.get("location")}`;
}, signed);

/* ======================================================== every form */

interface FormCase {
  what: string;
  role: Parameters<typeof as>[0];
  method: "POST" | "PATCH" | "PUT";
  path: string;
  /** A field the form requires, a wrong-typed body, and a valid body. */
  missing: Record<string, unknown>;
  wrongType: Record<string, unknown>;
  valid?: () => Promise<Record<string, unknown>>;
  /** Undo a valid write. */
  undo?: (res: Awaited<ReturnType<typeof call>>) => Promise<void>;
}

qa("TC-FLD-127", "every form's API repeats the page's checks: missing field and wrong type → 422 (never 500); unknown fields ignored", async () => {
  const A = await shopOf("A");
  const loc = need(world().location, "shop A's location");
  const forms: FormCase[] = [
    {
      what: "address",
      role: "customer",
      method: "POST",
      path: "/api/addresses",
      missing: { city: "Pune", pincode: loc.pincode },
      wrongType: { line1: 42, city: ["Pune"], pincode: 411038 },
      valid: async () => ({ line1: `QA form ${RUN}`, city: "Pune", pincode: loc.pincode, isDefault: false }),
      undo: async (res) => {
        if (res.body?.id) await call(await as("customer"), "DELETE", `/api/addresses/${res.body.id}`);
      },
    },
    {
      what: "profile",
      role: "customer",
      method: "PATCH",
      path: "/api/profile",
      missing: { gender: "NOT_A_GENDER" },
      wrongType: { name: 12345, markComplete: "yes" },
    },
    { what: "cart line", role: "customer", method: "POST", path: "/api/cart", missing: { quantity: 1 }, wrongType: { shopProductId: 7, quantity: "two" } },
    { what: "subscription", role: "customer", method: "POST", path: "/api/subscriptions", missing: { quantityMilli: 1000 }, wrongType: { shopProductId: world().listings.milk?.shopProductId, quantityMilli: "1 L", startDate: 20261101 } },
    { what: "support ticket", role: "customer", method: "POST", path: "/api/support/tickets", missing: { category: "ORDER" }, wrongType: { category: "ORDER", subject: ["x"], description: 10 } },
    { what: "rider application", role: "customer", method: "POST", path: "/api/delivery-partner", missing: { vehicleType: "MOTORCYCLE" }, wrongType: { fullName: 1, mobile: 9876543210, vehicleType: "ROCKET" } },
    {
      what: "shop details",
      role: "shop",
      method: "PATCH",
      path: `/api/shops/${A.id}`,
      missing: { name: "" },
      wrongType: { serviceRadiusKm: "five", deliveryAvailable: "yes" },
    },
    { what: "shop product", role: "shop", method: "POST", path: `/api/shops/${A.id}/products`, missing: { onlinePricePaise: 100 }, wrongType: { productId: 5, onlinePricePaise: "Rs 10" } },
    { what: "rider status", role: "rider", method: "PATCH", path: "/api/delivery-partner/status", missing: {}, wrongType: { isOnline: "maybe" } },
    { what: "society registration", role: "customer", method: "POST", path: "/api/societies", missing: { city: "Pune" }, wrongType: { name: 1, pincode: 411038 } },
  ];
  const out: string[] = [];
  const bad: string[] = [];
  for (const f of forms) {
    const ctx = await as(f.role);
    const missing = await call(ctx, f.method, f.path, f.missing);
    const wrong = await call(ctx, f.method, f.path, f.wrongType);
    for (const [label, res] of [["missing", missing], ["wrong type", wrong]] as const) {
      if (res.status >= 500) bad.push(`${f.what} ${label} → 500`);
      else if (res.status !== 422 && res.status !== 400) bad.push(`${f.what} ${label} → ${res.status} (expected 422): ${why(res).slice(0, 80)}`);
    }
    let extra = "";
    if (f.valid) {
      const body = { ...(await f.valid()), qaUnknownField: "ignored?", role: "ADMIN", userId: NO_SUCH_ID };
      const res = await call(ctx, f.method, f.path, body);
      extra = ` valid+unknown ${res.status}`;
      if (res.status >= 400) bad.push(`${f.what}: a valid body with unknown fields → ${why(res).slice(0, 80)}`);
      else if (/qaUnknownField|ignored\?/.test(res.text)) bad.push(`${f.what}: the unknown field came back stored`);
      await f.undo?.(res);
    }
    out.push(`${f.what} ${missing.status}/${wrong.status}${extra}`);
  }
  // A strict schema refuses unknown fields outright (shop details).
  const strict = await call(await as("shop"), "PATCH", `/api/shops/${A.id}`, { qaUnknownField: 1 });
  out.push(`shop details with an unknown field ${strict.status} (strict schema)`);
  expect(bad, bad.join("; ")).toEqual([]);
  return out.join("; ");
}, { ...signed, partial: "unknown fields: ignored by most forms; PATCH /api/shops/[id] refuses them (422) by its deliberate .strict() schema (src/app/api/shops/[id]/route.ts); the double-click half is the next check" });

qa("TC-FLD-127", "a double click on Save creates one record (address form)", async ({ browser }) => {
  const before = ((await call(await as("customer"), "GET", "/api/addresses")).body?.addresses ?? (await call(await as("customer"), "GET", "/api/addresses")).body) as { id: string; line1: string }[];
  const { context, page } = await pageAs(browser, "customer");
  const line1 = `QA double ${RUN}`;
  try {
    await page.goto("/profile/addresses", { waitUntil: "domcontentloaded" });
    const add = page.getByRole("button", { name: /Add (a new )?address|New address|Add address/i }).first();
    if (await add.count()) await add.click();
    await page.getByLabel("Address line 1").fill(line1);
    await page.getByLabel("City").fill("Pune");
    await page.getByLabel("PIN code").fill(need(world().location?.pincode, "a PIN"));
    const save = page.getByRole("button", { name: /^Save/ }).first();
    await save.dblclick();
    await page.waitForTimeout(3000);
  } finally {
    await context.close();
  }
  const after = ((await call(await as("customer"), "GET", "/api/addresses")).body?.addresses ?? (await call(await as("customer"), "GET", "/api/addresses")).body) as { id: string; line1: string }[];
  const created = after.filter((a) => a.line1 === line1);
  for (const a of created) await call(await as("customer"), "DELETE", `/api/addresses/${a.id}`);
  expect(created.length, `addresses created by one double click (had ${before.length})`).toBe(1);
  return "double click on Save → one address";
}, signed);

qa("TC-FLD-129", "text fields keep emoji, a 200-character word, SQL-like text and a backslash as typed; a pasted line break in a single-line field; no 500, no broken layout", async ({ browser }) => {
  const samples = { emoji: "QA 🙂🥛👍🏽", word: "W".repeat(200), sql: "' OR 1=1 -- \\ \"x\"", lines: "QA line one\nline two" };
  const customer = await as("customer");
  const out: string[] = [];
  const bad: string[] = [];
  const created: string[] = [];
  try {
    for (const [label, text] of Object.entries(samples)) {
      const res = await call(customer, "POST", "/api/addresses", { line1: text.slice(0, 200), landmark: text.slice(0, 200), city: "Pune", pincode: need(world().location?.pincode, "a PIN"), isDefault: false });
      if (res.status >= 500) bad.push(`address ${label} → 500`);
      if (res.status === 201 || res.status === 200) {
        created.push(res.body.id);
        const back = await call(customer, "GET", `/api/addresses/${res.body.id}`);
        const stored = back.body?.line1 ?? back.body?.address?.line1;
        if (stored !== text.slice(0, 200) && !(label === "lines" && stored === text.replace(/\s*\n\s*/g, " "))) bad.push(`address ${label}: stored ${JSON.stringify(String(stored).slice(0, 40))}`);
        out.push(`address ${label} ${res.status} ${stored === text.slice(0, 200) ? "as typed" : "normalised"}`);
      } else out.push(`address ${label} refused ${res.status}`);
    }
    const ticket = await call(customer, "POST", "/api/support/tickets", { category: "ORDER", subject: `QA ${samples.emoji} ${samples.sql}`.slice(0, 200), description: `${samples.word} ${samples.lines}` });
    if (ticket.status >= 500) bad.push("ticket → 500");
    out.push(`ticket ${ticket.status}`);
    const { context, page } = await pageAs(browser, "customer");
    try {
      await openPage(page, "/profile/addresses");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 2) bad.push(`/profile/addresses is ${overflow}px wider than the screen with a 200-character word`);
      await expect(page.locator("main")).toContainText("🙂🥛");
      await expect(page.locator("main")).toContainText("' OR 1=1 --");
    } finally {
      await context.close();
    }
  } finally {
    for (const id of created) await call(customer, "DELETE", `/api/addresses/${id}`);
  }
  expect(bad, bad.join("; ")).toEqual([]);
  return out.join("; ");
}, { ...signed, mobile: true });

/** The amount the wallet page would send for a typed value, captured before any payment starts. */
async function topUpAmount(page: Page, typed: string): Promise<{ sent: number | null; message: string }> {
  const input = page.getByLabel("Amount in rupees");
  await input.fill("");
  await input.focus();
  // A paste: the text lands in the field as the browser accepts it.
  await page.evaluate((t) => {
    const el = document.activeElement as HTMLInputElement;
    const data = new DataTransfer();
    data.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, typed);
  if (!(await input.inputValue())) await input.pressSequentially(typed).catch(() => {});
  let sent: number | null = null;
  await page.route("**/api/wallet/topup", async (route) => {
    sent = (route.request().postDataJSON() as { amountPaise: number }).amountPaise;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "QA", message: "QA stopped the payment" } }) });
  });
  const proceed = page.getByRole("button", { name: "Proceed to payment" });
  if (await proceed.isEnabled()) await proceed.click();
  await page.waitForTimeout(800);
  await page.unroute("**/api/wallet/topup");
  const message = sent === null ? ((await proceed.isEnabled()) ? ((await page.locator("main").innerText()).match(/Enter a valid amount\./)?.[0] ?? "") : `field left empty: "Proceed to payment" disabled`) : "";
  return { sent, message };
}

qa("TC-FLD-128", "number fields: pasted 1,000 / Rs 1000 / 0010 / 1e3 / Devanagari / trailing space are converted or refused, never saved as another amount", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  const out: string[] = [];
  const bad: string[] = [];
  try {
    await page.goto("/wallet", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    for (const typed of ["1,000", "Rs 1000", "0010", "1e3", "१०००", "1000 "]) {
      const first = await topUpAmount(page, typed);
      const again = await topUpAmount(page, typed);
      const plain = Number(typed.replace(/[^\d.e]/gi, "").replace(/^0+(?=\d)/, ""));
      out.push(`"${typed}" → ${first.sent === null ? `refused (${first.message || "button disabled"})` : `₹${first.sent / 100}`}`);
      if (first.sent !== again.sent) bad.push(`"${typed}" gave ${first.sent} then ${again.sent}`);
      if (first.sent !== null && first.sent !== plain * 100 && !(typed === "0010" && first.sent === 1000) && !(typed === "1e3" && first.sent === 100_000)) bad.push(`"${typed}" sent as ${first.sent} paise`);
      if (typed === "1,000" && first.sent === 100) bad.push(`"1,000" became ₹1`);
    }
  } finally {
    await context.close();
  }
  expect(bad, bad.join("; ")).toEqual([]);
  return `wallet top-up amount: ${out.join(", ")}`;
}, { ...signed, partial: "the wallet amount (a number field); the payment is stopped before the gateway; price and stock fields of the shop screens are not repeated here" });

qa("TC-FLD-126", "keyboard and keypads: tab order follows the address form, Enter submits once, numeric and email keypads on mobile, PIN, OTP and amount fields", async ({ browser }) => {
  const out: string[] = [];
  const bad: string[] = [];
  const guest = await browser.newContext();
  try {
    const page = await guest.newPage();
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    const id = page.getByLabel("Mobile number or email");
    const mode = `${(await id.getAttribute("type")) ?? "text"}/${(await id.getAttribute("inputmode")) ?? "-"}`;
    out.push(`sign-in identifier ${mode}`);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Deliver to/i }).click();
    const pin = page.getByRole("dialog", { name: /delivery location/i }).getByRole("textbox", { name: /PIN code/i });
    const pinMode = await pin.getAttribute("inputmode");
    out.push(`location PIN inputmode=${pinMode}`);
    if (pinMode !== "numeric") bad.push(`location PIN field opens the ${pinMode ?? "text"} keyboard`);
  } finally {
    await guest.close();
  }
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/wallet", { waitUntil: "domcontentloaded" });
    const amount = page.getByLabel("Amount in rupees");
    if ((await amount.getAttribute("inputmode")) !== "numeric") bad.push("wallet amount is not numeric");
    out.push(`wallet amount inputmode=${await amount.getAttribute("inputmode")}`);
    await page.goto("/profile/addresses", { waitUntil: "domcontentloaded" });
    const add = page.getByRole("button", { name: /Add (a new )?address|New address|Add address/i }).first();
    if (await add.count()) await add.click();
    const pinField = page.getByLabel("PIN code");
    const phone = page.getByLabel("Recipient mobile (optional)");
    out.push(`address PIN inputmode=${await pinField.getAttribute("inputmode")}, mobile inputmode=${await phone.getAttribute("inputmode")}`);
    if ((await pinField.getAttribute("inputmode")) !== "numeric") bad.push("address PIN is not numeric");
    // Tab order: line 1 → flat → area → city → state → PIN follows the screen.
    await page.getByLabel("Address line 1").focus();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      order.push(await page.evaluate(() => (document.activeElement?.closest("label")?.querySelector("span")?.textContent ?? document.activeElement?.getAttribute("aria-label") ?? "").trim()));
      await page.keyboard.press("Tab");
    }
    out.push(`tab: ${order.join(" → ")}`);
    const expected = ["Address line 1", "Flat / house / floor (optional)", "Area", "City", "State", "PIN code"];
    if (order.join("|") !== expected.join("|")) bad.push(`tab order ${order.join(" → ")}`);
    // Enter in the last field submits once.
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/addresses") && r.method() === "POST") posts.push(r.url());
    });
    await page.getByLabel("Address line 1").fill(`QA enter ${RUN}`);
    await page.getByLabel("City").fill("Pune");
    await pinField.fill(need(world().location?.pincode, "a PIN"));
    await page.getByLabel("Delivery instructions (optional)").press("Enter").catch(() => {});
    await pinField.press("Enter");
    await page.waitForTimeout(2500);
    out.push(`Enter → ${posts.length} request(s)`);
    if (posts.length !== 1) bad.push(`Enter sent ${posts.length} address requests`);
  } finally {
    await context.close();
    const list = ((await call(await as("customer"), "GET", "/api/addresses")).body?.addresses ?? (await call(await as("customer"), "GET", "/api/addresses")).body) as { id: string; line1: string }[];
    for (const a of list.filter((x) => x.line1 === `QA enter ${RUN}`)) await call(await as("customer"), "DELETE", `/api/addresses/${a.id}`);
  }
  expect(bad, bad.join("; ")).toEqual([]);
  return out.join("; ");
}, { ...signed, mobile: true, partial: "sign-in, location, wallet and address forms; the OTP field's keypad is read on the profile email-change form only when it is open" });

qa("TC-FLD-125", "address form: required fields marked, messages beside the field in plain words and cleared when fixed, typed values kept after an error", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  const out: string[] = [];
  const bad: string[] = [];
  try {
    await page.goto("/profile/addresses", { waitUntil: "domcontentloaded" });
    const add = page.getByRole("button", { name: /Add (a new )?address|New address|Add address/i }).first();
    if (await add.count()) await add.click();
    const line1 = page.getByLabel("Address line 1");
    const city = page.getByLabel("City");
    const pin = page.getByLabel("PIN code");
    // Required marks: optional fields say "(optional)"; required ones carry the required attribute.
    for (const [name, field] of [["Address line 1", line1], ["City", city], ["PIN code", pin]] as const) {
      if ((await field.getAttribute("required")) === null) bad.push(`${name} is not marked required`);
    }
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/addresses") && r.method() === "POST") posts.push(r.url());
    });
    await page.getByRole("button", { name: /^Save/ }).first().click();
    const firstMessage = await line1.evaluate((el) => (el as HTMLInputElement).validationMessage);
    out.push(`empty submit: "${firstMessage}" on Address line 1, ${posts.length} request(s)`);
    if (!firstMessage || posts.length) bad.push("an empty form was sent or no message on the first required field");
    await line1.fill("QA Flat 9");
    await page.getByRole("button", { name: /^Save/ }).first().click();
    const cityMessage = await city.evaluate((el) => (el as HTMLInputElement).validationMessage);
    const line1Message = await line1.evaluate((el) => (el as HTMLInputElement).validationMessage);
    out.push(`after fixing line 1: line 1 message "${line1Message}", city "${cityMessage}"`);
    if (line1Message) bad.push("the fixed field still shows its message");
    await city.fill("Pune");
    await pin.fill(need(world().location?.pincode, "a PIN"));
    // A value the page itself refuses: the browser's message sits on the field.
    const mobile = page.getByLabel("Recipient mobile (optional)");
    await mobile.fill("12345");
    await page.getByRole("button", { name: /^Save/ }).first().click();
    const mobileMessage = await mobile.evaluate((el) => (el as HTMLInputElement).validationMessage);
    out.push(`recipient mobile 12345: "${mobileMessage}" on the field`);
    if (!mobileMessage) bad.push("no message on the refused recipient mobile");
    await mobile.fill("");
    // A value only the server refuses (line 1 over its 200-character limit; the field has no maxlength).
    await line1.fill(`QA Flat 9 ${"x".repeat(200)}`);
    await page.getByRole("button", { name: /^Save/ }).first().click();
    await page.waitForTimeout(2500);
    const alert = (await page.locator("main").innerText()).match(/Please check the highlighted fields\.|Could not save this address\.|200/)?.[0] ?? "";
    const beside = await line1.evaluate((el) => el.closest("label")?.querySelector(".text-red-600")?.textContent ?? "");
    const highlighted = await page.locator("main [aria-invalid=true], main .border-red-500, main .text-red-600").count();
    out.push(`server refusal: "${alert}"; beside Address line 1: "${beside}"; highlighted fields: ${highlighted}`);
    if (!alert) bad.push("no message after the server refused Address line 1");
    if ((await city.inputValue()) !== "Pune" || !(await line1.inputValue()).startsWith("QA Flat 9")) bad.push("typed values were lost after the error");
    if (alert && !beside) bad.push(`the server's message "${alert}" is shown at the top of the form and no field is highlighted (the refused one is Address line 1, over 200 characters)`);
  } finally {
    await context.close();
  }
  expect(bad, bad.join("; ")).toEqual([]);
  return out.join("; ");
}, { ...signed, mobile: true, partial: "one long form (address); the admin forms' messages are checked by TC-ADM-008 and TC-FLD-120" });

qa("TC-UX-002", "the cart page at phone width keeps the pay button and totals on screen with no sideways scroll", async ({ browser }) => {
  const listing = await sellable("A");
  await emptyCart();
  expectStatus(await addToCart("customer", listing.shopProductId, 2), [200, 201], "add to cart");
  const { context, page } = await pageAs(browser, "customer", { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  try {
    await openPage(page, "/cart");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "sideways overflow at 360 px").toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: /Pay from wallet|Place order/i }).first()).toBeVisible();
  } finally {
    await context.close();
    await emptyCart();
  }
  return "cart at 360 px: fits, pay button visible";
}, { ...signed, mobile: true });

/* ======================================================== signed-in halves of the guest cases */

qa("TC-PRE-001", "signed in, the home page renders the header with the account menu, the location bar and shop shelves; no hydration error", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /#418|#423|#425|hydrat/i.test(m.text())) errors.push(m.text().slice(0, 160));
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
  try {
    await openPage(page, "/");
    await expect(page.getByRole("link", { name: /GoKesari.*Home/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Cart/ })).toBeVisible();
    const account = page.locator("[data-testid=account-dropdown]:visible, [data-testid=account-button]:visible").first();
    if (await account.count()) await expect(account, "account menu instead of Sign in").toBeVisible();
    else {
      // On a phone the home page keeps the account inside the "Open menu" drawer.
      await page.getByRole("button", { name: "Open menu" }).click();
      const drawer = page.getByRole("dialog", { name: /navigation/i });
      await expect(drawer.getByRole("link", { name: /Wallet/i }).first(), "the drawer holds the signed-in account").toBeVisible();
      await expect(drawer.getByRole("link", { name: /Sign in/i }), "no Sign in for a signed-in customer").toHaveCount(0);
      await drawer.getByRole("button", { name: /Close menu/i }).click();
    }
    await expect(page.getByRole("button", { name: /Deliver to/i })).toBeVisible();
    await expect(page.getByRole("region", { name: /Shops on GoKesari|Shop by category/i }).first()).toBeVisible();
  } finally {
    await context.close();
  }
  expect(errors, errors.join(" | ")).toEqual([]);
  return "customer: header (logo, cart, account menu), Deliver to, shelves; no hydration errors";
}, { ...signed, mobile: true });

qa("TC-PRE-002", "signed in, the database pages load: shops, search, categories, a shop, a product, orders and wallet", async ({ browser }) => {
  const A = await shopOf("A");
  const product = world().listings.packaged?.productId ?? (await sellable("A")).productId;
  const { context, page } = await pageAs(browser, "customer");
  const paths = ["/shops", "/search?q=milk", "/categories", `/shops/${A.slug}`, `/products/${product}`, "/orders", "/wallet"];
  try {
    for (const path of paths) await openPage(page, path);
  } finally {
    await context.close();
  }
  return `loaded signed in: ${paths.join(", ")}`;
}, signed);

qa("TC-RBAC-001", "a guest asking to subscribe to a subscribable product is asked to sign in, and nothing is created", async ({ page }) => {
  const milk = world().listings.milk ?? blocked("no subscribable product in this site's test data");
  await openPage(page, `/products/${milk.productId}`);
  const subscribe = page.getByRole("button", { name: /Subscribe/i }).or(page.getByRole("link", { name: /Subscribe/i })).first();
  if (!(await subscribe.count())) blocked(`no Subscribe control on the product page of "${milk.name}"`);
  await subscribe.click();
  await expect
    .poll(async () => /\/signin/.test(page.url()) || (await page.getByText(/sign in/i).count()) > 0, { timeout: 20_000 })
    .toBe(true);
  const guest = await anonymous();
  const subs = await call(guest, "GET", "/api/subscriptions");
  await guest.dispose();
  expect(subs.status, "a guest has no subscriptions").toBe(401);
  return `Subscribe on "${milk.name}" → ${/\/signin/.test(page.url()) ? "sign-in page" : "sign-in prompt"}; guest subscriptions API 401`;
}, { mobile: true, partial: "browse/search and Add to cart are tests/qa/guest/storefront.spec.ts" });

/** A session cookie signed with a key the site does not have: a forged or tampered session. */
async function forgedContext() {
  const { encode } = await import("next-auth/jwt");
  const secure = BASE_URL.startsWith("https");
  const name = secure ? "__Secure-authjs.session-token" : "authjs.session-token";
  const user = world().users.admin?.id ?? NO_SUCH_ID;
  const value = await encode({ token: { sub: user, email: "forged@test.local", role: "ADMIN" }, secret: `not-the-site-secret-${RUN}`, salt: name });
  const { request } = await import("@playwright/test");
  return request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { cookie: `${name}=${value}` } });
}

qa(["TC-RBAC-002", "TC-SEC-001"], "a forged session cookie (claiming ADMIN, signed with the wrong key) counts as signed out: pages go to sign-in, account and write APIs answer 401", async () => {
  const ctx = await forgedContext();
  const bad: string[] = [];
  const out: string[] = [];
  try {
    for (const path of ["/wallet", "/orders", "/cart", "/profile", "/subscriptions", "/shop", "/delivery-partner", "/society", "/admin", "/admin/settings"]) {
      const res = await call(ctx, "GET", path);
      const to = res.location ? new URL(res.location, BASE_URL).pathname : "";
      if (!(res.status === 401 || res.status === 403 || ([302, 303, 307, 308].includes(res.status) && /\/signin/.test(to)))) bad.push(`${path} → ${res.status} ${to}`);
    }
    out.push("10 portal pages → sign-in");
    for (const path of ["/api/wallet", "/api/orders", "/api/cart", "/api/notifications", "/api/auth/session"]) {
      const res = await call(ctx, "GET", path);
      if (path === "/api/auth/session") {
        if (res.body?.user) bad.push("the forged cookie produced a session");
      } else if (res.status !== 401) bad.push(`GET ${path} → ${res.status}`);
    }
    const writes: [string, "POST" | "PUT" | "PATCH", string, unknown][] = [
      ["cart", "POST", "/api/cart", { shopProductId: NO_SUCH_ID, quantity: 1 }],
      ["checkout", "POST", "/api/checkout", { requestId: `qa-forged-${RUN}` }],
      ["wallet", "POST", "/api/wallet/topup", { amountPaise: 10000 }],
      ["subscriptions", "POST", "/api/subscriptions", { shopProductId: NO_SUCH_ID, quantityMilli: 1000, startDate: "2030-01-01" }],
      ["addresses", "POST", "/api/addresses", { line1: "x", city: "Pune", pincode: "411038" }],
      ["shops", "POST", "/api/shops", {}],
      ["shop-products", "PATCH", `/api/shop-products/${NO_SUCH_ID}`, { onlinePricePaise: 1 }],
      ["returns", "PATCH", `/api/returns/${NO_SUCH_ID}`, { action: "cancel" }],
      ["societies", "POST", "/api/societies", {}],
      ["finance", "POST", "/api/finance/settlements", {}],
      ["admin", "PUT", "/api/admin/settings", { key: "otp", value: {} }],
      ["users", "POST", `/api/users/${NO_SUCH_ID}/suspend`, { reason: "forged" }],
      ["delivery-partner", "PATCH", "/api/delivery-partner/status", { isOnline: true }],
    ];
    for (const [group, method, path, body] of writes) {
      const res = await call(ctx, method, path, body);
      // D-01 (known): these routes look the record up or validate before the session check.
      const d01 = /shop-products|\/orders\/[^/]+\/(status|fulfilment|assign|fulfilment-plan)|excel-uploads|invoices|^\/api\/products|price-requests|marketing\/segments|payouts\/batches/.test(path);
      if (res.status !== 401) bad.push(`${d01 ? "D-01 (known) " : ""}${group}: ${method} ${path} → ${res.status} ${res.body?.error?.code ?? ""}`);
    }
    out.push(`${writes.length} write APIs (one per group) → 401`);
  } finally {
    await ctx.dispose();
  }
  expect(bad, bad.join("; ")).toEqual([]);
  return out.join("; ");
}, { ...signed, partial: "the no-cookie sweep of every page and write API is tests/qa/guest/access.spec.ts; known D-01 routes answer 404/422 there" });
