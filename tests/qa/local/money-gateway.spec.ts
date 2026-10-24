/**
 * The payment gateway's side of online order payments, on the local server
 * only (TC-PAY-005, 020–023, 026, 027, 030–032, 034, 035): what the gateway
 * sends (signed sandbox webhooks, duplicates, late or altered captures), what
 * the reconciliation job and the finance views make of it, and what is stored.
 *
 * Local tier: the sandbox webhook is signed with the local server's derived
 * secret (AUTH_SECRET), the gateway's own ledger (payment_sandbox_orders) is
 * moved in the database exactly as the gateway would move it when a customer
 * pays and closes the browser, and crons run with CRON_SECRET. Rule
 * onlinePayments is switched on for the file and restored after it.
 */
import { readFileSync } from "node:fs";

import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { deliver, onlyRiderOnline, packOrder, sellable } from "../lib/flows";
import { anonymous, call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import {
  checkoutNow,
  fillCart,
  intentRows,
  intentView,
  istDate,
  notificationsOf,
  onlineCheckout,
  onlineStock,
  orderOf,
  paySandbox,
  placeVia,
  postSandboxWebhook,
  putRule,
  restoreRule,
  ruleOf,
  runCron,
  runKey,
  sleep,
  walletOf,
  type OnlineCheckout,
  type RuleRow,
  type SandboxWebhookBody,
} from "../lib/money-helpers";
import { blocked, expect, manual, need, qa, test } from "../lib/record";
import { HOST, IS_LOCAL } from "../lib/target";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };
const KEY = runKey("gateway");

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

/** The gateway takes the money (its own ledger moves) — the customer paid and closed the tab. */
async function gatewayCaptures(checkout: OnlineCheckout, amountPaise?: number) {
  const { intent, sandbox } = await intentRows(checkout.payment.intentId);
  expect(sandbox, "the sandbox gateway has the order").toBeTruthy();
  const paymentId = `sbxpay_qa${Date.now().toString(36)}`;
  await db()`update payment_sandbox_orders set status = 'CAPTURED', payment_id = ${paymentId}, method = 'UPI',
             amount_paise = ${amountPaise ?? Number(sandbox.amount_paise)}, updated_at = now() where gateway_order_id = ${sandbox.gateway_order_id}`;
  return {
    paymentId,
    body: {
      type: "PAYMENT_CAPTURED",
      merchantOrderId: String(intent.merchant_order_id),
      gatewayOrderId: String(sandbox.gateway_order_id),
      paymentId,
      amountPaise: amountPaise ?? Number(sandbox.amount_paise),
    },
  };
}

function captured() {
  const v = unstash<OnlineCheckout & { eventId: string; raw: string }>(KEY);
  if (!v) blocked("needs the order confirmed by the webhook in TC-PAY-023 of this run");
  return v;
}

qa("TC-PAY-005", "a webhook with no or a wrong signature changes no payment (order payment and wallet top-up)", async () => {
  const listing = await sellable("A", 3);
  const checkout = await onlineCheckout("customer", [{ listing }]);
  const { intent, sandbox } = await intentRows(checkout.payment.intentId);
  const body = { type: "PAYMENT_CAPTURED", merchantOrderId: String(intent.merchant_order_id), gatewayOrderId: String(sandbox.gateway_order_id), paymentId: "sbxpay_forged", amountPaise: Number(intent.amount_paise) };
  const wrong = await postSandboxWebhook(body, { signature: "0".repeat(64) });
  expect(wrong.status, "wrong signature").toBe(401);
  const stale = await postSandboxWebhook(body, { timestamp: String(Date.now() - 3_600_000) });
  expect(stale.status, "stale timestamp (signature valid for an hour-old time)").toBe(401);
  const after = await intentRows(checkout.payment.intentId);
  expect(after.intent.status, "intent unchanged").toBe(intent.status);
  expect((await orderOf("customer", checkout.orders[0].id))?.status, "order unchanged").toBe("PENDING");
  const [rejected] = await db()`select count(*)::int as n from payment_webhook_events where outcome = 'BAD_SIGNATURE' and received_at > now() - interval '2 minutes'`;
  // The wallet top-up webhook: no Cashfree keys here, so nothing can verify it — refused.
  const topup = await call(await as("customer"), "POST", "/api/wallet/topup", { amountPaise: 1000 });
  expectStatus(topup, 200, "start a top-up");
  const guest = await anonymous();
  const cf = await call(guest, "POST", "/api/webhooks/cashfree", { type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: topup.body.gatewayOrderId, order_amount: 10 }, payment: { cf_payment_id: "forged1", payment_status: "SUCCESS" } } }, { headers: { "x-webhook-signature": "d3Jvbmc=", "x-webhook-timestamp": String(Date.now()) } });
  await guest.dispose();
  expect(cf.status, `cashfree webhook — ${why(cf)}`).toBeGreaterThanOrEqual(400);
  const [payment] = await db()`select status from payments where gateway_order_id = ${topup.body.gatewayOrderId}`;
  expect(payment.status, "top-up still unpaid").toBe("CREATED");
  // Leave the attempt closed.
  await postSandboxWebhook({ ...body, type: "PAYMENT_FAILED" }).catch(() => undefined);
  return `order webhook wrong signature → 401, stale → 401 (intent ${intent.status}, order PENDING, ${rejected?.n ?? "?"} BAD_SIGNATURE rows recorded); wallet webhook forged → ${cf.status}, top-up still CREATED`;
}, local);

qa("TC-PAY-023", "the browser never returns: the gateway's webhook alone confirms the order, which shows on /orders with a notification", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const since = Date.now();
  const checkout = await onlineCheckout("customer", [{ listing }]);
  const { body } = await gatewayCaptures(checkout);
  const eventId = `sbxevt_qa_${RUN}_${Date.now()}`;
  const first = await postSandboxWebhook({ ...body, eventId });
  expect(first.status, `webhook: ${first.text}`).toBe(200);
  const order = checkout.orders[0];
  expect((await orderOf("customer", order.id))?.status, "confirmed by the webhook").toBe("CONFIRMED");
  const notes = await notificationsOf("customer");
  const note = notes.notifications.find((n) => n.body.includes(order.orderNumber) && new Date(n.createdAt).getTime() >= since - 5000);
  expect(note, "a notification for the order").toBeTruthy();
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/orders");
    const card = page.getByTestId("order-card").filter({ hasText: order.orderNumber }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText(/confirmed/i);
  } finally {
    await context.close();
  }
  stash(KEY, { ...checkout, eventId, raw: first.raw });
  return `${order.orderNumber}: gateway ledger CAPTURED + signed webhook → CONFIRMED; "${note!.title}"; /orders card shows it confirmed`;
}, { ...local, mobile: false });

qa("TC-PAY-022", "the same valid webhook sent twice is acknowledged and changes nothing (one order, one payment)", async () => {
  const c = captured();
  const before = await db()`select count(*)::int as n from payment_intent_events where intent_id = ${c.payment.intentId} and to_status = 'CAPTURED'`;
  const parsed = JSON.parse(c.raw) as Record<string, unknown>;
  const again = await postSandboxWebhook({ ...(parsed as unknown as SandboxWebhookBody), eventId: c.eventId });
  expect(again.status).toBe(200);
  expect(again.body?.duplicate, `duplicate acknowledged: ${again.text}`).toBe(true);
  const after = await db()`select count(*)::int as n from payment_intent_events where intent_id = ${c.payment.intentId} and to_status = 'CAPTURED'`;
  expect(after[0].n, "captured once").toBe(before[0].n);
  expect(before[0].n).toBe(1);
  const orders = await db()`select count(*)::int as n from orders where checkout_key like ${`%${c.requestId}%`}`;
  expect(orders[0].n, "one order").toBe(1);
  const wrong = await postSandboxWebhook({ ...(parsed as unknown as SandboxWebhookBody), eventId: `${c.eventId}-x` }, { signature: "f".repeat(64) });
  expect(wrong.status, "bad signature rejected").toBe(401);
  return `replay of ${c.eventId} → 200 duplicate:true; CAPTURED events 1; orders 1; bad signature → 401`;
}, local);

qa("TC-PAY-021", "a capture for a different amount than the order never confirms it (the server checks the amount with the gateway)", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const checkout = await onlineCheckout("customer", [{ listing }]);
  const { sandbox } = await intentRows(checkout.payment.intentId);
  // The amount at the gateway differs from the order's (as if altered before paying).
  await db()`update payment_sandbox_orders set amount_paise = ${Number(sandbox.amount_paise) - 100} where gateway_order_id = ${sandbox.gateway_order_id}`;
  const { context, page } = await pageAs(browser, "customer");
  try {
    await paySandbox(page, checkout.payment, "pay");
  } finally {
    await context.close();
  }
  const { intent } = await intentRows(checkout.payment.intentId);
  expect(intent.status, "not captured").not.toBe("CAPTURED");
  const row = await orderOf("customer", checkout.orders[0].id);
  expect(row?.status, "order not confirmed").not.toBe("CONFIRMED");
  expect(row?.paidAt).toBeNull();
  const flagged = await db()`select count(*)::int as n from payment_webhook_events where intent_id = ${checkout.payment.intentId} and outcome = 'AMOUNT_MISMATCH'`;
  expect(flagged[0].n, "the mismatch is recorded").toBeGreaterThan(0);
  return `gateway captured ${Number(sandbox.amount_paise) - 100} against ${sandbox.amount_paise} expected → intent ${intent.status}, order ${row?.status}; mismatch outcomes recorded: ${flagged[0].n}`;
}, local);

qa("TC-PAY-020", "an unpaid attempt expires on time: the reconciliation job marks it EXPIRED, the order is released and nothing is charged", async () => {
  const listing = await sellable("A", 3);
  const stockBefore = await onlineStock(listing);
  const walletBefore = (await walletOf("customer")).wallet.balancePaise;
  const checkout = await onlineCheckout("customer", [{ listing }]);
  const { sandbox } = await intentRows(checkout.payment.intentId);
  // The customer closed the tab 20 minutes ago (intentExpiryMinutes 15).
  await db()`update payment_intents set expires_at = now() - interval '5 minutes', created_at = now() - interval '20 minutes' where id = ${checkout.payment.intentId}`;
  await db()`update payment_sandbox_orders set expires_at = now() - interval '5 minutes' where gateway_order_id = ${sandbox.gateway_order_id}`;
  const job = await runCron("/api/cron/payments-reconcile");
  expectStatus(job, 200, "payments-reconcile");
  const view = await intentView("customer", checkout.payment.intentId);
  expect(view.status, `after the job: ${job.text.slice(0, 200)}`).toBe("EXPIRED");
  const row = await orderOf("customer", checkout.orders[0].id);
  expect(row?.status).toBe("PAYMENT_FAILED");
  if (stockBefore !== undefined) expect(await onlineStock(listing), "stock released").toBe(stockBefore);
  expect((await walletOf("customer")).wallet.balancePaise, "no charge").toBe(walletBefore);
  return `${checkout.orders[0].orderNumber}: past its expiry → payments-reconcile → EXPIRED, order PAYMENT_FAILED, stock ${stockBefore} back, wallet unchanged (${job.text.slice(0, 120)})`;
}, { ...local, partial: "'the cart is still there' is superseded by D-A07 (docs/decision-log.md): the cart is cleared at checkout and the order waits for Retry payment" });

qa("TC-PAY-027", "illegal payment moves are refused: FAILED → CAPTURED, REFUNDED → CAPTURED and CAPTURED → CREATED leave the state unchanged", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const out: string[] = [];
  // FAILED → CAPTURED: the gateway reports a capture after the attempt failed.
  const failed = await onlineCheckout("customer", [{ listing }]);
  {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await paySandbox(page, failed.payment, "fail");
    } finally {
      await context.close();
    }
    const { body } = await gatewayCaptures(failed);
    const res = await postSandboxWebhook(body);
    expect(res.status).toBe(200);
    expect((await intentRows(failed.payment.intentId)).intent.status, "FAILED stays FAILED").toBe("FAILED");
    expect((await orderOf("customer", failed.orders[0].id))?.status).toBe("PAYMENT_FAILED");
    out.push(`FAILED → CAPTURED: ${res.body?.outcome ?? res.text.slice(0, 60)}, still FAILED`);
  }
  // REFUNDED → CAPTURED: a capture webhook after a full refund.
  const refunded = await onlineCheckout("customer", [{ listing }]);
  {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await paySandbox(page, refunded.payment, "pay");
    } finally {
      await context.close();
    }
    expectStatus(await call(await as("customer"), "PATCH", `/api/orders/${refunded.orders[0].id}/status`, { status: "CANCELLED", note: "QA" }), 200, "cancel");
    for (let i = 0; i < 10 && (await intentRows(refunded.payment.intentId)).intent.status !== "REFUNDED"; i++) await sleep(1000);
    const { intent, sandbox } = await intentRows(refunded.payment.intentId);
    expect(intent.status, "refunded first").toBe("REFUNDED");
    const res = await postSandboxWebhook({ type: "PAYMENT_CAPTURED", merchantOrderId: String(intent.merchant_order_id), gatewayOrderId: String(sandbox.gateway_order_id), paymentId: String(sandbox.payment_id), amountPaise: Number(sandbox.amount_paise) });
    expect(res.status).toBe(200);
    expect((await intentRows(refunded.payment.intentId)).intent.status, "REFUNDED stays REFUNDED").toBe("REFUNDED");
    out.push(`REFUNDED → CAPTURED: ${res.body?.outcome ?? "ok"}, still REFUNDED`);
  }
  // CAPTURED → CREATED (there is no RECONCILED state, D-A06): the gateway's ledger is rolled back to CREATED.
  const paidOne = await onlineCheckout("customer", [{ listing }]);
  {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await paySandbox(page, paidOne.payment, "pay");
    } finally {
      await context.close();
    }
    const { intent, sandbox } = await intentRows(paidOne.payment.intentId);
    await db()`update payment_sandbox_orders set status = 'CREATED' where gateway_order_id = ${sandbox.gateway_order_id}`;
    const res = await postSandboxWebhook({ type: "PAYMENT_AUTHORIZED", merchantOrderId: String(intent.merchant_order_id), gatewayOrderId: String(sandbox.gateway_order_id), paymentId: null, amountPaise: Number(sandbox.amount_paise) });
    await db()`update payment_sandbox_orders set status = 'CAPTURED' where gateway_order_id = ${sandbox.gateway_order_id}`;
    expect(res.status).toBe(200);
    expect((await intentRows(paidOne.payment.intentId)).intent.status, "CAPTURED stays CAPTURED").toBe("CAPTURED");
    out.push(`CAPTURED → CREATED: ${res.body?.outcome ?? "ok"}, still CAPTURED`);
  }
  return out.join("; ");
}, { ...local, partial: "'RECONCILED → CREATED' is tested as CAPTURED → CREATED: the documented state machine (D-A06, docs/payments-gateway-2026-10.md §2) has no RECONCILED state; no API moves a payment by hand, so the gateway's word (webhook) is the only way in" });

qa("TC-PAY-026", "the admin money trace of an online-paid order shows the payment and its states with time stamps", async () => {
  const c = captured();
  const order = c.orders[0];
  const res = await call(await as("admin"), "GET", `/api/finance/orders/${encodeURIComponent(order.orderNumber)}`);
  expectStatus(res, 200, "money trace");
  const events = await db()`select from_status, to_status, source, created_at from payment_intent_events where intent_id = ${c.payment.intentId} order by created_at`;
  const stored = events.map((e) => `${e.from_status ?? "∅"}→${e.to_status} (${e.source})`).join(", ");
  expect(res.body?.payment, `the trace's payment for an ONLINE order (stored events: ${stored}); trace: ${JSON.stringify(res.body?.payment)}`).toBeTruthy();
  expect(JSON.stringify(res.body), "the trace carries the payment intent's states").toMatch(/CAPTURED/);
  return `trace payment ${JSON.stringify(res.body.payment).slice(0, 160)}; stored events: ${stored}`;
}, { ...local, partial: "the expected AUTHORIZED / RECONCILED states are superseded by D-A06 (CREATED → … → CAPTURED; reconciliation is a separate record); wallet and COD orders are unaffected by construction (no intent)" });

qa("TC-PAY-030", "refunds: more than the order is refused, a replayed refund request refunds once, a failing gateway refund is retried and never shown as done", async ({ browser }) => {
  const out: string[] = [];
  // Over-refund and replay on a delivered wallet order (operator refund, /api/finance/refunds).
  await onlyRiderOnline("rider");
  const order = await placeVia("customer", "WALLET", await sellable("A", 3));
  await packOrder(order.id);
  await deliver(order.id);
  const ops = await as("ops");
  const over = await call(ops, "POST", "/api/finance/refunds", { orderNumber: order.orderNumber, amountPaise: order.totalPaise + 100, reason: "QA over-refund", chargeTo: "PLATFORM", requestId: `qa-${RUN}-over` });
  expect(over.status, `over-refund — ${why(over)}`).toBe(422);
  const walletBefore = (await walletOf("customer")).wallet.balancePaise;
  const requestId = `qa-${RUN}-refund1`;
  const first = await call(ops, "POST", "/api/finance/refunds", { orderNumber: order.orderNumber, amountPaise: 1000, reason: "QA partial refund", chargeTo: "PLATFORM", requestId });
  expectStatus(first, 201, "refund ₹10");
  const replay = await call(ops, "POST", "/api/finance/refunds", { orderNumber: order.orderNumber, amountPaise: 1000, reason: "QA partial refund", chargeTo: "PLATFORM", requestId });
  expectStatus(replay, [200, 201], "replay");
  expect(replay.body?.id, "the replay returns the first refund").toBe(first.body?.id);
  expect((await walletOf("customer")).wallet.balancePaise, "credited once").toBe(walletBefore + 1000);
  out.push(`over-refund → 422; refund ₹10 + replay (same requestId) → same record ${String(first.body?.id).slice(0, 8)}, wallet +1000 once`);
  // A gateway refund that fails: the gateway refuses (its ledger says the payment is not captured).
  const listing = await sellable("A", 3);
  const online = await onlineCheckout("customer", [{ listing }]);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await paySandbox(page, online.payment, "pay");
  } finally {
    await context.close();
  }
  const { sandbox } = await intentRows(online.payment.intentId);
  await db()`update payment_sandbox_orders set status = 'FAILED' where gateway_order_id = ${sandbox.gateway_order_id}`;
  try {
    expectStatus(await call(await as("customer"), "PATCH", `/api/orders/${online.orders[0].id}/status`, { status: "CANCELLED", note: "QA refund failure" }), 200, "cancel");
    const [r1] = await db()`select id, status from order_refunds where order_id = ${online.orders[0].id} order by created_at desc limit 1`;
    expect(r1, "a refund record").toBeTruthy();
    expect(r1.status, "not shown as done after the gateway refused").not.toBe("SUCCESS");
    const [p1] = await db()`select id, status, submitted_at from payment_refunds where intent_id = ${online.payment.intentId} order by created_at desc limit 1`;
    expect(p1?.status, "the gateway refund waits to be sent again").toBe("PENDING");
    let job = "";
    for (let i = 0; i < 2; i++) job = (await runCron("/api/cron/payments-reconcile")).text.slice(0, 160);
    const [p2] = await db()`select status from payment_refunds where id = ${p1.id}`;
    expect(p2.status, "still failing at the gateway: still pending, never done").toBe("PENDING");
    const view = await call(await as("customer"), "GET", `/api/orders/${online.orders[0].id}/refunds`);
    expect(JSON.stringify(view.body), "the customer is not told it is refunded").not.toMatch(/"status":"SUCCESS"/);
    const exceptions = await call(await as("admin"), "GET", "/api/finance/exceptions");
    const listed = JSON.stringify(exceptions.body).includes(online.orders[0].orderNumber);
    // The gateway recovers: the next run of the job sends the same refund again and it completes.
    await db()`update payment_sandbox_orders set status = 'CAPTURED' where gateway_order_id = ${sandbox.gateway_order_id}`;
    await runCron("/api/cron/payments-reconcile");
    const [p3] = await db()`select status from payment_refunds where id = ${p1.id}`;
    expect(p3.status, "retried by the job once the gateway accepts").toBe("SUCCESS");
    out.push(`gateway refusing the refund: customer refund ${r1.status}, gateway refund PENDING through 2 job runs (${job}); finance exception listed: ${listed}; gateway back → next run SUCCESS`);
  } finally {
    await db()`update payment_sandbox_orders set status = 'CAPTURED' where gateway_order_id = ${sandbox.gateway_order_id}`;
  }
  return out.join("; ");
}, { ...local, timeout: 400_000, partial: "the failing refund is retried by payments-reconcile and support is alerted after onlinePayments.maxReconcileAttempts (48) checks (D-A09) — whether a finance exception is listed meanwhile is recorded in the detail, not asserted" });

qa("TC-PAY-032", "reconciliation of a day with online orders: paid orders match; a mismatch is listed with both amounts", async () => {
  const c = captured();
  const plain = await placeVia("customer", "WALLET", await sellable("A", 3));
  const wallet = await placeVia("customer", "WALLET", await sellable("A", 3));
  await db()`update orders set total_paise = total_paise + 100 where id = ${wallet.id}`;
  try {
    const run = await call(await as("admin"), "POST", "/api/finance/reconciliation", { from: istDate(0), to: istDate(1) });
    expectStatus(run, 200, "run reconciliation");
    const list = await call(await as("admin"), "GET", "/api/finance/reconciliation");
    expectStatus(list, 200, "reconciliation records");
    const records = (list.body.records ?? []) as { entityId: string; reference: string; checkType: string; status: string; expectedPaise: number | null; actualPaise: number | null }[];
    const pick = (id: string) => records.find((r) => r.entityId === id && r.checkType === "ORDER_PAYMENT");
    const seen = (label: string, r: ReturnType<typeof pick>) => `${label} ${r ? `${r.status} (expected ${r.expectedPaise}, actual ${r.actualPaise})` : "not checked"}`;
    const rPlain = pick(plain.id);
    const rOnline = pick(c.orders[0].id);
    const rBad = pick(wallet.id);
    const summary = [seen(`wallet-paid ${plain.orderNumber}`, rPlain), seen(`online-paid ${c.orders[0].orderNumber}`, rOnline), seen(`altered ${wallet.orderNumber}`, rBad)].join("; ");
    const problems: string[] = [];
    if (!rPlain || !/^(MATCHED|RECONCILED)$/.test(rPlain.status)) problems.push("a correctly paid wallet order is not matched");
    if (!rOnline || !/^(MATCHED|RECONCILED)$/.test(rOnline.status)) problems.push("a captured online payment is not matched");
    if (!rBad || /^(MATCHED|RECONCILED)$/.test(rBad.status) || rBad.expectedPaise !== wallet.totalPaise + 100 || rBad.actualPaise !== wallet.totalPaise) problems.push("the mismatch is not listed with both amounts (order total vs paid)");
    expect(problems, `${problems.join("; ")} — ${summary}`).toEqual([]);
    return summary;
  } finally {
    await db()`update orders set total_paise = total_paise - 100 where id = ${wallet.id}`;
  }
}, local);

qa("TC-PAY-034", "no card number, CVV or UPI PIN is held: payment rows, gateway events, API answers and the server log carry only references", async () => {
  const c = captured();
  const pan = /\b(?:4\d{3}|5[1-5]\d{2}|6\d{3}|3[47]\d{2})[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/;
  const words = /"(cvv|cvc|card_?number|cardNumber|upi_?pin|upiPin|pan)"\s*:/i;
  const tables = await db()`select
      (select coalesce(string_agg(row_to_json(p)::text, ' '), '') from payment_intents p where p.created_at > now() - interval '1 day') as intents,
      (select coalesce(string_agg(row_to_json(e)::text, ' '), '') from payment_webhook_events e where e.received_at > now() - interval '1 day') as events,
      (select coalesce(string_agg(row_to_json(s)::text, ' '), '') from payment_sandbox_orders s where s.created_at > now() - interval '1 day') as sandbox,
      (select coalesce(string_agg(row_to_json(r)::text, ' '), '') from payment_refunds r where r.created_at > now() - interval '1 day') as refunds,
      (select coalesce(string_agg(row_to_json(y)::text, ' '), '') from payments y where y.created_at > now() - interval '1 day') as payments`.catch(async () =>
    db()`select (select coalesce(string_agg(row_to_json(p)::text, ' '), '') from payment_intents p) as intents, '' as events, '' as sandbox, '' as refunds, '' as payments`);
  const found: string[] = [];
  for (const [name, text] of Object.entries(tables[0] as Record<string, string>)) {
    if (pan.test(text)) found.push(`${name}: card-like number ${text.match(pan)![0]}`);
    if (words.test(text)) found.push(`${name}: field ${text.match(words)![1]}`);
  }
  const api = await call(await as("customer"), "GET", `/api/payments/intents/${c.payment.intentId}`);
  if (pan.test(api.text) || words.test(api.text)) found.push("customer payment API");
  const logFile = `test-results/qa/server-${HOST.split(":")[1] ?? "3000"}.log`;
  let log = "";
  try {
    log = readFileSync(logFile, "utf8");
  } catch {
    log = "";
  }
  if (/4111[ -]?1111[ -]?1111[ -]?1111|4706[ -]?1312/.test(log)) found.push("server log: a test card number");
  expect(found, found.join("; ")).toEqual([]);
  const sizes = Object.entries(tables[0] as Record<string, string>).map(([k, v]) => `${k} ${v.length} chars`).join(", ");
  return `scanned ${sizes}, the payment API and ${log ? logFile : "no server log"}: no card number, CVV/PIN field; the gateway page (sandbox) never asks for card details`;
}, { ...local, partial: "a real card payment happens on the gateway's page (Cashfree sandbox on staging); here the sandbox stands in, so 'after a card payment' is the sandbox Card method" });

qa("TC-PAY-035", "online payment is not started when the shop is suspended", async () => {
  need(world().shops.B, "shop B");
  const listing = await sellable("B", 3);
  await fillCart("customer", [{ listing }]);
  const admin = await as("admin");
  const suspend = await call(admin, "POST", `/api/shops/${listing.shopId}/suspend`, { reason: "QA suspension test", expectedAction: "None — QA" });
  expectStatus(suspend, [200, 201], "suspend shop B");
  try {
    const { res } = await checkoutNow("customer", "ONLINE", [listing.shopId]);
    expect(res.status, why(res)).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body?.payment).toBeFalsy();
    return `suspended shop → ${res.status} "${(res.body?.error?.message ?? "").slice(0, 100)}", no payment started`;
  } finally {
    const back = await call(admin, "POST", `/api/shops/${listing.shopId}/reactivate`, { note: "QA test over" });
    expectStatus(back, [200, 201], "reactivate shop B");
    await call(await as("customer"), "DELETE", "/api/cart");
  }
}, local);

manual(
  "TC-PAY-031",
  "chargeback on a delivered online order",
  "needs a gateway chargeback (dispute) event: the sandbox gateway cannot raise one and the documented payment state machine (D-A06) has no CHARGEBACK state or handler — to be run with the live/sandbox gateway's dispute simulator once chargeback handling exists",
  { tier: "local" },
);
