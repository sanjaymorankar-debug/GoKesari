/**
 * Stock journeys.
 *   SC-23 — a new shop stocks up by category and makes its first sales: the
 *           category puts every product in the inventory once at stock 100;
 *           the unpriced ones (incl. a loose one) are not buyable until the
 *           owner prices them; two counts corrected; a customer buys one
 *           packaged item and 500 g loose; delivered; stock, movements and
 *           the sales figure match the order.
 *   SC-26 — sell, purchase and inventory over a day at shop A: opening stock
 *           of three products, stock received, five orders (delivered,
 *           cancelled, substituted, a removed line, delivered then returned),
 *           a write-off and an in-shop sale; closing stock = opening +
 *           received − sold − written off + returned; sales count delivered
 *           goods only; wallet debits and refunds match; every change has a
 *           movement.
 *
 * Local tier: SC-23 uses a new owner's approved shop with no products (the
 * world's shop C keeps the category once added, so it cannot be "new" twice);
 * SC-26 uses fresh listings at shop A; returns are dropped off at the shop
 * (rule returns.pickupByRider off for the journey).
 */
import type { Browser } from "@playwright/test";

import {
  api,
  approvedShop,
  buy,
  checkoutLines,
  deliverOrder,
  deliverToPerson,
  ensureFunds,
  freeRider,
  freshListing,
  movements,
  orderDetail,
  ownerAction,
  packOrder,
  paiseIn,
  personPage,
  shopAction,
  userOf,
  walletBalance,
  withRules,
  type Listing,
} from "../lib/finance-helpers";
import { pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, RUN } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 600_000 };

/** The "Goods delivered" figure on /shop/manage/today, read by a browser signed in as the owner. */
async function goodsDelivered(browser: Browser, open: () => Promise<{ context: import("@playwright/test").BrowserContext; page: import("@playwright/test").Page }>) {
  const { context, page } = await open();
  try {
    await page.goto("/shop/manage/today");
    await expect(page.getByText("Goods delivered").first()).toBeVisible();
    const box = page.getByText("Goods delivered").first().locator("xpath=ancestor::*[self::div or self::section][1]/..");
    return need(paiseIn(await box.innerText())[0], "the 'Goods delivered' figure");
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ SC-23 */

qa("SC-23", "a new shop stocks up by category and makes its first sales: every product once at 100; unpriced ones not buyable until priced; the order charged at the shop's prices; stock falls by exactly what was sold; movements and revenue match", async ({ browser }) => {
  const shop = await approvedShop("sc23");
  const category = need((world() as unknown as { category?: { id: string } }).category?.id, "the QA category");
  try {
    // 1. The owner adds the QA category.
    const added = await call(shop.owner.ctx, "POST", `/api/shops/${shop.shopId}/product-categories`, { categoryId: category });
    expectStatus(added, [200, 201], "add the category");
    // 2. The inventory: every product of the category, once, at 100.
    const inv = await call(shop.owner.ctx, "GET", `/api/shops/${shop.shopId}/inventory`);
    expectStatus(inv, 200, "the inventory");
    const rows = inv.body.rows as { shopProductId: string; productId: string; productName: string; onlinePricePaise: number | null; available: number; onHand: number }[];
    const [{ expected }] = await db()<{ expected: number }[]>`select count(*)::int as expected from shop_products where shop_id = ${shop.shopId} and deleted_at is null`;
    const bad: string[] = [];
    if (new Set(rows.map((r) => r.productId)).size !== rows.length) bad.push("a product is listed twice");
    if (rows.length !== expected || rows.length !== Number(added.body.addedProducts ?? rows.length)) bad.push(`inventory rows ${rows.length}, listings ${expected}, added ${added.body.addedProducts}`);
    const notHundred = rows.filter((r) => r.onHand !== 100 && r.available !== 100);
    if (notHundred.length) bad.push(`${notHundred.length} products not at 100 (e.g. ${notHundred[0].productName}: ${notHundred[0].onHand})`);
    // 3. The 'needs a price' list; prices set for one packaged product without one (if any) and one loose product.
    const kinds = await db()<{ id: string; kind: string; unit_size_milli: number; sellable: boolean }[]>`
      select sp.id, p.kind, p.unit_size_milli, (sp.is_available and sp.is_active) as sellable from shop_products sp join products p on p.id = sp.product_id where sp.shop_id = ${shop.shopId}`;
    const kindOf = new Map(kinds.map((k) => [k.id, k]));
    const unpriced = rows.filter((r) => r.onlinePricePaise == null);
    const needsList = await (async () => {
      const { context, page } = await personPage(browser, shop.owner);
      try {
        await page.goto("/shop/inventory");
        const button = page.getByRole("button", { name: /Needs a price \((\d+)\)/ });
        await expect(button).toBeVisible();
        return Number((await button.innerText()).match(/\((\d+)\)/)?.[1] ?? -1);
      } finally {
        await context.close();
      }
    })();
    if (needsList !== unpriced.length) bad.push(`'Needs a price (${needsList})' but ${unpriced.length} rows have no price`);
    const loose = need(unpriced.find((r) => kindOf.get(r.shopProductId)?.kind === "LOOSE" && kindOf.get(r.shopProductId)?.sellable && 500 % (kindOf.get(r.shopProductId)?.unit_size_milli ?? 1000) === 0), "an unpriced loose product sold in 250 g or 500 g steps");
    const packaged = need(rows.find((r) => kindOf.get(r.shopProductId)?.kind === "PACKAGED" && kindOf.get(r.shopProductId)?.sellable && r.onlinePricePaise != null), "a priced packaged product");
    const before = await api("customer", "POST", "/api/cart", { shopProductId: loose.shopProductId, quantity: 1 });
    if (before.status < 400) bad.push(`the unpriced loose product was added to a cart (${before.status})`);
    await api("customer", "DELETE", "/api/cart");
    const pricing = [{ shopProductId: loose.shopProductId, pricePaise: 8000 }, ...unpriced.filter((r) => r !== loose && kindOf.get(r.shopProductId)?.kind === "PACKAGED").slice(0, 1).map((r) => ({ shopProductId: r.shopProductId, pricePaise: 3000 }))];
    expectStatus(await call(shop.owner.ctx, "PATCH", `/api/shops/${shop.shopId}/prices`, { prices: pricing }), 200, "set the missing prices");
    await call(shop.owner.ctx, "PATCH", `/api/shop-products/${loose.shopProductId}`, { onlineSaleEnabled: true });
    // 4. Two stock figures corrected to the real count.
    const second = need(rows.find((r) => r !== packaged && kindOf.get(r.shopProductId)?.kind === "PACKAGED" && kindOf.get(r.shopProductId)?.sellable), "a second packaged product");
    for (const [r, n] of [[packaged, 37], [second, 12]] as const) {
      expectStatus(await call(shop.owner.ctx, "POST", `/api/shops/${shop.shopId}/accounts/stock/${r.shopProductId}/count`, { countedMilli: n * 1000, note: "QA: counted on the shelf" }), [200, 201], `count ${r.productName}`);
      const [after] = await db()<{ online: number; offline: number; available: boolean }[]>`select online_stock as online, offline_stock as offline, is_available as available from shop_products where id = ${r.shopProductId}`;
      if (after.online !== n) {
        bad.push(`a physical count of ${n} for "${r.productName}" leaves online stock ${after.online} and in-shop ${after.offline}${after.available ? "" : " — the product is now unavailable online"} (src/server/accounts/stock.ts adjustStockTo takes the difference from the purchase channel first; the category add put 100 in both channels)`);
        // Carry on as the owner then would: the online stock set on the product screen.
        expectStatus(await call(shop.owner.ctx, "PATCH", `/api/shop-products/${r.shopProductId}`, { onlineStock: n, isAvailable: true }), 200, `online stock ${n}`);
      }
    }
    // 5. The customer buys one packaged item and 500 g loose.
    await ensureFunds("customer", 100_000);
    await freeRider("rider");
    const steps = 500 / need(kindOf.get(loose.shopProductId), "the loose product").unit_size_milli;
    const lines: { listing: Listing; quantity: number }[] = [
      { listing: { shopProductId: packaged.shopProductId, productId: packaged.productId, name: packaged.productName, pricePaise: packaged.onlinePricePaise, shopId: shop.shopId, shopName: shop.name } as Listing, quantity: 1 },
      { listing: { shopProductId: loose.shopProductId, productId: loose.productId, name: loose.productName, pricePaise: 8000, shopId: shop.shopId, shopName: shop.name } as Listing, quantity: steps },
    ];
    const salesBefore = await goodsDelivered(browser, () => personPage(browser, shop.owner));
    const since = new Date(Date.now() - 1000);
    const out = await checkoutLines(lines);
    expectStatus(out.res, 201, "the customer's order");
    const order = out.orders[0];
    const detail = need(await orderDetail("customer", order.id), "the order");
    const expectedGoods = (packaged.onlinePricePaise ?? 0) + 4000;
    if (detail.subtotalPaise !== expectedGoods) bad.push(`charged goods ₹${detail.subtotalPaise / 100}, expected ₹${expectedGoods / 100} at the shop's prices`);
    // 6. Accept, pick, pack; the rider delivers.
    for (const a of ["accept", "start", "ready"] as const) expectStatus(await ownerAction(shop.owner.ctx, order.id, a), 200, a);
    await deliverToPerson(order.id, order.orderNumber, { email: userOf("customer").email }, { owner: shop.owner.ctx });
    // 7. Inventory, movements and the sales figure.
    const after = (await call(shop.owner.ctx, "GET", `/api/shops/${shop.shopId}/inventory`)).body.rows as typeof rows;
    const p = need(after.find((r) => r.shopProductId === packaged.shopProductId), "the packaged row");
    const l = need(after.find((r) => r.shopProductId === loose.shopProductId), "the loose row");
    if (p.onHand !== 36) bad.push(`packaged stock ${p.onHand}, expected 37 − 1 = 36`);
    if (l.onHand !== 100 - steps) bad.push(`loose stock ${l.onHand}, expected 100 − ${steps} steps (500 g)`);
    const pm = await movements(packaged.shopProductId, since);
    if (!pm.some((m) => m.delta_units === -1 && m.order_id === order.id)) bad.push(`no sale movement for the packaged line (${pm.map((m) => `${m.delta_units} ${m.reason}`).join(", ")})`);
    const salesAfter = await goodsDelivered(browser, () => personPage(browser, shop.owner));
    if (salesAfter - salesBefore !== detail.subtotalPaise) bad.push(`'Goods delivered' rose by ₹${(salesAfter - salesBefore) / 100}, expected ₹${detail.subtotalPaise / 100}`);
    expect(bad, bad.join("\n")).toEqual([]);
    return `${rows.length} products added once at 100; 'Needs a price (${needsList})'; unpriced loose not buyable (${before.status}); priced ₹80/kg; counts → 37 and 12; ${order.orderNumber}: ₹${detail.subtotalPaise / 100} at the shop's prices, delivered; stock 37 → 36 and loose −500 g; sale movement linked; 'Goods delivered' +₹${(salesAfter - salesBefore) / 100}`;
  } finally {
    await shop.owner.ctx.dispose();
  }
}, local);

/* ------------------------------------------------------------------ SC-26 */

qa("SC-26", "a day of sales, purchases and stock at shop A reconciles: closing = opening + received − sold − written off + returned; sales count delivered goods only; wallet debits and refunds match the orders; every stock change has a movement", async ({ browser }) => {
  return withRules({ returns: { pickupByRider: false } }, async () => {
    await ensureFunds("customer", 300_000);
    const since = new Date(Date.now() - 1000);
    const salesBefore = await goodsDelivered(browser, () => pageAs(browser, "shop"));
    // 1. Opening stock of three products.
    const p1 = await freshListing({ name: "QA Day Atta", pricePaise: 5000, stock: 50 });
    const p2 = await freshListing({ name: "QA Day Sugar", pricePaise: 4000, stock: 50 });
    const p3 = await freshListing({ name: "QA Day Salt", pricePaise: 2000, stock: 50 });
    const opening = { p1: 50, p2: 50, p3: 50 };
    const flow = { p1: { in: 0, sold: 0, off: 0, back: 0 }, p2: { in: 0, sold: 0, off: 0, back: 0 }, p3: { in: 0, sold: 0, off: 0, back: 0 } };
    const walletStart = await walletBalance();
    // 2. Stock received for p1.
    const received = await api("shop", "POST", `/api/shops/${p1.shopId}/accounts/purchases`, {
      supplier: { name: `QA Day Supplier ${RUN}` },
      invoiceNo: `QA-DAY-${RUN}`,
      invoiceDate: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
      lines: [{ shopProductId: p1.shopProductId, description: p1.name, qtyMilli: 20_000, ratePaise: 3500, gstRateBp: 0 }],
      note: "Purchase from supplier",
    });
    expectStatus(received, 201, "stock received");
    flow.p1.in += 20;
    // 3. Five orders.
    await freeRider("rider");
    const a = await buy(p1, 2); // delivered normally
    await packOrder(a.id);
    await deliverOrder(a.id);
    flow.p1.sold += 2;
    const b = await buy(p2, 1); // cancelled
    expectStatus(await api("customer", "PATCH", `/api/orders/${b.id}/status`, { status: "CANCELLED", note: "QA: changed my mind" }), 200, "cancel");
    const c = await buy(p3, 2); // substituted by p2
    expectStatus(await shopAction(c.id, "accept"), 200, "accept");
    expectStatus(await shopAction(c.id, "start"), 200, "start");
    const cItem = need(await orderDetail("customer", c.id), "order c").items[0];
    expectStatus(await shopAction(c.id, "substitute", { itemId: cItem.id, substituteShopProductId: p2.shopProductId }), 200, "propose p2");
    expectStatus(await api("customer", "PATCH", `/api/orders/${c.id}/items/${cItem.id}/substitution`, { approve: true }), 200, "customer approves");
    expectStatus(await shopAction(c.id, "ready"), 200, "ready");
    await deliverOrder(c.id);
    const [sub] = await db()<{ qty: number }[]>`select coalesce(substitute_quantity_milli, quantity_milli)::int as qty from order_items where id = ${cItem.id}`;
    flow.p2.sold += sub.qty / 1000;
    const d = await checkoutLines([{ listing: p1, quantity: 1 }, { listing: p3, quantity: 1 }]); // a removed line
    expectStatus(d.res, 201, "two-line order");
    const dOrder = d.orders[0];
    expectStatus(await shopAction(dOrder.id, "accept"), 200, "accept");
    const removed = need(await orderDetail("customer", dOrder.id), "order d").items.find((i) => i.shopProductId === p3.shopProductId)!;
    expectStatus(await shopAction(dOrder.id, "remove", { itemId: removed.id, reason: "Out of stock" }), 200, "remove a line");
    // A line removed as "Out of stock" was not on the shelf: its unit stays off sale (TC-SPI-011) — counted as written off here.
    flow.p3.off += 1;
    expectStatus(await shopAction(dOrder.id, "ready"), 200, "ready");
    await deliverOrder(dOrder.id);
    flow.p1.sold += 1;
    const e = await buy(p2, 3); // delivered, then one returned unopened
    await packOrder(e.id);
    await deliverOrder(e.id);
    flow.p2.sold += 3;
    const eItem = need(await orderDetail("customer", e.id), "order e").items[0];
    const ret = await api("customer", "POST", `/api/orders/${e.id}/returns`, { reason: "OTHER", comment: "QA: one too many", items: [{ orderItemId: eItem.id, quantityMilli: 1000, condition: "UNOPENED" }] });
    expectStatus(ret, 201, "return one");
    for (const action of ["approve", "receive"]) expectStatus(await api("shop", "PATCH", `/api/returns/${ret.body.id}`, { action }), 200, action);
    expectStatus(await api("shop", "PATCH", `/api/returns/${ret.body.id}`, { action: "inspect", outcome: "ACCEPT", note: "Sealed, back on the shelf" }), 200, "inspect");
    flow.p2.back += 1;
    // 4. Write-off; 5. in-shop sale.
    expectStatus(await api("shop", "POST", `/api/shops/${p3.shopId}/accounts/stock/${p3.shopProductId}/write-off`, { qtyMilli: 1000, kind: "DAMAGE", note: "QA: packet torn" }), [200, 201], "write off 1");
    flow.p3.off += 1;
    // The sales invoice needs the shop's state (shop A has none in the test data): set for the sale, put back after.
    const [st] = await db()<{ state: string | null }[]>`select state from shops where id = ${p1.shopId}`;
    if (!st.state) await db()`update shops set state = 'Maharashtra' where id = ${p1.shopId}`;
    try {
      expectStatus(await api("shop", "POST", `/api/shops/${p1.shopId}/accounts/sales`, { paymentMode: "CASH", pricesIncludeTax: true, note: "Sold in shop", lines: [{ shopProductId: p1.shopProductId, description: p1.name, qtyMilli: 4000, ratePaise: 5000, gstRateBp: 0 }] }), 201, "in-shop sale");
    } finally {
      if (!st.state) await db()`update shops set state = null where id = ${p1.shopId}`;
    }
    flow.p1.sold += 4;
    // 6. Compare.
    const bad: string[] = [];
    const notes: string[] = [];
    for (const [key, l] of [["p1", p1], ["p2", p2], ["p3", p3]] as const) {
      const f = flow[key];
      const want = opening[key] + f.in - f.sold - f.off + f.back;
      const [{ stock }] = await db()<{ stock: number }[]>`select online_stock as stock from shop_products where id = ${l.shopProductId}`;
      const moved = (await movements(l.shopProductId, since)).reduce((s, m) => s + Number(m.delta_units), 0);
      notes.push(`${l.name.split(" ").slice(0, 3).join(" ")}: ${opening[key]} + ${f.in} − ${f.sold} − ${f.off} + ${f.back} = ${want}, stock ${stock}, movements Σ ${moved}`);
      if (stock !== want) bad.push(`${l.name}: closing stock ${stock}, expected ${want}${key === "p2" ? " (the returned unopened unit is not put back — same defect as TC-SPI-020)" : key === "p3" ? " (the substituted-away units are not given back — same defect as TC-SPI-010)" : ""}`);
      if (moved !== stock - opening[key]) bad.push(`${l.name}: movements add up to ${moved}, stock changed by ${stock - opening[key]}`);
    }
    const delivered = [a, c, dOrder, e];
    const goods = await db()<{ goods: number }[]>`select coalesce(sum(goods_paise), 0)::int as goods from order_financials where order_id = any(${delivered.map((o) => o.id)})`;
    const salesAfter = await goodsDelivered(browser, () => pageAs(browser, "shop"));
    if (salesAfter - salesBefore !== goods[0].goods) bad.push(`'Goods delivered' +₹${(salesAfter - salesBefore) / 100}, delivered goods ₹${goods[0].goods / 100} (the cancelled order must not count)`);
    const ids = [a, b, c, dOrder, e].map((o) => o.id);
    const [{ net }] = await db()<{ net: number }[]>`select coalesce(-sum(amount_paise), 0)::int as net from wallet_transactions where order_id = any(${ids})`;
    const totals = await db()<{ total: number; refunded: number; status: string }[]>`select total_paise::int as total, refunded_paise::int as refunded, status from orders where id = any(${ids})`;
    // An order's total is reduced by a removed line or a refunded return (refunded_paise records the refund).
    const owed = totals.reduce((sum, o) => sum + (o.status === "CANCELLED" || o.status === "REFUNDED" ? 0 : o.total), 0);
    const [returned] = await db()<{ amount: number }[]>`select coalesce(sum(amount_paise), 0)::int as amount from wallet_transactions where order_id = ${e.id} and amount_paise > 0`;
    if (net !== owed) bad.push(`wallet net charge ₹${net / 100} ≠ orders' net ₹${owed / 100}`);
    if ((await walletBalance()) !== walletStart - net) bad.push("the wallet balance does not match its order entries");
    expect(bad, `${bad.join("\n")}\n— ${notes.join(" | ")}`).toEqual([]);
    return `${notes.join(" | ")}; 'Goods delivered' +₹${(salesAfter - salesBefore) / 100} = delivered goods; wallet net ₹${net / 100} = orders' net (return refund ₹${returned.amount / 100})`;
  });
}, { ...local, timeout: 720_000 });
