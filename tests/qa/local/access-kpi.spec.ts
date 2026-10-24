/**
 * Marketplace KPIs against a hand computation (QA package 2, local tier):
 * a controlled set of real orders — delivered on time and late, cancelled,
 * rejected, one with a removed line, one rider decline — is placed through
 * the site's own flows, then moved into a past business day that holds no
 * other data, so every figure of /api/analytics/kpis and the analytics page
 * for that day can be compared with what the set says it must be.
 *
 * Local server only (the clock of the orders is moved in the database).
 */
import type { APIRequestContext } from "@playwright/test";

import { as } from "../lib/actors";
import { db } from "../lib/db";
import { fulfil, offerFor, onlyRiderOnline, pickupCode, riderAction } from "../lib/flows";
import { call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world, type Role } from "../lib/world";
import { apiFor, findRiderNow, freshCustomer } from "../lib/access-helpers";

const local = { tier: "local" as const, timeout: 900_000 };
const KEY = `kpi-window-${RUN}`;

interface Plan {
  /** Minutes after confirmation for each step (absent: the step did not happen). */
  accepted?: number;
  packed?: number;
  riderAccepted?: number;
  pickedUp?: number;
  outForDelivery?: number;
  delivered?: number;
  cancelled?: number;
  /** Promised delivery, minutes after confirmation (null: no promise). */
  promised?: number | null;
  /** When a first offer was declined: its offer time (minutes); the accepted offer follows a minute later. */
  declinedOfferAt?: number;
}

interface Placed {
  id: string;
  label: string;
  customer: string;
  t0: string;
  plan: Plan;
  goodsDeliveredPaise: number;
}

interface Window {
  day: string;
  next: string;
  prev: string;
  orders: Placed[];
  subscriptions: string[];
  customers: Record<string, string>;
  campaignId: string;
}

const TZ_OFFSET_MS = 5.5 * 3600_000;
const istDate = (iso: string, hour: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - TZ_OFFSET_MS + hour * 3600_000);
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const minutes = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);

/**
 * A past business day with nothing in it, nor in the days around it: ten days
 * before the earliest order, offer, subscription or campaign in the database
 * (an earlier run's live subscription would count in every later day).
 */
async function emptyDay(): Promise<string> {
  const [{ earliest }] = await db()<{ earliest: Date }[]>`select least(
      (select min(created_at) from orders), (select min(created_at) from subscriptions),
      (select min(offered_at) from delivery_orders), (select min(sent_at) from marketing_campaigns), now()) as earliest`;
  const first = new Date(new Date(earliest).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
  for (let tries = 0; tries < 4; tries++) {
    const day = addDays(first, -10 - tries * 7);
    const res = await call(await as("admin"), "GET", `/api/analytics/kpis?from=${addDays(day, -2)}&to=${addDays(day, 2)}`);
    expectStatus(res, 200, "KPIs of a candidate day");
    if (res.body.orders.placed === 0 && res.body.riders.offersAccepted === 0 && res.body.riders.offersDeclined === 0 && res.body.gmvTrend.length === 0 && res.body.subscriptions.liveAtStart === 0) return day;
  }
  blocked("no empty past day found for a controlled KPI window");
}

/** Customer side of an order for a fresh account: place one. */
async function order(ctx: APIRequestContext, lines: { shopProductId: string; quantity?: number }[], shopId: string, label: string) {
  await call(ctx, "DELETE", "/api/cart");
  for (const line of lines) expectStatus(await call(ctx, "POST", "/api/cart", { shopProductId: line.shopProductId, quantity: line.quantity ?? 1 }), [200, 201], `${label}: add to cart`);
  const address = (await call(ctx, "GET", "/api/addresses")).body;
  const addressId = ((address?.addresses ?? address ?? []) as { id: string }[])[0]?.id;
  const res = await call(ctx, "POST", "/api/checkout", { requestId: `qa-${RUN}-kpi-${label}`, addressId, paymentMethod: "WALLET", acknowledgeClosedShopIds: [shopId] });
  expectStatus(res, 201, `${label}: checkout`);
  return res.body.orders[0] as { id: string; totalPaise: number; orderNumber: string };
}

/** The rider leg for an order of a fresh customer (the customer's own delivery code). */
async function deliverFor(orderId: string, customer: APIRequestContext, rider: Role = "rider") {
  const offer = await offerFor(orderId, rider, 60_000);
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, rider), 200, "rider accepts");
  const code = await pickupCode(orderId);
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, rider), 200, "pickup");
  expectStatus(await riderAction(offer.deliveryOrderId, "start", {}, rider), 200, "start");
  let res = await call(customer, "POST", `/api/orders/${orderId}/delivery-code`, {});
  for (let i = 0; i < 2 && res.status === 429; i++) {
    const seconds = Number(res.body?.error?.message?.match(/(\d+)\s*seconds?/)?.[1] ?? 60);
    await new Promise((r) => setTimeout(r, Math.min(seconds, 120) * 1000 + 1500));
    res = await call(customer, "POST", `/api/orders/${orderId}/delivery-code`, {});
  }
  expectStatus(res, 200, "delivery code");
  const otp = String(res.body?.code ?? res.body?.otp ?? "");
  expectStatus(await riderAction(offer.deliveryOrderId, "deliver", { otp }, rider), 200, "deliver");
}

/** Moves one order's whole timeline to start at `t0` with the plan's step times. */
async function placeAt(orderId: string, t0: Date, plan: Plan) {
  const sql = db();
  const at = (m: number | undefined) => (m === undefined ? null : minutes(t0, m));
  await sql`update orders set created_at = ${minutes(t0, -0.05)}, updated_at = ${t0}, paid_at = ${t0},
    accepted_at = ${at(plan.accepted)}, packed_at = ${at(plan.packed)},
    promised_by_at = ${plan.promised == null ? null : minutes(t0, plan.promised)}, accept_by_at = null
    where id = ${orderId}`;
  const statusTime: Record<string, Date | null> = {
    CONFIRMED: t0,
    ACCEPTED: at(plan.accepted),
    PREPARING: at(plan.accepted === undefined ? undefined : plan.accepted + 0.5),
    READY: at(plan.packed),
    ASSIGNED: at(plan.riderAccepted),
    PICKED_UP: at(plan.pickedUp),
    OUT_FOR_DELIVERY: at(plan.outForDelivery),
    DELIVERED: at(plan.delivered),
    CANCELLED: at(plan.cancelled),
    REFUNDED: at(plan.cancelled === undefined ? undefined : plan.cancelled + 0.1),
  };
  const history = await sql<{ id: string; new_status: string }[]>`select id, new_status::text from order_status_history where order_id = ${orderId}`;
  for (const h of history) await sql`update order_status_history set created_at = ${statusTime[h.new_status] ?? t0} where id = ${h.id}`;
  const deliveries = await sql<{ id: string; accepted_at: Date | null }[]>`select id, accepted_at from delivery_orders where order_id = ${orderId} order by created_at`;
  for (const d of deliveries) {
    if (d.accepted_at === null) {
      const offered = at(plan.declinedOfferAt ?? plan.packed);
      await sql`update delivery_orders set created_at = ${offered}, offered_at = ${offered}, updated_at = ${offered} where id = ${d.id}`;
    } else {
      const offered = at(plan.declinedOfferAt !== undefined ? plan.declinedOfferAt + 1 : plan.packed);
      await sql`update delivery_orders set created_at = ${offered}, offered_at = ${offered}, accepted_at = ${at(plan.riderAccepted)},
        picked_up_at = ${at(plan.pickedUp)}, out_for_delivery_at = ${at(plan.outForDelivery)}, delivered_at = ${at(plan.delivered)},
        delivery_otp_sent_at = ${at(plan.outForDelivery)}, delivery_otp_used_at = ${at(plan.delivered)}, updated_at = ${at(plan.delivered) ?? offered}
        where id = ${d.id}`;
    }
  }
  if (plan.delivered !== undefined) await sql`update order_financials set delivered_at = ${at(plan.delivered)}, created_at = ${at(plan.delivered)} where order_id = ${orderId}`;
}

async function kpis(day: string, next: string) {
  const res = await call(await as("admin"), "GET", `/api/analytics/kpis?from=${day}&to=${next}`);
  expectStatus(res, 200, "KPIs of the controlled day");
  return res.body;
}

function current(): Window {
  return unstash<Window>(KEY) ?? blocked("needs the controlled KPI window arranged by the first check of this file");
}

qa(["TC-KPI-003", "TC-KPI-004", "TC-KPI-005", "TC-KPI-006", "TC-KPI-007", "TC-KPI-008", "TC-KPI-009", "TC-KPI-010", "TC-KPI-011", "TC-KPI-012"], "arrange the controlled set: 6 orders, 2 subscriptions and a campaign through the real flows, moved into an empty past day", async () => {
  const day = await emptyDay();
  const A = need(world().shops.A?.id, "shop A");
  const packaged = need(world().listings.packaged, "shop A's packaged listing");
  const bread = need(world().listings.sharedA, "shop A's bread listing");
  const milk = need(world().listings.milk, "shop A's milk listing");
  const people: Record<string, { id: string; email: string }> = {};
  for (const label of ["P", "Q", "R", "S"]) people[label] = await freshCustomer(`kpi${label.toLowerCase()}`, { withAddress: true, walletPaise: 300_000 });
  const ctx: Record<string, APIRequestContext> = {};
  for (const [k, u] of Object.entries(people)) ctx[k] = await apiFor(u);
  const placed: Placed[] = [];
  const riders = await db()<{ user_id: string }[]>`select user_id from delivery_partners where is_online`;
  try {
    await onlyRiderOnline("rider");
    // O6: customer P, the day before (shop A active in the previous window; P a returning customer).
    const o6 = await order(ctx.P, [{ shopProductId: packaged.shopProductId }], A, "o6");
    await fulfil(o6.id, "accept"); await fulfil(o6.id, "start"); await fulfil(o6.id, "ready");
    await deliverFor(o6.id, ctx.P);
    placed.push({ id: o6.id, label: "O6", customer: "P", t0: istDate(addDays(day, -1), 10).toISOString(), plan: { accepted: 5, packed: 15, riderAccepted: 18, pickedUp: 22, outForDelivery: 23, delivered: 40, promised: null }, goodsDeliveredPaise: o6.totalPaise });
    // O1: P, delivered on time.
    const o1 = await order(ctx.P, [{ shopProductId: packaged.shopProductId }], A, "o1");
    await fulfil(o1.id, "accept"); await fulfil(o1.id, "start"); await fulfil(o1.id, "ready");
    await deliverFor(o1.id, ctx.P);
    placed.push({ id: o1.id, label: "O1", customer: "P", t0: istDate(day, 10).toISOString(), plan: { accepted: 10, packed: 30, riderAccepted: 34, pickedUp: 40, outForDelivery: 42, delivered: 55, promised: 60 }, goodsDeliveredPaise: o1.totalPaise });
    // O2: P again, late; rider 2 declines the first offer, rider 1 takes the second.
    const o2 = await order(ctx.P, [{ shopProductId: packaged.shopProductId }], A, "o2");
    await onlyRiderOnline("rider2");
    await fulfil(o2.id, "accept"); await fulfil(o2.id, "start"); await fulfil(o2.id, "ready");
    const declined = await offerFor(o2.id, "rider2", 60_000);
    expectStatus(await riderAction(declined.deliveryOrderId, "reject", {}, "rider2"), 200, "rider 2 declines");
    await onlyRiderOnline("rider");
    expectStatus(await findRiderNow(o2.id), [200, 409], "find a rider again");
    await deliverFor(o2.id, ctx.P);
    placed.push({ id: o2.id, label: "O2", customer: "P", t0: istDate(day, 12).toISOString(), plan: { accepted: 20, packed: 50, declinedOfferAt: 50, riderAccepted: 56, pickedUp: 60, outForDelivery: 62, delivered: 90, promised: 80 }, goodsDeliveredPaise: o2.totalPaise });
    // O3: Q cancels before the shop accepts.
    const o3 = await order(ctx.Q, [{ shopProductId: packaged.shopProductId }], A, "o3");
    expectStatus(await call(ctx.Q, "PATCH", `/api/orders/${o3.id}/status`, { status: "CANCELLED", note: "QA KPI cancel" }), 200, "Q cancels");
    placed.push({ id: o3.id, label: "O3", customer: "Q", t0: istDate(day, 14).toISOString(), plan: { cancelled: 3, promised: null }, goodsDeliveredPaise: 0 });
    // O4: R's order, rejected by the shop.
    const o4 = await order(ctx.R, [{ shopProductId: packaged.shopProductId }], A, "o4");
    expectStatus(await fulfil(o4.id, "reject", { reason: "QA KPI: out of stock" }), 200, "shop rejects");
    placed.push({ id: o4.id, label: "O4", customer: "R", t0: istDate(day, 15).toISOString(), plan: { cancelled: 4, promised: null }, goodsDeliveredPaise: 0 });
    // O5: S, two lines; the shop removes the bread line while picking; delivered.
    const o5 = await order(ctx.S, [{ shopProductId: packaged.shopProductId }, { shopProductId: bread.shopProductId }], A, "o5");
    await fulfil(o5.id, "accept"); await fulfil(o5.id, "start");
    const items = ((await call(ctx.S, "GET", "/api/orders")).body as { id: string; items: { id: string; shopProductId: string; unitPricePaise?: number; lineTotalPaise?: number }[] }[]).find((o) => o.id === o5.id)?.items ?? [];
    const breadLine = need(items.find((i) => i.shopProductId === bread.shopProductId), "the bread line of O5");
    // "remove" is a fulfilment action flows.fulfil() does not type; sent as the shop would.
    expectStatus(await call(await as("shop"), "POST", `/api/orders/${o5.id}/fulfilment`, { action: "remove", itemId: breadLine.id, reason: "Unavailable" }), 200, "remove a line");
    await fulfil(o5.id, "ready");
    await deliverFor(o5.id, ctx.S);
    placed.push({ id: o5.id, label: "O5", customer: "S", t0: istDate(day, 16).toISOString(), plan: { accepted: 6, packed: 16, riderAccepted: 20, pickedUp: 25, outForDelivery: 26, delivered: 35, promised: null }, goodsDeliveredPaise: o5.totalPaise - (bread.pricePaise ?? 0) });
    // Two subscriptions of P live before the day; one cancelled during it.
    const subs: string[] = [];
    const start = addDays(new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10), 3);
    for (const i of [1, 2]) {
      const res = await call(ctx.P, "POST", "/api/subscriptions", { shopProductId: milk.shopProductId, quantityMilli: 1000 * i, frequency: "DAILY", weekdays: [], startDate: start, draft: true });
      expectStatus(res, 201, `subscription ${i}`);
      subs.push(String(res.body?.id ?? res.body?.subscription?.id));
    }
    expectStatus(await call(ctx.P, "DELETE", `/api/subscriptions/${subs[1]}`), [200, 204], "cancel subscription 2");
    await db()`update subscriptions set created_at = ${istDate(addDays(day, -5), 9)} where id in (${subs[0]}, ${subs[1]})`;
    await db()`update subscriptions set cancelled_at = ${istDate(day, 18)} where id = ${subs[1]}`;
    // A campaign of shop A to its customers with a delivered order; P (who gives marketing consent) is one of them.
    await db()`insert into user_consents (user_id, consent_type, version, granted)
      select ${people.P.id}, 'MARKETING_COMMUNICATIONS', version, true from user_consents where user_id = ${people.P.id} and consent_type = 'TERMS_AND_PRIVACY' limit 1`;
    const owner = await as("shop");
    const segment = await call(owner, "POST", `/api/shops/${A}/marketing/segments`, { name: `QA KPI segment ${RUN}`, rules: { minOrders: 1 } });
    expectStatus(segment, 201, "segment");
    const segmentId = String(segment.body?.id ?? segment.body?.segment?.id);
    const campaign = await call(owner, "POST", `/api/shops/${A}/marketing/campaigns`, { segmentId, title: `QA KPI ${RUN}`, message: "QA: fresh paneer today", maxRecipients: 50, attributionDays: 3 });
    expectStatus(campaign, 201, "campaign draft");
    const campaignId = String(campaign.body?.id ?? campaign.body?.campaign?.id);
    expectStatus(await call(owner, "PATCH", `/api/shops/${A}/marketing/campaigns/${campaignId}`, { action: "submit" }), 200, "submit");
    expectStatus(await call(await as("ops"), "POST", `/api/admin/campaigns/${campaignId}/decision`, { decision: "approve" }), 200, "operator approves");
    expectStatus(await call(owner, "PATCH", `/api/shops/${A}/marketing/campaigns/${campaignId}`, { action: "send" }), 200, "send");
    const sentAt = istDate(day, 9);
    await db()`update marketing_campaigns set sent_at = ${sentAt}, submitted_at = ${minutes(sentAt, -30)} where id = ${campaignId}`;
    await db()`update campaign_recipients set sent_at = ${sentAt} where campaign_id = ${campaignId}`;
    for (const p of placed) await placeAt(p.id, new Date(p.t0), p.plan);
    const window: Window = { day, next: addDays(day, 1), prev: addDays(day, -1), orders: placed, subscriptions: subs, customers: Object.fromEntries(Object.entries(people).map(([k, u]) => [k, u.id])), campaignId };
    stash(KEY, window);
    return `day ${day}: ${placed.map((p) => p.label).join(", ")} placed through the site and moved into the day (O6 the day before); 2 subscriptions; 1 campaign`;
  } finally {
    for (const c of Object.values(ctx)) await c.dispose();
    for (const r of riders) await db()`update delivery_partners set is_online = true where user_id = ${r.user_id}`;
  }
}, { ...local, partial: "arranging step: each KPI is compared in its own check below" });

const inDay = (w: Window) => w.orders.filter((o) => o.label !== "O6");

qa("TC-KPI-003", "GMV of the day = the delivered orders' goods plus delivery fee (the removed line excluded), on the API and the page", async ({ browser }) => {
  const w = current();
  const k = await kpis(w.day, w.next);
  const delivered = inDay(w).filter((o) => o.plan.delivered !== undefined);
  const fees = await db()<{ id: string; delivery_fee_paise: number }[]>`select id, delivery_fee_paise from orders where id in ${db()(delivered.map((o) => o.id))}`;
  const expected = delivered.reduce((s, o) => s + o.goodsDeliveredPaise, 0) + fees.reduce((s, f) => s + Number(f.delivery_fee_paise), 0);
  const trend = (k.gmvTrend as { gmvPaise: number }[]).reduce((s, d) => s + d.gmvPaise, 0);
  expect(trend, `GMV: ${delivered.map((o) => `${o.label} ${o.goodsDeliveredPaise}`).join(" + ")}`).toBe(expected);
  const { pageAs } = await import("../lib/actors");
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/analytics?days=7", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("kpi-dashboard")).toBeVisible();
  } finally {
    await context.close();
  }
  return `GMV ${trend} paise = goods ${delivered.map((o) => `${o.label} ${o.goodsDeliveredPaise}`).join(" + ")} + delivery fees ${fees.reduce((s, f) => s + Number(f.delivery_fee_paise), 0)}`;
}, { ...local, partial: "the analytics page offers 7/30/90-day windows ending today, so the past day is compared on the API that feeds it; the page itself is TC-KPI-001" });

qa("TC-KPI-004", "order fill rate (delivered / placed) and item fill rate (lines kept) match the hand computation", async () => {
  const w = current();
  const k = await kpis(w.day, w.next);
  const placed = inDay(w).length;
  const delivered = inDay(w).filter((o) => o.plan.delivered !== undefined).length;
  expect(k.orders.placed).toBe(placed);
  expect(k.orders.delivered).toBe(delivered);
  expect(k.fillRate).toBe(Math.round((delivered / placed) * 1000) / 1000);
  // Lines: one per order, O5 two with one removed.
  const lines = placed + 1;
  expect(k.itemFillRate, "item fill rate").toBe(Math.round(((lines - 1) / lines) * 1000) / 1000);
  return `placed ${placed}, delivered ${delivered} → fill ${k.fillRate}; lines ${lines}, removed 1 → item fill ${k.itemFillRate}`;
}, local);

const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};

qa("TC-KPI-005", "shop acceptance time and pick-pack time: averages and medians match the timestamps", async () => {
  const w = current();
  const k = await kpis(w.day, w.next);
  const accepted = inDay(w).filter((o) => o.plan.accepted !== undefined);
  const acceptance = accepted.map((o) => o.plan.accepted!);
  const pickPack = accepted.filter((o) => o.plan.packed !== undefined).map((o) => o.plan.packed! - o.plan.accepted!);
  expect(k.shopAcceptance).toEqual({ count: acceptance.length, avgMinutes: avg(acceptance), medianMinutes: median(acceptance) });
  expect(k.pickPack).toEqual({ count: pickPack.length, avgMinutes: avg(pickPack), medianMinutes: median(pickPack) });
  return `acceptance ${acceptance.join("/")} min → avg ${avg(acceptance)}, median ${median(acceptance)}; pick-pack ${pickPack.join("/")} → avg ${avg(pickPack)}, median ${median(pickPack)}`;
}, local);

qa("TC-KPI-006", "assignment time (ready → rider accepts) and delivery time (pickup → drop): averages match", async () => {
  const w = current();
  const k = await kpis(w.day, w.next);
  const done = inDay(w).filter((o) => o.plan.delivered !== undefined);
  const assignment = done.map((o) => o.plan.riderAccepted! - o.plan.packed!);
  const delivery = done.map((o) => o.plan.delivered! - o.plan.pickedUp!);
  const e2e = done.map((o) => o.plan.delivered!);
  expect(k.assignment).toEqual({ count: assignment.length, avgMinutes: avg(assignment), medianMinutes: median(assignment) });
  expect(k.riderDelivery).toEqual({ count: delivery.length, avgMinutes: avg(delivery), medianMinutes: median(delivery) });
  expect(k.endToEnd).toEqual({ count: e2e.length, avgMinutes: avg(e2e), medianMinutes: median(e2e) });
  return `assignment ${assignment.join("/")} → ${avg(assignment)}; delivery ${delivery.join("/")} → ${avg(delivery)}; end to end ${e2e.join("/")} → ${avg(e2e)}`;
}, local);

qa("TC-KPI-007", "on-time delivery rate: one on time and one late of the promised orders = 50%", async () => {
  const w = current();
  const k = await kpis(w.day, w.next);
  const promised = inDay(w).filter((o) => o.plan.promised != null && o.plan.delivered !== undefined);
  const onTime = promised.filter((o) => o.plan.delivered! <= o.plan.promised!).length;
  expect(k.onTime).toEqual({ promised: promised.length, onTime, rate: Math.round((onTime / promised.length) * 1000) / 1000 });
  return `${onTime} of ${promised.length} promised orders on time → ${k.onTime.rate}`;
}, local);

qa("TC-KPI-008", "cancellation rate and refund rate (count and value) match the cancelled and refunded orders", async () => {
  const w = current();
  const k = await kpis(w.day, w.next);
  const ids = inDay(w).map((o) => o.id);
  const rows = await db()<{ status: string; total_paise: number; refunded_paise: number }[]>`select status::text, total_paise, refunded_paise from orders where id in ${db()(ids)}`;
  const cancelled = inDay(w).filter((o) => o.plan.cancelled !== undefined).length;
  const refunded = rows.filter((r) => Number(r.refunded_paise) > 0 || r.status === "REFUNDED");
  const refundedValue = rows.reduce((s, r) => s + (r.status === "REFUNDED" ? Number(r.total_paise) + Number(r.refunded_paise) : Number(r.refunded_paise)), 0);
  const placedValue = rows.reduce((s, r) => s + Number(r.total_paise) + Number(r.refunded_paise), 0);
  const ratio = (a: number, b: number) => Math.round((a / b) * 1000) / 1000;
  expect(k.orders.cancelled, "cancelled").toBe(cancelled);
  expect(k.cancellationRate).toBe(ratio(cancelled, ids.length));
  expect(k.orders.refunded, "refunded orders").toBe(refunded.length);
  expect(k.orders.refundedValuePaise, "refunded value").toBe(refundedValue);
  expect(k.refundValueRate).toBe(ratio(refundedValue, placedValue));
  return `cancelled ${cancelled}/${ids.length} → ${k.cancellationRate}; refunded ${refunded.length} (two cancellations + the removed line) worth ${refundedValue} of ${placedValue} → ${k.refundValueRate}`;
}, local);

qa("TC-KPI-009", "customer repeat rate (one customer ordered twice) and shop retention (shop A active the day before and again)", async () => {
  const w = current();
  const k = await kpis(w.day, w.next);
  const byCustomer = new Map<string, number>();
  for (const o of inDay(w)) byCustomer.set(o.customer, (byCustomer.get(o.customer) ?? 0) + 1);
  const repeat = [...byCustomer.values()].filter((n) => n >= 2).length;
  expect(k.customers).toEqual({ ordering: byCustomer.size, repeat, returning: 1, repeatRate: Math.round((repeat / byCustomer.size) * 1000) / 1000 });
  expect(k.shopRetention, "shop retention").toEqual({ previousActive: 1, retained: 1, rate: 1 });
  return `${byCustomer.size} customers, ${repeat} ordered twice (P), 1 returning → ${k.customers.repeatRate}; shop A delivered the day before and again → retention ${k.shopRetention.rate}`;
}, local);

qa("TC-KPI-010", "subscription retention: of two live subscriptions one cancelled in the day → 50%", async () => {
  const w = current();
  const k = await kpis(w.day, w.next);
  expect(k.subscriptions).toEqual({ liveAtStart: 2, retained: 1, retention: 0.5, newInWindow: 0, cancelledInWindow: 1 });
  return `live at start 2, kept 1, cancelled in the day 1 → ${k.subscriptions.retention}`;
}, local);

qa("TC-KPI-011", "rider acceptance rate: accepted offers vs the one decline of the day", async () => {
  const w = current();
  const k = await kpis(w.day, w.next);
  const accepted = inDay(w).filter((o) => o.plan.riderAccepted !== undefined).length;
  const declined = inDay(w).filter((o) => o.plan.declinedOfferAt !== undefined).length;
  expect({ accepted: k.riders.offersAccepted, declined: k.riders.offersDeclined }, "offers of the day").toEqual({ accepted, declined });
  expect(k.riders.acceptanceRate).toBe(Math.round((accepted / (accepted + declined)) * 1000) / 1000);
  return `${accepted} accepted, ${declined} declined → ${k.riders.acceptanceRate}; utilisation ${k.riders.utilisation ?? "— (no online session recorded that day)"}`;
}, { ...local, partial: "utilisation needs online sessions in the past day, which a moved timeline cannot create honestly; it shows '—' (null), as the case allows for sessions recorded since release" });

qa("TC-KPI-012", "marketing conversion: recipients who ordered from the shop within the attribution window / all recipients", async () => {
  const w = current();
  const k = await kpis(w.day, w.next);
  const recipients = await db()<{ user_id: string }[]>`select user_id from campaign_recipients where campaign_id = ${w.campaignId}`;
  const ids = recipients.map((r) => r.user_id);
  expect(ids, "customer P received the campaign").toContain(w.customers.P);
  // Hand computation: within 3 days of the send only P ordered (O1 and O2); every other recipient's orders are years later.
  const pOrders = inDay(w).filter((o) => o.customer === "P").map((o) => o.id);
  const [{ value }] = await db()<{ value: number }[]>`select coalesce(sum(total_paise), 0)::int as value from orders where id in ${db()(pOrders)}`;
  expect(k.marketing).toMatchObject({ campaigns: 1, recipients: ids.length, converted: 1, conversionRate: Math.round((1 / ids.length) * 1000) / 1000, revenuePaise: Number(value) });
  return `1 campaign, ${ids.length} recipient(s), 1 converted (P: O1, O2) → ${k.marketing.conversionRate}; attributed revenue ${value} paise`;
}, { ...local, partial: "the campaign is real (segment, approval, send) and its send time is moved into the day with the orders" });

qa("TC-KPI-003", "the controlled orders are left closed (delivered or cancelled) and their customers' carts empty", async () => {
  const w = current();
  const rows = await db()<{ status: string }[]>`select status::text from orders where id in ${db()(w.orders.map((o) => o.id))}`;
  expect(rows.every((r) => ["DELIVERED", "CANCELLED", "REFUNDED"].includes(r.status)), `statuses: ${rows.map((r) => r.status).join(", ")}`).toBe(true);
  void why;
  return `${rows.length} orders closed`;
}, local);
