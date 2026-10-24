/**
 * One order through every state, as the customer, the shop owner and the
 * rider see it (TC-ORD-001), with the checks each step owes on the way:
 * wallet checkout and its replay, accept, pack, ready, the rider's offer,
 * pickup with the shop's code, delivery with the customer's code, and what
 * the rider may never see. Then the cancellation rules (TC-ORD-006/007).
 *
 * Signed-in tier: the test site (staging accounts) and the local server.
 * The checks run in order and hand the order on through the stash, so a
 * failed step blocks the ones after it instead of hiding them.
 */
import { as } from "../lib/actors";
import {
  addToCart,
  cartLines,
  defaultAddress,
  deliveryCode,
  emptyCart,
  fulfil,
  offerFor,
  onlyRiderOnline,
  orderAs,
  pickupCode,
  placeOrder,
  riderAction,
  sellable,
  walletBalance,
  type PlacedOrder,
} from "../lib/flows";
import { call, expectStatus, RUN, stash, unstash } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 300_000 };
// One key for the run (a clean results folder per run): the phone project reads the order the desktop project placed.
const KEY = "order-lifecycle";

function current() {
  const order = unstash<PlacedOrder & { deliveryOrderId?: string; startBalance?: number }>(KEY);
  if (!order) blocked("needs the order placed by TC-CART-009 in this run");
  return order;
}

/** Status of the order as the customer's own order list shows it. */
async function statusOf(id: string) {
  return (await orderAs("customer", id))?.status ?? "missing";
}

qa(["TC-CART-001", "TC-CART-002"], "cart: add two products of one shop, change quantity, remove a line, empty", async () => {
  const listing = await sellable("A");
  await emptyCart();
  expectStatus(await addToCart("customer", listing.shopProductId, 1), [200, 201], "add first line");
  const lines = await cartLines();
  expect(lines.map((l) => l.shopProductId)).toContain(listing.shopProductId);
  const line = lines.find((l) => l.shopProductId === listing.shopProductId)!;
  const more = await call(await as("customer"), "PATCH", `/api/cart/items/${line.id}`, { quantity: 2 });
  expectStatus(more, 200, "increase quantity");
  expect((await cartLines()).find((l) => l.id === line.id)?.quantity).toBe(2);
  const less = await call(await as("customer"), "PATCH", `/api/cart/items/${line.id}`, { quantity: 1 });
  expectStatus(less, 200, "decrease quantity");
  const removed = await call(await as("customer"), "DELETE", `/api/cart/items/${line.id}`);
  expectStatus(removed, [200, 204], "remove the line");
  expect((await cartLines()).find((l) => l.id === line.id), "removed line is gone").toBeUndefined();
  await emptyCart();
  expect(await cartLines()).toEqual([]);
  return `${listing.name} @ ${listing.pricePaise} paise: add, 1→2→1, remove, empty`;
}, { ...signed, partial: "second product and the /cart page's grouping and empty state are UI checks in cart-ui.spec.ts" });

qa(["TC-CART-009", "TC-ORD-001"], "wallet checkout of one shop: one CONFIRMED order, wallet debited by exactly the total, cart emptied", async () => {
  await onlyRiderOnline("rider");
  const start = await walletBalance();
  const order = await placeOrder({ method: "WALLET" });
  stash(KEY, { ...order, startBalance: start });
  expect(order.status, "status after wallet checkout").toBe("CONFIRMED");
  expect(await walletBalance(), "wallet debited by the order total").toBe(start - order.totalPaise);
  expect(await cartLines(), "cart emptied after checkout").toEqual([]);
  const listed = await orderAs("customer", order.id);
  expect(listed?.status, "order on /api/orders").toBe("CONFIRMED");
  return `${order.orderNumber} CONFIRMED, ₹${order.totalPaise / 100} debited (${start} → ${start - order.totalPaise} paise)`;
}, { ...signed, partial: "stock reduction and the shop notification are checked in the inventory and notification specs" });

qa("TC-CART-012", "replaying the checkout with the same request id makes no second order and no second debit", async () => {
  const order = current();
  const before = await walletBalance();
  const address = await defaultAddress();
  const res = await call(await as("customer"), "POST", "/api/checkout", {
    requestId: order.requestId,
    addressId: address?.id ?? null,
    paymentMethod: "WALLET",
    acknowledgeClosedShopIds: [order.listing.shopId],
  });
  expectStatus(res, [200, 201], "replayed checkout");
  expect(res.body.deduplicated, "deduplicated flag").toBe(true);
  expect(res.body.orders.map((o: { id: string }) => o.id)).toEqual([order.id]);
  expect(await walletBalance(), "no second debit").toBe(before);
  return `replay → deduplicated, same order ${order.orderNumber}, balance unchanged`;
}, signed);

qa("TC-CART-018", "/orders shows the new order with number, shop, amount and status", async ({ browser }) => {
  const order = current();
  const { pageAs } = await import("../lib/actors");
  const { context, page } = await pageAs(browser, "customer");
  // The phone run comes after the desktop run has moved the same order on, so the card is checked
  // against the order's status now ("confirmed" when new, "preparing" later), not a fixed word.
  const label = new RegExp((await statusOf(order.id)).replace(/_/g, " "), "i");
  try {
    await page.goto("/orders");
    const card = page.getByTestId("order-card").filter({ hasText: order.orderNumber }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText(order.listing.shopName);
    await expect(card).toContainText(label);
    await expect(card).toContainText(`${Math.floor(order.totalPaise / 100)}`);
  } finally {
    await context.close();
  }
  return `${order.orderNumber} card shows shop, amount and its status (${label.source})`;
}, { ...signed, mobile: true, partial: "the card's action buttons are checked in the cancellation and support specs" });

qa("TC-ORD-007", "the customer cannot cancel once the shop has accepted (ACCEPTED, PREPARING)", async () => {
  const order = current();
  expectStatus(await fulfil(order.id, "accept"), 200, "shop accepts");
  const atAccepted = await call(await as("customer"), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA" });
  expect(atAccepted.status, "cancel at ACCEPTED").toBe(409);
  expectStatus(await fulfil(order.id, "start"), 200, "shop starts picking");
  const atPreparing = await call(await as("customer"), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA" });
  expect(atPreparing.status, "cancel at PREPARING").toBe(409);
  expect(await statusOf(order.id)).toBe("PREPARING");
  return `cancel refused at ACCEPTED (${atAccepted.status}) and PREPARING (${atPreparing.status}): ${atPreparing.body?.error?.message ?? ""}`;
}, { ...signed, partial: "READY and ASSIGNED are checked by TC-ORD-007 (ready) below" });

qa(["TC-FUL-002", "TC-FUL-006"], "the shop marks the order READY and a rider is offered it automatically", async () => {
  const order = current();
  expect(await statusOf(order.id), "picking").toBe("PREPARING");
  expectStatus(await fulfil(order.id, "ready"), 200, "ready");
  expect(await statusOf(order.id)).toBe("READY");
  const offer = await offerFor(order.id, "rider");
  stash(KEY, { ...order, deliveryOrderId: offer.deliveryOrderId });
  return `READY; offer ${offer.deliveryOrderId} (${offer.status}) reached the rider`;
}, { ...signed, partial: "'without explicit picks' is this run (no line was picked); the all-picked variant is in fulfilment.spec.ts" });

qa("TC-ORD-007", "the customer cannot cancel at READY", async () => {
  const order = current();
  expect(await statusOf(order.id)).toBe("READY");
  const res = await call(await as("customer"), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED" });
  expect(res.status).toBe(409);
  return `cancel at READY → ${res.status}`;
}, signed);

qa(["TC-DEL-001", "TC-DEL-010"], "the rider accepts the offer: ASSIGNED; the rider's view carries no codes and no customer identity", async () => {
  const order = current();
  const id = order.deliveryOrderId ?? blocked("needs the delivery offer from TC-FUL-006");
  const res = await riderAction(id, "accept");
  expectStatus(res, 200, "rider accepts");
  expect(await statusOf(order.id)).toBe("ASSIGNED");
  const view = await call(await as("rider"), "GET", "/api/delivery-partner/deliveries");
  for (const text of [res.text, view.text]) {
    expect(text, "no pickup code in the rider's view").not.toMatch(/"pickupCode"\s*:\s*"\d/);
    expect(text, "no delivery code").not.toMatch(/"(deliveryOtp|deliveryOtpHash|handoverCode)"\s*:\s*"/);
  }
  expect(view.text).toMatch(/needsPickupCode|needsDeliveryOtp/);
  const cancel = await call(await as("customer"), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED" });
  expect(cancel.status, "customer cannot cancel at ASSIGNED (TC-ORD-007)").toBe(409);
  return "ASSIGNED; rider JSON has only needs* flags; customer cancel at ASSIGNED refused";
}, { ...signed, partial: "customer name/phone absence before pickup is asserted by TC-DEL-010 in rider.spec.ts with the page" });

qa("TC-DEL-004", "pickup: a wrong code is refused, the shop's code is accepted (PICKED_UP)", async () => {
  const order = current();
  const id = order.deliveryOrderId ?? blocked("needs the delivery from TC-DEL-001");
  const code = await pickupCode(order.id);
  if (!code) blocked("the packing slip shows no pickup code (QR-only pickup on this build)");
  const wrong = await riderAction(id, "pickup", { pickupCode: code === "0000" ? "1111" : "0000" });
  expect(wrong.status, "wrong pickup code").toBeGreaterThanOrEqual(400);
  const right = await riderAction(id, "pickup", { pickupCode: code });
  expectStatus(right, 200, "pickup with the shop's code");
  expect(await statusOf(order.id)).toBe("PICKED_UP");
  return `wrong code → ${wrong.status}; packing-slip code → PICKED_UP`;
}, { ...signed, partial: "shop and customer notifications are checked in notifications.spec.ts" });

qa(["TC-DEL-007", "TC-ORD-001"], "start and deliver with the customer's code: DELIVERED, wallet charged once", async () => {
  const order = current();
  const id = order.deliveryOrderId ?? blocked("needs the delivery from TC-DEL-001");
  expectStatus(await riderAction(id, "start"), 200, "start delivery");
  expect(await statusOf(order.id)).toBe("OUT_FOR_DELIVERY");
  const wrong = await riderAction(id, "deliver", { otp: "000000" });
  expect(wrong.status, "wrong delivery code").toBe(422);
  const otp = await deliveryCode(order.id);
  expectStatus(await riderAction(id, "deliver", { otp }), 200, "deliver with the customer's code");
  expect(await statusOf(order.id)).toBe("DELIVERED");
  if (order.startBalance !== undefined) expect(await walletBalance(), "charged exactly once").toBe(order.startBalance - order.totalPaise);
  return `${order.orderNumber}: CONFIRMED → ACCEPTED → PREPARING → READY → ASSIGNED → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED`;
}, { ...signed, partial: "rider earning, finance snapshot and per-step history rows are checked in finance.spec.ts and the local-tier audit checks" });

qa("TC-ORD-006", "the customer cancels a CONFIRMED order: full refund to the wallet, status cancelled/refunded", async () => {
  const start = await walletBalance();
  const order = await placeOrder({ method: "WALLET" });
  expect(order.status).toBe("CONFIRMED");
  const res = await call(await as("customer"), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA cancel" });
  expectStatus(res, 200, "cancel a confirmed order");
  const after = await statusOf(order.id);
  expect(["CANCELLED", "REFUNDED"], `status after cancel: ${after}`).toContain(after);
  expect(await walletBalance(), "full refund incl. delivery fee").toBe(start);
  return `${order.orderNumber} cancelled before acceptance → ${after}; wallet back to ${start}`;
}, { ...signed, partial: "stock return and the shop notification are checked in inventory.spec.ts" });

qa("TC-CART-011", "checkout with too little in the wallet is refused with the shortfall; no order, no debit", async () => {
  const listing = await sellable("A", 5, "priciest");
  const balance = await walletBalance();
  const price = listing.pricePaise ?? blocked("listing has no price");
  const quantity = Math.floor(balance / price) + 1;
  if (listing.stock !== undefined && quantity > listing.stock) blocked(`a basket above the wallet (${quantity} units) exceeds the stock (${listing.stock})`);
  if (quantity > 50) blocked(`the wallet (${balance} paise) needs ${quantity} units to exceed — too many for one cart line`);
  await emptyCart();
  expectStatus(await addToCart("customer", listing.shopProductId, quantity), [200, 201], "add a basket larger than the wallet");
  const address = await defaultAddress();
  const before = (await call(await as("customer"), "GET", "/api/orders")).body;
  const res = await call(await as("customer"), "POST", "/api/checkout", {
    requestId: `qa-${RUN}-short`,
    addressId: address?.id ?? null,
    paymentMethod: "WALLET",
    acknowledgeClosedShopIds: [listing.shopId],
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(402);
  expect(JSON.stringify(res.body)).toMatch(/INSUFFICIENT/i);
  expect(await walletBalance(), "no debit").toBe(balance);
  const afterOrders = (await call(await as("customer"), "GET", "/api/orders")).body;
  expect(JSON.stringify(afterOrders).length, "no new order").toBe(JSON.stringify(before).length);
  await emptyCart();
  return `basket of ${quantity} × ${price} > wallet ${balance}: 402 ${res.body?.error?.code}`;
}, { ...signed, partial: "the top-up prompt on the page is a UI check in cart-ui.spec.ts" });
