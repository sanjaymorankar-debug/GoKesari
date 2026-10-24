/**
 * End-to-end order journeys across customer, shop, rider and admin:
 * SC-01 (wallet order from search to rating and the money trace), SC-02
 * (multi-shop cart, one shop rejects), SC-03 (substitution and a removed
 * line), SC-04 (shop rejects), SC-05 (no rider available, then found), SC-06
 * (rider declines, the next one delivers), SC-07 (failed delivery returned to
 * the shop), SC-11 (cancellation at every stage) and SC-33 (shop does not
 * accept in time).
 *
 * Each scenario passes only when every step of its journey reaches the
 * expected outcome. Local tier: riders are put online / offline, rules are
 * switched for a scenario and restored, and scheduled jobs are run by hand.
 */
import {
  api,
  asPage,
  buy,
  checkoutLines,
  cron,
  deliverOrder,
  dbStock,
  ensureFunds,
  freeRider,
  freshListing,
  notificationsOf,
  orderDetail,
  packOrder,
  payOnSandbox,
  pickUpAndStart,
  riderAction,
  shopAction,
  shopId,
  snapshotCount,
  statusOf,
  trace,
  walletBalance,
  walletDebitOf,
  withRules,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { offerFor, onlyRiderOnline, pickupCode } from "../lib/flows";
import { expectStatus, poll } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 420_000 };

/** The delivery-order row of an order (local). */
async function leg(orderId: string) {
  const [row] = await db()<{ id: string; status: string; delivery_partner_id: string | null; rejected_partner_ids: string[] | null }[]>`
    select id, status, delivery_partner_id, rejected_partner_ids from delivery_orders where order_id = ${orderId}`;
  return row;
}

qa("SC-01", "customer finds the cheapest delivering shop, pays from the wallet, the order goes through every state to DELIVERED, rates shop and rider; the admin's money trace has the snapshot, commission and rider earning", async ({ browser }) => {
  await freeRider("rider");
  await ensureFunds("customer");
  // The same product at shop A (₹40) and shop B (₹45).
  const a = await freshListing({ name: "QA Compare Bread", shop: "A", pricePaise: 4000, mrpPaise: 5000, stock: 30 });
  const b = await freshListing({ name: "QA Compare Bread", shop: "B", pricePaise: 4500, productId: a.productId, stock: 30 });
  const since = new Date(Date.now() - 1000);
  // 1–2. Signed in, delivery location set, search and compare prices; the cheaper delivering shop is A.
  const picked = await asPage(browser, "customer", "/", async (page) => {
    const address = need(world().addresses?.customer, "the customer's address");
    expectStatus({ status: (await page.request.post("/api/location", { data: { addressId: address } })).status(), body: null, text: "", headers: {}, location: null }, 200, "set the delivery location");
    await page.goto(`/search?q=${encodeURIComponent(a.name)}`);
    const card = page.getByTestId("product-card").filter({ hasText: a.name }).first();
    await expect(card).toBeVisible();
    await card.getByTestId("compare-n-prices").click();
    await page.waitForURL(/\/search\/compare\?product=/);
    const main = page.locator("main").first();
    await expect(main).toContainText(a.shopName);
    await expect(main).toContainText(b.shopName);
    const text = await main.innerText();
    return text.indexOf(a.shopName) < text.indexOf(b.shopName) ? a : b;
  });
  expect(picked.shopId, "the cheapest delivering shop (₹40 at A vs ₹45 at B) is listed first").toBe(a.shopId);
  // 3. Cart, address and delivery window, wallet.
  const windows = await api("customer", "GET", `/api/checkout/delivery-windows?shopId=${picked.shopId}`);
  expectStatus(windows, 200, "delivery windows");
  const window = (["STANDARD_60", "EXPRESS_30"] as const).find((w) => windows.body[w]?.available ?? windows.body[w]) ?? "STANDARD_60";
  const stockBefore = await dbStock(a.shopProductId);
  const balance = await walletBalance();
  const order = await buy(picked, 2, { extra: { deliveryWindows: { [picked.shopId]: window } } });
  expect(order.status).toBe("CONFIRMED");
  // 4–6. Shop accepts, picks, packs; the rider is offered automatically, picks up with the code, delivers with the customer's code.
  await packOrder(order.id);
  const offer = await offerFor(order.id, "rider");
  expect(offer.status, "offered without anyone asking").toBe("OFFERED");
  await deliverOrder(order.id);
  expect(await statusOf(order.id)).toBe("DELIVERED");
  // 7. Ratings.
  expectStatus(await api("customer", "POST", `/api/orders/${order.id}/rating`, { target: "SHOP", score: 5, comment: "QA: quick" }), [200, 201], "rate the shop");
  expectStatus(await api("customer", "POST", `/api/orders/${order.id}/rating`, { target: "DELIVERY_PARTNER", score: 4 }), [200, 201], "rate the rider");
  const rated = await api("customer", "GET", `/api/orders/${order.id}/rating`);
  expect([rated.body.shopScore, rated.body.riderScore], "ratings saved").toEqual([5, 4]);
  // 8. Money trace.
  const t = await trace(order.orderNumber);
  expect(t.snapshot, "one finance snapshot").toBeTruthy();
  expect(await snapshotCount(order.id)).toBe(1);
  expect(t.snapshot!.commissionPaise).toBe(Math.round((t.snapshot!.goodsPaise * t.snapshot!.commissionRateBp) / 10_000));
  expect(t.riderEarning?.totalPaise ?? 0, "rider earning recorded").toBeGreaterThan(0);
  // Wallet once, stock reduced, a notification at every step.
  expect(balance - (await walletBalance()), "wallet debited once").toBe(order.totalPaise);
  expect(await walletDebitOf(order.id)).toBe(order.totalPaise);
  expect(await dbStock(a.shopProductId), "stock reduced by 2").toBe(stockBefore - 2);
  const notes = (await notificationsOf("customer", order.orderNumber, since)).map((n) => n.type);
  for (const step of ["order.confirmed", "order.accepted", "order.ready", "order.assigned", "order.picked_up", "order.out_for_delivery", "order.delivered"]) {
    expect(notes, `customer told: ${step}`).toContain(step);
  }
  const shopNotes = (await notificationsOf("shop", order.orderNumber, since)).length;
  expect(shopNotes, "the shop was notified too").toBeGreaterThan(0);
  return `${order.orderNumber}: compare page → ${picked.shopName}; window ${window}; CONFIRMED → … → DELIVERED; customer notified ${notes.length}× (${[...new Set(notes)].join(", ")}); rated 5/4; snapshot ${t.snapshot!.commissionRateBp}bp commission ₹${t.snapshot!.commissionPaise / 100}, earning ₹${(t.riderEarning?.totalPaise ?? 0) / 100}`;
}, local);

qa("SC-02", "multi-shop cart: two independent orders and debits; one shop delivers, the other rejects and is fully refunded with its stock restored", async () => {
  await freeRider("rider");
  await ensureFunds("customer");
  const a = await freshListing({ name: "QA Multi A", shop: "A", pricePaise: 3000, stock: 10 });
  const b = await freshListing({ name: "QA Multi B", shop: "B", pricePaise: 2500, stock: 10 });
  const before = await walletBalance();
  const out = await checkoutLines([{ listing: a, quantity: 1 }, { listing: b, quantity: 2 }]);
  expectStatus(out.res, 201, "pay for both shops");
  expect(out.orders.length, "two orders").toBe(2);
  const oa = out.orders.find((o) => o.shopId === a.shopId)!;
  const ob = out.orders.find((o) => o.shopId === b.shopId)!;
  expect(await walletDebitOf(oa.id), "debit for A").toBe(oa.totalPaise);
  expect(await walletDebitOf(ob.id), "debit for B").toBe(ob.totalPaise);
  expect(before - (await walletBalance())).toBe(oa.totalPaise + ob.totalPaise);
  // Shop B rejects; shop A fulfils and delivers.
  expectStatus(await shopAction(ob.id, "reject", { reason: "QA: out of stock today" }, "shopB"), 200, "B rejects");
  await packOrder(oa.id);
  await deliverOrder(oa.id);
  expect(await statusOf(oa.id)).toBe("DELIVERED");
  expect(["CANCELLED", "REFUNDED"]).toContain(await statusOf(ob.id));
  expect(before - (await walletBalance()), "only A's order is paid in the end").toBe(oa.totalPaise);
  expect(await dbStock(b.shopProductId), "B's stock restored").toBe(10);
  expect(await dbStock(a.shopProductId), "A's stock reduced").toBe(9);
  return `${oa.orderNumber} (A) delivered; ${ob.orderNumber} (B) rejected → refunded ₹${ob.totalPaise / 100}, stock 10 again`;
}, local);

qa("SC-03", "substitution: a cheaper substitute and a removed line are refunded at once; READY waits for the customer's decision; the snapshot uses the reduced goods value", async () => {
  await freeRider("rider");
  await ensureFunds("customer");
  const l1 = await freshListing({ name: "QA Sub Line1", pricePaise: 5000, stock: 10 });
  const l2 = await freshListing({ name: "QA Sub Line2", pricePaise: 3000, stock: 10 });
  const l3 = await freshListing({ name: "QA Sub Line3", pricePaise: 2000, stock: 10 });
  const cheaper = await freshListing({ name: "QA Sub Cheaper", pricePaise: 4200, stock: 10 });
  const out = await checkoutLines([{ listing: l1, quantity: 1 }, { listing: l2, quantity: 1 }, { listing: l3, quantity: 1 }]);
  expectStatus(out.res, 201, "3-line order");
  const order = out.orders[0];
  expectStatus(await shopAction(order.id, "accept"), 200, "accept");
  expectStatus(await shopAction(order.id, "start"), 200, "start");
  const items = need(await orderDetail("customer", order.id), "the order").items;
  const i1 = items.find((i) => i.shopProductId === l1.shopProductId)!;
  const i2 = items.find((i) => i.shopProductId === l2.shopProductId)!;
  const w0 = await walletBalance();
  expectStatus(await shopAction(order.id, "substitute", { itemId: i1.id, substituteShopProductId: cheaper.shopProductId }), 200, "propose the substitute");
  expectStatus(await shopAction(order.id, "remove", { itemId: i2.id, reason: "Out of stock" }), 200, "remove line 2");
  expect((await walletBalance()) - w0, "removed line refunded at once").toBe(3000);
  const early = await shopAction(order.id, "ready");
  expect(early.status, "READY is blocked until the customer decides").toBe(409);
  const w1 = await walletBalance();
  expectStatus(await api("customer", "PATCH", `/api/orders/${order.id}/items/${i1.id}/substitution`, { approve: true }), 200, "customer approves");
  expect((await walletBalance()) - w1, "the difference refunded at once").toBe(800);
  expectStatus(await shopAction(order.id, "ready"), 200, "ready");
  await deliverOrder(order.id);
  const t = await trace(order.orderNumber);
  expect(t.snapshot?.goodsPaise, "snapshot goods = 4200 + 2000").toBe(6200);
  return `${order.orderNumber}: line 2 refunded ₹30 and the ₹8 difference at once; READY refused (${early.status}) until approval; delivered with goods ₹62`;
}, local);

qa("SC-04", "the shop rejects the order: full refund, stock restored, the customer told the reason, no settlement entry", async () => {
  await ensureFunds("customer");
  const l = await freshListing({ name: "QA Reject Me", pricePaise: 4000, stock: 5 });
  const since = new Date(Date.now() - 1000);
  const before = await walletBalance();
  const order = await buy(l, 2);
  const reason = "QA: our oven broke down";
  expectStatus(await shopAction(order.id, "reject", { reason }), 200, "reject");
  expect(await walletBalance(), "full refund").toBe(before);
  expect(await dbStock(l.shopProductId), "stock restored").toBe(5);
  const notes = await notificationsOf("customer", order.orderNumber, since);
  expect(notes.some((n) => n.body.includes(reason) || n.title.includes(reason)), `the customer is told the reason (${notes.map((n) => `${n.type}: ${n.body}`).join(" | ")})`).toBe(true);
  expect(await snapshotCount(order.id), "never reaches a settlement").toBe(0);
  return `${order.orderNumber} rejected: refunded ₹${order.totalPaise / 100}, stock 5, notice "${notes.find((n) => n.body.includes(reason))?.body}"`;
}, local);

qa("SC-05", "no rider available: a bounded search with one notice at start and one at stop; a rider comes online, 'Try finding a rider again' offers them and the order completes", async () => {
  await ensureFunds("customer");
  const l = await freshListing({ name: "QA No Rider", pricePaise: 2000, stock: 5 });
  const since = new Date(Date.now() - 1000);
  const result = await withRules({ dispatch: { maxAttempts: 2, retryIntervalSeconds: 15, notifyShopAfterAttempts: 1 } }, async () => {
    await freeRider("rider");
    await db()`update delivery_partners set is_online = false where is_online`;
    const order = await buy(l, 1);
    await packOrder(order.id);
    let status = await api("shop", "POST", `/api/orders/${order.id}/assign`, {});
    // Watch the automatic attempts until the search stops (15 s between attempts by the rule).
    const stopped = await poll(
      async () => {
        await cron("delivery-dispatch");
        const [s] = await db()<{ status: string; attempts: number }[]>`select status, attempts from rider_searches where order_id = ${order.id}`;
        return s;
      },
      (s) => s?.status !== "SEARCHING",
      90_000,
      8_000,
    );
    expect(stopped?.status, `the search stops after ${stopped?.attempts} attempts`).not.toBe("SEARCHING");
    const shopNotes = (await notificationsOf("shop", order.orderNumber, since)).filter((n) => /rider/i.test(n.title + n.body));
    // A rider comes online; the shop presses "Try finding a rider again".
    await onlyRiderOnline("rider");
    status = await api("shop", "POST", `/api/orders/${order.id}/assign`, {});
    expectStatus(status, [200, 201], "try finding a rider again");
    const offer = await offerFor(order.id, "rider", 20_000);
    expect(offer.status).toBe("OFFERED");
    await deliverOrder(order.id);
    expect(await statusOf(order.id)).toBe("DELIVERED");
    return { order, stopped, shopNotes };
  });
  const kinds = result.shopNotes.map((n) => n.type);
  expect(kinds.filter((k) => k === "delivery.search_stopped").length, `one notice when the search stops (${kinds.join(", ")})`).toBe(1);
  expect(kinds.length, "one notice at the start and one at the stop").toBe(2);
  return `${result.order.orderNumber}: search stopped after ${result.stopped?.attempts} attempts (${result.stopped?.status}); shop told ${kinds.join(" → ")}; restarted, offered, delivered`;
}, local);

qa("SC-06", "rider 1 declines: rider 2 is offered and delivers; rider 1 is never offered it again; only one active assignment at a time", async () => {
  await ensureFunds("customer");
  await freeRider("rider2");
  await freeRider("rider");
  // Both online, rider 1 at the shop, rider 2 about 1 km away.
  await db()`update delivery_partners set is_online = true where user_id = any(${[world().users.rider!.id!, world().users.rider2!.id!]})`;
  await db()`update delivery_partners set last_location_latitude = ${String(world().location!.lat + 0.01)}, last_location_longitude = ${String(world().location!.lng)}, last_location_at = now() where user_id = ${world().users.rider2!.id!}`;
  const l = await freshListing({ name: "QA Decline", pricePaise: 2000, stock: 5 });
  const order = await buy(l, 1);
  await packOrder(order.id);
  const first = await offerFor(order.id, "rider");
  expectStatus(await riderAction(first.deliveryOrderId, "reject", { reason: "QA: too far" }, "rider"), 200, "rider 1 declines");
  const second = await offerFor(order.id, "rider2", 30_000).catch(async () => {
    await cron("delivery-dispatch");
    return offerFor(order.id, "rider2", 30_000);
  });
  const row = await leg(order.id);
  const [r1] = await db()<{ id: string }[]>`select id from delivery_partners where user_id = ${world().users.rider!.id!}`;
  expect(row.rejected_partner_ids ?? [], "rider 1 is on the never-again list").toContain(r1.id);
  const active = await db()<{ n: number }[]>`select count(*)::int as n from delivery_orders where order_id = ${order.id} and status in ('OFFERED','ACCEPTED','PICKED_UP')`;
  expect(active[0].n, "one active assignment").toBe(1);
  await deliverOrder(order.id, { rider: "rider2" });
  // Rider 1's view never shows it again.
  const view = await api("rider", "GET", "/api/delivery-partner/deliveries");
  expect(view.body?.active?.orderId ?? null, "rider 1 not re-offered").not.toBe(order.id);
  return `${order.orderNumber}: rider 1 declined; rider 2 offered (${second.status}) and delivered; one assignment row; rider 1 listed as declined`;
}, local);

qa("SC-07", "customer unreachable: the rider reports a failed delivery, the shop marks the goods returned; the order is cancelled and refunded per policy, the rider paid per the failed-delivery rule, stock restored", async () => {
  await freeRider("rider");
  await ensureFunds("customer");
  const l = await freshListing({ name: "QA Failed Drop", pricePaise: 3000, stock: 5 });
  const before = await walletBalance();
  const order = await buy(l, 1);
  await packOrder(order.id);
  const legRow = await pickUpAndStart(order.id);
  expectStatus(await riderAction(legRow.deliveryOrderId, "fail", { reason: "QA: customer not reachable" }), 200, "failed delivery");
  expect(await statusOf(order.id)).toBe("FAILED");
  expectStatus(await api("shop", "PATCH", `/api/orders/${order.id}/status`, { status: "RETURNED", note: "QA: goods back" }), 200, "returned");
  // FAILED / RETURNED orders are closed by the shop or operations (orders.ts D10 note).
  expectStatus(await api("shop", "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA: returned, closing" }), 200, "close the returned order");
  const final = await statusOf(order.id);
  expect(["CANCELLED", "REFUNDED"]).toContain(final);
  expect(await walletBalance(), "refunded in full (shop-side cancel)").toBe(before);
  expect(await dbStock(l.shopProductId), "stock restored").toBe(5);
  const [earning] = await db()<{ total: number }[]>`select total_paise::int as total from delivery_partner_earnings where delivery_order_id = ${legRow.deliveryOrderId}`;
  expect(earning?.total ?? 0, "the rider is paid for the trip (default 100%)").toBeGreaterThan(0);
  return `${order.orderNumber}: FAILED → RETURNED → ${final}; refunded ₹${order.totalPaise / 100}; stock 5; rider earned ₹${(earning?.total ?? 0) / 100}`;
}, { ...local, partial: "marking the goods RETURNED alone neither refunds nor restocks: the shop (or operations) then cancels the order, which does both" });

qa("SC-11", "cancellation at every stage: the customer may cancel at CONFIRMED (full refund), not at ACCEPTED / PREPARING / READY / ASSIGNED, and after pickup for the goods only; the shop's cancel is a full refund every time", async () => {
  await ensureFunds("customer");
  const l = await freshListing({ name: "QA Cancel Stages", pricePaise: 2000, stock: 40 });
  const results: string[] = [];
  const bad: string[] = [];
  const stages = ["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const;
  for (const stage of stages) {
    await freeRider("rider");
    const before = await walletBalance();
    const o = await buy(l, 1);
    const fee = (await orderDetail("customer", o.id))?.deliveryFeePaise ?? 0;
    if (stage !== "CONFIRMED") expectStatus(await shopAction(o.id, "accept"), 200, "accept");
    if (["PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"].includes(stage)) expectStatus(await shopAction(o.id, "start"), 200, "start");
    if (["READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"].includes(stage)) expectStatus(await shopAction(o.id, "ready"), 200, "ready");
    if (["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"].includes(stage)) {
      const offer = await offerFor(o.id, "rider");
      expectStatus(await riderAction(offer.deliveryOrderId, "accept"), 200, "rider accepts");
      if (stage !== "ASSIGNED") {
        const code = await pickupCode(o.id);
        expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}), 200, "pickup");
      }
      if (stage === "OUT_FOR_DELIVERY") expectStatus(await riderAction(offer.deliveryOrderId, "start"), 200, "start the drop");
    }
    expect(await statusOf(o.id)).toBe(stage);
    const mine = await api("customer", "PATCH", `/api/orders/${o.id}/status`, { status: "CANCELLED", note: `QA ${stage}` });
    const refunded = (await walletBalance()) - (before - o.totalPaise);
    const allowed = stage === "CONFIRMED" || stage === "PICKED_UP" || stage === "OUT_FOR_DELIVERY";
    if (allowed !== (mine.status === 200)) bad.push(`${stage}: customer cancel → ${mine.status} (expected ${allowed ? "allowed" : "blocked"})`);
    if (mine.status === 200) {
      const want = stage === "CONFIRMED" ? o.totalPaise : o.totalPaise - fee;
      if (refunded !== want) bad.push(`${stage}: refunded ${refunded} (expected ${want}${stage === "CONFIRMED" ? ", full" : ", goods only"})`);
      results.push(`${stage} customer ✓ ₹${refunded / 100}`);
    } else {
      const shop = await api("shop", "PATCH", `/api/orders/${o.id}/status`, { status: "CANCELLED", note: `QA shop cancels at ${stage}` });
      const shopRefund = (await walletBalance()) - (before - o.totalPaise);
      if (shop.status !== 200 || shopRefund !== o.totalPaise) bad.push(`${stage}: shop cancel → ${shop.status}, refunded ${shopRefund} of ${o.totalPaise}`);
      results.push(`${stage} customer ✗ (${mine.status}) → shop ✓ ₹${shopRefund / 100}`);
    }
  }
  expect(bad, `${bad.join(" | ")} — ${results.join("; ")}`).toEqual([]);
  return results.join("; ");
}, { ...local, timeout: 600_000 });

qa("SC-33", "the shop accepts none in time: a wallet, an online and a COD order are each cancelled once — wallet credited, online refunded to source, COD nothing; stock restored; customer and shop told", async ({ browser }) => {
  await freeRider("rider");
  await ensureFunds("customer");
  const l = await freshListing({ name: "QA Accept Timeout", pricePaise: 2500, stock: 20 });
  await db()`update shops set cod_enabled = true where id = ${shopId("A")}`;
  const since = new Date(Date.now() - 1000);
  try {
    return await withRules({ shopAcceptance: { enabled: true, acceptMinutes: 10, onTimeout: "CANCEL" }, onlinePayments: { enabled: true } }, async () => {
      const before = await walletBalance();
      const wallet = await buy(l, 1);
      const online = await checkoutLines([{ listing: l, quantity: 2 }], { method: "ONLINE" });
      expectStatus(online.res, 201, "online checkout");
      const redirect = need(online.res.body.payment?.redirectUrl, "the sandbox payment link");
      await payOnSandbox(browser, "customer", redirect, "SUCCESS", "UPI");
      const onlineOrder = online.orders[0];
      await poll(() => statusOf(onlineOrder.id), (s) => s === "CONFIRMED", 20_000, 1000);
      const cod = await buy(l, 3, { method: "COD" });
      expect(await dbStock(l.shopProductId), "6 units held").toBe(14);
      // Nobody accepts: the accept-by time passes.
      await db()`update orders set accept_by_at = now() - interval '1 minute' where id = any(${[wallet.id, onlineOrder.id, cod.id]})`;
      const swept = await cron("shop-acceptance");
      expectStatus(swept, 200, "acceptance sweep");
      await cron("shop-acceptance"); // a second run changes nothing
      await cron("payments-reconcile"); // sends the queued refund to the gateway
      const statuses = await Promise.all([wallet, onlineOrder, cod].map((o) => statusOf(o.id)));
      for (const s of statuses) expect(["CANCELLED", "REFUNDED", "REFUND_PENDING"], `status ${s}`).toContain(s);
      expect(await walletBalance(), "wallet order credited back (the online and COD orders never touched the wallet)").toBe(before);
      const refunds = await db()<{ status: string; amount: number }[]>`select status, amount_paise::int as amount from payment_refunds where order_id = ${onlineOrder.id}`;
      expect(refunds.length, "one refund to the source for the online order").toBe(1);
      expect(refunds[0].amount).toBe(onlineOrder.totalPaise);
      const cancels = await db()<{ n: number }[]>`select count(*)::int as n from order_status_history where order_id = any(${[wallet.id, onlineOrder.id, cod.id]}) and new_status = 'CANCELLED'`;
      expect(cancels[0].n, "each cancelled once").toBe(3);
      expect(await dbStock(l.shopProductId), "stock restored").toBe(20);
      const told = await notificationsOf("customer", wallet.orderNumber, since);
      const shopTold = await notificationsOf("shop", wallet.orderNumber, since);
      expect(told.length > 0 && shopTold.length > 0, "customer and shop told").toBe(true);
      return `${wallet.orderNumber} / ${onlineOrder.orderNumber} / ${cod.orderNumber} → ${statuses.join(", ")}; wallet back to ₹${before / 100}; online refund ${refunds[0].status} ₹${refunds[0].amount / 100}; COD nothing; stock 20; customer and shop notified`;
    });
  } finally {
    await db()`update shops set cod_enabled = false where id = ${shopId("A")}`;
  }
}, local);
