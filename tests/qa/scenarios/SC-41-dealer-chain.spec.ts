/**
 * SC-41 — a dealer chain earns the TIERED commission on a new shop (owner's
 * structure 20 / 4 / 3 %, DT-13 … DT-23): a prospect asks for a referral code,
 * the agent's dealer code is the one the shop registers with, the shop pays
 * the ₹4,999 slab and is approved, agent / lead / main dealer earn at once,
 * the agent's dashboard shows it, and the payout waits for the payee checks.
 *
 * Local tier (lib/dealer-commission-helpers.ts): the network and the shop's
 * attribution to the agent's code are arranged, the approval runs through the
 * API. SC-45 (a whole network month) needs seeded months of activity and a
 * month close: declared below with the reason.
 */
import { withFlags } from "../lib/billing-v2-helpers";
import { accruals, activatedShop, addMember, commissionAction, ledgerOf, tieredNetwork, visitorHeaders } from "../lib/dealer-commission-helpers";
import { withRules } from "../lib/finance-helpers";
import { anonymous, call, expectStatus } from "../lib/http";
import { expect, manual, need, qa } from "../lib/record";
import { ctxFor, freshAccount, uniqueMobile } from "../lib/sellers-helpers";

qa("SC-41", "dealer chain: request a code, register with the agent's code, ₹4,999 paid and approved → ₹999.80 / ₹199.96 / ₹149.97 at activation; held without agreement / bank; paid otherwise", async () => {
  return withFlags({ dealer_programme_enabled: true, dealer_rating_bonus_enabled: false }, () =>
    withRules({ dealerTieredCommission: { enabled: true } }, async () => {
      // 1. A prospect asks for a referral code.
      const guest = await anonymous();
      try {
        const asked = await call(guest, "POST", "/api/referral-requests", { name: "SC-41 Prospect", mobile: uniqueMobile(), shopType: "STATIONERY_STORE", area: "Kothrud", city: "Pune", pincode: "411038" }, visitorHeaders());
        expectStatus(asked, 201, "request a referral code");
        expect(asked.body.reference).toMatch(/^RCR-[0-9A-F]{8}$/);
      } finally {
        await guest.dispose();
      }
      const net = await tieredNetwork("sc41", { linkAccounts: true });
      // The agent's own dealer code is valid for a registration.
      const code = need(net.agent.code, "the agent's referral code");
      const prospect = await ctxFor(await freshAccount("sc41-prospect"));
      const check = await call(prospect, "GET", `/api/referral-codes/check?code=${code}`);
      expect(check.body, "the agent's code is accepted").toMatchObject({ valid: true });
      // 2–3. The shop registers with it, pays ₹4,999 and is approved: every level earns at once.
      const shop = await activatedShop(net.dealerId, net.agent.id);
      expect(await accruals(shop.shopId)).toEqual([
        ["DIRECT_1", net.agent.id, 99_980],
        ["OVERRIDE_LEAD", net.lead.id, 19_996],
        ["OVERRIDE_MAIN", null, 14_997],
      ]);
      const dash = await call(await ctxFor(need(net.agent.account, "the agent's account")), "GET", "/api/dealer/team?view=performance");
      expectStatus(dash, 200, "the agent's dashboard");
      expect(dash.body.report.rows[0].commissionPaise, "the agent's month so far").toBe(99_980);
      // 4. Payee checks: a new agent without the agreement is held; the agent with PAN + bank is paid.
      const unready = await addMember(net, "AGENT", net.lead.id, { pan: true, bank: false, agreement: false });
      const held = await activatedShop(net.dealerId, unready.id);
      const heldEntry = need((await ledgerOf(held.shopId)).find((r) => r.entry_type === "DIRECT_1"), "the unready agent's entry");
      expect(heldEntry.status, "held without the agreement").toBe("ON_HOLD");
      const entry = need((await ledgerOf(shop.shopId)).find((r) => r.entry_type === "DIRECT_1"), "the agent's entry");
      expectStatus(await commissionAction({ action: "approve", ids: [entry.id] }), 200, "approve");
      const batch = await commissionAction({ action: "createPayout", dealerId: net.dealerId, memberId: net.agent.id, note: "SC-41" });
      expectStatus(batch, 200, "the agent's payout");
      // A second admin approves before it is paid by hand.
      const approved = await call(await ctxFor(await freshAccount("sc41-admin2", "ADMIN")), "POST", "/api/admin/dealer-commission", { action: "approvePayout", batchId: batch.body.batch.id });
      if (approved.status === 409 && approved.body?.error?.details?.reason === "TDS_UNCONFIRMED") need(null, "a CA-confirmed TDS row (Admin → TDS on commission)");
      expectStatus(approved, 200, "another admin approves");
      const paid = await commissionAction({ action: "payoutPaid", batchId: batch.body.batch.id, reference: "SC41-UTR" });
      expectStatus(paid, 200, "paid with PAN and a verified bank");
      return `₹999.80 / ₹199.96 / ₹149.97 at activation; unready agent ON_HOLD; agent paid (${batch.body.batch.id.slice(0, 8)})`;
    }),
  );
}, { tier: "local", timeout: 420_000, partial: "the payout on the 5th through the month close is proven by tests/integration/dealer-tiered-commission.test.ts; here the agent's payout is drafted and paid by hand" });

manual(
  "SC-45",
  "dealer network month: targets, promotion, development bonus, reports, close and reversal",
  "needs a month of seeded activity (an agent with 50+ shops, a promoted team with 100+ shops), the 05:00 daily / Monday weekly report crons and a month close on the 5th; each part is checked on its own in tests/qa/local/dealer-commission-2026-11.spec.ts (TC-TIER-012/017/019/024/025/029/030) and proven together by tests/integration/dealer-tiered-commission.test.ts",
);
