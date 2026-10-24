/**
 * Marketplace finance on the local server (Slice 6): commission rates and
 * their resolution (TC-FIN-001/002, TC-FLD-111), the DELIVERED snapshot and
 * its journal (TC-FIN-004/005), weekly shop settlements and their lifecycle
 * (TC-FIN-006/007/008, TC-FLD-118), rider payouts (TC-FIN-019), manual
 * adjustments (TC-FIN-020, TC-FLD-116), reconciliation (TC-FIN-021/022/026),
 * the exceptions queue (TC-FIN-023), the period summary (TC-FIN-024), the
 * order money trace (TC-FIN-025) and the sold price in the settlement
 * (TC-SPI-014).
 *
 * Local tier: commission rates and settlement batches are global, delivered
 * orders are dated back into last week (the 2-day hold and the weekly window
 * look at the delivery time), and audit rows are read from the database.
 * Every global rate this file sets is put back by the last check.
 */
import {
  ageDelivery,
  api,
  arrangeGatewayTopUp,
  asPage,
  auditRows,
  buy,
  checkoutLines,
  commissionSnapshot,
  deliveredOrder,
  deliverOrder,
  freeRider,
  freshListing,
  fulfil,
  lastWeek,
  listingOf,
  orderDetail,
  packOrder,
  paiseIn,
  partnerId,
  payouts,
  pickUpAndStart,
  restoreCommission,
  riderAction,
  rid,
  setCommission,
  settlements,
  shown,
  shopAction,
  shopId,
  addDaysIso,
  snapshotCount,
  statusOf,
  trace,
  type Payout,
  type PlacedOrder,
  type Settlement,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { expectStatus, RUN, stash, unstash } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };
/** Stash keys of this file (stable across worker restarts; reset by its first check). */
const K = (k: string) => `fin-settlement-${k}`;
const KEYS = ["rateShop", "rateType", "rateDefault", "substituted", "adjShop", "adjRider", "carry", "batches", "payout"];
const DEFAULT_BP = 500;
const TYPE_BP = 300;
const SHOP_A_BP = 750;

type Kept = PlacedOrder & { shopId: string; deliveryOrderId?: string };
const keep = (k: string, v: Kept) => stash(K(k), v);
const kept = (k: string, what: string) => unstash<Kept>(K(k)) ?? blocked(`needs ${what} from an earlier check of this run`);

async function setShopType(key: "A" | "B", type: string) {
  await db()`update shops set shop_type = ${type} where id = ${shopId(key)}`;
}

/* ------------------------------------------------------------ commission */

qa("TC-FIN-001", "admin sets the platform default, a shop-type rate and a one-shop rate on /admin/finance; saved and audited; 0% until a default exists", async ({ browser }) => {
  for (const k of KEYS) stash(K(k), null);
  // Start from "no rate set"; the rates active before are put back by the last check of this file.
  stash(K("rates"), await commissionSnapshot());
  await restoreCommission([]);
  const before = await deliveredOrder({ listing: listingOf("sharedA") });
  const zero = await trace(before.orderNumber);
  expect(zero.snapshot?.commissionRateBp, "commission with no rate configured").toBe(0);
  expect(zero.snapshot?.commissionPaise).toBe(0);

  const since = new Date(Date.now() - 1000);
  const shopA = need(world().shops.A, "shop A");
  await asPage(browser, "admin", "/admin/finance#tab-2", async (page) => {
    await page.getByRole("tab", { name: "Commission" }).click();
    const panel = page.getByRole("tabpanel").filter({ has: page.getByText("Commission rates") });
    await expect(panel.getByText("No rate set — commission is 0% until a default is saved.")).toBeVisible();
    const save = async (scope: string, target: string | null, percent: string) => {
      await panel.getByLabel("Applies to").selectOption({ label: scope });
      if (target) {
        const caption = scope === "A shop type" ? "Shop type" : "Shop";
        await panel.locator("label", { has: page.locator("span", { hasText: new RegExp(`^${caption}$`) }) }).locator("select").selectOption({ label: target });
      }
      await panel.getByLabel("Commission %").fill(percent);
      await panel.getByRole("button", { name: "Save rate" }).click();
      await expect(panel.getByText("Commission rate saved — applies to orders delivered from now on.")).toBeVisible();
    };
    await save("Platform default", null, String(DEFAULT_BP / 100));
    await save("A shop type", "Bakery", String(TYPE_BP / 100));
    await save("One shop", shopA.name, String(SHOP_A_BP / 100));
    await expect(panel.locator("li").filter({ hasText: "Platform default" })).toContainText("5.00%");
    await expect(panel.locator("li").filter({ hasText: "Shop type: Bakery" })).toContainText("3.00%");
    await expect(panel.locator("li").filter({ hasText: `Shop: ${shopA.name}` })).toContainText("7.50%");
  });
  const audits = await auditRows("finance.commission_rate_set", since);
  expect(audits.length, "one audit row per saved rate").toBe(3);
  const rates = await api("admin", "GET", "/api/finance/commission-rates");
  const active = rates.body as { scope: string; rateBp: number; shopId: string | null; shopType: string | null }[];
  expect(active.find((r) => r.scope === "DEFAULT")?.rateBp).toBe(DEFAULT_BP);
  expect(active.find((r) => r.scope === "SHOP_TYPE" && r.shopType === "BAKERY")?.rateBp).toBe(TYPE_BP);
  expect(active.find((r) => r.scope === "SHOP" && r.shopId === shopA.id)?.rateBp).toBe(SHOP_A_BP);
  return `before any rate: ${before.orderNumber} snapshot 0%; saved default 5%, Bakery 3%, ${shopA.name} 7.5% through the form; 3 audit rows`;
}, local);

qa(["TC-FIN-002", "TC-FLD-111"], "commission resolution shop > shop type > default; each snapshot keeps the rate in force at delivery", async () => {
  const rates = await api("admin", "GET", "/api/finance/commission-rates");
  if (!(rates.body as { scope: string }[]).some((r) => r.scope === "DEFAULT")) blocked("needs the rates set by TC-FIN-001");
  const results: string[] = [];
  try {
    const a = await deliveredOrder({ listing: listingOf("sharedA") });
    keep("rateShop", a);
    const ta = await trace(a.orderNumber);
    expect(ta.snapshot?.commissionRateBp, "shop A (own rate)").toBe(SHOP_A_BP);
    expect(ta.snapshot?.commissionPaise).toBe(Math.round((ta.snapshot!.goodsPaise * SHOP_A_BP) / 10_000));
    results.push(`A ${SHOP_A_BP}bp`);

    await setShopType("B", "BAKERY");
    const b = await deliveredOrder({ listing: listingOf("sharedB") });
    keep("rateType", b);
    const tb = await trace(b.orderNumber);
    expect(tb.snapshot?.commissionRateBp, "shop B as a Bakery (type rate)").toBe(TYPE_BP);
    results.push(`B/Bakery ${TYPE_BP}bp`);

    await setShopType("B", "GROCERY_KIRANA");
    const c = await deliveredOrder({ listing: listingOf("sharedB") });
    keep("rateDefault", c);
    const tc = await trace(c.orderNumber);
    expect(tc.snapshot?.commissionRateBp, "shop B as a Kirana (no type rate: default)").toBe(DEFAULT_BP);
    results.push(`B/Kirana ${DEFAULT_BP}bp`);

    // Change the default (7.5% — a decimal rate is accepted, TC-FLD-111) and deliver again.
    await setCommission("DEFAULT", 750);
    const d = await deliveredOrder({ listing: listingOf("sharedB") });
    const td = await trace(d.orderNumber);
    expect(td.snapshot?.commissionRateBp, "new default applies to the next delivery").toBe(750);
    expect((await trace(c.orderNumber)).snapshot?.commissionRateBp, "earlier snapshot unchanged").toBe(DEFAULT_BP);
    expect((await trace(a.orderNumber)).snapshot?.commissionRateBp, "earlier shop-rate snapshot unchanged").toBe(SHOP_A_BP);
    results.push(`default → 750bp: next ${td.snapshot?.commissionRateBp}bp, earlier kept`);
    // 0% and the 50% cap are accepted values too (TC-FLD-111).
    await setCommission("DEFAULT", 0);
    await setCommission("DEFAULT", 5000);
  } finally {
    await setShopType("B", "DAIRY");
    await setCommission("DEFAULT", DEFAULT_BP);
  }
  return results.join("; ");
}, local);

/* ------------------------------------------------------------- snapshot */

qa("TC-FIN-004", "DELIVERED with one removed and one substituted line: one snapshot, goods after changes, GMV, commission, payable, journal", async ({ browser }) => {
  await freeRider("rider");
  const butter = await freshListing({ name: "QA Butter", pricePaise: 5800, stock: 20 });
  const bread = await freshListing({ name: "QA Bread", pricePaise: 4000, stock: 20 });
  const curd = await freshListing({ name: "QA Curd", pricePaise: 3500, stock: 20 });
  const out = await checkoutLines([
    { listing: butter, quantity: 1 },
    { listing: bread, quantity: 1 },
  ]);
  expectStatus(out.res, 201, "checkout of two lines");
  const order = out.orders[0];
  expectStatus(await fulfil(order.id, "accept"), 200, "accept");
  expectStatus(await fulfil(order.id, "start"), 200, "start");
  const detail = need(await orderDetail("customer", order.id), "order items");
  const butterItem = detail.items.find((i) => i.shopProductId === butter.shopProductId)!;
  const breadItem = detail.items.find((i) => i.shopProductId === bread.shopProductId)!;
  expectStatus(await shopAction(order.id, "remove", { itemId: butterItem.id, reason: "Out of stock" }), 200, "remove butter");
  expectStatus(await shopAction(order.id, "substitute", { itemId: breadItem.id, substituteShopProductId: curd.shopProductId, note: "QA cheaper substitute" }), 200, "substitute bread → curd");
  expectStatus(await api("customer", "PATCH", `/api/orders/${order.id}/items/${breadItem.id}/substitution`, { approve: true }), 200, "customer approves");
  expectStatus(await fulfil(order.id, "ready"), 200, "ready");
  await deliverOrder(order.id);
  expect(await statusOf(order.id)).toBe("DELIVERED");
  const t = await trace(order.orderNumber);
  const s = need(t.snapshot, "the delivered snapshot");
  const goods = Math.min(curd.pricePaise!, bread.pricePaise!);
  expect(await snapshotCount(order.id), "exactly one snapshot").toBe(1);
  expect(s.goodsPaise, "goods = the substituted line only").toBe(goods);
  expect(s.gmvPaise, "GMV = goods + delivery fee").toBe(goods + t.order.deliveryFeePaise);
  expect(s.commissionPaise, "commission = round(goods × rate)").toBe(Math.round((goods * s.commissionRateBp) / 10_000));
  expect(s.shopPayablePaise, "shop payable = goods − commission").toBe(goods - s.commissionPaise);
  const kinds = new Set(t.ledger.map((l) => l.entryType));
  for (const k of ["GOODS_SALE", ...(s.commissionPaise > 0 ? ["COMMISSION"] : []), "RIDER_EARNING"]) expect([...kinds], `journal has ${k}`).toContain(k);
  keep("substituted", { id: order.id, orderNumber: order.orderNumber, totalPaise: order.totalPaise, status: "DELIVERED", requestId: out.requestId, body: null, listing: bread, shopId: bread.shopId });
  // The admin's money trace page shows the same snapshot and the journal.
  await asPage(browser, "admin", `/admin/finance?trace=${encodeURIComponent(order.orderNumber)}`, async (page) => {
    await page.getByRole("tab", { name: "Money trace" }).click();
    const box = page.getByTestId("order-trace");
    await expect(box).toBeVisible();
    const text = await box.innerText();
    expect(text).toContain(order.orderNumber);
    expect(text).toContain(`commission ${(s.commissionRateBp / 100).toFixed(2)}%`);
    const amounts = paiseIn(text);
    for (const v of [s.gmvPaise, s.commissionPaise, s.shopPayablePaise]) expect(amounts, `trace page shows ₹${v / 100}`).toContain(v);
    await expect(box.getByText("Journal")).toBeVisible();
  });
  return `${order.orderNumber}: butter removed, bread → curd; goods ₹${goods / 100}, GMV ₹${s.gmvPaise / 100}, commission ${s.commissionRateBp}bp = ₹${s.commissionPaise / 100}, payable ₹${s.shopPayablePaise / 100}; journal ${[...kinds].join(", ")}`;
}, local);

qa("TC-FIN-005", "exactly one snapshot on every delivery path: rider code, shop's own delivery, operator confirmation, dispute back to DELIVERED", async () => {
  const seen: string[] = [];
  // 1. Rider with the customer's code (TC-FIN-002's first order).
  const viaRider = kept("rateShop", "the rider-delivered order of TC-FIN-002");
  expect(await snapshotCount(viaRider.id), "rider path").toBe(1);
  seen.push(`rider ${viaRider.orderNumber}: 1`);

  // 2. The shop delivers itself: READY → OUT_FOR_DELIVERY → DELIVERED with no rider.
  await db()`update delivery_partners set is_online = false where is_online`;
  const own = await buy(listingOf("sharedA"), 1);
  await packOrder(own.id);
  expectStatus(await api("shop", "PATCH", `/api/orders/${own.id}/status`, { status: "OUT_FOR_DELIVERY" }), 200, "shop: out for delivery");
  expectStatus(await api("shop", "PATCH", `/api/orders/${own.id}/status`, { status: "DELIVERED" }), 200, "shop: delivered");
  expect(await snapshotCount(own.id), "shop's own delivery").toBe(1);
  seen.push(`shop's own ${own.orderNumber}: 1`);

  // 3. Operations confirms a drop the customer could not confirm by code.
  await freeRider("rider");
  const op = await buy(listingOf("sharedA"), 1);
  await packOrder(op.id);
  await pickUpAndStart(op.id);
  expectStatus(await api("ops", "POST", `/api/orders/${op.id}/confirm-delivery`, { proofNote: "QA: customer confirmed by phone" }), 200, "operator confirms");
  expect(await statusOf(op.id)).toBe("DELIVERED");
  expect(await snapshotCount(op.id), "operator confirmation").toBe(1);
  seen.push(`operator ${op.orderNumber}: 1`);

  // 4. Disputed, then resolved back to DELIVERED.
  const disputed = await deliveredOrder({ listing: listingOf("sharedA") });
  expectStatus(await api("ops", "PATCH", `/api/orders/${disputed.id}/status`, { status: "DISPUTED", note: "QA dispute" }), 200, "operator: disputed");
  expectStatus(await api("ops", "PATCH", `/api/orders/${disputed.id}/status`, { status: "DELIVERED", note: "QA: resolved for the shop" }), 200, "operator: back to delivered");
  expect(await statusOf(disputed.id)).toBe("DELIVERED");
  expect(await snapshotCount(disputed.id), "dispute resolved back to DELIVERED").toBe(1);
  seen.push(`dispute ${disputed.orderNumber}: 1`);
  return seen.join("; ");
}, local);

/* ------------------------------------------------- adjustments & batches */

async function ageAdjustment(id: string) {
  await db()`update financial_adjustments set created_at = ${lastWeek().inside} where id = ${id}`;
}

qa("TC-FIN-020", "manual adjustments: +₹100 to shop A and −₹50 to the rider with reasons; a replayed request id is not counted twice; audited", async ({ browser }) => {
  const since = new Date(Date.now() - 1000);
  const shopA = need(world().shops.A, "shop A");
  const reason = `QA goodwill ${RUN}`;
  await asPage(browser, "admin", "/admin/finance", async (page) => {
    await page.getByRole("tab", { name: "Adjustments" }).click();
    const panel = page.getByRole("tabpanel").filter({ has: page.getByRole("button", { name: "Record adjustment" }) });
    await panel.getByLabel("Type").selectOption("SHOP_ADJUSTMENT");
    await panel.locator("label", { has: page.locator("span", { hasText: /^Shop$/ }) }).locator("select").selectOption({ label: shopA.name });
    await panel.getByLabel(/Amount ₹/).fill("100");
    await panel.getByLabel("Reason").fill(reason);
    await panel.getByRole("button", { name: "Record adjustment" }).click();
    await expect(panel.getByText("Adjustment recorded — it goes into the next batch.")).toBeVisible();
    await expect(panel.getByText(reason).first()).toBeVisible();
  });
  const list = await api("admin", "GET", "/api/finance/adjustments");
  const shopAdj = (list.body as { adjustment: { id: string; reason: string; amountPaise: number; shopId: string; status: string } }[]).find((a) => a.adjustment.reason === reason)?.adjustment;
  expect(shopAdj?.amountPaise, "₹100 stored as 10000 paise for shop A").toBe(10_000);
  expect(shopAdj?.shopId).toBe(shopA.id);
  expect(shopAdj?.status).toBe("PENDING");

  const partner = await partnerId("rider");
  const body = { type: "RIDER_ADJUSTMENT", deliveryPartnerId: partner, amountPaise: -5000, reason: `QA helmet deduction ${RUN}`, requestId: rid("adj") };
  const first = await api("admin", "POST", "/api/finance/adjustments", body);
  expectStatus(first, 201, "rider adjustment");
  const replay = await api("admin", "POST", "/api/finance/adjustments", body);
  expectStatus(replay, [200, 201], "replay");
  expect(replay.body.id, "replay returns the same adjustment").toBe(first.body.id);
  const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from financial_adjustments where idempotency_key like ${"%" + body.requestId}`;
  expect(n, "one row for the replayed request").toBe(1);
  const audits = await auditRows("finance.adjustment_recorded", since);
  expect(audits.length, "two adjustments audited (replay adds none)").toBe(2);
  // Into last week's batches (the batches below are prepared for last week).
  await ageAdjustment(shopAdj!.id);
  await ageAdjustment(first.body.id);
  stash(K("adjShop"), shopAdj!.id);
  stash(K("adjRider"), first.body.id);
  return `shop A +₹100 (form) and rider −₹50 (API) PENDING; replay → same id ${first.body.id.slice(0, 8)}, one row; 2 audit rows`;
}, { ...local, partial: "flowing into the next settlement / payout is asserted by TC-FIN-006 and TC-FIN-019 below" });

qa("TC-FIN-006", "prepare last week's settlements: one batch per shop with gross, commission, refunds, adjustments, net; hold / disputed / refund-pending orders carried over; a re-run adds nothing", async ({ browser }) => {
  const a1 = kept("rateShop", "shop A's order of TC-FIN-002");
  const a2 = kept("substituted", "shop A's order of TC-FIN-004");
  const b1 = kept("rateType", "shop B's order of TC-FIN-002");
  const b2 = kept("rateDefault", "shop B's second order of TC-FIN-002");
  for (const o of [a1, a2, b1, b2]) await ageDelivery(o.id);
  // A partial refund charged to the shop (the "refunds" column).
  const refund = await api("ops", "POST", "/api/finance/refunds", { orderNumber: a1.orderNumber, amountPaise: 1000, reason: "QA partial refund", chargeTo: "SHOP", requestId: rid("ref") });
  expectStatus(refund, 201, "partial refund charged to the shop");
  await ageAdjustment(refund.body.id);
  // Excluded: inside the hold, disputed, refund pending.
  const inHold = await deliveredOrder({ listing: listingOf("sharedA") });
  const disputed = await deliveredOrder({ listing: listingOf("sharedA") });
  await ageDelivery(disputed.id);
  expectStatus(await api("ops", "PATCH", `/api/orders/${disputed.id}/status`, { status: "DISPUTED", note: "QA: under dispute" }), 200, "dispute");
  const pendingRefund = await deliveredOrder({ listing: listingOf("sharedA") });
  await ageDelivery(pendingRefund.id);
  await db()`update orders set status = 'REFUND_PENDING' where id = ${pendingRefund.id}`; // as an online refund waiting at the gateway
  stash(K("carry"), { disputed: disputed.id, pendingRefund: pendingRefund.id, inHold: inHold.id });

  const before = (await settlements()).length;
  await asPage(browser, "admin", "/admin/finance", async (page) => {
    await page.getByRole("tab", { name: "Settlements" }).click();
    await page.getByRole("button", { name: "Prepare last week's settlements" }).click();
    await expect(page.getByText("Prepared — review the new batches below.")).toBeVisible();
  });
  const all = await settlements();
  const fresh = all.slice(0, all.length - before).map((s) => s.settlement);
  const forA = fresh.filter((s) => s.shopId === shopId("A"));
  const forB = fresh.filter((s) => s.shopId === shopId("B"));
  expect(forA.length, "one batch for shop A").toBe(1);
  expect(forB.length, "one batch for shop B").toBe(1);
  const bad: string[] = [];
  for (const s of [forA[0], forB[0]]) {
    const lines = await db()<{ order_id: string; goods: number; payable: number }[]>`select order_id, goods_paise::int as goods, shop_payable_paise::int as payable from order_financials where settlement_id = ${s.id}`;
    const adj = await db()<{ type: string; amount: number }[]>`select type, amount_paise::int as amount from financial_adjustments where settlement_id = ${s.id}`;
    const goods = lines.reduce((x, l) => x + l.goods, 0);
    const commission = lines.reduce((x, l) => x + (l.goods - l.payable), 0);
    const refunds = adj.filter((x) => x.type === "REFUND_SHOP").reduce((x, a) => x + a.amount, 0);
    const other = adj.filter((x) => x.type !== "REFUND_SHOP").reduce((x, a) => x + a.amount, 0);
    if (s.orderCount !== lines.length) bad.push(`${s.id}: orderCount ${s.orderCount} ≠ ${lines.length}`);
    if (s.goodsPaise !== goods) bad.push(`goods ${s.goodsPaise} ≠ ${goods}`);
    if (s.commissionPaise !== commission) bad.push(`commission ${s.commissionPaise} ≠ ${commission}`);
    if (s.refundsPaise !== refunds) bad.push(`refunds ${s.refundsPaise} ≠ ${refunds}`);
    if (s.adjustmentsPaise !== other) bad.push(`adjustments ${s.adjustmentsPaise} ≠ ${other}`);
    if (s.netPayablePaise !== goods - commission + refunds + other) bad.push(`net ${s.netPayablePaise} ≠ ${goods - commission + refunds + other}`);
    const ids = new Set(lines.map((l) => l.order_id));
    const expected = s.shopId === shopId("A") ? [a1, a2] : [b1, b2];
    for (const o of expected) if (!ids.has(o.id)) bad.push(`${o.orderNumber} missing from its shop's batch`);
    for (const o of [inHold, disputed, pendingRefund]) if (ids.has(o.id)) bad.push(`${o.orderNumber} should have been carried over`);
  }
  const adjA = await db()<{ id: string; settlement_id: string | null }[]>`select id, settlement_id from financial_adjustments where id = any(${[unstash<string>(K("adjShop")) ?? "", refund.body.id]})`;
  for (const r of adjA) if (r.settlement_id !== forA[0].id) bad.push(`adjustment ${r.id.slice(0, 8)} not in shop A's batch`);
  expect(bad, bad.join("\n")).toEqual([]);
  // Re-run: nothing new, nothing counted twice.
  const again = await api("admin", "POST", "/api/finance/settlements", {});
  expectStatus(again, 201, "re-run");
  expect((again.body as Settlement[]).filter((s) => s.shopId === shopId("A") || s.shopId === shopId("B")), "re-run creates no new batch for A or B").toEqual([]);
  stash(K("batches"), { a: forA[0].id, b: forB[0].id });
  const sa = forA[0];
  return `A: ${sa.orderCount} orders, goods ₹${sa.goodsPaise / 100} − commission ₹${sa.commissionPaise / 100} + refunds ₹${sa.refundsPaise / 100} + adjustments ₹${sa.adjustmentsPaise / 100} = ₹${sa.netPayablePaise / 100}; B: ${forB[0].orderCount} orders ₹${forB[0].netPayablePaise / 100}; hold / disputed / refund-pending left out; re-run added none`;
}, local);

async function settlementById(id: string): Promise<Settlement> {
  const list = await settlements();
  return need(list.find((s) => s.settlement.id === id)?.settlement, `settlement ${id}`);
}

qa("TC-FIN-008", "settlement lifecycle: approve → sent to bank → paid with a UTR; pay needs a reference; fail and re-send; reverse a paid one; cancel a pending one; all audited", async ({ browser }) => {
  const batches = unstash<{ a: string; b: string }>(K("batches")) ?? blocked("needs the batches of TC-FIN-006");
  const since = new Date(Date.now() - 1000);
  const shopA = need(world().shops.A, "shop A");
  const utr = `UTR${RUN.toUpperCase()}A`;
  // Shop A through the page: approve, sent to bank, paid with a reference.
  await asPage(browser, "admin", "/admin/finance", async (page) => {
    await page.getByRole("tab", { name: "Settlements" }).click();
    const row = () => page.getByRole("tabpanel").locator("div.flex.flex-wrap.items-center.justify-between").filter({ hasText: shopA.name }).filter({ has: page.getByText("Week from") }).first();
    await row().getByRole("button", { name: "Approve" }).click();
    await expect(row()).toContainText(/eligible/i);
    await row().getByRole("button", { name: "Sent to bank" }).click();
    await expect(row()).toContainText(/processing/i);
    await expect(row().getByRole("button", { name: "Mark paid" }), "paying needs a reference").toBeDisabled();
    await row().getByLabel("Bank reference or reason").fill(utr);
    await row().getByRole("button", { name: "Mark paid" }).click();
    await expect(row()).toContainText(`ref ${utr}`);
  });
  const paid = await settlementById(batches.a);
  expect(paid.status).toBe("PAID");
  expect(paid.paymentReference).toBe(utr);
  // Pay without a reference (API) is refused.
  const b = batches.b;
  expectStatus(await api("admin", "PATCH", `/api/finance/settlements/${b}`, { action: "approve" }), 200, "approve B");
  expectStatus(await api("admin", "PATCH", `/api/finance/settlements/${b}`, { action: "process" }), 200, "process B");
  const noRef = await api("admin", "PATCH", `/api/finance/settlements/${b}`, { action: "pay" });
  expect(noRef.status, "pay without a reference").toBe(422);
  // Fail, then re-send and pay.
  expectStatus(await api("admin", "PATCH", `/api/finance/settlements/${b}`, { action: "fail", note: "QA: account closed" }), 200, "fail B");
  expect((await settlementById(b)).status).toBe("FAILED");
  expectStatus(await api("admin", "PATCH", `/api/finance/settlements/${b}`, { action: "process" }), 200, "re-send B");
  expect((await settlementById(b)).status).toBe("PROCESSING");
  expectStatus(await api("admin", "PATCH", `/api/finance/settlements/${b}`, { action: "pay", note: `UTR${RUN.toUpperCase()}B` }), 200, "pay B");
  // Reverse A: its orders and adjustments are released and a REVERSAL is journaled.
  expectStatus(await api("admin", "PATCH", `/api/finance/settlements/${batches.a}`, { action: "reverse", note: "QA: returned by the bank" }), 200, "reverse A");
  expect((await settlementById(batches.a)).status).toBe("REVERSED");
  const [{ held }] = await db()<{ held: number }[]>`select count(*)::int as held from order_financials where settlement_id = ${batches.a}`;
  expect(held, "reversal releases the orders").toBe(0);
  const [{ rev }] = await db()<{ rev: number }[]>`select count(*)::int as rev from finance_ledger_entries where source_id = ${batches.a} and entry_type = 'REVERSAL'`;
  expect(rev, "REVERSAL journal entry").toBe(1);
  // A pending batch is cancelled: prepare again (A's released orders and the carried-over ones), then cancel.
  const carry = unstash<{ disputed: string; pendingRefund: string; inHold: string }>(K("carry"));
  if (carry) {
    expectStatus(await api("ops", "PATCH", `/api/orders/${carry.disputed}/status`, { status: "DELIVERED", note: "QA: dispute closed" }), 200, "dispute closed");
    await db()`update orders set status = 'DELIVERED' where id = ${carry.pendingRefund}`;
  }
  const next = await api("admin", "POST", "/api/finance/settlements", {});
  expectStatus(next, 201, "prepare again");
  const nextA = (next.body as Settlement[]).find((s) => s.shopId === shopId("A"));
  const nextIds = nextA ? (await db()<{ order_id: string }[]>`select order_id from order_financials where settlement_id = ${nextA.id}`).map((r) => r.order_id) : [];
  if (carry) {
    expect(nextIds, "carried-over disputed order joins the next batch").toContain(carry.disputed);
    expect(nextIds, "carried-over refund-pending order joins the next batch").toContain(carry.pendingRefund);
    expect(nextIds, "an order inside the hold still waits").not.toContain(carry.inHold);
  }
  const pendingA = need(nextA, "a new PENDING batch for shop A");
  expectStatus(await api("admin", "PATCH", `/api/finance/settlements/${pendingA.id}`, { action: "cancel" }), 200, "cancel the pending batch");
  expect((await settlementById(pendingA.id)).status).toBe("CANCELLED");
  const [{ left }] = await db()<{ left: number }[]>`select count(*)::int as left from order_financials where settlement_id = ${pendingA.id}`;
  expect(left, "cancel releases the orders").toBe(0);
  const audits = await auditRows("finance.settlement_status_changed", since);
  expect(audits.length, "every move audited (A: approve, process, pay, reverse; B: approve, process, fail, process, pay; cancel)").toBe(10);
  return `A paid ${utr} via the page then reversed (orders released, REVERSAL journaled); B: pay without ref → 422, failed → re-sent → paid; carried-over orders in the next batch, which was cancelled (released); 10 audit rows`;
}, { ...local, partial: "'no money is transferred by the system' is by construction (no bank API is called; PAID records a reference) and not observable here" });

/* ------------------------------------------------------------ rider payouts */

qa("TC-FIN-019", "weekly rider payout: unpaid earnings incl. failed and cancelled-after-pickup trips, net of adjustments and COD cash held; approve and pay; a cancelled batch releases its earnings", async ({ browser }) => {
  const rider = await partnerId("rider");
  const trips: string[] = [];
  // A normal drop.
  const delivered = await deliveredOrder({ listing: listingOf("sharedA") });
  await ageDelivery(delivered.id);
  trips.push(`${delivered.orderNumber} delivered`);
  // A failed drop (the rider made the trip).
  await freeRider("rider");
  const failed = await buy(listingOf("sharedA"), 1);
  await packOrder(failed.id);
  const failedLeg = await pickUpAndStart(failed.id);
  expectStatus(await riderAction(failedLeg.deliveryOrderId, "fail", { reason: "QA: customer not reachable" }), 200, "rider reports a failed drop");
  await ageDelivery(failed.id);
  trips.push(`${failed.orderNumber} failed`);
  // The customer cancels after pickup (rider still paid, D10).
  await freeRider("rider");
  const cancelled = await buy(listingOf("sharedA"), 1);
  await packOrder(cancelled.id);
  await pickUpAndStart(cancelled.id);
  expectStatus(await api("customer", "PATCH", `/api/orders/${cancelled.id}/status`, { status: "CANCELLED", note: "QA: changed my mind" }), 200, "customer cancels after pickup");
  await ageDelivery(cancelled.id);
  trips.push(`${cancelled.orderNumber} cancelled after pickup`);
  // A cash-on-delivery drop: the cash is held by the rider until deposited or netted.
  await db()`update shops set cod_enabled = true where id = ${shopId("A")}`;
  let codTotal = 0;
  try {
    const cod = await deliveredOrder({ listing: listingOf("sharedA"), method: "COD" });
    codTotal = cod.totalPaise;
    await ageDelivery(cod.id);
    const [codAdj] = await db()<{ id: string }[]>`select id from financial_adjustments where order_id = ${cod.id} and type = 'COD_CASH_COLLECTED'`;
    expect(codAdj?.id, "COD cash recorded against the rider").toBeTruthy();
    await ageAdjustment(codAdj.id);
    trips.push(`${cod.orderNumber} COD ₹${codTotal / 100}`);
  } finally {
    await db()`update shops set cod_enabled = false where id = ${shopId("A")}`;
  }

  const before = new Set((await payouts()).map((p) => p.payout.id));
  await asPage(browser, "admin", "/admin/finance", async (page) => {
    await page.getByRole("tab", { name: "Rider payouts" }).click();
    await page.getByRole("button", { name: "Prepare last week's payouts" }).click();
    await expect(page.getByText("Prepared — review the new batches below.")).toBeVisible();
  });
  const fresh = (await payouts()).map((p) => p.payout).filter((p) => !before.has(p.id));
  const mine = need(fresh.find((p) => p.deliveryPartnerId === rider), "a new payout for rider 1");
  const linked = await db()<{ id: string; total: number; delivery_order_id: string | null }[]>`select id, total_paise::int as total, delivery_order_id from delivery_partner_earnings where payout_id = ${mine.id}`;
  const linkedAdj = await db()<{ type: string; amount: number }[]>`select type, amount_paise::int as amount from financial_adjustments where payout_id = ${mine.id}`;
  const gross = linked.reduce((s, e) => s + e.total, 0);
  const adjustments = linkedAdj.reduce((s, a) => s + a.amount, 0);
  expect(mine.earningsCount, "earnings in the batch").toBe(linked.length);
  expect(mine.grossPaise, "gross = Σ earnings").toBe(gross);
  expect(mine.adjustmentsPaise, "adjustments = Σ rider adjustments incl. COD cash held").toBe(adjustments);
  expect(mine.amountPaise, "amount = gross + adjustments").toBe(gross + adjustments);
  const legs = await db()<{ order_id: string; id: string }[]>`select order_id, id from delivery_orders where order_id = any(${[delivered.id, failed.id, cancelled.id]})`;
  for (const leg of legs) expect(linked.map((e) => e.delivery_order_id), `earning of order ${leg.order_id.slice(0, 8)} in the batch`).toContain(leg.id);
  expect(linkedAdj.map((a) => a.type), "the −₹50 rider adjustment of TC-FIN-020").toContain("RIDER_ADJUSTMENT");
  if (codTotal) expect(linkedAdj.find((a) => a.type === "COD_CASH_COLLECTED")?.amount, "COD cash held netted").toBe(-codTotal);
  // The rider's own payout list shows the batch (the earnings statement lists the newest 50 earnings only, so last week's may be past it here).
  await asPage(browser, "rider", "/delivery-partner", async (page) => {
    const box = page.getByTestId("rider-payouts");
    await expect(box, "the rider sees the batch").toContainText(`${mine.earningsCount} deliveries`);
    await expect(box).toContainText(shown(mine.amountPaise));
  });
  // Approve and pay with a reference.
  expectStatus(await api("admin", "PATCH", `/api/finance/rider-payouts/${mine.id}`, { action: "approve" }), 200, "approve");
  expectStatus(await api("admin", "PATCH", `/api/finance/rider-payouts/${mine.id}`, { action: "process" }), 200, "process");
  expect((await api("admin", "PATCH", `/api/finance/rider-payouts/${mine.id}`, { action: "pay" })).status, "pay needs a reference").toBe(422);
  expectStatus(await api("admin", "PATCH", `/api/finance/rider-payouts/${mine.id}`, { action: "pay", note: `UTR${RUN.toUpperCase()}R` }), 200, "pay");
  // Another rider's batch is cancelled: its earnings go back to unpaid.
  const r2 = await deliveredOrder({ listing: listingOf("sharedA"), rider: "rider2" });
  await ageDelivery(r2.id);
  const next = await api("admin", "POST", "/api/finance/rider-payouts", {});
  expectStatus(next, 201, "prepare again");
  const rider2 = await partnerId("rider2");
  const r2Batch = need((next.body as Payout[]).find((p) => p.deliveryPartnerId === rider2), "a payout for rider 2");
  expectStatus(await api("admin", "PATCH", `/api/finance/rider-payouts/${r2Batch.id}`, { action: "cancel" }), 200, "cancel rider 2's batch");
  const [{ held }] = await db()<{ held: number }[]>`select count(*)::int as held from delivery_partner_earnings where payout_id = ${r2Batch.id}`;
  expect(held, "cancel releases the earnings").toBe(0);
  stash(K("payout"), mine.id);
  return `rider 1: ${mine.earningsCount} earnings ₹${gross / 100} + adjustments ₹${adjustments / 100} (−₹50 and COD −₹${codTotal / 100}) = ₹${mine.amountPaise / 100}, shown on the rider's payout list, paid with a UTR; rider 2's batch cancelled and released. Trips: ${trips.join(", ")}`;
}, { ...local, timeout: 420_000, partial: "the return-pickup fee is checked with the return journey in scenarios/SC-10-returns.spec.ts" });

/* ------------------------------------------------------------ reconciliation */

interface ReconRecord {
  id: string;
  entityType: string;
  entityId: string;
  reference: string;
  checkType: string;
  status: string;
  detail: string | null;
  expectedPaise: number | null;
  actualPaise: number | null;
}

/**
 * Local: the stored reconciliation records (all of them — the admin API lists
 * only the 200 most recently checked, and a 35-day run checks far more here).
 */
async function storedRecords(): Promise<ReconRecord[]> {
  return db()<ReconRecord[]>`select id, entity_type as "entityType", entity_id as "entityId", reference, check_type as "checkType", status, detail,
    expected_paise::int as "expectedPaise", actual_paise::int as "actualPaise" from reconciliation_records`;
}

async function reconRecords(role: "admin" | "ops" = "admin", status = ""): Promise<{ records: ReconRecord[]; counts: Record<string, number> }> {
  const res = await api(role, "GET", `/api/finance/reconciliation${status ? `?status=${status}` : ""}`);
  expectStatus(res, 200, "reconciliation records");
  return res.body;
}

qa("TC-FIN-021", "run reconciliation for the last 35 days: ORDER, PAYMENT, RIDER, SETTLEMENT and PAYOUT records MATCHED where the books agree; each exception names the mismatch", async ({ browser }) => {
  const credited = await arrangeGatewayTopUp("customer", 10_000, true);
  const missing = await arrangeGatewayTopUp("customer", 7_700, false);
  stash(K("missingPayment"), missing.paymentId);
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 35 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - 1000);
  await asPage(browser, "admin", `/admin/finance?from=${from}&to=${to}`, async (page) => {
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await page.getByRole("button", { name: "Run reconciliation for this period" }).click();
    await expect(page.getByText("Reconciliation run.")).toBeVisible();
  });
  expect((await auditRows("finance.reconciliation_run", since)).length, "the run is audited").toBe(1);
  const listed = (await reconRecords()).records.length;
  const records = await storedRecords();
  const fresh = records.filter((r) => r.status !== "RECONCILED");
  const by = (entityId: string, check: string) => records.find((r) => r.entityId === entityId && r.checkType === check);
  const b1 = kept("rateType", "shop B's order of TC-FIN-002");
  const batches = unstash<{ a: string; b: string }>(K("batches"));
  const payout = unstash<string>(K("payout"));
  const leg = (await db()<{ id: string }[]>`select id from delivery_orders where order_id = ${b1.id}`)[0];
  const expectMatched: [string, string, string][] = [
    [b1.id, "ORDER_PAYMENT", "order payment"],
    [b1.id, "DELIVERED_SNAPSHOT", "delivered snapshot"],
    [credited.paymentId, "GATEWAY_CREDIT", "gateway top-up credited once"],
    ...(leg ? ([[leg.id, "EARNING_PRESENT", "rider earning"]] as [string, string, string][]) : []),
    ...(batches ? ([[batches.b, "SETTLEMENT_TOTAL", "paid settlement total"]] as [string, string, string][]) : []),
    ...(payout ? ([[payout, "PAYOUT_TOTAL", "paid rider payout total"]] as [string, string, string][]) : []),
  ];
  const bad: string[] = [];
  for (const [id, check, what] of expectMatched) {
    const r = by(id, check);
    if (r?.status !== "MATCHED") bad.push(`${what} (${check} ${r?.reference ?? id}) → ${r?.status ?? "no record"}, expected ${r?.expectedPaise} found ${r?.actualPaise}${r?.detail ? `: ${r.detail}` : ""}`);
  }
  const gap = by(missing.paymentId, "GATEWAY_CREDIT");
  if (gap?.status !== "UNMATCHED" || !/credit is missing or short/.test(gap.detail ?? "")) bad.push(`uncredited top-up → ${gap?.status}: ${gap?.detail}`);
  const unnamed = fresh.filter((r) => r.status !== "MATCHED" && !r.detail);
  if (unnamed.length) bad.push(`${unnamed.length} non-matched records without a detail: ${unnamed.slice(0, 3).map((r) => `${r.entityType}/${r.checkType}`).join(", ")}`);
  expect(bad, bad.join("\n")).toEqual([]);
  const entities = [...new Set(records.filter((r) => r.status === "MATCHED").map((r) => r.entityType))].sort();
  return `${from}…${to}: MATCHED for ${entities.join(", ")}; the uncredited ₹77 top-up is UNMATCHED ("${gap?.detail}"); ${records.length} records stored, the admin list shows ${listed}`;
}, local);

qa("TC-FIN-022", "operator resolves an open reconciliation exception with a note (RECONCILED, audited); without a note refused; settlement and payout records are out of an operator's reach", async ({ browser }) => {
  const paymentId = unstash<string>(K("missingPayment")) ?? blocked("needs the open exception of TC-FIN-021");
  const { records } = await reconRecords("ops", "UNMATCHED,PARTIAL,EXCEPTION");
  const open = need((await storedRecords()).find((r) => r.entityId === paymentId && r.status !== "MATCHED" && r.status !== "RECONCILED"), "the open PAYMENT exception");
  const inOperatorList = records.some((r) => r.id === open.id);
  expect(records.every((r) => ["ORDER", "PAYMENT", "RIDER"].includes(r.entityType)), "operator sees only ORDER / PAYMENT / RIDER records").toBe(true);
  const noNote = await api("ops", "PATCH", `/api/finance/reconciliation/${open.id}`, {});
  expect(noNote.status, "resolve without a note").toBe(422);
  const shortNote = await api("ops", "PATCH", `/api/finance/reconciliation/${open.id}`, { note: "ok" });
  expect(shortNote.status, "resolve with a two-letter note").toBe(422);
  const since = new Date(Date.now() - 1000);
  const note = `QA ${RUN}: gateway confirmed the top-up failed; customer told`;
  let via = "the exceptions page";
  const onPage = await asPage(browser, "ops", "/admin/finance/exceptions", async (page) => {
    const row = page.getByTestId("exception-reconciliation").locator("div.flex").filter({ hasText: open.reference }).first();
    if (!(await row.count())) return false;
    await row.getByRole("button", { name: "Resolve" }).click();
    await row.getByLabel("Resolution note").fill(note);
    await row.getByRole("button", { name: "Mark reconciled" }).click();
    await expect(page.getByTestId("exception-reconciliation").getByText(open.reference)).toHaveCount(0);
    return true;
  });
  if (!onPage) {
    // The open records are many here (every ORDER_PAYMENT is UNMATCHED — see TC-FIN-021), and the page lists the newest only.
    via = `the API (the page lists the newest open records only; this one is ${inOperatorList ? "in" : "not in"} the operator's list)`;
    expectStatus(await api("ops", "PATCH", `/api/finance/reconciliation/${open.id}`, { note }), 200, "operator resolves");
  }
  const after = (await storedRecords()).find((r) => r.id === open.id);
  expect(after?.status).toBe("RECONCILED");
  expect((await auditRows("finance.reconciliation_resolved", since, open.id)).length, "audited").toBe(1);
  // A settlement / payout record: refused to an operator (looks like a missing record).
  const all = (await reconRecords("admin")).records;
  const batchRecord = all.find((r) => r.entityType === "SETTLEMENT" || r.entityType === "PAYOUT");
  if (batchRecord) {
    const res = await api("ops", "PATCH", `/api/finance/reconciliation/${batchRecord.id}`, { note: "QA operator tries a batch record" });
    expect(res.status, `operator on a ${batchRecord.entityType} record`).toBe(404);
  }
  return `PAYMENT exception ${open.reference} → RECONCILED by the operator through ${via}, audited; no / short note → 422; operator on a ${batchRecord?.entityType ?? "batch"} record → 404`;
}, local);

qa("TC-FIN-023", "finance exceptions queue: payments, refunds pending, cancellations, delivery adjustments, open reconciliation; admin also sees failed / reversed batches and overdue settlements; operator sees no batch totals", async ({ browser }) => {
  // An order delivered 12 days ago and never settled ("settlement missing").
  const overdue = await deliveredOrder({ listing: listingOf("sharedA") });
  await ageDelivery(overdue.id, new Date(Date.now() - 12 * 86_400_000));
  // A rider adjustment in the last 14 days (delivery adjustments section).
  await api("admin", "POST", "/api/finance/adjustments", { type: "DELIVERY_ADJUSTMENT", deliveryPartnerId: await partnerId("rider"), amountPaise: 1500, reason: `QA waiting time ${RUN}`, requestId: rid("dadj") });
  const sections = ["Reconciliation items", "Orders needing a refund or decision", "Payments", "Recently cancelled / refunded orders", "Delivery / rider adjustments (last 14 days)"];
  const opView = await asPage(browser, "ops", "/admin/finance/exceptions", async (page) => {
    for (const s of sections) await expect(page.getByRole("heading", { name: new RegExp(`^${s.replace(/[()/]/g, ".")}`) }).first(), `operator section "${s}"`).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settlements & payouts" }), "operator sees no settlement / payout section").toHaveCount(0);
    const text = await page.locator("main").first().innerText();
    expect(text).toContain(`QA waiting time ${RUN}`);
    return text;
  });
  expect(opView).not.toMatch(/Failed \/ reversed settlements/);
  const admin = await asPage(browser, "admin", "/admin/finance/exceptions", async (page) => {
    await expect(page.getByRole("heading", { name: "Settlements & payouts" })).toBeVisible();
    const box = page.getByRole("heading", { name: "Settlements & payouts" }).locator("..").locator("..");
    const text = await page.locator("main").first().innerText();
    expect(text, "the overdue order is listed").toContain(overdue.orderNumber);
    expect(text, "a reversed settlement is listed").toMatch(/Failed \/ reversed settlements[\s\S]*reversed/i);
    return (await box.innerText()).includes("Delivered 9+ days ago, not settled");
  });
  expect(admin, "the 'Delivered 9+ days ago, not settled' list").toBe(true);
  return `operator: ${sections.length} sections, no settlement / payout section; admin: + failed / reversed batches and ${overdue.orderNumber} under "Delivered 9+ days ago, not settled"`;
}, local);

qa("TC-FIN-024", "finance summary for a period equals the hand computation; the day boundary is IST midnight", async () => {
  // Two deliveries placed either side of IST midnight on a quiet past date.
  const day = "2026-09-15";
  const inside = new Date(`2026-09-14T18:40:00Z`); // 00:10 IST on the 15th
  const outside = new Date(`2026-09-14T18:20:00Z`); // 23:50 IST on the 14th
  const x = await deliveredOrder({ listing: listingOf("sharedA"), quantity: 2 });
  const y = await deliveredOrder({ listing: listingOf("sharedA") });
  await ageDelivery(x.id, inside);
  await ageDelivery(y.id, outside);
  const refund = await api("ops", "POST", "/api/finance/refunds", { orderNumber: x.orderNumber, amountPaise: 500, reason: "QA summary refund", chargeTo: "PLATFORM", requestId: rid("sumref") });
  expectStatus(refund, 201, "refund in the window");
  await db()`update financial_adjustments set created_at = ${new Date(inside.getTime() + 60_000)} where id = ${refund.body.id}`;
  const rows = await db()<{ order_id: string; gmv: number; goods: number; commission: number; fee: number; charge: number; discount: number }[]>`
    select order_id, gmv_paise::int as gmv, goods_paise::int as goods, commission_paise::int as commission, delivery_fee_paise::int as fee, shop_delivery_charge_paise::int as charge, discount_paise::int as discount
    from order_financials where delivered_at >= ${`${day}T00:00:00+05:30`} and delivered_at < ${`2026-09-16T00:00:00+05:30`}`;
  const riders = await db()<{ total: number }[]>`select coalesce(sum(total_paise), 0)::int as total from delivery_partner_earnings where created_at >= ${`${day}T00:00:00+05:30`} and created_at < ${`2026-09-16T00:00:00+05:30`}`;
  // Refunds after delivery in the window (this run's ₹5 plus any an earlier run left on the same quiet date).
  const [refunds] = await db()<{ total: number }[]>`select coalesce(sum(customer_refund_paise), 0)::int as total from financial_adjustments where created_at >= ${`${day}T00:00:00+05:30`} and created_at < ${`2026-09-16T00:00:00+05:30`}`;
  expect(refunds.total, "the ₹5 refund is in the window").toBeGreaterThanOrEqual(500);
  const ids = rows.map((r) => r.order_id);
  expect(ids, "the 00:10 IST delivery is in the day").toContain(x.id);
  expect(ids, "the 23:50 IST delivery (previous day) is not").not.toContain(y.id);
  const res = await api("admin", "GET", `/api/finance/summary?from=${day}&to=2026-09-16`);
  expectStatus(res, 200, "summary");
  const s = res.body;
  const hand = {
    deliveredOrders: rows.length,
    gmvPaise: rows.reduce((a, r) => a + r.gmv, 0),
    commissionPaise: rows.reduce((a, r) => a + r.commission, 0),
    deliveryFeeRevenuePaise: rows.reduce((a, r) => a + r.fee + r.charge, 0),
    riderCostPaise: riders[0].total,
    refundsAfterDeliveryPaise: refunds.total,
  };
  for (const [k, v] of Object.entries(hand)) expect(s[k], k).toBe(v);
  expect(s.platformNetPaise, "platform net").toBe(s.commissionPaise + s.deliveryFeeRevenuePaise - s.riderCostPaise - s.discountPaise - s.platformRefundCostPaise);
  return `${day} (IST): ${hand.deliveredOrders} delivered, GMV ₹${hand.gmvPaise / 100}, commission ₹${hand.commissionPaise / 100}, delivery fees ₹${hand.deliveryFeeRevenuePaise / 100}, rider cost ₹${hand.riderCostPaise / 100}, refunds ₹${refunds.total / 100} (incl. this run's ₹5) — all equal; the 23:50 IST drop counted on the 14th`;
}, local);

qa("TC-FIN-025", "order money trace: payment, wallet entries, snapshot, adjustments, journal, settlement, rider earning and reconciliation", async () => {
  const a1 = kept("rateShop", "shop A's order of TC-FIN-002");
  const b1 = kept("rateType", "shop B's order of TC-FIN-002");
  const ta = await trace(a1.orderNumber);
  const tb = await trace(b1.orderNumber);
  expect(tb.payment?.method).toBe("WALLET");
  expect(tb.payment?.amountPaise, "payment = the order total").toBe(b1.totalPaise);
  expect(tb.walletEntries.some((w) => w.amountPaise === -b1.totalPaise), "the wallet debit").toBe(true);
  expect(tb.snapshot?.goodsPaise).toBeGreaterThan(0);
  expect(tb.settlement?.status, "the settlement it went into").toBe("PAID");
  expect(tb.riderEarning?.totalPaise, "the rider's earning").toBeGreaterThan(0);
  expect(tb.ledger.map((l) => l.entryType)).toEqual(expect.arrayContaining(["GOODS_SALE", "RIDER_EARNING"]));
  expect(tb.reconciliation.map((r) => r.checkType)).toEqual(expect.arrayContaining(["ORDER_PAYMENT", "DELIVERED_SNAPSHOT"]));
  expect(ta.adjustments.some((a) => a.type === "REFUND_SHOP"), "the refund adjustment on order A").toBe(true);
  expect(ta.walletEntries.some((w) => w.type === "REFUND"), "the refund in the wallet entries").toBe(true);
  return `${b1.orderNumber}: payment ₹${(tb.payment?.amountPaise ?? 0) / 100}, ${tb.walletEntries.length} wallet entries, snapshot, ${tb.ledger.length} journal lines, settlement ${tb.settlement?.status}, earning ₹${(tb.riderEarning?.totalPaise ?? 0) / 100}, ${tb.reconciliation.length} reconciliation records; ${a1.orderNumber}: refund adjustment + wallet refund`;
}, local);

qa("TC-SPI-014", "the settlement uses the goods value at the time of sale less commission; later price and MRP changes do not alter it", async () => {
  const b1 = kept("rateType", "shop B's order of TC-FIN-002");
  const before = await trace(b1.orderNumber);
  const settledNet = before.settlement ? (await settlementById(before.settlement.id)).netPayablePaise : null;
  const listing = listingOf("sharedB");
  const priceNow = (await api("shopB", "GET", `/api/shops/${shopId("B")}/products`)).body?.find?.((p: { shopProductId: string; onlinePricePaise: number }) => p.shopProductId === listing.shopProductId)?.onlinePricePaise ?? listing.pricePaise;
  try {
    expectStatus(await api("shopB", "PATCH", `/api/shop-products/${listing.shopProductId}`, { onlinePricePaise: (priceNow ?? 4500) - 300 }), 200, "shop B lowers its price");
    const mrp = await api("admin", "POST", "/api/mrp", { productId: listing.productId, mrpPaise: 5200, source: "ADMIN", reason: "QA later MRP change" });
    expectStatus(mrp, 200, "admin changes the master MRP");
    const after = await trace(b1.orderNumber);
    expect(after.snapshot?.goodsPaise, "goods value at sale kept").toBe(before.snapshot?.goodsPaise);
    expect(after.snapshot?.shopPayablePaise, "payable kept").toBe(before.snapshot?.shopPayablePaise);
    if (settledNet != null) expect((await settlementById(before.settlement!.id)).netPayablePaise, "settlement net kept").toBe(settledNet);
  } finally {
    await api("shopB", "PATCH", `/api/shop-products/${listing.shopProductId}`, { onlinePricePaise: priceNow ?? 4500 });
    await api("admin", "POST", "/api/mrp", { productId: listing.productId, mrpPaise: 5000, source: "ADMIN", reason: "QA restore" });
  }
  return `${b1.orderNumber}: goods ₹${(before.snapshot?.goodsPaise ?? 0) / 100} and payable ₹${(before.snapshot?.shopPayablePaise ?? 0) / 100} unchanged after a price cut and an MRP change; settlement net ₹${(settledNet ?? 0) / 100} unchanged`;
}, local);

/* ------------------------------------------------------------- field rules */

qa("TC-FIN-007", "a settlement week must start on a Monday: a Wednesday is refused with 422 on both batch APIs", async () => {
  const wednesday = addDaysIso(lastWeek().start, 2);
  const bad: string[] = [];
  for (const path of ["/api/finance/settlements", "/api/finance/rider-payouts"]) {
    const res = await api("admin", "POST", path, { weekStart: wednesday });
    if (res.status !== 422) bad.push(`${path} ${wednesday} → ${res.status}`);
    else expect(JSON.stringify(res.body)).toMatch(/Monday/);
  }
  expect(bad, bad.join("\n")).toEqual([]);
  return `${wednesday} (a Wednesday) → 422 "A settlement week starts on a Monday." on settlements and rider payouts`;
}, local);

qa("TC-FLD-118", "settlement week start: a Tuesday, blank, 31 February and text are refused (422); a past Monday is accepted; a week that has not ended is refused", async () => {
  const bad: string[] = [];
  const lw = lastWeek();
  const probes: [unknown, string, number][] = [
    [lw.start.replace(/\d{2}$/, (d) => String(Number(d) + 2).padStart(2, "0")), "a Wednesday", 422],
    [lw.start.replace(/\d{2}$/, (d) => String(Number(d) + 1).padStart(2, "0")), "a Tuesday", 422],
    ["", "blank", 422],
    ["2026-02-31", "31 February", 422],
    ["next monday", "text", 422],
  ];
  for (const [weekStart, label, want] of probes) {
    for (const path of ["/api/finance/settlements", "/api/finance/rider-payouts"]) {
      const res = await api("admin", "POST", path, { weekStart });
      if (res.status !== want) bad.push(`${path} ${label} (${weekStart}) → ${res.status}`);
    }
  }
  // A past Monday is a normal preparation.
  const past = await api("admin", "POST", "/api/finance/settlements", { weekStart: "2026-08-03" });
  if (past.status !== 201) bad.push(`past Monday → ${past.status}`);
  // This week's Monday and a future Monday: the week has not ended.
  for (const [weekStart, label] of [[lw.thisMonday, "this week's Monday (week not ended)"], [lw.thisMonday.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_m, y, mo, d) => new Date(Date.UTC(+y, +mo - 1, +d + 14)).toISOString().slice(0, 10)), "a future Monday"]] as const) {
    const res = await api("admin", "POST", "/api/finance/settlements", { weekStart });
    if (res.status !== 422) bad.push(`${label} ${weekStart} → ${res.status}${res.status === 201 ? ` (accepted, ${(res.body as unknown[]).length} batches prepared)` : ""}`);
  }
  expect(bad, bad.join("\n")).toEqual([]);
  return "Wednesday / Tuesday / blank / 31 Feb / text → 422 on both batch APIs; past Monday 201; current and future week → 422";
}, { ...local, partial: "the page has no date field (it prepares last week only), so 'the API gives the same answer as the page' is the API alone" });

qa("TC-FLD-116", "manual adjustment amount and reason: zero, text, 3 decimals and out-of-range refused; ₹70.50 stored as 7050; the sign marks a deduction; a reason is required", async ({ browser }) => {
  const shop = shopId("A");
  const made: string[] = [];
  const bad: string[] = [];
  const post = (amountPaise: unknown, reason: unknown = "QA field check", omitReason = false) =>
    api("admin", "POST", "/api/finance/adjustments", {
      type: "SHOP_ADJUSTMENT",
      shopId: shop,
      amountPaise,
      ...(omitReason ? {} : { reason }),
      requestId: rid("fld"),
    });
  try {
    for (const [v, label] of [[0, "0"], [null, "blank"], ["abc", "text"], [1055.5, "10.555 (1055.5 paise)"], [10_000_000_000, "₹10,00,00,000 (10^10 paise)"]] as const) {
      const res = await post(v);
      if (res.status === 201) made.push(res.body.id);
      if (res.status !== 422) bad.push(`amount ${label} → ${res.status}`);
    }
    for (const [r, label] of [[null, "missing"], ["", "blank"], ["  ", "spaces"], ["ab", "2 letters"]] as const) {
      const res = await post(1000, r, r === null);
      if (res.status === 201) made.push(res.body.id);
      if (res.status !== 422) bad.push(`reason ${label} → ${res.status}`);
    }
    // The form: ₹70.50 is 7050 paise; a deduction is a minus sign; 10.555 must not be silently rounded.
    await asPage(browser, "admin", "/admin/finance", async (page) => {
      await page.getByRole("tab", { name: "Adjustments" }).click();
      const panel = page.getByRole("tabpanel").filter({ has: page.getByRole("button", { name: "Record adjustment" }) });
      const fill = async (amount: string, reason: string) => {
        await panel.getByLabel("Type").selectOption("SHOP_ADJUSTMENT");
        await panel.locator("label", { has: page.locator("span", { hasText: /^Shop$/ }) }).locator("select").selectOption({ index: 1 });
        await panel.getByLabel(/Amount ₹/).fill(amount);
        await panel.getByLabel("Reason").fill(reason);
      };
      await fill("70.50", "");
      await expect(panel.getByRole("button", { name: "Record adjustment" }), "no reason: the button stays off").toBeDisabled();
      await fill("70.50", `QA 70.50 ${RUN}`);
      await panel.getByRole("button", { name: "Record adjustment" }).click();
      await expect(panel.getByText("Adjustment recorded — it goes into the next batch.")).toBeVisible();
      await fill("-25", `QA deduction ${RUN}`);
      await panel.getByRole("button", { name: "Record adjustment" }).click();
      await expect(panel.getByText("Adjustment recorded — it goes into the next batch.")).toBeVisible();
      await fill("10.555", `QA three decimals ${RUN}`);
      await panel.getByRole("button", { name: "Record adjustment" }).click();
      await page.waitForTimeout(1500); // the form shows either an error or the notice; nothing else to wait on
    });
    const rows = await db()<{ id: string; amount: number; reason: string }[]>`select id, amount_paise::int as amount, reason from financial_adjustments where reason like ${`%${RUN}`} and reason like 'QA %' and created_at > now() - interval '10 minutes'`;
    for (const r of rows) if (/70\.50|deduction|three decimals/.test(r.reason)) made.push(r.id);
    const r7050 = rows.find((r) => r.reason.startsWith("QA 70.50"));
    if (r7050?.amount !== 7050) bad.push(`₹70.50 stored as ${r7050?.amount}`);
    const ded = rows.find((r) => r.reason.startsWith("QA deduction"));
    if (ded?.amount !== -2500) bad.push(`−₹25 stored as ${ded?.amount}`);
    const three = rows.find((r) => r.reason.startsWith("QA three decimals"));
    if (three) bad.push(`₹10.555 in the form was accepted and stored as ${three.amount} paise without a field message`);
  } finally {
    // These checks' own rows are taken out again so no batch pays them.
    if (made.length) {
      await db()`delete from finance_ledger_entries where source_type = 'financial_adjustments' and source_id = any(${made})`;
      await db()`delete from financial_adjustments where id = any(${made})`;
    }
  }
  expect(bad, bad.join("\n")).toEqual([]);
  return "API: 0, blank, text, 1055.5 paise, 10^10 paise and a missing / short reason → 422; form: ₹70.50 → 7050, −₹25 → −2500, no reason keeps the button off, 10.555 refused";
}, local);

/* ---------------------------------------------------------------- restore */

qa("TC-FIN-001", "the commission rates active before this file are put back", async () => {
  const before = unstash<string[]>(K("rates"));
  if (!before) blocked("no snapshot of the earlier rates (TC-FIN-001 did not run)");
  await restoreCommission(before);
  const active = await commissionSnapshot();
  expect(active.sort()).toEqual([...before].sort());
  return `${before.length} earlier rates active again`;
}, local);
