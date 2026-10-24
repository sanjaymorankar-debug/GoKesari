/**
 * Order rules that need the local server (package 5): the state history and
 * audit trail per change, unpaid orders, the shop acceptance timeout (incl.
 * a closed shop and each payment method), settlements versus cancelled and
 * disputed orders, subscription and suspended-shop fulfilment, aged return
 * and rating windows, refund retry, rule changes for returns, the public
 * grievance form, dispute escalation and photo proof of delivery.
 *
 * Local tier: rules are changed through /api/admin/settings and restored in
 * finally blocks; time is aged in the local database instead of waited for;
 * the sweeps run through the cron endpoints with the local CRON_SECRET.
 */
import type { Browser, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { as, pageAs } from "../lib/actors";
import { anonymous } from "../lib/http";
import { db } from "../lib/db";
import { onlyRiderOnline } from "../lib/flows";
import {
  abandon,
  call,
  checkoutLines,
  cron,
  customerCard,
  driveTo,
  ensureWallet,
  expectStatus,
  listingOf,
  notesFor,
  orderRow,
  PDF_BYTES,
  placeSimple,
  png,
  riderAction,
  releaseRiders,
  RUN,
  setStatus,
  shopAct,
  statusOf,
  stockOf,
  TEXT,
  upload,
  walletOf,
  withRule,
  withShopSettings,
  type Placed,
} from "../lib/orders-helpers";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };

async function ready() {
  await releaseRiders();
  await onlyRiderOnline("rider");
  await ensureWallet();
}

async function delivered(): Promise<Placed> {
  await ready();
  const placed = await placeSimple();
  await driveTo(placed.id, "DELIVERED");
  return placed;
}

/** Monday (IST) of last week, YYYY-MM-DD: only a finished week can be settled (TC-FLD-118). */
function lastMonday() {
  const ist = new Date(Date.now() + 5.5 * 3_600_000);
  const day = (ist.getUTCDay() + 6) % 7;
  ist.setUTCDate(ist.getUTCDate() - day - 7);
  return ist.toISOString().slice(0, 10);
}

/** Wednesday noon (IST) of the week starting `monday` — a delivery date inside that settlement week. */
function midWeek(monday: string) {
  return new Date(new Date(`${monday}T06:30:00Z`).getTime() + 2 * 86_400_000).toISOString();
}

/** Pays an online order on the local sandbox gateway page as the customer. */
async function payOnSandbox(browser: Browser, redirectUrl: string, outcome: "sandbox-pay" | "sandbox-fail" = "sandbox-pay") {
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto(redirectUrl);
    await page.getByTestId(outcome).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/orders/pay/sandbox"), { timeout: 30_000 });
  } finally {
    await context.close();
  }
}

async function onlineOrder(browser: Browser, outcome: "sandbox-pay" | "sandbox-fail" | null) {
  await ensureWallet();
  const listing = await listingOf("packaged");
  await call(await as("customer"), "DELETE", "/api/cart");
  expectStatus(await call(await as("customer"), "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 }), [200, 201], "add to cart");
  const address = world().addresses?.customer ?? null;
  const res = await call(await as("customer"), "POST", "/api/checkout", { requestId: `qa-${RUN}-${randomUUID().slice(0, 8)}`, addressId: address, paymentMethod: "ONLINE", acknowledgeClosedShopIds: [listing.shopId] });
  expectStatus(res, 201, "online checkout");
  const order = res.body.orders[0] as { id: string; orderNumber: string; status: string; totalPaise: number };
  const url = res.body.payment?.redirectUrl as string | undefined;
  if (outcome) await payOnSandbox(browser, need(url, "the sandbox payment link"), outcome);
  return { ...order, redirectUrl: url };
}

qa("TC-ORD-001", "every status change from CONFIRMED to DELIVERED leaves a history row (in order, with its time and actor) and an audit entry", async () => {
  const placed = await delivered();
  const history = await db()<{ previous_status: string | null; new_status: string; changed_by: string | null; created_at: Date }[]>`
    select previous_status, new_status, changed_by, created_at from order_status_history where order_id = ${placed.id} order by created_at`;
  const path = history.map((h) => h.new_status);
  const expected = ["ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"];
  expect(path.slice(-expected.length), "history in order").toEqual(expected);
  for (let i = 1; i < history.length; i++) expect(history[i].created_at.getTime(), "timestamps rise").toBeGreaterThanOrEqual(history[i - 1].created_at.getTime());
  expect(history.slice(-expected.length).every((h) => h.changed_by), "who made each change").toBe(true);
  const audits = await db()<{ new_value: { status: string } }[]>`select new_value from audit_logs where action = 'order.status_changed' and entity_id = ${placed.id} order by created_at`;
  expect(audits.map((a) => a.new_value.status), "one audit entry per change").toEqual(expect.arrayContaining(expected));
  expect(audits.length).toBeGreaterThanOrEqual(expected.length);
  return `${placed.orderNumber}: ${history.length} history rows (${path.join(" → ")}), ${audits.length} audit entries`;
}, { ...local, partial: "the customer's label per step is TC-ORD-001 in signed-in/orders-cancel.spec.ts" });

qa("TC-ORD-003", "an unpaid order (PENDING, or PAYMENT_FAILED after a failed online payment) cannot be confirmed or prepared by the shop", async ({ browser }) => {
  const restore = await withRule("onlinePayments", { enabled: true });
  const notes: string[] = [];
  try {
    const pending = await onlineOrder(browser, null);
    expect(pending.status, "an online order waits for payment").toBe("PENDING");
    for (const [what, res] of [
      ["CONFIRMED via /status", await setStatus(pending.id, "CONFIRMED")],
      ["PREPARING via /status", await setStatus(pending.id, "PREPARING")],
      ["accept", await shopAct(pending.id, "accept")],
      ["start", await shopAct(pending.id, "start")],
    ] as const) {
      expect(res.status, `${what} on PENDING`).toBeGreaterThanOrEqual(400);
      notes.push(`PENDING ${what} → ${res.status}`);
    }
    expect(await statusOf(pending.id)).toBe("PENDING");
    const failed = await onlineOrder(browser, "sandbox-fail");
    await expect.poll(() => statusOf(failed.id), { timeout: 20_000 }).toBe("PAYMENT_FAILED");
    const prep = await setStatus(failed.id, "PREPARING");
    expect(prep.status, "PREPARING on PAYMENT_FAILED").toBe(409);
    notes.push(`PAYMENT_FAILED PREPARING → ${prep.status}`);
    await abandon(pending.id);
  } finally {
    await restore();
  }
  return notes.join("; ");
}, { ...local, partial: "WALLET_INSUFFICIENT (subscription renewals) is not produced; CONFIRMED is not a target of /status at all (DEF-06) — 422" });

qa(["TC-ORD-015", "TC-ORD-016", "TC-ORD-017"], "acceptance timeout: an order gets an accept-by time (30 min), is cancelled at the timeout with a full refund, stock back and one notice each; an order accepted in time stays; a new value applies to new orders", async () => {
  const restore = await withRule("shopAcceptance", { enabled: true, acceptMinutes: 30, onTimeout: "CANCEL" });
  const listing = await listingOf("packaged");
  const notes: string[] = [];
  const made: string[] = [];
  try {
    await ensureWallet();
    const start = await walletOf();
    const stock = await stockOf(listing);
    const missed = await checkoutLines([{ listing }]);
    made.push(missed.id);
    const [row] = await db()<{ accept_by_at: Date; created_at: Date }[]>`select accept_by_at, created_at from orders where id = ${missed.id}`;
    const minutes = Math.round((row.accept_by_at.getTime() - row.created_at.getTime()) / 60_000);
    expect(minutes, "accept-by = placed + 30 min").toBe(30);
    notes.push(`threshold seen: ${minutes} min`);
    const inTime = await placeSimple();
    made.push(inTime.id);
    expectStatus(await shopAct(inTime.id, "accept"), 200, "accepted in time");
    await db()`update orders set accept_by_at = now() - interval '1 minute' where id = any(${[missed.id, inTime.id]}::uuid[])`;
    const sweep = await cron("/api/cron/shop-acceptance");
    expectStatus(sweep, 200, "acceptance sweep");
    expect(sweep.body.cancelled, "one order cancelled").toBe(1);
    expect(["CANCELLED", "REFUNDED"]).toContain(await statusOf(missed.id));
    expect((await orderRow(missed.id)).cancellationReason).toBe("The shop did not accept the order in time");
    expect(await statusOf(inTime.id), "accepted in time: not cancelled").toBe("ACCEPTED");
    expect(await walletOf(), "full refund").toBe(start - inTime.totalPaise);
    if (stock !== null) expect(await stockOf(listing), "stock back (the accepted order still holds its unit)").toBe(stock - 1);
    await cron("/api/cron/shop-acceptance");
    const customerTold = (await notesFor("customer", missed.orderNumber)).filter((n) => /cancel/i.test(`${n.title} ${n.body}`));
    const shopTold = (await notesFor("shop", missed.orderNumber)).filter((n) => /did not accept|missed|not accepted|cancel/i.test(`${n.title} ${n.body}`));
    expect(customerTold, "customer told once").toHaveLength(1);
    expect(shopTold, "shop told once").toHaveLength(1);
    notes.push(`timed out → ${await statusOf(missed.id)}, reason kept, refund + restock, one notice each after two sweeps; accepted order untouched`);
  } finally {
    for (const id of made) await abandon(id);
    await restore();
  }
  const restore10 = await withRule("shopAcceptance", { enabled: true, acceptMinutes: 10 });
  try {
    const fresh = await placeSimple();
    const [row] = await db()<{ accept_by_at: Date; created_at: Date }[]>`select accept_by_at, created_at from orders where id = ${fresh.id}`;
    expect(Math.round((row.accept_by_at.getTime() - row.created_at.getTime()) / 60_000), "new value for a new order").toBe(10);
    notes.push("set to 10 min → a new order gets +10 min");
    await abandon(fresh.id);
  } finally {
    await restore10();
  }
  return notes.join("; ");
}, { ...local, partial: "the time is aged in the database; the rule is changed through the settings API the /admin/settings page uses" });

qa("TC-ORD-018", "an order placed while the shop is closed is not timed out before opening; its accept-by runs from the opening time", async () => {
  const restoreRule = await withRule("shopAcceptance", { enabled: true, acceptMinutes: 30 });
  const ist = new Date(Date.now() + 5.5 * 3_600_000);
  const tomorrow = (ist.getUTCDay() + 1) % 7;
  const hours = Array.from({ length: 7 }, (_, day) => ({ day, open: "09:00", close: "21:00", closed: day !== tomorrow }));
  const restoreHours = await withShopSettings({ openingHours: hours });
  let placed: Placed | null = null;
  try {
    placed = await placeSimple();
    const [row] = await db()<{ placed_while_closed: boolean; expected_open_at: Date; accept_by_at: Date }[]>`select placed_while_closed, expected_open_at, accept_by_at from orders where id = ${placed.id}`;
    expect(row.placed_while_closed, "placed while closed").toBe(true);
    expect(Math.round((row.accept_by_at.getTime() - row.expected_open_at.getTime()) / 60_000), "accept-by = opening + 30 min").toBe(30);
    expect(row.expected_open_at.getTime(), "opening is tomorrow").toBeGreaterThan(Date.now());
    expectStatus(await cron("/api/cron/shop-acceptance"), 200, "sweep while closed");
    expect(await statusOf(placed.id), "not cancelled while closed").toBe("CONFIRMED");
    await db()`update orders set accept_by_at = now() - interval '1 minute' where id = ${placed.id}`;
    expectStatus(await cron("/api/cron/shop-acceptance"), 200, "sweep after the window from opening");
    expect(["CANCELLED", "REFUNDED"]).toContain(await statusOf(placed.id));
    return `closed shop: accept-by = opening (${row.expected_open_at.toISOString()}) + 30 min; kept while closed; cancelled once its time from opening had passed (aged)`;
  } finally {
    await restoreHours();
    await restoreRule();
    await abandon(placed?.id);
  }
}, local);

qa("TC-ORD-019", "timed-out orders are refunded by their payment method: wallet back to the wallet, online back to the source, cash nothing — each once", async ({ browser }) => {
  const restoreRule = await withRule("shopAcceptance", { enabled: true, acceptMinutes: 30 });
  const restorePay = await withRule("onlinePayments", { enabled: true });
  const restoreCod = await withShopSettings({ codEnabled: true });
  const notes: string[] = [];
  const made: string[] = [];
  try {
    await ensureWallet();
    const start = await walletOf();
    const wallet = await placeSimple();
    const cod = await placeSimple({ method: "COD" });
    const online = await onlineOrder(browser, "sandbox-pay");
    made.push(wallet.id, cod.id, online.id);
    await expect.poll(() => statusOf(online.id), { timeout: 20_000 }).toBe("CONFIRMED");
    const afterOrders = await walletOf();
    await db()`update orders set accept_by_at = now() - interval '1 minute' where id = any(${made}::uuid[])`;
    expectStatus(await cron("/api/cron/shop-acceptance"), 200, "sweep");
    expectStatus(await cron("/api/cron/shop-acceptance"), 200, "sweep again");
    for (const id of made) expect(["CANCELLED", "REFUNDED", "REFUND_PENDING"], `status of ${id}`).toContain(await statusOf(id));
    expect(await walletOf(), "only the wallet order comes back to the wallet").toBe(afterOrders + wallet.totalPaise);
    expect(afterOrders, "COD took nothing; online took nothing from the wallet").toBe(start - wallet.totalPaise);
    const refunds = (await call(await as("customer"), "GET", `/api/orders/${online.id}/refunds`)).body.refunds as { method: string; status: string; amountPaise: number }[];
    expect(refunds.map((r) => r.method), "online refund to the original method").toEqual(["ORIGINAL"]);
    const cancels = await db()<{ order_id: string; n: number }[]>`select order_id, count(*)::int as n from order_status_history where order_id = any(${made}::uuid[]) and new_status = 'CANCELLED' group by order_id`;
    expect(cancels.every((c) => c.n === 1) && cancels.length === 3, "each cancelled exactly once").toBe(true);
    notes.push(`wallet +${wallet.totalPaise} to the wallet; COD nothing; online ${refunds[0].method} ${refunds[0].status}; each cancelled once`);
  } finally {
    for (const id of made) await abandon(id);
    await restoreCod();
    await restorePay();
    await restoreRule();
  }
  return notes.join("; ");
}, { ...local, partial: "online is the local sandbox gateway" });

qa(["TC-ORD-014", "TC-ORD-004", "TC-RET-020"], "settlements: a cancelled order is in no batch; a disputed order is held out and listed in the exceptions queue; back to DELIVERED it joins the next batch, with one finance snapshot", async ({ browser }) => {
  const disputed = await delivered();
  const cancelled = await placeSimple();
  expectStatus(await setStatus(cancelled.id, "CANCELLED", "shop", "QA settlement check"), 200, "cancel");
  const weekStart = lastMonday();
  await db()`update order_financials set delivered_at = ${midWeek(weekStart)}::timestamptz where order_id = ${disputed.id}`;
  expectStatus(await setStatus(disputed.id, "DISPUTED", "ops"), 200, "dispute");
  const admin = await as("admin");
  expectStatus(await call(admin, "POST", "/api/finance/settlements", { weekStart }), 201, "prepare settlements");
  const fin = async (id: string) => db()<{ settlement_id: string | null }[]>`select settlement_id from order_financials where order_id = ${id}`;
  expect(await fin(cancelled.id), "a cancelled order has no financial line to settle").toHaveLength(0);
  expect((await fin(disputed.id))[0].settlement_id, "the disputed order is held out").toBeNull();
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/exceptions");
    await expect(page.getByText(`#${disputed.orderNumber}`).first(), "in the exceptions queue").toBeVisible();
  } finally {
    await context.close();
  }
  expectStatus(await setStatus(disputed.id, "DELIVERED", "ops"), 200, "resolved back to DELIVERED");
  // Kept in last week, whatever re-delivery does to the date, so the next batch of that week picks it up.
  await db()`update order_financials set delivered_at = ${midWeek(weekStart)}::timestamptz where order_id = ${disputed.id}`;
  expectStatus(await call(admin, "POST", "/api/finance/settlements", { weekStart }), 201, "prepare again");
  const after = await fin(disputed.id);
  expect(after, "exactly one finance snapshot").toHaveLength(1);
  expect(after[0].settlement_id, "now in a batch").toBeTruthy();
  return `cancelled ${cancelled.orderNumber}: no line; disputed ${disputed.orderNumber}: held out, in /admin/exceptions; back to DELIVERED → settled, one snapshot`;
}, { ...local, partial: "the delivery date is moved into last week (only a finished week is settled, TC-FLD-118); the batches are prepared through the API the Finance page's button uses" });

qa("TC-FUL-016", "a subscription order still goes CONFIRMED → PREPARING in one step", async () => {
  await ensureWallet();
  const placed = await placeSimple();
  try {
    await db()`update orders set source = 'SUBSCRIPTION' where id = ${placed.id}`;
    const res = await setStatus(placed.id, "PREPARING");
    expectStatus(res, 200, "CONFIRMED → PREPARING");
    expect(await statusOf(placed.id)).toBe("PREPARING");
    return `${placed.orderNumber} (source SUBSCRIPTION) CONFIRMED → PREPARING directly`;
  } finally {
    await abandon(placed.id);
  }
}, { ...local, partial: "the order is marked a subscription order in the database rather than generated by the daily subscription run" });

qa("TC-FUL-018", "a suspended shop: held orders cannot be advanced (clear message), new orders are refunded by the policy, orders left to continue are completed", async () => {
  const shopB = need(world().shops.B, "shop B");
  need(world().listings.sharedB, "a listing at shop B");
  await releaseRiders();
  await onlyRiderOnline("rider");
  await ensureWallet();
  const listing = await listingOf("sharedB");
  const held = await checkoutLines([{ listing }]);
  const fresh = await checkoutLines([{ listing }]);
  const going = await checkoutLines([{ listing }]);
  const notes: string[] = [];
  try {
    await driveTo(held.id, "ACCEPTED", { shop: "shopB" });
    const driven = await driveTo(going.id, "PICKED_UP", { shop: "shopB" });
    const start = await walletOf();
    const res = await call(await as("ops"), "POST", `/api/shops/${shopB.id}/suspend`, { reason: "QA suspension check" });
    expectStatus(res, 200, "suspend shop B");
    const advance = await shopAct(held.id, "start", {}, "shopB");
    expect(advance.status, "held order cannot be advanced").toBe(409);
    expect(advance.body?.error?.message).toMatch(/suspended/i);
    expect(["CANCELLED", "REFUNDED"], "the new order is cancelled by the policy").toContain(await statusOf(fresh.id));
    expect(await walletOf(), "and refunded").toBe(start + fresh.totalPaise);
    expectStatus(await riderAction(driven.deliveryOrderId!, "start"), 200, "the continuing order goes on");
    const { buyerCode } = await import("../lib/orders-helpers");
    expectStatus(await riderAction(driven.deliveryOrderId!, "deliver", { otp: await buyerCode(going.id) }), 200, "and is delivered");
    notes.push(`held: ${advance.status} "${advance.body?.error?.message}"; new: refunded; picked-up order delivered`);
  } finally {
    await call(await as("ops"), "POST", `/api/shops/${shopB.id}/reactivate`, { note: "QA reactivation" });
    for (const o of [held, fresh, going]) await abandon(o.id);
  }
  return notes.join("; ");
}, { ...local, partial: "with the default suspension policy (CONFIRMED cancel+refund, ACCEPTED–ASSIGNED review, PICKED_UP/OUT_FOR_DELIVERY continue)" });

qa("TC-RET-004", "a return more than 48 hours after delivery is refused: window passed (API and the return page)", async ({ browser }) => {
  const placed = await delivered();
  await db()`update order_status_history set created_at = now() - interval '49 hours' where order_id = ${placed.id} and new_status = 'DELIVERED'`;
  const item = (await orderRow(placed.id)).items[0];
  const res = await call(await as("customer"), "POST", `/api/orders/${placed.id}/returns`, { reason: "MISSING_ITEM", items: [{ orderItemId: item.id, quantityMilli: 1000, condition: "UNOPENED" }] });
  expect(res.status).toBe(409);
  expect(res.body?.error?.message).toMatch(/return window .* has passed/i);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto(`/orders/${placed.id}/return`);
    await expect(page.getByText(/return window \(48 hours after delivery\) has passed/i)).toBeVisible();
  } finally {
    await context.close();
  }
  return `delivered 49 h ago → ${res.status} "${res.body?.error?.message}"; the page says so`;
}, { ...local, partial: "the delivery time is aged in the database" });

qa("TC-RET-016", "returns rule changes: with 'Changed my mind' enabled (charged to the platform) a new return is accepted and the form offers it; restored afterwards", async ({ browser }) => {
  const placed = await delivered();
  const current = (await call(await as("admin"), "GET", "/api/admin/settings")).body.rules.find((r: { key: string }) => r.key === "returns").value as { reasons: Record<string, unknown> };
  const restore = await withRule("returns", { windowHours: 24, reasons: { ...current.reasons, CHANGED_MIND: { allowed: true, requiresImages: false, chargeTo: "PLATFORM" } } });
  let notes = "";
  try {
    const { context, page } = await pageAs(browser, "customer");
    try {
      await page.goto(`/orders/${placed.id}/return`);
      await expect(page.getByText(/You can request a return until/)).toBeVisible();
      const options = await page.getByLabel("Reason for the return").locator("option").allInnerTexts();
      expect(options).toContain("Changed my mind");
    } finally {
      await context.close();
    }
    const item = (await orderRow(placed.id)).items[0];
    const res = await call(await as("customer"), "POST", `/api/orders/${placed.id}/returns`, { reason: "CHANGED_MIND", items: [{ orderItemId: item.id, quantityMilli: 1000, condition: "UNOPENED" }] });
    expectStatus(res, 201, "CHANGED_MIND accepted");
    const [row] = await db()<{ charge_to: string }[]>`select charge_to from return_requests where id = ${res.body.id}`;
    expect(row.charge_to).toBe("PLATFORM");
    notes = `form offers 'Changed my mind'; return ${res.body.returnNumber} accepted, charged to PLATFORM; window 24 h`;
    await call(await as("customer"), "PATCH", `/api/returns/${res.body.id}`, { action: "cancel" });
  } finally {
    await restore();
  }
  const again = await call(await as("customer"), "POST", `/api/orders/${placed.id}/returns`, { reason: "CHANGED_MIND", items: [{ orderItemId: (await orderRow(placed.id)).items[0].id, quantityMilli: 1000, condition: "UNOPENED" }] });
  expect(again.status, "default restored: CHANGED_MIND refused again").toBe(422);
  return `${notes}; after restoring the default → ${again.status}`;
}, local);

qa("TC-RET-014", "a return stuck at 'Refund initiated': retrying the refund twice at once completes it once, with one credit", async ({ browser }) => {
  const restoreAuto = await withRule("returns", { autoRefundAfterInspection: false });
  try {
    const placed = await delivered();
    const restoreShop = await withShopSettings({ deliveryAvailable: false });
    let returnId = "";
    try {
      const item = (await orderRow(placed.id)).items[0];
      const res = await call(await as("customer"), "POST", `/api/orders/${placed.id}/returns`, { reason: "MISSING_ITEM", items: [{ orderItemId: item.id, quantityMilli: 1000, condition: "UNOPENED" }] });
      expectStatus(res, 201, "return");
      returnId = String(res.body.id);
    } finally {
      await restoreShop();
    }
    const shop = await as("shop");
    expectStatus(await call(shop, "PATCH", `/api/returns/${returnId}`, { action: "approve" }), 200, "approve");
    expectStatus(await call(shop, "PATCH", `/api/returns/${returnId}`, { action: "receive" }), 200, "handed over");
    expectStatus(await call(shop, "PATCH", `/api/returns/${returnId}`, { action: "inspect", outcome: "ACCEPT", note: "Fine" }), 200, "inspect");
    await db()`update return_requests set status = 'REFUND_INITIATED' where id = ${returnId}`;
    const { context, page } = await pageAs(browser, "ops");
    try {
      await page.goto("/admin/returns");
      await expect(page.getByTestId("return-case").filter({ hasText: String((await call(await as("ops"), "GET", `/api/returns/${returnId}`)).body.ret.returnNumber) }).getByRole("button", { name: "Retry refund" })).toBeVisible();
    } finally {
      await context.close();
    }
    const start = await walletOf();
    const ops = await as("ops");
    const [a, b] = await Promise.all([call(ops, "PATCH", `/api/returns/${returnId}`, { action: "issue_refund" }), call(ops, "PATCH", `/api/returns/${returnId}`, { action: "issue_refund" })]);
    const codes = [a.status, b.status].sort();
    expect(codes.includes(200), `one retry completes: ${codes}`).toBe(true);
    const detail = (await call(ops, "GET", `/api/returns/${returnId}`)).body;
    expect(detail.ret.status).toBe("REFUND_COMPLETED");
    expect(await walletOf(), "credited once").toBe(start + detail.ret.refundAmountPaise);
    return `two parallel retries → ${codes.join(" + ")}; REFUND_COMPLETED; wallet +${detail.ret.refundAmountPaise} once`;
  } finally {
    await restoreAuto();
  }
}, { ...local, partial: "'stuck at Refund initiated' is arranged in the database (status set after an inspection with auto-refund off)" });

qa("TC-SUP-007", "a delivered order more than 30 days old can no longer be rated", async () => {
  const placed = await delivered();
  await db()`update order_status_history set created_at = now() - interval '31 days' where order_id = ${placed.id} and new_status = 'DELIVERED'`;
  const res = await call(await as("customer"), "POST", `/api/orders/${placed.id}/rating`, { target: "SHOP", score: 4 });
  expect(res.status, "rating after 31 days").toBe(403);
  return `${res.status} "${res.body?.error?.message}"`;
}, { ...local, partial: "the other eligibility rules are TC-SUP-007 in signed-in/orders-support.spec.ts" });

/** A unique client address for the public form's per-IP limit (5 per 10 minutes). */
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

qa("TC-SUP-004", "the public grievance form creates a ticket with a reference; the lookup shows its status with the right e-mail and nothing with another", async ({ browser }) => {
  const email = `qa-grv-${RUN}@test.local`;
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page: Page = await context.newPage();
  let ticket = "";
  try {
    await page.goto("/grievance");
    await page.getByLabel("Your name").fill("QA Guest Complainant");
    await page.getByLabel("Email", { exact: true }).first().fill(email);
    await page.getByLabel("Subject").fill("Late refund");
    await page.getByLabel("Describe your complaint").fill("My refund for a cancelled order has not arrived yet.");
    await page.getByRole("button", { name: "Submit complaint" }).click();
    const ref = page.getByText(/GRV-\d+/).first();
    await expect(ref).toBeVisible({ timeout: 20_000 });
    ticket = ((await ref.innerText()).match(/GRV-\d+/) ?? [""])[0];
  } finally {
    await context.close();
  }
  expect(ticket).toMatch(/^GRV-/);
  const guest = await anonymous();
  try {
    const mine = await call(guest, "GET", `/api/grievances/lookup?ticket=${ticket}&email=${encodeURIComponent(email)}`, undefined, { headers: { "x-forwarded-for": ip() } });
    expectStatus(mine, 200, "lookup with the right e-mail");
    expect(mine.body.status).toBe("OPEN");
    const other = await call(guest, "GET", `/api/grievances/lookup?ticket=${ticket}&email=someone-else@test.local`, undefined, { headers: { "x-forwarded-for": ip() } });
    expect(other.status, "another e-mail").toBeGreaterThanOrEqual(400);
    expect(other.text, "nothing of the ticket").not.toContain("Late refund");
    return `${ticket} created from /grievance; lookup → ${mine.body.status}; with another e-mail → ${other.status}, no details`;
  } finally {
    await guest.dispose();
  }
}, { ...local, partial: "the public form's per-IP limit (5 per 10 minutes, keyed on X-Forwarded-For) is spread with a test address per request" });

qa("TC-FLD-101", "grievance form fields: blank, spaces, 1 character, over-long text and an invalid e-mail are refused; script and Hindi are kept, outer spaces trimmed; a wrong ticket gives a neutral answer", async () => {
  const guest = await anonymous();
  const post = (body: Record<string, unknown>) => call(guest, "POST", "/api/grievances", body, { headers: { "x-forwarded-for": ip() } });
  const base = { name: "QA Field Guest", email: `qa-fld-${RUN}@test.local`, category: "ORDER", subject: "Field rules", description: "A description that is long enough." };
  const notes: string[] = [];
  try {
    for (const [what, patch] of [
      ["blank name", { name: "" }],
      ["spaces-only name", { name: "    " }],
      ["1-character name", { name: "x" }],
      ["121-character name", { name: TEXT.long(121) }],
      ["blank description", { description: "" }],
      ["spaces-only description", { description: "            " }],
      ["4001-character description", { description: TEXT.long(4001) }],
      ["invalid e-mail", { email: "not-an-email" }],
      ["unknown category", { category: "ALIENS" }],
    ] as const) {
      const res = await post({ ...base, ...patch });
      expect(res.status, what).toBe(422);
      notes.push(`${what} 422`);
    }
    const ok = await post({ ...base, name: `  ${TEXT.hindi}  `, subject: `  ${TEXT.script}  `, description: `   ${TEXT.marathi} — refund pending   ` });
    expectStatus(ok, 201, "script and Hindi");
    const look = await call(guest, "GET", `/api/grievances/lookup?ticket=${ok.body.ticketNumber}&email=${encodeURIComponent(base.email)}`, undefined, { headers: { "x-forwarded-for": ip() } });
    expect(look.body.subject, "subject kept as written and trimmed").toBe(TEXT.script);
    const [row] = await db()<{ name: string; description: string }[]>`select name, description from grievances where ticket_number = ${ok.body.ticketNumber}`;
    expect(row.name).toBe(TEXT.hindi);
    expect(row.description).toBe(`${TEXT.marathi} — refund pending`);
    notes.push("script/Hindi/Marathi kept, trimmed");
    const badPhone = await post({ ...base, phone: "not a phone" });
    notes.push(`phone "not a phone" → ${badPhone.status}`);
    const unknown = await call(guest, "GET", `/api/grievances/lookup?ticket=GRV-999999&email=${encodeURIComponent(base.email)}`, undefined, { headers: { "x-forwarded-for": ip() } });
    const wrongMail = await call(guest, "GET", `/api/grievances/lookup?ticket=${ok.body.ticketNumber}&email=other@test.local`, undefined, { headers: { "x-forwarded-for": ip() } });
    notes.push(`unknown ticket → ${unknown.status} "${unknown.body?.error?.message}", existing ticket + wrong e-mail → ${wrongMail.status} "${wrongMail.body?.error?.message}"`);
    expect(badPhone.status, `an invalid mobile as contact is refused — ${notes.join("; ")}`).toBe(422);
    expect(wrongMail.status, `the lookup does not reveal that a ticket exists — ${notes.join("; ")}`).toBe(unknown.status);
  } finally {
    await guest.dispose();
  }
  return notes.join("; ");
}, { ...local, partial: "the public form has no order-reference field (its description carries one); per-IP limit spread with a test address per request" });

qa("TC-SUP-013", "escalation: a customer rejecting the proposed resolution, left unanswered past the response time, and a case past its review age both become ESCALATED (senior queue) with a notice", async () => {
  const one = await delivered();
  const two = await delivered();
  const open = async (orderId: string) => {
    const res = await call(await as("customer"), "POST", "/api/disputes", { orderId, reason: "QUALITY_ISSUE", description: "The pack was stale on opening it", disputedAmountPaise: 1000 });
    expectStatus(res, 201, "open dispute");
    return res.body as { id: string; caseNumber: string };
  };
  const a = await open(one.id);
  const b = await open(two.id);
  const ops = await as("ops");
  for (const [to, extra] of [["TRIAGED", {}], ["INVESTIGATING", {}], ["RESOLUTION_PROPOSED", { proposal: "₹5 credit" }]] as const) {
    expectStatus(await call(ops, "PATCH", `/api/disputes/${a.id}`, { action: "advance", to, ...extra }), 200, `→ ${to}`);
  }
  expectStatus(await call(await as("customer"), "POST", `/api/disputes/${a.id}/comments`, { body: "No — I do not accept ₹5, I want a replacement", clientRequestId: `qa-${RUN}-${a.id.slice(0, 8)}` }), 201, "customer rejects the proposal");
  await db()`update order_disputes set awaiting_response_since = now() - interval '25 hours' where id = ${a.id}`;
  await db()`update order_disputes set created_at = now() - interval '49 hours' where id = ${b.id}`;
  const sweep = await cron("/api/cron/dispute-escalation");
  expectStatus(sweep, 200, "escalation sweep");
  const status = async (id: string) => (await call(ops, "GET", `/api/disputes/${id}`)).body;
  const da = await status(a.id);
  const dbb = await status(b.id);
  expect(JSON.stringify(da), "rejected proposal, unanswered 25 h → ESCALATED").toMatch(/"status":"ESCALATED"/);
  expect(JSON.stringify(dbb), "49 h old → ESCALATED").toMatch(/"status":"ESCALATED"/);
  const senior = await call(await as("admin"), "GET", "/api/disputes?level=L2");
  expect(JSON.stringify(senior.body), "both in the senior (L2) queue").toContain(a.caseNumber);
  expect(JSON.stringify(senior.body)).toContain(b.caseNumber);
  const told = await notesFor("admin", a.caseNumber);
  expect(told.length, "administrators told").toBeGreaterThan(0);
  return `${a.caseNumber} (customer rejected, 25 h unanswered) and ${b.caseNumber} (49 h old) → ESCALATED / L2; admins notified`;
}, { ...local, partial: "the customer's rejection does not escalate at once: it restarts the response clock and the hourly SLA check escalates after 24 h (src/lib/dispute-states.ts: back to investigation on a rejection; rule disputes.responseSlaHours) — aged in the database" });

qa(["TC-DEL-022", "TC-DEL-023"], "photo proof on: Mark delivered waits for a photo; oversized and disguised files are refused; the photo is saved with its time and shown to the customer and operations", async ({ browser }) => {
  const restore = await withRule("deliveryProof", { photoRequired: true });
  await ready();
  const placed = await placeSimple();
  const notes: string[] = [];
  try {
    const driven = await driveTo(placed.id, "OUT_FOR_DELIVERY");
    const { buyerCode } = await import("../lib/orders-helpers");
    const otp = await buyerCode(placed.id);
    const without = await riderAction(driven.deliveryOrderId!, "deliver", { otp });
    expect(without.status, "deliver without a photo").toBe(409);
    const rider = await as("rider");
    const big = await upload(rider, `/api/delivery-orders/${driven.deliveryOrderId}/proof`, { name: "big.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([png(), Buffer.alloc(2_100_000)]) });
    const pdf = await upload(rider, `/api/delivery-orders/${driven.deliveryOrderId}/proof`, { name: "door.jpg", mimeType: "image/jpeg", buffer: PDF_BYTES });
    const empty = await upload(rider, `/api/delivery-orders/${driven.deliveryOrderId}/proof`, { name: "empty.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(0) });
    expect([big.status, pdf.status, empty.status], "oversized, PDF named .jpg, empty").toEqual([422, 422, 422]);
    notes.push(`no photo → ${without.status} "${without.body?.error?.message}"; oversized/PDF/empty → 422`);
    const { context, page } = await pageAs(browser, "rider", { geolocation: { latitude: 18.5084, longitude: 73.8087 }, permissions: ["geolocation"] });
    try {
      await page.goto("/delivery-partner");
      await expect(page.getByTestId("delivery-proof")).toBeVisible();
      await page.getByLabel("Delivery code from the customer").fill(otp);
      await expect(page.getByRole("button", { name: "Mark delivered" }), "disabled until a photo").toBeDisabled();
    } finally {
      await context.close();
    }
    const ok = await upload(rider, `/api/delivery-orders/${driven.deliveryOrderId}/proof`, { name: "door.png", mimeType: "image/png", buffer: png(320, 240) });
    expectStatus(ok, 201, "a valid photo");
    expectStatus(await riderAction(driven.deliveryOrderId!, "deliver", { otp }), 200, "deliver with the photo");
    const [proof] = await db()<{ created_at: Date }[]>`select created_at from delivery_proofs where delivery_order_id = ${driven.deliveryOrderId!}`;
    expect(proof.created_at, "saved with its time").toBeTruthy();
    const customer = await pageAs(browser, "customer");
    try {
      const card = await customerCard(customer.page, placed.orderNumber, "past");
      const link = card.getByRole("link", { name: "Photo at delivery" });
      await expect(link).toBeVisible();
      expect(await link.getAttribute("href")).toBe(ok.body.url);
    } finally {
      await customer.context.close();
    }
    const ops = await pageAs(browser, "ops");
    try {
      await ops.page.goto("/admin/orders");
      await expect(ops.page.getByRole("row").filter({ hasText: placed.orderNumber }).getByRole("link", { name: /Photo at delivery/ })).toBeVisible();
    } finally {
      await ops.context.close();
    }
    notes.push("valid photo → delivered; 'Photo at delivery' on the customer's order and in /admin/orders");
  } finally {
    await restore();
    await abandon(placed.id);
  }
  return notes.join("; ");
}, local);

