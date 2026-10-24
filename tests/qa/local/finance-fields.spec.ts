/**
 * Field-level checks of package 7 (the 3 Oct field-testing request): a shop
 * listing's online / in-shop price, MRP, stock, thresholds and sale switches
 * (TC-FLD-058…064), stock adjustments (TC-FLD-065), product photos
 * (TC-FLD-066), the listing's description text (TC-FLD-067), a new product
 * (TC-FLD-068), the add-category picker (TC-FLD-069), the Excel upload's file
 * field (TC-FLD-070), the registration fee schedule (TC-FLD-112) and a shop
 * payment record (TC-FLD-113).
 *
 * Local tier: each listing check works on a fresh listing of its own; the
 * registration fee is a global setting (restored in the same check); payment
 * records go against the world's pending shop.
 */
import ExcelJS from "exceljs";
import { deflateSync } from "node:zlib";

import { api, asPage, freshListing, productCard, rid, shopId, shown, type Listing } from "../lib/finance-helpers";
import { as } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, RUN, type Answer } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 240_000 };

/** Collects the probes whose answer differs from the rule. */
class Probes {
  bad: string[] = [];
  seen: string[] = [];
  check(label: string, res: Answer, want: number | number[]) {
    const list = Array.isArray(want) ? want : [want];
    this.seen.push(`${label} → ${res.status}`);
    if (!list.includes(res.status)) this.bad.push(`${label} → ${res.status} (expected ${list.join("/")})${res.body?.error?.message ? `: ${res.body.error.message}` : ""}`);
    return res;
  }
  note(text: string) {
    this.bad.push(text);
  }
  assert(what: string) {
    expect(this.bad, `${what}: ${this.bad.join(" | ")}`).toEqual([]);
    return this.seen.join("; ");
  }
}

const patch = (listing: Listing, body: Record<string, unknown>, role: "shop" | "shopB" = "shop") => api(role, "PATCH", `/api/shop-products/${listing.shopProductId}`, body);
async function listingRow(id: string) {
  const [row] = await db()<{ online_price_paise: number | null; offline_price_paise: number | null; online_stock: number; online_sale_enabled: boolean; offline_sale_enabled: boolean; low_stock_threshold: number; reorder_level: number | null; reorder_quantity: number | null }[]>`
    select online_price_paise::int, offline_price_paise::int, online_stock, online_sale_enabled, offline_sale_enabled, low_stock_threshold, reorder_level, reorder_quantity from shop_products where id = ${id}`;
  return row;
}

/* ------------------------------------------------------------------ PNGs */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** An RGB PNG of w × h; `noise` makes it incompressible (for the size limit). */
function png(w: number, h: number, noise = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = noise ? Math.floor(Math.random() * 256) : (x * 7 + y) & 0xff;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: noise ? 0 : 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/* -------------------------------------------------------------- listings */

qa("TC-FLD-058", "listing online price: blank (on sale), 0, negative, text, 3 decimals, out of range and above the MRP are refused; ₹70.50 is 7050 paise and shows ₹70.50; a loose product may stay unpriced", async ({ browser }) => {
  const withMrp = await freshListing({ name: "QA MRP50 Juice", pricePaise: 4500, mrpPaise: 5000, stock: 10 });
  const noMrp = await freshListing({ name: "QA No-MRP Pickle", pricePaise: 4500, stock: 10 });
  const loose = await freshListing({ name: "QA Loose Peas", kind: "LOOSE", pricePaise: 6000, stock: 10 });
  const p = new Probes();
  p.check("blank while on sale online", await patch(noMrp, { onlineSaleEnabled: true, onlinePricePaise: null }), 422);
  p.check("₹0", await patch(noMrp, { onlinePricePaise: 0 }), 422);
  p.check("−₹1", await patch(noMrp, { onlinePricePaise: -100 }), 422);
  p.check("text", await patch(noMrp, { onlinePricePaise: "seventy" }), 422);
  p.check("10.555 (1055.5 paise)", await patch(noMrp, { onlinePricePaise: 1055.5 }), 422);
  p.check("₹10,00,00,000", await patch(noMrp, { onlinePricePaise: 10_000_000_000 }), 422);
  p.check("₹51 above the ₹50 MRP", await patch(withMrp, { onlinePricePaise: 5100 }), 422);
  p.check("₹70.50", await patch(noMrp, { onlinePricePaise: 7050 }), 200);
  if ((await listingRow(noMrp.shopProductId)).online_price_paise !== 7050) p.note("₹70.50 not stored as 7050");
  p.check("loose: blank price, off sale", await patch(loose, { onlineSaleEnabled: false, onlinePricePaise: null }), 200);
  const looseRow = await listingRow(loose.shopProductId);
  if (looseRow.online_price_paise !== null || looseRow.online_sale_enabled) p.note("the loose product did not stay unpriced and off sale");
  // The owner's form: ₹70.50 shows as ₹70.50; three decimals and ₹0 must be stopped at the field.
  await asPage(browser, "shop", "/shop/manage/products", async (page) => {
    const card = await productCard(page, noMrp.name);
    await expect(card).toContainText(`${shown(7050)} online`);
    for (const [typed, label] of [["10.555", "₹10.555"], ["0", "₹0"]] as const) {
      await card.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel(/Online price/).fill(typed);
      // Refused on the form (no request, TC-CAT-032) or sent: either way it must not save the typed value.
      const saved = page.waitForResponse((r) => r.url().includes(`/api/shop-products/${noMrp.shopProductId}`) && r.request().method() === "PATCH", { timeout: 8_000 }).catch(() => null);
      await page.getByRole("button", { name: "Save changes" }).click();
      const res = await saved;
      const stored = (await listingRow(noMrp.shopProductId)).online_price_paise;
      if (res?.ok()) p.note(`the form saved ${label} as ${stored} paise without a field message`);
      // Put ₹70.50 back for the next probe.
      await patch(noMrp, { onlinePricePaise: 7050 });
      await page.reload();
      await productCard(page, noMrp.name);
    }
  });
  return p.assert("online price");
}, local);

qa("TC-FLD-059", "listing in-shop price: 0, negative, text, 3 decimals and out of range refused; ₹70.50 stored as 7050; blank accepted when in-shop sale is off", async () => {
  const listing = await freshListing({ name: "QA Offline Price Item", pricePaise: 4500, stock: 10 });
  const p = new Probes();
  p.check("blank, in-shop off", await patch(listing, { offlineSaleEnabled: false, offlinePricePaise: null }), 200);
  p.check("blank while sold in shop", await patch(listing, { offlineSaleEnabled: true, offlinePricePaise: null }), 422);
  p.check("₹0", await patch(listing, { offlineSaleEnabled: true, offlinePricePaise: 0 }), 422);
  p.check("−₹1", await patch(listing, { offlinePricePaise: -100 }), 422);
  p.check("text", await patch(listing, { offlinePricePaise: "ten" }), 422);
  p.check("10.555", await patch(listing, { offlinePricePaise: 1055.5 }), 422);
  p.check("₹10,00,00,000", await patch(listing, { offlinePricePaise: 10_000_000_000 }), 422);
  p.check("₹70.50", await patch(listing, { offlineSaleEnabled: true, offlinePricePaise: 7050 }), 200);
  if ((await listingRow(listing.shopProductId)).offline_price_paise !== 7050) p.note("₹70.50 not stored as 7050");
  return p.assert("in-shop price");
}, { ...local, partial: "API only; the form's handling of decimals is the same input as the online price (TC-FLD-058)" });

qa("TC-FLD-060", "listing MRP: the owner has no MRP field of their own; the master MRP is operations-only and a price above it is refused", async () => {
  const listing = await freshListing({ name: "QA MRP Guard Soap", pricePaise: 4800, mrpPaise: 5000, stock: 10 });
  const p = new Probes();
  const ignored = await patch(listing, { mrpPaise: 7050, onlinePricePaise: 4800 });
  p.check("an mrpPaise field on the listing", ignored, 200);
  const [mrp] = await db()<{ mrp: number }[]>`select mrp_paise::int as mrp from products where id = ${listing.productId}`;
  if (mrp.mrp !== 5000) p.note(`the listing PATCH changed the master MRP to ${mrp.mrp}`);
  p.check("owner sets the master MRP", await api("shop", "POST", "/api/mrp", { productId: listing.productId, mrpPaise: 4500, source: "SELLER_SUBMITTED" }), 403);
  p.check("price ₹51 above the MRP", await patch(listing, { onlinePricePaise: 5100 }), 422);
  // The owner's path is an MRP correction request, with its own amount rules.
  const correction = (claimedMrpPaise: unknown) => api("shop", "POST", "/api/mrp/corrections", { productId: listing.productId, shopId: listing.shopId, claimedMrpPaise, note: "QA" });
  p.check("correction −₹1", await correction(-100), 422);
  p.check("correction text", await correction("fifty"), 422);
  p.check("correction 10.555", await correction(1055.5), 422);
  p.check("correction ₹70.50", await correction(7050), 201);
  return p.assert("MRP");
}, {
  ...local,
  partial:
    "expected 'the saved MRP applies to this shop only' superseded by docs/product-import-2026-10/README.md ('Decisions taken' 1) and docs/three-modules-2026-10/PLAN.md §1.2: there is no shop-level MRP field; the master MRP is operations-only (a shop raises a correction), and the bulk upload's MRP column is kept per listing only to guard the price",
});

qa("TC-FLD-061", "listing stock: −1, 1.5, text and out of range refused; a normal value saves; 0 shows out of stock; decimals only for loose goods", async ({ browser }) => {
  const listing = await freshListing({ name: "QA Stock Field Tin", pricePaise: 3000, stock: 10 });
  const p = new Probes();
  p.check("−1", await patch(listing, { onlineStock: -1 }), 422);
  p.check("1.5 (packaged)", await patch(listing, { onlineStock: 1.5 }), 422);
  p.check("text", await patch(listing, { onlineStock: "ten" }), 422);
  p.check("99999999", await patch(listing, { onlineStock: 99_999_999 }), 422);
  p.check("blank (null)", await patch(listing, { onlineStock: null }), 422);
  p.check("37", await patch(listing, { onlineStock: 37 }), 200);
  if ((await listingRow(listing.shopProductId)).online_stock !== 37) p.note("37 not saved");
  p.check("0", await patch(listing, { onlineStock: 0 }), 200);
  // A customer's storefront answer says whether it is in stock, not the count (TC-SPI-027).
  const card = await api("customer", "GET", `/api/shops/${shopId("A")}/products?limit=100`);
  const row = (card.body as { shopProductId: string; inStock?: boolean; onlineStock?: number }[]).find((r) => r.shopProductId === listing.shopProductId);
  if (row && (row.inStock ?? (row.onlineStock ?? 0) > 0)) p.note("0 does not show out of stock");
  const add = await api("customer", "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 });
  if (add.status !== 409) p.note(`at 0 the product can still be added (${add.status})`);
  // The form: a blank stock box must not save as 0 silently.
  await patch(listing, { onlineStock: 37 });
  await asPage(browser, "shop", "/shop/manage/products", async (page) => {
    const c = await productCard(page, listing.name);
    await expect(c).toContainText("37 in stock");
    await c.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Online stock").fill("");
    // Refused on the form (no request) or sent: a blank box must not become 0.
    const saved = page.waitForResponse((r) => r.url().includes(`/api/shop-products/${listing.shopProductId}`) && r.request().method() === "PATCH", { timeout: 8_000 }).catch(() => null);
    await page.getByRole("button", { name: "Save changes" }).click();
    await saved;
    const after = (await listingRow(listing.shopProductId)).online_stock;
    if (after !== 37) p.note(`the form saved a blank stock box as ${after} without a field message`);
  });
  return p.assert("stock");
}, { ...local, partial: "decimals for loose goods are TC-SPI-025 (refused: whole steps only)" });

qa(["TC-FLD-062", "TC-FLD-063"], "low-stock threshold and reorder level / quantity: −1, 1.5, text and out of range refused; a normal value saves; blank falls back (threshold) or means no reorder hint", async () => {
  const listing = await freshListing({ name: "QA Threshold Jar", pricePaise: 3000, stock: 30 });
  const set = (body: Record<string, unknown>) => api("shop", "PATCH", `/api/shop-products/${listing.shopProductId}/stock-settings`, body);
  const p = new Probes();
  for (const field of ["lowStockThreshold", "reorderLevel", "reorderQuantity"]) {
    p.check(`${field} −1`, await set({ [field]: -1 }), 422);
    p.check(`${field} 1.5`, await set({ [field]: 1.5 }), 422);
    p.check(`${field} text`, await set({ [field]: "five" }), 422);
    p.check(`${field} 99999999`, await set({ [field]: 99_999_999 }), 422);
  }
  p.check("normal 5 / 4 / 12", await set({ lowStockThreshold: 5, reorderLevel: 4, reorderQuantity: 12 }), 200);
  let row = await listingRow(listing.shopProductId);
  if ([row.low_stock_threshold, row.reorder_level, row.reorder_quantity].join() !== "5,4,12") p.note(`saved ${row.low_stock_threshold}/${row.reorder_level}/${row.reorder_quantity}`);
  p.check("blank threshold (0 = inherit), blank reorder", await set({ lowStockThreshold: 0, reorderLevel: null, reorderQuantity: null }), 200);
  row = await listingRow(listing.shopProductId);
  const inv = await api("shop", "GET", `/api/shops/${shopId("A")}/inventory`);
  const r = (inv.body.rows as { shopProductId: string; thresholds: { source: { lowStock: string }; reorderLevel: number | null } }[]).find((x) => x.shopProductId === listing.shopProductId);
  if (r?.thresholds.source.lowStock === "LISTING") p.note("a blank threshold did not fall back to the product / shop default");
  if (row.reorder_level !== null) p.note("a blank reorder level was not cleared");
  return p.assert("thresholds");
}, { ...local, partial: "API only (the inventory page sends the same fields)" });

qa("TC-FLD-064", "sell online / sell in shop switches: on and off persist and take effect; a non-boolean is refused; online sale cannot be on without a price", async ({ browser }) => {
  const listing = await freshListing({ name: "QA Switch Box", pricePaise: 3000, stock: 10 });
  const p = new Probes();
  p.check("offline on with a price", await patch(listing, { offlineSaleEnabled: true, offlinePricePaise: 3000 }), 200);
  p.check("online off", await patch(listing, { onlineSaleEnabled: false }), 200);
  let row = await listingRow(listing.shopProductId);
  if (row.online_sale_enabled || !row.offline_sale_enabled) p.note("the switches did not persist");
  const offAdd = await api("customer", "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 });
  if (offAdd.status !== 409) p.note(`online off but still added to a cart (${offAdd.status})`);
  p.check("online on again", await patch(listing, { onlineSaleEnabled: true }), 200);
  row = await listingRow(listing.shopProductId);
  if (!row.online_sale_enabled) p.note("online on did not persist");
  const onAdd = await api("customer", "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 });
  if (onAdd.status !== 200) p.note(`online on but not buyable (${onAdd.status})`);
  await api("customer", "DELETE", "/api/cart");
  p.check('non-boolean "yes"', await patch(listing, { onlineSaleEnabled: "yes" }), 422);
  p.check("1 for a switch", await patch(listing, { offlineSaleEnabled: 1 }), 422);
  p.check("online on with the price blank", await patch(listing, { onlineSaleEnabled: true, onlinePricePaise: null }), 422);
  // Through the form: switching online off and back persists over a reload.
  await asPage(browser, "shop", "/shop/manage/products", async (page) => {
    const c = await productCard(page, listing.name);
    await c.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Sell online").uncheck();
    const saved = page.waitForResponse((r) => r.url().includes(`/api/shop-products/${listing.shopProductId}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save changes" }).click();
    await saved;
    await page.reload();
    const again = await productCard(page, listing.name);
    await again.getByRole("button", { name: "Edit" }).click();
    if (await page.getByLabel("Sell online").isChecked()) p.note("'Sell online' unchecked in the form did not persist over a reload");
  });
  return p.assert("switches");
}, local);

qa("TC-FLD-065", "stock adjustment: 0, text and a decimal on a packaged product are refused; a reduction below zero is refused; the reason is optional; adding 5 with a reason writes a movement", async () => {
  const listing = await freshListing({ name: "QA Adjust Pack", pricePaise: 3000, stock: 10 });
  const writeOff = (qtyMilli: unknown, note?: string) => api("shop", "POST", `/api/shops/${listing.shopId}/accounts/stock/${listing.shopProductId}/write-off`, { qtyMilli, kind: "DAMAGE", ...(note !== undefined ? { note } : {}) });
  const p = new Probes();
  p.check("write-off 0", await writeOff(0), 422);
  p.check("write-off text", await writeOff("two"), 422);
  p.check("write-off 1.5 units of a packaged product (1500 milli)", await writeOff(1500), 422);
  p.check("reduce by 11 of 10", await writeOff(11_000), 422);
  const noReason = p.check("write-off 1 with no reason", await writeOff(1000), [201, 422]);
  // Adding 5 with a reason, on a listing of its own at 10.
  const add = await freshListing({ name: "QA Adjust Add", pricePaise: 3000, stock: 10 });
  const since = new Date(Date.now() - 1000);
  p.check(
    "add 5 with a reason (physical count 15)",
    await api("shop", "POST", `/api/shops/${add.shopId}/accounts/stock/${add.shopProductId}/count`, { countedMilli: 15_000, note: "QA: found 5 more in the back room" }),
    200,
  );
  const moved = await db()<{ delta_units: number; reason: string }[]>`select delta_units, reason from inventory_movements where shop_product_id = ${add.shopProductId} and created_at >= ${since}`;
  if (moved.reduce((t, m) => t + m.delta_units, 0) !== 5) p.note(`adding 5 wrote ${moved.map((m) => m.delta_units).join(", ") || "no"} movement`);
  const out = p.assert("stock adjustment");
  return `${out}; the reason is ${noReason.status === 201 ? "optional (recorded when given)" : "required"}`;
}, local);

qa("TC-FLD-066", "product photo: no file, oversize, wrong type, a PDF named .jpg, an empty file and a 20 × 20 image are refused with a message; a valid image is accepted and served", async () => {
  const owner = await as("shop");
  const upload = (file: { name: string; mimeType: string; buffer: Buffer } | null) =>
    call(owner, "POST", "/api/images", undefined, { multipart: file ? { file, purpose: "PRODUCT" } : { purpose: "PRODUCT" } });
  const p = new Probes();
  p.check("no file", await upload(null), 422);
  p.check("2.9 MB (over the 2 MB limit)", await upload({ name: "big.png", mimeType: "image/png", buffer: png(1200, 800, true) }), 422);
  p.check("a text file", await upload({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") }), 422);
  p.check("a PDF named .jpg", await upload({ name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF") }), 422);
  p.check("an SVG named .jpg", await upload({ name: "photo2.jpg", mimeType: "image/jpeg", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><script>alert(1)</script></svg>') }), 422);
  p.check("an empty file", await upload({ name: "empty.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(0) }), 422);
  p.check("20 × 20 px", await upload({ name: "tiny.png", mimeType: "image/png", buffer: png(20, 20) }), 422);
  const ok = p.check("a valid 400 × 300 PNG", await upload({ name: "good.png", mimeType: "image/png", buffer: png(400, 300) }), 201);
  if (ok.status === 201) {
    const served = await call(owner, "GET", ok.body.url);
    if (served.status !== 200 || !/image\//.test(served.headers["content-type"] ?? "")) p.note(`the accepted image is not served (${served.status} ${served.headers["content-type"]})`);
  }
  return p.assert("photo upload");
}, { ...local, partial: "the upload API (the page's uploader shrinks the image first and posts the same file)" });

qa("TC-FLD-067", "listing description: blank accepted; long text refused at the limit, never a 500; script text kept as plain text; Hindi / Marathi saved and shown", async ({ browser }) => {
  const listing = await freshListing({ name: "QA Description Item", pricePaise: 3000, stock: 10 });
  const set = (body: Record<string, unknown>) => api("shop", "PATCH", `/api/shops/${listing.shopId}/listings/${listing.shopProductId}/media`, body);
  const p = new Probes();
  p.check("blank", await set({ shortDescription: "" }), 200);
  p.check("300 characters", await set({ shortDescription: "क".repeat(10) + "a".repeat(290) }), [200, 422]);
  let limit = 0;
  for (const n of [50, 100, 150, 160, 200, 250, 300, 500, 1000, 5000, 20_001]) {
    const res = await set({ shortDescription: "x".repeat(n) });
    if (res.status >= 500) p.note(`${n} characters → ${res.status}`);
    if (res.status === 200) limit = n;
  }
  const script = "<script>alert(1)</script> & <b>bold</b> ₹ % \"";
  p.check("script text", await set({ shortDescription: script }), 200);
  const stored = await db()<{ short_description: string | null }[]>`select short_description from shop_products where id = ${listing.shopProductId}`;
  const hindi = "ताज़ा देसी घी — शुद्ध गाईचे तूप";
  p.check("Hindi / Marathi", await set({ longDescription: hindi }), 200);
  const page = await asPage(browser, "customer", `/products/${listing.productId}`, async (pg) => {
    let alerted = false;
    pg.on("dialog", async (d) => {
      alerted = true;
      await d.dismiss();
    });
    const text = await pg.locator("main").first().innerText();
    return { text, alerted };
  });
  if (page.alerted) p.note("the script text ran in the page");
  if (!stored[0].short_description?.includes("<script>")) p.note(`script text not kept as typed (stored "${stored[0].short_description?.slice(0, 40)}")`);
  const out = p.assert("description");
  return `${out}; accepted up to ${limit} characters (short description limit from rule shopProductMedia); Hindi ${page.text.includes("ताज़ा") ? "shown on the product page" : "saved"}`;
}, local);

qa("TC-FLD-068", "a new product by a shop: blank / spaces-only name refused; long name refused at the limit, never a 500; script and Hindi kept as text; outer spaces trimmed; pack size must be positive", async () => {
  const create = (body: Record<string, unknown>) => api("shop", "POST", "/api/products", { shopId: shopId("A"), unit: "piece", ...body });
  const p = new Probes();
  p.check("blank name", await create({ name: "" }), 422);
  p.check("spaces-only name", await create({ name: "     " }), 422);
  p.check("1 character", await create({ name: "Q" }), 422);
  const long = await create({ name: `QA ${"L".repeat(300)}` });
  if (long.status >= 500) p.note(`a 300+ character name → ${long.status}`);
  p.check("300+ characters", long, [422, 201]);
  const script = await create({ name: `<script>alert(1)</script> QA ${RUN}`, confirmDuplicate: true });
  p.check("script text", script, 201);
  const hindi = await create({ name: `QA ताज़ा पनीर ${RUN}`, confirmDuplicate: true });
  p.check("Hindi / Marathi", hindi, 201);
  const spaced = await create({ name: `   QA Trimmed ${RUN}   `, confirmDuplicate: true });
  p.check("outer spaces", spaced, 201);
  const names = await db()<{ name: string }[]>`select name from products where name like ${`%${RUN}%`}`;
  if (!names.some((n) => n.name === `QA Trimmed ${RUN}`)) p.note("outer spaces were not trimmed");
  if (!names.some((n) => n.name === `QA ताज़ा पनीर ${RUN}`)) p.note("the Hindi name was not saved as typed");
  if (!names.some((n) => n.name === `<script>alert(1)</script> QA ${RUN}`)) p.note("the script text was not kept as plain text");
  p.check("pack size 0", await create({ name: `QA Pack Zero ${RUN}`, unitSizeMilli: 0 }), 422);
  p.check("pack size negative", await create({ name: `QA Pack Neg ${RUN}`, unitSizeMilli: -500 }), 422);
  p.check("pack size text", await create({ name: `QA Pack Text ${RUN}`, unitSizeMilli: "half" }), 422);
  p.check("blank unit", await create({ name: `QA No Unit ${RUN}`, unit: "" }), 422);
  for (const [unit, label] of [["bananas", "a unit not in the list ('bananas')"], ["0 kg", "pack size 0 in the form's 'Unit / pack size' box"], ["-5 L", "a negative pack size in the form's box"]] as const) {
    p.check(label, await create({ name: `QA Unit ${unit} ${RUN}`, unit, confirmDuplicate: true }), 422);
  }
  return `${p.assert("new product")}; 300+ character name → ${long.status}`;
}, { ...local, partial: "the product form has no brand field (a new product's brand is not asked for); API only" });

qa("TC-FLD-069", "add-category picker: nothing chosen and an unlisted value refused; listed options save and show; an already-added category adds no duplicates; an unknown id is refused and adds nothing", async () => {
  const b = shopId("B");
  const add = (body: Record<string, unknown>) => api("shopB", "POST", `/api/shops/${b}/product-categories`, body);
  const w = world() as ReturnType<typeof world> & { category?: { id: string } };
  const qaCategory = need(w.category?.id, "the QA category");
  const options = await api("shopB", "GET", "/api/product-categories");
  const all = ((options.body?.categories ?? options.body ?? []) as { id: string; name: string; productCount?: number }[]);
  const picks = all.filter((c) => ["Khari", "Curd"].includes(c.name)).slice(0, 2);
  const p = new Probes();
  p.check("nothing chosen", await add({}), 422);
  p.check("an unlisted value", await add({ categoryId: "dairy" }), 422);
  const before = await db()<{ n: number }[]>`select count(*)::int as n from shop_products where shop_id = ${b}`;
  p.check("an unknown id", await add({ categoryId: "00000000-0000-4000-8000-000000000000" }), [404, 422]);
  const afterUnknown = await db()<{ n: number }[]>`select count(*)::int as n from shop_products where shop_id = ${b}`;
  if (afterUnknown[0].n !== before[0].n) p.note("an unknown category added products");
  for (const c of picks) p.check(`option "${c.name}"`, await add({ categoryId: c.id }), [200, 201]);
  const listed = await api("shopB", "GET", `/api/shops/${b}/product-categories`);
  const names = ((listed.body?.categories ?? []) as { name: string; categoryId?: string; id?: string }[]).map((c) => c.name);
  for (const c of picks) if (!names.includes(c.name)) p.note(`"${c.name}" does not show after saving`);
  const dupBefore = await db()<{ n: number }[]>`select count(*)::int as n from shop_products where shop_id = ${b}`;
  p.check("the QA category again (already added)", await add({ categoryId: qaCategory }), 200);
  const dupAfter = await db()<{ n: number }[]>`select count(*)::int as n from shop_products where shop_id = ${b}`;
  const [cats] = await db()<{ n: number }[]>`select count(*)::int as n from shop_product_categories where shop_id = ${b} and category_id = ${qaCategory}`;
  if (dupAfter[0].n !== dupBefore[0].n || cats.n !== 1) p.note("adding an existing category made duplicates");
  return `${p.assert("category picker")}; options tried: ${picks.map((c) => c.name).join(", ")}`;
}, { ...local, partial: "two of the listed options were saved (each adds that category's products to shop B), not every option" });

qa("TC-FLD-070", "Excel upload file field: no file, oversize, wrong type, a PDF named .xlsx and an empty file refused with a message; a valid sheet previews; a headers-only sheet reports nothing to apply", async () => {
  const owner = await as("shop");
  const up = (file: { name: string; mimeType: string; buffer: Buffer } | null) =>
    call(owner, "POST", "/api/excel-uploads", undefined, { multipart: { shopId: shopId("A"), uploadType: "PRICES", ...(file ? { file } : {}) } });
  const sheet = async (rows: (string | number)[][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Prices");
    ws.addRow(["Product ID", "Product Name", "Price"]);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const [code] = await db()<{ code: string; price: number }[]>`select p.code, sp.online_price_paise::int as price from shop_products sp join products p on p.id = sp.product_id
    where sp.shop_id = ${shopId("A")} and sp.online_price_paise is not null and sp.deleted_at is null and p.mrp_paise is null limit 1`;
  const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const p = new Probes();
  p.check("no file", await up(null), 422);
  p.check("a 6 MB file", await up({ name: "big.xlsx", mimeType: xlsx, buffer: Buffer.alloc(6 * 1024 * 1024, 65) }), [413, 422]);
  p.check("a text file", await up({ name: "prices.txt", mimeType: "text/plain", buffer: Buffer.from("Product ID,Price\nP1,10") }), 422);
  p.check("a PDF named .xlsx", await up({ name: "prices.xlsx", mimeType: xlsx, buffer: Buffer.from("%PDF-1.4\n%%EOF") }), 422);
  p.check("an empty file", await up({ name: "empty.xlsx", mimeType: xlsx, buffer: Buffer.alloc(0) }), 422);
  const valid = p.check("a valid sheet", await up({ name: "prices.xlsx", mimeType: xlsx, buffer: await sheet([[code.code, "QA", code.price / 100]]) }), 201);
  const headersOnly = p.check("headers only", await up({ name: "headers.xlsx", mimeType: xlsx, buffer: await sheet([]) }), 422);
  if (headersOnly.status === 422 && !/no data rows/i.test(headersOnly.body?.error?.message ?? "")) p.note(`headers-only message: "${headersOnly.body?.error?.message}"`);
  return `${p.assert("excel upload")}; valid preview ${valid.body?.id ? `${valid.body.id.slice(0, 8)}…` : ""}; headers only: "${headersOnly.body?.error?.message}"`;
}, { ...local, partial: "the upload API (the page posts the same form); the upload limit is rule spreadsheets.maxBytes" });

/* ---------------------------------------------------------- fees, payments */

qa("TC-FLD-112", "registration fee schedule amount: blank, negative, text, 3 decimals and out of range refused; ₹70.50 stored as 7050; 0 accepted (free registration)", async () => {
  const current = await api("admin", "GET", "/api/registration-fees");
  expectStatus(current, 200, "fee schedule");
  const before = current.body.active?.amountPaise ?? 0;
  const set = (amountPaise: unknown) => api("admin", "POST", "/api/registration-fees", { amountPaise, reason: `QA ${RUN}` });
  const p = new Probes();
  try {
    p.check("blank", await set(null), 422);
    p.check("−₹1", await set(-100), 422);
    p.check("text", await set("fifty"), 422);
    p.check("10.555", await set(1055.5), 422);
    p.check("₹10,00,00,000", await set(10_000_000_000), 422);
    p.check("₹70.50", await set(7050), 201);
    const after = await api("admin", "GET", "/api/registration-fees");
    if (after.body.active?.amountPaise !== 7050) p.note(`₹70.50 active as ${after.body.active?.amountPaise}`);
    p.check("₹0 (free)", await set(0), 201);
  } finally {
    await set(before);
  }
  return `${p.assert("registration fee")}; restored to ₹${before / 100}`;
}, local);

qa("TC-FLD-113", "shop payment record: blank, zero, negative, text, 3 decimals and out of range refused; ₹70.50 stored as 7050; a reference is required and unique; a future date is refused", async () => {
  const pending = need(world().shops.pending?.id, "the pending shop");
  const record = (body: Record<string, unknown>) => api("ops", "POST", "/api/shop-payments", { shopId: pending, paymentType: "REGISTRATION_FEE", method: "UPI", ...body });
  const ref = `UPI-${RUN}-${rid("p").slice(-6)}`;
  const p = new Probes();
  p.check("blank amount", await record({ amountPaise: null, transactionId: `${ref}-a` }), 422);
  p.check("₹0", await record({ amountPaise: 0, transactionId: `${ref}-b` }), 422);
  p.check("−₹1", await record({ amountPaise: -100, transactionId: `${ref}-c` }), 422);
  p.check("text", await record({ amountPaise: "ten", transactionId: `${ref}-d` }), 422);
  p.check("10.555", await record({ amountPaise: 1055.5, transactionId: `${ref}-e` }), 422);
  p.check("₹10,00,00,000", await record({ amountPaise: 10_000_000_000, transactionId: `${ref}-f` }), 422);
  const ok = p.check("₹70.50", await record({ amountPaise: 7050, transactionId: ref, paidAt: new Date().toISOString() }), 201);
  if (ok.status === 201 && (ok.body?.amountPaise ?? ok.body?.payment?.amountPaise) !== 7050) p.note(`₹70.50 stored as ${ok.body?.amountPaise ?? ok.body?.payment?.amountPaise}`);
  p.check("blank reference", await record({ amountPaise: 100 }), 422);
  p.check("a reference already used", await record({ amountPaise: 100, transactionId: ref }), [409, 422]);
  p.check("a future date", await record({ amountPaise: 100, transactionId: `${ref}-g`, paidAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }), 422);
  return p.assert("shop payment");
}, { ...local, partial: "API only (the operator's form posts the same fields)" });
