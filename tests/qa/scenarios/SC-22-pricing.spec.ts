/**
 * Price and MRP journeys.
 *   SC-22 — price governance: an admin sets the MRP; prices above it are
 *           refused on the price form's API and by Excel; an operator's price
 *           change waits for the owner's approval; the customer sees the new
 *           price and discount; one MRP across shops when compared.
 *   SC-24 — loose goods from no price to a sale: a loose product added by two
 *           shops starts unpriced (never ₹0, not buyable); shop B prices it at
 *           ₹60/kg; 750 g from shop B is exactly ₹45; once B clears the price
 *           it is no longer buyable.
 *   SC-25 — shop-specific MRP: superseded (one master MRP); the master MRP
 *           change applies to both shops, each order records its own shop's
 *           price, and an owner cannot change another shop's listing.
 *
 * Local tier: products are arranged in the catalogue as catalogue staff
 * would (the operator's create-product API has no LOOSE kind — loose master
 * products come from the product master); listings are added by the owners
 * through the site.
 */
import ExcelJS from "exceljs";

import {
  api,
  asPage,
  buy,
  freshListing,
  shopId,
  type Listing,
} from "../lib/finance-helpers";
import { as } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, RUN, why } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 420_000 };
const SUPERSEDED = "the shop-level MRP (NEW-010) is superseded — one master MRP for every shop (docs/three-modules-2026-10/PLAN.md §1.2 'MRP is master-only'; docs/product-import-2026-10/README.md decision 1)";

async function livePrice(shopProductId: string) {
  const [row] = await db()<{ price: number | null }[]>`select online_price_paise::int as price from shop_products where id = ${shopProductId}`;
  return row.price;
}

async function sheet(rows: (string | number | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Prices");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A second shop's listing of the same master product (added by shop B's owner). */
async function listAtB(productId: string, pricePaise: number | null, stock = 20): Promise<Listing> {
  const res = await api("shopB", "POST", `/api/shops/${shopId("B")}/products`, {
    productId,
    onlineSaleEnabled: pricePaise != null,
    onlinePricePaise: pricePaise,
    trackInventory: true,
    onlineStock: stock,
  });
  expectStatus(res, 201, "shop B lists the product");
  const b = need(world().shops.B, "shop B");
  return { shopProductId: res.body.id, productId, name: "", pricePaise, stock, shopId: b.id!, shopName: b.name } as Listing;
}

/* ------------------------------------------------------------------ SC-22 */

qa("SC-22", "price governance: the MRP guard holds on the form's API and Excel; an operator's change waits for the owner's approval; the customer sees the new price and discount; one MRP across shops", async ({ browser }) => {
  const a = await freshListing({ name: "QA Governed Oil", pricePaise: 4500, stock: 20, mrpPaise: null });
  const b = await listAtB(a.productId, 4700);
  const [{ code }] = await db()<{ code: string }[]>`select code from products where id = ${a.productId}`;
  const bad: string[] = [];
  // 1. The admin sets the MRP.
  expectStatus(await api("admin", "POST", "/api/mrp", { productId: a.productId, mrpPaise: 5000, source: "ADMIN", reason: "QA: printed on the pack" }), 200, "MRP ₹50");
  // 2. Above the MRP: the price form's request and the Excel price list.
  const form = await api("shop", "PATCH", `/api/shops/${shopId("A")}/prices`, { prices: [{ shopProductId: a.shopProductId, pricePaise: 5500 }] });
  if (form.status !== 422) bad.push(`price ₹55 above the MRP via the price form → ${form.status}`);
  const upload = await call(await as("shop"), "POST", "/api/excel-uploads", undefined, {
    multipart: { shopId: shopId("A"), file: { name: "prices.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await sheet([["Product ID", "Price"], [code, 55]]) } },
  });
  expectStatus(upload, 201, "upload the price list");
  const apply = await api("shop", "POST", `/api/excel-uploads/${upload.body.uploadId}/apply`);
  if ((await livePrice(a.shopProductId)) !== 4500) bad.push(`Excel ₹55 applied (apply ${apply.status}); live ${await livePrice(a.shopProductId)}`);
  // 3. The operator proposes ₹42; the owner approves.
  const proposed = await api("ops", "PATCH", `/api/shop-products/${a.shopProductId}`, { onlinePricePaise: 4200 });
  if (proposed.status !== 202) bad.push(`operator's change → ${proposed.status} (expected 202 pending)`);
  if ((await livePrice(a.shopProductId)) !== 4500) bad.push("the operator's change went live before approval");
  const requestIds = (proposed.body?.requestIds ?? []) as string[];
  expectStatus(await api("shop", "POST", "/api/price-requests/decide", { requestIds, decision: "APPROVED" }), 200, "the owner approves");
  if ((await livePrice(a.shopProductId)) !== 4200) bad.push(`after approval the price is ${await livePrice(a.shopProductId)}`);
  // 4. The customer sees the new price and the discount; 6. one MRP when comparing shops.
  const card = await asPage(browser, "customer", `/search?q=${encodeURIComponent(a.name)}`, async (page) => {
    const el = page.locator(`[data-product-name="${a.name}"]`).first();
    await expect(el).toBeVisible();
    return (await el.innerText()).replace(/\s+/g, " ");
  });
  if (!card.includes("42") || !/16\s*%\s*off/i.test(card)) bad.push(`product card "${card.slice(0, 120)}" (expected ₹42 and 16% off ₹50)`);
  const compare = await asPage(browser, "customer", `/products/${a.productId}`, async (page) => {
    const mrp = (await page.getByTestId("product-mrp").innerText()).replace(/\s+/g, " ");
    const prices = (await page.getByTestId("price-comparison").innerText()).replace(/\s+/g, " ");
    return { mrp, prices };
  });
  if (!compare.mrp.includes("50") || !compare.prices.includes("42") || !compare.prices.includes("47")) bad.push(`compare: MRP "${compare.mrp}", prices "${compare.prices.slice(0, 160)}"`);
  // 5. The owner's own-shop MRP: there is no such figure (superseded) — the master stays.
  const ownMrp = await api("shop", "PATCH", `/api/shop-products/${a.shopProductId}`, { mrpPaise: 5500 });
  const [{ mrp }] = await db()<{ mrp: number }[]>`select mrp_paise::int as mrp from products where id = ${a.productId}`;
  if (mrp !== 5000) bad.push(`the master MRP became ${mrp} after an owner's request`);
  await api("shopB", "DELETE", `/api/shop-products/${b.shopProductId}`);
  expect(bad, bad.join("\n")).toEqual([]);
  return `MRP ₹50; ₹55 refused by the price form (${form.status} "${form.body?.error?.message ?? ""}") and Excel (apply ${apply.status}, price unchanged); operator ₹42 → ${proposed.status} pending, live after the owner's approval; card "${card.slice(0, 80)}"; compare MRP ${compare.mrp} with A ₹42 and B ₹47; owner MRP request → ${ownMrp.status}, master stays ₹50`;
}, { ...local, partial: `the price form is checked through the request it sends (PATCH /api/shops/{id}/prices); ${SUPERSEDED}` });

/* ------------------------------------------------------------------ SC-24 */

qa("SC-24", "loose goods from no price to a sale: never ₹0 and not buyable while unpriced; only the priced shop is buyable; 750 g at ₹60/kg is exactly ₹45; clearing the price makes it unbuyable again", async ({ browser }) => {
  const category = need((world() as unknown as { category?: { id: string } }).category?.id, "the QA category");
  const name = `QA Loose Moong ${RUN}`;
  // 1. The loose master product (250 g steps, no MRP, no price).
  const [product] = await db()<{ id: string }[]>`
    insert into products (category_id, name, slug, unit, unit_size_milli, kind, mrp_paise, mrp_verification_status, approval_status, is_active)
    values (${category}, ${name}, ${`qa-loose-moong-${RUN}`}, 'kg', 250, 'LOOSE', null, 'UNVERIFIED', 'APPROVED', true) returning id`;
  // 2. Shops A and B add it: both start with an empty price.
  const la = await api("shop", "POST", `/api/shops/${shopId("A")}/products`, { productId: product.id, onlineSaleEnabled: false, onlinePricePaise: null, trackInventory: true, onlineStock: 200 });
  expectStatus(la, 201, "shop A adds it");
  const lb = await api("shopB", "POST", `/api/shops/${shopId("B")}/products`, { productId: product.id, onlineSaleEnabled: false, onlinePricePaise: null, trackInventory: true, onlineStock: 200 });
  expectStatus(lb, 201, "shop B adds it");
  const bad: string[] = [];
  for (const id of [la.body.id, lb.body.id]) if ((await livePrice(id)) !== null) bad.push(`listing ${id.slice(0, 8)} starts at ${await livePrice(id)}, not empty`);
  // 3. The customer: no ₹0 anywhere, neither can be added.
  const view = async () => asPage(browser, "customer", `/products/${product.id}`, async (page) => (await page.locator("main").innerText()).replace(/\s+/g, " "));
  const unpriced = await view();
  if (/₹\s?0(\.00)?(?![\d.,])/.test(unpriced)) bad.push(`₹0 shown while unpriced: "${unpriced.slice(0, 160)}"`);
  await api("customer", "DELETE", "/api/cart");
  for (const [shop, id] of [["A", la.body.id], ["B", lb.body.id]]) {
    const add = await api("customer", "POST", "/api/cart", { shopProductId: id, quantity: 1 });
    if (add.status < 400) bad.push(`unpriced at shop ${shop} added to the cart (${add.status})`);
  }
  // 4. Shop B prices it at ₹60 per kg; shop A leaves it empty.
  expectStatus(await api("shopB", "PATCH", `/api/shop-products/${lb.body.id}`, { onlinePricePaise: 6000, onlineSaleEnabled: true }), 200, "shop B: ₹60 per kg");
  // 5. Compare, then 750 g from shop B.
  const priced = await view();
  if (!priced.includes("60")) bad.push(`shop B's ₹60/kg is not shown: "${priced.slice(0, 160)}"`);
  if (/₹\s?0(\.00)?(?![\d.,])/.test(priced)) bad.push("₹0 shown for shop A");
  const addA = await api("customer", "POST", "/api/cart", { shopProductId: la.body.id, quantity: 1 });
  if (addA.status < 400) bad.push(`shop A (no price) buyable after B priced (${addA.status})`);
  await api("customer", "DELETE", "/api/cart");
  const listing = { shopProductId: lb.body.id, productId: product.id, name, pricePaise: 6000, stock: 200, shopId: shopId("B"), shopName: need(world().shops.B, "shop B").name } as Listing;
  const order = await buy(listing, 3);
  const [line] = await db()<{ qty: number; total: number }[]>`select quantity_milli::int as qty, line_total_paise::int as total from order_items where order_id = ${order.id}`;
  const [o] = await db()<{ subtotal: number }[]>`select subtotal_paise::int as subtotal from orders where id = ${order.id}`;
  if (line.qty !== 750 || line.total !== 4500 || o.subtotal !== 4500) bad.push(`750 g line ${line.qty} milli ₹${line.total / 100}, goods ₹${o.subtotal / 100} (expected ₹45)`);
  await api("customer", "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
  // 6. Shop B clears the price again.
  const clear = await api("shopB", "PATCH", `/api/shop-products/${lb.body.id}`, { onlinePricePaise: null, onlineSaleEnabled: false });
  expectStatus(clear, 200, "shop B clears the price");
  const again = await api("customer", "POST", "/api/cart", { shopProductId: lb.body.id, quantity: 1 });
  if (again.status < 400) bad.push(`still buyable after the price was cleared (${again.status})`);
  await api("customer", "DELETE", "/api/cart");
  expect(bad, bad.join("\n")).toEqual([]);
  return `both shops start unpriced (null); product page shows no ₹0; neither addable; B ₹60/kg → shown and buyable, A still not; ${order.orderNumber}: 750 g = ₹45.00 exactly; B cleared → add to cart ${again.status}`;
}, { ...local, partial: "the loose master product is arranged in the catalogue database (the operator's create-product API has no LOOSE kind — loose master products come from the product master's promote step)" });

/* ------------------------------------------------------------------ SC-25 */

qa("SC-25", "shop-specific MRP (superseded: one master MRP): owner A's price above the master MRP is refused until the admin raises it; both shops follow the master; each order records its own shop's price and the MRP; another shop's listing cannot be changed", async () => {
  const a = await freshListing({ name: "QA Master Biscuit", pricePaise: 4800, stock: 20, mrpPaise: 5000 });
  const b = await listAtB(a.productId, 4900);
  b.name = a.name;
  const bad: string[] = [];
  // 2. Owner A: price ₹52 with the master MRP at ₹50 is refused; there is no shop MRP to change.
  const over = await api("shop", "PATCH", `/api/shop-products/${a.shopProductId}`, { onlinePricePaise: 5200 });
  if (over.status !== 422) bad.push(`price ₹52 above the master MRP → ${over.status}`);
  // 4. The admin raises the master MRP to ₹60: both shops follow; A can now charge ₹52.
  expectStatus(await api("admin", "POST", "/api/mrp", { productId: a.productId, mrpPaise: 6000, source: "ADMIN", reason: "QA: new pack price" }), 200, "master MRP ₹60");
  expectStatus(await api("shop", "PATCH", `/api/shop-products/${a.shopProductId}`, { onlinePricePaise: 5200 }), 200, "shop A ₹52");
  // 5. The customer buys from each shop.
  const fromA = await buy({ ...a, pricePaise: 5200 }, 1);
  const fromB = await buy(b, 1);
  for (const [o, price] of [[fromA, 5200], [fromB, 4900]] as const) {
    const [line] = await db()<Record<string, unknown>[]>`select * from order_items where order_id = ${o.id}`;
    const unit = Number(line.unit_price_paise ?? line.price_paise ?? line.unit_price_snapshot_paise ?? NaN);
    const mrpKeys = Object.keys(line).filter((k) => /mrp/i.test(k));
    if (unit !== price && Number(line.line_total_paise) !== price) bad.push(`${o.orderNumber}: line price ${unit} / total ${line.line_total_paise}, expected ${price}`);
    if (!mrpKeys.length) bad.push(`${o.orderNumber}: the order line records no MRP (columns: ${Object.keys(line).join(", ")})`);
    else if (Number(line[mrpKeys[0]]) !== 6000) bad.push(`${o.orderNumber}: MRP ${line[mrpKeys[0]]} recorded, expected 6000`);
    await api("customer", "PATCH", `/api/orders/${o.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
  }
  // 6. Owner A tries to change shop B's listing.
  const cross = await api("shop", "PATCH", `/api/shop-products/${b.shopProductId}`, { onlinePricePaise: 4000 });
  if (cross.status !== 403 && cross.status !== 404) bad.push(`owner A changed shop B's listing (${cross.status} ${why(cross)})`);
  if ((await livePrice(b.shopProductId)) !== 4900) bad.push("shop B's price changed");
  await api("shopB", "DELETE", `/api/shop-products/${b.shopProductId}`);
  expect(bad, bad.join("\n")).toEqual([]);
  return `₹52 over the ₹50 master MRP → ${over.status}; master → ₹60, A ₹52 accepted, B follows; orders ${fromA.orderNumber} ₹52 / ${fromB.orderNumber} ₹49 with MRP ₹60; owner A on B's listing → ${cross.status}`;
}, { ...local, partial: `"Shop A shows MRP 55" — ${SUPERSEDED}` });
