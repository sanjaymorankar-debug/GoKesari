/**
 * Suspension journeys.
 *   SC-16 — a shop with orders at CONFIRMED, PREPARING and OUT_FOR_DELIVERY
 *           is suspended after a preview: the policy is applied per status,
 *           the owner is told, customers cannot order meanwhile, the held
 *           order is decided by operations, and reinstatement restores
 *           service.
 *   SC-18 — a risk condition (two deliveries with every delivery-code
 *           attempt used) raises one flag; operations review it and suspend
 *           the rider from the flag (with notice, the flag closed with the
 *           reason); the admin reinstates the rider.
 *
 * Local tier: SC-16 uses a new owner's shop (approved for the journey) so
 * the world's shops are never suspended; SC-18 uses rider 2, reinstated at
 * the end, and moves rider 2's older lock-outs out of the rule's window so
 * that the flag comes from this journey only.
 */
import {
  addToCart,
  api,
  asPage,
  buy,
  emptyCart,
  ensureFunds,
  freeRider,
  freshListing,
  mailedDeliveryCode,
  offerFor,
  ownerAction,
  packOrder,
  partnerId,
  pickupCode,
  riderAction,
  sellingShop,
  slipCode,
  userOf,
  walletBalance,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { expectStatus, why } from "../lib/http";
import { expect, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 420_000 };

async function statusOf(orderId: string) {
  const [row] = await db()<{ status: string }[]>`select status from orders where id = ${orderId}`;
  return row.status;
}

/* ------------------------------------------------------------------ SC-16 */

qa("SC-16", "shop suspension with open orders: the preview, the policy applied per status, the owner informed, no ordering meanwhile, the held order decided, reinstatement restores service", async () => {
  const shop = await sellingShop("sc16");
  try {
    await ensureFunds("customer", 200_000);
    await freeRider("rider");
    // 1. Orders at OUT_FOR_DELIVERY, PREPARING and CONFIRMED.
    const out = await buy(shop.listing, 1);
    for (const a of ["accept", "start", "ready"] as const) expectStatus(await ownerAction(shop.owner.ctx, out.id, a), 200, `out-for-delivery order: ${a}`);
    const offer = await offerFor(out.id, "rider");
    if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, "rider"), 200, "rider accepts");
    const code = await slipCode(shop.owner.ctx, out.id);
    expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, "rider"), 200, "pickup");
    const started = Date.now() - 2000;
    expectStatus(await riderAction(offer.deliveryOrderId, "start", {}, "rider"), 200, "start the drop");
    const preparing = await buy(shop.listing, 1);
    for (const a of ["accept", "start"] as const) expectStatus(await ownerAction(shop.owner.ctx, preparing.id, a), 200, `preparing order: ${a}`);
    const confirmed = await buy(shop.listing, 1);
    expect([await statusOf(confirmed.id), await statusOf(preparing.id), await statusOf(out.id)]).toEqual(["CONFIRMED", "PREPARING", "OUT_FOR_DELIVERY"]);
    // 2. Preview, then confirm the suspension.
    const preview = await api("admin", "GET", `/api/shops/${shop.shopId}/suspend`);
    expectStatus(preview, 200, "impact preview");
    const planned = new Map((preview.body.orders as { orderId: string; plannedAction: string }[]).map((o) => [o.orderId, o.plannedAction]));
    expect([planned.get(confirmed.id), planned.get(preparing.id), planned.get(out.id)], "planned: cancel & refund / hold / continue").toEqual(["CANCEL_REFUND", "REVIEW", "CONTINUE"]);
    expect(await statusOf(confirmed.id), "nothing changes on preview").toBe("CONFIRMED");
    const since = new Date();
    const wallet = await walletBalance();
    const res = await api("admin", "POST", `/api/shops/${shop.shopId}/suspend`, { reason: "QA SC-16: food safety complaint under review", expectedAction: "Send the inspection report to support" });
    expectStatus(res, 200, "suspend");
    expect(res.body.status).toBe("SUSPENDED");
    const bad: string[] = [];
    if (!["CANCELLED", "REFUNDED"].includes(await statusOf(confirmed.id))) bad.push(`CONFIRMED order → ${await statusOf(confirmed.id)}`);
    if ((await walletBalance()) - wallet !== confirmed.totalPaise) bad.push(`refund of the confirmed order: ${(await walletBalance()) - wallet} (expected ${confirmed.totalPaise})`);
    if ((await statusOf(preparing.id)) !== "PREPARING") bad.push(`held PREPARING order → ${await statusOf(preparing.id)}`);
    // The order on the road continues.
    const otp = await mailedDeliveryCode(userOf("customer").email, out.orderNumber, started);
    expectStatus(await riderAction(offer.deliveryOrderId, "deliver", { otp }, "rider"), 200, "the order on the road is delivered");
    // The owner is informed.
    const notes = await db()<{ title: string; body: string }[]>`select title, body from notifications where user_id = ${shop.owner.id} and created_at >= ${since}`;
    if (!notes.some((n) => /suspend/i.test(n.title + n.body) && n.body.includes("food safety complaint"))) bad.push(`owner notification with the reason missing (${notes.map((n) => n.title).join(", ") || "none"})`);
    // Customers cannot order meanwhile.
    await emptyCart();
    const add = await addToCart("customer", shop.listing.shopProductId, 1);
    if (add.status < 400 || add.status >= 500) bad.push(`add to cart from the suspended shop → ${add.status}`);
    // 3. Operations decide the held order: cancel and refund.
    const beforeDecision = await walletBalance();
    expectStatus(await api("admin", "POST", "/api/admin/suspensions", { orderId: preparing.id, decision: "CANCEL_REFUND", note: "QA: the shop cannot finish it" }), 200, "decide the held order");
    if (!["CANCELLED", "REFUNDED"].includes(await statusOf(preparing.id))) bad.push(`decided order → ${await statusOf(preparing.id)}`);
    if ((await walletBalance()) - beforeDecision !== preparing.totalPaise) bad.push("the decided order was not refunded in full");
    // 4. Reinstatement restores service.
    expectStatus(await api("admin", "POST", `/api/shops/${shop.shopId}/reactivate`, { note: "QA: report received" }), 200, "reinstate");
    const again = await addToCart("customer", shop.listing.shopProductId, 1);
    if (again.status !== 200 && again.status !== 201) bad.push(`add to cart after reinstatement → ${again.status} ${why(again)}`);
    await emptyCart();
    expect(bad, bad.join("\n")).toEqual([]);
    return `CONFIRMED ${confirmed.orderNumber} cancelled + ₹${confirmed.totalPaise / 100} refunded; PREPARING ${preparing.orderNumber} held, then cancelled & refunded by operations; OUT_FOR_DELIVERY ${out.orderNumber} delivered; owner notified with the reason; cart refused (${add.status}) while suspended, accepted after reinstatement`;
  } finally {
    if ((await db()<{ status: string }[]>`select status from shops where id = ${shop.shopId}`)[0]?.status === "SUSPENDED") await api("admin", "POST", `/api/shops/${shop.shopId}/reactivate`, { note: "QA cleanup" });
    await shop.owner.ctx.dispose();
  }
}, local);

/* ------------------------------------------------------------------ SC-18 */

qa("SC-18", "risk flag to suspension: two deliveries with every code attempt used raise one flag; operations suspend the rider from the flag with notice and the flag closes with the reason; the admin reinstates", async ({ browser }) => {
  const rider2 = await partnerId("rider2");
  const r2user = userOf("rider2").id!;
  // Only this journey's lock-outs count: older ones of rider 2 are moved out of the rule's 30-day window, and any open flag closed.
  await db()`update delivery_orders set updated_at = now() - interval '60 days' where delivery_partner_id = ${rider2} and delivery_otp_attempts >= 5`;
  for (const f of (await api("ops", "GET", "/api/admin/risk?subjectType=DELIVERY_PARTNER")).body as { id: string; subjectId: string; ruleCode: string }[]) {
    if (f.subjectId === rider2 && f.ruleCode === "OTP_LOCKOUTS") await api("ops", "PATCH", `/api/admin/risk/${f.id}`, { decision: "DISMISSED", note: "QA: reset before SC-18" });
  }
  try {
    await freeRider("rider2");
    await ensureFunds("customer", 100_000);
    const listing = await freshListing({ name: "QA Risk Biscuits", pricePaise: 3000, stock: 10 });
    const tries: number[] = [];
    // 1. Two deliveries where the code is entered wrong until it locks.
    for (let n = 0; n < 2; n++) {
      const order = await buy(listing, 1);
      await packOrder(order.id);
      const offer = await offerFor(order.id, "rider2");
      if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, "rider2"), 200, "accept");
      const code = await pickupCode(order.id);
      expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, "rider2"), 200, "pickup");
      expectStatus(await riderAction(offer.deliveryOrderId, "start", {}, "rider2"), 200, "start");
      for (let i = 0; i < 5; i++) tries.push((await riderAction(offer.deliveryOrderId, "deliver", { otp: "0000" }, "rider2")).status);
      expectStatus(await api("ops", "POST", `/api/orders/${order.id}/confirm-delivery`, { proofNote: "QA: customer confirmed by phone" }), 200, "operations confirm the delivery");
    }
    const [{ locked }] = await db()<{ locked: number }[]>`select count(*)::int as locked from delivery_orders where delivery_partner_id = ${rider2} and delivery_otp_attempts >= 5 and updated_at > now() - interval '30 days'`;
    expect(locked, "two lock-outs recorded").toBe(2);
    // 2. Run the rules (twice: still one flag).
    for (let i = 0; i < 2; i++) expectStatus(await api("ops", "POST", "/api/admin/risk", {}), [200, 201], "run the risk rules");
    const flags = ((await api("ops", "GET", "/api/admin/risk?subjectType=DELIVERY_PARTNER")).body as { id: string; subjectId: string; ruleCode: string; status: string; occurrences: number }[])
      .filter((f) => f.subjectId === rider2 && f.ruleCode === "OTP_LOCKOUTS");
    expect(flags.length, "one open flag for rider 2").toBe(1);
    const flag = flags[0];
    // 3. Operations review it and suspend the rider from the flag.
    const since = new Date();
    const reason = "QA SC-18: repeated wrong delivery codes";
    const [{ full_name: riderName }] = await db()<{ full_name: string }[]>`select full_name from delivery_partners where id = ${rider2}`;
    await asPage(browser, "ops", "/admin/risk", async (page) => {
      const row = page.getByTestId("risk-flags").locator("div.space-y-1").filter({ hasText: `Delivery codes repeatedly entered wrong — ${riderName}` }).first();
      await row.getByTestId("risk-suspend").click();
      await row.getByLabel(/Reason for suspending this/).fill(reason);
      await row.getByRole("button", { name: "Confirm suspension" }).click();
      await expect(page.getByText(/was suspended and the flag marked actioned/)).toBeVisible({ timeout: 20_000 });
    });
    const [partner] = await db()<{ status: string }[]>`select status from delivery_partners where id = ${rider2}`;
    const [closed] = await db()<{ status: string; review_note: string | null }[]>`select status, review_note from risk_flags where id = ${flag.id}`;
    const notes = await db()<{ title: string; body: string }[]>`select title, body from notifications where user_id = ${r2user} and created_at >= ${since}`;
    const bad: string[] = [];
    if (partner.status !== "SUSPENDED") bad.push(`rider 2 is ${partner.status}`);
    if (closed.status !== "ACTIONED" || !closed.review_note?.includes(reason)) bad.push(`flag ${closed.status} "${closed.review_note}"`);
    if (!notes.some((n) => /suspend/i.test(n.title + n.body))) bad.push(`no suspension notice to the rider (${notes.map((n) => n.title).join(", ") || "none"})`);
    // 4. The admin reinstates.
    expectStatus(await api("admin", "PATCH", `/api/delivery-partner/${rider2}`, { action: "reactivate", reason: "QA: suspension reviewed" }), 200, "reinstate rider 2");
    const [back] = await db()<{ status: string }[]>`select status from delivery_partners where id = ${rider2}`;
    if (back.status !== "APPROVED") bad.push(`after reinstatement rider 2 is ${back.status}`);
    expect(bad, bad.join("\n")).toEqual([]);
    return `wrong codes → ${[...new Set(tries)].join("/")}; 2 lock-outs; rules run twice → one OTP_LOCKOUTS flag; suspended from /admin/risk by operations ("${reason}"), flag ACTIONED "${closed.review_note}", rider notified (${notes.map((n) => n.title).join(", ")}); reinstated → APPROVED`;
  } finally {
    const [p] = await db()<{ status: string }[]>`select status from delivery_partners where id = ${rider2}`;
    if (p?.status === "SUSPENDED") await api("admin", "PATCH", `/api/delivery-partner/${rider2}`, { action: "reactivate", reason: "QA cleanup" });
  }
}, local);

