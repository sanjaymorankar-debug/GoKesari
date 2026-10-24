/**
 * Money journeys across a week.
 *   SC-14 — weekly settlement and payout: commission set, several orders
 *           (one refunded in part, one COD) delivered last week, the shop's
 *           settlement and the rider's payout prepared, approved and paid
 *           with references, shop and rider see their own statements, and
 *           reconciliation of the period is clean.
 *   SC-15 — cash on delivery: the shop opts in, a COD order under ₹2,000 is
 *           delivered with the code and the cash confirmed, the cash is
 *           tracked against the rider until operations record the deposit,
 *           and the weekly payout nets the cash still held.
 *
 * Local tier: the commission rate, shop B's COD switch and the delivery
 * dates (moved into last week, as the weekly batches only take last week's
 * deliveries) are arranged and restored; settlement and payout batches are
 * global, so the checks look at the batches that hold this journey's orders.
 */
import {
  addDaysIso,
  ageDelivery,
  api,
  asPage,
  commissionSnapshot,
  deliveredOrder,
  ensureFunds,
  freshListing,
  istDate,
  lastWeek,
  partnerId,
  restoreCommission,
  rid,
  setCommission,
  shopId,
  shown,
  type Payout,
  type Settlement,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { expectStatus, RUN } from "../lib/http";
import { expect, need, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 600_000 };

async function ageAdjustments(orderId: string) {
  await db()`update financial_adjustments set created_at = ${lastWeek().inside} where order_id = ${orderId}`;
}

async function withCod<T>(body: () => Promise<T>): Promise<T> {
  const b = shopId("B");
  const [before] = await db()<{ cod_enabled: boolean }[]>`select cod_enabled from shops where id = ${b}`;
  try {
    return await body();
  } finally {
    await db()`update shops set cod_enabled = ${before.cod_enabled} where id = ${b}`;
  }
}

interface ReconRecord {
  entityId: string;
  checkType: string;
  status: string;
  detail: string | null;
  expectedPaise: number | null;
  actualPaise: number | null;
}

/* ------------------------------------------------------------------ SC-14 */

qa("SC-14", "weekly settlement and payout: batches total gross − commission − refunds ± adjustments (− COD cash held for the rider); approved and paid with references; shop and rider see their own statements; reconciliation is clean", async ({ browser }) => {
  const rates = await commissionSnapshot();
  try {
    return await withCod(async () => {
      // 1. Commission for shop B: 10 %.
      await setCommission("SHOP", 1000, { shopId: shopId("B") });
      await db()`update shops set cod_enabled = true where id = ${shopId("B")}`;
      await ensureFunds("customer", 300_000);
      // 2. Three orders delivered: a plain one, one refunded ₹50 (charged to the shop), one cash on delivery.
      const listing = await freshListing({ name: "QA Week Paneer", shop: "B", pricePaise: 20_000, stock: 20 });
      const plain = await deliveredOrder({ listing });
      const refunded = await deliveredOrder({ listing });
      const cod = await deliveredOrder({ listing, method: "COD" });
      const refund = await api("ops", "POST", "/api/finance/refunds", { orderNumber: refunded.orderNumber, amountPaise: 5000, reason: "QA: one pack short-dated", chargeTo: "SHOP", requestId: rid("sc14") });
      expectStatus(refund, 201, "₹50 refund charged to the shop");
      const mine = [plain, refunded, cod];
      for (const o of mine) {
        await ageDelivery(o.id);
        await ageAdjustments(o.id);
      }
      // 3. Last week's settlements and rider payouts.
      const prepared = await api("admin", "POST", "/api/finance/settlements", {});
      expectStatus(prepared, 201, "prepare last week's settlements");
      const [line] = await db()<{ settlement_id: string | null }[]>`select settlement_id from order_financials where order_id = ${plain.id}`;
      const batch = need(((prepared.body as Settlement[]) ?? []).find((s) => s.id === line.settlement_id), "shop B's new settlement holding the orders");
      const lines = await db()<{ order_id: string; goods: number; payable: number; rate: number }[]>`
        select order_id, goods_paise::int as goods, shop_payable_paise::int as payable, commission_rate_bp as rate from order_financials where settlement_id = ${batch.id}`;
      const adjs = await db()<{ type: string; amount: number; order_id: string | null }[]>`select type, amount_paise::int as amount, order_id from financial_adjustments where settlement_id = ${batch.id}`;
      const bad: string[] = [];
      for (const o of mine) if (!lines.some((l) => l.order_id === o.id)) bad.push(`${o.orderNumber} is not in shop B's batch`);
      for (const l of lines.filter((x) => mine.some((o) => o.id === x.order_id))) if (l.rate !== 1000) bad.push(`order ${l.order_id.slice(0, 8)} at ${l.rate} bp, expected 1000`);
      const goods = lines.reduce((s, l) => s + l.goods, 0);
      const commission = lines.reduce((s, l) => s + (l.goods - l.payable), 0);
      const refunds = adjs.filter((a) => a.type === "REFUND_SHOP").reduce((s, a) => s + a.amount, 0);
      const other = adjs.filter((a) => a.type !== "REFUND_SHOP").reduce((s, a) => s + a.amount, 0);
      const myRefund = adjs.find((a) => a.type === "REFUND_SHOP" && a.order_id === refunded.id);
      if (myRefund?.amount !== -4500) bad.push(`the ₹50 refund recovers ${myRefund?.amount ?? "nothing"} from the shop (expected −4500: ₹50 less its 10 % commission)`);
      if (batch.goodsPaise !== goods) bad.push(`goods ${batch.goodsPaise} ≠ Σ ${goods}`);
      if (batch.commissionPaise !== commission) bad.push(`commission ${batch.commissionPaise} ≠ Σ ${commission}`);
      if (batch.refundsPaise !== refunds) bad.push(`refunds ${batch.refundsPaise} ≠ Σ ${refunds}`);
      if (batch.netPayablePaise !== goods - commission + refunds + other) bad.push(`net ${batch.netPayablePaise} ≠ ${goods} − ${commission} + ${refunds} + ${other}`);
      // The rider hands in the COD order's cash (dated last week): a payout whose cash held outweighs the
      // earnings would be negative and cannot be paid (TC-COD-010), so the deposit comes before the payout.
      const riderId = await partnerId("rider");
      const deposit = await api("admin", "POST", "/api/admin/cod", { party: "RIDER", id: riderId, amountPaise: cod.totalPaise, reference: `QA-RCPT-${RUN}-S14`, requestId: rid("sc14dep") });
      expectStatus(deposit, 201, "record the rider's cash deposit");
      await db()`update financial_adjustments set created_at = ${lastWeek().inside} where id = ${deposit.body.id}`;
      const preparedPayouts = await api("admin", "POST", "/api/finance/rider-payouts", {});
      expectStatus(preparedPayouts, 201, "prepare last week's rider payouts");
      const rider = riderId;
      const payout = need(((preparedPayouts.body as Payout[]) ?? []).find((p) => p.deliveryPartnerId === rider), "rider 1's new payout");
      const earnings = await db()<{ total: number; order_id: string | null }[]>`
        select e.total_paise::int as total, d.order_id from delivery_partner_earnings e left join delivery_orders d on d.id = e.delivery_order_id where e.payout_id = ${payout.id}`;
      const riderAdjs = await db()<{ type: string; amount: number; order_id: string | null }[]>`select type, amount_paise::int as amount, order_id from financial_adjustments where payout_id = ${payout.id}`;
      for (const o of mine) if (!earnings.some((e) => e.order_id === o.id)) bad.push(`rider's earning for ${o.orderNumber} is not in the payout`);
      const codHeld = riderAdjs.find((a) => a.type === "COD_CASH_COLLECTED" && a.order_id === cod.id);
      if (codHeld?.amount !== -cod.totalPaise) bad.push(`COD cash held in the payout ${codHeld?.amount ?? "missing"} (expected −${cod.totalPaise})`);
      if (!riderAdjs.some((a) => a.type === "COD_CASH_DEPOSITED" && a.amount === cod.totalPaise)) bad.push("the cash deposit is not in the payout");
      const gross = earnings.reduce((s, e) => s + e.total, 0);
      const adjSum = riderAdjs.reduce((s, a) => s + a.amount, 0);
      if (payout.grossPaise !== gross || payout.amountPaise !== gross + adjSum) bad.push(`payout ${payout.amountPaise} ≠ gross ${gross} + adjustments ${adjSum}`);
      // 4. Approved and paid with references.
      const utr = `UTR${RUN.toUpperCase()}S14`;
      for (const action of ["approve", "process"]) expectStatus(await api("admin", "PATCH", `/api/finance/settlements/${batch.id}`, { action }), 200, `settlement ${action}`);
      expectStatus(await api("admin", "PATCH", `/api/finance/settlements/${batch.id}`, { action: "pay", note: utr }), 200, "settlement paid");
      for (const action of ["approve", "process"]) expectStatus(await api("admin", "PATCH", `/api/finance/rider-payouts/${payout.id}`, { action }), 200, `payout ${action}`);
      expectStatus(await api("admin", "PATCH", `/api/finance/rider-payouts/${payout.id}`, { action: "pay", note: `${utr}R` }), 200, "payout paid");
      // Each sees their own statement.
      await asPage(browser, "shopB", "/shop/finance", async (page) => {
        const row = page.locator("#settlements").getByText(`paid, ref ${utr}`);
        await expect(row, "the shop's settlement statement").toBeVisible();
      });
      await asPage(browser, "rider", "/delivery-partner", async (page) => {
        await expect(page.getByTestId("rider-payouts"), "the rider's payout statement").toContainText(`ref ${utr}R`);
        await expect(page.getByTestId("rider-payouts")).toContainText(shown(payout.amountPaise));
      });
      // 5. Reconciliation for the period.
      const today = istDate();
      const run = await api("admin", "POST", "/api/finance/reconciliation", { from: addDaysIso(lastWeek().start, 0), to: addDaysIso(today, 1) });
      expectStatus(run, 200, "run reconciliation");
      // The stored records (the admin list shows only the 200 most recently checked).
      const records = await db()<ReconRecord[]>`select entity_id as "entityId", check_type as "checkType", status, detail, expected_paise::int as "expectedPaise", actual_paise::int as "actualPaise" from reconciliation_records`;
      const legs = await db()<{ id: string; order_id: string }[]>`select id, order_id from delivery_orders where order_id = any(${mine.map((o) => o.id)}) and status = 'DELIVERED'`;
      const want: [string, string, string][] = [
        ...mine.map((o) => [o.id, "ORDER_PAYMENT", `${o.orderNumber} payment`] as [string, string, string]),
        ...legs.map((l) => [l.id, "EARNING_PRESENT", `earning for ${l.order_id.slice(0, 8)}`] as [string, string, string]),
        [batch.id, "SETTLEMENT_TOTAL", "the settlement"],
        [payout.id, "PAYOUT_TOTAL", "the payout"],
      ];
      for (const [id, check, what] of want) {
        const r = records.find((x) => x.entityId === id && x.checkType === check);
        if (r?.status !== "MATCHED") bad.push(`reconciliation: ${what} ${check} → ${r?.status ?? "no record"} (expected ${r?.expectedPaise} found ${r?.actualPaise}${r?.detail ? `: ${r.detail}` : ""})`);
      }
      expect(bad, bad.join("\n")).toEqual([]);
      return `shop B batch: ${batch.orderCount} orders, goods ₹${goods / 100} − commission ₹${commission / 100} + refunds ₹${refunds / 100} + adjustments ₹${other / 100} = ₹${batch.netPayablePaise / 100}, paid ${utr}; rider 1 payout ₹${gross / 100} + ₹${adjSum / 100} (incl. COD −₹${cod.totalPaise / 100}) = ₹${payout.amountPaise / 100}, paid; statements on /shop/finance and /delivery-partner; reconciliation MATCHED`;
    });
  } finally {
    await restoreCommission(rates);
  }
}, local);

/* ------------------------------------------------------------------ SC-15 */

qa("SC-15", "cash on delivery: the shop opts in, a COD order under ₹2,000 is paid on delivery, the cash is tracked against the rider until the deposit, and the weekly payout nets what is still held", async () => {
  return withCod(async () => {
    // 1. The shop opts in (its own settings).
    expectStatus(await api("shopB", "PATCH", `/api/shops/${shopId("B")}`, { codEnabled: true }), 200, "shop B turns on cash on delivery");
    const rider = await partnerId("rider");
    const held = async () => {
      const res = await api("admin", "GET", "/api/admin/cod");
      expectStatus(res, 200, "cash held");
      const rows = (Array.isArray(res.body) ? res.body : (res.body?.holders ?? [])) as { party: string; id: string; heldPaise: number }[];
      return rows.find((r) => r.party === "RIDER" && r.id === rider)?.heldPaise ?? 0;
    };
    const start = await held();
    // 2.–3. Two COD orders under ₹2,000, delivered with the code and the cash confirmed.
    const listing = await freshListing({ name: "QA Cash Ghee", shop: "B", pricePaise: 45_000, stock: 10 });
    const first = await deliveredOrder({ listing, method: "COD" });
    const second = await deliveredOrder({ listing, method: "COD" });
    const bad: string[] = [];
    for (const o of [first, second]) {
      const [row] = await db()<{ status: string; paid: Date | null; cod: Date | null; total: number }[]>`select status, paid_at as paid, cod_collected_at as cod, total_paise::int as total from orders where id = ${o.id}`;
      if (row.status !== "DELIVERED" || !row.paid || !row.cod) bad.push(`${o.orderNumber}: ${row.status}, paid ${row.paid ? "yes" : "no"}, cash collected ${row.cod ? "yes" : "no"}`);
      if (row.total >= 200_000) bad.push(`${o.orderNumber} is ₹${row.total / 100}, not under ₹2,000`);
    }
    const afterDrops = await held();
    if (afterDrops - start !== first.totalPaise + second.totalPaise) bad.push(`cash held by the rider rose by ${afterDrops - start}, expected ${first.totalPaise + second.totalPaise}`);
    // 4. Operations record the deposit of the first order's cash (more than is held is refused).
    const tooMuch = await api("admin", "POST", "/api/admin/cod", { party: "RIDER", id: rider, amountPaise: afterDrops + 100, reference: `QA-RCPT-${RUN}-X`, requestId: rid("dep") });
    if (tooMuch.status !== 409) bad.push(`a deposit above the cash held → ${tooMuch.status} (expected 409)`);
    const deposit = await api("admin", "POST", "/api/admin/cod", { party: "RIDER", id: rider, amountPaise: first.totalPaise, reference: `QA-RCPT-${RUN}`, requestId: rid("dep") });
    expectStatus(deposit, 201, "record the deposit");
    const afterDeposit = await held();
    if (afterDrops - afterDeposit !== first.totalPaise) bad.push(`the deposit lowered the cash held by ${afterDrops - afterDeposit}, expected ${first.totalPaise}`);
    // 5. The weekly payout nets the cash still held.
    for (const o of [first, second]) {
      await ageDelivery(o.id);
      await ageAdjustments(o.id);
    }
    await db()`update financial_adjustments set created_at = ${lastWeek().inside} where id = ${deposit.body.id}`;
    const prepared = await api("admin", "POST", "/api/finance/rider-payouts", {});
    expectStatus(prepared, 201, "prepare last week's payouts");
    const payout = need(((prepared.body as Payout[]) ?? []).find((p) => p.deliveryPartnerId === rider), "rider 1's payout");
    const linked = await db()<{ id: string; type: string; amount: number; order_id: string | null }[]>`select id, type, amount_paise::int as amount, order_id from financial_adjustments where payout_id = ${payout.id}`;
    const mine = linked.filter((a) => a.order_id === first.id || a.order_id === second.id || a.id === deposit.body.id);
    if (mine.length !== 3) bad.push(`${mine.length} of the 3 cash entries (2 collected, 1 deposit) are in the payout`);
    const net = mine.reduce((s, a) => s + a.amount, 0);
    if (net !== -second.totalPaise) bad.push(`the payout nets ${net} for these orders, expected −${second.totalPaise} (the cash still held)`);
    const [{ gross }] = await db()<{ gross: number }[]>`select coalesce(sum(total_paise), 0)::int as gross from delivery_partner_earnings where payout_id = ${payout.id}`;
    if (payout.amountPaise !== gross + linked.reduce((s, a) => s + a.amount, 0)) bad.push(`payout amount ${payout.amountPaise} ≠ earnings ${gross} + adjustments`);
    expect(bad, bad.join("\n")).toEqual([]);
    return `${first.orderNumber} ₹${first.totalPaise / 100} and ${second.orderNumber} ₹${second.totalPaise / 100} paid on delivery; rider's cash held +₹${(afterDrops - start) / 100}; deposit above the cash held → 409; deposit of ₹${first.totalPaise / 100} recorded → held −₹${first.totalPaise / 100}; the payout nets −₹${second.totalPaise / 100} for the cash still held (amount ₹${payout.amountPaise / 100})`;
  });
}, local);
