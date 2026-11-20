/**
 * SC-48 — a territory dealer's year (DT-24 … DT-27, PR #419): an admin gives a
 * TIERED dealer an exclusive territory, the dealer pays the fee online, the daily
 * job rates it, customers order from a shop there (one goods refund), his card
 * shows the month so far, the month close writes the TERRITORY entry into his
 * one payout, and with the rule switched off again nothing more is worked out.
 *
 * Local tier (lib/dealer-territory-helpers.ts): the rule is switched on for the
 * journey and off at its end; the fee is paid on the local SANDBOX gateway page;
 * the orders are real deliveries from the world's shop A (GoKesari's 2% set on
 * it for the journey); the delivery dates are moved into an old month that is
 * then closed with "Close <month> now".
 */
import { dealerOnly } from "../lib/dealer-commission-helpers";
import {
  backdate,
  cancelAll,
  closeMonth,
  delivered,
  feeOnSandbox,
  feeRows,
  freeMonth,
  give,
  midMonth,
  myTerritory,
  refundGoods,
  rs,
  shareOf,
  shopA,
  TEST_PIN,
  territorial,
  territoryAction,
  territoryCard,
  territoryDaily,
  territoryEntries,
  territoryRow,
  withCommission,
} from "../lib/dealer-territory-helpers";
import { db } from "../lib/db";
import { withRules } from "../lib/finance-helpers";
import { call, expectStatus, RUN } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { ctxFor, pageFor } from "../lib/sellers-helpers";

qa("SC-48", "territory dealer: exclusive pincodes and fee, paid online (Active only after the webhook), daily rating 20–25%, orders and a refund on his card, the month's TERRITORY entry in his one payout; nothing more once the rule is off", async ({ browser }) => {
  return territorial(() =>
    withCommission([shopA()], 200, async () => {
      const d = await dealerOnly("sc48");
      await db()`update users set role = 'DEALER' where id = ${d.owner.id}`;
      await db()`insert into user_role_grants (user_id, role, source) values (${d.owner.id}, 'DEALER', 'ADMIN') on conflict do nothing`;
      const rival = await dealerOnly("sc48b");
      try {
        // 1. The territory: exclusive pincodes and a yearly fee.
        const t = await give(d.dealerId, [TEST_PIN], { name: `SC-48 Kothrud ${RUN}`, feePaise: 5_000_000 });
        const second = await territoryAction({ action: "create", dealerId: rival.dealerId, name: "SC-48 rival", pincodes: [TEST_PIN], feePaise: 5_000_000 });
        expectStatus(second, 409, "a second holder of 411038");
        // 2. Paid online; Active only after the gateway's webhook.
        const { context, page } = await pageFor(browser, d.owner);
        try {
          await page.goto("/dealer");
          const card = territoryCard(page);
          await card.getByRole("button", { name: "Pay ₹50,000 now" }).click();
          await page.waitForURL(/\/orders\/pay\/sandbox\//);
          expect((await territoryRow(t.id)).status, "before the webhook").toBe("AWAITING_FEE");
          await feeOnSandbox(page, "pay");
          expect((await territoryRow(t.id)).status, "after the webhook").toBe("ACTIVE");
          expect((await feeRows(t.id)).map((f) => [f.status, f.method])).toEqual([["PAID", "ONLINE"]]);
          // 3. The daily rating; orders from shop A; one goods refund.
          await db()`update dealers set rating = 7 where id = ${d.dealerId}`;
          await territoryDaily();
          const [rating] = await db()<{ share_bp: number; day: string }[]>`select share_bp, to_char(day, 'YYYY-MM-DD') as day from dealer_territory_ratings where territory_id = ${t.id}`;
          const share = need(rating, "today's rating").share_bp;
          expect(share, "20–25%").toBeGreaterThanOrEqual(2000);
          expect(share).toBeLessThanOrEqual(2500);
          const o1 = await delivered();
          const o2 = await delivered({ quantity: 10 });
          await refundGoods(o1.order_number, 20_000);
          const refunded = Math.round((20_000 * o1.commission_rate_bp) / 10_000);
          const kept = o1.commission_paise - refunded + o2.commission_paise;
          const income = shareOf(o1.commission_paise - refunded, share) + shareOf(o2.commission_paise, share);
          // 4. His card: this month's orders and income.
          expect((await myTerritory(await ctxFor(d.owner), t.id)).monthSoFar).toEqual({ orders: 2, commissionKeptPaise: kept, incomePaise: income });
          await page.goto("/dealer");
          await expect(card).toContainText(`This month so far: 2 orders · ${rs(kept)} GoKesari commission · ${rs(income)} for you`);
          // 5. The month close: one TERRITORY entry in his one payout, on the statement as "Territory order income".
          const month = await freeMonth();
          await backdate(t.id, [o1.order_id, o2.order_id], midMonth(month));
          await db()`update dealer_territory_ratings set day = ${`${month}-01`} where territory_id = ${t.id} and day = ${rating.day}`;
          await closeMonth(month);
          const entries = await territoryEntries(d.dealerId);
          expect(entries.map((e) => [e.kind, e.amount_paise, e.payee_member_id]), "one TERRITORY entry, net of the refund").toEqual([["ACCRUAL", income, null]]);
          const [batch] = await db()<{ n: number; total: number }[]>`select count(*)::int as n, max(total_paise)::int as total from dealer_payout_batches where dealer_id = ${d.dealerId} and period_month = ${month}`;
          expect(batch, "one payout").toEqual({ n: 1, total: income });
          const csv = await call(await ctxFor(d.owner), "GET", `/api/dealer/commission/statement?month=${month}`);
          expect(csv.text).toContain(`"  Territory order income (Rs)","${(income / 100).toFixed(2)}"`);
          // 6. The rule off again: no more order income is worked out.
          await withRules({ territoryDealer: { enabled: false } }, async () => {
            const o3 = await delivered();
            const off = await freeMonth();
            await backdate(t.id, [o3.order_id], midMonth(off));
            await closeMonth(off);
            expect((await territoryEntries(d.dealerId)).length, "no entry with the rule off").toBe(1);
            const refused = await territoryAction({ action: "create", dealerId: d.dealerId, name: "SC-48 off", pincodes: ["799991"], feePaise: 5_000_000 });
            expectStatus(refused, 409, "give a territory with the rule off");
          });
          return `411038 exclusive; paid online → Active after the webhook; share ${share / 100}%; 2 orders, ₹200 refunded → ${rs(income)}; ${month}: TERRITORY ${rs(income)} in one payout, statement line; rule off → nothing more`;
        } finally {
          await context.close();
        }
      } finally {
        await cancelAll();
      }
    }),
  );
}, { tier: "local", timeout: 600_000, partial: "the delivery dates are moved into an old month closed with 'Close <month> now' (the payout-day job closes only last month); the payout is drafted, its approval and payment are TC-TERR-022" });
