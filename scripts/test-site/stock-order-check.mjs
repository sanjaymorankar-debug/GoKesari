/**
 * Stock accuracy on a live test site (docs/inventory-accounting-2026-10, Part 1):
 * a customer's online order reduces the shop's stock and writes a SALE row in
 * the stock ledger at checkout (event-driven, no cron), and cancelling it puts
 * the stock back with a SALE_RETURN row; the ledger stays equal to the stock.
 *
 *   node scripts/test-site/stock-order-check.mjs https://test.gokesari.com owner-state.json customer-state.json <shopId>
 *
 * Pays with the customer's test-site wallet (no payment gateway). Test site only.
 */
import { request } from "@playwright/test";

const [base, ownerState, customerState, shopId] = process.argv.slice(2);
if (!base || !ownerState || !customerState || !shopId) {
  console.error("usage: stock-order-check.mjs <base url> <owner state.json> <customer state.json> <shopId>");
  process.exit(2);
}
if (/\/\/(www\.)?gokesari\.com/.test(base)) {
  console.error("Refusing to place orders on production.");
  process.exit(2);
}
const ENV = new URL(base).host;
const owner = await request.newContext({ storageState: ownerState, baseURL: base, timeout: 120_000 });
const customer = await request.newContext({ storageState: customerState, baseURL: base, timeout: 120_000 });
const A = (p) => `/api/shops/${shopId}/accounts/${p}`;
const body = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const results = [];
function record(id, title, result, detail) {
  const row = { id, title, env: ENV, result, detail: String(detail).slice(0, 600), at: new Date().toISOString() };
  results.push(row);
  console.log(JSON.stringify(row));
}
const fail = (msg) => {
  throw new Error(msg);
};

async function stockOf(spId) {
  const s = await body(await owner.get(A("stock")));
  return s.rows.find((r) => r.shopProductId === spId);
}
async function ledgerOf(spId) {
  return body(await owner.get(A(`stock/${spId}`)));
}
async function drift() {
  return body(await owner.get(A("stock/drift")));
}

let orderId = null;
let spId = null;
let before = null;
try {
  // A tracked listing with stock to spare, sold online.
  const stock = await body(await owner.get(A("stock")));
  const listings = await body(await owner.get(A("stock/listings")));
  const candidates = stock.rows.filter((r) => r.qtyMilli >= 5000 && !r.drift);
  const pick = candidates.find((r) => {
    const l = listings.find((x) => x.shopProductId === r.shopProductId);
    return l && l.onlinePricePaise > 0 && l.onlinePricePaise <= 3_000;
  });
  if (!pick) fail("no listing with stock ≥ 5 and price ≤ ₹30 to order");
  spId = pick.shopProductId;
  before = pick.qtyMilli;

  // Customer: only this item in the cart.
  const cart = await body(await customer.get("/api/cart"));
  for (const group of cart.groups ?? []) {
    for (const line of group.lines ?? []) {
      await customer.patch(`/api/cart/items/${line.cartItemId}`, { data: { quantity: 0 } });
    }
  }
  const add = await customer.post("/api/cart", { data: { shopProductId: spId, quantity: 1 } });
  if (!add.ok()) fail(`add to cart ${add.status()} ${await add.text()}`);
  const wallet = await body(await customer.get("/api/wallet"));
  const addresses = await body(await customer.get("/api/addresses"));
  const list = Array.isArray(addresses) ? addresses : (addresses.addresses ?? []);
  const addressId = (list.find((a) => a.isDefault) ?? list[0])?.id ?? null;
  const attempt = (paymentMethod) =>
    customer.post("/api/checkout", { data: { requestId: `stockcheck-${paymentMethod}-${Date.now().toString(36)}`, addressId, paymentMethod, acknowledgeClosedShopIds: [shopId] } });
  // The test wallet first; cash on delivery when the wallet is short.
  let t0 = Date.now();
  let co = await attempt("WALLET");
  if (!co.ok() && /balance|wallet|top up/i.test(await co.text())) {
    t0 = Date.now();
    co = await attempt("COD");
  }
  const checkoutMs = Date.now() - t0;
  const coBody = await body(co);
  if (!co.ok()) fail(`checkout ${co.status()} ${JSON.stringify(coBody).slice(0, 300)} (wallet ${JSON.stringify(wallet).slice(0, 120)})`);
  orderId = coBody.orders?.[0]?.id;
  if (!orderId) fail(`no order id in ${JSON.stringify(coBody).slice(0, 300)}`);

  const t1 = Date.now();
  const after = await stockOf(spId);
  const led = await ledgerOf(spId);
  const sale = led.find((l) => l.orderId === orderId && l.movementType === "SALE");
  const ok = after.qtyMilli === before - 1000 && sale && sale.qtyMilli === -1000 && led[0].balanceMilli === after.qtyMilli;
  record(
    "TS-STOCK-ORDER",
    "Online order reduces the shop's stock at checkout: SALE ledger row with the order id, ledger = stock (no cron)",
    ok ? "PASS" : "FAIL",
    `order ${orderId}: stock ${before / 1000} → ${after.qtyMilli / 1000}; checkout took ${checkoutMs} ms, stock read ${Date.now() - t1} ms after it returned (first read); ledger row ${sale ? `${sale.movementType} ${sale.qtyMilli / 1000} on ${sale.channel}` : "missing"}; balance ${led[0]?.balanceMilli / 1000}`,
  );
} catch (e) {
  record("TS-STOCK-ORDER", "Online order reduces the shop's stock at checkout: SALE ledger row with the order id, ledger = stock (no cron)", "FAIL", e.message);
}

if (orderId) {
  try {
    const c = await customer.patch(`/api/orders/${orderId}/status`, { data: { status: "CANCELLED", note: "Inventory & Accounting stock test" } });
    if (!c.ok()) fail(`cancel ${c.status()} ${await c.text()}`);
    const after = await stockOf(spId);
    const led = await ledgerOf(spId);
    const back = led.find((l) => l.orderId === orderId && l.movementType === "SALE_RETURN");
    const d = await drift();
    const driftRows = Array.isArray(d) ? d.length : (d.rows?.length ?? 0);
    const ok = after.qtyMilli === before && back && back.qtyMilli === 1000 && driftRows === 0;
    record(
      "TS-STOCK-CANCEL",
      "Cancelling the order puts the stock back: SALE_RETURN ledger row; no listing in the shop drifts from its ledger",
      ok ? "PASS" : "FAIL",
      `stock back to ${after.qtyMilli / 1000} (was ${before / 1000}); ledger row ${back ? `${back.movementType} +${back.qtyMilli / 1000}` : "missing"}; drift rows ${driftRows}`,
    );
  } catch (e) {
    record("TS-STOCK-CANCEL", "Cancelling the order puts the stock back: SALE_RETURN ledger row; no listing in the shop drifts from its ledger", "FAIL", e.message);
  }
}
await owner.dispose();
await customer.dispose();
const passed = results.filter((r) => r.result === "PASS").length;
console.log(JSON.stringify({ summary: { env: ENV, total: results.length, passed, failed: results.length - passed } }));
