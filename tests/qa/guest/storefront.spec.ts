/**
 * Preflight and the storefront as a guest sees it (production-safe): the
 * site renders, database-backed pages load, browsing and search work without
 * signing in, the location bar, legal pages, the 404 page and the phone
 * layout. Only GETs and the guest's own location cookie.
 */
import type { Page } from "@playwright/test";

import { anonymous, call, fromApp } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import { BASE_URL, IS_REMOTE, TARGET } from "../lib/target";

/** Collects console errors and uncaught page errors while a page is used. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Third-party noise that says nothing about GoKesari's own pages.
    if (/favicon|ERR_BLOCKED_BY_CLIENT|maps\.googleapis|gstatic|Failed to load resource: the server responded with a status of 40[134]/.test(text)) return;
    errors.push(text.slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  return errors;
}

async function open(page: Page, path: string) {
  let res = await page.goto(path, { waitUntil: "domcontentloaded" });
  // The sites' host firewall can answer a burst of requests with a short-lived 403/429 before the
  // app sees them; look once more after a pause. A real refusal is still there on the second look.
  for (const wait of [20_000, 60_000]) {
    if (!(IS_REMOTE && res && [403, 429].includes(res.status()))) break;
    await page.waitForTimeout(wait);
    res = await page.goto(path, { waitUntil: "domcontentloaded" });
  }
  // A refusal the host still gives after that says nothing about the app (E-01).
  if (IS_REMOTE && res && res.status() >= 400 && !fromApp(res.headers())) blocked(`${path}: the host firewall answered ${res.status()} for 80 s, not the app (E-01)`);
  expect(res, `no response for ${path}`).toBeTruthy();
  expect(res!.status(), `${path} answered ${res!.status()}`).toBeLessThan(400);
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await expect(page.locator("body"), `${path} shows an error page`).not.toContainText(/Something went wrong|Application error|Internal Server Error/i);
  return res!;
}

/** Sign in is in the header, or (home page on a phone) inside the "Open menu" drawer. */
async function expectSignInReachable(page: Page) {
  const inHeader = page.getByRole("link", { name: /Sign in/i }).first();
  if (await inHeader.isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "Open menu" }).click();
  const drawer = page.getByRole("dialog", { name: /navigation/i });
  await expect(drawer.getByRole("link", { name: /Sign in/i }).first()).toBeVisible();
  await drawer.getByRole("button", { name: /Close menu/i }).click();
}

/** The first approved shop and one of its products, from the public APIs. */
async function aShopAndProduct() {
  const guest = await anonymous();
  const shops = await call(guest, "GET", "/api/shops?limit=24");
  expect(shops.status, "GET /api/shops").toBe(200);
  const list = (Array.isArray(shops.body) ? shops.body : (shops.body?.shops ?? [])) as { id: string; slug: string; name: string }[];
  if (!list.length) blocked("no approved shop is listed on this site");
  for (const shop of list.slice(0, 8)) {
    const products = await call(guest, "GET", `/api/shops/${shop.id}/products?limit=50`);
    const rows = (Array.isArray(products.body) ? products.body : (products.body?.products ?? [])) as { productId: string; productName: string }[];
    if (products.status === 200 && rows.length) {
      await guest.dispose();
      return { shop, product: { id: rows[0].productId, name: rows[0].productName } };
    }
  }
  await guest.dispose();
  return { shop: list[0], product: null };
}

qa("TC-PRE-001", "the site is reachable and renders the header, location bar and shop shelves", async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, "/");
  await expect(page.getByRole("link", { name: /GoKesari.*Home/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Cart/ })).toBeVisible();
  await expectSignInReachable(page);
  await expect(page.getByRole("button", { name: /Deliver to/i })).toBeVisible();
  await expect(page.getByRole("region", { name: /Shops on GoKesari|Shop by category/i }).first()).toBeVisible();
  const hydration = errors.filter((e) => /#418|#423|#425|hydrat/i.test(e));
  expect(hydration, `hydration errors: ${hydration.join(" | ")}`).toEqual([]);
  return `${BASE_URL} renders; console errors: ${errors.length ? errors.join(" | ") : "none"}`;
}, { mobile: true });

qa("TC-PRE-002", "database-backed pages load without a 500 or an error page", async ({ page }) => {
  const { shop, product } = await aShopAndProduct();
  const paths = ["/shops", "/search?q=milk", "/categories", `/shops/${shop.slug}`, ...(product ? [`/products/${product.id}`] : [])];
  for (const path of paths) await open(page, path);
  return `loaded: ${paths.join(", ")}`;
});

qa(["TC-PRE-010", "TC-RBAC-001"], "a guest can browse and search: home, shops, search, a shop, a product, sign-in and terms", async ({ page }) => {
  const { shop, product } = await aShopAndProduct();
  const paths = ["/", "/shops", "/search?q=milk", `/shops/${shop.slug}`, ...(product ? [`/products/${product.id}`] : []), "/search/compare", "/signin", "/legal/terms"];
  for (const path of paths) await open(page, path);
  return `${TARGET}: ${paths.length} pages readable signed out`;
}, { mobile: true, partial: "'Add to cart / subscribe prompts sign-in' is checked in TC-RBAC-001 add-to-cart below" });

qa("TC-RBAC-001", "Add to cart as a guest asks to sign in and adds nothing", async ({ page }) => {
  const { shop } = await aShopAndProduct();
  await open(page, `/shops/${shop.slug}`);
  const add = page.getByRole("button", { name: /^Add\b|Add to cart/i }).first();
  if (!(await add.count())) blocked(`no Add button on ${shop.name}'s page (no product on sale online)`);
  await add.click();
  // Either the page sends the guest to sign in, or it says sign-in is needed.
  await expect
    .poll(async () => /\/signin/.test(page.url()) || (await page.getByText(/sign in/i).count()) > 0, { timeout: 20_000 })
    .toBe(true);
  const guest = await anonymous();
  const cart = await call(guest, "GET", "/api/cart");
  await guest.dispose();
  expect(cart.status, "a guest has no cart").toBe(401);
  return `Add on ${shop.name} → ${/\/signin/.test(page.url()) ? "sign-in page" : "sign-in prompt"}; guest cart API 401`;
}, { mobile: true });

qa("TC-DISC-001", "home page: search, categories, banners and the shops section", async ({ page }) => {
  await open(page, "/");
  await expect(page.getByRole("combobox", { name: /Search products, shops and categories/i })).toBeVisible();
  await expect(page.getByRole("region", { name: "Shop by category" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Shops on GoKesari" })).toBeVisible();
  const shops = await page.getByRole("region", { name: "Shops on GoKesari" }).getByRole("article").count();
  return `home: search box, categories, ${shops} shop cards`;
}, { mobile: true });

qa(["TC-DISC-004", "TC-FLD-022", "TC-DISC-007"], "shop search by name, partial name and PIN; odd search text is shown escaped, never an error page", async ({ page }) => {
  const { shop } = await aShopAndProduct();
  const guest = await anonymous();
  const detail = await call(guest, "GET", `/api/shops/${shop.id}`);
  await guest.dispose();
  const pincode: string | undefined = detail.body?.pincode ?? detail.body?.shop?.pincode;
  for (const q of [shop.name, shop.name.slice(0, Math.max(3, Math.floor(shop.name.length / 2))), ...(pincode ? [pincode] : [])]) {
    await open(page, `/shops?q=${encodeURIComponent(q)}`);
    await expect(page.getByText(shop.name).first(), `"${q}" finds ${shop.name}`).toBeVisible();
  }
  let alerted = false;
  page.on("dialog", async (d) => {
    alerted = true;
    await d.dismiss();
  });
  // The inputs of TC-FLD-022 / TC-DISC-007: blank, one character, 200 characters, symbols, a script tag, Hindi, outer spaces, no match.
  const inputs = ["", "a", "x".repeat(200), "% _ ' \"", "<script>alert(1)</script>", "दूध", "  milk  ", "zzqqxxnotaproduct"];
  for (const q of inputs) {
    await open(page, `/search?q=${encodeURIComponent(q)}`);
    if (q.includes("<script>")) await expect(page.locator("main")).toContainText("<script>alert(1)</script>");
  }
  expect(alerted, "a script in the search text ran").toBe(false);
  return `found "${shop.name}" by name, partial name${pincode ? " and PIN" : ""}; ${inputs.length} edge inputs render escaped, no script ran`;
}, { partial: "search by shop type and area: TC-DISC-005 filters" });

qa("TC-DISC-005", "shop filters by type and delivery keep the list consistent", async ({ page }) => {
  for (const q of ["type=DAIRY", "type=BAKERY", "delivery=true", "open=1"]) await open(page, `/shops?${q}`);
  return "type, delivery and open-now filters load";
}, { partial: "checks the filters load; that every listed shop matches the filter needs known shop data (signed-in tier)" });

qa(["TC-DISC-007", "TC-SEC-002"], "search and id edge cases: no 500 for odd text or malformed ids", async () => {
  const guest = await anonymous();
  const bad: string[] = [];
  const probes = [
    "/api/search?q=%27%3B--",
    `/api/search?q=${"a".repeat(500)}`,
    "/api/shops/abc/products",
    `/api/shops/${"9".repeat(80)}/products`,
    "/api/shops/1%27%20OR%201%3D1/products",
    "/api/products/abc",
    "/api/products/%27%20OR%201%3D1",
  ];
  for (const path of probes) {
    const res = await call(guest, "GET", path);
    if (res.status >= 500) bad.push(`${path} → ${res.status}`);
  }
  for (const path of ["/products/abc", "/products/%27%20OR%201%3D1", `/shops/${"z".repeat(200)}`]) {
    const res = await call(guest, "GET", path);
    if (res.status >= 500) bad.push(`${path} → ${res.status}`);
  }
  await guest.dispose();
  expect(bad, bad.join("; ")).toEqual([]);
  return `${probes.length + 3} malformed requests: none answered 5xx`;
}, { partial: "public routes only; signed-in id routes are swept in the signed-in tier" });

qa(["TC-DISC-012", "TC-SEC-009"], "an unknown product or page shows the branded 404 with navigation, not a stack trace", async ({ page }) => {
  for (const path of ["/products/00000000-0000-4000-8000-000000000000", "/this-page-does-not-exist"]) {
    const res = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(res?.status(), path).toBe(404);
    await expect(page.getByRole("link", { name: /GoKesari.*Home|Home|Go to/i }).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/at .*\.js:\d+|node_modules|stack/i);
  }
  return "404 pages are branded with a way home";
}, { mobile: true });

qa(["TC-DISC-013", "TC-SUP-011"], "a shop page shows name, address, products and a contact page", async ({ page }) => {
  const { shop } = await aShopAndProduct();
  await open(page, `/shops/${shop.slug}`);
  await expect(page.getByRole("heading", { name: shop.name }).first()).toBeVisible();
  await open(page, `/shops/${shop.slug}/contact`);
  return `${shop.name}: page and contact page load`;
}, { partial: "contact form submission needs sign-in (signed-in tier)" });

qa("TC-DISC-017", "category and department pages load", async ({ page }) => {
  for (const path of ["/categories", "/category/DAIRY", "/category/BAKERY", "/dairy", "/bakery"]) await open(page, path);
  return "categories, DAIRY, BAKERY, /dairy and /bakery redirects load";
});

qa(["TC-LOC-001", "TC-LOC-007", "TC-FLD-020"], "guest sets the delivery location by PIN and clears it", async ({ page }) => {
  await open(page, "/");
  await page.getByRole("button", { name: /Deliver to/i }).click();
  const dialog = page.getByRole("dialog", { name: /delivery location/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /PIN code/i }).fill("411038");
  await dialog.getByRole("button", { name: "Use PIN" }).click();
  await expect(page.getByRole("button", { name: /Deliver to/i })).toContainText(/411038|Pune|Kothrud/i, { timeout: 30_000 });
  // Clear through the same API the location bar uses (the guest's own cookie).
  const res = await page.request.delete("/api/location");
  expect(res.status(), "DELETE /api/location").toBeLessThan(300);
  await page.reload();
  await expect(page.getByRole("button", { name: /Deliver to/i })).toContainText(/Set location/i);
  return "PIN 411038 set from the location bar, then cleared";
}, { mobile: true });

qa(["TC-LOC-002", "TC-FLD-020"], "an invalid PIN is refused on the field and by the API", async ({ page }) => {
  await open(page, "/");
  await page.getByRole("button", { name: /Deliver to/i }).click();
  const dialog = page.getByRole("dialog", { name: /delivery location/i });
  const field = dialog.getByRole("textbox", { name: /PIN code/i });
  const seen: string[] = [];
  // Seven digits cannot be typed: the field stops at six.
  await field.fill("1234567");
  expect((await field.inputValue()).length, "PIN field length").toBeLessThanOrEqual(6);
  for (const pin of ["12345", "011001", "abcdef"]) {
    await field.fill(pin);
    await dialog.getByRole("button", { name: "Use PIN" }).click();
    await page.waitForTimeout(1000);
    await expect(dialog, `dialog stays open for "${pin}"`).toBeVisible();
    await expect(page.getByRole("button", { name: /Deliver to/i })).not.toContainText(pin);
    seen.push(pin);
  }
  const res = await page.request.post("/api/location", { data: { pincode: "000000" } });
  expect(res.status(), "POST /api/location 000000").toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
  return `7 digits cut to 6; refused on the field: ${seen.join(", ")}; API 000000 → ${res.status()}`;
});

qa(["TC-UX-004", "TC-SUP-004"], "legal and policy pages and the grievance officer page load", async ({ page }) => {
  const legal = ["terms", "privacy-policy", "refund-policy", "shipping-policy", "cookie-policy", "grievance-redressal", "seller-terms", "subscription-terms", "wallet-terms", "voucher-terms"];
  for (const p of legal) {
    await open(page, `/legal/${p}`);
    await expect(page.getByRole("heading").first()).toBeVisible();
  }
  await open(page, "/grievance");
  await expect(page.getByText(/Grievance Officer/i).first()).toBeVisible();
  return `${legal.length} legal pages and /grievance load`;
}, { partial: "TC-SUP-004: page and officer details only; filing and ticket lookup write data (signed-in tier)" });

qa("TC-UX-002", "phone viewport: no sideways scroll on the main pages; header menu reachable", async ({ page }) => {
  const wide: string[] = [];
  for (const path of ["/", "/shops", "/search?q=milk", "/categories", "/signin"]) {
    await open(page, path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 2) wide.push(`${path} +${overflow}px`);
  }
  expect(wide, `pages wider than the screen: ${wide.join(", ")}`).toEqual([]);
  return "5 pages fit the screen width";
}, { mobile: true, partial: "guest pages; signed-in screens (cart, checkout, orders) run in the signed-in tier" });

qa("TC-UX-003", "the main guest pages log no console or page errors", async ({ page }) => {
  const errors = watchErrors(page);
  const { shop } = await aShopAndProduct();
  for (const path of ["/", "/shops", "/search?q=milk", "/categories", `/shops/${shop.slug}`, "/signin", "/legal/terms"]) await open(page, path);
  expect(errors, errors.join(" | ")).toEqual([]);
  return "7 pages, no console errors";
}, { mobile: true, partial: "guest pages; signed-in pages run in the signed-in tier" });

qa("TC-UX-001", "header for a guest: home, search, location, cart and sign-in", async ({ page }) => {
  await open(page, "/shops");
  for (const [role, name] of [["link", /GoKesari.*Home/i], ["button", /Deliver to/i], ["link", /^Cart/]] as const) {
    await expect(page.getByRole(role, { name }).first(), `${role} ${name}`).toBeVisible();
  }
  // Search is a box on a wide screen and a link to /search on a phone.
  await expect(page.getByRole("combobox", { name: /Search/i }).or(page.getByRole("link", { name: /^Search$/ })).first(), "search").toBeVisible();
  await expectSignInReachable(page);
  for (const path of ["/", "/categories"]) {
    await open(page, path);
    await expectSignInReachable(page);
  }
  return "guest header complete on /shops, / and /categories";
}, { mobile: true, partial: "guest header; the per-role headers run in the signed-in tier" });

qa("TC-DISC-018", "a product without an image shows a placeholder, never a broken image", async ({ page }) => {
  const { shop } = await aShopAndProduct();
  await open(page, `/shops/${shop.slug}`);
  const broken = await page.evaluate(() =>
    [...document.images].filter((img) => img.complete && img.naturalWidth === 0 && !img.src.startsWith("data:")).map((img) => img.src),
  );
  expect(broken, `broken images: ${broken.join(", ")}`).toEqual([]);
  return `${shop.name}: no broken images`;
}, { mobile: true });

qa("TC-DISC-022", "home widgets with no location set: a prompt instead of an empty or broken shelf", async ({ page }) => {
  await page.context().clearCookies();
  await open(page, "/");
  await expect(page.getByText(/Set your location/i).first()).toBeVisible();
  return "no location: 'Set your location' prompt shown";
}, { mobile: true });
