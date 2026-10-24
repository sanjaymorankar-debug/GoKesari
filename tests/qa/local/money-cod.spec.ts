/**
 * Cash on delivery on the local server (TC-COD-003 boundary, 004, 007 audit,
 * 008, 010, 011): the exact ₹2,000 limit (rule cod), COD paused by a HIGH risk
 * flag or failed COD deliveries (arranged in the database and removed after),
 * the audit row of an operator's override, a shop delivering itself and
 * collecting the cash, the cash netted in the rider's weekly payout, and the
 * reconciliation of a delivered COD order.
 */
import { as } from "../lib/actors";
import { db } from "../lib/db";
import { deliver, fulfil, offerFor, onlyRiderOnline, packOrder, pickupCode, riderAction, sellable, shopOf } from "../lib/flows";
import { call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import { cancelAsCustomer, checkoutNow, fillCart, istDate, mailsTo, orderOf, ordersOf, placeVia, ruleOf, runKey, sleep, withRule, worldListing } from "../lib/money-helpers";
import { blocked, expect, need, qa, test } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };
const KEY = runKey("cod-local");

let codBefore: boolean | null = null;
test.beforeAll(async () => {
  const shop = await shopOf("A");
  const res = await call(await as("shop"), "GET", `/api/shops/${shop.id}`);
  codBefore = Boolean(res.body?.codEnabled ?? res.body?.shop?.codEnabled);
  if (!codBefore) await call(await as("shop"), "PATCH", `/api/shops/${shop.id}`, { codEnabled: true });
});
test.afterAll(async () => {
  if (codBefore === false) await call(await as("shop"), "PATCH", `/api/shops/${(await shopOf("A")).id}`, { codEnabled: false });
});

async function closeOpenCod() {
  const closed = ["DELIVERED", "DISPUTED", "CANCELLED", "REFUND_PENDING", "REFUNDED", "RETURNED", "FAILED"];
  for (const o of await ordersOf("customer")) {
    if (o.paymentMethod !== "COD" || closed.includes(o.status)) continue;
    // The customer may cancel before the shop accepts; after that the shop takes it off (its own order).
    const res = await cancelAsCustomer("customer", o.id, "QA COD clean-up");
    if (res.status !== 200) await call(await as("shop"), "PATCH", `/api/orders/${o.id}/status`, { status: "CANCELLED", note: "QA COD clean-up" });
  }
}

async function eligibility() {
  const res = await call(await as("customer"), "GET", "/api/cod/eligibility");
  expectStatus(res, 200, "COD eligibility");
  return res.body as { allowed: boolean; reason: string | null; maxOrderPaise: number };
}

qa("TC-COD-003", "exactly ₹2,000 may be paid cash on delivery; the same basket over a lower limit is refused", async () => {
  await closeOpenCod();
  const premium = await worldListing("premium");
  const milk = await worldListing("milk");
  if (premium.pricePaise !== 65_000 || milk.pricePaise !== 7_000) blocked("needs the world's ghee at ₹650 and milk at ₹70 to make a ₹2,000 basket");
  const rule = await ruleOf("cod");
  if (Number(rule.value.maxOrderPaise) !== 200_000) blocked(`rule cod.maxOrderPaise is ${String(rule.value.maxOrderPaise)}, not the ₹2,000 default`);
  await fillCart("customer", [{ listing: premium, quantity: 2 }, { listing: milk, quantity: 10 }]);
  const cart = await call(await as("customer"), "GET", "/api/cart");
  const total = Number(cart.body?.grandTotalPaise ?? 0);
  if (total !== 200_000) blocked(`the basket comes to ${total} paise (delivery fee or taxes), not exactly ₹2,000`);
  const at = await checkoutNow("customer", "COD", [premium.shopId]);
  expectStatus(at.res, 201, "COD for exactly ₹2,000");
  await cancelAsCustomer("customer", at.res.body.orders[0].id);
  const over = await withRule("cod", { maxOrderPaise: 199_999 }, async () => {
    await fillCart("customer", [{ listing: premium, quantity: 2 }, { listing: milk, quantity: 10 }]);
    return (await checkoutNow("customer", "COD", [premium.shopId])).res;
  });
  expect(over.status, `₹2,000.00 against a ₹1,999.99 limit — ${why(over)}`).toBe(422);
  await call(await as("customer"), "DELETE", "/api/cart");
  return `₹2,000.00 basket (2 × ghee + 10 × milk) → COD 201 at the ₹2,000 limit; the same basket with the limit at ₹1,999.99 → 422 "${over.body?.error?.message}"`;
}, local);

qa("TC-COD-004", "COD is refused with the reason while the customer has an open HIGH risk flag, or after 2 failed COD deliveries in 90 days", async () => {
  await closeOpenCod();
  const userId = need(world().users.customer?.id, "customer id");
  const listing = await sellable("A", 3);
  const out: string[] = [];
  // 1. An open HIGH risk flag.
  const [flag] = await db()`insert into risk_flags (subject_type, subject_id, rule_code, severity, status, summary)
                            values ('USER', ${userId}, ${`QA_HIGH_${RUN}`}, 'HIGH', 'OPEN', 'QA: high-risk test flag') returning id`;
  try {
    const e = await eligibility();
    expect(e.allowed).toBe(false);
    await fillCart("customer", [{ listing }]);
    const res = (await checkoutNow("customer", "COD", [listing.shopId])).res;
    expect(res.status, why(res)).toBe(409);
    out.push(`HIGH flag → eligibility "${e.reason}", checkout ${res.status}`);
  } finally {
    await db()`delete from risk_flags where id = ${flag.id}`;
  }
  // 2. Two COD orders whose delivery failed (status history FAILED) within 90 days.
  const failed: string[] = [];
  for (let i = 0; i < 2; i++) {
    const o = await placeVia("customer", "COD", listing);
    await cancelAsCustomer("customer", o.id, "QA failed-delivery arrangement");
    failed.push(o.id);
  }
  const rows = await db()`insert into order_status_history (order_id, previous_status, new_status, note)
                          select id, 'OUT_FOR_DELIVERY', 'FAILED', 'QA: failed COD delivery (arranged)' from orders where id in ${db()(failed)} returning id`;
  try {
    const e = await eligibility();
    expect(e.allowed).toBe(false);
    expect(String(e.reason)).toMatch(/paused/i);
    await fillCart("customer", [{ listing }]);
    const res = (await checkoutNow("customer", "COD", [listing.shopId])).res;
    expect(res.status, why(res)).toBe(409);
    out.push(`2 failed COD deliveries → eligibility "${e.reason}", checkout ${res.status}`);
  } finally {
    await db()`delete from order_status_history where id in ${db()(rows.map((r) => r.id))}`;
    await call(await as("customer"), "DELETE", "/api/cart");
  }
  expect((await eligibility()).allowed, "allowed again after the arrangement is removed").toBe(true);
  return out.join("; ");
}, { ...local, partial: "the two failed deliveries are status-history rows arranged in the database (a rider's 'fail' twice would leave the customer paused for 90 days), removed afterwards" });

qa("TC-COD-007", "an operator's cash-confirmed override of a COD delivery is audited", async () => {
  await closeOpenCod();
  await onlyRiderOnline("rider");
  const order = await placeVia("customer", "COD", await sellable("A", 3));
  await packOrder(order.id);
  const offer = await offerFor(order.id, "rider");
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept"), 200, "rider accepts");
  const code = await pickupCode(order.id);
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}), 200, "pickup");
  const note = `QA ${RUN}: confirmed by phone`;
  expectStatus(await call(await as("ops"), "POST", `/api/orders/${order.id}/confirm-delivery`, { proofNote: note, cashCollected: true }), 200, "operator confirms");
  const [audit] = await db()`select action, actor_role, new_value from audit_logs where entity_type = 'delivery_order' and entity_id = ${offer.deliveryOrderId} and action ilike '%CONFIRMED_BY_OPERATOR%' order by created_at desc limit 1`;
  expect(audit, "an audit row for the override").toBeTruthy();
  expect(JSON.stringify(audit.new_value)).toContain(note);
  const [cod] = await db()`select action from audit_logs where entity_type = 'order' and entity_id = ${order.id} and action ilike '%COD_CASH_COLLECTED%'`;
  expect(cod, "the cash collection is audited too").toBeTruthy();
  return `${order.orderNumber}: override audited as ${audit.action} by ${audit.actor_role} with the proof note; ${cod.action} recorded`;
}, local);

qa("TC-COD-008", "a shop delivering a COD order itself must confirm the cash, and the cash is then held against the shop, not a rider", async () => {
  await closeOpenCod();
  const shop = await shopOf("A");
  const heldBefore = await heldByShop(shop.id);
  const result = await withRule("fulfilmentOptions", { enabled: true }, async () => {
    const order = await placeVia("customer", "COD", await sellable("A", 3));
    expectStatus(await fulfil(order.id, "accept"), 200, "accept");
    expectStatus(await fulfil(order.id, "start"), 200, "start");
    const plan = await call(await as("shop"), "GET", `/api/orders/${order.id}/fulfilment-plan`);
    expectStatus(plan, 200, "fulfilment plan");
    const day = (plan.body.days as { date: string; slots: { key: string }[] }[] | undefined)?.flatMap((d) => d.slots ?? [])[0];
    if (!day) blocked(`no own-delivery slot is offered (${plan.text.slice(0, 150)})`);
    const staffList = await call(await as("shop"), "GET", `/api/shops/${shop.id}/delivery-staff`);
    let staffId = (staffList.body?.staff as { id: string }[] | undefined)?.[0]?.id;
    if (!staffId) {
      const added = await call(await as("shop"), "POST", `/api/shops/${shop.id}/delivery-staff`, { name: "QA Delivery Person", mobile: "9876500011" });
      expectStatus(added, [200, 201], "add the shop's delivery person");
      staffId = added.body?.id ?? added.body?.staff?.id;
    }
    const set = await call(await as("shop"), "POST", `/api/orders/${order.id}/fulfilment-plan`, { option: "SHOP_DELIVERY", slotKey: day.key, staffId, markReady: true });
    expectStatus(set, 200, "own delivery, ready");
    const sent = Date.now();
    expectStatus(await call(await as("shop"), "POST", `/api/orders/${order.id}/fulfilment-plan/handover`, { action: "out_for_delivery" }), 200, "out for delivery");
    // The customer is e-mailed the delivery code as the delivery leaves (read from the local mail catcher).
    const email = need(world().users.customer?.email, "the customer's e-mail");
    let code = "";
    for (let i = 0; i < 20 && !code; i++) {
      code = mailsTo(email, sent).map((m) => m.subject.match(new RegExp(`(\\d{4,8}) is your delivery code for order ${order.orderNumber}`))?.[1] ?? "").find(Boolean) ?? "";
      if (!code) await sleep(1000);
    }
    if (!code) blocked(`no delivery code e-mail for ${order.orderNumber} reached the local mail catcher`);
    const without = await call(await as("shop"), "POST", `/api/orders/${order.id}/fulfilment-plan/handover`, { action: "deliver", code });
    expect(without.status, `deliver without the cash — ${why(without)}`).toBeGreaterThanOrEqual(400);
    const done = await call(await as("shop"), "POST", `/api/orders/${order.id}/fulfilment-plan/handover`, { action: "deliver", code, cashCollected: true });
    expectStatus(done, 200, "deliver with the cash");
    return { order, without };
  });
  const row = await orderOf("customer", result.order.id);
  expect(row?.status).toBe("DELIVERED");
  const heldAfter = await heldByShop(shop.id);
  expect(heldAfter - heldBefore, "cash held against the shop").toBe(result.order.totalPaise);
  const [adj] = await db()`select party, shop_id, delivery_partner_id from financial_adjustments where order_id = ${result.order.id} and type = 'COD_CASH_COLLECTED'`;
  expect([adj.party, adj.delivery_partner_id]).toEqual(["SHOP", null]);
  return `${result.order.orderNumber}: own delivery; deliver without cash → ${result.without.status}; with cash → DELIVERED; the shop holds +${result.order.totalPaise} (${heldBefore} → ${heldAfter}), adjustment party SHOP, no rider`;
}, local);

async function heldByShop(shopId: string) {
  const res = await call(await as("ops"), "GET", "/api/admin/cod");
  return (res.body as { party: string; id: string; heldPaise: number }[]).find((r) => r.party === "SHOP" && r.id === shopId)?.heldPaise ?? 0;
}

/** Monday of this week (IST), as the rider payout week. */
function thisMonday(): string {
  const today = istDate(0);
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  const back = day === 0 ? 6 : day - 1;
  return istDate(-back);
}

interface BigCod {
  orderId: string;
  orderNumber: string;
  totalPaise: number;
  partnerId: string;
}

qa("TC-COD-011", "reconciliation counts the cash collected for a delivered COD order as its payment", async () => {
  await closeOpenCod();
  await onlyRiderOnline("rider");
  // A large COD order, so the rider will hold more cash than the week's earnings (TC-COD-010).
  const premium = await worldListing("premium");
  await fillCart("customer", [{ listing: premium, quantity: 3 }]);
  const placed = (await checkoutNow("customer", "COD", [premium.shopId])).res;
  expectStatus(placed, 201, "COD order of ₹1,950");
  const order = placed.body.orders[0] as { id: string; orderNumber: string; totalPaise: number };
  await packOrder(order.id);
  await deliver(order.id, { cashCollected: true });
  const partner = await call(await as("rider"), "GET", "/api/delivery-partner/me");
  const partnerId = String(partner.body?.id ?? partner.body?.partner?.id ?? partner.body?.profile?.id ?? "");
  stash(KEY, { orderId: order.id, orderNumber: order.orderNumber, totalPaise: order.totalPaise, partnerId } satisfies BigCod);
  const recon = await call(await as("admin"), "POST", "/api/finance/reconciliation", { from: istDate(0), to: istDate(1) });
  expectStatus(recon, 200, "reconciliation run");
  const recs = await call(await as("admin"), "GET", "/api/finance/reconciliation");
  const rec = (recs.body.records as { entityId: string; checkType: string; status: string; expectedPaise: number; actualPaise: number }[]).find((r) => r.entityId === order.id && r.checkType === "ORDER_PAYMENT");
  expect(rec, "the delivered COD order is checked").toBeTruthy();
  expect(rec!.status, `${order.orderNumber}: expected ${rec!.expectedPaise}, actual ${rec!.actualPaise}`).toMatch(/^(MATCHED|RECONCILED)$/);
  return `${order.orderNumber} (₹${order.totalPaise / 100} cash collected) → ${rec!.status} (expected ${rec!.expectedPaise}, actual ${rec!.actualPaise})`;
}, { ...local, partial: "the refund-as-wallet-credit half is TC-COD-011 in tests/qa/signed-in/money-cod.spec.ts" });

qa("TC-COD-010", "cash a rider still holds is netted in the weekly payout: net = earnings − cash held; a negative net is flagged for manual collection", async () => {
  const big = unstash<BigCod>(KEY) ?? blocked("needs the ₹1,950 COD delivery of TC-COD-011");
  const partnerId = big.partnerId || blocked("the rider profile carries no id");
  const heldList = await call(await as("ops"), "GET", "/api/admin/cod");
  const held = (heldList.body as { party: string; id: string; heldPaise: number }[]).find((r) => r.party === "RIDER" && r.id === partnerId)?.heldPaise ?? 0;
  if (held < big.totalPaise) blocked(`the rider holds ${held} paise, less than the ₹${big.totalPaise / 100} COD order`);
  const [earn] = await db()`select coalesce(sum(total_paise), 0)::bigint as gross from delivery_partner_earnings where delivery_partner_id = ${partnerId} and payout_id is null`;
  const prep = await call(await as("admin"), "POST", "/api/finance/rider-payouts", { weekStart: thisMonday() });
  expectStatus(prep, 201, "prepare rider payouts");
  const mine = (prep.body as { deliveryPartnerId: string; grossPaise: number; adjustmentsPaise: number; amountPaise: number; id: string }[]).find((p) => p.deliveryPartnerId === partnerId);
  const exceptions = await call(await as("admin"), "GET", "/api/finance/exceptions");
  const flagged = mine ? JSON.stringify(exceptions.body).includes(mine.id) : false;
  const problems: string[] = [];
  if (!mine) problems.push("no payout prepared for the rider");
  else {
    if (mine.grossPaise !== Number(earn.gross)) problems.push(`gross ${mine.grossPaise} ≠ unpaid earnings ${earn.gross}`);
    if (mine.adjustmentsPaise > -held) problems.push(`adjustments ${mine.adjustmentsPaise} do not take the ${held} paise of cash held`);
    if (mine.amountPaise !== mine.grossPaise + mine.adjustmentsPaise) problems.push("net ≠ gross + adjustments");
    if (mine.amountPaise < 0 && !flagged) problems.push(`the negative payout (${mine.amountPaise} paise) is not flagged for manual collection (absent from /api/finance/exceptions)`);
  }
  const heldAfter = ((await call(await as("ops"), "GET", "/api/admin/cod")).body as { party: string; id: string; heldPaise: number }[]).find((r) => r.party === "RIDER" && r.id === partnerId)?.heldPaise ?? 0;
  expect(problems, `${problems.join("; ")} — rider held ${held}, earnings ${earn.gross}, payout ${JSON.stringify(mine)}`).toEqual([]);
  return `rider held ${held}; payout: gross ${mine!.grossPaise} + adjustments ${mine!.adjustmentsPaise} = ${mine!.amountPaise}${mine!.amountPaise < 0 ? " (negative, flagged)" : ""}; held after ${heldAfter}`;
}, { ...local, partial: "the weekly payout is GS-064 rider payouts (/api/finance/rider-payouts) prepared for the current week" });
