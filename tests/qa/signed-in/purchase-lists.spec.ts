/**
 * Purchase lists (docs/purchase-lists-2026-10) as a signed-in customer:
 * create shopping and medicine lists, add products from a product card, set
 * this time's quantities (0 = skip), notes, the "Check list" confirmation
 * priced like the cart, sending the list to the cart (add to it or replace
 * it), saving the cart as a list, editing and deleting lists, who may see a
 * list, the ways in and the phone layout.
 *
 * Signed-in tier: the test site (staging customer accounts of
 * tests/qa/worlds/staging.json, products of the world's shop A) and the
 * local server. What it writes and how it cleans up:
 *  - only lists named "QA PL <run> …" — each check deletes the lists it made
 *    (and any "QA PL" list left over from a run more than two hours old);
 *  - the customer's cart: a check that changes it puts it back as it found it
 *    (same products and quantities) when it ends, pass or fail;
 *  - never an order, never a payment: "Confirm order" only fills the cart.
 * Every check stands alone (its own lists, its own cart state), so one
 * failure never hides the checks after it.
 */
import type { Locator, Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { addToCart, cartLines, emptyCart, shopOf } from "../lib/flows";
import { call, expectStatus, RUN, why, type Answer, type Method } from "../lib/http";
import { blocked, expect, manual, qa, test } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";
import { assertWritable } from "../lib/target";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };
const PREFIX = "QA PL";

/* ------------------------------------------------------------- the data */

type Kind = "SHOPPING" | "MEDICINE";
type Frequency = "WEEKLY" | "MONTHLY";

interface ListSummary {
  id: string;
  name: string;
  kind: Kind;
  frequency: Frequency;
  remind: boolean;
  lastOrderedAt: string | null;
  nextDueAt: string;
  itemCount: number;
  activeItemCount: number;
  createdAt: string;
}

interface ListItem {
  itemId: string;
  shopProductId: string;
  quantity: number;
  note: string | null;
  exists: boolean;
  productName: string;
  unitPricePaise: number | null;
  lineTotalPaise: number;
  purchasable: boolean;
  unavailableReason: string | null;
}

interface ListDetail extends ListSummary {
  items: ListItem[];
  estimatedSubtotalPaise: number;
}

interface CheckLine {
  cartItemId: string;
  shopProductId: string;
  productName: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  purchasable: boolean;
  unavailableReason: string | null;
  offerTitle?: string;
}

interface Check {
  listId: string;
  listName: string;
  preview: {
    groups: { shop: { id: string; name: string }; lines: CheckLine[]; subtotalPaise: number; deliveryFeePaise: number; taxPaise: number; totalPaise: number }[];
    grandTotalPaise: number;
  };
  skipped: { itemId: string; productName: string }[];
  missing: { itemId: string; productName: string }[];
  cartItemCount: number;
}

/** A product of shop A as its storefront lists it. */
interface Row {
  shopProductId: string;
  productId: string;
  productName: string;
  categoryName: string;
  unitSizeMilli: number;
  onlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  isAvailable: boolean;
  trackInventory: boolean;
  /** The count, where the API gives it (the shop's own view, or builds before D-90); otherwise read through a check (shopRows). */
  onlineStock: number;
  /** What customers are told instead of the count (D-90 / TC-SPI-027). */
  inStock?: boolean;
  shopId: string;
  shopName: string;
  shopSlug: string;
}

const isPhone = () => test.info().project.name === "mobile";

/** A name only this run of this spec uses (lists are unique per customer, any case). */
function listName(what: string) {
  return `${PREFIX} ${RUN}${isPhone() ? " m" : ""} ${what}`;
}

async function api(method: Method, path: string, body?: unknown, role: "customer" | "customer2" = "customer"): Promise<Answer> {
  return call(await as(role), method, path, body);
}

async function myLists(): Promise<ListSummary[]> {
  const res = await api("GET", "/api/purchase-lists");
  expectStatus(res, 200, "GET /api/purchase-lists");
  return res.body.lists as ListSummary[];
}

async function getList(id: string): Promise<ListDetail> {
  const res = await api("GET", `/api/purchase-lists/${id}`);
  expectStatus(res, 200, `GET list ${id}`);
  return res.body as ListDetail;
}

async function createList(what: string, extra: { kind?: Kind; frequency?: Frequency; remind?: boolean } = {}): Promise<ListSummary> {
  assertWritable("create a purchase list");
  const res = await api("POST", "/api/purchase-lists", { name: listName(what), ...extra });
  if (res.status === 409 && /up to \d+ lists/i.test(why(res))) blocked(`the customer already keeps the most lists allowed — ${why(res)}`);
  expectStatus(res, 201, `create list "${listName(what)}"`);
  return res.body as ListSummary;
}

async function addItem(listId: string, row: Row, quantity = 1, note?: string): Promise<ListItem> {
  const res = await api("POST", `/api/purchase-lists/${listId}/items`, { shopProductId: row.shopProductId, quantity, ...(note ? { note } : {}) });
  expectStatus(res, 201, `add ${row.productName} ×${quantity} to the list`);
  return res.body.item as ListItem;
}

/**
 * Deletes the lists this run made, and "QA PL" lists of runs over two hours
 * old (a crashed run's leftovers). Nothing else of the customer's is touched.
 */
async function sweepLists() {
  const mine = `${PREFIX} ${RUN} `;
  const stale = Date.now() - 2 * 3600_000;
  for (const list of await myLists()) {
    const ours = list.name.startsWith(mine) || (list.name.startsWith(`${PREFIX} `) && Date.parse(list.createdAt) < stale);
    if (!ours) continue;
    const res = await api("DELETE", `/api/purchase-lists/${list.id}`);
    expectStatus(res, [204, 404], `clean up list "${list.name}"`);
  }
}

/* ------------------------------------------------------------- the cart */

type CartState = { shopProductId: string; quantity: number }[];

async function cartState(): Promise<CartState> {
  return (await cartLines()).map((l) => ({ shopProductId: l.shopProductId, quantity: l.quantity }));
}

const cartKey = (state: CartState) =>
  state
    .map((l) => `${l.shopProductId}×${l.quantity}`)
    .sort()
    .join(", ");

/** Puts the customer's cart back to `before` (same products and quantities). */
async function restoreCart(before: CartState) {
  if (cartKey(await cartState()) === cartKey(before)) return;
  await emptyCart();
  const lost: string[] = [];
  for (const line of before) {
    const res = await addToCart("customer", line.shopProductId, line.quantity);
    if (res.status !== 200 && res.status !== 201) lost.push(`${line.shopProductId} ×${line.quantity}: ${why(res)}`);
  }
  if (lost.length) console.warn(`purchase-lists: could not restore the customer's cart line(s): ${lost.join("; ")}`);
}

/** Runs `body` on a cart set to exactly `lines`, and restores the customer's own cart afterwards. */
async function withCart<T>(lines: { row: Row; quantity: number }[], body: () => Promise<T>): Promise<T> {
  assertWritable("change the cart");
  const before = await cartState();
  try {
    await emptyCart();
    for (const { row, quantity } of lines) {
      const res = await addToCart("customer", row.shopProductId, quantity);
      if (res.status === 409 || res.status === 422) blocked(`"${row.productName}" ×${quantity} cannot go in the cart now — ${why(res)}`);
      expectStatus(res, [200, 201], `cart: add ${row.productName} ×${quantity}`);
    }
    return await body();
  } finally {
    await restoreCart(before);
  }
}

/* --------------------------------------------------------- the products */

let rowsCache: Row[] | null = null;

/**
 * Shop A's storefront (online listings), as a customer's browser reads it.
 * Customers are told whether a product is in stock, not the count (D-90,
 * TC-SPI-027). Where the count is not given it is read the way the app tells a
 * customer: a throwaway "QA PL" list asks for 99 of each tracked product and
 * its check answers "Only N left in stock." for one with fewer (99 here means
 * "99 or more"); the list is deleted straight away.
 */
async function shopRows(): Promise<Row[]> {
  if (rowsCache) return rowsCache;
  const shop = await shopOf("A");
  const res = await api("GET", `/api/shops/${shop.id}/products?limit=100`);
  expectStatus(res, 200, "shop A's storefront");
  const rows = ((Array.isArray(res.body) ? res.body : (res.body?.products ?? [])) as Row[]).map((r) => ({
    ...r,
    shopId: r.shopId ?? shop.id,
    shopName: r.shopName ?? shop.name,
    shopSlug: r.shopSlug ?? shop.slug,
  }));
  const unknown = rows.filter((r) => r.trackInventory && typeof r.onlineStock !== "number");
  for (const r of unknown) if (r.inStock === false) r.onlineStock = 0;
  const probe = unknown.filter((r) => r.inStock !== false && r.onlineSaleEnabled && r.isAvailable && (r.onlinePricePaise ?? 0) > 0);
  if (probe.length) {
    const list = await createList("stock probe");
    try {
      for (const r of probe) await addItem(list.id, r, 99);
      const check = await api("GET", `/api/purchase-lists/${list.id}/check`);
      expectStatus(check, 200, "check of the stock probe list");
      const lines = (check.body as Check).preview.groups.flatMap((g) => g.lines);
      for (const r of probe) {
        const line = lines.find((l) => l.shopProductId === r.shopProductId);
        const left = line?.unavailableReason?.match(/^Only (\d+) left in stock\.$/);
        r.onlineStock = line?.purchasable ? 99 : left ? Number(left[1]) : 0;
      }
    } finally {
      expectStatus(await api("DELETE", `/api/purchase-lists/${list.id}`), [204, 404], "delete the stock probe list");
    }
  }
  rowsCache = rows;
  return rowsCache;
}

const buyable = (r: Row, units = 1) =>
  r.onlineSaleEnabled && r.isAvailable && (r.onlinePricePaise ?? 0) > 0 && (!r.trackInventory || r.onlineStock >= units);

/** `n` different products of shop A that can be bought online with `minStock`+ in stock, cheapest first. */
async function products(n: number, minStock = 5): Promise<Row[]> {
  const seen = new Set<string>();
  const list = (await shopRows())
    .filter((r) => buyable(r, minStock))
    .sort((a, b) => (a.onlinePricePaise ?? 0) - (b.onlinePricePaise ?? 0))
    .filter((r) => !seen.has(r.productName) && seen.add(r.productName));
  if (list.length < n) blocked(`needs ${n} products of shop A on sale online with ${minStock}+ in stock (found ${list.length})`);
  return list.slice(0, n);
}

/** A product with stock tracked and fewer than 99 left: a list quantity of stock + 1 cannot be ordered ("Only N left"). */
async function lowStock(): Promise<{ row: Row; quantity: number }> {
  const rows = (await shopRows()).filter((r) => r.trackInventory && buyable(r, 1) && r.onlineStock <= 98);
  const preset = world().listings.lowStock?.shopProductId;
  const row = rows.find((r) => r.shopProductId === preset) ?? rows.sort((a, b) => a.onlineStock - b.onlineStock)[0];
  if (!row) blocked("needs a product of shop A on sale online with stock tracked and fewer than 99 left (to ask for more than there is)");
  return { row, quantity: row.onlineStock + 1 };
}

/** A product a cart line can hold 99 of (stock not tracked, or 99+ in stock): the line is at the cart's cap. */
async function roomy(): Promise<Row> {
  const row = (await shopRows()).filter((r) => buyable(r, 99)).sort((a, b) => (a.onlinePricePaise ?? 0) - (b.onlinePricePaise ?? 0))[0];
  if (!row) blocked("needs a product of shop A with stock not tracked or 99+ in stock (a cart line at the 99 cap)");
  return row;
}

/* ---------------------------------------------------------------- pages */

/** CSS attribute value, quoted. */
const attr = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

function itemRow(page: Page, productName: string): Locator {
  return page.getByTestId("list-item").and(page.locator(`[data-product-name=${attr(productName)}]`));
}

async function openList(page: Page, id: string) {
  await page.goto(`/lists/${id}`);
  await expect(page.getByTestId("list-editor")).toBeVisible();
}

/** The "Check list" button the customer would tap: the bar above the items on a phone, the side panel on a wide screen. */
function checkButton(page: Page): Locator {
  return isPhone() ? page.getByTestId("list-check-bar").getByRole("button", { name: "Check list" }) : page.getByTestId("check-list");
}

async function openCheck(page: Page, name: string): Promise<Locator> {
  await checkButton(page).click();
  const dialog = page.getByRole("dialog", { name: `Confirm order: ${name}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** "₹1,234.50" → 123450 */
function paiseOf(text: string): number {
  const value = text.replace(/[^\d.]/g, "");
  expect(value, `an amount in "${text}"`).not.toBe("");
  return Math.round(Number.parseFloat(value) * 100);
}

/** Waits for the list item change the click sends. */
async function saving(page: Page, listId: string, act: () => Promise<void>) {
  const answer = page.waitForResponse((r) => r.url().includes(`/api/purchase-lists/${listId}/items/`) && r.request().method() === "PATCH");
  await act();
  const res = await answer;
  expect(res.status(), `PATCH ${res.url()}`).toBe(200);
}

/** The product's card on its shop's page (by category tab, page by page). */
async function productCard(page: Page, row: Row): Promise<Locator> {
  for (let n = 1; n <= 12; n++) {
    await page.goto(`/shops/${row.shopSlug}?cat=${encodeURIComponent(row.categoryName)}&page=${n}`);
    const card = page.getByTestId("product-card").and(page.locator(`[data-product-name=${attr(row.productName)}]`));
    if (await card.count()) return card.first();
    if (!(await page.locator('[data-testid="pager"] a[rel="next"]').count())) break;
  }
  blocked(`the card of "${row.productName}" is not on /shops/${row.shopSlug} (category "${row.categoryName}")`);
}

/** Taps a choice pill (a radio drawn as its label, the input itself visually hidden) as a person would, and checks it took. */
async function choose(scope: Locator, name: string | RegExp) {
  const radio = scope.getByRole("radio", { name });
  // The inner locator of `has` is matched inside each label, so it starts from the page.
  await scope.locator("label").filter({ has: scope.page().getByRole("radio", { name }) }).click();
  await expect(radio).toBeChecked();
}

async function noSidewaysScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${where} is ${overflow}px wider than the screen`).toBeLessThanOrEqual(2);
}

async function orderIds(): Promise<string> {
  const res = await api("GET", "/api/orders");
  expectStatus(res, 200, "GET /api/orders");
  const list = (Array.isArray(res.body) ? res.body : (res.body?.orders ?? [])) as { id: string }[];
  return list.map((o) => o.id).sort().join(",");
}

/* ============================================================ the checks */

qa("TC-LIST-003", "create a weekly shopping list from My lists: it opens, empty, and shows under Shopping lists", async ({ browser }) => {
  const name = listName("Weekly dairy");
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/lists");
    await expect(page.getByRole("heading", { name: /Shopping lists/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Medicine lists/ })).toBeVisible();
    const form = page.getByTestId("create-list-form");
    await choose(form, /Shopping list/);
    await form.getByLabel("List name").fill(name);
    await choose(form, "Weekly");
    await expect(form.getByLabel("Remind me when it is due again")).toBeChecked();
    await form.getByRole("button", { name: "Create list" }).click();

    await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
    const id = page.url().split("/").pop()!;
    await expect(page.getByTestId("list-name")).toHaveText(new RegExp(`${name}$`));
    await expect(page.getByTestId("list-editor")).toContainText("Shopping list · Weekly");
    const empty = page.getByTestId("list-empty");
    await expect(empty).toContainText("This list is empty");
    await expect(empty.getByRole("link", { name: "Browse shops" })).toHaveAttribute("href", "/shops");

    const saved = await getList(id);
    expect({ name: saved.name, kind: saved.kind, frequency: saved.frequency, remind: saved.remind, items: saved.items.length }).toEqual({
      name,
      kind: "SHOPPING",
      frequency: "WEEKLY",
      remind: true,
      items: 0,
    });
    // Before its first order a list is due a week after it was made.
    expect(Date.parse(saved.nextDueAt) - Date.parse(saved.createdAt), "next due = created + 7 days").toBe(7 * 86_400_000);

    await page.goto("/lists");
    const card = page.getByTestId("lists-shopping").getByTestId("list-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Weekly");
    await expect(card).toContainText("No products yet");
    await expect(card).toContainText(/Next due \d{1,2} \w{3}/);
    await expect(page.getByTestId("lists-medicine").getByText(name)).toHaveCount(0);
    return `"${name}" created from the form → /lists/${id.slice(0, 8)}…, empty ("Browse shops"), SHOPPING/WEEKLY/remind on, next due +7 d, card under Shopping lists`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, { ...signed, mobile: true });

qa("TC-LIST-004", "create a monthly medicine list with the reminder off: it shows under Medicine lists and points to pharmacies", async ({ browser }) => {
  const name = listName("BP medicines");
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/lists?kind=MEDICINE");
    const form = page.getByTestId("create-list-form");
    // ?kind=MEDICINE opens the form on Medicines.
    await expect(form.getByRole("radio", { name: /Medicines/ })).toBeChecked();
    await form.getByLabel("List name").fill(name);
    await choose(form, "Monthly");
    await form.getByLabel("Remind me when it is due again").uncheck();
    await form.getByRole("button", { name: "Create list" }).click();

    await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
    const id = page.url().split("/").pop()!;
    await expect(page.getByTestId("list-editor")).toContainText("Medicines · Monthly");
    await expect(page.getByTestId("list-editor")).toContainText("Reminder off");
    await expect(page.getByTestId("list-empty").getByRole("link", { name: "Find a pharmacy" })).toHaveAttribute("href", "/shops?type=PHARMACY");

    const saved = await getList(id);
    expect({ kind: saved.kind, frequency: saved.frequency, remind: saved.remind }).toEqual({ kind: "MEDICINE", frequency: "MONTHLY", remind: false });
    const days = (Date.parse(saved.nextDueAt) - Date.parse(saved.createdAt)) / 86_400_000;
    expect(days, "next due a calendar month after it was made").toBeGreaterThanOrEqual(28);
    expect(days, "next due a calendar month after it was made").toBeLessThanOrEqual(31);

    await page.goto("/lists");
    await expect(page.getByTestId("lists-medicine").getByTestId("list-card").filter({ hasText: name })).toContainText("Monthly");
    await expect(page.getByTestId("lists-shopping").getByText(name)).toHaveCount(0);
    return `"${name}" MEDICINE/MONTHLY/reminder off; empty list links "Find a pharmacy" → /shops?type=PHARMACY; card under Medicine lists`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, signed);

qa("TC-LIST-005", "a second list with the same name (any case, extra spaces) is refused and no second list is made", async ({ browser }) => {
  const list = await createList("Monthly groceries");
  const { context, page } = await pageAs(browser, "customer");
  try {
    // The same name in other case, with spaces around and inside it.
    const variant = `  ${list.name.toUpperCase().replace(/ /g, "  ")} `;
    await page.goto("/lists");
    const form = page.getByTestId("create-list-form");
    await form.getByLabel("List name").fill(variant);
    await form.getByRole("button", { name: "Create list" }).click();
    await expect(form.getByRole("alert")).toContainText(/You already have a list called/);
    await expect(page).toHaveURL(/\/lists$/);

    const again = await api("POST", "/api/purchase-lists", { name: list.name.toLowerCase() });
    expectStatus(again, 409, "duplicate name (lower case) through the API");
    expect(why(again)).toMatch(/You already have a list called/);
    const same = (await myLists()).filter((l) => l.name.toLowerCase() === list.name.toLowerCase());
    expect(same.map((l) => l.id), "lists with that name").toEqual([list.id]);
    return `"${variant.trim()}" (form) and "${list.name.toLowerCase()}" (API, 409) refused: "${why(again)}"; one list keeps the name`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, signed);

qa("TC-LIST-006", "Add to list on a product card: the picker shows the customer's lists and adds the product (quantity 1)", async ({ browser }) => {
  const [row] = await products(1);
  const list = await createList("Card picks");
  const { context, page } = await pageAs(browser, "customer");
  try {
    const card = await productCard(page, row);
    await card.getByRole("button", { name: `Add ${row.productName} to one of my lists` }).click();
    const picker = page.getByRole("dialog", { name: `Add ${row.productName} to a list` });
    await expect(picker).toBeVisible();
    await expect(picker.getByText("Add to which list?")).toBeVisible();
    const choice = picker.getByRole("button", { name: list.name, exact: true });
    await expect(choice).toBeVisible();
    const added = page.waitForResponse((r) => r.url().endsWith(`/api/purchase-lists/${list.id}/items`) && r.request().method() === "POST");
    await choice.click();
    expect((await added).status(), "POST …/items for a new product").toBe(201);
    await expect(picker).toBeHidden();
    const status = card.getByRole("status");
    await expect(status).toContainText(`Added to "${list.name}"`);
    await expect(status.getByRole("link", { name: "Open" })).toHaveAttribute("href", `/lists/${list.id}`);

    const saved = await getList(list.id);
    expect(saved.items.map((i) => [i.shopProductId, i.quantity])).toEqual([[row.shopProductId, 1]]);
    await status.getByRole("link", { name: "Open" }).click();
    await expect(page).toHaveURL(new RegExp(`/lists/${list.id}$`));
    await expect(itemRow(page, row.productName)).toBeVisible();
    await expect(itemRow(page, row.productName).getByLabel(`Quantity of ${row.productName}`)).toHaveValue("1");
    return `${row.productName} (${row.shopName}) → picker → "${list.name}": 201, "Added to …", Open → the list shows it ×1`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, { ...signed, mobile: true, partial: "only an active listing of an approved shop can be added: the refusal for hidden products is TC-LIST-009" });

qa("TC-LIST-007", "Create & add in the picker makes a new list of the chosen type with the product on it", async ({ browser }) => {
  const [row] = await products(1);
  const name = listName("Made in picker");
  const { context, page } = await pageAs(browser, "customer");
  try {
    const card = await productCard(page, row);
    await card.getByRole("button", { name: `Add ${row.productName} to one of my lists` }).click();
    const picker = page.getByRole("dialog", { name: `Add ${row.productName} to a list` });
    await expect(picker.getByText("Or start a new list")).toBeVisible();
    await expect(picker.getByRole("button", { name: "Create & add" })).toBeDisabled();
    await picker.getByLabel("New list name").fill(name);
    await picker.getByLabel("New list type").selectOption("MEDICINE");
    await picker.getByRole("button", { name: "Create & add" }).click();
    await expect(card.getByRole("status")).toContainText(`Added to "${name}"`);
    const href = await card.getByRole("status").getByRole("link", { name: "Open" }).getAttribute("href");
    const id = href!.split("/").pop()!;
    const saved = await getList(id);
    expect({ name: saved.name, kind: saved.kind, items: saved.items.map((i) => [i.shopProductId, i.quantity]) }).toEqual({
      name,
      kind: "MEDICINE",
      items: [[row.shopProductId, 1]],
    });
    return `"${name}" created in the sheet as a medicines list with ${row.productName} ×1`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, signed);

qa("TC-LIST-008", "adding a product that is already on the list says 'Already on' and leaves its quantity and note as they were", async ({ browser }) => {
  const [row] = await products(1);
  const list = await createList("Already there");
  await addItem(list.id, row, 3, "QA keep this note");
  const { context, page } = await pageAs(browser, "customer");
  try {
    const card = await productCard(page, row);
    await card.getByRole("button", { name: `Add ${row.productName} to one of my lists` }).click();
    const picker = page.getByRole("dialog", { name: `Add ${row.productName} to a list` });
    const answer = page.waitForResponse((r) => r.url().endsWith(`/api/purchase-lists/${list.id}/items`) && r.request().method() === "POST");
    await picker.getByRole("button", { name: list.name, exact: true }).click();
    expect((await answer).status(), "POST …/items for a product already on the list").toBe(200);
    await expect(card.getByRole("status")).toContainText(`Already on "${list.name}"`);

    const res = await api("POST", `/api/purchase-lists/${list.id}/items`, { shopProductId: row.shopProductId, quantity: 7, note: "other" });
    expectStatus(res, 200, "add again through the API");
    expect(res.body.alreadyOnList).toBe(true);
    const saved = await getList(list.id);
    expect(saved.items.map((i) => ({ q: i.quantity, note: i.note }))).toEqual([{ q: 3, note: "QA keep this note" }]);
    return `picker → 200 "Already on …"; API add ×7 → 200 alreadyOnList; still one line ×3 with its note`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, signed);

qa("TC-LIST-009", "only products customers can see can be added: an unknown product is 'not found', a malformed id is refused", async () => {
  const list = await createList("Unknown products");
  try {
    const unknown = await api("POST", `/api/purchase-lists/${list.id}/items`, { shopProductId: NO_SUCH_ID, quantity: 1 });
    expectStatus(unknown, 404, "an id no listing has");
    const malformed = await api("POST", `/api/purchase-lists/${list.id}/items`, { shopProductId: "not-a-product", quantity: 1 });
    expectStatus(malformed, 422, "a malformed product id");
    expect((await getList(list.id)).items, "nothing was added").toEqual([]);
    return `unknown id → ${why(unknown)}; malformed → ${malformed.status} ${malformed.body?.error?.code}; list still empty`;
  } finally {
    await sweepLists();
  }
}, { ...signed, partial: "an inactive listing and a product of a shop that is not approved need seller data changed: covered by tests/integration/purchase-lists.test.ts" });

qa("TC-LIST-010", "quantity stepper and typed quantity are saved; 0 shows 'Skipped this time' and keeps the product on the list", async ({ browser }) => {
  const [p, q] = await products(2, 10);
  const list = await createList("Quantities");
  const itemP = await addItem(list.id, p, 1);
  const itemQ = await addItem(list.id, q, 1);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await openList(page, list.id);
    const rowP = itemRow(page, p.productName);
    const rowQ = itemRow(page, q.productName);
    await saving(page, list.id, () => rowP.getByRole("button", { name: `Increase ${p.productName}` }).click());
    await expect(rowP.getByLabel(`Quantity of ${p.productName}`)).toHaveValue("2");
    const box = rowP.getByLabel(`Quantity of ${p.productName}`);
    await box.fill("5");
    await saving(page, list.id, () => box.press("Enter"));
    await expect(box).toHaveValue("5");
    await saving(page, list.id, () => rowQ.getByRole("button", { name: `Decrease ${q.productName}` }).click());
    await expect(rowQ.getByLabel(`Quantity of ${q.productName}`)).toHaveValue("0");
    await expect(rowQ.getByText("Skipped this time")).toBeVisible();
    await expect(rowQ.getByRole("button", { name: `Decrease ${q.productName}` })).toBeDisabled();
    await expect(page.getByTestId("list-active-count")).toHaveText("1 of 2");

    const saved = await getList(list.id);
    const byId = new Map(saved.items.map((i) => [i.itemId, i]));
    expect([byId.get(itemP.itemId)?.quantity, byId.get(itemQ.itemId)?.quantity], "saved quantities P, Q").toEqual([5, 0]);
    expect(saved.items.length, "the skipped product stays on the list").toBe(2);
    // The estimate is today's price × quantity of what will be ordered (the skipped product adds nothing).
    expect(paiseOf(await page.getByTestId("list-estimate").innerText()), "estimated items total").toBe(saved.estimatedSubtotalPaise);
    expect(saved.estimatedSubtotalPaise).toBe(byId.get(itemP.itemId)!.lineTotalPaise);

    await page.reload();
    await expect(itemRow(page, p.productName).getByLabel(`Quantity of ${p.productName}`)).toHaveValue("5");
    await expect(itemRow(page, q.productName).getByText("Skipped this time")).toBeVisible();
    await page.goto("/lists");
    await expect(page.getByTestId("list-card").filter({ hasText: list.name })).toContainText("2 products · 1 skipped this time");
    return `${p.productName} 1→2 (+), typed 5; ${q.productName} 1→0 "Skipped this time", kept; "1 of 2" to order; estimate ₹${saved.estimatedSubtotalPaise / 100}; kept after reload; card "2 products · 1 skipped"`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, { ...signed, mobile: true });

qa("TC-LIST-011", "a note is saved and kept; quantities outside 0–99 and notes over 120 characters are refused", async ({ browser }) => {
  const [p] = await products(1);
  const list = await createList("Notes");
  const item = await addItem(list.id, p, 1);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await openList(page, list.id);
    const note = page.getByLabel(`Note for ${p.productName}`);
    await expect(note).toHaveAttribute("placeholder", /brand or size/);
    await note.fill("1 after breakfast — QA");
    await saving(page, list.id, () => note.blur());
    await page.reload();
    await expect(page.getByLabel(`Note for ${p.productName}`)).toHaveValue("1 after breakfast — QA");
    expect((await getList(list.id)).items[0].note).toBe("1 after breakfast — QA");

    const path = `/api/purchase-lists/${list.id}/items/${item.itemId}`;
    const refused: string[] = [];
    for (const [body, what] of [
      [{ quantity: 100 }, "quantity 100"],
      [{ quantity: -1 }, "quantity -1"],
      [{ quantity: 1.5 }, "quantity 1.5"],
      [{ note: "x".repeat(121) }, "a 121-character note"],
    ] as const) {
      const res = await api("PATCH", path, body);
      expectStatus(res, 422, what);
      refused.push(`${what} → 422`);
    }
    const ok = await api("PATCH", path, { quantity: 99, note: "y".repeat(120) });
    expectStatus(ok, 200, "quantity 99 and a 120-character note");
    const saved = (await getList(list.id)).items[0];
    expect([saved.quantity, saved.note?.length]).toEqual([99, 120]);
    return `note saved on leaving the field and kept after reload; ${refused.join(", ")}; 99 and 120 characters accepted`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, signed);

qa("TC-LIST-012", "Remove takes the product off the list for good; removing it again is 'not found'", async ({ browser }) => {
  const [p, q] = await products(2);
  const list = await createList("Remove one");
  await addItem(list.id, p, 1);
  const itemQ = await addItem(list.id, q, 2);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await openList(page, list.id);
    const gone = page.waitForResponse((r) => r.url().endsWith(`/items/${itemQ.itemId}`) && r.request().method() === "DELETE");
    await itemRow(page, q.productName).getByRole("button", { name: "Remove" }).click();
    expect((await gone).status(), "DELETE …/items/<id>").toBe(204);
    await expect(itemRow(page, q.productName)).toHaveCount(0);
    await expect(itemRow(page, p.productName)).toBeVisible();
    await page.reload();
    await expect(itemRow(page, q.productName)).toHaveCount(0);
    expect((await getList(list.id)).items.map((i) => i.shopProductId)).toEqual([p.shopProductId]);
    const again = await api("DELETE", `/api/purchase-lists/${list.id}/items/${itemQ.itemId}`);
    expectStatus(again, 404, "remove the same product again");
    return `${q.productName} removed (204), gone after reload, ${p.productName} kept; second remove → 404`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, signed);

qa("TC-LIST-013", "Check list shows the list priced like the cart: per-shop lines, subtotal, delivery and the total to pay; it writes nothing", async ({ browser }) => {
  const [p, q] = await products(2);
  const list = await createList("Check totals");
  await addItem(list.id, p, 2);
  await addItem(list.id, q, 0);
  return withCart([], async () => {
    const res = await api("GET", `/api/purchase-lists/${list.id}/check`);
    expectStatus(res, 200, "GET …/check");
    const check = res.body as Check;
    expect(check.preview.groups.length, "one shop").toBe(1);
    const group = check.preview.groups[0];
    expect(group.lines.map((l) => [l.shopProductId, l.quantity, l.purchasable])).toEqual([[p.shopProductId, 2, true]]);
    expect(check.skipped.map((s) => s.productName)).toEqual([q.productName]);
    // The cart's own arithmetic: line totals, the shop subtotal, its delivery fee, the total.
    expect(group.subtotalPaise).toBe(group.lines[0].lineTotalPaise);
    expect(group.totalPaise).toBe(group.subtotalPaise + group.deliveryFeePaise + group.taxPaise);
    expect(check.preview.grandTotalPaise).toBe(group.totalPaise);
    if (!group.lines[0].offerTitle) expect(group.lines[0].unitPricePaise, "today's online price").toBe(p.onlinePricePaise);

    const { context, page } = await pageAs(browser, "customer");
    try {
      await openList(page, list.id);
      const dialog = await openCheck(page, list.name);
      await expect(dialog.getByRole("heading", { name: "Confirm your order" })).toBeVisible();
      const shop = dialog.getByTestId("check-shop");
      await expect(shop).toHaveCount(1);
      await expect(shop).toContainText(group.shop.name);
      await expect(shop).toContainText(`${p.productName} × 2`);
      await expect(shop.getByText("Subtotal")).toBeVisible();
      await expect(shop.getByText("Delivery")).toBeVisible();
      if (group.deliveryFeePaise === 0) await expect(shop).toContainText("Free");
      await expect(dialog.getByText("Total to pay")).toBeVisible();
      expect(paiseOf(await dialog.getByTestId("check-total").innerText()), "total to pay").toBe(check.preview.grandTotalPaise);
      await expect(dialog).toContainText(`Skipped this time: ${q.productName}`);
      await expect(dialog.getByRole("radio", { name: "Add this list to them" }), "no add / replace choice with an empty cart").toHaveCount(0);
      await expect(dialog).toContainText("nothing is charged yet");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
    } finally {
      await context.close();
    }
    expect(await cartState(), "the check put nothing in the cart").toEqual([]);
    expect((await getList(list.id)).lastOrderedAt, "the check does not mark the list ordered").toBeNull();
    return `${p.productName} ×2 at ₹${group.lines[0].unitPricePaise / 100}: subtotal ₹${group.subtotalPaise / 100} + delivery ₹${group.deliveryFeePaise / 100} = total to pay ₹${check.preview.grandTotalPaise / 100} (dialog = API); ${q.productName} listed as skipped; cart and list unchanged`;
  }).finally(sweepLists);
}, { ...signed, mobile: true, partial: "equality with the cart's own total after confirming is proven in TC-LIST-016; live shop offers apply only when the offers rule is on" });

qa("TC-LIST-014", "Check list shows a line that cannot be ordered at the list's quantity with its reason, and leaves it out of the total", async ({ browser }) => {
  const [p] = await products(1);
  const { row: low, quantity } = await lowStock();
  const list = await createList("Left out");
  await addItem(list.id, p, 1);
  await addItem(list.id, low, quantity);
  return withCart([], async () => {
    const check = (await api("GET", `/api/purchase-lists/${list.id}/check`)).body as Check;
    const lines = check.preview.groups.flatMap((g) => g.lines);
    const out = lines.find((l) => l.shopProductId === low.shopProductId)!;
    expect(out.purchasable, `${low.productName} ×${quantity} with ${low.onlineStock} in stock`).toBe(false);
    expect(out.unavailableReason).toBe(`Only ${low.onlineStock} left in stock.`);
    const inLine = lines.find((l) => l.shopProductId === p.shopProductId)!;
    const groupOfP = check.preview.groups.find((g) => g.lines.includes(inLine))!;
    expect(groupOfP.subtotalPaise, "the left-out line adds nothing").toBe(inLine.lineTotalPaise);

    const { context, page } = await pageAs(browser, "customer");
    try {
      await openList(page, list.id);
      await expect(itemRow(page, low.productName).getByText(`Only ${low.onlineStock} left in stock.`)).toBeVisible();
      await expect(page.getByText("1 product can't be ordered right now and will be left out.")).toBeVisible();
      const dialog = await openCheck(page, list.name);
      const line = dialog.getByRole("listitem").filter({ hasText: `${low.productName} × ${quantity}` });
      await expect(line).toContainText(`Only ${low.onlineStock} left in stock.`);
      await expect(line).toContainText("—");
      await expect(dialog.getByText(/1 product can't be ordered right now and will be left out/)).toBeVisible();
      expect(paiseOf(await dialog.getByTestId("check-total").innerText())).toBe(check.preview.grandTotalPaise);
      await expect(dialog.getByTestId("confirm-list-order")).toBeEnabled();
    } finally {
      await context.close();
    }
    return `${low.productName} ×${quantity} (stock ${low.onlineStock}) shown "Only ${low.onlineStock} left in stock." priced "—", alert "1 product … left out"; total ₹${check.preview.grandTotalPaise / 100} = ${p.productName} only`;
  }).finally(sweepLists);
}, { ...signed, partial: "'No longer sold' (a product the shop removed) and 'shop not accepting orders' need seller data changed: integration tests" });

qa("TC-LIST-015", "with items already in the cart the check offers 'Add this list to them' or 'Replace my cart'; the total's label follows", async ({ browser }) => {
  const [p, q] = await products(2);
  const list = await createList("Cart choice");
  await addItem(list.id, p, 1);
  return withCart([{ row: q, quantity: 1 }], async () => {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await openList(page, list.id);
      const dialog = await openCheck(page, list.name);
      await expect(dialog.getByText("Your cart already has 1 item")).toBeVisible();
      const add = dialog.getByRole("radio", { name: "Add this list to them" });
      const replace = dialog.getByRole("radio", { name: "Replace my cart with this list" });
      await expect(add).toBeChecked();
      await expect(dialog.getByText("Total for this list")).toBeVisible();
      await expect(dialog.getByText(/Plus what is already in your cart/)).toBeVisible();
      await choose(dialog, "Replace my cart with this list");
      await expect(add).not.toBeChecked();
      await expect(replace).toBeChecked();
      await expect(dialog.getByText("Total to pay")).toBeVisible();
      await expect(dialog.getByText("Total for this list")).toHaveCount(0);
      await expect(dialog.getByText(/Plus what is already in your cart/)).toHaveCount(0);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await context.close();
    }
    expect(cartKey(await cartState()), "cart unchanged by the check").toBe(cartKey([{ shopProductId: q.shopProductId, quantity: 1 }]));
    return `cart with ${q.productName} ×1: "Your cart already has 1 item", ADD default with "Total for this list" + note; REPLACE → "Total to pay"; cart unchanged`;
  }).finally(sweepLists);
}, signed);

qa("TC-LIST-016", "Confirm order with an empty cart puts the list's quantities in the cart at the checked total, opens /cart, marks the list ordered — no order, no charge", async ({ browser }) => {
  const [p, q] = await products(2);
  const list = await createList("Weekly order", { frequency: "WEEKLY" });
  await addItem(list.id, p, 2);
  await addItem(list.id, q, 0);
  const ordersBefore = await orderIds();
  return withCart([], async () => {
    const { context, page } = await pageAs(browser, "customer");
    let checked = 0;
    try {
      await openList(page, list.id);
      const dialog = await openCheck(page, list.name);
      checked = paiseOf(await dialog.getByTestId("check-total").innerText());
      await dialog.getByTestId("confirm-list-order").click();
      await expect(page).toHaveURL(/\/cart$/);
      await expect(page.getByText(p.productName).first()).toBeVisible();
    } finally {
      await context.close();
    }
    expect(cartKey(await cartState()), "the cart holds the list's ordered lines only (the skipped one stays out)").toBe(
      cartKey([{ shopProductId: p.shopProductId, quantity: 2 }]),
    );
    const cart = await api("GET", "/api/cart");
    expect(cart.body.grandTotalPaise, "the cart's total = the checked total").toBe(checked);
    const saved = await getList(list.id);
    expect(saved.lastOrderedAt, "marked ordered").not.toBeNull();
    expect(Date.now() - Date.parse(saved.lastOrderedAt!), "ordered just now").toBeLessThan(15 * 60_000);
    expect(Date.parse(saved.nextDueAt) - Date.parse(saved.lastOrderedAt!), "next due a week after this order").toBe(7 * 86_400_000);
    expect(await orderIds(), "no order was placed").toBe(ordersBefore);

    const { context: c2, page: p2 } = await pageAs(browser, "customer");
    try {
      await openList(p2, list.id);
      await expect(p2.getByTestId("list-editor")).toContainText("Last ordered");
    } finally {
      await c2.close();
    }
    return `confirmed → /cart with ${p.productName} ×2 (${q.productName} skipped, not added); cart total ₹${checked / 100} = checked total; list last ordered now, next due +7 d; no new order`;
  }).finally(sweepLists);
}, { ...signed, mobile: true });

qa("TC-LIST-017", "Confirm order with 'Add this list to them' keeps the cart's items and adds the list's quantities on top", async ({ browser }) => {
  const [p, q] = await products(2, 10);
  const list = await createList("Add on top");
  await addItem(list.id, p, 2);
  return withCart([{ row: q, quantity: 1 }, { row: p, quantity: 1 }], async () => {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await openList(page, list.id);
      const dialog = await openCheck(page, list.name);
      await expect(dialog.getByRole("radio", { name: "Add this list to them" })).toBeChecked();
      const sent = page.waitForResponse((r) => r.url().endsWith(`/api/purchase-lists/${list.id}/order`));
      await dialog.getByTestId("confirm-list-order").click();
      const res = await sent;
      expect(res.status()).toBe(200);
      const result = (await res.json()) as { added: { shopProductId: string; quantity: number }[]; notAdded: unknown[]; cartItemCount: number };
      expect(result.added.map((a) => [a.shopProductId, a.quantity])).toEqual([[p.shopProductId, 2]]);
      expect(result.notAdded).toEqual([]);
      expect(result.cartItemCount).toBe(4);
      await expect(page).toHaveURL(/\/cart$/);
    } finally {
      await context.close();
    }
    expect(cartKey(await cartState())).toBe(
      cartKey([
        { shopProductId: q.shopProductId, quantity: 1 },
        { shopProductId: p.shopProductId, quantity: 3 },
      ]),
    );
    return `cart ${q.productName} ×1 + ${p.productName} ×1, list ${p.productName} ×2 → ADD: ${q.productName} ×1 kept, ${p.productName} ×3; 4 units`;
  }).finally(sweepLists);
}, { ...signed, partial: "the 99-per-line cap on ADD is TC-LIST-020" });

qa("TC-LIST-018", "Confirm order with 'Replace my cart with this list' leaves only the list's lines in the cart", async ({ browser }) => {
  const [p, q] = await products(2);
  const list = await createList("Replace cart");
  await addItem(list.id, p, 2);
  return withCart([{ row: q, quantity: 1 }], async () => {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await openList(page, list.id);
      const dialog = await openCheck(page, list.name);
      await choose(dialog, "Replace my cart with this list");
      await dialog.getByTestId("confirm-list-order").click();
      await expect(page).toHaveURL(/\/cart$/);
    } finally {
      await context.close();
    }
    expect(cartKey(await cartState())).toBe(cartKey([{ shopProductId: p.shopProductId, quantity: 2 }]));
    return `cart ${q.productName} ×1 → REPLACE with ${p.productName} ×2: the cart holds only ${p.productName} ×2`;
  }).finally(sweepLists);
}, signed);

qa("TC-LIST-019", "nothing to order (every quantity 0, or an empty list): Check list is disabled and sending is refused; the cart is untouched", async ({ browser }) => {
  const [p, q] = await products(2);
  const list = await createList("All skipped");
  await addItem(list.id, p, 0);
  const empty = await createList("Nothing on it");
  return withCart([{ row: q, quantity: 1 }], async () => {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await openList(page, list.id);
      await expect(checkButton(page)).toBeDisabled();
      await expect(page.getByText("Set a quantity above 0 for something to order.")).toBeVisible();
    } finally {
      await context.close();
    }
    const refused: string[] = [];
    for (const [id, mode] of [
      [list.id, "ADD"],
      [list.id, "REPLACE"],
      [empty.id, "REPLACE"],
    ] as const) {
      const res = await api("POST", `/api/purchase-lists/${id}/order`, { mode });
      expectStatus(res, 422, `send ${id === list.id ? "an all-skipped" : "an empty"} list (${mode})`);
      expect(why(res)).toMatch(/Nothing to order/);
      refused.push(`${id === list.id ? "all-skipped" : "empty"} ${mode} → 422`);
    }
    expect(cartKey(await cartState()), "cart untouched").toBe(cartKey([{ shopProductId: q.shopProductId, quantity: 1 }]));
    expect((await getList(list.id)).lastOrderedAt).toBeNull();
    return `Check list disabled with "Set a quantity above 0…"; ${refused.join(", ")} ("Nothing to order…"); cart still ${q.productName} ×1`;
  }).finally(sweepLists);
}, signed);

qa("TC-LIST-020", "no line can go in (cart line already at 99): 'Nothing could be added', the reason, and the cart is not changed", async ({ browser }) => {
  const r = await roomy();
  const list = await createList("Line at cap");
  await addItem(list.id, r, 1);
  return withCart([{ row: r, quantity: 99 }], async () => {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await openList(page, list.id);
      const dialog = await openCheck(page, list.name);
      await expect(dialog.getByText("Your cart already has 99 items")).toBeVisible();
      await dialog.getByTestId("confirm-list-order").click();
      const result = dialog.getByTestId("list-order-result");
      await expect(dialog.getByRole("heading", { name: "Nothing could be added" })).toBeVisible();
      await expect(result).toContainText("Your cart was not changed");
      await expect(result).toContainText(`${r.productName} — Your cart already has 99 — the most one line can hold.`);
      await expect(result.getByRole("link", { name: "Go to checkout" })).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/lists/${list.id}$`));
    } finally {
      await context.close();
    }
    expect(cartKey(await cartState())).toBe(cartKey([{ shopProductId: r.shopProductId, quantity: 99 }]));
    expect((await getList(list.id)).lastOrderedAt, "not marked ordered").toBeNull();
    return `cart ${r.productName} ×99, list ×1 → "Nothing could be added", "Your cart was not changed", left out "${r.productName} — Your cart already has 99…"; cart still ×99; list not marked ordered`;
  }).finally(sweepLists);
}, { ...signed, timeout: 360_000 });

qa("TC-LIST-020", "REPLACE when no line of the list can be ordered leaves the cart exactly as it was (Confirm order is disabled)", async ({ browser }) => {
  const [q] = await products(1);
  const { row: low, quantity } = await lowStock();
  const list = await createList("None orderable");
  await addItem(list.id, low, quantity);
  return withCart([{ row: q, quantity: 1 }], async () => {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await openList(page, list.id);
      const dialog = await openCheck(page, list.name);
      await expect(dialog.getByText(/1 product can't be ordered right now and will be left out/)).toBeVisible();
      await expect(dialog.getByTestId("confirm-list-order")).toBeDisabled();
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await context.close();
    }
    const res = await api("POST", `/api/purchase-lists/${list.id}/order`, { mode: "REPLACE" });
    expectStatus(res, 200, "send the list (REPLACE)");
    expect(res.body.added).toEqual([]);
    expect(res.body.notAdded.map((n: { shopProductId: string; reason: string }) => [n.shopProductId, n.reason])).toEqual([
      [low.shopProductId, `Only ${low.onlineStock} left in stock.`],
    ]);
    expect(res.body.cartItemCount).toBe(1);
    expect(cartKey(await cartState()), "REPLACE did not empty the cart for nothing").toBe(cartKey([{ shopProductId: q.shopProductId, quantity: 1 }]));
    expect((await getList(list.id)).lastOrderedAt).toBeNull();
    return `${low.productName} ×${quantity} (stock ${low.onlineStock}) only: Confirm disabled; API REPLACE → added [], left out "Only ${low.onlineStock} left in stock."; cart still ${q.productName} ×1`;
  }).finally(sweepLists);
}, signed);

qa("TC-LIST-021", "Save as a list on the cart makes a new list of the cart's products and quantities", async ({ browser }) => {
  const [p, q] = await products(2);
  const name = listName("From my cart");
  return withCart([{ row: p, quantity: 2 }, { row: q, quantity: 1 }], async () => {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await page.goto("/cart");
      const box = page.getByTestId("save-cart-as-list");
      await box.getByRole("button", { name: "Save as a list" }).click();
      const target = box.getByLabel("Save to");
      if (await target.count()) await expect(target).toHaveValue("new");
      await choose(box, /Shopping list/);
      await box.getByLabel("List name").fill(name);
      await choose(box, "Weekly");
      await box.getByRole("button", { name: "Save list" }).click();
      const status = box.getByRole("status");
      await expect(status).toContainText(`Saved to "${name}".`);
      const href = await status.getByRole("link", { name: "Open the list" }).getAttribute("href");
      const id = href!.split("/").pop()!;
      // The new list is offered next time without a reload, already chosen.
      await box.getByRole("button", { name: "Save as a list" }).click();
      await expect(box.getByLabel("Save to")).toHaveValue(id);

      const saved = await getList(id);
      expect({ kind: saved.kind, frequency: saved.frequency }).toEqual({ kind: "SHOPPING", frequency: "WEEKLY" });
      expect(cartKey(saved.items.map((i) => ({ shopProductId: i.shopProductId, quantity: i.quantity })))).toBe(
        cartKey([
          { shopProductId: p.shopProductId, quantity: 2 },
          { shopProductId: q.shopProductId, quantity: 1 },
        ]),
      );
      expect(cartKey(await cartState()), "saving keeps the cart as it is").toBe(
        cartKey([
          { shopProductId: p.shopProductId, quantity: 2 },
          { shopProductId: q.shopProductId, quantity: 1 },
        ]),
      );
      return `/cart → "${name}" (SHOPPING, WEEKLY) with ${p.productName} ×2, ${q.productName} ×1; "Saved to …", Open the list; offered in "Save to" without reload; cart unchanged`;
    } finally {
      await context.close();
    }
  }).finally(sweepLists);
}, { ...signed, mobile: true });

qa("TC-LIST-022", "Save as a list into an existing list: new products are added, products already on it take the cart's quantity", async ({ browser }) => {
  const rows = await products(2);
  const [p, q] = rows;
  const third = (await shopRows()).find((r) => buyable(r, 1) && !rows.some((x) => x.shopProductId === r.shopProductId)) ?? null;
  const list = await createList("Existing list");
  await addItem(list.id, p, 5);
  if (third) await addItem(list.id, third, 3);
  return withCart([{ row: p, quantity: 2 }, { row: q, quantity: 1 }], async () => {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await page.goto("/cart");
      const box = page.getByTestId("save-cart-as-list");
      await box.getByRole("button", { name: "Save as a list" }).click();
      await box.getByLabel("Save to").selectOption(list.id);
      await expect(box.getByText("Products already on that list take the quantity in your cart.")).toBeVisible();
      await expect(box.getByLabel("List name")).toHaveCount(0);
      await box.getByRole("button", { name: "Save list" }).click();
      await expect(box.getByRole("status")).toContainText(`Saved to "${list.name}".`);
    } finally {
      await context.close();
    }
    const saved = await getList(list.id);
    const expected = [
      { shopProductId: p.shopProductId, quantity: 2 },
      { shopProductId: q.shopProductId, quantity: 1 },
      ...(third ? [{ shopProductId: third.shopProductId, quantity: 3 }] : []),
    ];
    expect(cartKey(saved.items.map((i) => ({ shopProductId: i.shopProductId, quantity: i.quantity })))).toBe(cartKey(expected));
    await emptyCart();
    const none = await api("POST", "/api/purchase-lists/from-cart", { listId: list.id });
    expectStatus(none, 422, "save an empty cart");
    expect(why(none)).toMatch(/Your cart is empty/);
    return `"${list.name}" had ${p.productName} ×5${third ? ` and ${third.productName} ×3` : ""}; cart ${p.productName} ×2 + ${q.productName} ×1 saved into it → ${p.productName} ×2, ${q.productName} ×1${third ? `, ${third.productName} ×3 kept` : ""}; an empty cart → 422 "Your cart is empty"`;
  }).finally(sweepLists);
}, signed);

qa("TC-LIST-023", "Edit list changes the name, type, frequency and reminder; a name already in use is refused", async ({ browser }) => {
  const list = await createList("To be edited", { kind: "SHOPPING", frequency: "MONTHLY", remind: true });
  const other = await createList("Name taken");
  const renamed = listName("Edited meds");
  const { context, page } = await pageAs(browser, "customer");
  try {
    await openList(page, list.id);
    await page.getByRole("button", { name: "Edit list" }).click();
    const settings = page.getByTestId("list-settings");
    await settings.getByLabel("List name").fill(other.name.toUpperCase());
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByRole("alert")).toContainText("You already have a list called");

    await settings.getByLabel("List name").fill(renamed);
    await choose(settings, /Medicines/);
    await choose(settings, "Weekly");
    await settings.getByLabel("Remind me when it is due again").uncheck();
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings).toBeHidden();
    await expect(page.getByTestId("list-name")).toHaveText(new RegExp(`${renamed}$`));
    await expect(page.getByTestId("list-editor")).toContainText("Medicines · Weekly");
    await expect(page.getByTestId("list-editor")).toContainText("Reminder off");

    const saved = await getList(list.id);
    expect({ name: saved.name, kind: saved.kind, frequency: saved.frequency, remind: saved.remind }).toEqual({ name: renamed, kind: "MEDICINE", frequency: "WEEKLY", remind: false });
    expect(Date.parse(saved.nextDueAt) - Date.parse(saved.createdAt), "next due follows the new frequency").toBe(7 * 86_400_000);
    await page.goto("/lists");
    await expect(page.getByTestId("lists-medicine").getByTestId("list-card").filter({ hasText: renamed })).toBeVisible();
    await expect(page.getByTestId("lists-shopping").getByText(renamed)).toHaveCount(0);
    return `taken name refused ("You already have a list called…"); renamed to "${renamed}", MEDICINE, WEEKLY, reminder off; next due +7 d; card moved to Medicine lists`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, signed);

qa("TC-LIST-024", "Delete list asks once, then removes the list: back on My lists, its page and API answer 404", async ({ browser }) => {
  const [p] = await products(1);
  const list = await createList("To be deleted");
  await addItem(list.id, p, 2);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await openList(page, list.id);
    await page.getByRole("button", { name: "Edit list" }).click();
    await page.getByRole("button", { name: "Delete list" }).click();
    const confirm = page.getByRole("group", { name: "Delete this list?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Yes, delete list" }).click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByTestId("list-card").filter({ hasText: list.name })).toHaveCount(0);
    const res = await page.goto(`/lists/${list.id}`);
    expect(res?.status(), "the deleted list's page").toBe(404);
    expectStatus(await api("GET", `/api/purchase-lists/${list.id}`), 404, "GET the deleted list");
    expect((await myLists()).some((l) => l.id === list.id)).toBe(false);
    return `"${list.name}" (1 product): Delete list → "Delete this list?" → Yes → /lists without it; page 404, API 404`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, signed);

qa("TC-LIST-025", "another customer's list answers 404 everywhere (page and every API), and is left unchanged", async ({ browser }) => {
  const [p] = await products(1);
  const list = await createList("Private");
  const item = await addItem(list.id, p, 2);
  try {
    const base = `/api/purchase-lists/${list.id}`;
    const probes: [Method, string, unknown][] = [
      ["GET", base, undefined],
      ["PATCH", base, { name: "QA taken over" }],
      ["DELETE", base, undefined],
      ["POST", `${base}/items`, { shopProductId: p.shopProductId, quantity: 1 }],
      ["PATCH", `${base}/items/${item.itemId}`, { quantity: 9 }],
      ["DELETE", `${base}/items/${item.itemId}`, undefined],
      ["GET", `${base}/check`, undefined],
      ["POST", `${base}/order`, { mode: "REPLACE" }],
    ];
    const bad: string[] = [];
    for (const [method, path, body] of probes) {
      const res = await api(method, path, body, "customer2");
      if (res.status !== 404) bad.push(`${method} ${path.replace(base, "…")} → ${res.status}`);
    }
    expect(bad, `customer 2 reached customer 1's list:\n${bad.join("\n")}`).toEqual([]);
    expectStatus(await api("GET", "/api/purchase-lists/not-a-list-id", undefined, "customer2"), 404, "a malformed list id");
    expect((await api("GET", "/api/purchase-lists", undefined, "customer2")).body.lists.some((l: ListSummary) => l.id === list.id), "in customer 2's lists").toBe(false);

    const { context, page } = await pageAs(browser, "customer2");
    try {
      expect((await page.goto(`/lists/${list.id}`))?.status(), "customer 2 opens customer 1's list page").toBe(404);
      expect((await page.goto("/lists/not-a-list-id"))?.status(), "a malformed id in the URL").toBe(404);
    } finally {
      await context.close();
    }
    const after = await getList(list.id);
    expect([after.name, after.items.map((i) => i.quantity)]).toEqual([list.name, [2]]);
    return `${probes.length} API calls as customer 2 → 404; malformed id → 404; page 404; not in customer 2's lists; customer 1's list unchanged`;
  } finally {
    await sweepLists();
  }
}, { ...signed, partial: "'Save as a list' into another customer's list: refused as 'cart empty' first when customer 2's cart is empty (no existence leak); 404 path is in the integration tests" });

qa("TC-LIST-026", "My lists is reachable from the account menu, the Orders menu and the /orders tabs", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  const seen: string[] = [];
  try {
    // 1. The account menu of the site header.
    await page.goto("/orders");
    await page.getByTestId("account-button").click();
    await page.getByTestId("account-menu").getByRole("menuitem", { name: "My lists" }).click();
    await expect(page).toHaveURL(/\/lists$/);
    seen.push("account menu");

    // 2. The Orders menu: the Tile Board's Orders tile, or (product-discovery home) the Orders group of the account menu / phone drawer.
    await page.goto("/");
    if (await page.locator('[data-tile-board="customer"]').count()) {
      // Tile Board home (rule homeDiscovery off).
      const tile = page.getByTestId("board-tile").and(page.locator('[data-key="orders"]'));
      if (isPhone()) {
        // A touch tile is one link to /orders, whose tabs hold "My lists".
        await tile.getByTestId("board-tile-link").click();
        await expect(page).toHaveURL(/\/orders/);
        await page.getByTestId("list-tabs").getByRole("link", { name: "My lists" }).click();
        seen.push("Orders tile → /orders → My lists tab");
      } else {
        await tile.getByTestId("board-chip").and(page.locator('[data-key="lists"]')).click();
        seen.push("Orders tile → My lists chip");
      }
    } else if (isPhone()) {
      await page.getByTestId("drawer-open").click();
      const group = page.getByTestId("drawer-group").and(page.locator('[data-key="orders"]'));
      await group.locator("summary").click();
      await group.getByRole("link", { name: "My lists" }).click();
      seen.push("phone drawer → Orders → My lists");
    } else {
      await page.getByTestId("account-dropdown").click();
      await page.getByTestId("account-group").and(page.locator('[data-key="orders"]')).getByRole("link", { name: "My lists" }).click();
      seen.push("account dropdown → Orders → My lists");
    }
    await expect(page).toHaveURL(/\/lists$/);

    // 3. The tabs of /orders (where the phone's Orders tile and bottom bar land).
    await page.goto("/orders");
    const tab = page.getByTestId("list-tabs").getByRole("link", { name: "My lists" });
    await expect(tab).toHaveAttribute("href", "/lists");
    await tab.click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByRole("heading", { name: "My lists", level: 1 })).toBeVisible();
    seen.push("/orders tab");
  } finally {
    await context.close();
  }
  return seen.join("; ") + " → /lists";
}, { ...signed, mobile: true });

qa("TC-LIST-027", "phone layout: My lists, a list and its check fit the screen (no sideways scroll); the Add to list sheet is usable", async ({ browser }) => {
  const [p] = await products(1);
  const list = await createList("Phone layout list name that is quite long");
  await addItem(list.id, p, 1);
  const { context, page } = await pageAs(browser, "customer");
  const phone = isPhone();
  try {
    const width = page.viewportSize()!.width;
    await page.goto("/lists");
    await noSidewaysScroll(page, "/lists");
    await openList(page, list.id);
    await noSidewaysScroll(page, "/lists/<id>");
    const bar = page.getByTestId("list-check-bar");
    if (phone) {
      // The Check list bar sits above the items on a phone.
      await expect(bar).toBeVisible();
      const barBox = (await bar.boundingBox())!;
      const firstItem = (await page.getByTestId("list-item").first().boundingBox())!;
      expect(barBox.y, "Check list bar above the first item").toBeLessThan(firstItem.y);
    } else {
      await expect(bar).toBeHidden();
      await expect(page.getByTestId("check-list")).toBeVisible();
    }
    const dialog = await openCheck(page, list.name);
    await noSidewaysScroll(page, "the check dialog");
    const confirm = dialog.getByTestId("confirm-list-order");
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    const card = await productCard(page, p);
    await noSidewaysScroll(page, "the shop page");
    await card.getByRole("button", { name: `Add ${p.productName} to one of my lists` }).click();
    const sheet = page.getByRole("dialog", { name: `Add ${p.productName} to a list` });
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    if (phone) expect(Math.round(box.width), "the sheet spans the phone's width").toBeGreaterThanOrEqual(width - 2);
    expect(box.x, "sheet inside the screen (left)").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "sheet inside the screen (right)").toBeLessThanOrEqual(width + 1);
    await noSidewaysScroll(page, "the shop page with the sheet open");
    const choice = sheet.getByRole("button", { name: list.name, exact: true });
    await expect(choice).toBeInViewport();
    // The list's long name is shown in full, not cut.
    const fits = await choice.evaluate((el) => [...el.querySelectorAll("span")].every((s) => s.scrollWidth <= s.clientWidth + 1));
    expect(fits, "list name shown in full").toBe(true);
    const tap = (await choice.boundingBox())!;
    expect(tap.height, "tap target height").toBeGreaterThanOrEqual(44);
    await expect(sheet.getByLabel("New list name")).toBeInViewport();
    await choice.click();
    await expect(card.getByRole("status")).toContainText(`Already on "${list.name}"`);
    return `${phone ? "Pixel 7" : "desktop"} ${width}px: /lists, the list and its check fit; ${phone ? "Check list bar above the items; sheet full width" : "side Check list, no bar"}; sheet inside the screen, long name in full, ${Math.round(tap.height)}px tap targets`;
  } finally {
    await context.close();
    await sweepLists();
  }
}, { ...signed, mobile: true });

manual(
  "TC-LIST-028",
  "reminder: 'Time to reorder: <list>' once per due date for a list due again",
  "time-based: needs a list last ordered a week / a month ago and the 05:00 IST cron run (purchase-list-reminders) — local tier with the database; covered by tests/integration/purchase-lists.test.ts",
);
