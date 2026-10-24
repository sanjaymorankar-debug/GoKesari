/**
 * The admin and operations console, analytics and the signed-in site as each
 * role uses it (QA package 2): preflight of the deployed build and its data,
 * the admin dashboard and its figures, order monitoring, the shop dashboard,
 * the risk queue, consents, compliance and Maps panels, the operator
 * landing, marketplace analytics, header navigation by role, the phone
 * layout, console errors and the unsaved-changes guard.
 *
 * Signed-in tier: test accounts on their own data; nothing here changes a
 * business rule, suspends or approves anything (that is tests/qa/local).
 */
import type { Page } from "@playwright/test";

import { as, me, pageAs } from "../lib/actors";
import { addToCart, deliver, emptyCart, onlyRiderOnline, packOrder, placeOrder, sellable, shopOf, walletBalance } from "../lib/flows";
import { call, expectStatus, RUN, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { IS_LOCAL, IS_REMOTE } from "../lib/target";
import { world, type Role } from "../lib/world";
import { brief, getAs, listRules, openPage, redirectPath, sidewaysOverflow, societyId, watchErrors } from "../lib/access-helpers";

const signed = { tier: "signed" as const, timeout: 300_000 };

/** The visible text of a server-rendered page's main area (scripts and tags stripped). */
function mainText(html: string) {
  const start = html.indexOf("<main");
  const body = start >= 0 ? html.slice(start) : html;
  return body
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

/** Internal links of a page's main area (no assets, no footer legal pages). */
function mainLinks(html: string) {
  const start = html.indexOf("<main");
  const body = start >= 0 ? html.slice(start) : html;
  const footer = body.indexOf("<footer");
  const scope = footer > 0 ? body.slice(0, footer) : body;
  return [...new Set([...scope.matchAll(/href="(\/[^"#?]*)(?:\?[^"#]*)?"/g)].map((m) => m[1]))].filter((h) => !/^\/(_next|brand|api\/|legal\/)|\.(png|ico|css|js|webmanifest)$/.test(h));
}

/** Today's date in IST (the app's business day). */
function istToday(offsetDays = 0) {
  return new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/* ======================================================== preflight */

const PREFLIGHT_ADMIN_PAGES = [
  "/admin/dashboard",
  "/admin/orders",
  "/admin/exceptions",
  "/admin/settings",
  "/admin/suspensions",
  "/admin/rider-earnings",
  "/admin/price-references",
  "/admin/mrp",
  "/admin/shop-categories",
  "/admin/returns",
  "/admin/cod",
  "/admin/risk",
  "/admin/analytics",
  "/admin/campaigns",
  "/admin/societies",
  "/admin/product-master",
  "/admin/consents",
  "/admin/ratings",
];

qa("TC-PRE-003", "every admin page of the preflight list loads for the admin (no 404, no 500, no error page)", async ({ page, browser }) => {
  void page;
  const { context, page: admin } = await pageAs(browser, "admin");
  const loaded: string[] = [];
  const bad: string[] = [];
  try {
    for (const path of PREFLIGHT_ADMIN_PAGES) {
      const res = await admin.goto(path, { waitUntil: "domcontentloaded" });
      const status = res?.status() ?? 0;
      const errorPage = await admin.locator("body").getByText(/Something went wrong|Application error|Internal Server Error|This page could not be found/i).count();
      if (status !== 200 || errorPage > 0 || new URL(admin.url()).pathname !== path) bad.push(`${path} → ${status}${errorPage ? " error page" : ""} at ${new URL(admin.url()).pathname}`);
      else loaded.push(path);
    }
  } finally {
    await context.close();
  }
  expect(bad, bad.join("; ")).toEqual([]);
  return `${loaded.length}/${PREFLIGHT_ADMIN_PAGES.length} admin pages load: none blocks a module`;
}, signed);

qa("TC-PRE-004", "business rules: the nine original rule groups are listed with default and current values; overrides recorded", async ({ browser }) => {
  const rules = await listRules();
  const nine = ["otp", "dispatch", "riderEarnings", "returns", "images", "notifications", "suspension", "mrp", "externalPrices"];
  const keys = rules.map((r) => r.key);
  expect(keys, "the nine groups the plan names").toEqual(expect.arrayContaining(nine));
  for (const r of rules) {
    expect(r.defaults, `${r.key} has defaults`).toBeTruthy();
    expect(r.value, `${r.key} has a current value`).toBeTruthy();
  }
  const overridden = rules.filter((r) => r.overridden).map((r) => r.key);
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/settings?q=otp", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("rule-list")).toContainText("otp");
    await expect(page.getByTestId("rule-list")).toContainText(/default|customised/);
  } finally {
    await context.close();
  }
  return `${rules.length} rule groups (the plan's nine all present; superseded: the console now has ${rules.length}); non-default: ${overridden.length ? overridden.join(", ") : "none"}`;
}, { ...signed, partial: "restoring overridden rules to their defaults is admin-settings work kept to the local tier (tests/qa/local/access-admin.spec.ts)" });

qa("TC-PRE-008", "seed data is sufficient: shop A, shop B with a shared product at another price, customer 1's address and wallet, a loose product, shop C empty", async () => {
  const A = await shopOf("A");
  const B = await shopOf("B");
  const out: string[] = [];
  const shopA = (await getAs("guest", `/api/shops/${A.id}`)).body;
  expect(shopA?.deliveryAvailable, "shop A delivers").toBe(true);
  const inventory = await call(await as("shop"), "GET", `/api/shops/${A.id}/inventory`);
  expectStatus(inventory, 200, "shop A inventory");
  const rows = (inventory.body?.rows ?? []) as { productName: string; available: number; onlinePricePaise: number | null; productId: string }[];
  const stocked = rows.filter((r) => r.available >= 20);
  expect(stocked.length, "3+ products with stock >= 20").toBeGreaterThanOrEqual(3);
  out.push(`A: ${stocked.length} products with 20+ in stock`);
  const storefrontA = (await getAs("guest", `/api/shops/${A.id}/products?limit=100`)).body as { productId: string; productName: string; onlinePricePaise: number | null }[];
  // The storefront API carries no MRP; the product page shows it.
  let withMrp: string | null = null;
  for (const p of storefrontA.slice(0, 12)) {
    const productPage = await getAs("guest", `/products/${p.productId}`);
    if (productPage.status === 200 && /MRP/.test(mainText(productPage.text))) {
      withMrp = p.productName;
      break;
    }
  }
  expect(withMrp, "a packaged product of shop A shows an MRP").not.toBeNull();
  const storefrontB = (await getAs("guest", `/api/shops/${B.id}/products?limit=100`)).body as { productId: string; onlinePricePaise: number | null }[];
  const shared = storefrontB.find((b) => storefrontA.some((a) => a.productId === b.productId && a.onlinePricePaise !== b.onlinePricePaise));
  expect(shared, "shop B sells a product of shop A at another price").toBeTruthy();
  const shopB = (await getAs("guest", `/api/shops/${B.id}`)).body;
  expect(shopB?.pincode, "shop B in shop A's PIN").toBe(shopA?.pincode);
  out.push(`A: "${withMrp}" shows an MRP; B: shared product at ${shared?.onlinePricePaise} paise, PIN ${shopB?.pincode}`);
  const address = (await call(await as("customer"), "GET", "/api/addresses")).body;
  const list = (address?.addresses ?? address ?? []) as { isDefault: boolean; latitude: string | null; longitude: string | null }[];
  const home = list.find((a) => a.isDefault) ?? list[0];
  expect(home?.latitude && home?.longitude, "customer 1's address has coordinates").toBeTruthy();
  const balance = await walletBalance("customer");
  expect(balance, "customer 1's wallet >= Rs 2,000").toBeGreaterThanOrEqual(200_000);
  out.push(`customer 1: address with coordinates, wallet ₹${balance / 100}`);
  const loose = world().listings.loose ?? world().listings.unpricedLoose;
  if (loose) expect(rows.some((r) => r.productId === loose.productId), "a loose product in shop A").toBe(true);
  out.push(`loose product: ${loose ? loose.name : "not named in this world"}`);
  const C = world().shops.C ? await shopOf("C") : null;
  if (C) {
    const products = (await getAs("guest", `/api/shops/${C.id}/products?limit=10`)).body as unknown[];
    expect(products.length, "shop C has no products").toBe(0);
    out.push("shop C approved, empty");
  } else out.push("shop C: not in this world");
  return out.join("; ");
}, { ...signed, partial: "'category X with 5+ master products (one unpriced, one loose, one listed by A)' is checked through the product-category specs; shop C is not in the staging world" });

qa("TC-PRE-011", "record whether the 3-Oct requirements are deployed: loose price not pre-filled, owner adds a product category, MRP owner-editable", async () => {
  const A = await shopOf("A");
  const out: string[] = [];
  const inventory = (await call(await as("shop"), "GET", `/api/shops/${A.id}/inventory`)).body?.rows as { productId: string; onlinePricePaise: number | null; productName: string }[];
  const unpriced = world().listings.unpricedLoose;
  if (unpriced) {
    const row = inventory.find((r) => r.productId === unpriced.productId);
    out.push(`NEW-008 loose product added without a price: ${row ? (row.onlinePricePaise === null ? "no price pre-filled (owner must price it) — present" : `price ${row.onlinePricePaise} pre-filled`) : "not listed"}`);
  } else out.push("NEW-008: no unpriced loose listing in this world to look at");
  const categories = await getAs("shop", "/shop/product-categories");
  expect(categories.status).toBe(200);
  const canAdd = /Add a category/.test(categories.text);
  out.push(`NEW-009 owner adds a product category on /shop/product-categories: ${canAdd ? "present" : "absent"}`);
  const mrpWrite = await call(await as("shop"), "POST", "/api/mrp", { productId: world().listings.packaged?.productId, mrpPaise: 1 });
  const dispute = await call(await as("shop"), "GET", "/api/mrp/corrections");
  out.push(`NEW-010 MRP: owner write ${mrpWrite.status} (${mrpWrite.status === 403 ? "not editable by the owner; disputes go to /api/mrp/corrections" : "editable"}), corrections list ${dispute.status}`);
  expect(categories.status).toBe(200);
  return out.join("; ");
}, { ...signed, partial: "record-only (the case decides Blocked vs run for later modules); src/server/authz/permissions.ts documents the owner may dispute an MRP but never write it (§13)" });

qa("TC-PRE-012", "record which of the open features treated as completed are deployed", async () => {
  const rules = new Map((await listRules()).map((r) => [r.key, r.value as Record<string, unknown>]));
  const A = await shopOf("A");
  const present: string[] = [];
  const probe = async (label: string, role: Role | "guest", path: string, ok: (status: number) => boolean = (s) => s === 200) => {
    const res = await getAs(role, path);
    present.push(`${label}: ${ok(res.status) ? "present" : `absent (${brief(res)})`}`);
  };
  present.push(`SMS sign-in code: rule otp.smsEnabled=${rules.get("otp")?.smsEnabled}`);
  await probe("SMS/WhatsApp/push channels (notification preferences)", "customer", "/api/notifications/preferences");
  present.push(`online payment at checkout: rule onlinePayments.enabled=${rules.get("onlinePayments")?.enabled}`);
  present.push(`coupon field: rule coupons.enabled=${rules.get("coupons")?.enabled}`);
  await probe("scheduled slots", "customer", "/api/checkout/scheduled-slots", (s) => s < 500 && s !== 404);
  present.push(`master order reference: rule parentOrders.enabled=${rules.get("parentOrders")?.enabled}`);
  await probe("shop KYC document upload", "shop", "/shop/documents");
  await probe("rider profile edit", "rider", "/gig/profile");
  await probe("image moderation queue", "admin", "/admin/image-moderation");
  await probe("customer referral", "customer", "/refer");
  present.push(`home comparison widgets: rule homePriceComparison.enabled=${rules.get("homePriceComparison")?.enabled}`);
  await probe("shop-page offers", "shop", `/api/shops/${A.id}/offers`);
  present.push(`tax invoice: rule invoicing.enabled=${rules.get("invoicing")?.enabled}`);
  present.push(`photo proof of delivery: rule deliveryProof=${JSON.stringify(rules.get("deliveryProof") ?? {}).slice(0, 60)}`);
  return present.join("; ");
}, { ...signed, partial: "record-only: presence of each screen/API and the switch of its business rule; the features' own cases test their behaviour" });

/* ======================================================== admin dashboard */

qa("TC-ADM-001", "admin dashboard (control tower): every section is there and every link opens a real page", async () => {
  const res = await getAs("admin", "/admin/dashboard");
  expect(res.status).toBe(200);
  const text = mainText(res.text);
  const sections = [
    "Orders placed",
    "Orders in flight",
    "Riders online",
    "Shops awaiting approval",
    "Open risk flags",
    "Operational exceptions",
    "Rider searches stopped today",
    "Inventory exceptions",
    "Returns open",
    "Refunded today",
    "MRP corrections to decide",
    "Notification failures",
    "Sign-in codes requested",
    "Key indicators",
  ];
  const missing = sections.filter((s) => !text.includes(s));
  expect(missing, `dashboard sections missing: ${missing.join(", ")}`).toEqual([]);
  const links = mainLinks(res.text);
  const dead: string[] = [];
  for (const link of links) {
    const r = await getAs("admin", link);
    if (r.status >= 400 || (redirectPath(r) === "/signin")) dead.push(`${link} → ${brief(r)}`);
  }
  expect(dead, `dead links: ${dead.join(", ")}`).toEqual([]);
  return `${sections.length} sections present; ${links.length} links open (${links.slice(0, 8).join(", ")} …)`;
}, signed);

/** The dashboard's "Today" figures, read from its text. */
async function todayFigures() {
  const text = mainText((await getAs("admin", "/admin/dashboard")).text);
  const placed = text.match(/Orders placed (\d+) (\d+) cancelled · (\d+) refunded/);
  const delivered = text.match(/GMV delivered ₹([\d,.]+) (\d+) orders delivered/);
  const inFlight = text.match(/Orders in flight (\d+)/);
  if (!placed || !delivered || !inFlight) throw new Error(`dashboard figures not found in: ${text.slice(0, 300)}`);
  return {
    placed: Number(placed[1]),
    cancelled: Number(placed[2]),
    refunded: Number(placed[3]),
    gmvRupees: Number(delivered[1].replace(/,/g, "")),
    delivered: Number(delivered[2]),
    inFlight: Number(inFlight[1]),
  };
}

qa("TC-ADM-002", "dashboard figures are real: they move exactly with a placed, cancelled and delivered order and match analytics for today", async () => {
  if (IS_LOCAL) await onlyRiderOnline("rider");
  const before = await todayFigures();
  const cancelled = await placeOrder({ method: "WALLET" });
  const afterPlace = await todayFigures();
  expectStatus(await call(await as("customer"), "PATCH", `/api/orders/${cancelled.id}/status`, { status: "CANCELLED", note: "QA dashboard check" }), 200, "cancel");
  const afterCancel = await todayFigures();
  const delivered = await placeOrder({ method: "WALLET" });
  await packOrder(delivered.id);
  await deliver(delivered.id);
  const afterDeliver = await todayFigures();
  const exact = IS_LOCAL; // the test site may have other activity at the same time
  const step = (a: number, b: number, d: number, what: string) => (exact ? expect(b - a, what).toBe(d) : expect(b - a, what).toBeGreaterThanOrEqual(d));
  step(before.placed, afterPlace.placed, 1, "placed +1 after an order");
  step(before.inFlight, afterPlace.inFlight, 1, "in flight +1");
  step(afterPlace.cancelled, afterCancel.cancelled, 1, "cancelled +1 after a cancel");
  step(afterPlace.inFlight - 1, afterCancel.inFlight, 0, "in flight back after the cancel");
  step(afterCancel.placed, afterDeliver.placed, 1, "placed +1 for the delivered order");
  step(afterCancel.delivered, afterDeliver.delivered, 1, "delivered +1");
  if (exact) expect(Math.round((afterDeliver.gmvRupees - afterCancel.gmvRupees) * 100), "GMV grows by the delivered order's total").toBe(delivered.totalPaise);
  const kpis = (await call(await as("admin"), "GET", `/api/analytics/kpis?from=${istToday()}&to=${istToday(1)}`)).body;
  expect(kpis?.orders?.placed, "analytics (1-day window) placed = dashboard").toBe(afterDeliver.placed);
  expect(kpis?.orders?.delivered, "analytics delivered = dashboard").toBe(afterDeliver.delivered);
  expect(kpis?.orders?.cancelled, "analytics cancelled = dashboard").toBe(afterDeliver.cancelled);
  const orders = await getAs("admin", `/admin/orders?dateFrom=${istToday()}&dateTo=${istToday()}`);
  expect(orders.text, "the delivered order is on /admin/orders").toContain(delivered.orderNumber);
  return `placed ${before.placed}→${afterPlace.placed}→${afterDeliver.placed}; cancelled ${afterPlace.cancelled}→${afterCancel.cancelled}; delivered ${afterCancel.delivered}→${afterDeliver.delivered}; GMV ₹${afterCancel.gmvRupees}→₹${afterDeliver.gmvRupees}; analytics agrees`;
}, { ...signed, partial: "exact deltas locally; on the test site at least the run's own changes (other activity may add more)" });

qa("TC-ADM-004", "order monitoring filters: status, shop, date and combined match; invalid URL values are ignored without a 500", async ({ browser }) => {
  const A = await shopOf("A");
  const B = await shopOf("B");
  const a = await placeOrder({ method: "WALLET", listing: await sellable("A") });
  const b = await placeOrder({ method: "WALLET", listing: await sellable("B") });
  await call(await as("customer"), "PATCH", `/api/orders/${b.id}/status`, { status: "CANCELLED", note: "QA filter check" });
  const out: string[] = [];
  const rowsOf = async (query: string) => {
    const res = await getAs("admin", `/admin/orders${query}`);
    expect(res.status, `/admin/orders${query}`).toBe(200);
    const text = mainText(res.text);
    const count = Number(text.match(/Orders \((\d+)\+?\)/)?.[1] ?? NaN);
    return { text, count };
  };
  const byStatus = await rowsOf("?status=CONFIRMED");
  expect(byStatus.text).toContain(a.orderNumber);
  expect(byStatus.text, "a refunded order is not under CONFIRMED").not.toContain(b.orderNumber);
  const byShop = await rowsOf(`?shopId=${B.id}`);
  expect(byShop.text).toContain(b.orderNumber);
  expect(byShop.text, "shop A's order is not under shop B").not.toContain(a.orderNumber);
  const today = await rowsOf(`?dateFrom=${istToday()}&dateTo=${istToday()}`);
  expect(today.text).toContain(a.orderNumber);
  const yesterday = await rowsOf(`?dateFrom=${istToday(-2)}&dateTo=${istToday(-2)}`);
  expect(yesterday.text, "today's order is not in an earlier day").not.toContain(a.orderNumber);
  const combined = await rowsOf(`?status=CONFIRMED&shopId=${A.id}&dateFrom=${istToday()}`);
  expect(combined.text).toContain(a.orderNumber);
  expect(combined.text).not.toContain(b.orderNumber);
  out.push(`status, shop, date and combined filters match (${combined.count} rows combined)`);
  for (const bad of ["?status=NOPE", "?shopId=abc", "?dateFrom=not-a-date&dateTo=2026-99-99", "?status=%27%3B--&shopId=%00"]) {
    const res = await rowsOf(bad);
    expect(res.text, `${bad} is ignored`).toContain(a.orderNumber);
  }
  out.push("invalid status/shop/date values ignored (200, unfiltered)");
  const all = await rowsOf("");
  expect(all.count, "at most the latest 100 rows").toBeLessThanOrEqual(100);
  out.push(`unfiltered: ${all.count}${all.count === 100 ? "+" : ""} rows`);
  // The filter controls drive the same URL.
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/orders", { waitUntil: "domcontentloaded" });
    await page.locator("select").first().selectOption("CONFIRMED");
    await page.getByRole("button", { name: "Apply Filters" }).click();
    await expect(page).toHaveURL(/status=CONFIRMED/, { timeout: 15_000 });
    await expect(page.locator("main")).toContainText(a.orderNumber);
  } finally {
    await context.close();
  }
  await call(await as("customer"), "PATCH", `/api/orders/${a.id}/status`, { status: "CANCELLED", note: "QA filter check" });
  return out.join("; ");
}, { ...signed, partial: "the IST day boundary of the date filter needs an order aged across midnight: tests/qa/local/access-admin.spec.ts" });

qa("TC-ADM-006", "shop dashboard: today's orders by stage, delivered revenue, returns, inventory with low stock, notifications", async () => {
  const res = await getAs("shop", "/shop");
  expect(res.status).toBe(200);
  const text = mainText(res.text);
  const wanted: [string, RegExp][] = [
    ["today's orders", /Today|today/],
    ["awaiting acceptance / new", /New|awaiting|accept/i],
    ["in progress", /progress|Preparing|Packing|Ready/i],
    ["delivered", /Delivered|delivered/],
    ["cancelled", /Cancel/i],
    ["revenue", /Revenue|Sales|₹/],
    ["returns", /Return/i],
    ["inventory / low stock", /stock/i],
  ];
  const missing = wanted.filter(([, re]) => !re.test(text)).map(([w]) => w);
  // Notifications: the seller header's bell (unread count) links to /notifications.
  if (!/href="\/notifications"/.test(res.text)) missing.push("notifications");
  wanted.push(["notifications (header bell)", /./]);
  expect(missing, `missing on /shop: ${missing.join(", ")}`).toEqual([]);
  return `/shop shows ${wanted.map(([w]) => w).join(", ")}`;
}, { ...signed, partial: "presence of each block; that revenue counts delivered orders only is checked by TC-KPI-003 (GMV)" });

/* ======================================================== risk, consents, compliance, operator landing */

qa("TC-ADM-011", "risk queue: status tabs, severity and subject filters combine and survive navigation, unknown values ignored, Clear filters, Run rules now", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "ops");
  const out: string[] = [];
  try {
    await page.goto("/admin/risk", { waitUntil: "domcontentloaded" });
    const filters = page.getByTestId("risk-filters");
    await expect(filters).toBeVisible();
    await filters.getByRole("link", { name: "dismissed" }).click();
    await expect(page).toHaveURL(/status=DISMISSED/);
    await filters.getByRole("link", { name: "high" }).click();
    await expect(page).toHaveURL(/status=DISMISSED/);
    await expect(page).toHaveURL(/severity=HIGH/);
    await filters.getByRole("link", { name: "shop" }).click();
    await expect(page).toHaveURL(/status=DISMISSED.*severity=HIGH.*subjectType=SHOP|subjectType=SHOP.*severity=HIGH/);
    out.push("tabs and filters combine in the URL");
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/subjectType=SHOP/);
    await expect(filters.getByRole("link", { name: "shop" })).toHaveAttribute("aria-current", "page");
    out.push("filters survive navigating away and back");
    const res = await page.goto("/admin/risk?status=WHATEVER&severity=EXTREME&subjectType=ALIEN", { waitUntil: "domcontentloaded" });
    expect(res?.status(), "unknown filter values").toBe(200);
    await expect(filters.getByRole("link", { name: "open" })).toHaveAttribute("aria-current", "page");
    out.push("unknown values fall back to OPEN/all");
    await page.goto("/admin/risk?status=DISMISSED&severity=HIGH&subjectType=DELIVERY_PARTNER", { waitUntil: "domcontentloaded" });
    const clear = page.getByRole("link", { name: "Clear filters" });
    if (await clear.count()) {
      await clear.click();
      await expect(page).toHaveURL(/\/admin\/risk\?status=DISMISSED$/);
      out.push("'Clear filters' on an empty filtered result");
    } else out.push("filtered result not empty here: 'Clear filters' not offered");
    await page.goto("/admin/risk", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Run rules now/i }).click();
    await expect(page.getByText("Rules run — queue refreshed.")).toBeVisible({ timeout: 30_000 });
    out.push("'Run rules now' refreshed the queue");
    const flags = page.getByTestId("risk-flags");
    if (await flags.count()) {
      await expect(flags).toContainText(/Account status/);
      out.push("flags show subject, account status and severity");
    } else out.push("no open flags to read");
  } finally {
    await context.close();
  }
  return out.join("; ");
}, { ...signed, partial: "flag rows with every subject type are arranged in the local tier (TC-ADM-014/015/016)" });

qa("TC-ADM-019", "consent view for operations: record what /admin/consents shows", async () => {
  const res = await getAs("ops", "/admin/consents");
  expect(res.status, `/admin/consents for an operator — ${brief(res)}`).toBe(200);
  const text = mainText(res.text);
  const parts = ["Consent record", "Terms & privacy policy", "Marketing communications", "Look up one person"].filter((p) => text.includes(p));
  expect(parts.length, "the consent view's sections").toBeGreaterThanOrEqual(3);
  expect(text, "IP addresses are not shown").not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  const customer = await getAs("customer", "/admin/consents");
  expect(redirectPath(customer), "a customer is sent away").not.toBeNull();
  return `built: ${parts.join(", ")}; ${text.match(/Current policy version [^.]+/)?.[0] ?? ""}; customer ${brief(customer)}`;
}, { ...signed, partial: "record-only: the status report listed it as not built; it is now a working page" });

qa("TC-ADM-020", "compliance checklist and Maps usage panels load with data", async () => {
  const compliance = await getAs("admin", "/admin/console/compliance");
  expect(compliance.status).toBe(200);
  const ctext = mainText(compliance.text);
  expect(ctext).toMatch(/Compliance/);
  expect(ctext, "checklist rows").toMatch(/Active \d+ Missing \d+ Review required \d+/);
  const maps = await getAs("admin", "/admin/console/maps");
  expect(maps.status, `/admin/console/maps — ${brief(maps)}`).toBe(200);
  const mtext = mainText(maps.text);
  expect(mtext, "Maps usage panel").toMatch(/Maps|SKU|usage/i);
  const ops = await getAs("ops", "/admin/console/maps");
  return `compliance: ${ctext.match(/Active \d+ Missing \d+ Review required \d+/)?.[0]}; maps: ${mtext.slice(mtext.search(/Maps/i), mtext.search(/Maps/i) + 120)}; operator on maps ${brief(ops)}`;
}, signed);

qa("TC-ADM-021", "operator landing: /operator opens the operator console with onboarding, product uploads, payments and exceptions reachable", async () => {
  const ops = await getAs("ops", "/operator");
  expect(redirectPath(ops), "an OPERATOR is sent to the shared console").toBe("/admin");
  const board = await getAs("ops", "/admin");
  const links = mainLinks(board.text);
  const wanted: [string, RegExp][] = [
    ["onboarding", /^\/admin\/(menu\/onboarding|console\/shops|shop-registrations)/],
    ["product uploads", /^\/admin\/(product-import|product-master)/],
    ["payments", /^\/admin\/(finance\/exceptions|cod|menu\/vouchers|console\/registration-fees)/],
    ["exceptions", /^\/admin\/exceptions/],
  ];
  const missing = wanted.filter(([, re]) => !links.some((l) => re.test(l))).map(([w]) => w);
  expect(missing, `not reachable from the operator console: ${missing.join(", ")}`).toEqual([]);
  const out = [`OPERATOR /operator → /admin; reachable: ${wanted.map(([w]) => w).join(", ")}`];
  if (world().users.oplim) {
    const limited = await getAs("oplim", "/operator");
    expect(limited.status, "/operator for OPERATOR_LIMITED").toBe(200);
    const llinks = mainLinks(limited.text);
    for (const path of ["/operator/onboard", "/operator/shops", "/operator/documents", "/operator/payments"]) {
      expect(llinks, `operator-limited board links ${path}`).toContain(path);
      expect((await getAs("oplim", path)).status, `${path} opens`).toBe(200);
    }
    out.push("OPERATOR_LIMITED /operator: onboard, shops, documents, payments open");
  }
  return out.join("; ");
}, signed);

/* ======================================================== analytics */

qa("TC-KPI-001", "marketplace analytics: KPI cards and the daily GMV trend load and follow the 7/30/90-day window", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  const out: string[] = [];
  try {
    await page.goto("/admin/analytics", { waitUntil: "domcontentloaded" });
    const board = page.getByTestId("kpi-dashboard");
    await expect(board).toBeVisible();
    for (const id of ["KPI-001", "KPI-002", "KPI-003", "KPI-007", "KPI-008", "KPI-010", "KPI-012"]) await expect(board.locator(`[data-kpi="${id}"]`), id).toBeVisible();
    await expect(board).toContainText("Delivered GMV by day");
    const header30 = await page.getByText(/Marketplace KPIs from/).textContent();
    await page.getByRole("link", { name: "Last 7 days" }).click();
    await expect(page).toHaveURL(/days=7/);
    const header7 = await page.getByText(/Marketplace KPIs from/).textContent();
    expect(header7, "the window changes").not.toBe(header30);
    const from7 = header7?.match(/from (\d{4}-\d{2}-\d{2})/)?.[1];
    const to7 = header7?.match(/to (\d{4}-\d{2}-\d{2})/)?.[1];
    expect(Math.round((Date.parse(to7 ?? "") - Date.parse(from7 ?? "")) / 86_400_000), "7-day window").toBe(7);
    const api7 = (await call(await as("admin"), "GET", `/api/analytics/kpis?from=${from7}&to=${to7}`)).body;
    await expect(board.locator('[data-kpi="KPI-001"]')).toContainText(`${api7.orders.delivered} delivered of ${api7.orders.placed} placed`);
    out.push(`30 days: ${header30?.trim()}; 7 days: ${header7?.trim()}; tile matches the API (${api7.orders.placed} placed)`);
    await page.getByRole("link", { name: "Last 90 days" }).click();
    await expect(page).toHaveURL(/days=90/);
    out.push("90 days loads");
  } finally {
    await context.close();
  }
  return out.join("; ");
}, signed);

qa("TC-KPI-013", "an empty window shows zeros or dashes — no NaN, Infinity or error", async () => {
  const res = await call(await as("admin"), "GET", "/api/analytics/kpis?from=2001-01-01&to=2001-01-02");
  expectStatus(res, 200, "KPIs for a window with no orders");
  expect(res.text, "no NaN / Infinity").not.toMatch(/NaN|Infinity/);
  expect(res.body.orders.placed).toBe(0);
  expect(res.body.fillRate).toBeNull();
  const empty = world().shops.C ? await shopOf("C") : null;
  const out = [`API: placed 0, rates null`];
  if (empty && world().users.shopC) {
    const page = await getAs("shopC", "/shop/analytics");
    expect(page.status).toBe(200);
    const text = mainText(page.text);
    expect(text, "shop C's analytics (no orders)").not.toMatch(/NaN|Infinity|undefined/);
    expect(text).toMatch(/—|0/);
    out.push("shop C /shop/analytics shows dashes/zeros");
  }
  const reversed = await call(await as("admin"), "GET", "/api/analytics/kpis?from=2026-01-02&to=2026-01-01");
  expect(reversed.status, `a reversed window — ${why(reversed)}`).toBe(422);
  out.push("reversed window 422");
  return out.join("; ");
}, signed);

/* ======================================================== navigation, layout, console */

/** Internal links of the header and the role's home portal. */
async function navLinks(page: Page) {
  return page.evaluate(() =>
    [...new Set([...document.querySelectorAll("header a[href^='/'], nav a[href^='/'], main a[href^='/']")].map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""))]
      .map((h) => h.split("#")[0])
      .filter((h) => h && !h.startsWith("/legal/") && !h.startsWith("/api/") && !/\.(png|ico|css|js)$/.test(h)),
  );
}

qa("TC-UX-001", "header and portal navigation by role: every link opens a working page for that role", async ({ browser }) => {
  const homes: [Role, string][] = [
    ["customer", "/"],
    ["shop", "/shop"],
    ["rider", "/delivery-partner"],
    ["ops", "/admin"],
    ["admin", "/admin"],
    ...(world().users.society ? ([["society", "/society"]] as [Role, string][]) : []),
    ...(world().users.oplim ? ([["oplim", "/operator"]] as [Role, string][]) : []),
  ];
  const dead: string[] = [];
  const counts: string[] = [];
  for (const [role, home] of homes) {
    const { context, page } = await pageAs(browser, role);
    try {
      await page.goto(home, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      const links = (await navLinks(page)).slice(0, 80);
      for (const link of links) {
        const res = await getAs(role, link);
        if (res.status >= 400 && res.status !== 405) dead.push(`${role}: ${link} → ${res.status}`);
        else if (redirectPath(res) === "/signin") dead.push(`${role}: ${link} → sign-in`);
      }
      counts.push(`${role} ${links.length}`);
      if (role === "admin") counts.push(`admin links /admin/dashboard: ${links.includes("/admin/dashboard") ? "yes" : "no"}, /admin/orders: ${links.includes("/admin/orders") ? "yes" : "no"}`);
    } finally {
      await context.close();
    }
  }
  expect(dead, `dead links: ${dead.join("; ")}`).toEqual([]);
  return `links checked per role: ${counts.join(", ")}`;
}, { ...signed, timeout: 600_000, partial: "links read from each role's home portal page (header, menus, tiles); a link the role may not open redirects (not counted dead) — refusals are TC-RBAC-003/005" });

qa("TC-UX-002", "phone viewport, signed in: home → search → shop → cart → checkout → orders without sideways scroll, menu reachable", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const wide: string[] = [];
  const steps: string[] = [];
  try {
    const listing = await sellable("A");
    await emptyCart();
    for (const path of ["/", `/search?q=${encodeURIComponent(listing.name.split(" ").slice(1, 2).join(" ") || "milk")}`, `/shops/${(await shopOf("A")).slug}`]) {
      await openPage(page, path);
      const over = await sidewaysOverflow(page);
      if (over > 2) wide.push(`${path} +${over}px`);
      steps.push(path.split("?")[0]);
    }
    expectStatus(await addToCart("customer", listing.shopProductId, 1), [200, 201], "add to cart");
    await openPage(page, "/cart");
    await expect(page.getByRole("button", { name: /Pay from wallet|Place order/i }).first(), "the pay button on the cart").toBeVisible();
    const box = await page.getByRole("button", { name: /Pay from wallet|Place order/i }).first().boundingBox();
    expect((box?.height ?? 0) >= 40, "checkout button is tappable (40px+)").toBe(true);
    if ((await sidewaysOverflow(page)) > 2) wide.push(`/cart +${await sidewaysOverflow(page)}px`);
    steps.push("/cart");
    await openPage(page, "/orders");
    if ((await sidewaysOverflow(page)) > 2) wide.push(`/orders +${await sidewaysOverflow(page)}px`);
    steps.push("/orders");
    await openPage(page, "/wallet");
    if ((await sidewaysOverflow(page)) > 2) wide.push(`/wallet +${await sidewaysOverflow(page)}px`);
    const menu = page.getByRole("button", { name: /menu|account/i }).first();
    await expect(menu, "a menu button is reachable").toBeVisible();
  } finally {
    await emptyCart();
    await context.close();
  }
  expect(wide, `pages wider than the screen: ${wide.join(", ")}`).toEqual([]);
  return `${steps.join(" → ")} at 390 px: no sideways scroll, checkout button tappable, menu reachable`;
}, { ...signed, mobile: true, partial: "the checkout confirmation itself is placed through the API (TC-CART-009); the page walk stops at the cart's checkout button" });

qa("TC-UX-003", "signed-in pages log no console or page errors: cart, orders, wallet, /shop, /delivery-partner, /admin", async ({ browser }) => {
  const plan: [Role, string[]][] = [
    ["customer", ["/", "/cart", "/orders", "/wallet", "/profile", "/subscriptions"]],
    ["shop", ["/shop", "/shop/orders"]],
    ["rider", ["/delivery-partner"]],
    ["admin", ["/admin", "/admin/dashboard"]],
  ];
  const errors: string[] = [];
  let pages = 0;
  for (const [role, paths] of plan) {
    const { context, page } = await pageAs(browser, role);
    const seen = watchErrors(page);
    try {
      for (const path of paths) {
        await openPage(page, path);
        pages += 1;
      }
    } finally {
      await context.close();
    }
    errors.push(...seen.map((e) => `${role} ${e}`));
  }
  const hydration = errors.filter((e) => /#418|#423|#425|hydrat/i.test(e));
  expect(hydration, `hydration errors: ${hydration.join(" | ")}`).toEqual([]);
  expect(errors, errors.join(" | ")).toEqual([]);
  return `${pages} signed-in pages: no console errors`;
}, { ...signed, mobile: true });

qa("TC-UX-004", "/about and /contact load with content (the legal pages are in the guest tier)", async ({ page }) => {
  for (const path of ["/about", "/contact"]) {
    await openPage(page, path);
    await expect(page.getByRole("heading").first()).toBeVisible();
    expect((await page.locator("main").innerText()).length, `${path} has content`).toBeGreaterThan(200);
  }
  return "/about and /contact load with headings and content";
}, { mobile: true, partial: "the ten legal pages and /grievance are tests/qa/guest/storefront.spec.ts TC-UX-004" });

qa("TC-UX-005", "admin edit screen: a changed field warns before the page is left", async ({ browser }) => {
  const victim = await me("customer2");
  const { context, page } = await pageAs(browser, "admin");
  const dialogs: string[] = [];
  try {
    await page.goto(`/admin/users/${victim.id}`, { waitUntil: "domcontentloaded" });
    const name = page.getByLabel("Name");
    const was = await name.inputValue();
    await name.fill(`${was} (unsaved ${RUN})`);
    await expect(page.getByText(/Unsaved profile changes/)).toBeVisible();
    page.once("dialog", async (d) => {
      dialogs.push(d.type());
      await d.dismiss();
    });
    await page.goto("/admin", { timeout: 5_000 }).catch(() => {});
    expect(dialogs, "a leave-page warning").toContain("beforeunload");
    await expect(name, "the typed value is still there after staying").toHaveValue(`${was} (unsaved ${RUN})`);
  } finally {
    await context.close();
  }
  const after = (await call(await as("customer2"), "GET", "/api/profile")).body;
  expect(String(after?.name ?? ""), "nothing was saved").not.toContain(`unsaved ${RUN}`);
  return "typing in /admin/users/{id} shows 'Unsaved profile changes'; leaving raises the browser's leave-page warning; staying keeps the value; nothing saved";
}, { ...signed, partial: "in-app links outside the form (site header) leave without a prompt by design (src/components/unsaved-changes-guard.tsx)" });

/* ======================================================== society and rider portals (header reachability) */

qa("TC-UX-001", "society admin and rider portals open from their header links", async () => {
  const out: string[] = [];
  if (world().users.society) {
    const soc = need(societyId(), "the world's society");
    const res = await getAs("society", "/society");
    expect([200, 307, 308]).toContain(res.status);
    const target = redirectPath(res) ?? "/society";
    expect((await getAs("society", target)).status, `society portal ${target}`).toBe(200);
    expect((await getAs("society", `/society/${soc}`)).status).toBe(200);
    out.push(`society /society → ${target} 200`);
  }
  const rider = await getAs("rider", "/delivery-partner");
  expect(rider.status).toBe(200);
  for (const link of mainLinks(rider.text).filter((l) => l.startsWith("/gig") || l.startsWith("/delivery-partner"))) {
    const res = await getAs("rider", link);
    expect(res.status < 400 || res.status === 405, `${link} for the rider — ${brief(res)}`).toBe(true);
    out.push(`rider ${link} ${res.status}`);
  }
  if (IS_REMOTE) out.push("(test site)");
  return out.join("; ") || blocked("no society or rider account here");
}, signed);
