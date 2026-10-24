/**
 * Orders paid online at the payment gateway (TC-PAY-007, 017–021, 024, 025,
 * 028, 029, 033, 035) — as the customer and the shop see it, through the
 * site's own pages and APIs. Never real money: on the local server and on
 * test.gokesari.com with PAYMENT_GATEWAY unset the gateway is the SANDBOX
 * (/orders/pay/sandbox/<ref>: Pay / Fail / Let it expire post a signed webhook
 * through the real handler). Where a site sends payments to Cashfree's hosted
 * checkout instead, the paying checks block (pay through the "Sandbox
 * payment" workflow with the Cashfree sandbox test data).
 *
 * Signed tier: the checks only act as the test accounts on their own data.
 * Rule onlinePayments is OFF by default; on a LOCAL run only, the file's
 * beforeAll switches it on as an admin and afterAll restores it (on staging
 * the owner's setting is used and the checks block while it is off).
 */
import { as, pageAs } from "../lib/actors";
import { emptyCart, fulfil, sellable } from "../lib/flows";
import { call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import {
  checkoutNow,
  fillCart,
  intentView,
  notificationsOf,
  ONLINE_OFF,
  onlineCheckout,
  onlineStock,
  orderOf,
  ordersOf,
  paySandbox,
  putRule,
  restoreRule,
  ruleOf,
  runKey,
  sandboxPath,
  walletOf,
  type OnlineCheckout,
  type RuleRow,
} from "../lib/money-helpers";
import { blocked, expect, need, qa, test } from "../lib/record";
import { IS_LOCAL } from "../lib/target";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };
const KEY = runKey("online");

let ruleBefore: RuleRow | null = null;
test.beforeAll(async () => {
  if (!IS_LOCAL) return;
  ruleBefore = await ruleOf("onlinePayments");
  await putRule("onlinePayments", { ...ruleBefore.value, enabled: true });
});
test.afterAll(async () => {
  if (ruleBefore) await restoreRule(ruleBefore);
  ruleBefore = null;
});

function paid() {
  const order = unstash<OnlineCheckout & { listingId: string }>(KEY);
  if (!order) blocked("needs the order paid online by TC-PAY-017 in this run");
  return order;
}

qa("TC-PAY-007", "checkout offers Wallet, Cash on delivery (with the reason when not eligible) and Pay online — no dead option", async ({ browser }) => {
  const listing = await sellable("A");
  await fillCart("customer", [{ listing }]);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/cart");
    const pay = page.getByTestId("payment-method");
    await expect(pay).toBeVisible();
    // The "Pay with" field label wraps all three radios, so the wallet radio is found by its own label.
    const wallet = pay.locator("label").filter({ hasText: /^\s*Wallet\s*$/ }).getByRole("radio");
    await expect(wallet).toBeVisible();
    const cod = pay.getByRole("radio", { name: "Cash on delivery", exact: true });
    await expect(cod).toBeVisible();
    const online = pay.getByTestId("pay-online-option");
    if (!(await online.count())) blocked("'Pay online' is not offered on this site (rule onlinePayments off)");
    await expect(online).toContainText(/UPI.*card.*netbanking/i);
    // A disabled cash-on-delivery option must say why (shop not opted in, limits, no address).
    const codDisabled = await cod.isDisabled();
    if (codDisabled) await expect(pay).toContainText(/cash on delivery|wallet|address/i);
    await online.getByRole("radio").check();
    await expect(online.getByRole("radio")).toBeChecked();
    const button = page.getByRole("button", { name: /^(Pay|Place order)/ }).first();
    await expect(button).toBeEnabled();
    const label = (await button.textContent())?.trim() ?? "";
    await wallet.check();
    await expect(wallet).toBeChecked();
    return `options: Wallet, Cash on delivery (${codDisabled ? `disabled — "${(await pay.textContent())?.match(/[^.]*does not accept cash on delivery[^.]*\.|Cash on delivery is[^.]*\./)?.[0] ?? "reason shown"}"` : "enabled"}), Pay online (UPI / card / netbanking); with Pay online chosen the button reads "${label}"`;
  } finally {
    await context.close();
    await emptyCart("customer");
  }
}, { ...signed, mobile: true, partial: "each option is proven to work by its own case (TC-PAY-017 online, TC-COD-002 cash, TC-CART-009 wallet)" });

qa("TC-PAY-017", "pay an order by UPI on the gateway page: CONFIRMED + ONLINE, wallet untouched, stock reduced, shop alerted", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const walletBefore = (await walletOf("customer")).wallet.balancePaise;
  const stockBefore = await onlineStock(listing);
  await fillCart("customer", [{ listing, quantity: 2 }]);
  const { context, page } = await pageAs(browser, "customer");
  const since = Date.now();
  try {
    await page.goto("/cart");
    const online = page.getByTestId("pay-online-option");
    if (!(await online.count())) blocked("'Pay online' is not offered on this site (rule onlinePayments off)");
    await online.getByRole("radio").check();
    const checkoutRes = page.waitForResponse((r) => r.url().endsWith("/api/checkout") && r.request().method() === "POST");
    await page.getByRole("button", { name: /^(Pay|Place order)/ }).first().click();
    // The open-order and closed-shop questions come before the payment.
    for (const name of [/Ignore and continue/, /Yes, continue/]) {
      const b = page.getByRole("button", { name });
      if (await b.isVisible().catch(() => false)) await b.click();
    }
    const res = await checkoutRes;
    expect(res.status(), "checkout answered 201").toBe(201);
    await page.waitForURL(/\/orders\/pay\/sandbox\//, { timeout: 30_000 }).catch(() => undefined);
    const at = new URL(page.url()).pathname;
    const ret = await paySandbox(page, { redirectUrl: at }, "pay", "UPI");
    await expect(ret).toContainText("Payment received");
    const intentId = new URL(page.url()).searchParams.get("intent")!;
    const view0 = await intentView("customer", intentId);
    const payment = { intentId, status: view0.status, amountPaise: view0.amountPaise, redirectUrl: at, alreadyPaid: false };
    const body = { requestId: "", orders: view0.orders.map((o) => ({ ...o, shopId: listing.shopId, totalPaise: view0.amountPaise, paymentMethod: "ONLINE" })) };
    const order = body.orders[0];
    const row = await orderOf("customer", order.id);
    expect(row?.status, "order after a captured payment").toBe("CONFIRMED");
    expect(row?.paymentMethod).toBe("ONLINE");
    expect(row?.paidAt, "paid").toBeTruthy();
    expect((await walletOf("customer")).wallet.balancePaise, "wallet untouched").toBe(walletBefore);
    if (stockBefore !== undefined) expect(await onlineStock(listing), "stock reduced by 2").toBe(stockBefore - 2);
    const shopNotes = await notificationsOf("shop");
    const alert = shopNotes.notifications.find((n) => n.body.includes(order.orderNumber) && new Date(n.createdAt).getTime() >= since - 5000);
    expect(alert, `shop notified of ${order.orderNumber}`).toBeTruthy();
    const view = await intentView("customer", payment.intentId);
    expect(view.status).toBe("CAPTURED");
    expect(view.amountPaise, "one payment for the order total").toBe(order.totalPaise);
    stash(KEY, { requestId: "", orders: body.orders, payment, res: { status: 201, body: null, text: "", headers: {}, location: null }, listingId: listing.shopProductId });
    return `${order.orderNumber}: sandbox UPI → CAPTURED ₹${order.totalPaise / 100} → CONFIRMED/ONLINE; wallet ${walletBefore} unchanged; stock ${stockBefore ?? "untracked"} → ${stockBefore !== undefined ? stockBefore - 2 : "-"}; shop: "${alert!.title}"`;
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true, partial: "the gateway returns to /orders/payment-return (shows 'Payment received' and the order), not to the order's own page" });

qa("TC-PAY-018", "pay one order by card and another by netbanking: both CONFIRMED and paid", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const out: string[] = [];
  for (const method of ["Card", "Netbanking"] as const) {
    const checkout = await onlineCheckout("customer", [{ listing }]);
    const { context, page } = await pageAs(browser, "customer");
    try {
      const ret = await paySandbox(page, checkout.payment, "pay", method);
      await expect(ret).toContainText("Payment received");
    } finally {
      await context.close();
    }
    const row = await orderOf("customer", checkout.orders[0].id);
    expect(row?.status, `${method} order`).toBe("CONFIRMED");
    expect(row?.paymentMethod).toBe("ONLINE");
    expect(row?.paidAt).toBeTruthy();
    expect((await intentView("customer", checkout.payment.intentId)).status).toBe("CAPTURED");
    out.push(`${method}: ${checkout.orders[0].orderNumber} CONFIRMED`);
  }
  return out.join("; ");
}, signed);

qa("TC-PAY-019", "a declined payment: clear failure message, order not confirmed, stock released, retry pays the same order", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const stockBefore = await onlineStock(listing);
  const checkout = await onlineCheckout("customer", [{ listing }]);
  const order = checkout.orders[0];
  if (stockBefore !== undefined) expect(await onlineStock(listing), "stock held while paying").toBe(stockBefore - 1);
  const { context, page } = await pageAs(browser, "customer");
  try {
    const ret = await paySandbox(page, checkout.payment, "fail", "UPI");
    await expect(ret).toContainText("Payment failed");
    await expect(ret.getByTestId("retry-payment")).toBeVisible();
    const row = await orderOf("customer", order.id);
    expect(row?.status, "not confirmed").toBe("PAYMENT_FAILED");
    expect(row?.paidAt).toBeNull();
    if (stockBefore !== undefined) expect(await onlineStock(listing), "stock released").toBe(stockBefore);
    // Retry reuses the order: a new attempt, paid this time.
    await ret.getByTestId("retry-payment").click();
    await page.waitForURL(/\/orders\/pay\/sandbox\//);
    const box = page.getByTestId("sandbox-checkout");
    await box.getByLabel("UPI", { exact: true }).check();
    await box.getByTestId("sandbox-pay").click();
    await page.waitForURL(/\/orders\/payment-return/);
    await expect(page.getByTestId("payment-return")).toContainText("Payment received");
  } finally {
    await context.close();
  }
  const after = await orderOf("customer", order.id);
  expect(after?.status, "same order confirmed after retry").toBe("CONFIRMED");
  return `${order.orderNumber}: Fail → "Payment failed" + Retry, PAYMENT_FAILED, stock ${stockBefore} restored; Retry → paid → CONFIRMED`;
}, { ...signed, partial: "expected 'the cart is kept' is superseded by docs/payments-gateway-2026-10.md §2 / decision D-A07: checkout clears the cart and the order itself waits (PAYMENT_FAILED) for 'Retry payment'; switching that order to another method is not offered (cancel and re-order)" });

qa("TC-PAY-020", "an abandoned gateway page: no confirmed order and no charge; when the attempt expires the stock is released", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const walletBefore = (await walletOf("customer")).wallet.balancePaise;
  const stockBefore = await onlineStock(listing);
  const checkout = await onlineCheckout("customer", [{ listing }]);
  const order = checkout.orders[0];
  // The tab is closed: nothing is paid.
  let row = await orderOf("customer", order.id);
  expect(row?.status, "waiting for payment, not confirmed").toBe("PENDING");
  expect(row?.paidAt).toBeNull();
  const view = await intentView("customer", checkout.payment.intentId);
  expect(["CREATED", "PENDING"]).toContain(view.status);
  expect((await walletOf("customer")).wallet.balancePaise, "no charge").toBe(walletBefore);
  // Back on the site later: the gateway reports the attempt expired.
  const { context, page } = await pageAs(browser, "customer");
  try {
    const ret = await paySandbox(page, checkout.payment, "expire");
    await expect(ret).toContainText("Payment not completed in time");
  } finally {
    await context.close();
  }
  row = await orderOf("customer", order.id);
  expect(row?.status).toBe("PAYMENT_FAILED");
  if (stockBefore !== undefined) expect(await onlineStock(listing), "stock released").toBe(stockBefore);
  return `${order.orderNumber}: abandoned → PENDING, ${view.status}, no charge; gateway expiry → PAYMENT_FAILED, stock ${stockBefore ?? "-"} back`;
}, { ...signed, partial: "expiry is the gateway's 'Let it expire' here; the time-based expiry by the reconciliation job is TC-PAY-020 in tests/qa/local/money-gateway.spec.ts. 'The cart is still there' is superseded (D-A07: the order waits for Retry payment)" });

qa("TC-PAY-021", "a forged or replayed return cannot confirm an order: unknown intent, another customer's intent, replay of a paid one", async ({ browser }) => {
  const order = paid();
  const made = "00000000-0000-4000-8000-000000000000";
  const own = await call(await as("customer"), "GET", `/api/payments/intents/${made}`);
  expect(own.status, "made-up payment id").toBe(404);
  const other = await call(await as("customer2"), "GET", `/api/payments/intents/${order.payment.intentId}`);
  expect(other.status, "another customer's payment").toBe(404);
  const retry = await call(await as("customer"), "POST", `/api/orders/${order.orders[0].id}/pay`, {});
  expectStatus(retry, 200, "pay again for a paid order");
  expect(retry.body.alreadyPaid, "already paid — no second attempt").toBe(true);
  expect(retry.body.redirectUrl).toBeNull();
  const { context, page } = await pageAs(browser, "customer");
  try {
    const ret = await page.goto(`/orders/payment-return?intent=${made}`);
    expect(ret?.status(), "return page for a made-up intent").toBe(404);
    await page.goto(`/orders/payment-return?intent=${order.payment.intentId}`);
    await expect(page.getByTestId("payment-return")).toContainText("Payment received");
  } finally {
    await context.close();
  }
  const list = (await ordersOf("customer")).filter((o) => o.id === order.orders[0].id);
  expect(list.length, "still one order").toBe(1);
  return `made-up intent → 404 (API and page); customer2 reading customer's intent → 404; pay again → alreadyPaid, no new attempt; replayed return shows the same paid order`;
}, { ...signed, partial: "'the server verifies status and amount with the gateway' (a changed amount never confirms) is TC-PAY-021 in tests/qa/local/money-gateway.spec.ts (needs the gateway ledger)" });

qa("TC-PAY-024", "the same order paid from two tabs: one order and one captured payment", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const checkout = await onlineCheckout("customer", [{ listing }]);
  const replay = await checkoutNow("customer", "ONLINE", [listing.shopId], {}, checkout.requestId);
  expectStatus(replay.res, [200, 201], "second tab's checkout (same attempt)");
  expect(replay.res.body.deduplicated, "same checkout").toBe(true);
  expect(replay.res.body.payment?.intentId ?? checkout.payment.intentId, "same payment").toBe(checkout.payment.intentId);
  const path = sandboxPath(checkout.payment);
  const a = await pageAs(browser, "customer");
  const b = await pageAs(browser, "customer");
  try {
    await a.page.goto(path);
    await b.page.goto(path);
    await a.page.getByTestId("sandbox-pay").click();
    await a.page.waitForURL(/payment-return/);
    await b.page.getByTestId("sandbox-pay").click();
    await b.page.waitForURL(/payment-return/);
    await expect(b.page.getByTestId("payment-return")).toContainText("Payment received");
  } finally {
    await a.context.close();
    await b.context.close();
  }
  const view = await intentView("customer", checkout.payment.intentId);
  expect(view.status).toBe("CAPTURED");
  expect(view.orders.map((o) => o.id)).toEqual([checkout.orders[0].id]);
  const mine = (await ordersOf("customer")).filter((o) => o.id === checkout.orders[0].id || o.orderNumber === checkout.orders[0].orderNumber);
  expect(mine.length, "one order").toBe(1);
  return `${checkout.orders[0].orderNumber}: second tab's checkout → same intent (deduplicated); Pay in both tabs → one CAPTURED payment, one order`;
}, { ...signed, partial: "one captured payment is read from the customer's payment view; the gateway ledger itself is checked in the local tier (TC-PAY-022)" });


qa("TC-PAY-025", "a cart from shop A and shop B paid online once: one payment for the full amount, one order per shop, each shop sees only its own", async ({ browser }) => {
  need(world().shops.B, "a second shop (shop B) in this site's test data");
  const a = await sellable("A", 3);
  const b = await sellable("B", 3);
  const checkout = await onlineCheckout("customer", [{ listing: a }, { listing: b }]);
  expect(checkout.orders.length, "one order per shop").toBe(2);
  const total = checkout.orders.reduce((n, o) => n + o.totalPaise, 0);
  expect(checkout.payment.amountPaise, "one payment for the full amount").toBe(total);
  const { context, page } = await pageAs(browser, "customer");
  try {
    const ret = await paySandbox(page, checkout.payment, "pay");
    await expect(ret).toContainText("Payment received");
  } finally {
    await context.close();
  }
  const rows = await Promise.all(checkout.orders.map((o) => orderOf("customer", o.id)));
  for (const row of rows) {
    expect(row?.status, `${row?.orderNumber}`).toBe("CONFIRMED");
    expect(row?.orderGroupId, "one master reference").toBeTruthy();
  }
  expect(rows[0]?.orderGroupId).toBe(rows[1]?.orderGroupId);
  const view = await intentView("customer", checkout.payment.intentId);
  expect(view.orders.length, "the one payment covers both orders").toBe(2);
  const orderA = checkout.orders.find((o) => o.shopId === a.shopId)!;
  const orderB = checkout.orders.find((o) => o.shopId === b.shopId)!;
  const pageA = await call(await as("shop"), "GET", "/shop/orders", undefined, { maxRedirects: 3 });
  expectStatus(pageA, 200, "shop A's order list");
  expect(pageA.text, "shop A sees its order").toContain(orderA.orderNumber);
  expect(pageA.text, "shop A does not see shop B's order").not.toContain(orderB.orderNumber);
  const foreign = await fulfil(orderB.id, "accept", {}, "shop");
  expect([403, 404], `shop A acting on shop B's order — ${why(foreign)}`).toContain(foreign.status);
  return `one ORDER_GROUP payment ₹${total / 100} → ${orderA.orderNumber} (A) + ${orderB.orderNumber} (B) CONFIRMED, same group; shop A's list shows only its order, acting on B's → ${foreign.status}`;
}, { ...signed, partial: "shop B's own view is the mirror of shop A's and is not opened separately" });

qa("TC-PAY-028", "cancelling an online-paid order before the shop accepts refunds the original method in full, with a reference; stock restored", async () => {
  const order = paid();
  const id = order.orders[0].id;
  const listing = { shopId: order.orders[0].shopId, shopProductId: order.listingId };
  const walletBefore = (await walletOf("customer")).wallet.balancePaise;
  const stockBefore = await onlineStock(listing);
  const res = await call(await as("customer"), "PATCH", `/api/orders/${id}/status`, { status: "CANCELLED", note: "QA online cancel" });
  expectStatus(res, 200, "cancel the paid online order");
  let row = await orderOf("customer", id);
  for (let i = 0; i < 20 && row?.status !== "REFUNDED"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    row = await orderOf("customer", id);
  }
  expect(["REFUND_PENDING", "REFUNDED"], `status after cancel: ${row?.status}`).toContain(row?.status);
  expect((await walletOf("customer")).wallet.balancePaise, "nothing to the wallet: the refund goes to the source").toBe(walletBefore);
  const refunds = await call(await as("customer"), "GET", `/api/orders/${id}/refunds`);
  expectStatus(refunds, 200, "the order's refunds");
  const refund = (refunds.body.refunds as { method: string; status: string; amountPaise: number; timeline: { status: string; note: string | null }[] }[])[0];
  expect(refund, `a refund record in ${refunds.text.slice(0, 300)}`).toBeTruthy();
  expect(refund.method, "refunded to the original method").toMatch(/ORIGINAL|GATEWAY|SOURCE/i);
  expect(refund.amountPaise, "full amount").toBe(order.orders[0].totalPaise);
  const view = await intentView("customer", order.payment.intentId);
  expect(["REFUNDED", "PARTIALLY_REFUNDED"]).toContain(view.status);
  expect(view.refundedPaise).toBe(order.orders[0].totalPaise);
  if (stockBefore !== undefined) expect(await onlineStock(listing), "stock restored").toBe(stockBefore + 2);
  const timeline = refund.timeline.map((t) => `${t.status}${t.note ? ` (${t.note})` : ""}`).join(" → ");
  return `${order.orders[0].orderNumber}: cancel → ${row?.status}; refund ${refund.method} ₹${refund.amountPaise / 100} ${refund.status}; payment ${view.status}; timeline ${timeline}; wallet unchanged`;
}, { ...signed, partial: "the 'expected time' text is read from the refund timeline notes when present; the bank-side settlement time is the gateway's" });

qa("TC-PAY-029", "the shop removes one line of an online-paid order: that line's exact amount goes back to the source", async ({ browser }) => {
  const one = await sellable("A", 3);
  const two = await (async () => {
    const l = world().listings.sharedA;
    return l ? { ...l, shopId: one.shopId, shopName: one.shopName } : null;
  })();
  if (!two) blocked("needs a second sellable product at shop A (sharedA)");
  const checkout = await onlineCheckout("customer", [{ listing: one }, { listing: two }]);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await expect(await paySandbox(page, checkout.payment, "pay")).toContainText("Payment received");
  } finally {
    await context.close();
  }
  const order = checkout.orders[0];
  const walletBefore = (await walletOf("customer")).wallet.balancePaise;
  expectStatus(await fulfil(order.id, "accept"), 200, "shop accepts");
  expectStatus(await fulfil(order.id, "start"), 200, "shop starts picking");
  const lineTotal = (two.pricePaise ?? 0) * 1;
  const shopPage = await pageAs(browser, "shop");
  try {
    await shopPage.page.goto("/shop/orders?status=packing");
    const card = shopPage.page.getByTestId("shop-order").filter({ hasText: order.orderNumber }).first();
    await expect(card).toBeVisible();
    const row = card.getByRole("listitem").filter({ hasText: two.name }).first();
    const done = shopPage.page.waitForResponse((r) => r.url().includes(`/api/orders/${order.id}/fulfilment`) && r.request().method() === "POST");
    await row.getByRole("button", { name: /Unavailable — remove/ }).click();
    const res = await done;
    expect(res.status(), `remove a line from the online-paid order: ${await res.text()}`).toBe(200);
  } finally {
    await shopPage.context.close();
  }
  const refunds = await call(await as("customer"), "GET", `/api/orders/${order.id}/refunds`);
  const view = await intentView("customer", checkout.payment.intentId);
  expect(view.refundedPaise, `refunded to the source: ${refunds.text.slice(0, 200)}`).toBe(lineTotal);
  expect((await walletOf("customer")).wallet.balancePaise, "not to the wallet").toBe(walletBefore);
  return `${order.orderNumber}: line ${lineTotal} paise removed → payment refunded ${view.refundedPaise} paise (${view.status})`;
}, { ...signed, partial: "the cheaper-substitute and approved-return differences are not run here" });

qa("TC-PAY-033", "the smallest order the shop allows can be paid online", async ({ browser }) => {
  const listing = await sellable("A", 1, "cheapest");
  const checkout = await onlineCheckout("customer", [{ listing }]);
  expect(checkout.payment.amountPaise).toBe(checkout.orders[0].totalPaise);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await expect(await paySandbox(page, checkout.payment, "pay")).toContainText("Payment received");
  } finally {
    await context.close();
  }
  expect((await orderOf("customer", checkout.orders[0].id))?.status).toBe("CONFIRMED");
  return `one ${listing.name} (₹${checkout.payment.amountPaise / 100}) paid online and confirmed`;
}, { ...signed, partial: "'above the gateway maximum the customer is told before payment starts' is not testable: no maximum is configured (rule onlinePayments has no amount cap and the sandbox accepts any amount) — owner to set the cap the live gateway enforces" });

qa("TC-PAY-035", "online payment is not started for an order that cannot be placed (out of zone, out of stock, paused shop, under the minimum)", async () => {
  const listing = await sellable("A", 3);
  const shopId = listing.shopId;
  const out: string[] = [];
  const attempt = async (what: string, role: "customer" | "customer2" = "customer") => {
    const intentsBefore = (await ordersOf(role)).filter((o) => o.paymentMethod === "ONLINE").length;
    const { res } = await checkoutNow(role, "ONLINE", [shopId]);
    if (res.status === 409 && ONLINE_OFF.test(why(res))) blocked("online payment is off on this site");
    expect(res.status, `${what}: ${why(res)}`).toBeGreaterThanOrEqual(400);
    expect(res.status, `${what}: no server error`).toBeLessThan(500);
    expect(res.body?.payment, `${what}: no payment started`).toBeFalsy();
    const intentsAfter = (await ordersOf(role)).filter((o) => o.paymentMethod === "ONLINE").length;
    expect(intentsAfter, `${what}: no online order created`).toBe(intentsBefore);
    out.push(`${what} → ${res.status} "${(res.body?.error?.message ?? "").slice(0, 90)}"`);
  };
  // 1. Out-of-zone address: a saved address at a PIN no shop of the world delivers to.
  const outside = world().outsidePincode;
  if (outside) {
    const added = await call(await as("customer"), "POST", "/api/addresses", { label: `QA far ${RUN}`, line1: "QA far address", area: "Wakad", city: "Pune", pincode: outside, latitude: 18.5975, longitude: 73.7637, isDefault: false });
    expectStatus(added, [200, 201], "save an out-of-zone address");
    const farId = added.body?.id ?? added.body?.address?.id;
    try {
      await fillCart("customer", [{ listing }]);
      const intentsBefore = (await ordersOf("customer")).filter((o) => o.paymentMethod === "ONLINE").length;
      const { res } = await checkoutNow("customer", "ONLINE", [shopId], { addressId: farId });
      expect(res.status, `out-of-zone: ${why(res)}`).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body?.payment, "out-of-zone: no payment started").toBeFalsy();
      expect((await ordersOf("customer")).filter((o) => o.paymentMethod === "ONLINE").length).toBe(intentsBefore);
      out.push(`out-of-zone address (${outside}) → ${res.status} "${(res.body?.error?.message ?? "").slice(0, 90)}"`);
    } finally {
      if (farId) await call(await as("customer"), "DELETE", `/api/addresses/${farId}`);
    }
  }
  // 2. Paused shop and 3. under the minimum — the shop owner's own settings, restored after.
  const shop = await call(await as("shop"), "GET", `/api/shops/${shopId}`);
  const before = { ordersPaused: Boolean(shop.body?.ordersPaused ?? shop.body?.shop?.ordersPaused), minOrderPaise: Number(shop.body?.minOrderPaise ?? shop.body?.shop?.minOrderPaise ?? 0) };
  try {
    await fillCart("customer", [{ listing }]);
    expectStatus(await call(await as("shop"), "PATCH", `/api/shops/${shopId}`, { ordersPaused: true }), 200, "shop pauses orders");
    await attempt("paused shop");
    expectStatus(await call(await as("shop"), "PATCH", `/api/shops/${shopId}`, { ordersPaused: before.ordersPaused, minOrderPaise: (listing.pricePaise ?? 0) * 5 }), 200, "shop sets a minimum order");
    await attempt("total under the minimum order");
    expectStatus(await call(await as("shop"), "PATCH", `/api/shops/${shopId}`, { minOrderPaise: before.minOrderPaise }), 200, "restore the minimum");
    // 4. Out of stock: the shop's last units went while the line sat in the cart.
    const low = world().listings.lowStock;
    if (low) {
      await fillCart("customer", [{ listing: { ...low, shopId, shopName: listing.shopName }, quantity: 2 }]);
      const inv = await call(await as("shop"), "PATCH", `/api/shop-products/${low.shopProductId}`, { onlineStock: 0 });
      if (inv.status === 200) {
        await attempt("out-of-stock line");
        await call(await as("shop"), "PATCH", `/api/shop-products/${low.shopProductId}`, { onlineStock: low.stock ?? 2 });
      } else out.push(`out-of-stock: could not set the stock to 0 as the shop (${inv.status})`);
    }
  } finally {
    await call(await as("shop"), "PATCH", `/api/shops/${shopId}`, before);
    await emptyCart("customer");
  }
  return out.join("; ");
}, { ...signed, partial: "a suspended shop is TC-PAY-035 in tests/qa/local/money-gateway.spec.ts (suspending is an operator action)" });
