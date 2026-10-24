/**
 * SC-09 — a daily milk subscription through the daily-orders job: charged
 * once per day at the day's quantity, nothing on skipped or paused days, and
 * a day that failed for a short wallet recovered by a retry with one debit.
 * TC-FIN-026 — that retried day reconciles (ORDER_PAYMENT MATCHED, not
 * counted twice).
 *
 * Local tier: the daily-orders and reconciliation jobs are run by hand for
 * chosen dates (as the scheduler would), and the wallet is drained by an
 * ordinary order (cancelled again afterwards).
 */
import {
  addDaysIso,
  api,
  arrangeGatewayTopUp,
  buy,
  cron,
  ensureFunds,
  freshListing,
  istDate,
  listingOf,
  walletBalance,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { expectStatus, stash, unstash } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 300_000 };

interface DayOrder {
  delivery_date: string;
  status: string;
  order_id: string | null;
  total: number | null;
  debits: number;
}

async function days(subscriptionId: string): Promise<DayOrder[]> {
  return db()<DayOrder[]>`
    select so.delivery_date::text, so.status, so.order_id, o.total_paise::int as total,
      (select count(*)::int from wallet_transactions w where w.order_id = so.order_id and w.amount_paise < 0) as debits
    from subscription_orders so left join orders o on o.id = so.order_id
    where so.subscription_id = ${subscriptionId} order by so.delivery_date`;
}

qa("SC-09", "daily milk subscription: ₹140 then ₹210 charged once each; nothing on skipped or paused days; a day failed for a short wallet is recovered by a retry with a single debit", async () => {
  stash("sc09-retried", null);
  const milk = listingOf("milk");
  await ensureFunds("customer", 300_000);
  const today = istDate();
  const d = (n: number) => addDaysIso(today, n);
  const created = await api("customer", "POST", "/api/subscriptions", { shopProductId: milk.shopProductId, quantityMilli: 2000, frequency: "DAILY", startDate: d(1) });
  expectStatus(created, 201, "subscribe to 2 L a day");
  const sub = created.body.id ?? created.body.subscription?.id;
  stash("sc09-sub", sub);
  const run = async (date: string) => {
    const res = await cron("daily-orders", { date, subscriptionIds: [sub] });
    expectStatus(res, 200, `daily orders for ${date}`);
    return res.body;
  };
  // Day 1, twice.
  const first = await run(d(1));
  const again = await run(d(1));
  expect([first.generated, again.generated, again.alreadyExisted], "generated once, the re-run finds it").toEqual([1, 0, 1]);
  // Tomorrow+1 at 3 L, skip the next, pause the two after.
  expectStatus(await api("customer", "POST", `/api/subscriptions/${sub}/override`, { date: d(2), quantityMilli: 3000 }), [200, 201], "3 L on day 2");
  expectStatus(await api("customer", "POST", `/api/subscriptions/${sub}/skip`, { date: d(3) }), [200, 201], "skip day 3");
  expectStatus(await api("customer", "POST", `/api/subscriptions/${sub}/pause`, { from: d(4), until: d(5) }), [200, 201], "pause days 4–5");
  for (const n of [2, 3, 4, 5]) await run(d(n));
  // Day 6: the wallet runs short (an ordinary order spends it down to ₹100), then a top-up and a retry.
  const balance = await walletBalance();
  const drain = await freshListing({ name: "QA Wallet Drain", pricePaise: balance - 10_000, stock: 2 });
  const spent = await buy(drain, 1);
  const short = await run(d(6));
  expect(short.walletFailures, "day 6 fails for the short wallet").toBe(1);
  await arrangeGatewayTopUp("customer", 50_000);
  const retried = await api("customer", "POST", `/api/subscriptions/${sub}/retry`, { date: d(6) });
  expectStatus(retried, 200, "retry day 6");
  const again6 = await api("customer", "POST", `/api/subscriptions/${sub}/retry`, { date: d(6) });
  await api("customer", "PATCH", `/api/orders/${spent.id}/status`, { status: "CANCELLED", note: "QA: undo the drain" });
  const rows = await days(sub);
  const byDate = new Map(rows.map((r) => [r.delivery_date, r]));
  const bad: string[] = [];
  const want: [number, number | null][] = [[1, 14_000], [2, 21_000], [3, null], [4, null], [5, null], [6, 14_000]];
  for (const [n, total] of want) {
    const r = byDate.get(d(n));
    if (total === null) {
      if (r?.order_id) bad.push(`day ${n} (${d(n)}) has an order (${r.status})`);
    } else {
      if (r?.total !== total) bad.push(`day ${n}: charged ${r?.total ?? "nothing"} (expected ${total})`);
      if (r?.debits !== 1) bad.push(`day ${n}: ${r?.debits ?? 0} wallet debits`);
    }
  }
  stash("sc09-retried", byDate.get(d(6))?.order_id ?? null);
  expect(bad, `${bad.join(" | ")} — ${rows.map((r) => `${r.delivery_date} ${r.status} ${r.total ?? "-"}`).join(", ")}`).toEqual([]);
  return `${rows.map((r) => `${r.delivery_date} ${r.status} ${r.total != null ? `₹${r.total / 100}` : "—"}`).join("; ")}; second retry → ${again6.status}`;
}, local);

qa("TC-FIN-026", "a subscription day that failed and was retried reconciles: ORDER_PAYMENT MATCHED, not counted twice", async () => {
  const orderId = unstash<string | null>("sc09-retried") ?? blocked("needs the retried subscription day of SC-09");
  const today = istDate();
  const res = await api("admin", "POST", "/api/finance/reconciliation", { from: addDaysIso(today, -1), to: addDaysIso(today, 1) });
  expectStatus(res, 200, "run reconciliation");
  const [rec] = await db()<{ status: string; expected: number | null; actual: number | null; detail: string | null }[]>`
    select status, expected_paise::int as expected, actual_paise::int as actual, detail from reconciliation_records where entity_id = ${orderId} and check_type = 'ORDER_PAYMENT'`;
  need(rec, "an ORDER_PAYMENT record for the retried day");
  expect(rec.status, `ORDER_PAYMENT expected ${rec.expected} found ${rec.actual}: ${rec.detail ?? ""}`).toBe("MATCHED");
  return `ORDER_PAYMENT MATCHED (₹${(rec.expected ?? 0) / 100})`;
}, local);
