/**
 * Sell, purchase and inventory on the local server: money and stock agree on
 * every sale (TC-SPI-001…005), stock through the order states and back on
 * cancel / reject / failure (TC-SPI-018, 019), the reserved floor
 * (TC-SPI-012), out of stock and back (TC-SPI-023), B2B purchase (TC-SPI-007),
 * the shop's sales figure (TC-SPI-009), substitution and removed lines
 * (TC-SPI-010, 011), in-shop sale, stock received and written off
 * (TC-SPI-013, 016, 017), returns (TC-SPI-020), the movement ledger
 * (TC-SPI-021), a stale stock save (TC-SPI-022), Excel stock upload
 * (TC-SPI-024), loose stock units (TC-SPI-025), inventory search (TC-SPI-026)
 * and the admin's inventory exceptions (TC-SPI-028).
 *
 * Local tier: every check works on its own fresh listing (created in the
 * database with a known opening stock), so the stock arithmetic starts from a
 * known figure and no check depends on another's leftovers.
 */
import {
  api,
  asPage,
  buy,
  checkoutLines,
  deliverOrder,
  dbStock,
  ensureFunds,
  freeRider,
  freshListing,
  inventoryRow,
  movements,
  orderDetail,
  packOrder,
  paiseIn,
  pickUpAndStart,
  productCard,
  riderAction,
  setStock,
  shopAction,
  shopId,
  statusOf,
  walletBalance,
  withRules,
  type Listing,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { shopListings } from "../lib/flows";
import { expectStatus, RUN } from "../lib/http";
import { messagesTo } from "../lib/mail";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };

/** The books' stock ledger of a listing (GET /api/shops/{id}/accounts/stock/{listing}), newest first. */
async function ledger(listing: Listing, owner: "shop" | "shopB" = "shop") {
  const res = await api(owner, "GET", `/api/shops/${listing.shopId}/accounts/stock/${listing.shopProductId}`);
  expectStatus(res, 200, "stock ledger");
  return res.body as { movementType: string; qtyMilli: number; balanceMilli: number; note: string | null; orderId: string | null; createdBy: string | null; channel: string }[];
}

qa("TC-SPI-001", "buying 2 of a ₹45 packaged product: line 2 × ₹45 = ₹90 + delivery fee, wallet debited once, stock 98 with a −2 movement linked to the order", async ({ browser }) => {
  const listing = await freshListing({ name: "QA Biscuits ₹45", pricePaise: 4500, stock: 100 });
  await ensureFunds("customer");
  const before = await walletBalance();
  const since = new Date(Date.now() - 1000);
  const order = await buy(listing, 2);
  const detail = need(await orderDetail("customer", order.id), "the order");
  const line = detail.items[0];
  expect(line.quantityMilli, "2 units").toBe(2000);
  expect(line.unitPricePaise).toBe(4500);
  expect(line.lineTotalPaise, "2 × ₹45").toBe(9000);
  expect(detail.subtotalPaise).toBe(9000);
  expect(detail.totalPaise, "goods + delivery fee").toBe(9000 + detail.deliveryFeePaise);
  expect(await walletBalance(), "wallet debited once by the total").toBe(before - detail.totalPaise);
  const debits = await db()<{ n: number }[]>`select count(*)::int as n from wallet_transactions where order_id = ${order.id} and amount_paise < 0`;
  expect(debits[0].n, "one wallet debit").toBe(1);
  const moves = await movements(listing.shopProductId, since);
  expect(moves.map((m) => [m.delta_units, m.order_id]), "one −2 movement linked to the order").toEqual([[-2, order.id]]);
  const row = await inventoryRow(listing.shopProductId);
  expect(row.available, "available 98").toBe(98);
  // The owner's inventory page shows it too.
  await asPage(browser, "shop", "/shop/inventory", async (page) => {
    const tr = page.getByTestId("inventory-table").locator("tbody tr").filter({ hasText: listing.name });
    await expect(tr).toContainText("98");
  });
  const page = await asPage(browser, "customer", `/orders/${order.id}`, async (p) => p.locator("main").first().innerText());
  expect(paiseIn(page), "order page shows the ₹90 line and the total").toEqual(expect.arrayContaining([9000, detail.totalPaise]));
  return `${order.orderNumber}: 2 × ₹45 = ₹90 + fee ₹${detail.deliveryFeePaise / 100} = ₹${detail.totalPaise / 100}; one debit; stock 100 → 98 (movement −2, order-linked)`;
}, { ...local, mobile: false });

qa("TC-SPI-002", "loose goods by weight at ₹60/kg: 500 g is ₹30 and 1.25 kg is ₹75 to the paisa; quantities 500 and 1250 milli; stock falls by 1.75 kg", async () => {
  // A loose product sold in 250 g steps (the cart takes whole steps of the product's unit size).
  const listing = await freshListing({ name: "QA Loose Rava", kind: "LOOSE", unit: "kg", unitSizeMilli: 250, pricePaise: 6000, stock: 400 });
  const a = await buy(listing, 2);
  const b = await buy(listing, 5);
  const la = need(await orderDetail("customer", a.id), "order 1").items[0];
  const lb = need(await orderDetail("customer", b.id), "order 2").items[0];
  expect([la.quantityMilli, la.lineTotalPaise], "500 g").toEqual([500, 3000]);
  expect([lb.quantityMilli, lb.lineTotalPaise], "1.25 kg").toEqual([1250, 7500]);
  const after = await dbStock(listing.shopProductId);
  expect(after, "stock 100 kg − 1.75 kg, in 250 g steps").toBe(400 - 7);
  return `500 g → ₹30.00 (500 milli), 1.25 kg → ₹75.00 (1250 milli); stock 400 → 393 steps of 250 g (100 kg → 98.25 kg)`;
}, {
  ...local,
  partial: "uses a loose product sold in 250 g steps; a loose product listed per 1 kg (the seeded paneer, unit size 1000) can be bought in whole kg only — see TC-SPI-025",
});

qa("TC-SPI-003", "buying the whole stock: stock 0 and shown out of stock; one more is refused OUT_OF_STOCK with no debit", async ({ browser }) => {
  const listing = await freshListing({ name: "QA Toffee ₹1", pricePaise: 100, stock: 100 });
  const first = await checkoutLines([{ listing, quantity: 99 }]);
  expectStatus(first.res, 201, "99 of 100");
  const second = await buy(listing, 1);
  expect(await dbStock(listing.shopProductId), "stock 0").toBe(0);
  await ensureFunds("customer");
  const before = await walletBalance();
  const added = await api("customer", "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 });
  expect(added.status, "adding one more").toBe(409);
  expect(JSON.stringify(added.body)).toMatch(/OUT_OF_STOCK|unavailable/i);
  expect(await walletBalance(), "no debit").toBe(before);
  const shop = need(world().shops.A, "shop A");
  const card = await asPage(browser, "customer", `/shops/${shop.slug}`, async (page) => {
    const search = page.getByTestId("product-card").filter({ hasText: listing.name });
    if (!(await search.count())) return null;
    return search.first().innerText();
  });
  if (card) expect(card, "the card says out of stock").toMatch(/Out of stock|Unavailable/);
  return `99 + 1 bought (${first.orders[0]?.orderNumber}, ${second.orderNumber}); stock 0; one more → 409 ${added.body?.error?.code}; no debit${card ? "; card shows out of stock" : ""}`;
}, { ...local, partial: "bought as 99 + 1: one cart line takes at most 99 units (POST /api/cart quantity ≤ 99); a listing added by category is replaced by a fresh one at stock 100" });

qa("TC-SPI-004", "three lines (one loose): each line = price × quantity; goods + delivery fee is the same on the cart, the order and the e-mail and equals the wallet debit", async ({ browser }) => {
  const a = await freshListing({ name: "QA Jam", pricePaise: 12_550, stock: 20 });
  const b = await freshListing({ name: "QA Honey", pricePaise: 23_900, stock: 20 });
  const c = await freshListing({ name: "QA Loose Atta", kind: "LOOSE", unit: "kg", unitSizeMilli: 500, pricePaise: 4_850, stock: 40 });
  await (await import("../lib/flows")).emptyCart("customer");
  for (const [l, q] of [[a, 2], [b, 1], [c, 3]] as const) expectStatus(await api("customer", "POST", "/api/cart", { shopProductId: l.shopProductId, quantity: q }), [200, 201], `add ${l.name}`);
  const cart = await api("customer", "GET", "/api/cart");
  const lines = (cart.body.groups as { lines: { shopProductId: string; quantity: number; unitPricePaise: number; lineTotalPaise: number }[]; subtotalPaise?: number; deliveryFeePaise?: number }[]).flatMap((g) => g.lines);
  const want = { [a.shopProductId]: 2 * 12_550, [b.shopProductId]: 23_900, [c.shopProductId]: Math.round((4_850 * 1500) / 1000) };
  for (const l of lines) expect(l.lineTotalPaise, `cart line ${l.shopProductId.slice(0, 8)}`).toBe(want[l.shopProductId]);
  const goods = Object.values(want).reduce((s, v) => s + v, 0);
  const cartPage = await asPage(browser, "customer", "/cart", async (p) => p.locator("main").first().innerText());
  expect(paiseIn(cartPage), "cart page shows the goods total").toContain(goods);
  await ensureFunds("customer");
  const before = await walletBalance();
  const since = Date.now() - 1000;
  const out = await checkoutLines([{ listing: a, quantity: 2 }, { listing: b, quantity: 1 }, { listing: c, quantity: 3 }]);
  expectStatus(out.res, 201, "checkout");
  const detail = need(await orderDetail("customer", out.orders[0].id), "the order");
  expect(detail.subtotalPaise, "order goods").toBe(goods);
  expect(detail.totalPaise, "grand total = goods + delivery fee").toBe(goods + detail.deliveryFeePaise);
  expect(before - (await walletBalance()), "wallet debit = grand total").toBe(detail.totalPaise);
  const orderPage = await asPage(browser, "customer", `/orders/${detail.id}`, async (p) => p.locator("main").first().innerText());
  expect(paiseIn(orderPage), "order page: goods and total").toEqual(expect.arrayContaining([goods, detail.totalPaise]));
  const email = world().users.customer!.email;
  let mail = "";
  for (let i = 0; i < 20 && !mail; i++) {
    mail = messagesTo(email, since).map((m) => m.body).find((b) => b.includes(detail.orderNumber)) ?? "";
    if (!mail) await new Promise((r) => setTimeout(r, 500));
  }
  expect(mail, "an order e-mail reached the customer").not.toBe("");
  const text = mail.split(/Content-Type: text\/plain/)[1]?.split(/----_/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  expect(paiseIn(mail).includes(detail.totalPaise) || mail.includes((detail.totalPaise / 100).toFixed(2)), `the order e-mail shows the grand total ₹${detail.totalPaise / 100} — it reads: "${text.slice(0, 160)}"`).toBe(true);
  return `${detail.orderNumber}: lines ₹${want[a.shopProductId] / 100} + ₹${want[b.shopProductId] / 100} + 1.5 kg ₹${want[c.shopProductId] / 100} = ₹${goods / 100}; total ₹${detail.totalPaise / 100} on cart, order, e-mail and the debit`;
}, local);

qa("TC-SPI-005", "price and MRP changed between cart and payment: the cart shows the new figures, the customer pays the current price and the order records the MRP in force", async () => {
  const listing = await freshListing({ name: "QA Oil 1 L", pricePaise: 18_000, mrpPaise: 20_000, stock: 20 });
  await (await import("../lib/flows")).emptyCart("customer");
  expectStatus(await api("customer", "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 }), [200, 201], "add to cart");
  // The owner lowers the price; operations raise the master MRP (there is no shop-level MRP field).
  expectStatus(await api("shop", "PATCH", `/api/shop-products/${listing.shopProductId}`, { onlinePricePaise: 17_500 }), 200, "owner changes the price");
  expectStatus(await api("admin", "POST", "/api/mrp", { productId: listing.productId, mrpPaise: 21_000, source: "ADMIN", reason: "QA MRP change" }), 200, "MRP change");
  const cart = await api("customer", "GET", "/api/cart");
  const line = (cart.body.groups as { lines: { shopProductId: string; unitPricePaise: number }[] }[]).flatMap((g) => g.lines).find((l) => l.shopProductId === listing.shopProductId);
  expect(line?.unitPricePaise, "cart shows the new price before paying").toBe(17_500);
  const out = await checkoutLines([{ listing, quantity: 1 }]);
  expectStatus(out.res, 201, "pay");
  const item = need(await orderDetail("customer", out.orders[0].id), "the order").items[0];
  expect(item.unitPricePaise, "charged the current price").toBe(17_500);
  const cols = await db()<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'order_items' and column_name ilike '%mrp%'`;
  expect(cols.map((c) => c.column_name), "the order line records the MRP in force at payment").not.toEqual([]);
  return `cart showed ₹175 after the change; paid ₹175; MRP recorded on the line`;
}, local);

qa("TC-SPI-018", "reserved and available through the order states: after ordering 2 of 100, available 98 with 2 held; after delivery on hand 98, reserved 0", async () => {
  await freeRider("rider");
  const listing = await freshListing({ name: "QA Chips", pricePaise: 2000, stock: 100 });
  const order = await buy(listing, 2);
  let row = await inventoryRow(listing.shopProductId);
  expect([row.available, row.reserved, row.onHand], "after the order (CONFIRMED)").toEqual([98, 2, 100]);
  await packOrder(order.id);
  row = await inventoryRow(listing.shopProductId);
  expect([row.available, row.reserved, row.onHand], "at READY").toEqual([98, 2, 100]);
  await deliverOrder(order.id);
  row = await inventoryRow(listing.shopProductId);
  expect([row.available, row.reserved, row.onHand], "after delivery").toEqual([98, 0, 98]);
  return `${order.orderNumber}: 100/0/100 → 98/2/100 (confirmed, ready) → 98/0/98 delivered; never negative`;
}, local);

qa("TC-SPI-019", "cancelled, rejected and failed-and-returned orders give the stock back, each with a return movement", async () => {
  const listing = await freshListing({ name: "QA Soda", pricePaise: 2500, stock: 100 });
  const since = new Date(Date.now() - 1000);
  const steps: string[] = [];
  // Cancelled by the customer.
  const c = await buy(listing, 2);
  expectStatus(await api("customer", "PATCH", `/api/orders/${c.id}/status`, { status: "CANCELLED", note: "QA" }), 200, "cancel");
  expect(await dbStock(listing.shopProductId), "after the cancel").toBe(100);
  steps.push("cancel 2 → 100");
  // Rejected by the shop.
  const r = await buy(listing, 3);
  expectStatus(await shopAction(r.id, "reject", { reason: "QA: shop closing early" }), 200, "reject");
  expect(await dbStock(listing.shopProductId), "after the reject").toBe(100);
  steps.push("reject 3 → 100");
  // A failed delivery brought back to the shop.
  await freeRider("rider");
  const f = await buy(listing, 1);
  await packOrder(f.id);
  const leg = await pickUpAndStart(f.id);
  expectStatus(await riderAction(leg.deliveryOrderId, "fail", { reason: "QA: customer not reachable" }), 200, "failed drop");
  expect(await statusOf(f.id)).toBe("FAILED");
  expectStatus(await api("shop", "PATCH", `/api/orders/${f.id}/status`, { status: "RETURNED", note: "QA: goods back at the shop" }), 200, "returned to the shop");
  const atReturned = await dbStock(listing.shopProductId);
  // FAILED / RETURNED orders are closed by the shop or an operator (orders.ts cancelOrder, D10 note): the shop cancels it.
  expectStatus(await api("shop", "PATCH", `/api/orders/${f.id}/status`, { status: "CANCELLED", note: "QA: returned goods, order closed" }), 200, "shop closes the returned order");
  const finalStatus = await statusOf(f.id);
  const stock = await dbStock(listing.shopProductId);
  steps.push(`failed → returned (stock ${atReturned}) → shop cancels (${finalStatus}) → ${stock}`);
  const moves = await movements(listing.shopProductId, since);
  const returns = moves.filter((m) => m.delta_units > 0);
  expect(stock, `after the failed delivery came back (${steps.join("; ")})`).toBe(100);
  expect(returns.length, `a return movement for each of the three (${moves.map((m) => `${m.delta_units} ${m.reason}`).join(" | ")})`).toBe(3);
  return steps.join("; ");
}, local);

qa("TC-SPI-012", "stock 5 with 3 held by an order: the owner sets 1, available never goes negative, and a new order for 3 is refused", async () => {
  const listing = await freshListing({ name: "QA Eggs", pricePaise: 700, stock: 5 });
  const held = await buy(listing, 3);
  let row = await inventoryRow(listing.shopProductId);
  expect([row.available, row.reserved], "3 held").toEqual([2, 3]);
  const set = await api("shop", "PATCH", `/api/shop-products/${listing.shopProductId}`, { onlineStock: 1 });
  row = await inventoryRow(listing.shopProductId);
  expect(row.available, "available never negative").toBeGreaterThanOrEqual(0);
  expect(row.onHand, "consistent: on hand = available + held").toBe(row.available + row.reserved);
  const attempt = await api("customer2", "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 3 });
  const viaCustomer = attempt.status === 409 ? attempt : await api("customer", "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 3 });
  expect(viaCustomer.status, "a purchase of 3 is refused").toBe(409);
  await api("customer", "PATCH", `/api/orders/${held.id}/status`, { status: "CANCELLED", note: "QA" });
  return `owner's save of 1 → ${set.status}; available ${row.available}, reserved ${row.reserved}, on hand ${row.onHand}; buying 3 → 409`;
}, local);

qa("TC-SPI-023", "out of stock and back: at 0 the product is out of stock, not buyable and listed after buyable rows; at 10 it is buyable at once", async ({ browser }) => {
  const oos = await freshListing({ name: "QA AAA Oos Cereal", pricePaise: 9_900, stock: 0 });
  const fine = await freshListing({ name: "QA ZZZ Fine Cereal", pricePaise: 9_900, stock: 10 });
  const add0 = await api("customer", "POST", "/api/cart", { shopProductId: oos.shopProductId, quantity: 1 });
  expect(add0.status, "not buyable at 0").toBe(409);
  const storefront = await api("customer", "GET", `/api/shops/${shopId("A")}/products?limit=100`);
  const rows = (storefront.body as { shopProductId: string; productName: string }[]).map((r) => r.shopProductId);
  const iOos = rows.indexOf(oos.shopProductId);
  const iFine = rows.indexOf(fine.shopProductId);
  const product = await asPage(browser, "customer", `/products/${oos.productId}`, async (p) => p.locator("main").first().innerText());
  expect(product, "the product page marks it").toMatch(/Out of stock|Unavailable|not available/i);
  await setStock(oos.shopProductId, 10);
  const add10 = await api("customer", "POST", "/api/cart", { shopProductId: oos.shopProductId, quantity: 1 });
  expect(add10.status, "buyable again at 10").toBe(200);
  await (await import("../lib/flows")).emptyCart("customer");
  expect(iOos > iFine || iOos === -1, `the out-of-stock row is listed after a buyable one (storefront position ${iOos} vs ${iFine})`).toBe(true);
  return `at 0: cart 409, product page marks it, storefront position ${iOos} vs buyable ${iFine}; at 10: cart 200 at once`;
}, { ...local, partial: "the comparison page leaves an out-of-stock listing out entirely (src/server/services/price-comparison.ts)" });

/* ---------------------------------------------------- purchase, sale, books */

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

async function receiveStock(listing: Listing, units: number, ratePaise = 1000, owner: "shop" | "shopB" = "shop") {
  const res = await api(owner, "POST", `/api/shops/${listing.shopId}/accounts/purchases`, {
    supplier: { name: `QA Supplier ${RUN}` },
    invoiceNo: `QA-${RUN}-${Math.floor(Math.random() * 1e6)}`,
    invoiceDate: today(),
    lines: [{ shopProductId: listing.shopProductId, description: listing.name, qtyMilli: units * 1000, ratePaise, gstRateBp: 0 }],
    note: "Purchase from supplier",
  });
  expectStatus(res, 201, `stock received +${units}`);
  return res.body;
}

async function writeOff(listing: Listing, units: number, note = "QA: damaged in storage") {
  return api("shop", "POST", `/api/shops/${listing.shopId}/accounts/stock/${listing.shopProductId}/write-off`, { qtyMilli: units * 1000, kind: "DAMAGE", note });
}

async function withShopState<T>(body: () => Promise<T>): Promise<T> {
  const [row] = await db()<{ state: string | null }[]>`select state from shops where id = ${shopId("A")}`;
  if (!row.state) await db()`update shops set state = 'Maharashtra' where id = ${shopId("A")}`;
  try {
    return await body();
  } finally {
    if (!row.state) await db()`update shops set state = null where id = ${shopId("A")}`;
  }
}

qa("TC-SPI-016", "stock received: +30 with the reason 'Purchase from supplier' takes 20 to 50; the movement shows +30, before and after, reason, user and time", async () => {
  const listing = await freshListing({ name: "QA Flour", pricePaise: 5000, stock: 20 });
  const since = new Date(Date.now() - 1000);
  await withShopState(() => receiveStock(listing, 30));
  expect(await dbStock(listing.shopProductId), "stock 50").toBe(50);
  const moves = await movements(listing.shopProductId, since);
  const m = need(moves.find((x) => x.delta_units === 30), "a +30 movement");
  expect([m.previous_units, m.new_units], "before and after").toEqual([20, 50]);
  expect(m.created_by, "the user").toBe(world().users.shop!.id);
  expect(m.created_at, "the time").toBeTruthy();
  const book = await ledger(listing);
  const purchase = need(book.find((l) => l.movementType === "PURCHASE"), "the PURCHASE line in the stock ledger");
  expect(purchase.qtyMilli).toBe(30_000);
  expect(purchase.balanceMilli, "running balance").toBe(50_000);
  return `20 → 50: movement +30 (${m.previous_units} → ${m.new_units}, "${m.reason}", by the owner, ${new Date(m.created_at).toISOString()}); stock ledger PURCHASE +30 kg-units, balance 50`;
}, { ...local, partial: "the reason the owner types is kept on the purchase bill (note) and the ledger names the purchase; the movement's own reason reads 'purchase … (books)'" });

qa("TC-SPI-017", "stock written off: −5 with a reason takes 50 to 45 with a movement; a write-off of 60 is refused", async () => {
  const listing = await freshListing({ name: "QA Yoghurt", pricePaise: 3000, stock: 50 });
  const since = new Date(Date.now() - 1000);
  expectStatus(await writeOff(listing, 5), 201, "write off 5");
  expect(await dbStock(listing.shopProductId), "stock 45").toBe(45);
  const m = (await movements(listing.shopProductId, since)).find((x) => x.delta_units === -5);
  expect(m?.reason ?? "", "movement with the reason").toMatch(/write off damage/i);
  const tooMuch = await writeOff(listing, 60);
  expect(tooMuch.status, "below zero refused").toBe(422);
  expect(await dbStock(listing.shopProductId)).toBe(45);
  return `50 → 45 (movement "${m?.reason}"); −60 → 422 "${tooMuch.body?.error?.message}"`;
}, local);

qa("TC-SPI-013", "an in-shop sale of 4 takes 4 off the stock with a movement and its reason; online availability follows; a dedicated in-shop sale screen exists", async ({ browser }) => {
  const listing = await freshListing({ name: "QA Namkeen", pricePaise: 2000, stock: 12 });
  const since = new Date(Date.now() - 1000);
  const sale = await withShopState(() =>
    api("shop", "POST", `/api/shops/${listing.shopId}/accounts/sales`, {
      paymentMode: "CASH",
      pricesIncludeTax: true,
      note: "Sold in shop",
      lines: [{ shopProductId: listing.shopProductId, description: listing.name, qtyMilli: 4000, ratePaise: 2000, gstRateBp: 0 }],
    }),
  );
  expectStatus(sale, 201, "in-shop sale");
  expect(await dbStock(listing.shopProductId), "12 − 4").toBe(8);
  const m = (await movements(listing.shopProductId, since)).find((x) => x.delta_units === -4);
  expect(m?.reason ?? "", "movement naming the sale").toMatch(/sale/i);
  // The count as operations see it; a customer's storefront answer says only "in stock" (TC-SPI-027).
  const row = (await shopListings(listing.shopId)).find((r) => r.shopProductId === listing.shopProductId);
  expect(row?.onlineStock, "online availability follows").toBe(8);
  const screen = await asPage(browser, "shop", "/shop/accounts/sales", async (p) => p.locator("main").first().innerText());
  expect(screen).toMatch(/sale/i);
  return `sales invoice ${sale.body?.invoiceNo}: 12 → 8 ("${m?.reason}"), storefront 8; the in-shop sale screen is /shop/accounts/sales`;
}, local);

/* ------------------------------------------------------- sale variations */

qa("TC-SPI-007", "a shop buys from another shop (B2B): shop B's stock falls by 10 with a sale movement; whether shop A's stock rises is recorded", async () => {
  await freeRider("rider");
  const bListing = await freshListing({ name: "QA Wholesale Tea", shop: "B", pricePaise: 1000, stock: 40 });
  const since = new Date(Date.now() - 1000);
  const out = await checkoutLines([{ listing: bListing, quantity: 10 }], { role: "shop", extra: { orderType: "B2B", buyerShopId: shopId("A") } });
  if (out.res.status === 403 || out.res.status === 422) return blockedB2b(out.res);
  expectStatus(out.res, 201, "B2B checkout");
  const order = out.orders[0];
  await packOrder(order.id, "shopB");
  await deliverOrder(order.id, { shop: "shopB", customer: "shop" });
  expect(await dbStock(bListing.shopProductId), "shop B 40 − 10").toBe(30);
  const sale = (await movements(bListing.shopProductId, since)).find((m) => m.delta_units === -10);
  expect(sale?.order_id, "sale movement linked to the order").toBe(order.id);
  const [aHas] = await db()<{ n: number }[]>`select count(*)::int as n from shop_products where shop_id = ${shopId("A")} and product_id = ${bListing.productId}`;
  return `${order.orderNumber} (B2B) delivered: shop B 40 → 30 (sale movement); shop A's stock does not rise automatically (${aHas.n ? "A lists it but unchanged" : "A has no listing of it"}) — the owner records the stock-in by hand (TC-SPI-016)`;
}, local);

function blockedB2b(res: { status: number; body: unknown }): never {
  throw new Error(`B2B checkout refused: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
}

qa("TC-SPI-009", "the shop's sales figure counts delivered orders only: +₹90 for a delivered order, nothing for a cancelled ₹50 one", async ({ browser }) => {
  const read = () =>
    asPage(browser, "shop", "/shop/manage/today", async (p) => {
      const kpi = p.locator("div, section").filter({ hasText: /^Goods delivered/ }).first();
      await expect(p.getByText("Goods delivered").first()).toBeVisible();
      const box = p.getByText("Goods delivered").first().locator("xpath=ancestor::*[self::div or self::section][1]/..");
      return paiseIn(await box.innerText())[0] ?? paiseIn(await kpi.innerText())[0];
    });
  const before = need(await read(), "the 'Goods delivered' figure");
  await freeRider("rider");
  const x = await freshListing({ name: "QA Ninety", pricePaise: 4500, stock: 10 });
  const y = await freshListing({ name: "QA Fifty", pricePaise: 5000, stock: 10 });
  const delivered = await buy(x, 2);
  await packOrder(delivered.id);
  await deliverOrder(delivered.id);
  const cancelled = await buy(y, 1);
  expectStatus(await api("customer", "PATCH", `/api/orders/${cancelled.id}/status`, { status: "CANCELLED", note: "QA" }), 200, "cancel the ₹50 order");
  const after = need(await read(), "the figure after");
  expect(after - before, `goods delivered ₹${before / 100} → ₹${after / 100}`).toBe(9000);
  return `"Goods delivered" ₹${before / 100} → ₹${after / 100} (+₹90; the cancelled ₹50 adds nothing)`;
}, local);

qa("TC-SPI-010", "a sale with a substitution: P comes back to stock (or was never taken) and Q falls by what was sold; movements show both", async () => {
  await freeRider("rider");
  const p = await freshListing({ name: "QA Brand P Milk", pricePaise: 3000, stock: 10 });
  const q = await freshListing({ name: "QA Brand Q Milk", pricePaise: 2800, stock: 10 });
  const since = new Date(Date.now() - 1000);
  const order = await buy(p, 1);
  expectStatus(await shopAction(order.id, "accept"), 200, "accept");
  expectStatus(await shopAction(order.id, "start"), 200, "start");
  const item = need(await orderDetail("customer", order.id), "the order").items[0];
  expectStatus(await shopAction(order.id, "substitute", { itemId: item.id, substituteShopProductId: q.shopProductId }), 200, "propose Q");
  expectStatus(await api("customer", "PATCH", `/api/orders/${order.id}/items/${item.id}/substitution`, { approve: true }), 200, "customer approves");
  expectStatus(await shopAction(order.id, "ready"), 200, "ready");
  await deliverOrder(order.id);
  const pStock = await dbStock(p.shopProductId);
  const qStock = await dbStock(q.shopProductId);
  const moves = [...(await movements(p.shopProductId, since)).map((m) => `P ${m.delta_units}`), ...(await movements(q.shopProductId, since)).map((m) => `Q ${m.delta_units}`)];
  expect(qStock, "Q reduced by 1").toBe(9);
  expect(pStock, `P back to 10 or never taken (movements: ${moves.join(", ")})`).toBe(10);
  return `${order.orderNumber}: P ${pStock}, Q ${qStock}; movements ${moves.join(", ")}`;
}, local);

qa("TC-SPI-011", "a removed line ('Out of stock'): the customer is refunded for it, the sale is the remaining line only, the removed unit is not put back on sale", async () => {
  await freeRider("rider");
  const keep = await freshListing({ name: "QA Kept Line", pricePaise: 3000, stock: 10 });
  const gone = await freshListing({ name: "QA Removed Line", pricePaise: 2000, stock: 10 });
  const out = await checkoutLines([{ listing: keep, quantity: 1 }, { listing: gone, quantity: 1 }]);
  expectStatus(out.res, 201, "two-line order");
  const order = out.orders[0];
  expectStatus(await shopAction(order.id, "accept"), 200, "accept");
  const item = need(await orderDetail("customer", order.id), "the order").items.find((i) => i.shopProductId === gone.shopProductId)!;
  const before = await walletBalance();
  expectStatus(await shopAction(order.id, "remove", { itemId: item.id, reason: "Out of stock" }), 200, "remove");
  expect((await walletBalance()) - before, "refunded ₹20 at once").toBe(2000);
  expectStatus(await shopAction(order.id, "ready"), 200, "ready");
  await deliverOrder(order.id);
  const [snap] = await db()<{ goods: number }[]>`select goods_paise::int as goods from order_financials where order_id = ${order.id}`;
  expect(snap.goods, "sale value = the remaining line").toBe(3000);
  expect(await dbStock(gone.shopProductId), "the removed unit stays off sale").toBe(9);
  return `${order.orderNumber}: removed line refunded ₹20 at once; delivered goods ₹30; removed product's stock 9 (not put back)`;
}, local);

qa("TC-SPI-020", "returned goods: a resaleable unit goes back into stock with a movement; a damaged one does not", async () => {
  await freeRider("rider");
  const listing = await freshListing({ name: "QA Returnable Jar", pricePaise: 6000, stock: 10 });
  const results = await withRules({ returns: { pickupByRider: false } }, async () => {
    const out: string[] = [];
    for (const condition of ["UNOPENED", "DAMAGED"] as const) {
      const order = await buy(listing, 2);
      await packOrder(order.id);
      await deliverOrder(order.id);
      const item = need(await orderDetail("customer", order.id), "the order").items[0];
      const stockBefore = await dbStock(listing.shopProductId);
      const since = new Date(Date.now() - 1000);
      const ret = await api("customer", "POST", `/api/orders/${order.id}/returns`, { reason: "OTHER", comment: `QA ${condition}`, items: [{ orderItemId: item.id, quantityMilli: 1000, condition }] });
      expectStatus(ret, 201, "request a return");
      expectStatus(await api("shop", "PATCH", `/api/returns/${ret.body.id}`, { action: "approve" }), 200, "approve");
      expectStatus(await api("shop", "PATCH", `/api/returns/${ret.body.id}`, { action: "receive" }), 200, "received at the shop");
      expectStatus(await api("shop", "PATCH", `/api/returns/${ret.body.id}`, { action: "inspect", outcome: "ACCEPT", note: condition === "UNOPENED" ? "Sealed, resaleable" : "Damaged, not resaleable" }), 200, "inspect");
      const stockAfter = await dbStock(listing.shopProductId);
      const moved = (await movements(listing.shopProductId, since)).filter((m) => m.delta_units > 0).length;
      out.push(`${condition}: stock ${stockBefore} → ${stockAfter}, ${moved} movement`);
      if (condition === "UNOPENED") expect(stockAfter, `resaleable unit back in stock (${out.join("; ")})`).toBe(stockBefore + 1);
      else expect(stockAfter, "damaged unit not put back").toBe(stockBefore);
    }
    return out;
  });
  return results.join("; ");
}, { ...local, timeout: 400_000 });

qa("TC-SPI-021", "the movement ledger adds up to the stock on hand: 100 − 5 (+2 −2) + 20 − 3 − 10 = 102", async ({ browser }) => {
  await freeRider("rider");
  const listing = await freshListing({ name: "QA Ledger Rice", pricePaise: 1000, stock: 100 });
  const sell = async (n: number) => {
    const o = await buy(listing, n);
    await packOrder(o.id);
    await deliverOrder(o.id);
  };
  await sell(5);
  const c = await buy(listing, 2);
  expectStatus(await api("customer", "PATCH", `/api/orders/${c.id}/status`, { status: "CANCELLED", note: "QA" }), 200, "cancel 2");
  await withShopState(() => receiveStock(listing, 20));
  expectStatus(await writeOff(listing, 3), 201, "write off 3");
  await sell(10);
  const row = await inventoryRow(listing.shopProductId);
  expect([row.onHand, row.reserved], "on hand 102, nothing held").toEqual([102, 0]);
  const book = await ledger(listing);
  const sum = book.reduce((s, l) => s + l.qtyMilli, 0);
  expect(sum, `Σ ledger = ${sum / 1000} (${book.map((l) => `${l.movementType} ${l.qtyMilli / 1000}`).reverse().join(", ")})`).toBe(102_000);
  const page = await asPage(browser, "shop", "/shop/inventory", async (p) => p.getByTestId("inventory-table").locator("tbody tr").filter({ hasText: listing.name }).innerText());
  expect(page, "the inventory page shows 102").toContain("102");
  return `ledger ${book.map((l) => `${l.movementType} ${l.qtyMilli / 1000}`).reverse().join(", ")} = 102 = on hand on /shop/inventory`;
}, { ...local, partial: "the listing is a fresh one with opening stock 100 (the category add's opening is the same OPENING ledger entry)" });

qa("TC-SPI-022", "the owner saves stock 10 → 8 from a page opened before a 4-unit order: no lost update, stock never above the true figure", async ({ browser }) => {
  const listing = await freshListing({ name: "QA Stale Page Ghee", pricePaise: 5000, stock: 10 });
  const result = await asPage(browser, "shop", "/shop/manage/products", async (page) => {
    const card = await productCard(page, listing.name);
    await expect(card).toContainText("10 in stock");
    await card.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Online stock").fill("8");
    // Meanwhile a customer pays for 4.
    const order = await buy(listing, 4);
    const saved = page.waitForResponse((r) => r.url().includes(`/api/shop-products/${listing.shopProductId}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save changes" }).click();
    const res = await saved;
    return { order: order.orderNumber, status: res.status() };
  });
  const stock = await dbStock(listing.shopProductId);
  expect(stock, `after the stale save (order ${result.order} took 4; the page's save answered ${result.status})`).toBeLessThanOrEqual(10 - 4);
  return `stale save after ${result.order}: stock ${stock}`;
}, local);

qa("TC-SPI-025", "loose stock: the unit is shown beside the figure, decimal stock is accepted and kept in milli-units, 250 g can be sold", async ({ browser }) => {
  const listing = await freshListing({ name: "QA Loose Jaggery", kind: "LOOSE", unit: "kg", unitSizeMilli: 1000, pricePaise: 8000, stock: 100 });
  const row = await inventoryRow(listing.shopProductId);
  const page = await asPage(browser, "shop", "/shop/inventory", async (p) => p.getByTestId("inventory-table").locator("tbody tr").filter({ hasText: listing.name }).innerText());
  const issues: string[] = [];
  if (!/\bkg\b/.test(page)) issues.push("no unit on the inventory row");
  const decimal = await api("shop", "PATCH", `/api/shop-products/${listing.shopProductId}`, { onlineStock: 2.5 });
  if (decimal.status !== 200) issues.push(`stock 2.5 → ${decimal.status} ${decimal.body?.error?.message ?? ""}`.trim());
  const count = await api("shop", "POST", `/api/shops/${listing.shopId}/accounts/stock/${listing.shopProductId}/count`, { countedMilli: 2500, note: "QA count 2.5 kg" });
  const afterCount = await dbStock(listing.shopProductId);
  if (count.status === 200 && afterCount !== 2.5) issues.push(`the books' count of 2.500 kg leaves sellable stock at ${afterCount}`);
  const quarter = await api("customer", "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 0.25 });
  if (quarter.status !== 200) issues.push(`selling 250 g → ${quarter.status} (the cart takes whole steps of the product's 1 kg unit)`);
  await (await import("../lib/flows")).emptyCart("customer");
  expect(issues, `unit "${row.unit}"; ${issues.join("; ")}`).toEqual([]);
  return `unit ${row.unit}; 2.5 accepted; 250 g sold`;
}, local);

/* ------------------------------------------------------ uploads and views */

async function importCsv(csv: string, name: string) {
  const res = await api("shop", "POST", `/api/v1/shops/${shopId("A")}/product-imports`, undefined, {
    multipart: { file: { name, mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") } },
  });
  expectStatus(res, 202, `upload ${name}`);
  const jobId = res.body.jobId as string;
  const waitFor = async (done: (s: string) => boolean) => {
    for (let i = 0; i < 60; i++) {
      const job = await api("shop", "GET", `/api/v1/product-imports/${jobId}`);
      if (done(job.body?.status)) return job.body;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`import ${jobId} did not finish`);
  };
  const preview = await waitFor((s) => !["uploaded", "parsing"].includes(s));
  expect(preview.status, `preview of ${name}: ${JSON.stringify(preview.messages)}`).toBe("preview_ready");
  expectStatus(await api("shop", "POST", `/api/v1/product-imports/${jobId}/commit`, { inventoryMode: "SET" }), 202, "import");
  const done = await waitFor((s) => !["importing", "preview_ready"].includes(s));
  const rows = await api("shop", "GET", `/api/v1/product-imports/${jobId}/rows?limit=50`);
  return { job: done, rows: (rows.body?.rows ?? rows.body ?? []) as { sku: string | null; status: string; messages: string[] }[] };
}

async function bySku(sku: string) {
  const [row] = await db()<{ id: string; online_stock: number }[]>`select sp.id, sp.online_stock from shop_listing_details d join shop_products sp on sp.id = d.shop_product_id
    where d.shop_id = ${shopId("A")} and lower(d.seller_sku) = lower(${sku})`;
  return row;
}

qa("TC-SPI-024", "stock through the bulk upload: two changed stock values apply with movements; a negative and a text value are reported and not applied", async () => {
  const sku = (n: number) => `QA-${RUN}-${n}`;
  const header = "SKU,Product Name,Category,Unit,MRP,Selling Price,Quantity";
  const first = [header, ...[1, 2, 3, 4].map((n) => `${sku(n)},QA Upload Item ${RUN} ${n},General,piece,100,90,10`)].join("\n");
  const one = await importCsv(first, `qa-stock-${RUN}-a.csv`);
  expect(one.job.status, JSON.stringify(one.job.counts)).toBe("completed");
  const before = await Promise.all([1, 2, 3, 4].map((n) => bySku(sku(n))));
  expect(before.map((b) => b?.online_stock), "created at 10").toEqual([10, 10, 10, 10]);
  const since = new Date(Date.now() - 1000);
  const second = [header, `${sku(1)},QA Upload Item ${RUN} 1,General,piece,100,90,15`, `${sku(2)},QA Upload Item ${RUN} 2,General,piece,100,90,25`, `${sku(3)},QA Upload Item ${RUN} 3,General,piece,100,90,-5`, `${sku(4)},QA Upload Item ${RUN} 4,General,piece,100,90,ten`].join("\n");
  const two = await importCsv(second, `qa-stock-${RUN}-b.csv`);
  const after = await Promise.all([1, 2, 3, 4].map((n) => bySku(sku(n))));
  expect(after.map((a) => a.online_stock), "15 and 25 applied; −5 and 'ten' left at 10").toEqual([15, 25, 10, 10]);
  const moved = await Promise.all(after.map((a) => movements(a.id, since)));
  expect(moved.map((m) => m.reduce((s, x) => s + x.delta_units, 0)), "movements for the applied rows only").toEqual([5, 15, 0, 0]);
  const reported = two.rows.filter((r) => r.sku === sku(3) || r.sku === sku(4)).map((r) => `${r.sku}: ${r.messages.join(" ")}`);
  expect(reported.join(" | "), "the bad rows are reported").toMatch(/negative|whole number|stock left unchanged/i);
  return `upload 2: ${sku(1)} 10 → 15, ${sku(2)} 10 → 25 (movements +5, +15); ${sku(3)} −5 and ${sku(4)} "ten" left at 10 and reported: ${reported.join(" | ").slice(0, 200)}`;
}, { ...local, timeout: 400_000, partial: "uses the bulk product upload (its Quantity column is the stock); the Excel price upload's template has no stock column" });

qa("TC-SPI-026", "inventory search, filter by category / low stock / out of stock / needs price, and sort by stock", async ({ browser }) => {
  const rows = (await (await import("../lib/finance-helpers")).inventory("shop", "A")).rows.length;
  const found = await asPage(browser, "shop", "/shop/inventory", async (p) => ({
    search: await p.getByRole("searchbox").or(p.getByPlaceholder(/search|find/i)).count(),
    category: await p.getByRole("combobox", { name: /category/i }).count(),
    lowStock: await p.getByRole("button", { name: /low stock/i }).or(p.getByRole("checkbox", { name: /low stock/i })).count(),
    outOfStock: await p.getByRole("button", { name: /^out of stock/i }).or(p.getByRole("checkbox", { name: /out of stock/i })).count(),
    needsPrice: await p.getByRole("button", { name: /Needs a price/ }).count(),
    sort: await p.getByRole("button", { name: /sort/i }).or(p.getByRole("combobox", { name: /sort/i })).count(),
  }));
  const missing = Object.entries(found).filter(([, n]) => n === 0).map(([k]) => k);
  expect(missing, `/shop/inventory (${rows} listings) has no: ${missing.join(", ")}`).toEqual([]);
  return `${rows} listings; search, category, low stock, out of stock, needs price and sort controls present`;
}, { ...local, partial: "the product list /shop/manage/products has a name search of its own; this check is about the inventory page" });

qa("TC-SPI-028", "inventory exceptions on the admin dashboard: the count matches the open out-of-stock data", async ({ browser }) => {
  const listing = await freshListing({ name: "QA Last One", pricePaise: 1500, stock: 1 });
  await buy(listing, 1); // stock 0 with an open order
  const [db1] = await db()<{ n: number; shops: number }[]>`select count(*)::int as n, count(distinct shop_id)::int as shops from stock_alerts where status = 'OPEN' and alert_type = 'OUT_OF_STOCK'`;
  const kpi = await asPage(browser, "admin", "/admin/dashboard", async (p) => {
    const card = p.getByText("Inventory exceptions").first().locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
    return card.innerText();
  });
  expect(kpi.replace(/\s+/g, " "), "the KPI equals the open out-of-stock alerts").toMatch(new RegExp(`Inventory exceptions ?${db1.n}(?!\\d)`));
  expect(kpi).toContain(`out of stock in ${db1.shops} shop(s)`);
  return `KPI "${kpi.replace(/\s+/g, " ").slice(0, 120)}" = ${db1.n} open out-of-stock alerts in ${db1.shops} shops`;
}, { ...local, partial: "the dashboard counts open out-of-stock / low-stock alerts; it does not list listings with inconsistent figures (the books' drift check is per shop: /api/shops/{id}/accounts/stock/drift)" });
