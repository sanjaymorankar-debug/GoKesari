/**
 * P0 cases added on 23-Nov-2026 (docs/testing/manual/cases-added-2026-11-23.json), group R1:
 * Puja Samagri access and a puja order paid online / by cash, the voice price & offer assistant
 * (flag voice_price_assistant_enabled), the shop logo upload (flag shop_logo_upload_enabled) and
 * "Add product by photo" while its flag (shop_photo_listing_enabled) is off.
 *
 * Signed-in tier (test.gokesari.com and the local server). On staging there is no session for shop
 * B's owner, no shop staff account and no second admin: the parts of a case that need them are not
 * run and the check says so in `partial`. Nothing here changes a flag, a business rule or a shop
 * setting.
 *
 * What the checks change, and put back in a finally:
 *  - TC-VPA-015: shop A's "Bread" price ₹40 → ₹42 by voice, then back to the price it had (same path);
 *  - TC-VPA-019: a "10% off · Bread" offer by voice, then switched off (Marketing → Offers);
 *  - TC-LOGO-006: shop A's logo set by the operator, then put back as it was (removed when there was none);
 *  - TC-PUJA-059: one puja order paid online with Cashfree sandbox data (UPI testsuccess@gocash, through
 *    the "Sandbox payment" workflow); when it cannot be delivered now, it is cancelled before packing.
 *    Where shop A takes cash on delivery, a second (COD) order is placed and cancelled again, so the
 *    test customer keeps no open COD order (E-16).
 * Only "Bread" and the product named in TC-VPA-021 are priced or offered; TC-VPA-021 only checks
 * (interpret), it publishes nothing.
 */
import type { Browser, Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

import { as, me, pageAs, plainCustomer } from "../lib/actors";
import { cartLines, emptyCart, orderAs, shopOf, type Listing, type StorefrontRow } from "../lib/flows";
import { anonymous, call, expectStatus, poll, stash, unstash, why, type Answer } from "../lib/http";
import { fillCart, intentView, notificationsOf, orderOf, paySandbox } from "../lib/money-helpers";
import { png } from "../lib/orders-helpers";
import { blocked, expect, need, qa, test } from "../lib/record";
import { phoneOptions } from "../lib/regression-2026-11-helpers";
import { chooseDeliveryTime, rupees } from "../lib/shopping-helpers";
import { IS_LOCAL } from "../lib/target";
import { world, type Role } from "../lib/world";

const KEY = "p0-puja-voice-logo-2026-11-23";
const signed = { tier: "signed" as const, timeout: 300_000 };
const NOT_YOURS = "This shop does not belong to you.";
const VOICE_OWNER_ONLY = "Only the shop's owner can change prices and offers by voice.";
const STAFF_ONLY = "You do not have access to this area.";
const NO_B_OWNER = "no session for shop B's owner on this site";
const NO_STAFF = "no shop staff account (catalogue scope) on this site";

const isPhone = () => test.info().project.name === "mobile";
const attr = (s: string) => JSON.stringify(s);

/** A page signed in as `role`, at phone size on the mobile project. */
function rolePage(browser: Browser, role: Role) {
  return pageAs(browser, role, isPhone() ? phoneOptions() : {});
}

function errorText(res: Answer): string {
  const e = res.body?.error;
  return typeof e === "string" ? e : (e?.message ?? res.body?.message ?? "");
}

function expectRefusal(res: Answer, status: number, message: string, what: string) {
  expect(res.status, `${what} — ${why(res)}`).toBe(status);
  expect(errorText(res), `${what}: message`).toBe(message);
}

/* ------------------------------------------------------------------ shop A's Bread */

/**
 * Shop A's listings as its owner sees them (prices, MRP, stock). Read as the owner rather than the operator
 * (lib/flows shopListings): on 23-Nov the operator account answered with the public shelf for a while, as
 * if it had lost its operator rights (another run was changing test accounts' roles).
 */
async function ownerListings(shopId: string): Promise<(StorefrontRow & { offlinePricePaise: number | null })[]> {
  const res = await call(await as("shop"), "GET", `/api/shops/${shopId}/products`);
  expectStatus(res, 200, "shop A's listings (owner)");
  type Row = Omit<StorefrontRow, "shopProductId" | "productName"> & { id: string; offlinePricePaise: number | null; product?: { name: string; mrpPaise?: number | null } };
  const rows = res.body as Row[];
  expect(rows.every((r) => typeof r.id === "string" && r.product), "the owner's view of the listings").toBe(true);
  return rows.map((r) => ({ ...r, shopProductId: r.id, productName: r.product?.name ?? "", mrpPaise: r.product?.mrpPaise ?? null }));
}

/** A listing's online stock (undefined when not tracked). */
async function stockOf(listing: Pick<Listing, "shopId" | "shopProductId">): Promise<number | undefined> {
  const row = (await ownerListings(listing.shopId)).find((r) => r.shopProductId === listing.shopProductId);
  return row?.trackInventory ? row.onlineStock : undefined;
}

interface PriceRow {
  shopProductId: string;
  productId: string;
  productName: string;
  online: number | null;
  offline: number | null;
  mrp: number | null;
}

async function listingRow(shopId: string, shopProductId: string): Promise<PriceRow> {
  const row = (await ownerListings(shopId)).find((r) => r.shopProductId === shopProductId);
  if (!row) blocked(`listing ${shopProductId} is not in shop A any more`);
  return {
    shopProductId: row.shopProductId,
    productId: row.productId,
    productName: row.productName,
    online: row.onlinePricePaise,
    offline: row.offlinePricePaise ?? null,
    mrp: row.mrpPaise ?? null,
  };
}

/** Shop A's "Bread" (the world's sharedA listing) — the one product the VPA cases may price. */
async function bread() {
  const shop = await shopOf("A");
  const preset = need(world().listings.sharedA, `shop A's "Bread" listing in this site's test data`);
  const row = await listingRow(shop.id, preset.shopProductId);
  if (row.productName !== "Bread") blocked(`the sharedA listing is "${row.productName}", not "Bread"`);
  return { shop, row };
}

type OfferRow = { id: string; title: string; active: boolean; startsAt: string; endsAt: string; shopProductId: string | null; targetType: string; categoryId: string | null; discountType: "PERCENT" | "FLAT"; percent: number | null; flatPaise: number | null };

async function offersOf(shopId: string): Promise<OfferRow[]> {
  const res = await call(await as("shop"), "GET", `/api/shops/${shopId}/offers`);
  expectStatus(res, 200, "shop A's offers");
  return res.body.offers as OfferRow[];
}

const live = (o: OfferRow) => o.active && Date.parse(o.startsAt) <= Date.now() && Date.parse(o.endsAt) > Date.now();

/** Puts a listing's price back through the assistant's own apply (both prices, as the inventory Save does). */
async function restorePrice(shopId: string, shopProductId: string, pricePaise: number) {
  const now = await listingRow(shopId, shopProductId);
  if (now.online === pricePaise && now.offline === pricePaise) return "already back";
  const res = await call(await as("shop"), "POST", `/api/shops/${shopId}/voice-price/apply`, {
    shopProductId,
    newPricePaise: pricePaise,
    offer: null,
    expectedPricePaise: now.online ?? now.offline,
  });
  expectStatus(res, 200, "restore the price");
  return `restored to ${rupees(pricePaise)}`;
}

async function switchOffOffer(shopId: string, offer: OfferRow) {
  const res = await call(await as("shop"), "PUT", `/api/shops/${shopId}/offers/${offer.id}`, {
    title: offer.title,
    targetType: offer.targetType,
    shopProductId: offer.shopProductId,
    categoryId: offer.categoryId,
    discountType: offer.discountType,
    percent: offer.percent,
    flatPaise: offer.flatPaise,
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    active: false,
  });
  expectStatus(res, 200, "switch the offer off");
}

/* ------------------------------------------------------------------ the voice assistant page */

/**
 * The assistant for shop A. Without ?shopId the page works on the owner's newest shop, not the shop chosen
 * in Seller Central's switcher (seen 23-Nov: "QA Welcome pune 1646" while the header said shop A), so the
 * shop is named in the address, as the case does for staff (TC-VPA-003 step 4).
 */
async function openVoicePage(page: Page, shop: { id: string; name: string }) {
  await page.goto(`/shop/voice-price?shopId=${shop.id}`);
  await expect(page.getByRole("heading", { name: "Change price or offer by voice" })).toBeVisible();
  await expect(page.getByText(`${shop.name} — Say the product`), "the assistant works on shop A").toBeVisible();
  await expect(page.getByTestId("voice-price-assistant")).toBeVisible();
}

/** Types a command, presses Check and, when asked to choose, taps the candidate `pick` matches. */
async function voiceCheck(page: Page, text: string, pick: RegExp) {
  const proposal = page.getByTestId("voice-price-proposal");
  await page.getByTestId("voice-price-text").fill(text);
  let answered = page.waitForResponse((r) => r.url().includes("/voice-price/interpret") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  expect((await answered).status(), "interpret").toBe(200);
  await expect(proposal).toBeVisible();
  const candidates = proposal.getByTestId("voice-price-candidate");
  let chose = false;
  if (!(await proposal.getByTestId("voice-price-product").count())) {
    const candidate = candidates.filter({ has: page.getByText(pick) }).first();
    await expect(candidate, `a candidate matching ${pick}`).toBeVisible();
    answered = page.waitForResponse((r) => r.url().includes("/voice-price/interpret") && r.request().method() === "POST");
    await candidate.click();
    expect((await answered).status(), "interpret with the chosen product").toBe(200);
    chose = true;
  }
  await expect(proposal.getByTestId("voice-price-product")).toHaveText(pick);
  return { proposal, chose };
}

/** The bakery's product card as a customer sees it on the shop page (its category, page by page). */
async function shopCard(page: Page, shopId: string, slug: string, productName: string): Promise<Locator> {
  let cat: string | undefined;
  for (let offset = 0; offset < 1000 && !cat; offset += 100) {
    const rows = await call(await as("customer"), "GET", `/api/shops/${shopId}/products?limit=100&offset=${offset}`);
    expectStatus(rows, 200, "shop A's shelf");
    const list = rows.body as { productName: string; categoryName?: string }[];
    cat = list.find((r) => r.productName === productName)?.categoryName;
    if (list.length < 100) break;
  }
  if (!cat) blocked(`"${productName}" is not on shop A's shelf`);
  for (let n = 1; n <= 10; n++) {
    await page.goto(`/shops/${slug}?cat=${encodeURIComponent(cat)}&page=${n}`);
    const card = page.getByTestId("product-card").and(page.locator(`[data-product-name=${attr(productName)}]`));
    if (await card.count()) return card.first();
    if (!(await page.locator('[data-testid="pager"] a[rel="next"]').count())) break;
  }
  blocked(`the card of "${productName}" is not on /shops/${slug} (category "${cat}")`);
}

/** The admin's audit log (/admin/console/audit-log): the first row holding every one of `parts`. */
async function auditRow(browser: Browser, parts: string[]): Promise<string> {
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/console/audit-log");
    let row = page.getByRole("row");
    for (const p of parts) row = row.filter({ hasText: p });
    await expect(row.first(), `an audit row with ${parts.join(" + ")}`).toBeVisible();
    return (await row.first().innerText()).replace(/\s+/g, " ").trim();
  } finally {
    await context.close();
  }
}

/* ====================================================================== Puja Samagri */

qa("TC-PUJA-026", "a customer is refused the puja setup, the catalogue seed and owner-only item creation of shop A (403 “This shop does not belong to you.”, nothing listed or created); the operator reads shop A's puja setup (200)", async () => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const read = async () => {
    const res = await call(owner, "GET", `/api/shops/${shop.id}/puja`);
    expectStatus(res, 200, "owner reads the puja setup");
    const cats = res.body.categories as { id: string; listed: number }[];
    return { cats, listed: cats.reduce((n, c) => n + c.listed, 0), types: (res.body.types as unknown[] | undefined)?.length ?? 0 };
  };
  const before = await read();
  const role = await plainCustomer();
  const customer = await as(role);
  const base = `/api/shops/${shop.id}`;
  // Bodies that would change nothing even if a call were let through: every category excluded, empty items.
  const calls: [string, "GET" | "POST", string, unknown?][] = [
    ["step 2 setup", "GET", `${base}/puja`],
    ["step 2 seed", "POST", `${base}/puja/seed`, { excludeCategoryIds: before.cats.map((c) => c.id) }],
    ["(step 3's calls, as the customer) new type", "POST", `${base}/puja/types`, {}],
    ["(step 3's calls, as the customer) new product", "POST", `${base}/puja/products`, {}],
    ["(step 3's calls, as the customer) price requests", "GET", `${base}/listing-price-requests`],
  ];
  const seen: string[] = [];
  for (const [what, method, path, body] of calls) {
    const res = await call(customer, method, path, body);
    expectRefusal(res, 403, NOT_YOURS, `${role}: ${what}`);
    seen.push(`${method} ${path.replace(base, "…")} 403`);
  }
  const ops = await call(await as("ops"), "GET", `${base}/puja`);
  expectStatus(ops, 200, "step 4: operator reads shop A's puja setup");
  expect(Array.isArray(ops.body.categories), "the operator gets the setup").toBe(true);
  const after = await read();
  expect(after.listed, "nothing listed in shop A").toBe(before.listed);
  expect(after.types, "no product type created for shop A").toBe(before.types);
  return `${role} (CUSTOMER): ${seen.join(", ")} — each “${NOT_YOURS}”; shop A still lists ${after.listed} puja products and ${after.types} own types; operator GET …/puja 200`;
}, { ...signed, partial: `steps 1 and 3 as shop B's owner not run (${NO_B_OWNER}); step 3's three calls were made as the customer instead (same owner check)` });

qa("TC-PUJA-049", "admin and operator open /admin/puja (“🪔 Puja Samagri & Temple Supplies”, tabs Catalogue, Review queue, Festivals, Configuration) and its APIs (200); shop owner, customer, rider and the oplim account are sent to “/” and refused 403 “You do not have access to this area.”", async ({ browser }) => {
  const seen: string[] = [];
  const oplimRole = (await me("oplim")).role;
  const roles: Role[] = ["admin", "ops", "oplim", "shop", "customer", "rider"];
  for (const role of roles) {
    const user = await me(role);
    const staff = user.role === "ADMIN" || user.role === "OPERATOR";
    const { context, page } = await pageAs(browser, role);
    try {
      await page.goto("/admin/puja");
      if (staff) {
        await expect(page.getByRole("heading", { name: "🪔 Puja Samagri & Temple Supplies" })).toBeVisible();
        const tabs = page.getByTestId("puja-admin");
        for (const [key, name] of [["catalogue", "Catalogue"], ["review", "Review queue"], ["festivals", "Festivals"], ["config", "Configuration"]] as const) {
          await expect(tabs.getByTestId(`puja-admin-tab-${key}`), `${role}: tab ${name}`).toHaveText(name);
        }
        if (role === "ops") {
          // Step 3 (read only): the operator's Configuration tab offers the FSSAI switch, enabled.
          await tabs.getByTestId("puja-admin-tab-config").click();
          await expect(page.getByText("FSSAI for edible items")).toBeVisible();
          await expect(page.getByTestId("puja-config-fssai")).toBeEnabled();
        }
      } else {
        await expect.poll(() => new URL(page.url()).pathname, { message: `${role}: sent to /` }).toBe("/");
        await expect(page.getByRole("heading", { name: "🪔 Puja Samagri & Temple Supplies" })).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
    const ctx = await as(role);
    for (const path of ["/api/admin/puja/config", "/api/admin/puja/catalogue"]) {
      const res = await call(ctx, "GET", path);
      if (staff) expectStatus(res, 200, `${role}: GET ${path}`);
      else expectRefusal(res, 403, STAFF_ONLY, `${role}: GET ${path}`);
    }
    seen.push(`${role} (${user.role}): ${staff ? "page + 4 tabs, APIs 200" : "→ /, APIs 403"}`);
  }
  return seen.join("; ") + (oplimRole !== "OPERATOR_LIMITED" ? `. Note: the oplim account holds role ${oplimRole}, not OPERATOR_LIMITED` : "");
}, { ...signed, partial: "step 3 (the operator unticks and ticks again “FSSAI for edible items” → “Saved.”) not run: it writes business rule pujaSamagri, not allowed on staging in this run — the operator's Configuration tab was seen with the switch enabled; operator-limited is covered only if the oplim account still holds OPERATOR_LIMITED (see the detail)" });

/* ---------------------------------------------------- TC-PUJA-059: puja items in a normal cart */

interface PujaItem {
  productId: string;
  name: string;
  kind: "PACKAGED" | "LOOSE";
  listing: { id: string; state: string; pricePaise: number | null; stock: number } | null;
}

async function pujaItems(shopId: string, query: string): Promise<PujaItem[]> {
  const res = await call(await as("shop"), "GET", `/api/shops/${shopId}/puja/catalogue?limit=200&${query}`);
  expectStatus(res, 200, `shop A's puja catalogue ${query}`);
  return res.body.items as PujaItem[];
}

/** Shop A's cheapest packed kapur listing and a loose flower priced through Ask price. */
async function pujaPair() {
  const shop = await shopOf("A");
  const setup = await call(await as("shop"), "GET", `/api/shops/${shop.id}/puja`);
  if (setup.status === 404) blocked("the Puja Samagri feature is not on this site");
  expectStatus(setup, 200, "puja setup");
  const cats = setup.body.categories as { id: string; slug: string }[];
  const kapurCat = need(cats.find((c) => c.slug === "puja-kapur"), "the puja-kapur category");
  const flowerCat = need(cats.find((c) => c.slug === "puja-phool-patte"), "the puja-phool-patte category");
  const kapur = (await pujaItems(shop.id, `categoryId=${kapurCat.id}&kind=packed`))
    .filter((i) => i.listing?.state === "LISTED" && (i.listing.pricePaise ?? 0) > 0 && i.listing.stock >= 3)
    .sort((a, b) => a.listing!.pricePaise! - b.listing!.pricePaise!)[0];
  if (!kapur?.listing) blocked("shop A lists no priced packed kapur item with stock 3+");
  const flower = (await pujaItems(shop.id, `categoryId=${flowerCat.id}&kind=loose`)).find(
    (i) => i.listing?.state === "LISTED" && (i.listing.pricePaise ?? 0) > 0 && i.listing.stock >= 3,
  );
  if (!flower?.listing) blocked("shop A has no loose flower priced through Ask price (TC-PUJA-015 prices one)");
  const as_ = (i: PujaItem): Listing => ({ shopProductId: i.listing!.id, productId: i.productId, name: i.name, pricePaise: i.listing!.pricePaise, shopId: shop.id, shopName: shop.name });
  return { shop, kapur: as_(kapur), flower: as_(flower) };
}

/** Adds a product from /puja (searched by `q`) to the cart, from shop A's card. */
async function addFromPuja(page: Page, q: string, item: Listing) {
  await page.goto(`/puja?all=1&q=${encodeURIComponent(q)}`);
  const card = page
    .getByTestId("product-card")
    .and(page.locator(`[data-product-name=${attr(item.name)}]`))
    .filter({ has: page.getByTestId("card-shop").getByText(item.shopName, { exact: true }) })
    .first();
  await expect(card, `${item.name} of ${item.shopName} on /puja`).toBeVisible();
  await expect(card, "the card shows the listing's price").toContainText(rupees(item.pricePaise!));
  const added = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/cart" && r.request().method() === "POST");
  await card.getByRole("button", { name: "Add to cart" }).click();
  expect([200, 201], `add ${item.name}`).toContain((await added).status());
}

/** Presses the pay button on /cart and answers the open-order and closed-shop questions; returns the checkout answer. */
async function payOnCart(page: Page) {
  await chooseDeliveryTime(page);
  // The page leaves for the payment page as soon as checkout answers, which drops the answer's body:
  // keep a copy as it passes through.
  const box: { answer?: { status: number; body: Record<string, unknown> | null } } = {};
  await page.route("**/api/checkout", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const res = await route.fetch({ timeout: 180_000 });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    box.answer = { status: res.status(), body };
    await route.fulfill({ response: res, body: text });
  });
  await page.getByRole("button", { name: /^(Pay|Place order)/ }).first().click();
  for (let i = 0; i < 360 && !box.answer; i++) {
    for (const name of ["Ignore and continue", "Yes, continue"]) {
      const b = page.getByRole("button", { name, exact: true });
      if (!box.answer && (await b.isVisible().catch(() => false))) await b.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  if (!box.answer) throw new Error("checkout did not answer within 180 s");
  return box.answer;
}

/** Cashfree's payment session id, as the payer's "Pay online" page hands it to Cashfree's checkout. */
async function cashfreeSession(role: Role, path: string): Promise<string> {
  const html = await call(await as(role), "GET", path);
  expectStatus(html, 200, "the Pay online page");
  expect(html.text, "Cashfree checkout in sandbox mode").toMatch(/mode\\?"\s*:\s*\\?"sandbox/);
  return need(html.text.match(/sessionToken\\?"\s*:\s*\\?"([^"\\]+)/)?.[1], "the payment session id on the Pay online page");
}

/** Pays a Cashfree sandbox session with UPI testsuccess@gocash through the "Sandbox payment" workflow (never the session id in a log). */
function runSandboxPayWorkflow(session: string) {
  if (IS_LOCAL) blocked("the Cashfree sandbox is paid through the GitHub workflow on the test site only");
  try {
    execFileSync("gh", ["workflow", "run", "sandbox-pay.yml", "--ref", "staging", "-f", `session=${session}`, "-f", "instrument=upi-success"], { stdio: "pipe", timeout: 60_000 });
  } catch (error) {
    blocked(`the "Sandbox payment" workflow could not be started (${(error as Error).message.replace(session, "<session>").slice(0, 160)})`);
  }
}

function latestSandboxPayRuns(): { databaseId: number; status: string; conclusion: string; createdAt: string }[] {
  try {
    return JSON.parse(execFileSync("gh", ["run", "list", "--workflow", "sandbox-pay.yml", "--limit", "5", "--json", "databaseId,status,conclusion,createdAt"], { encoding: "utf8", timeout: 60_000 }));
  } catch {
    return [];
  }
}

qa("TC-PUJA-059", "a packed kapur item and a flower priced through Ask price go from /puja into one shop cart at their prices; paid online (Cashfree sandbox, UPI testsuccess@gocash) the order is paid and CONFIRMED, each item's stock drops by the quantity and the shop is notified", async ({ browser }) => {
  stash(KEY, null);
  const { shop, kapur, flower } = await pujaPair();
  const buyer: Role = "customer2";
  await emptyCart(buyer);
  const stock0 = { kapur: await stockOf(kapur), flower: await stockOf(flower) };
  const since = Date.now();
  const { context, page } = await pageAs(browser, buyer);
  let checkout: { status: number; body: Record<string, unknown> | null };
  let qty = { kapur: 1, flower: 1 };
  try {
    await addFromPuja(page, kapur.name.split(" – ")[0], kapur);
    await addFromPuja(page, flower.name.split(" (")[0], flower);
    const lines = await cartLines(buyer);
    expect(lines.map((l) => l.shopProductId).sort(), "the cart holds the two puja lines").toEqual([kapur.shopProductId, flower.shopProductId].sort());
    qty = { kapur: Number(lines.find((l) => l.shopProductId === kapur.shopProductId)!.quantity), flower: Number(lines.find((l) => l.shopProductId === flower.shopProductId)!.quantity) };
    await page.goto("/cart");
    const group = page.getByRole("link", { name: shop.name, exact: true });
    await expect(group, "one shop group for shop A").toHaveCount(1);
    for (const item of [kapur, flower]) {
      const line = page.locator("li").filter({ has: page.getByText(item.name, { exact: true }) }).first();
      await expect(line, `${item.name} in the cart`).toBeVisible();
      await expect(line, `${item.name} at its price`).toContainText(`${rupees(item.pricePaise!)} ×`);
    }
    const missing = page.getByTestId("checkout-missing-details");
    if (await missing.isVisible().catch(() => false)) blocked(`${buyer} cannot check out: ${(await missing.innerText()).replace(/\s+/g, " ")}`);
    const online = page.getByTestId("pay-online-option");
    if (!(await online.count())) blocked("'Pay online' is not offered on this site (rule onlinePayments off)");
    await online.getByRole("radio").check();
    checkout = await payOnCart(page);
  } finally {
    await context.close();
  }
  if (checkout.status === 409 || checkout.status === 422) blocked(`online checkout refused — HTTP ${checkout.status}: ${JSON.stringify(checkout.body?.error ?? checkout.body).slice(0, 200)}`);
  expect(checkout.status, "checkout answered 201").toBe(201);
  const order = (checkout.body!.orders as { id: string; orderNumber: string; totalPaise: number }[])[0];
  const payment = checkout.body!.payment as { intentId: string; redirectUrl: string | null };
  stash(KEY, { orderId: order.id, orderNumber: order.orderNumber, buyer, items: [kapur.shopProductId, flower.shopProductId] });
  const url = payment.redirectUrl ?? "";
  const path = url.startsWith("http") ? new URL(url).pathname : url;
  let how: string;
  if (/^\/orders\/pay\/session\//.test(path)) {
    const session = await cashfreeSession(buyer, path);
    const started = Date.now();
    runSandboxPayWorkflow(session);
    how = "Cashfree sandbox (UPI testsuccess@gocash via the Sandbox payment workflow)";
    const view = await poll(() => intentView(buyer, payment.intentId), (v) => ["CAPTURED", "FAILED", "EXPIRED"].includes(v.status), 600_000, 15_000);
    if (view.status !== "CAPTURED") {
      const run = latestSandboxPayRuns().find((r) => Date.parse(r.createdAt) >= started - 10_000);
      throw new Error(`the payment is ${view.status} after the workflow (latest run: ${run ? `${run.databaseId} ${run.status}/${run.conclusion}` : "not found"})`);
    }
  } else if (/^\/orders\/pay\/sandbox\//.test(path)) {
    const pay = await pageAs(browser, buyer);
    try {
      const ret = await paySandbox(pay.page, { redirectUrl: path }, "pay", "UPI");
      await expect(ret).toContainText("Payment received");
    } finally {
      await pay.context.close();
    }
    how = "the site's built-in sandbox page (PAYMENT_GATEWAY=SANDBOX), UPI, Pay (success)";
  } else {
    throw new Error(`Pay online opened ${url || "no page"}`);
  }
  const row = await orderOf(buyer, order.id);
  expect(row?.status, "the order after the captured payment").toBe("CONFIRMED");
  expect(row?.paymentMethod).toBe("ONLINE");
  expect(row?.paidAt, "paid").toBeTruthy();
  const stock1 = { kapur: await stockOf(kapur), flower: await stockOf(flower) };
  if (stock0.kapur !== undefined) expect(stock1.kapur, `${kapur.name}: stock down by ${qty.kapur}`).toBe(stock0.kapur - qty.kapur);
  if (stock0.flower !== undefined) expect(stock1.flower, `${flower.name}: stock down by ${qty.flower}`).toBe(stock0.flower - qty.flower);
  const shopNote = (await notificationsOf("shop")).notifications.find((n) => n.body.includes(order.orderNumber) && Date.parse(n.createdAt) >= since - 5_000);
  expect(shopNote, `shop A notified of ${order.orderNumber}`).toBeTruthy();
  const buyerNote = (await notificationsOf(buyer)).notifications.find((n) => (n.body.includes(order.orderNumber) || n.title.includes(order.orderNumber)) && Date.parse(n.createdAt) >= since - 5_000);
  return `${buyer}: ${kapur.name} ${rupees(kapur.pricePaise!)} + ${flower.name} ${rupees(flower.pricePaise!)} in one shop-A cart from /puja (qty ${qty.kapur} + ${qty.flower}); ${order.orderNumber} ₹${order.totalPaise / 100} paid via ${how} → CONFIRMED/ONLINE; stock ${stock0.kapur}→${stock1.kapur}, ${stock0.flower}→${stock1.flower}; shop: "${shopNote!.title}"; customer: ${buyerNote ? `"${buyerNote.title}"` : "no order notice seen"}`;
}, { ...signed, timeout: 900_000, partial: "delivery with the OTP is the third TC-PUJA-059 check; cash on delivery the second" });

qa("TC-PUJA-059", "a second puja order paid by cash on delivery from the same cart", async ({ browser }) => {
  const { kapur, flower } = await pujaPair();
  const buyer: Role = "customer2";
  await fillCart(buyer, [{ listing: kapur }, { listing: flower }]);
  const { context, page } = await pageAs(browser, buyer);
  try {
    await page.goto("/cart");
    const pay = page.getByTestId("payment-method");
    await expect(pay).toBeVisible();
    const cod = pay.getByRole("radio", { name: "Cash on delivery", exact: true });
    if (await cod.isDisabled()) {
      const reason = (await pay.locator("p").last().innerText().catch(() => "")).trim();
      blocked(`cash on delivery is not offered for shop A's cart: “${reason}” (shop A's own COD setting is off; changing a shop setting is outside this run)`);
    }
    await cod.check();
    const checkout = await payOnCart(page);
    if (checkout.status === 409 || checkout.status === 422) blocked(`COD checkout refused — HTTP ${checkout.status}: ${JSON.stringify(checkout.body?.error ?? checkout.body).slice(0, 200)}`);
    expect(checkout.status, "COD checkout 201").toBe(201);
    const order = (checkout.body!.orders as { id: string; orderNumber: string; status: string; paymentMethod?: string }[])[0];
    const row = await orderOf(buyer, order.id);
    expect(row?.status).toMatch(/CONFIRMED|ACCEPTED/);
    expect(row?.paymentMethod).toBe("COD");
    // Not delivered here: customer2 must not keep an open COD order (E-16).
    const cancel = await call(await as(buyer), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA TC-PUJA-059 COD leg" });
    expectStatus(cancel, 200, "cancel the COD order");
    return `${order.orderNumber}: COD → ${row?.status}; cancelled again before packing`;
  } finally {
    await context.close();
    await emptyCart(buyer);
  }
}, { ...signed, timeout: 600_000, partial: "delivery of the COD order with the OTP not run (cancelled before packing so no open COD order stays)" });

qa("TC-PUJA-059", "the puja order is accepted, packed and delivered with the customer's OTP (DELIVERED)", async () => {
  const placed = unstash<{ orderId: string; orderNumber: string; buyer: Role } | null>(KEY);
  if (!placed) blocked("needs the puja order paid online by the first TC-PUJA-059 check in this run");
  const shopCtx = await as("shop");
  const plan = await call(shopCtx, "GET", `/api/orders/${placed.orderId}/fulfilment-plan`);
  expectStatus(plan, 200, "delivery plan options");
  const slot = (plan.body?.days as { slots: { key: string; start?: string }[] }[] | undefined)?.[0]?.slots[0];
  const start = slot?.start ? Date.parse(slot.start) : NaN;
  if (!slot || Number.isNaN(start) || start - Date.now() > 60 * 60_000) {
    const when = Number.isNaN(start) ? "none offered" : new Date(start).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST";
    // Nobody can deliver it now: cancel it before packing (the online payment is refunded) so no open order stays.
    const cancel = await call(await as(placed.buyer), "PATCH", `/api/orders/${placed.orderId}/status`, { status: "CANCELLED", note: "QA TC-PUJA-059: cannot be delivered at this hour" });
    const after = await orderAs(placed.buyer, placed.orderId);
    blocked(
      `no delivery possible now: the earliest delivery slot is ${when} (the site's delivery hours are 07.00–22.00 IST; the rider search starts shortly before the slot). ` +
        `${placed.orderNumber} was cancelled before packing (HTTP ${cancel.status}, now ${after?.status ?? "?"})`,
    );
  }
  const { packOrder, deliver } = await import("../lib/flows");
  await packOrder(placed.orderId);
  await deliver(placed.orderId, { customer: placed.buyer });
  const done = await orderAs(placed.buyer, placed.orderId);
  expect(done?.status).toBe("DELIVERED");
  return `${placed.orderNumber}: accepted → packed → picked up → delivered with the customer's code (DELIVERED)`;
}, { ...signed, timeout: 600_000, partial: "the COD order's delivery is not part of this check" });

/* ====================================================================== Shop logo */

qa("TC-LOGO-006", "a guest's logo upload is 401; a customer's upload and removal are 403 “This shop does not belong to you.” and shop A's logo is unchanged; the operator's upload is 201 and its audit row names the operator", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const logoOf = async () => {
    const res = await call(owner, "GET", `/api/shops/${shop.id}`);
    expectStatus(res, 200, "shop A's details");
    return (res.body.logoUrl ?? null) as string | null;
  };
  const before = await logoOf();
  const file = () => ({ file: { name: "qa-logo.png", mimeType: "image/png", buffer: png(200, 200) } }) as never;
  const path = `/api/shops/${shop.id}/logo`;
  let uploaded = false;
  try {
    const guest = await call(await anonymous(), "POST", path, undefined, { multipart: file() });
    expect(guest.status, `guest POST — ${why(guest)}`).toBe(401);
    const role = await plainCustomer();
    const customer = await as(role);
    expectRefusal(await call(customer, "POST", path, undefined, { multipart: file() }), 403, NOT_YOURS, `${role} POST`);
    expectRefusal(await call(customer, "DELETE", path), 403, NOT_YOURS, `${role} DELETE`);
    expect(await logoOf(), "shop A's logo unchanged").toBe(before);
    const ops = await call(await as("ops"), "POST", path, undefined, { multipart: file() });
    expectStatus(ops, 201, "operator POST");
    uploaded = true;
    const logoUrl = String(ops.body?.logoUrl ?? "");
    expect(logoUrl, "the new logo").toMatch(/^\/api\/images\/[0-9a-f-]{36}$/);
    expect(await logoOf()).toBe(logoUrl);
    const imageId = logoUrl.split("/").pop()!;
    const opsUser = await me("ops");
    const row = await auditRow(browser, ["image.uploaded", imageId.slice(0, 8), `"shopId":"${shop.id}"`]);
    expect(row, "the audit row's purpose").toContain('"purpose":"SHOP_LOGO"');
    expect(row, "the audit row names the operator").toContain("OPERATOR");
    expect(row).toContain(opsUser.name || opsUser.email);
    return `guest 401; ${role} POST/DELETE 403 “${NOT_YOURS}”, logo unchanged (${before ?? "none"}); operator POST 201 → ${logoUrl}; audit: ${row.slice(0, 220)}`;
  } finally {
    if (uploaded) {
      // Put shop A's logo back as it was.
      const back = before === null ? await call(owner, "DELETE", path) : await call(owner, "PATCH", `/api/shops/${shop.id}`, { logoUrl: before });
      expectStatus(back, 200, "restore shop A's logo");
    }
  }
}, { ...signed, partial: `steps 3 (shop B's owner) and 4 (shop A's staff member) not run: ${NO_B_OWNER}; ${NO_STAFF}. Shop A's logo is put back afterwards (removed again when it had none)` });

/* ====================================================================== Voice price & offer assistant */

qa("TC-VPA-002", "a guest opening /shop/voice-price is sent to sign in, with /shop/voice-price kept as the page to come back to; interpret and apply answer 401 and nothing changes", async ({ page, context }) => {
  const { shop, row } = await bread();
  await page.goto("/shop/voice-price");
  await page.waitForURL(/\/signin/, { timeout: 60_000 });
  const url = new URL(page.url());
  expect(url.pathname).toBe("/signin");
  // Seller Central's layout sends a guest to plain /signin before the page's own redirect (?next=) runs;
  // the way back is the D-23 return-to cookie the proxy writes on every page load.
  const returnTo = (await context.cookies()).find((c) => c.name === "gk_return_to")?.value;
  expect(decodeURIComponent(returnTo ?? ""), "the page to come back to after signing in").toBe("/shop/voice-price");
  const guest = await anonymous();
  const interpret = await call(guest, "POST", `/api/shops/${shop.id}/voice-price/interpret`, { text: "Bread price 42 rupees" });
  expect(interpret.status, `interpret — ${why(interpret)}`).toBe(401);
  const apply = await call(guest, "POST", `/api/shops/${shop.id}/voice-price/apply`, { shopProductId: row.shopProductId, newPricePaise: row.online, offer: null, expectedPricePaise: row.online });
  expect(apply.status, `apply — ${why(apply)}`).toBe(401);
  const after = await listingRow(shop.id, row.shopProductId);
  expect([after.online, after.offline], "Bread's prices unchanged").toEqual([row.online, row.offline]);
  return `/shop/voice-price → ${url.pathname}${url.search} (gk_return_to = /shop/voice-price, no ?next= in the URL); interpret 401, apply 401; Bread still ${rupees(row.online ?? 0)}`;
}, { ...signed, partial: "the case expects /signin?next=/shop/voice-price; the site sends the guest to /signin and keeps the way back in the gk_return_to cookie (D-23) — checked that way" });

qa("TC-VPA-003", "a customer's interpret and the admin's apply for the bakery are 403 “Only the shop's owner can change prices and offers by voice.”; no price or offer changes", async () => {
  const { shop, row } = await bread();
  const offers0 = (await offersOf(shop.id)).length;
  const role = await plainCustomer();
  const base = `/api/shops/${shop.id}/voice-price`;
  expectRefusal(await call(await as(role), "POST", `${base}/interpret`, { text: "Bread price 42 rupees" }), 403, VOICE_OWNER_ONLY, `${role} interpret`);
  // The body asks for Bread's own price: even if it were let through nothing would change.
  const body = { shopProductId: row.shopProductId, newPricePaise: row.online, offer: null, expectedPricePaise: row.online };
  expectRefusal(await call(await as("admin"), "POST", `${base}/apply`, body), 403, VOICE_OWNER_ONLY, "admin apply");
  expectRefusal(await call(await as("admin"), "POST", `${base}/interpret`, { text: "Bread price 42 rupees" }), 403, VOICE_OWNER_ONLY, "admin interpret");
  const after = await listingRow(shop.id, row.shopProductId);
  expect([after.online, after.offline], "Bread's prices unchanged").toEqual([row.online, row.offline]);
  expect((await offersOf(shop.id)).length, "no offer added").toBe(offers0);
  return `${role} interpret 403, admin apply and interpret 403 — “${VOICE_OWNER_ONLY}”; Bread still ${rupees(row.online ?? 0)}, ${offers0} offers`;
}, { ...signed, partial: `step 2 (another shop's owner: interpret and apply) and step 4 (the bakery's staff member sees the warning, no assistant) not run: ${NO_B_OWNER}; ${NO_STAFF}` });

qa("TC-VPA-015", "“Bread price 42 rupees” → Yes, publish: online and in-store price ₹42, the inventory page and the customer see ₹42, the text box and proposal clear and “Next product” is offered", async ({ browser }) => {
  const { shop, row } = await bread();
  if (row.online !== 4000 || row.offline !== 4000) blocked(`Bread is not at ₹40 online and in the shop (${row.online} / ${row.offline} paise) — the case's starting point`);
  if (row.mrp !== null) blocked(`Bread has an MRP (${row.mrp} paise); the case wants none`);
  if ((await offersOf(shop.id)).some((o) => o.shopProductId === row.shopProductId && live(o))) blocked("a live offer on Bread would change what the customer pays");
  const owner = await rolePage(browser, "shop");
  let published = false;
  try {
    await openVoicePage(owner.page, shop);
    const { proposal, chose } = await voiceCheck(owner.page, "Bread price 42 rupees", /^Bread · /);
    await expect(proposal.getByTestId("voice-price-new-price")).toHaveText(/₹40\s*₹42/);
    const applied = owner.page.waitForResponse((r) => r.url().includes("/voice-price/apply") && r.request().method() === "POST");
    await proposal.getByTestId("voice-price-publish").click();
    const res = await applied;
    published = res.status() === 200;
    expect(res.status(), "apply").toBe(200);
    const done = owner.page.getByTestId("voice-price-done");
    await expect(done).toHaveText(/^Published: Bread · .*price ₹40 → ₹42/);
    await expect(proposal, "the proposal clears").toBeHidden();
    await expect(owner.page.getByTestId("voice-price-text"), "the text box clears").toHaveValue("");
    await expect(owner.page.getByRole("button", { name: "Next product" })).toBeVisible();
    const doneText = (await done.innerText()).trim();
    const now = await listingRow(shop.id, row.shopProductId);
    expect([now.online, now.offline], "online and in-store prices").toEqual([4200, 4200]);
    await owner.page.goto("/shop/inventory");
    await owner.page.getByTestId("inventory-filters").getByLabel("Search products", { exact: true }).fill("Bread");
    await expect(owner.page.getByLabel("Price of Bread", { exact: true })).toHaveValue("42");
    const customer = await rolePage(browser, "customer");
    try {
      await customer.page.goto(`/products/${row.productId}`);
      const offer = customer.page.getByTestId("price-comparison").locator("> div").filter({ has: customer.page.getByRole("link", { name: shop.name, exact: true }) });
      await expect(offer, "the customer sees ₹42 at the bakery").toContainText("₹42");
    } finally {
      await customer.context.close();
    }
    return `${chose ? "chose Bread among the candidates; " : ""}“${doneText}”; online/in-store 4200/4200 paise; inventory shows 42; customer sees ₹42; text box and proposal cleared, “Next product” offered`;
  } finally {
    await owner.context.close();
    if (published) await restorePrice(shop.id, row.shopProductId, 4000);
  }
}, { ...signed, mobile: true, partial: "the product_price_history row (₹40 → ₹42) is not read: needs database access (developer). Bread's price is put back to ₹40 afterwards (same apply path)" });

qa("TC-VPA-019", "“ब्रेड 10 टक्के सूट रविवार पर्यंत” → Yes, publish: a live “10% off · Bread” shop offer ending 23.59 IST on the coming Sunday, listed in Marketing → Offers, audited; the customer sees ₹36; Switch off stops it", async ({ browser }) => {
  const { shop, row } = await bread();
  if (row.online !== 4000) blocked(`Bread is not at ₹40 (${row.online} paise) — the case's starting point`);
  const before = await offersOf(shop.id);
  if (before.some((o) => o.shopProductId === row.shopProductId && live(o))) blocked("a live offer on Bread already exists");
  // The coming Sunday, 23.59.59 IST (today's date when today is Sunday).
  const istNow = new Date(Date.now() + 5.5 * 3_600_000);
  const daysToSunday = (7 - istNow.getUTCDay()) % 7;
  const sundayEnd = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + daysToSunday, 23, 59, 59, 999) - 5.5 * 3_600_000;
  const sundayLabel = new Date(sundayEnd).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const owner = await rolePage(browser, "shop");
  let offerId: string | null = null;
  try {
    await openVoicePage(owner.page, shop);
    const { proposal, chose } = await voiceCheck(owner.page, "ब्रेड 10 टक्के सूट रविवार पर्यंत", /^Bread · /);
    await expect(proposal.getByTestId("voice-price-offer")).toHaveText(`10% off until ${sundayLabel}`);
    await expect(proposal).toContainText("₹36");
    const applied = owner.page.waitForResponse((r) => r.url().includes("/voice-price/apply") && r.request().method() === "POST");
    await proposal.getByTestId("voice-price-publish").click();
    const res = await applied;
    const result = (await res.json().catch(() => null)) as { offerId?: string; offerEndsAt?: string } | null;
    offerId = result?.offerId ?? null;
    expect(res.status(), "apply").toBe(200);
    const doneText = (await owner.page.getByTestId("voice-price-done").innerText()).trim();
    expect(doneText).toMatch(new RegExp(`^Published: Bread( · [^·]+)? · 10% off until ${sundayLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    const offer = need((await offersOf(shop.id)).find((o) => o.id === offerId), "the published offer in shop A's offers");
    expect(offer).toMatchObject({ title: "10% off · Bread", targetType: "PRODUCT", shopProductId: row.shopProductId, discountType: "PERCENT", percent: 10, active: true });
    expect(Math.abs(Date.parse(offer.startsAt) - Date.now()), "starts now").toBeLessThan(10 * 60_000);
    expect(Date.parse(offer.endsAt), "ends 23.59 IST on the coming Sunday").toBe(sundayEnd);
    const audit = await auditRow(browser, ["shop.offer_saved", offerId!.slice(0, 8)]);
    // The customer sees the offer price on the bakery's Bread.
    const customer = await rolePage(browser, "customer");
    try {
      const card = await shopCard(customer.page, shop.id, shop.slug, "Bread");
      await expect(card).toContainText("₹36");
      await expect(card.getByTestId("offer-list-price")).toHaveText("₹40");
      await expect(card.getByTestId("product-offer")).toHaveText("10% off · Bread");
    } finally {
      await customer.context.close();
    }
    // Marketing → Offers lists it, on, with Switch off; switching it off stops it.
    await owner.page.goto("/shop/offers");
    const listed = owner.page.getByTestId("shop-offer-row").filter({ hasText: "10% off · Bread" }).filter({ has: owner.page.getByRole("button", { name: "Switch off" }) });
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText("on");
    const put = owner.page.waitForResponse((r) => r.url().includes(`/offers/${offerId}`) && r.request().method() === "PUT");
    await listed.getByRole("button", { name: "Switch off" }).click();
    expect((await put).status(), "switch off").toBe(200);
    const stopped = (await offersOf(shop.id)).find((o) => o.id === offerId);
    expect(stopped?.active, "the offer is off").toBe(false);
    return `${chose ? "chose Bread among the candidates; " : ""}“${doneText}”; offer ${offerId!.slice(0, 8)} “10% off · Bread”, PRODUCT Bread, 10%, ${offer.startsAt} → ${offer.endsAt} (Sun 23.59 IST), active; audit: ${audit.slice(0, 160)}; customer card ₹36 (₹40 struck); listed in Offers and switched off there`;
  } finally {
    await owner.context.close();
    if (offerId) {
      const offer = (await offersOf(shop.id)).find((o) => o.id === offerId);
      if (offer?.active) await switchOffOffer(shop.id, offer);
    }
  }
}, { ...signed, partial: "editing the offer in Marketing → Offers is not exercised (the page offers Switch on / off); the offer is switched off at the end" });

qa("TC-VPA-021", "a voice price above the product's MRP is blocked with “The price can't be more than the MRP (₹…).” and no live Yes button; a price equal to the MRP may be published", async ({ browser }) => {
  const shop = await shopOf("A");
  const rows = await ownerListings(shop.id);
  // The case's product (MRP ₹50, price ₹45); otherwise a packed puja item whose price equals its MRP. Nothing is published.
  const exact = rows.find((r) => r.mrpPaise === 5000 && r.onlinePricePaise === 4500);
  const substitute = rows.find((r) => r.productName === "Kapur Cubes – 25 g" && r.mrpPaise != null && r.onlinePricePaise != null);
  const target = need(exact ?? substitute, "a listed product with an MRP on shop A");
  const mrp = target.mrpPaise!;
  const spoken = target.productName.split(" – ")[0];
  const label = new RegExp(`^${target.productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · `);
  const owner = await rolePage(browser, "shop");
  try {
    await openVoicePage(owner.page, shop);
    const above = await voiceCheck(owner.page, `${spoken} price ${mrp / 100 + 10} rupees`, label);
    await expect(above.proposal.getByText(`The price can't be more than the MRP (${rupees(mrp)}).`)).toBeVisible();
    await expect(above.proposal.getByTestId("voice-price-publish"), "no Yes for a price above the MRP").toBeDisabled();
    await above.proposal.getByRole("button", { name: "No, change it" }).click();
    const equal = await voiceCheck(owner.page, `${spoken} price ${mrp / 100} rupees`, label);
    await expect(equal.proposal.getByText(/more than the MRP/)).toHaveCount(0);
    await expect(equal.proposal.getByTestId("voice-price-publish"), "a price equal to the MRP may be published").toBeEnabled();
    await equal.proposal.getByRole("button", { name: "No, change it" }).click();
  } finally {
    await owner.context.close();
  }
  const after = (await ownerListings(shop.id)).find((r) => r.shopProductId === target.shopProductId);
  expect(after?.onlinePricePaise, "price unchanged").toBe(target.onlinePricePaise);
  return `${exact ? "" : `no MRP ₹50 / ₹45 product on shop A: used ${target.productName} (MRP ${rupees(mrp)}, price ${rupees(target.onlinePricePaise!)}); `}“price ${mrp / 100 + 10}” → “The price can't be more than the MRP (${rupees(mrp)}).”, Yes disabled; “price ${mrp / 100}” → no warning, Yes enabled (not pressed); price unchanged`;
}, { ...signed, mobile: true, partial: "step 3 (POST …/apply with a price above the MRP → 422, price unchanged) not run: shop A has no MRP ₹50 / price ₹45 product, and no other product may be sent to apply in this run; steps 1–2 used the substitute named in the detail when the case's product is missing" });

/* ====================================================================== Smart shopping: add by photo, flag off */

qa("TC-SMART-026", "with shop_photo_listing_enabled off: no “Add product by photo” tile under Inventory, /shop/photo-listing is 404, the drafts API answers 404 “This feature is not available.”; a guest's drafts and voice calls are 401", async ({ browser }) => {
  const flags = await call(await as("admin"), "GET", "/api/admin/feature-flags");
  expectStatus(flags, 200, "feature flags");
  const flag = (flags.body.flags as { key: string; enabled: boolean; districtCodes: string[] | null }[]).find((f) => f.key === "shop_photo_listing_enabled");
  if (flag?.enabled) blocked(`shop_photo_listing_enabled is on here (districts ${JSON.stringify(flag.districtCodes)}); this check is for the flag-off state`);
  const shop = await shopOf("A");
  const owner = await rolePage(browser, "shop");
  let pageSeen = "";
  try {
    await owner.page.goto("/shop/menu/inventory");
    const hub = owner.page.getByTestId("menu-hub");
    await expect(hub).toBeVisible();
    // The voice-price tile (its flag is on) shows that flagged tiles do render here.
    await expect(hub.getByTestId("hub-tile").and(owner.page.locator('[data-key="voicePrice"]'))).toHaveCount(1);
    await expect(hub.getByTestId("hub-tile").and(owner.page.locator('[data-key="addByPhoto"]')), "no Add product by photo tile").toHaveCount(0);
    await expect(hub.getByText("Add product by photo")).toHaveCount(0);
    const res = await owner.page.goto(`/shop/photo-listing?shopId=${shop.id}`);
    const status = res?.status() ?? 0;
    // Under Seller Central's streamed layout a page's 404 comes inside a 200 answer (as in TC-SEC-009).
    const inPage404 = status === 200 && (await owner.page.getByRole("heading", { name: /does not exist|not found/i }).first().isVisible({ timeout: 15_000 }).catch(() => false));
    expect(inPage404 ? 404 : status, `/shop/photo-listing → ${status}`).toBe(404);
    await expect(owner.page.getByRole("heading", { name: "Add product by photo" })).toHaveCount(0);
    await expect(owner.page.getByText("Take 1–4 photos")).toHaveCount(0);
    pageSeen = inPage404 ? `200 with the not-found page (“${(await owner.page.getByRole("heading", { name: /does not exist|not found/i }).first().innerText()).trim()}”)` : "404";
  } finally {
    await owner.context.close();
  }
  const photo = () => ({ photo: { name: "front.png", mimeType: "image/png", buffer: png(200, 200) }, side: "FRONT" }) as never;
  const drafts = `/api/shops/${shop.id}/photo-listing/drafts`;
  const own = await call(await as("shop"), "POST", drafts, undefined, { multipart: photo() });
  expectRefusal(own, 404, "This feature is not available.", "owner POST drafts");
  const guest = await anonymous();
  const g1 = await call(guest, "POST", drafts, undefined, { multipart: photo() });
  expect(g1.status, `guest drafts — ${why(g1)}`).toBe(401);
  const g2 = await call(guest, "POST", `/api/shops/${shop.id}/photo-listing/voice`, { text: "price 40 rupees stock 10" });
  expect(g2.status, `guest voice — ${why(g2)}`).toBe(401);
  const role = await plainCustomer();
  const c = await call(await as(role), "POST", drafts, undefined, { multipart: photo() });
  expect([403, 404], `${role} drafts — ${why(c)}`).toContain(c.status);
  return `flag off; Inventory menu: no addByPhoto tile (voicePrice tile present); /shop/photo-listing: ${pageSeen}; owner drafts 404 “This feature is not available.”; guest drafts 401, voice 401; ${role} drafts ${c.status} (${errorText(c)})`;
}, { ...signed, mobile: true, partial: "the flag-on half (tile, page text, customer / other owner 403, staff warning, operator use) is not run: switching the flag on is not allowed on staging in this run, and there is no shop B owner or staff session; “no AI call is made” is not observable without database access" });
