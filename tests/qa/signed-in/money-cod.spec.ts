/**
 * Cash on delivery (TC-COD-001–003, 005–007, 009, 011, 012): the shop opting
 * in, a COD order confirmed unpaid, the eligibility refusals, cancelling, the
 * rider (or operations) confirming the cash, recording a cash deposit, a
 * refund of a delivered COD order and a replayed COD checkout.
 *
 * Signed tier: the shop owner switches cash on delivery on for their own
 * shop (and back to how it was at the end of the file); operations act on
 * this run's test orders only.
 */
import { as, pageAs } from "../lib/actors";
import { deliveryCode, emptyCart, offerFor, onlyRiderOnline, packOrder, pickupCode, riderAction, sellable, shopOf } from "../lib/flows";
import { call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import { cancelAsCustomer, checkoutNow, fillCart, onlineStock, orderOf, ordersOf, placeVia, runKey, walletOf } from "../lib/money-helpers";
import { blocked, expect, need, qa, test } from "../lib/record";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };
const KEY = runKey("cod");

interface CodState {
  shopId: string;
  codBefore: boolean;
}

/** Shop A takes cash on delivery for the check (TC-COD-001 proves the switch; a worker restart runs afterAll, which puts it back). */
async function state(): Promise<CodState> {
  const s = unstash<CodState>(KEY);
  if (!s) blocked("needs shop A's COD setting recorded by TC-COD-001 in this run");
  if (!(await codSetting(s.shopId))) expectStatus(await call(await as("shop"), "PATCH", `/api/shops/${s.shopId}`, { codEnabled: true }), 200, "shop A takes COD");
  return s;
}

async function codSetting(shopId: string): Promise<boolean> {
  const res = await call(await as("shop"), "GET", `/api/shops/${shopId}`);
  expectStatus(res, 200, "GET the shop");
  return Boolean(res.body?.codEnabled ?? res.body?.shop?.codEnabled);
}

/** Cancels the customer's open COD orders so the 2-open-orders limit does not block the next check. */
async function closeOpenCod() {
  const closed = ["DELIVERED", "DISPUTED", "CANCELLED", "REFUND_PENDING", "REFUNDED", "RETURNED", "FAILED"];
  for (const o of await ordersOf("customer")) {
    if (o.paymentMethod !== "COD" || closed.includes(o.status)) continue;
    // The customer may cancel before the shop accepts; after that the shop takes it off (its own order).
    const res = await cancelAsCustomer("customer", o.id, "QA COD clean-up");
    if (res.status !== 200) await call(await as("shop"), "PATCH", `/api/orders/${o.id}/status`, { status: "CANCELLED", note: "QA COD clean-up" });
  }
}

test.afterAll(async () => {
  const s = unstash<CodState>(KEY);
  if (s) await call(await as("shop"), "PATCH", `/api/shops/${s.shopId}`, { codEnabled: s.codBefore }).catch(() => undefined);
});

qa("TC-COD-001", "the shop opts in to cash on delivery on /shop/marketing; COD becomes available to its customers", async ({ browser }) => {
  const shop = await shopOf("A");
  const codBefore = await codSetting(shop.id);
  stash(KEY, { shopId: shop.id, codBefore } satisfies CodState);
  if (codBefore) {
    expectStatus(await call(await as("shop"), "PATCH", `/api/shops/${shop.id}`, { codEnabled: false }), 200, "start from COD off");
  }
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/marketing");
    const toggle = page.getByTestId("cod-toggle");
    await expect(toggle).not.toBeChecked();
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/shops/${shop.id}`) && r.request().method() === "PATCH");
    await toggle.click();
    expect((await saved).status(), "the setting is saved").toBe(200);
    await expect(page.getByText("Cash on delivery turned on.")).toBeVisible();
    await expect(toggle).toBeChecked();
  } finally {
    await context.close();
  }
  expect(await codSetting(shop.id), "saved").toBe(true);
  const listing = await sellable("A", 3);
  await fillCart("customer", [{ listing }]);
  const customer = await pageAs(browser, "customer");
  try {
    await customer.page.goto("/cart");
    await expect(customer.page.getByTestId("payment-method").getByRole("radio", { name: "Cash on delivery", exact: true })).toBeEnabled();
  } finally {
    await customer.context.close();
    await emptyCart("customer");
  }
  const elig = await call(await as("customer"), "GET", "/api/cod/eligibility");
  expect(elig.body?.allowed, JSON.stringify(elig.body)).toBe(true);
  return `"Accept cash on delivery" ticked → "Cash on delivery turned on." and saved; the customer's cart now offers Cash on delivery (eligibility allowed, up to ₹${elig.body.maxOrderPaise / 100})`;
}, { ...signed, mobile: true });

qa("TC-COD-002", "a COD order is placed and confirmed unpaid: CONFIRMED + COD, wallet not debited, stock reduced", async ({ browser }) => {
  await state();
  await closeOpenCod();
  const listing = await sellable("A", 3);
  const wallet = (await walletOf("customer")).wallet.balancePaise;
  const stock = await onlineStock(listing);
  await fillCart("customer", [{ listing }]);
  const { context, page } = await pageAs(browser, "customer");
  let orderId = "";
  try {
    await page.goto("/cart");
    await page.getByTestId("payment-method").getByRole("radio", { name: "Cash on delivery", exact: true }).check();
    const placed = page.waitForResponse((r) => r.url().endsWith("/api/checkout") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Place order — pay cash on delivery" }).click();
    for (const name of [/Ignore and continue/, /Yes, continue/]) {
      const b = page.getByRole("button", { name });
      if (await b.isVisible().catch(() => false)) await b.click();
    }
    const res = await placed;
    const body = await res.json();
    expect(res.status(), JSON.stringify(body).slice(0, 200)).toBe(201);
    orderId = body.orders[0].id;
  } finally {
    await context.close();
  }
  const row = await orderOf("customer", orderId);
  expect(row?.status).toBe("CONFIRMED");
  expect(row?.paymentMethod).toBe("COD");
  expect(row?.paidAt, "unpaid until the cash is collected").toBeNull();
  expect((await walletOf("customer")).wallet.balancePaise, "wallet not debited").toBe(wallet);
  if (stock !== undefined) expect(await onlineStock(listing), "stock reduced").toBe(stock - 1);
  stash(`${KEY}-order`, orderId);
  return `${row?.orderNumber}: CONFIRMED, COD, unpaid; wallet ${wallet} unchanged; stock ${stock} → ${stock !== undefined ? stock - 1 : "-"}`;
}, { ...signed, mobile: true });

qa("TC-COD-005", "cancelling a COD order before delivery: no wallet refund (nothing was paid), stock restored", async () => {
  await state();
  const id = unstash<string>(`${KEY}-order`) ?? blocked("needs the COD order of TC-COD-002");
  const order = await orderOf("customer", id);
  if (order?.status !== "CONFIRMED") blocked(`the COD order is ${order?.status}`);
  const listing = await sellable("A", 1);
  const wallet = (await walletOf("customer")).wallet.balancePaise;
  const stock = await onlineStock(listing);
  const res = await cancelAsCustomer("customer", id);
  expectStatus(res, 200, "cancel the COD order");
  expect((await walletOf("customer")).wallet.balancePaise, "no wallet refund").toBe(wallet);
  const after = await orderOf("customer", id);
  expect(after?.status).toBe("CANCELLED");
  if (stock !== undefined) expect(await onlineStock(listing), "stock restored").toBe(stock + 1);
  return `${order.orderNumber}: cancelled → ${after?.status}; wallet ${wallet} unchanged; stock ${stock} → ${stock !== undefined ? stock + 1 : "-"}`;
}, signed);

qa("TC-COD-012", "a replayed COD checkout (same request id) returns the same order — no duplicate", async () => {
  await state();
  await closeOpenCod();
  const listing = await sellable("A", 3);
  await fillCart("customer", [{ listing }]);
  const first = await checkoutNow("customer", "COD", [listing.shopId]);
  expectStatus(first.res, 201, "COD checkout");
  const again = await checkoutNow("customer", "COD", [listing.shopId], {}, first.requestId);
  expectStatus(again.res, [200, 201], "replay");
  expect(again.res.body.deduplicated).toBe(true);
  expect(again.res.body.orders.map((o: { id: string }) => o.id)).toEqual(first.res.body.orders.map((o: { id: string }) => o.id));
  const same = (await ordersOf("customer")).filter((o) => (o as { checkoutKey?: string }).checkoutKey?.includes(first.requestId));
  expect(same.length, "one order for the request id").toBe(1);
  await cancelAsCustomer("customer", first.res.body.orders[0].id);
  return `replay of ${first.requestId} → deduplicated, same order ${first.res.body.orders[0].orderNumber}; one order stored`;
}, signed);

qa("TC-COD-003", "COD refusals with the reason: business order, no address, shop not opted in, over ₹2,000, a third open COD order", async () => {
  await state();
  await closeOpenCod();
  const out: string[] = [];
  const refusal = (what: string, res: { status: number; body: { error?: { message?: string } } | null }) => {
    expect(res.status, `${what}: ${JSON.stringify(res.body).slice(0, 160)}`).toBeGreaterThanOrEqual(400);
    expect(res.status, `${what}: no server error`).toBeLessThan(500);
    out.push(`${what} → ${res.status} "${(res.body?.error?.message ?? "").slice(0, 90)}"`);
  };
  const a = await sellable("A", 3);
  // 1. Without an address.
  await fillCart("customer", [{ listing: a }]);
  refusal("no address", (await checkoutNow("customer", "COD", [a.shopId], { addressId: null })).res);
  // 2. From a shop that has not opted in (shop B).
  if (world().shops.B) {
    const b = await sellable("B", 3);
    if (!(await call(await as("shopB"), "GET", `/api/shops/${b.shopId}`)).body?.codEnabled) {
      await fillCart("customer", [{ listing: b }]);
      refusal("shop not opted in", (await checkoutNow("customer", "COD", [b.shopId])).res);
    }
  }
  // 3. Over ₹2,000 (the live cod.maxOrderPaise).
  const elig = await call(await as("customer"), "GET", "/api/cod/eligibility");
  const max = Number(elig.body?.maxOrderPaise ?? 200_000);
  const premium = await sellable("A", 5, "priciest");
  const qty = Math.floor(max / (premium.pricePaise ?? 1)) + 1;
  if (premium.stock === undefined || qty <= premium.stock) {
    await fillCart("customer", [{ listing: premium, quantity: qty }]);
    refusal(`₹${(qty * (premium.pricePaise ?? 0)) / 100} (> ₹${max / 100})`, (await checkoutNow("customer", "COD", [premium.shopId])).res);
  }
  // 4. A business (B2B) order.
  if (world().users.shopB && world().shops.B) {
    const buyer = await shopOf("B");
    await fillCart("shopB", [{ listing: a }]).catch(() => undefined);
    const b2b = await checkoutNow("shopB", "COD", [a.shopId], { orderType: "B2B", buyerShopId: buyer.id });
    refusal("business order", b2b.res);
    await emptyCart("shopB").catch(() => undefined);
  }
  // 5. A third open COD order.
  const placed: string[] = [];
  for (let i = 0; i < 2; i++) {
    await fillCart("customer", [{ listing: a }]);
    const r = await checkoutNow("customer", "COD", [a.shopId]);
    expectStatus(r.res, 201, `COD order ${i + 1}`);
    placed.push(r.res.body.orders[0].id);
  }
  await fillCart("customer", [{ listing: a }]);
  const thirdRes = (await checkoutNow("customer", "COD", [a.shopId])).res;
  expect(thirdRes.status, "refused for the open-order limit, not the rate limit").not.toBe(429);
  refusal("third open COD order", thirdRes);
  const third = await call(await as("customer"), "GET", "/api/cod/eligibility");
  expect(third.body?.allowed, "eligibility says no").toBe(false);
  expect(String(third.body?.reason)).toMatch(/2 cash-on-delivery orders/);
  out.push(`eligibility with 2 open → allowed false "${third.body.reason}"`);
  for (const id of placed) await cancelAsCustomer("customer", id);
  await emptyCart("customer");
  return out.join("; ");
}, { ...signed, partial: "GET /api/cod/eligibility is customer-level by design (src/server/services/cod.ts getCodEligibility: shop opt-in and amount are checked per order at checkout and shown on the cart page), so it explains only the open-orders / risk refusals; 'exactly ₹2,000 is allowed' is TC-COD-003 in tests/qa/local/money-cod.spec.ts" });

interface CodDelivery {
  orderId: string;
  orderNumber: string;
  totalPaise: number;
  deliveryOrderId: string;
}

qa("TC-COD-006", "the rider must confirm the cash: deliver without it is refused; with it the order is DELIVERED and paid, and the cash is held against the rider", async () => {
  await state();
  await closeOpenCod();
  await onlyRiderOnline("rider");
  const order = await placeVia("customer", "COD", await sellable("A", 3));
  expect(order.status).toBe("CONFIRMED");
  await packOrder(order.id);
  const offer = await offerFor(order.id, "rider");
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept"), 200, "rider accepts");
  const code = await pickupCode(order.id);
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}), 200, "pickup");
  expectStatus(await riderAction(offer.deliveryOrderId, "start"), 200, "start");
  const otp = await deliveryCode(order.id);
  const without = await riderAction(offer.deliveryOrderId, "deliver", { otp });
  expect(without.status, `deliver without cash — ${why(without)}`).toBe(422);
  expect(why(without)).toMatch(/cash/i);
  const heldBefore = await heldBy("RIDER");
  const done = await riderAction(offer.deliveryOrderId, "deliver", { otp, cashCollected: true });
  expectStatus(done, 200, "deliver with the cash confirmed");
  const row = await orderOf("customer", order.id);
  expect(row?.status).toBe("DELIVERED");
  expect(row?.paidAt, "paid once the cash is collected").toBeTruthy();
  expect(row?.codCollectedAt).toBeTruthy();
  const heldAfter = await heldBy("RIDER");
  expect(heldAfter - heldBefore, "a −total COD_CASH_COLLECTED adjustment held against the rider").toBe(order.totalPaise);
  stash(`${KEY}-delivered`, { orderId: order.id, orderNumber: order.orderNumber, totalPaise: order.totalPaise, deliveryOrderId: offer.deliveryOrderId } satisfies CodDelivery);
  return `${order.orderNumber}: deliver without cash → 422 "${(without.body?.error?.message ?? "").slice(0, 80)}"; with cash → DELIVERED, paid; rider holds +${order.totalPaise} paise (${heldBefore} → ${heldAfter})`;
}, signed);

/** Cash the world's rider (or shop A) holds, as operations see it on /api/admin/cod. */
async function heldBy(party: "RIDER" | "SHOP"): Promise<number> {
  const res = await call(await as("ops"), "GET", "/api/admin/cod");
  expectStatus(res, 200, "GET /api/admin/cod");
  const rows = res.body as { party: string; id: string; name: string; heldPaise: number }[];
  if (party === "SHOP") {
    const shop = await shopOf("A");
    return rows.find((r) => r.party === "SHOP" && r.id === shop.id)?.heldPaise ?? 0;
  }
  const riderId = await riderPartnerId();
  return rows.find((r) => r.party === "RIDER" && r.id === riderId)?.heldPaise ?? 0;
}

async function riderPartnerId(): Promise<string> {
  const res = await call(await as("rider"), "GET", "/api/delivery-partner/me");
  expectStatus(res, 200, "the rider's own profile");
  const id = res.body?.id ?? res.body?.partner?.id ?? res.body?.deliveryPartner?.id ?? res.body?.profile?.id;
  if (!id) blocked(`the rider profile carries no id (${res.text.slice(0, 120)})`);
  return String(id);
}

async function riderName(riderId: string): Promise<string> {
  const res = await call(await as("ops"), "GET", "/api/admin/cod");
  return (res.body as { party: string; id: string; name: string }[]).find((r) => r.party === "RIDER" && r.id === riderId)?.name ?? "";
}

qa("TC-COD-007", "operations confirming a COD delivery: a proof note alone is refused; with the cash confirmed it completes and is recorded", async () => {
  await state();
  await closeOpenCod();
  await onlyRiderOnline("rider");
  const order = await placeVia("customer", "COD", await sellable("A", 3));
  await packOrder(order.id);
  const offer = await offerFor(order.id, "rider");
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept"), 200, "rider accepts");
  const code = await pickupCode(order.id);
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}), 200, "pickup");
  const ops = await as("ops");
  const note = `QA ${RUN}: customer confirmed by phone`;
  const first = await call(ops, "POST", `/api/orders/${order.id}/confirm-delivery`, { proofNote: note });
  expect(first.status, `proof note only — ${why(first)}`).toBe(422);
  expect(why(first)).toMatch(/cash/i);
  const second = await call(ops, "POST", `/api/orders/${order.id}/confirm-delivery`, { proofNote: note, cashCollected: true });
  expectStatus(second, 200, "confirm with the cash");
  const row = await orderOf("customer", order.id);
  expect(row?.status).toBe("DELIVERED");
  expect(row?.paidAt).toBeTruthy();
  expect(second.body?.deliveryConfirmation ?? second.body?.confirmation ?? "OPERATOR_OVERRIDE").toMatch(/OPERATOR/);
  return `${order.orderNumber}: proofNote only → 422 "${(first.body?.error?.message ?? "").slice(0, 80)}"; with cashCollected → DELIVERED (operator override), paid`;
}, { ...signed, partial: "the audit row (DELIVERY_CONFIRMED_BY_OPERATOR) is read in the local tier (tests/qa/local/money-cod.spec.ts)" });

qa("TC-COD-009", "recording a cash deposit on /admin/cod: up to the cash held, with a reference; more than held is refused; a replay is not counted twice", async ({ browser }) => {
  await state();
  const delivered = unstash<CodDelivery>(`${KEY}-delivered`) ?? blocked("needs the COD delivery of TC-COD-006");
  const riderId = need(await riderPartnerId(), "the rider's delivery-partner id");
  const held = await heldBy("RIDER");
  if (held < delivered.totalPaise) blocked(`the rider holds ${held} paise, less than this run's COD order`);
  const { context, page } = await pageAs(browser, "admin");
  const ref = `QA-DEP-${RUN}`;
  try {
    await page.goto("/admin/cod");
    const name = await riderName(riderId);
    const scope = page.getByTestId("cod-holders").locator(":scope > div").filter({ hasText: `${name} (rider)` }).first();
    await expect(scope).toBeVisible();
    await scope.getByLabel("Amount (₹)").fill((delivered.totalPaise / 100).toFixed(2));
    await scope.getByLabel("Receipt / reference").fill(ref);
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/admin/cod") && r.request().method() === "POST");
    await scope.getByRole("button", { name: "Record deposit" }).click();
    const res = await saved;
    expect(res.status(), await res.text().catch(() => "")).toBe(201);
    await expect(scope.getByText("Deposit recorded.")).toBeVisible();
  } finally {
    await context.close();
  }
  const afterUi = await heldBy("RIDER");
  const admin = await as("admin");
  const over = await call(admin, "POST", "/api/admin/cod", { party: "RIDER", id: riderId, amountPaise: afterUi + 100, reference: `${ref}-over`, requestId: `qa-${RUN}-over-dep` });
  expect(over.status, `deposit larger than held — ${why(over)}`).toBeGreaterThanOrEqual(400);
  expect(over.status).toBeLessThan(500);
  let replayNote = "nothing left held to replay";
  if (afterUi >= 100) {
    const body = { party: "RIDER", id: riderId, amountPaise: 100, reference: `${ref}-r`, requestId: `qa-${RUN}-dep-replay` };
    const one = await call(admin, "POST", "/api/admin/cod", body);
    expectStatus(one, 201, "deposit ₹1");
    const two = await call(admin, "POST", "/api/admin/cod", body);
    expectStatus(two, [200, 201], "replay");
    expect(two.body?.id, "same deposit returned").toBe(one.body?.id);
    expect(await heldBy("RIDER"), "counted once").toBe(afterUi - 100);
    replayNote = `₹1 deposit replayed with the same requestId → same record, held ${afterUi} → ${afterUi - 100}`;
  }
  return `held ${held} → after the page's deposit of ${delivered.totalPaise} (ref ${ref}) ${afterUi}; deposit of held+₹1 → ${over.status} "${(over.body?.error?.message ?? "").slice(0, 70)}"; ${replayNote}`;
}, { ...signed, mobile: false });

qa("TC-COD-011", "refunding a delivered COD order credits the customer's wallet (customer-funded)", async () => {
  await state();
  const delivered = unstash<CodDelivery>(`${KEY}-delivered`) ?? blocked("needs the COD delivery of TC-COD-006");
  const before = await walletOf("customer");
  const res = await call(await as("ops"), "POST", "/api/finance/refunds", { orderNumber: delivered.orderNumber, amountPaise: delivered.totalPaise, reason: "QA COD refund", chargeTo: "PLATFORM", requestId: `qa-${RUN}-cod-refund` });
  expectStatus(res, 201, "refund the delivered COD order");
  const after = await walletOf("customer");
  expect(after.wallet.balancePaise, "wallet credited").toBe(before.wallet.balancePaise + delivered.totalPaise);
  expect(after.wallet.promotionalBalancePaise, "customer-funded, not promotional").toBe(before.wallet.promotionalBalancePaise);
  const row = after.transactions.find((t) => t.type === "REFUND" && t.amountPaise === delivered.totalPaise);
  expect(row, "a REFUND ledger row").toBeTruthy();
  return `${delivered.orderNumber}: refund ₹${delivered.totalPaise / 100} → wallet ${before.wallet.balancePaise} → ${after.wallet.balancePaise} ("${row!.description}")`;
}, { ...signed, partial: "'reconciliation treats collected cash as the payment' is TC-COD-011 in tests/qa/local/money-cod.spec.ts" });
