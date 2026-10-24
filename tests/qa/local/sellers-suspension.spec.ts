/**
 * Shop suspension (NEW-002): the impact preview, suspending a shop with open
 * orders in every status, the owner's notice, what customers can no longer
 * do, deciding the held orders, reinstating, a changed suspension policy,
 * suspending from the risk page, and two suspensions at once.
 *
 * Local tier: it suspends shops. Every shop here is a fresh owner's shop
 * selling the world's QA catalogue beside shop A, so the world's customer
 * and riders serve it; the world's own shops are never suspended.
 * The checks run in order and hand the shop on through the stash.
 */
import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { addToCart, deliveryCode, emptyCart, offerFor, onlyRiderOnline, placeOrder, riderAction, walletBalance, type PlacedOrder } from "../lib/flows";
import { anonymous, call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import { messagesTo } from "../lib/mail";
import { blocked, expect, qa } from "../lib/record";
import {
  approvedShopOfNewOwner,
  auditRows,
  ctxFor,
  notificationsOf,
  orderStatus,
  ownerFulfil,
  ownerPickupCode,
  pageFor,
  sellingShop,
  shopRow,
  withRule,
  type Account,
  RUN_KEY,
} from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 300_000 };
const KEY = `suspension-${RUN_KEY}`;

interface Arranged {
  shopId: string;
  shopName: string;
  owner: Account;
  orders: Record<"confirmed" | "accepted" | "preparing" | "ready" | "assigned" | "outForDelivery", { id: string; orderNumber: string; totalPaise: number }>;
  deliveries: { assigned: string; outForDelivery: string };
  listingId: string;
  suspendedAt?: string;
  walletBeforeSuspend?: number;
}

function arranged(): Arranged {
  return unstash<Arranged>(KEY) ?? blocked("needs the shop with open orders arranged by TC-ONB-030 in this run");
}

const pick = (o: PlacedOrder) => ({ id: o.id, orderNumber: o.orderNumber, totalPaise: o.totalPaise });

/** A READY order of the shop taken by `rider`, up to `until`. */
async function riderTakes(ctx: Awaited<ReturnType<typeof ctxFor>>, orderId: string, rider: "rider" | "rider2", until: "ASSIGNED" | "OUT_FOR_DELIVERY") {
  await onlyRiderOnline(rider);
  for (const action of ["accept", "start", "ready"] as const) expectStatus(await ownerFulfil(ctx, orderId, action), 200, `shop ${action}`);
  const offer = await offerFor(orderId, rider, 60_000);
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, rider), 200, "rider accepts");
  if (until === "OUT_FOR_DELIVERY") {
    const code = await ownerPickupCode(ctx, orderId);
    expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, rider), 200, "pickup");
    expectStatus(await riderAction(offer.deliveryOrderId, "start", {}, rider), 200, "start delivery");
  }
  return offer.deliveryOrderId;
}

/** A shop of a fresh owner with one open order in each status the policy names. */
async function arrangeShopWithOrders(label: string): Promise<Arranged> {
  const made = await sellingShop(label);
  const order = () => placeOrder({ method: "WALLET", listing: made.listing });
  const outForDelivery = await order();
  const dOut = await riderTakes(made.ctx, outForDelivery.id, "rider", "OUT_FOR_DELIVERY");
  const assigned = await order();
  const dAssigned = await riderTakes(made.ctx, assigned.id, "rider2", "ASSIGNED");
  const ready = await order();
  for (const a of ["accept", "start", "ready"] as const) expectStatus(await ownerFulfil(made.ctx, ready.id, a), 200, `ready: ${a}`);
  const preparing = await order();
  for (const a of ["accept", "start"] as const) expectStatus(await ownerFulfil(made.ctx, preparing.id, a), 200, `preparing: ${a}`);
  const accepted = await order();
  expectStatus(await ownerFulfil(made.ctx, accepted.id, "accept"), 200, "accepted");
  const confirmed = await order();
  const statuses = await Promise.all([confirmed, accepted, preparing, ready, assigned, outForDelivery].map((o) => orderStatus(o.id)));
  expect(statuses).toEqual(["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "OUT_FOR_DELIVERY"]);
  return {
    shopId: made.shop.id,
    shopName: made.shop.name,
    owner: made.owner,
    orders: { confirmed: pick(confirmed), accepted: pick(accepted), preparing: pick(preparing), ready: pick(ready), assigned: pick(assigned), outForDelivery: pick(outForDelivery) },
    deliveries: { assigned: dAssigned, outForDelivery: dOut },
    listingId: made.listing.shopProductId,
  };
}

const ACTIONS: Record<string, string> = {
  CONFIRMED: "CANCEL_REFUND",
  ACCEPTED: "REVIEW",
  PREPARING: "REVIEW",
  READY: "REVIEW",
  ASSIGNED: "REVIEW",
  PICKED_UP: "CONTINUE",
  OUT_FOR_DELIVERY: "CONTINUE",
};

qa("TC-ONB-030", "suspension impact preview: every open order with its planned action, the counts (cancel & refund / shop finishes / hold) and the refund value, before confirming", async ({ browser }) => {
  const shop = await arrangeShopWithOrders("onb030");
  stash(KEY, shop);
  const preview = await call(await as("admin"), "GET", `/api/shops/${shop.shopId}/suspend`);
  expectStatus(preview, 200, "preview");
  const byId = new Map((preview.body.orders as { orderId: string; status: string; plannedAction: string }[]).map((o) => [o.orderId, o]));
  for (const o of Object.values(shop.orders)) {
    const row = byId.get(o.id);
    expect(row, `${o.orderNumber} listed`).toBeTruthy();
    expect(row!.plannedAction, `${o.orderNumber} (${row!.status})`).toBe(ACTIONS[row!.status]);
  }
  expect(preview.body.counts).toEqual({ cancelRefund: 1, continue: 1, review: 4, leftAlone: 0 });
  expect(preview.body.refundPaise).toBe(shop.orders.confirmed.totalPaise);
  expect((await shopRow(shop.shopId)).status, "nothing changed yet").toBe("APPROVED");
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/shops");
    await page.getByPlaceholder("Search shop, owner or registration number").fill(shop.shopName);
    const row = page.getByRole("row").filter({ hasText: shop.shopName }).first();
    await row.getByRole("button", { name: "Suspend…" }).click();
    const impact = page.getByTestId("suspend-impact");
    await expect(impact).toContainText("1 cancelled and refunded");
    await expect(impact).toContainText("1 will be completed by the shop");
    await expect(impact).toContainText("4 held for an operations decision");
    for (const o of Object.values(shop.orders)) await expect(impact).toContainText(o.orderNumber);
    await page.getByTestId("suspend-panel").getByRole("button", { name: "Cancel" }).click();
  } finally {
    await context.close();
  }
  expect((await shopRow(shop.shopId)).status).toBe("APPROVED");
  return `6 open orders: CONFIRMED→cancel & refund, ACCEPTED/PREPARING/READY/ASSIGNED→hold, OUT_FOR_DELIVERY→continue; refund ₹${preview.body.refundPaise / 100}; the Suspend… panel lists each order and the counts before confirming`;
}, { ...local, partial: "PICKED_UP is covered by the policy table (CONTINUE) but not arranged — the OUT_FOR_DELIVERY order passed through it" });

qa("TC-ONB-031", "suspend with a reason and expected action: SUSPENDED; CONFIRMED cancelled, refunded and restocked; OUT_FOR_DELIVERY continues (delivered); ACCEPTED/PREPARING/READY/ASSIGNED held; the response summarises the impact", async ({ browser }) => {
  const shop = arranged();
  const walletBefore = await walletBalance();
  // A cart left with this shop's product (TC-ONB-033 tries to pay it later).
  await emptyCart();
  expectStatus(await addToCart("customer", shop.listingId, 1), [200, 201], "a cart line from the shop");
  const [stockBefore] = await db()<{ online_stock: number }[]>`select online_stock from shop_products where id = ${shop.listingId}`;
  const { context, page } = await pageAs(browser, "admin");
  let message = "";
  try {
    await page.goto("/admin/shops");
    await page.getByPlaceholder("Search shop, owner or registration number").fill(shop.shopName);
    const row = page.getByRole("row").filter({ hasText: shop.shopName }).first();
    await row.getByRole("button", { name: "Suspend…" }).click();
    await expect(page.getByTestId("suspend-impact")).toBeVisible();
    await page.getByLabel("Reason (shown to the owner)").fill("QA: repeated hygiene complaints");
    await page.getByLabel("What the owner must do (optional)").fill("Send a cleaning certificate to support");
    await page.getByRole("button", { name: "Suspend shop" }).click();
    const done = page.getByText(/^Suspended — /);
    await expect(done).toBeVisible({ timeout: 30_000 });
    message = await done.innerText();
  } finally {
    await context.close();
  }
  expect(message).toMatch(/1 cancelled, 1 continuing, 4 under review/);
  stash(KEY, { ...shop, suspendedAt: new Date().toISOString(), walletBeforeSuspend: walletBefore });
  expect((await shopRow(shop.shopId)).status).toBe("SUSPENDED");
  const s = await Promise.all(Object.values(shop.orders).map((o) => orderStatus(o.id)));
  expect(["CANCELLED", "REFUNDED"]).toContain(s[0]);
  expect(s.slice(1)).toEqual(["ACCEPTED", "PREPARING", "READY", "ASSIGNED", "OUT_FOR_DELIVERY"]);
  expect(await walletBalance(), "the confirmed order refunded in full").toBe(walletBefore + shop.orders.confirmed.totalPaise);
  const [stockAfter] = await db()<{ online_stock: number }[]>`select online_stock from shop_products where id = ${shop.listingId}`;
  expect(stockAfter.online_stock, "the cancelled unit restocked").toBe(stockBefore.online_stock + 1);
  // The order already on the road is completed.
  const otp = await deliveryCode(shop.orders.outForDelivery.id);
  expectStatus(await riderAction(shop.deliveries.outForDelivery, "deliver", { otp }, "rider"), 200, "deliver the order on the road");
  expect(await orderStatus(shop.orders.outForDelivery.id)).toBe("DELIVERED");
  const audits = await auditRows(shop.shopId, "%suspend%");
  expect(audits.length).toBeGreaterThan(0);
  return `"${message}"; CONFIRMED → ${s[0]} with ₹${shop.orders.confirmed.totalPaise / 100} back in the wallet and +1 stock; the out-for-delivery order was delivered; the rest held`;
}, { ...local, mobile: false });

qa("TC-ONB-032", "the owner sees the suspension: red banner with reason, effective time, what to do and what happened to orders; a matching notification and email", async ({ browser }) => {
  const shop = arranged();
  const since = new Date(shop.suspendedAt ?? Date.now() - 600_000).getTime() - 60_000;
  const { context, page } = await pageFor(browser, shop.owner);
  try {
    await page.goto("/shop");
    await expect(page.getByRole("status").filter({ hasText: /suspended/i, visible: true }).first()).toBeVisible();
    await page.goto("/shop/manage/today");
    const notice = page.getByTestId("suspension-notice");
    await expect(notice).toContainText("Your shop is suspended");
    await expect(notice).toContainText("QA: repeated hygiene complaints");
    await expect(notice).toContainText("Send a cleaning certificate to support");
    await expect(notice).toContainText(/Since \d/);
    await expect(notice).toContainText(/Orders already on the road should still be completed/);
  } finally {
    await context.close();
  }
  const notes = await notificationsOf(shop.owner.id, new Date(since));
  const note = notes.find((n) => /suspend/i.test(`${n.type} ${n.title}`));
  expect(note, `notification: ${JSON.stringify(notes)}`).toBeTruthy();
  expect(`${note!.title} ${note!.body}`).toContain("QA: repeated hygiene complaints");
  expect(`${note!.body}`, "what happened to orders").toMatch(/cancelled and refunded|on the road|reviewed/);
  const mails = messagesTo(shop.owner.email, since);
  expect(mails.some((m) => /suspend/i.test(m.body) && /hygiene complaints/.test(m.body)), `email to ${shop.owner.email} (${mails.length} messages)`).toBe(true);
  return `banner on /shop and /shop/manage/today with reason, since-time, what to do and the order note; notification "${note!.title}"; email sent`;
}, local);

qa("TC-ONB-033", "customers cannot buy from a suspended shop: absent from lists, items unavailable, checkout of an existing cart refused", async () => {
  const shop = arranged();
  const guest = await anonymous();
  const search = await call(guest, "GET", `/api/shops?q=${encodeURIComponent(shop.shopName)}&limit=24`);
  const listed = (Array.isArray(search.body) ? search.body : (search.body?.shops ?? [])) as { id: string }[];
  expect(listed.some((s) => s.id === shop.shopId), "not in shop search").toBe(false);
  const products = await call(guest, "GET", `/api/shops/${shop.shopId}/products?limit=10`);
  expect(products.status, "storefront items").toBe(404);
  await guest.dispose();
  const add = await addToCart("customer", shop.listingId, 1);
  expect(add.status, `add to cart: ${why(add)}`).toBeGreaterThanOrEqual(400);
  const before = await walletBalance();
  const res = await call(await as("customer"), "POST", "/api/checkout", {
    requestId: `qa-${RUN}-suspended`,
    addressId: null,
    paymentMethod: "WALLET",
    acknowledgeClosedShopIds: [shop.shopId],
  });
  expect(res.status, `checkout: ${why(res)}`).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(await walletBalance(), "no debit").toBe(before);
  await emptyCart();
  return `search: absent; storefront 404; add to cart ${add.status}; checkout of the cart line → ${res.status} ${res.body?.error?.code ?? ""}`;
}, local);

qa("TC-ONB-034", "decide held orders on /admin/suspensions: 'Let the shop finish it' proceeds, 'Cancel & refund' refunds in full, the outcome is recorded and the owner notified; a held READY order is not dispatched until decided", async ({ browser }) => {
  const shop = arranged();
  const since = new Date();
  // The held READY order: no rider is offered it while it waits.
  await onlyRiderOnline("rider");
  const offers = await call(await as("rider"), "GET", "/api/delivery-partner/deliveries");
  expect(JSON.stringify(offers.body ?? {}), "the held READY order is not offered").not.toContain(shop.orders.ready.id);
  const before = await walletBalance();
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/suspensions");
    const item = (n: string) => page.getByTestId("suspension").getByRole("listitem").filter({ hasText: n }).first();
    await expect(item(shop.orders.accepted.orderNumber)).toContainText("Needs your decision");
    await item(shop.orders.accepted.orderNumber).getByRole("button", { name: /Let the shop finish it/i }).click();
    await expect(item(shop.orders.accepted.orderNumber)).toContainText("Shop is finishing it", { timeout: 20_000 });
    await item(shop.orders.assigned.orderNumber).getByRole("button", { name: /Cancel & refund/i }).click();
    await expect(item(shop.orders.assigned.orderNumber)).toContainText("Cancelled & refunded", { timeout: 20_000 });
  } finally {
    await context.close();
  }
  expect(await orderStatus(shop.orders.accepted.id), "continues with the shop").toBe("ACCEPTED");
  expectStatus(await ownerFulfil(await ctxFor(shop.owner), shop.orders.accepted.id, "start"), 200, "the shop carries on with the order it may finish");
  expect(["CANCELLED", "REFUNDED"]).toContain(await orderStatus(shop.orders.assigned.id));
  expect(await walletBalance(), "full refund").toBe(before + shop.orders.assigned.totalPaise);
  const list = await call(await as("admin"), "GET", "/api/admin/suspensions");
  const mine = (list.body.suspensions as { suspension: { shopId: string }; orders: { orderId: string; outcome: string }[] }[]).find((s) => s.suspension.shopId === shop.shopId);
  const outcome = new Map(mine!.orders.map((o) => [o.orderId, o.outcome]));
  expect(outcome.get(shop.orders.accepted.id)).toBe("CONTINUING");
  expect(outcome.get(shop.orders.assigned.id)).toBe("CANCELLED");
  const notes = await notificationsOf(shop.owner.id, since);
  return `ACCEPTED → finish (outcome CONTINUING, the shop could start picking); ASSIGNED → cancelled, ₹${shop.orders.assigned.totalPaise / 100} refunded; held READY not offered; owner notifications since: ${notes.map((n) => n.type).join(", ") || "none"}`;
}, { ...local, partial: "an owner notification for each decision is not asserted (none is sent for a CONTINUE decision on this build — recorded in the detail)" });

qa("TC-ONB-035", "reinstate: APPROVED, held orders go back to the shop, the owner is notified, ordering works again", async () => {
  const shop = arranged();
  const since = new Date();
  const res = await call(await as("admin"), "POST", `/api/shops/${shop.shopId}/reactivate`, { note: "QA: certificate received" });
  expectStatus(res, 200, "reinstate");
  expect((await shopRow(shop.shopId)).status).toBe("APPROVED");
  const list = await call(await as("admin"), "GET", "/api/admin/suspensions");
  const still = (list.body.suspensions as { suspension: { shopId: string } }[]).some((s) => s.suspension.shopId === shop.shopId);
  expect(still, "no longer an active suspension").toBe(false);
  const [held] = await db()<{ outcome: string; n: number }[]>`
    select o.outcome, count(*)::int as n from shop_suspension_orders o join shop_suspensions s on s.id = o.suspension_id
    where s.shop_id = ${shop.shopId} and o.order_id in (${shop.orders.preparing.id}, ${shop.orders.ready.id}) group by o.outcome`;
  expect(held, "held orders back with the shop").toEqual({ outcome: "CONTINUING", n: 2 });
  expectStatus(await ownerFulfil(await ctxFor(shop.owner), shop.orders.preparing.id, "ready"), 200, "the shop finishes a held order");
  const notes = await notificationsOf(shop.owner.id, since);
  expect(notes.some((n) => /reactivat|reinstat/i.test(`${n.type} ${n.title}`)), JSON.stringify(notes)).toBe(true);
  await emptyCart();
  const add = await addToCart("customer", shop.listingId, 1);
  expectStatus(add, [200, 201], "ordering works again");
  await emptyCart();
  return "APPROVED; the two held orders → CONTINUING and the shop could mark one READY; owner notified; add to cart works";
}, local);

qa("TC-ONB-036", "a changed suspension policy (READY → CONTINUE) drives both the preview and the outcome; the default is restored", async () => {
  return withRule("suspension", { actions: { ...ACTIONS, READY: "CONTINUE" } }, async () => {
    const made = await sellingShop("onb036");
    const ready = await placeOrder({ method: "WALLET", listing: made.listing });
    for (const a of ["accept", "start", "ready"] as const) expectStatus(await ownerFulfil(made.ctx, ready.id, a), 200, a);
    const preview = await call(await as("admin"), "GET", `/api/shops/${made.shop.id}/suspend`);
    const row = (preview.body.orders as { orderId: string; plannedAction: string }[]).find((o) => o.orderId === ready.id);
    expect(row?.plannedAction).toBe("CONTINUE");
    const res = await call(await as("admin"), "POST", `/api/shops/${made.shop.id}/suspend`, { reason: "QA policy check" });
    expectStatus(res, 200, "suspend");
    expect(res.body.impact).toMatchObject({ continuing: 1, awaitingReview: 0 });
    expectStatus(await call(await as("admin"), "POST", `/api/shops/${made.shop.id}/reactivate`, { note: "QA policy check done" }), 200, "reinstate");
    return "READY → CONTINUE in the preview and the outcome (continuing 1, review 0); rule restored afterwards";
  });
}, local);

qa("TC-ONB-037", "suspend from the risk page: the policy and the notice apply; the flag closes as ACTIONED with 'Suspended: <reason>'", async ({ browser }) => {
  const made = await sellingShop("onb037");
  const order = await placeOrder({ method: "WALLET", listing: made.listing });
  const [flag] = await db()<{ id: string }[]>`
    insert into risk_flags (subject_type, subject_id, rule_code, severity, summary)
    values ('SHOP', ${made.shop.id}, 'highRefundRate', 'HIGH', ${`QA risk flag ${RUN}`}) returning id`;
  const since = new Date();
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/risk");
    const row = page.getByTestId("risk-flags").locator("div.p-3").filter({ hasText: `QA risk flag ${RUN}` }).first();
    await row.getByTestId("risk-suspend").click();
    await row.getByLabel(/Reason for suspending this/).fill("QA: refunds far above normal");
    await row.getByRole("button", { name: "Confirm suspension" }).click();
    // The page refreshes and the closed flag leaves the open list.
    await expect.poll(async () => (await db()<{ status: string }[]>`select status from risk_flags where id = ${flag.id}`)[0].status, { timeout: 30_000 }).toBe("ACTIONED");
    await expect(page.getByText(`QA risk flag ${RUN}`)).toHaveCount(0);
  } finally {
    await context.close();
  }
  expect((await shopRow(made.shop.id)).status).toBe("SUSPENDED");
  expect(["CANCELLED", "REFUNDED"], "the policy cancelled the confirmed order").toContain(await orderStatus(order.id));
  const [f] = await db()<{ status: string; review_note: string }[]>`select status, review_note from risk_flags where id = ${flag.id}`;
  expect(f.status).toBe("ACTIONED");
  expect(f.review_note).toBe("Suspended: QA: refunds far above normal");
  const notes = await notificationsOf(made.owner.id, since);
  expect(notes.some((n) => /suspend/i.test(`${n.type} ${n.title}`))).toBe(true);
  expectStatus(await call(await as("admin"), "POST", `/api/shops/${made.shop.id}/reactivate`, { note: "QA risk check done" }), 200, "reinstate");
  return `risk page → shop SUSPENDED, its confirmed order cancelled by the policy, owner notified; flag ACTIONED "${f.review_note}"`;
}, local);

qa("TC-ONB-038", "two suspensions sent together: one succeeds, the other 409; one audit row", async () => {
  const { shop } = await approvedShopOfNewOwner("onb038");
  const admin = await as("admin");
  const ops = await as("ops");
  const [a, b] = await Promise.all([
    call(admin, "POST", `/api/shops/${shop.id}/suspend`, { reason: "QA concurrent one" }),
    call(ops, "POST", `/api/shops/${shop.id}/suspend`, { reason: "QA concurrent two" }),
  ]);
  expect([a.status, b.status].sort(), `${why(a)} / ${why(b)}`).toEqual([200, 409]);
  const audits = (await auditRows(shop.id)).filter((r) => r.action === "shop.suspended" || /SUSPENDED/.test(JSON.stringify(r.new_value ?? "")));
  expect(audits.length, `audit rows: ${audits.map((r) => r.action).join(", ")}`).toBe(1);
  expectStatus(await call(admin, "POST", `/api/shops/${shop.id}/reactivate`, { note: "QA concurrency done" }), 200, "reinstate");
  // A suspend and a reject together: whichever lands second must be refused. Sent one after the
  // other, so the order is known (in parallel the outcome depends on timing).
  const second = await approvedShopOfNewOwner("onb038b");
  const s1 = await call(admin, "POST", `/api/shops/${second.shop.id}/suspend`, { reason: "QA suspend vs reject" });
  expectStatus(s1, 200, "suspend");
  const r1 = await call(ops, "POST", `/api/shops/${second.shop.id}/reject`, { reason: "QA reject vs suspend" });
  const final = await shopRow(second.shop.id);
  const rows = (await auditRows(second.shop.id)).filter((r) => r.action === "shop.suspended" || r.action === "shop.rejected");
  expect(r1.status, `reject after suspend → ${r1.status}; shop now ${final.status}; audit rows ${rows.map((r) => r.action).join(", ")}`).toBe(409);
  expect(rows.length).toBe(1);
  return `two suspends → ${a.status}/${b.status}, one audit row; reject after suspend → ${r1.status}`;
}, local);
