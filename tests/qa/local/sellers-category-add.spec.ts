/**
 * Adding a product category to a shop fills its inventory (NEW-009 / rule
 * catalogue.categoryFillStock): every active, approved master product of the
 * category becomes a listing at stock 100 — priced at the MRP when there is
 * one, empty for loose goods and products without a price — once, without
 * touching what the shop already lists or any other shop.
 *
 * Local tier: the categories and their master products are arranged in the
 * database for this run (a known count of each kind); shop C (approved, no
 * products) and the world's other shops act through the site's own APIs and
 * pages. The checks run in order and hand the category on through the stash.
 */
import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { addToCart, deliver, emptyCart, onlyRiderOnline, packOrder, placeOrder } from "../lib/flows";
import { anonymous, call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";
import { auditRows, inventory, listingRow, newMasterProduct, ownerListings, RUN_KEY, storefront } from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 300_000 };
const KEY = `category-add-${RUN_KEY}`;

interface CategoryX {
  id: string;
  name: string;
  /** Active approved products, by kind. */
  withMrp: { id: string; code: string; name: string; mrp: number }[];
  noMrp: { id: string; code: string; name: string }[];
  loose: { id: string; code: string; name: string }[];
  excluded: { id: string; name: string; why: string }[];
}

async function shopC() {
  return need(world().shops.C?.id, "shop C (approved, no products)");
}

/** A new product category with a known set of master products. */
async function makeCategory(label: string): Promise<CategoryX> {
  const res = await call(await as("admin"), "POST", "/api/product-categories", { name: `QA Cat ${label} ${RUN}`, department: "DAIRY" });
  expectStatus(res, 201, "create a product category");
  const id = res.body.id as string;
  const withMrp = [];
  for (const mrp of [4000, 6500]) withMrp.push({ ...(await newMasterProduct({ categoryId: id, mrpPaise: mrp })), mrp });
  const noMrp = [await newMasterProduct({ categoryId: id, mrpPaise: null })];
  const loose = [await newMasterProduct({ categoryId: id, kind: "LOOSE" })];
  const inactive = await newMasterProduct({ categoryId: id, active: false });
  const pending = await newMasterProduct({ categoryId: id, approval: "PENDING_APPROVAL", createdBy: world().users.shopB?.id ?? null });
  const retired = await newMasterProduct({ categoryId: id });
  await db()`update products set deleted_at = now() where id = ${retired.id}`;
  return {
    id,
    name: res.body.name,
    withMrp,
    noMrp,
    loose,
    excluded: [
      { id: inactive.id, name: inactive.name, why: "inactive" },
      { id: pending.id, name: pending.name, why: "pending (another shop's)" },
      { id: retired.id, name: retired.name, why: "retired duplicate" },
    ],
  };
}

function current(): CategoryX {
  return unstash<CategoryX>(KEY) ?? blocked("needs category X added by TC-CAT-037 in this run");
}

const all = (x: CategoryX) => [...x.withMrp, ...x.noMrp, ...x.loose];

async function listingsOf(categoryProducts: { id: string }[]) {
  const shop = await shopC();
  const ids = new Set(categoryProducts.map((p) => p.id));
  return (await ownerListings(await as("shopC"), shop)).filter((l) => ids.has(l.productId));
}

qa(["TC-CAT-037", "TC-CAT-045"], "shop C's owner adds category X on /shop/product-categories: every active approved master product of X becomes a listing (count = master count); inactive, retired and pending products are not added", async ({ browser }) => {
  const x = await makeCategory("X");
  stash(KEY, x);
  const shop = await shopC();
  const bBefore = await ownerListings(await as("shopB"), need(world().shops.B?.id, "shop B"));
  stash(`${KEY}-b`, bBefore.map((l) => ({ id: l.id, price: l.onlinePricePaise, stock: l.onlineStock })));
  const { context, page } = await pageAs(browser, "shopC");
  let message = "";
  try {
    await page.goto(`/shop/product-categories?shop=${shop}`);
    await page.getByLabel("Add a category").selectOption({ label: x.name });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const alert = page.getByText(new RegExp(`Added ${x.name}`));
    await expect(alert).toBeVisible({ timeout: 60_000 });
    message = await alert.innerText();
  } finally {
    await context.close();
  }
  expect(message).toContain(`${all(x).length} products added to the inventory with stock 100`);
  const listed = await listingsOf(all(x));
  expect(listed.length, "one listing per active approved product").toBe(all(x).length);
  const excludedListed = await listingsOf(x.excluded);
  expect(excludedListed.map((l) => l.product.name), "excluded products are not listed").toEqual([]);
  const inv = await inventory(await as("shopC"), shop);
  expect(inv.rows.filter((r) => all(x).some((p) => p.id === r.productId)).length).toBe(all(x).length);
  return `"${message}"; ${listed.length}/${all(x).length} listings on /shop/inventory; not added: ${x.excluded.map((e) => e.why).join(", ")}`;
}, { ...local, partial: "TC-CAT-045 'merged duplicate': catalogue products have no merged state; a retired (deleted) duplicate stands in for it" });

qa("TC-CAT-038", "each added listing starts with on-hand 100, reserved 0, available 100, and one opening stock movement of +100", async () => {
  const x = current();
  const shop = await shopC();
  const rows = (await inventory(await as("shopC"), shop)).rows.filter((r) => all(x).some((p) => p.id === r.productId));
  for (const r of rows) expect([r.onHand, r.reserved, r.available], r.productName).toEqual([100, 0, 100]);
  const ledger = await db()<{ shop_product_id: string; channel: string; movement_type: string; qty_milli: string; source_type: string; note: string }[]>`
    select shop_product_id, channel, movement_type, qty_milli, source_type, note from inv_stock_ledger
    where shop_product_id in (select id from shop_products where shop_id = ${shop} and product_id = any(${all(x).map((p) => p.id)}))`;
  for (const r of rows) {
    const online = ledger.filter((l) => l.shop_product_id === r.shopProductId && l.channel === "ONLINE");
    expect(online.map((l) => [l.movement_type, Number(l.qty_milli)]), r.productName).toEqual([["OPENING", 100_000]]);
  }
  return `${rows.length} listings: 100/0/100; one ONLINE OPENING +100 each (source ${ledger[0]?.source_type}, "${ledger[0]?.note}")`;
}, { ...local, partial: "the opening row says 'Stock entered when the product was listed' (source CATALOGUE) — it does not name the category add; the add itself is audited (TC-CAT-051)" });

qa("TC-CAT-039", "a packaged product with a catalogue MRP starts priced at that MRP, never above it, and the owner can lower it", async () => {
  const x = current();
  const listed = await listingsOf(x.withMrp);
  for (const p of x.withMrp) {
    const l = listed.find((r) => r.productId === p.id)!;
    expect([l.onlinePricePaise, l.offlinePricePaise, l.onlineSaleEnabled], p.name).toEqual([p.mrp, p.mrp, true]);
  }
  const first = listed.find((r) => r.productId === x.withMrp[0].id)!;
  expectStatus(await call(await as("shopC"), "PATCH", `/api/shops/${await shopC()}/prices`, { prices: [{ shopProductId: first.id, pricePaise: x.withMrp[0].mrp - 300 }] }), 200, "owner edits");
  const above = await call(await as("shopC"), "PATCH", `/api/shops/${await shopC()}/prices`, { prices: [{ shopProductId: first.id, pricePaise: x.withMrp[0].mrp + 100 }] });
  expect(above.status, "never above the MRP").toBe(422);
  return `${x.withMrp.map((p) => `${p.name}: ₹${p.mrp / 100}`).join(", ")} pre-filled and on sale; owner lowered one by ₹3; above MRP → 422`;
}, local);

qa("TC-CAT-040", "a product with no catalogue price starts empty, is counted under 'Needs a price', is not buyable online, and becomes buyable once priced", async ({ browser }) => {
  const x = current();
  const shop = await shopC();
  const l = (await listingsOf(x.noMrp))[0];
  expect([l.onlinePricePaise, l.onlineSaleEnabled]).toEqual([null, false]);
  await emptyCart();
  const before = await addToCart("customer", l.id, 1);
  expect(before.status, `unpriced: ${why(before)}`).toBeGreaterThanOrEqual(400);
  const { context, page } = await pageAs(browser, "shopC");
  try {
    await page.goto(`/shop/inventory`);
    const needs = page.getByRole("button", { name: /Needs a price \((\d+)\)/ });
    await expect(needs).toBeVisible();
    const count = Number((await needs.innerText()).match(/\((\d+)\)/)?.[1]);
    expect(count).toBeGreaterThanOrEqual(x.noMrp.length + x.loose.length);
    await needs.click();
    await expect(page.getByLabel(`Price of ${l.product.name}`)).toHaveValue("");
    await page.getByLabel(`Price of ${l.product.name}`).fill("33");
    await page.getByRole("button", { name: "Save prices" }).click();
    await expect(page.getByText("Saved 1 price.")).toBeVisible();
  } finally {
    await context.close();
  }
  const after = await addToCart("customer", l.id, 1);
  expectStatus(after, [200, 201], "buyable once priced");
  await emptyCart();
  void shop;
  return `${l.product.name}: empty, off sale, add to cart ${before.status}; listed under "Needs a price"; ₹33 saved → buyable`;
}, local);

qa("TC-CAT-041", "a loose product in the category is added with an empty price whatever the catalogue holds; its stock 100 is in the product's unit (kg)", async () => {
  const x = current();
  const l = (await listingsOf(x.loose))[0];
  expect([l.onlinePricePaise, l.offlinePricePaise, l.onlineSaleEnabled]).toEqual([null, null, false]);
  const row = (await inventory(await as("shopC"), await shopC())).rows.find((r) => r.shopProductId === l.id)!;
  return `${l.product.name}: empty price, off sale; stock ${row.available} ${row.unit} (the listing's unit)`;
}, local);

qa("TC-CAT-042", "a product the shop already lists (stock 7, its own price) is left untouched when its category is added: no second listing", async () => {
  const shop = await shopC();
  const y = await call(await as("admin"), "POST", "/api/product-categories", { name: `QA Cat Y ${RUN}`, department: "DAIRY" });
  expectStatus(y, 201, "category Y");
  const p = await newMasterProduct({ categoryId: y.body.id, mrpPaise: 8000 });
  const other = await newMasterProduct({ categoryId: y.body.id, mrpPaise: 3000 });
  // The shop already sells p: it carries Y only for that one product (as an owner's "Create New Product" leaves it).
  await db()`insert into shop_product_categories (shop_id, category_id) values (${shop}, ${y.body.id}) on conflict do nothing`;
  const own = await call(await as("shopC"), "POST", `/api/shops/${shop}/products`, { productId: p.id, onlineSaleEnabled: true, onlinePricePaise: 7100, trackInventory: true, onlineStock: 7 });
  expectStatus(own, 201, "the shop's own listing");
  await db()`delete from shop_product_categories where shop_id = ${shop} and category_id = ${y.body.id}`;
  const add = await call(await as("shopC"), "POST", `/api/shops/${shop}/product-categories`, { categoryId: y.body.id });
  expectStatus(add, 201, "add Y");
  const mine = (await ownerListings(await as("shopC"), shop)).filter((l) => l.productId === p.id);
  expect(mine.length, "one listing").toBe(1);
  expect([mine[0].onlineStock, mine[0].onlinePricePaise]).toEqual([7, 7100]);
  expect(add.body.addedProducts, "only the other product was added").toBe(1);
  void other;
  return `existing listing kept stock 7 and ₹71; the add listed only the other product (addedProducts ${add.body.addedProducts})`;
}, local);

qa("TC-CAT-043", "adding the same category twice (a double click, two API calls together, and again later) creates no duplicates and neither raises nor resets stock", async ({ browser }) => {
  const shop = await shopC();
  const z = await makeCategory("Z");
  const [r1, r2] = await Promise.all([
    call(await as("shopC"), "POST", `/api/shops/${shop}/product-categories`, { categoryId: z.id }),
    call(await as("shopC"), "POST", `/api/shops/${shop}/product-categories`, { categoryId: z.id }),
  ]);
  expect([r1.status, r2.status].sort(), `${why(r1)} / ${why(r2)}`).toEqual([200, 201]);
  const listed = await listingsOf(all(z));
  expect(listed.length).toBe(all(z).length);
  // Stock is spent a little, then the category is added again.
  const first = listed[0];
  expectStatus(await call(await as("shopC"), "PATCH", `/api/shop-products/${first.id}`, { onlineStock: 93 }), 200, "stock 93");
  const again = await call(await as("shopC"), "POST", `/api/shops/${shop}/product-categories`, { categoryId: z.id });
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ added: false, addedProducts: 0 });
  expect((await listingRow(first.id)).online_stock, "not raised to 200 or reset to 100").toBe(93);
  const openings = await db()<{ n: number }[]>`select count(*)::int as n from inv_stock_ledger where shop_product_id = ${first.id} and movement_type = 'OPENING' and channel = 'ONLINE'`;
  expect(openings[0].n, "one opening movement").toBe(1);
  // A double click on the page.
  const w = await makeCategory("W");
  const { context, page } = await pageAs(browser, "shopC");
  try {
    await page.goto(`/shop/product-categories?shop=${shop}`);
    await page.getByLabel("Add a category").selectOption({ label: w.name });
    await page.getByRole("button", { name: "Add", exact: true }).dblclick();
    await expect(page.getByText(new RegExp(`Added ${w.name}`))).toBeVisible({ timeout: 60_000 });
  } finally {
    await context.close();
  }
  const wListed = await listingsOf(all(w));
  expect(wListed.length, "double click: one listing per product").toBe(all(w).length);
  return `two concurrent adds → ${r1.status}/${r2.status}, ${listed.length} listings; re-add → added:false, stock stays 93, one OPENING row; double-click → ${wListed.length} listings`;
}, local);

qa("TC-CAT-044", "two categories sharing a product give one listing (stock 100)", async () => {
  const x = current();
  const [row] = await db()<{ n: number }[]>`select count(*)::int as n from shop_products where shop_id = ${await shopC()} and product_id = ${x.withMrp[0].id}`;
  expect(row.n).toBe(1);
  return "a product has exactly one category in this build, so two categories cannot share it; the product added with X is listed once";
}, { ...local, partial: "a product belongs to one category only (products.category_id), so the X-and-Z overlap cannot be arranged" });

qa("TC-CAT-046", "a category with no products is added with a clear message and no listings", async ({ browser }) => {
  const shop = await shopC();
  const empty = await call(await as("admin"), "POST", "/api/product-categories", { name: `QA Cat Empty ${RUN}`, department: "DAIRY" });
  expectStatus(empty, 201, "empty category");
  const before = (await ownerListings(await as("shopC"), shop)).length;
  const { context, page } = await pageAs(browser, "shopC");
  try {
    await page.goto(`/shop/product-categories?shop=${shop}`);
    await page.getByLabel("Add a category").selectOption({ label: empty.body.name });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(`Added ${empty.body.name}. Its products are now visible to this shop.`)).toBeVisible();
  } finally {
    await context.close();
  }
  expect((await ownerListings(await as("shopC"), shop)).length).toBe(before);
  return `"Added ${empty.body.name}. Its products are now visible to this shop." — no listings, no error`;
}, local);

qa("TC-CAT-048", "other shops are not affected: shop B's listings, stock and prices are unchanged after shop C's adds", async () => {
  const before = unstash<{ id: string; price: number | null; stock: number }[]>(`${KEY}-b`) ?? blocked("needs shop B's snapshot from TC-CAT-037");
  const after = (await ownerListings(await as("shopB"), need(world().shops.B?.id, "shop B"))).map((l) => ({ id: l.id, price: l.onlinePricePaise, stock: l.onlineStock }));
  expect(after).toEqual(before);
  return `shop B: ${after.length} listings, prices and stock identical`;
}, local);

qa("TC-CAT-049", "an owner cannot add a category to another shop; a customer and a guest are refused too; nothing is created for that shop", async () => {
  const x = current();
  const shopB = need(world().shops.B?.id, "shop B");
  const before = (await ownerListings(await as("shopB"), shopB)).length;
  const fresh = await call(await as("admin"), "POST", "/api/product-categories", { name: `QA Cat Guard ${RUN}`, department: "DAIRY" });
  await newMasterProduct({ categoryId: fresh.body.id });
  const answers: string[] = [];
  for (const [who, ctx] of [["owner A", await as("shop")], ["customer", await as("customer")]] as const) {
    const res = await call(ctx, "POST", `/api/shops/${shopB}/product-categories`, { categoryId: fresh.body.id });
    expect(res.status, `${who}: ${why(res)}`).toBe(403);
    answers.push(`${who} ${res.status}`);
  }
  const guest = await anonymous();
  const g = await call(guest, "POST", `/api/shops/${shopB}/product-categories`, { categoryId: fresh.body.id });
  await guest.dispose();
  expect(g.status).toBe(401);
  expect((await ownerListings(await as("shopB"), shopB)).length).toBe(before);
  void x;
  return `${answers.join(", ")}, guest ${g.status}; shop B still has ${before} listings`;
}, local);

qa("TC-CAT-050", "the added products on the shop C page: priced ones in stock and buyable; unpriced ones not buyable and never ₹0", async ({ page }) => {
  const x = current();
  const slug = need(world().shops.C?.slug, "shop C's page");
  await page.goto(`/shops/${slug}?cat=${encodeURIComponent(x.name)}`);
  const main = page.locator("main");
  for (const p of x.withMrp) await expect(main.locator(`[data-product-name="${p.name}"]`).first()).toBeVisible();
  const priced = main.locator(`[data-product-name="${x.withMrp[1].name}"]`).first();
  await expect(priced.getByRole("button", { name: /^Add\b/ })).toBeVisible();
  for (const p of x.loose) {
    const card = main.locator(`[data-product-name="${p.name}"]`);
    if (await card.count()) await expect(card.first().getByRole("button", { name: /^Add\b/ })).toHaveCount(0);
  }
  for (const t of await main.locator("[data-product-name]").allInnerTexts()) expect(t.replace(/\s+/g, " "), "a product card shows ₹0").not.toMatch(/₹\s?0(\.00)?\b/);
  const rows = (await storefront(await anonymous(), await shopC())).rows;
  expect(rows.some((r) => x.loose.some((l) => l.id === r.productId)), "unpriced loose not on sale").toBe(false);
  return `shop C page: ${x.withMrp.length} priced products with Add; unpriced not buyable; no ₹0`;
}, local);

qa("TC-CAT-051", "no false low-stock alerts for listings at 100; the add is audited once with the product count", async () => {
  const x = current();
  const shop = await shopC();
  const listed = await listingsOf(all(x));
  const [alerts] = await db()<{ n: number }[]>`select count(*)::int as n from stock_alerts where shop_product_id = any(${listed.map((l) => l.id)})`;
  expect(alerts.n).toBe(0);
  const audits = (await auditRows(shop, "%product_category%")).filter((r) => JSON.stringify(r.new_value).includes(x.id));
  expect(audits.length, "one audit row for the add").toBe(1);
  expect((audits[0].new_value as { productsListed?: number }).productsListed).toBe(all(x).length);
  return `0 stock alerts; one "${audits[0].action}" audit row with productsListed ${all(x).length}`;
}, local);

qa("TC-CAT-052", "the owner corrects the default 100 to the real stock (12 and 0): saved with movements; the 0 listing is out of stock on the storefront", async () => {
  const x = current();
  const listed = await listingsOf(x.withMrp);
  const [a, b] = listed;
  expectStatus(await call(await as("shopC"), "PATCH", `/api/shop-products/${a.id}`, { onlineStock: 12 }), 200, "12");
  expectStatus(await call(await as("shopC"), "PATCH", `/api/shop-products/${b.id}`, { onlineStock: 0 }), 200, "0");
  const moves = await db()<{ shop_product_id: string; delta_units: number }[]>`select shop_product_id, delta_units from inventory_movements where shop_product_id in (${a.id}, ${b.id}) and reason = 'Manual stock update'`;
  expect(moves.find((m) => m.shop_product_id === a.id)?.delta_units).toBe(-88);
  expect(moves.find((m) => m.shop_product_id === b.id)?.delta_units).toBe(-100);
  const row = (await storefront(await as("customer"), await shopC())).rows.find((r) => r.shopProductId === b.id);
  expect(row?.onlineStock ?? 0).toBe(0);
  await emptyCart();
  const add = await addToCart("customer", b.id, 1);
  expect(add.status, "out of stock").toBeGreaterThanOrEqual(400);
  expectStatus(await call(await as("shopC"), "PATCH", `/api/shop-products/${b.id}`, { onlineStock: 100 }), 200, "back to 100 for the next checks");
  return `100 → 12 (movement -88) and 100 → 0 (-100); the 0 listing is out of stock (add to cart ${add.status})`;
}, local);

qa("TC-CAT-053", "an operator adds a category to shop C on /admin/shops/{id}/product-categories: the products are auto-added at stock 100 as for the owner", async () => {
  const shop = await shopC();
  const v = await makeCategory("V");
  const res = await call(await as("ops"), "POST", `/api/shops/${shop}/product-categories`, { categoryId: v.id });
  expectStatus(res, 201, "operator adds");
  const listed = await listingsOf(all(v));
  expect(listed.length).toBe(all(v).length);
  expect(listed.every((l) => l.onlineStock === 100)).toBe(true);
  const audit = (await auditRows(shop, "%product_category%")).find((r) => JSON.stringify(r.new_value).includes(v.id));
  expect((audit?.new_value as { byOwner?: boolean }).byOwner).toBe(false);
  return `recorded: an operator's add fills the inventory too (${listed.length} listings at 100), audited with byOwner false`;
}, local);

qa("TC-CAT-055", "a product added to category X later is not listed in shop C automatically; it becomes visible for the owner to add", async () => {
  const x = current();
  const shop = await shopC();
  const later = await newMasterProduct({ categoryId: x.id, mrpPaise: 2500 });
  const listed = (await ownerListings(await as("shopC"), shop)).some((l) => l.productId === later.id);
  const visible = await call(await as("shopC"), "GET", `/api/shops/${shop}/catalogue-search?q=${encodeURIComponent(later.name)}`);
  expect(listed, "not auto-listed").toBe(false);
  expect(JSON.stringify(visible.body)).toContain(later.id);
  return "recorded: a later master product is not auto-listed (the fill runs when the category is added); it shows in the shop's 'add existing product' search";
}, local);

qa("TC-CAT-056", "removing category X from shop C with stock and an open order: listings are paused, not deleted; the open order still completes", async () => {
  const x = current();
  const shop = await shopC();
  const target = (await listingsOf(x.withMrp))[1];
  await onlyRiderOnline("rider");
  const order = await placeOrder({ method: "WALLET", listing: { shopProductId: target.id, productId: target.productId, name: target.product.name, pricePaise: target.onlinePricePaise, shopId: shop, shopName: world().shops.C!.name } });
  const impact = await call(await as("shopC"), "GET", `/api/shops/${shop}/product-categories/${x.id}`);
  const removed = await call(await as("shopC"), "DELETE", `/api/shops/${shop}/product-categories/${x.id}`);
  expectStatus(removed, 200, "remove X");
  const rows = await listingsOf(all(x));
  expect(rows.length, "listings kept").toBe(all(x).length);
  expect(rows.every((r) => r.deletedAt === null)).toBe(true);
  expect((await storefront(await as("customer"), shop)).rows.some((r) => r.shopProductId === target.id), "paused: off the storefront").toBe(false);
  await packOrder(order.id, "shopC");
  await deliver(order.id, { shop: "shopC" });
  const [o] = await db()<{ status: string }[]>`select status from orders where id = ${order.id}`;
  expect(o.status).toBe("DELIVERED");
  expectStatus(await call(await as("shopC"), "POST", `/api/shops/${shop}/product-categories`, { categoryId: x.id }), [200, 201], "add X back");
  return `remove: ${removed.body.pausedListings} listings paused (impact said ${impact.body?.pausedListings}), none deleted, hidden from customers; ${order.orderNumber} still went through to DELIVERED; X added back`;
}, local);

qa("TC-CAT-047", "a category of several hundred products is added completely, in one go, without a timeout or a 500", async () => {
  const shop = await shopC();
  const big = await call(await as("admin"), "POST", "/api/product-categories", { name: `QA Cat Large ${RUN}`, department: "DAIRY" });
  expectStatus(big, 201, "large category");
  await db()`
    insert into products (category_id, name, slug, unit, unit_size_milli, kind, mrp_paise, mrp_source, mrp_verification_status, approval_status, is_active)
    select ${big.body.id}, 'QA Bulk ' || ${RUN} || ' ' || g, 'qa-bulk-' || ${RUN} || '-' || g, 'piece', 1000, 'PACKAGED', 1000 + g, 'ADMIN', 'VERIFIED', 'APPROVED', true
    from generate_series(1, 650) g`;
  const started = Date.now();
  const res = await call(await as("shopC"), "POST", `/api/shops/${shop}/product-categories`, { categoryId: big.body.id });
  const ms = Date.now() - started;
  expectStatus(res, 201, "add the large category");
  expect(res.body.addedProducts).toBe(650);
  const [n] = await db()<{ n: number }[]>`select count(*)::int as n from shop_products sp join products p on p.id = sp.product_id where sp.shop_id = ${shop} and p.category_id = ${big.body.id}`;
  expect(n.n).toBe(650);
  return `650 products added in ${(ms / 1000).toFixed(1)} s in one transaction (two insert batches of ≤500); completion message "${res.body.categoryName}: ${res.body.addedProducts} added"`;
}, { ...local, partial: "'no partial result' rests on the single transaction of the route; a mid-way failure was not forced" });

qa("TC-CAT-050", "added products still appear on the shop page once the shop has more than 100 products (after the large category)", async ({ page }) => {
  const x = current();
  const slug = need(world().shops.C?.slug, "shop C's page");
  const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from shop_products where shop_id = ${await shopC()} and deleted_at is null and online_sale_enabled`;
  await page.goto(`/shops/${slug}?cat=${encodeURIComponent(x.name)}`);
  const tabs = await page.locator("main").getByRole("link").allInnerTexts();
  const found = await page.locator(`[data-product-name="${x.withMrp[0].name}"]`).count();
  expect(found, `shop C has ${n} products on sale; the shop page loads only the first 100 storefront rows (src/app/shops/[slug]/page.tsx: listStorefrontProducts limit 100), so category "${x.name}" is ${tabs.some((t) => t.includes(x.name)) ? "listed" : "missing"} and its products are not shown`).toBeGreaterThan(0);
  return `with ${n} products on sale, "${x.name}" and its products are still on the shop page`;
}, local);
