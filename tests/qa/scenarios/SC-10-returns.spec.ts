/**
 * SC-10 — a return with a photo, collected by a rider with the customer's
 * handover code, inspected and accepted for part of the amount: each status
 * visible to the customer, the wallet credited once, the shop's share in its
 * next settlement and the rider paid the pickup fee. Also the return-pickup
 * fee in the rider's payout statement (the part TC-FIN-019 leaves to here).
 *
 * Local tier: the delivered order and the rider's position are arranged as in
 * the other journeys; the pickup id is read from the database (the rider's
 * app finds it on their dashboard).
 */
import { api, buy, deliverOrder, ensureFunds, freeRider, freshListing, orderDetail, packOrder, testPng, walletBalance } from "../lib/finance-helpers";
import { as } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, poll } from "../lib/http";
import { expect, need, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 300_000 };

qa("SC-10", "return with rider pickup: photo, approval, the rider collects with the handover code, inspection accepts a partial amount; each status shown to the customer, the wallet credited once, the shop's share in the next settlement, the rider paid the pickup fee", async () => {
  await freeRider("rider");
  await ensureFunds("customer");
  const listing = await freshListing({ name: "QA Return Jar", pricePaise: 8000, stock: 10 });
  const order = await buy(listing, 2);
  await packOrder(order.id);
  await deliverOrder(order.id);
  const item = need(await orderDetail("customer", order.id), "the order").items[0];
  // 1. The customer asks for a return with a photo.
  const upload = await call(await as("customer"), "POST", "/api/images", undefined, { multipart: { purpose: "RETURN_EVIDENCE", file: { name: "damage.png", mimeType: "image/png", buffer: testPng() } } });
  expectStatus(upload, 201, "upload the return photo");
  const req = await api("customer", "POST", `/api/orders/${order.id}/returns`, {
    reason: "DAMAGED",
    comment: "QA: the lid was cracked",
    items: [{ orderItemId: item.id, quantityMilli: 1000, condition: "DAMAGED", imageIds: [upload.body.id] }],
  });
  expectStatus(req, 201, "request the return");
  const returnId = req.body.id as string;
  const seen: string[] = [];
  const customerSees = async () => {
    const r = await api("customer", "GET", `/api/returns/${returnId}`);
    expectStatus(r, 200, "the customer's return page");
    const status = r.body.ret.status as string;
    if (seen.at(-1) !== status) seen.push(status);
    return r.body;
  };
  await customerSees();
  // 2. The shop approves; a rider is offered the pickup.
  expectStatus(await api("shop", "PATCH", `/api/returns/${returnId}`, { action: "approve", note: "QA: approved" }), 200, "shop approves");
  await customerSees();
  const pickup = await poll(
    async () => (await db()<{ id: string; status: string }[]>`select id, status from return_pickups where return_id = ${returnId} order by created_at desc`)[0],
    (p) => p?.status === "OFFERED",
    20_000,
    1000,
  );
  need(pickup, "a rider pickup for the return (shop A delivers and returns.pickupByRider is on)");
  expect(pickup.status, "the pickup is offered to a rider").toBe("OFFERED");
  const code = need((await customerSees()).pickup?.handoverCode as string | undefined, "the handover code on the customer's return page");
  // 3. The rider accepts, sets off and collects with the code.
  for (const action of ["accept", "start"] as const) expectStatus(await api("rider", "PATCH", `/api/return-pickups/${pickup.id}`, { action }), 200, `rider ${action}`);
  await customerSees();
  const wrong = await api("rider", "PATCH", `/api/return-pickups/${pickup.id}`, { action: "pickup", code: code === "0000" ? "1111" : "0000" });
  expect(wrong.status, "a wrong handover code").toBeGreaterThanOrEqual(400);
  expectStatus(await api("rider", "PATCH", `/api/return-pickups/${pickup.id}`, { action: "pickup", code }), 200, "rider collects with the code");
  await customerSees();
  // 4. The shop receives and inspects; accepts ₹60 of the ₹80.
  const before = await walletBalance();
  expectStatus(await api("shop", "PATCH", `/api/returns/${returnId}`, { action: "receive" }), 200, "received");
  expectStatus(await api("shop", "PATCH", `/api/returns/${returnId}`, { action: "inspect", outcome: "ACCEPT", note: "QA: lid cracked, contents fine", refundPaise: 6000 }), 200, "inspect and accept ₹60");
  let final = await customerSees();
  // returns.autoRefundAfterInspection (default on) pays at once; otherwise the shop issues it.
  if (final.ret.status !== "REFUND_COMPLETED") {
    expectStatus(await api("shop", "PATCH", `/api/returns/${returnId}`, { action: "issue_refund" }), 200, "issue the refund");
    final = await customerSees();
  }
  expect(final.ret.status as string, "refund completed").toBe("REFUND_COMPLETED");
  // Asking again does not pay twice.
  const twice = await api("shop", "PATCH", `/api/returns/${returnId}`, { action: "issue_refund" });
  expect((await walletBalance()) - before, "wallet credited ₹60 once").toBe(6000);
  const refunds = await db()<{ n: number }[]>`select count(*)::int as n from wallet_transactions where order_id = ${order.id} and amount_paise > 0`;
  expect(refunds[0].n, "one refund entry").toBe(1);
  // The shop's share waits for its next settlement; the rider is paid the pickup fee.
  const [adj] = await db()<{ status: string; amount: number; type: string }[]>`select status, amount_paise::int as amount, type from financial_adjustments where order_id = ${order.id} and type in ('REFUND_SHOP','REFUND_PLATFORM')`;
  expect(adj?.type, "charged to the shop (reason DAMAGED)").toBe("REFUND_SHOP");
  expect(adj?.status, "pending for the next settlement").toBe("PENDING");
  const [fee] = await db()<{ total: number }[]>`select total_paise::int as total from delivery_partner_earnings where return_pickup_id = ${pickup.id}`;
  expect(fee?.total ?? 0, "the rider's pickup fee").toBeGreaterThan(0);
  const statement = (await api("rider", "GET", "/api/delivery-partner/earnings")).body.statement as { totalPaise: number; deliveryOrderId: string | null }[];
  expect(statement.some((e) => e.deliveryOrderId === null && e.totalPaise === fee.total), "the pickup fee is in the rider's statement (payable in the weekly payout)").toBe(true);
  const history = await db()<{ to_status: string }[]>`select to_status from return_status_history where return_id = ${returnId} order by created_at`;
  return `${order.orderNumber}: return statuses ${history.map((h) => h.to_status).join(" → ")} (customer saw ${seen.join(" → ")}); wrong code ${wrong.status}; refund ₹60 once (second issue_refund → ${twice.status}); shop share ${adj.amount / 100} pending; rider pickup fee ₹${fee.total / 100}`;
}, { ...local, partial: "TC-FIN-019's 'return-pickup fee in the payout' is shown as the fee in the rider's unpaid statement, which the weekly payout batches" });
