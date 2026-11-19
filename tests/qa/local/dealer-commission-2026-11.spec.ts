/**
 * TIERED dealer commission — the owner's structure 20 / 4 / 3 % (DT-13 …
 * DT-23, docs/dealer-programme/TIERED_COMMISSION.md) — and the shop-referral
 * request, on the local server.
 *
 * Local tier: dealer_programme_enabled is switched on for every district and
 * rule dealerTieredCommission on for the check, then both are put back. Each
 * check builds its own TIERED network (lib/dealer-commission-helpers.ts): the
 * dealer row and the members' PAN / bank / agreement are arranged, the team
 * is built and the model changed through the admin API, and every shop is
 * approved by operations through the API — that approval accrues the
 * commission under test.
 *
 * The main dealer's 3% (DT-23, PR #417, migration 0150) is the rule's default
 * from that release: TC-TIER-012 / 015 / 016 / 017 and SC-41 read the rule as
 * the site has it and expect 3%; TC-TIER-013 sets 2% then 3% itself.
 */
import { as, pageAs } from "../lib/actors";
import { withFlags } from "../lib/billing-v2-helpers";
import {
  accruals,
  activatedShop,
  addMember,
  AGENT_AGREEMENT_VERSION,
  commissionAction,
  dealerOnly,
  ledgerOf,
  SLAB_4999,
  SLAB_9999,
  tieredNetwork,
  tierAction,
  visitorHeaders,
} from "../lib/dealer-commission-helpers";
import { db } from "../lib/db";
import { withRules } from "../lib/finance-helpers";
import { anonymous, call, expectStatus, RUN } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { approvedShopOfNewOwner, ctxFor, freshAccount, pageFor, uniqueMobile } from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 300_000 };

/** dealer_programme_enabled on, the rating bonus off, rule dealerTieredCommission on (plus `rule`). */
function tiered<T>(body: () => Promise<T>, rule: Record<string, unknown> = {}, flags: { rating?: boolean } = {}): Promise<T> {
  return withFlags({ dealer_programme_enabled: true, dealer_rating_bonus_enabled: Boolean(flags.rating) }, () => withRules({ dealerTieredCommission: { enabled: true, ...rule } }, body));
}

const AGREEMENT_HOLD_NOTE = "held: the agent agreement is not accepted yet — released when it is";

/* ------------------------------------------------ TS-DLR-12: the split */

qa("TC-TIER-012", "each signer: agent's ₹4,999 shop 999.80 / 199.96 / 149.97; lead's own 999.80 + 149.97; main dealer's own 999.80; ₹9,999 1,999.80 / 399.96 / 299.97 — all at activation", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t012");
    const agentShop = await activatedShop(net.dealerId, net.agent.id, SLAB_4999);
    const leadShop = await activatedShop(net.dealerId, net.lead.id, SLAB_4999);
    const mainShop = await activatedShop(net.dealerId, null, SLAB_4999);
    const bigShop = await activatedShop(net.dealerId, net.agent.id, SLAB_9999);
    expect(await accruals(agentShop.shopId), "agent's ₹4,999 shop (27%)").toEqual([
      ["DIRECT_1", net.agent.id, 99_980],
      ["OVERRIDE_LEAD", net.lead.id, 19_996],
      ["OVERRIDE_MAIN", null, 14_997],
    ]);
    expect(await accruals(leadShop.shopId), "lead's own shop (23%, no 4% on top)").toEqual([
      ["DIRECT_1", net.lead.id, 99_980],
      ["OVERRIDE_MAIN", null, 14_997],
    ]);
    expect(await accruals(mainShop.shopId), "main dealer's own shop (20% only)").toEqual([["DIRECT_1", null, 99_980]]);
    expect(await accruals(bigShop.shopId), "₹9,999 by the agent").toEqual([
      ["DIRECT_1", net.agent.id, 199_980],
      ["OVERRIDE_LEAD", net.lead.id, 39_996],
      ["OVERRIDE_MAIN", null, 29_997],
    ]);
    for (const s of [agentShop, leadShop, mainShop, bigShop]) {
      const statuses = [...new Set((await ledgerOf(s.shopId)).map((r) => r.status))];
      expect(statuses, "earned at activation (no TRADING wait)").toEqual(["EARNED"]);
    }
    // Admin → Dealers → Commission → Ledger shows them.
    const admin = await call(await as("admin"), "GET", `/api/admin/dealer-commission?dealerId=${net.dealerId}`);
    expectStatus(admin, 200, "the dealer's ledger for the admin");
    expect((admin.body.ledger as unknown[]).length, "4 + 3 + 2 + 1 … entries listed").toBeGreaterThanOrEqual(9);
    return "agent 999.80/199.96/149.97; lead 999.80+149.97; main 999.80; ₹9,999 1,999.80/399.96/299.97 — all EARNED";
  });
}, { ...local, timeout: 420_000 });

qa("TC-TIER-013", "a shop activated while the main dealer's share was 2% keeps ₹99.98; a shop activated after the change to 3% earns ₹149.97", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t013");
    const before = await withRules({ dealerTieredCommission: { mainOverrideBp: 200 } }, () => activatedShop(net.dealerId, net.agent.id));
    const after = await withRules({ dealerTieredCommission: { mainOverrideBp: 300 } }, () => activatedShop(net.dealerId, net.agent.id));
    const main = async (shopId: string) => (await accruals(shopId)).find((r) => r[0] === "OVERRIDE_MAIN")?.[2];
    expect(await main(before.shopId), "older shop: 2%, not recalculated").toBe(9_998);
    expect(await main(after.shopId), "new shop: 3%").toBe(14_997);
    const plans = await db()<{ shop_id: string; main_override_bp: number }[]>`select shop_id, main_override_bp from dealer_tier_shop_plans where shop_id in ${db()([before.shopId, after.shopId])}`;
    expect(plans.find((p) => p.shop_id === before.shopId)?.main_override_bp, "the older plan is frozen at 2%").toBe(200);
    expect(plans.find((p) => p.shop_id === after.shopId)?.main_override_bp).toBe(300);
    return "plan at 2% keeps ₹99.98; new plan 3% ₹149.97";
  });
}, local);

qa("TC-TIER-015", "a 10% coupon lowers the base: 20 / 4 / 3 % of ₹4,499.10 (the fee after the coupon, before GST)", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t015");
    const shop = await activatedShop(net.dealerId, net.agent.id, SLAB_4999, { discountPaise: 49_990 });
    expect(await accruals(shop.shopId)).toEqual([
      ["DIRECT_1", net.agent.id, 89_982],
      ["OVERRIDE_LEAD", net.lead.id, 17_996],
      ["OVERRIDE_MAIN", null, 13_497],
    ]);
    const [plan] = await db()<{ fee_paise: number }[]>`select fee_paise from dealer_tier_shop_plans where shop_id = ${shop.shopId}`;
    expect(plan.fee_paise, "the base is the fee after the coupon, without GST").toBe(449_910);
    return "base ₹4,499.10: 899.82 / 179.96 / 134.97";
  });
}, local);

qa("TC-TIER-016", "the dealer's rating (6.0, step 1%) moves only the direct share: 21% to the signer, the lead's 4% and the main dealer's 3% unchanged", async () => {
  return tiered(
    async () => {
      const net = await tieredNetwork("t016");
      await db()`update dealers set rating = 6.0, rating_step_bp = 100 where id = ${net.dealerId}`;
      const shop = await activatedShop(net.dealerId, net.agent.id);
      expect(await accruals(shop.shopId)).toEqual([
        ["DIRECT_1", net.agent.id, 104_979],
        ["OVERRIDE_LEAD", net.lead.id, 19_996],
        ["OVERRIDE_MAIN", null, 14_997],
      ]);
      return "rating 6.0: direct 21% ₹1,049.79; lead ₹199.96 and main ₹149.97 unchanged";
    },
    {},
    { rating: true },
  );
}, local);

/* ------------------------------------------- TS-DLR-14: renewal, promotion */

qa("TC-TIER-017", "renewal ₹4,999 in year 2: agent ₹499.90, lead ₹99.98, main ₹49.99; after 3 years nothing; renewals off nothing", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t017");
    const renew = async (shopId: string) => {
      const res = await call(await as("admin"), "POST", "/api/shop-payments", { shopId, paymentType: "RENEWAL", amountPaise: 589_882, method: "CASH", note: "QA renewal" });
      expectStatus(res, 201, "record the renewal payment");
      return (await ledgerOf(shopId)).filter((r) => r.entry_type === "RENEWAL").map((r) => [r.payee_member_id, r.amount_paise]);
    };
    const year2 = await activatedShop(net.dealerId, net.agent.id);
    await db()`update dealer_tier_shop_plans set activated_at = now() - interval '400 days' where shop_id = ${year2.shopId}`;
    const rows = await renew(year2.shopId);
    expect(rows, "year 2: 10 / 2 / 1 % of ₹4,999").toEqual(expect.arrayContaining([[net.agent.id, 49_990], [net.lead.id, 9_998], [null, 4_999]]));
    expect(rows.length).toBe(3);
    const old = await activatedShop(net.dealerId, net.agent.id);
    await db()`update dealer_tier_shop_plans set activated_at = now() - interval '3 years 5 days' where shop_id = ${old.shopId}`;
    expect(await renew(old.shopId), "after 3 years: nothing").toEqual([]);
    const off = await activatedShop(net.dealerId, net.agent.id);
    const none = await withRules({ dealerTieredCommission: { renewalEnabled: false } }, () => renew(off.shopId));
    expect(none, "renewals switched off: nothing").toEqual([]);
    return "year 2 ₹499.90 / ₹99.98 / ₹49.99; after 3 years and with renewals off nothing";
  });
}, { ...local, timeout: 420_000 });

qa("TC-TIER-019", "promotion: below 50 shops / 3 ready agents only 'Promote anyway (override)' (with a reason); promoted he reports to the main dealer with the agents he brought in", async ({ browser }) => {
  return tiered(async () => {
    const net = await tieredNetwork("t019", { linkAccounts: true });
    // The agent brings in a sub-agent (request approved by an admin).
    const agentCtx = await ctxFor(need(net.agent.account, "the agent's account"));
    const asked = await call(agentCtx, "POST", "/api/dealer/team", { action: "requestSubAgent", employeeId: `QA-SUB-${RUN}`, name: "QA Recruited Agent" });
    expectStatus(asked, 200, "the agent asks for a sub-agent");
    const decided = await tierAction({ action: "decideRequest", requestId: asked.body.id, approve: true, note: "QA" });
    expectStatus(decided, 200, "the admin approves");
    const recruit = need(decided.body.memberId as string | null, "the new agent");
    const { context, page } = await pageAs(browser, "admin");
    try {
      await page.goto(`/admin/dealers/commission/tiered?dealerId=${net.dealerId}`);
      await expect(page.getByText(/Promotion: 0\/50 shops · 0\/3 ready agents/).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Promote anyway (override)" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Promote to team lead" })).toHaveCount(0);
    } finally {
      await context.close();
    }
    const refused = await tierAction({ action: "promote", memberId: net.agent.id, reason: "QA promotion" });
    expectStatus(refused, 409, "promotion below the bar without an override");
    expect(refused.body.error.message).toBe("Not eligible yet: 0 of 50 activated shops, 0 of 3 ready agents. An admin can promote anyway with an override and a reason.");
    const noReason = await tierAction({ action: "promote", memberId: net.agent.id, reason: "", override: true });
    expectStatus(noReason, 422, "an override without a reason");
    const promoted = await tierAction({ action: "promote", memberId: net.agent.id, reason: "QA: promote anyway", override: true });
    expectStatus(promoted, 200, "promote with an override and a reason");
    expect(promoted.body).toMatchObject({ role: "TEAM_LEAD", movedAgents: 1 });
    const [me] = await db()<{ parent_id: string | null; team_role: string }[]>`select parent_id, team_role from dealer_salespeople where id = ${net.agent.id}`;
    expect(me, "now a team lead under the main dealer").toEqual({ parent_id: null, team_role: "TEAM_LEAD" });
    const [sub] = await db()<{ parent_id: string | null }[]>`select parent_id from dealer_salespeople where id = ${recruit}`;
    expect(sub.parent_id, "the agent he brought in moves with him").toBe(net.agent.id);
    return "progress 0/50 · 0/3, only the override offered; promoted with 1 agent";
  });
}, { ...local, partial: "the eligible path (50 activated shops and 3 ready agents → 'Promote to team lead') is proven by tests/integration/dealer-tiered-commission.test.ts" });

/* ------------------------------------------------- TS-DLR-15: the team */

qa("TC-TIER-021", "an agent cannot add a member himself; his sub-agent request is approved (new agent recruited by him) or declined (nothing changes); both logged", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t021", { linkAccounts: true });
    const agentCtx = await ctxFor(need(net.agent.account, "the agent's account"));
    const direct = await call(agentCtx, "POST", "/api/dealer/team", { action: "addMember", employeeId: `QA-X-${RUN}`, name: "QA Direct", role: "AGENT" });
    expectStatus(direct, 403, "an agent adds a member himself");
    expect(direct.body.error.message).toBe("Only the main dealer adds members; a team member asks for a sub-agent instead.");
    const one = await call(agentCtx, "POST", "/api/dealer/team", { action: "requestSubAgent", employeeId: `QA-S1-${RUN}`, name: "QA Sub One" });
    const two = await call(agentCtx, "POST", "/api/dealer/team", { action: "requestSubAgent", employeeId: `QA-S2-${RUN}`, name: "QA Sub Two" });
    expectStatus(one, 200, "request 1");
    expectStatus(two, 200, "request 2");
    const yes = await tierAction({ action: "decideRequest", requestId: one.body.id, approve: true, note: null });
    expectStatus(yes, 200, "approve");
    const no = await tierAction({ action: "decideRequest", requestId: two.body.id, approve: false, note: "QA: not now" });
    expectStatus(no, 200, "decline");
    expect(no.body.memberId).toBeNull();
    const [added] = await db()<{ team_role: string; recruited_by_id: string; parent_id: string }[]>`select team_role, recruited_by_id, parent_id from dealer_salespeople where id = ${yes.body.memberId}`;
    expect(added, "approved: an agent in the requester's team, recruited by him").toEqual({ team_role: "AGENT", recruited_by_id: net.agent.id, parent_id: net.lead.id });
    const declined = await db()`select 1 from dealer_salespeople where dealer_id = ${net.dealerId} and lower(employee_id) = lower(${`QA-S2-${RUN}`})`;
    expect(declined.length, "declined: no member").toBe(0);
    const logged = await db()`select 1 from audit_logs where action = 'dealer.team_request' and entity_id in ${db()([one.body.id, two.body.id])}`;
    expect(logged.length, "both decisions logged").toBeGreaterThanOrEqual(2);
    return "agent's own add refused (403); request 1 approved (recruited by him), request 2 declined; logged";
  });
}, local);

qa("TC-TIER-022", "moving an agent needs a reason; moved, his next shop pays the new lead; a lead who still has agents cannot become an agent", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t022");
    const lead2 = await addMember(net, "TEAM_LEAD", null);
    const bare = await tierAction({ action: "placeMember", memberId: net.agent.id, role: "AGENT", parentId: lead2.id, reason: "" });
    expectStatus(bare, 422, "move without a reason");
    expect(bare.body.error.message).toBe("Give the reason for the change (it is kept in the audit log).");
    const moved = await tierAction({ action: "placeMember", memberId: net.agent.id, role: "AGENT", parentId: lead2.id, reason: "QA: territory change" });
    expectStatus(moved, 200, "move with a reason");
    expect(moved.body.parentId).toBe(lead2.id);
    const shop = await activatedShop(net.dealerId, net.agent.id);
    expect((await accruals(shop.shopId)).find((r) => r[0] === "OVERRIDE_LEAD")?.[1], "the new lead earns the override").toBe(lead2.id);
    const demote = await tierAction({ action: "placeMember", memberId: lead2.id, role: "AGENT", parentId: net.lead.id, reason: "QA: try to demote" });
    expectStatus(demote, 409, "a lead with agents made an agent");
    expect(demote.body.error.message).toBe("This team lead still has 1 agent(s); move them to another lead first.");
    const history = await db()`select 1 from dealer_team_mapping_history where member_id = ${net.agent.id}`;
    expect(history.length, "the move is in the mapping history").toBeGreaterThan(0);
    return "no reason refused; moved and logged; next shop's override to the new lead; demotion refused";
  });
}, local);

qa("TC-TIER-023", "a STANDARD dealer earns on the standard model; moved to TIERED (with a reason) the next shop earns the TIERED share; earlier entries never recalculated", async () => {
  return tiered(async () => {
    const net = await dealerOnly("t023", { standard: true });
    const first = await activatedShop(net.dealerId, null);
    const standard = await ledgerOf(first.shopId);
    need(standard.length ? standard : null, "a standard commission entry (Dealers → Commission settings: the standard model)");
    expect(standard.some((r) => ["DIRECT_1", "OVERRIDE_LEAD", "OVERRIDE_MAIN"].includes(r.entry_type)), "no TIERED entries on the standard model").toBe(false);
    const bare = await tierAction({ action: "setModel", dealerId: net.dealerId, model: "TIERED", reason: "" });
    expectStatus(bare, 422, "move to TIERED without a reason");
    expectStatus(await tierAction({ action: "setModel", dealerId: net.dealerId, model: "TIERED", reason: "QA: move to TIERED" }), 200, "move with a reason");
    const second = await activatedShop(net.dealerId, null);
    expect(await accruals(second.shopId), "after the move: TIERED (main dealer's own shop: 20%)").toEqual([["DIRECT_1", null, 99_980]]);
    const again = await ledgerOf(first.shopId);
    expect(again.map((r) => [r.id, r.amount_paise, r.entry_type]), "earlier entries unchanged").toEqual(standard.map((r) => [r.id, r.amount_paise, r.entry_type]));
    const audit = await db()`select 1 from audit_logs where entity_id = ${net.dealerId} and new_value::text like '%TIERED%'`;
    expect(audit.length, "the move is logged").toBeGreaterThan(0);
    return `standard ${standard.map((r) => `${r.entry_type} ₹${r.amount_paise / 100}`).join(", ")}; then TIERED ₹999.80; earlier untouched`;
  });
}, local);

/* ------------------------------------- TS-DLR-16: dashboards and reports */

qa("TC-TIER-024", "/dealer as the agent: this month's earnings, all-time earned and paid, target progress; a new shop's ₹999.80 appears without a reload", async ({ browser }) => {
  return tiered(async () => {
    const net = await tieredNetwork("t024", { linkAccounts: true });
    const { context, page } = await pageFor(browser, need(net.agent.account, "the agent's account"));
    try {
      await page.goto("/dealer");
      const card = page.getByTestId("team-performance");
      await expect(card.getByRole("heading", { name: "Your earnings and team performance" })).toBeVisible();
      const mine = card.getByTestId("my-earnings");
      await expect(mine).toContainText("Earned this month");
      await expect(mine).toContainText("Earned all time");
      await expect(mine).toContainText("Paid out");
      await expect(card.getByTestId("target-progress")).toBeVisible();
      await expect(mine).not.toContainText("₹999.8");
      await activatedShop(net.dealerId, net.agent.id);
      await expect(mine, "refreshes by itself (every 30 s)").toContainText("₹999.8", { timeout: 60_000 });
    } finally {
      await context.close();
    }
    return "card shows ₹999.8 for the new shop without a reload";
  });
}, { ...local, mobile: true });

qa("TC-TIER-025", "team performance: the main dealer sees lead and agent rows; This month / Yesterday / Last week; the CSV download matches; the admin sees the same per dealer", async ({ browser }) => {
  return tiered(async () => {
    const net = await tieredNetwork("t025");
    await activatedShop(net.dealerId, net.agent.id);
    const { context, page } = await pageFor(browser, net.owner);
    try {
      await page.goto("/dealer");
      const table = page.getByTestId("team-performance-table");
      await expect(table).toContainText(net.lead.name);
      await expect(table).toContainText(net.agent.name);
      for (const label of ["Yesterday", "Last week", "This month"]) {
        await page.getByRole("button", { name: label }).click();
        await expect(page.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
      }
      const href = need(await page.getByRole("link", { name: "Download (Excel / CSV)" }).getAttribute("href"), "the download link");
      const csv = await call(await ctxFor(net.owner), "GET", href);
      expectStatus(csv, 200, "team performance CSV");
      expect(csv.headers["content-type"]).toContain("text/csv");
      expect(csv.text).toContain(net.agent.name);
      expect(csv.text).toContain(net.lead.name);
    } finally {
      await context.close();
    }
    const admin = await pageAs(browser, "admin");
    try {
      await admin.page.goto(`/admin/dealers/commission/tiered?dealerId=${net.dealerId}`);
      const card = admin.page.getByTestId("team-performance");
      await expect(card.getByRole("heading", { name: "Team performance" })).toBeVisible();
      await expect(card.getByTestId("team-performance-table")).toContainText(net.agent.name);
    } finally {
      await admin.context.close();
    }
    return "rows for lead and agent; 3 periods; CSV with both; admin's card the same";
  });
}, local);

qa("TC-TIER-026", "lead A sees only his team; the admin's per-dealer API refuses him; an agent sees only his own row", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t026", { linkAccounts: true });
    const leadB = await addMember(net, "TEAM_LEAD", null);
    const agentB = await addMember(net, "AGENT", leadB.id);
    const leadCtx = await ctxFor(need(net.lead.account, "lead A's account"));
    const mine = await call(leadCtx, "GET", "/api/dealer/team?view=performance");
    expectStatus(mine, 200, "lead A's team performance");
    const names = (mine.body.report.rows as { name: string }[]).map((r) => r.name);
    expect(names, "lead A and his agent").toEqual(expect.arrayContaining([net.lead.name, net.agent.name]));
    expect(names.filter((n) => n === leadB.name || n === agentB.name), "nothing of lead B's team").toEqual([]);
    const other = await call(leadCtx, "GET", `/api/admin/dealer-tiers?dealerId=${net.dealerId}&view=performance`);
    expectStatus(other, 403, "lead A asks for the whole network");
    const agentCtx = await ctxFor(need(net.agent.account, "the agent's account"));
    const own = await call(agentCtx, "GET", "/api/dealer/team?view=performance");
    expect((own.body.report.rows as { name: string }[]).map((r) => r.name), "the agent: his own figures only").toEqual([net.agent.name]);
    const mapping = await call(leadCtx, "GET", "/api/dealer/team?view=mapping");
    expectStatus(mapping, 403, "the whole team mapping is the main dealer's");
    return `lead A sees ${names.length} rows (none of lead B's); admin API 403; agent 1 row`;
  });
}, local);

/* --------------------------------------- TS-DLR-17: holds, payouts, reversal */

qa("TC-TIER-029", "earnings wait on hold until the agreement is accepted; 'Paid' is refused without a verified bank; then paid", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t029");
    const fresh = await addMember(net, "AGENT", net.lead.id, { pan: true, bank: false, agreement: false }, true);
    const shop = await activatedShop(net.dealerId, fresh.id);
    const direct = need((await ledgerOf(shop.shopId)).find((r) => r.entry_type === "DIRECT_1"), "the direct entry");
    expect(direct.status, "on hold before acceptance").toBe("ON_HOLD");
    expect(direct.note ?? "").toContain(AGREEMENT_HOLD_NOTE);
    const accept = await call(await ctxFor(need(fresh.account, "the agent's account")), "POST", "/api/dealer/team", { action: "acceptAgreement", version: AGENT_AGREEMENT_VERSION });
    expectStatus(accept, 200, "the agent accepts the agreement");
    const [m] = await db()<{ v: string; at: Date | null }[]>`select agreement_version as v, agreement_accepted_at as at from dealer_salespeople where id = ${fresh.id}`;
    expect(m.v, "versioned").toBe(AGENT_AGREEMENT_VERSION);
    expect(m.at, "time-stamped").toBeTruthy();
    const released = need((await ledgerOf(shop.shopId)).find((r) => r.id === direct.id), "the entry");
    expect(released.status, "released on acceptance").toBe("EARNED");
    expectStatus(await commissionAction({ action: "approve", ids: [direct.id] }), 200, "approve the entry");
    const batch = await commissionAction({ action: "createPayout", dealerId: net.dealerId, memberId: fresh.id, note: "QA payout" });
    expectStatus(batch, 200, "draft the agent's payout");
    const batchId = batch.body.batch.id as string;
    const refused = await commissionAction({ action: "payoutPaid", batchId, reference: "QA-UTR-1" });
    expectStatus(refused, 409, "Paid without a verified bank");
    expect(refused.body.error.message).toBe(`${fresh.name}'s bank account is not verified. A payout is paid only with PAN and a verified bank account on file.`);
    await db()`update dealer_salespeople set bank_status = 'VERIFIED', bank_account_last4 = '4321', bank_verified_at = now() where id = ${fresh.id}`;
    const paid = await commissionAction({ action: "payoutPaid", batchId, reference: "QA-UTR-2" });
    if (paid.status === 409 && paid.body?.error?.details?.reason === "TDS_UNCONFIRMED") need(null, "a CA-confirmed TDS row for the payout (Admin → TDS on commission)");
    expectStatus(paid, 200, "Paid once PAN and a verified bank are on file");
    expect(paid.body.batch.status).toBe("PAID");
    return "ON_HOLD → EARNED on acceptance; Paid refused (bank not verified) → PAID";
  });
}, { ...local, partial: "the month close's 'held: PAN, verified bank account, agent agreement' carry-over is proven by tests/integration/dealer-tiered-commission.test.ts and dealer-payouts-pan-tds.test.ts" });

qa("TC-TIER-030", "a refund of the shop's registration fee takes back the direct, lead and main-dealer entries", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t030");
    const shop = await activatedShop(net.dealerId, net.agent.id);
    expect((await accruals(shop.shopId)).length).toBe(3);
    const refund = await call(await as("admin"), "POST", "/api/shop-payments", { shopId: shop.shopId, paymentType: "REFUND", amountPaise: 589_882, method: "CASH", note: "QA: fee refunded" });
    expectStatus(refund, 201, "record the refund");
    const rows = (await ledgerOf(shop.shopId)).filter((r) => r.kind === "ACCRUAL");
    expect(rows.map((r) => [r.entry_type, r.status]), "every level reversed").toEqual([
      ["DIRECT_1", "REVERSED"],
      ["OVERRIDE_LEAD", "REVERSED"],
      ["OVERRIDE_MAIN", "REVERSED"],
    ]);
    return "refund → DIRECT_1, OVERRIDE_LEAD, OVERRIDE_MAIN reversed";
  });
}, { ...local, partial: "the development entry and an amount already paid taken from the next payout are proven by tests/integration/dealer-tiered-commission.test.ts; 'Reverse' on one ledger entry reverses that entry only (possible defect, report-E)" });

qa("TC-TIER-031", "flag off: /dealer and the TIERED screen answer 404; on: a customer is sent home, an operator reads it without change buttons", async ({ browser }) => {
  const guest = await anonymous();
  try {
    await withFlags({ dealer_programme_enabled: false }, async () => {
      for (const path of ["/dealer", "/admin/dealers/commission/tiered"]) {
        const res = await call(guest, "GET", path);
        expectStatus(res, 404, `${path} with the flag off`);
      }
    });
  } finally {
    await guest.dispose();
  }
  return tiered(async () => {
    const customer = await freshAccount("dlr-cust");
    const { context, page } = await pageFor(browser, customer);
    try {
      await page.goto("/admin/dealers/commission/tiered");
      await page.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });
    } finally {
      await context.close();
    }
    const ops = await pageAs(browser, "ops");
    try {
      await ops.page.goto("/admin/dealers/commission/tiered");
      await expect(ops.page.getByRole("heading", { name: "TIERED commission" })).toBeVisible();
      await expect(ops.page.getByText("Read only: only an admin changes the TIERED model, rates, teams or payouts.")).toBeVisible();
    } finally {
      await ops.context.close();
    }
    const refused = await call(await as("ops"), "POST", "/api/admin/dealer-tiers", { action: "setModel", dealerId: "00000000-0000-4000-8000-000000000001", model: "TIERED", reason: "QA operator" });
    expectStatus(refused, 403, "an operator changes the model");
    return "flag off 404; customer → /; operator read-only; operator write 403";
  });
}, local);

qa("TC-TIER-032", "changing rule dealerTieredCommission without a reason is refused; a change is logged with the old and new values", async () => {
  return withFlags({ dealer_programme_enabled: true }, async () => {
    const before = await call(await as("admin"), "GET", "/api/admin/settings");
    const row = need((before.body.rules as { key: string; value: Record<string, unknown>; overridden: boolean }[]).find((r) => r.key === "dealerTieredCommission"), "rule dealerTieredCommission");
    const since = new Date(Date.now() - 1000);
    const put = await call(await as("admin"), "PUT", "/api/admin/settings", { key: "dealerTieredCommission", value: { ...row.value, renewalYears: Number(row.value.renewalYears ?? 3) + 1 } });
    try {
      if (put.status === 200) {
        const [log] = await db()<{ p: { renewalYears: number }; n: { renewalYears: number } }[]>`
          select previous_value as p, new_value as n from audit_logs where action = 'setting.changed' and entity_id = 'dealerTieredCommission' and created_at >= ${since} order by created_at desc limit 1`;
        expect(log, "the change is logged").toBeTruthy();
        expect(log.n.renewalYears - log.p.renewalYears, "with the old and new values").toBe(1);
      }
      expect(put.status, `a change without a reason must be refused — ${put.status}`).not.toBe(200);
      return `refused ${put.status}`;
    } finally {
      if (put.status === 200) {
        const restore = row.overridden
          ? await call(await as("admin"), "PUT", "/api/admin/settings", { key: "dealerTieredCommission", value: row.value })
          : await call(await as("admin"), "DELETE", "/api/admin/settings?key=dealerTieredCommission");
        expectStatus(restore, 200, "restore the rule");
      }
    }
  });
}, local);

/* ------------------------------------- TS-DLR-13: referral code requests */

qa("TC-SREF-008", "Request a referral code (signed in, no shop yet): the dialog's fields, 'Request received' with the RCR- reference and the masked mobile; listed in Admin → Referral requests", async ({ browser }) => {
  const person = await freshAccount("sref-req");
  const mobile = uniqueMobile();
  const { context, page } = await pageFor(browser, person);
  await context.setExtraHTTPHeaders(visitorHeaders().headers);
  let reference = "";
  try {
    await page.goto("/shop/register");
    await page.getByTestId("request-referral-code").click();
    const dialog = page.getByRole("dialog", { name: "Request a referral code" });
    await dialog.getByLabel("Your name").fill("QA Prospect Owner");
    await dialog.getByLabel("Mobile number").fill(mobile);
    const type = dialog.getByLabel("Type of shop");
    const first = need(await type.locator("option:not([disabled])").first().getAttribute("value"), "a shop type");
    await type.selectOption(first);
    await dialog.getByLabel("Area").fill("Kothrud");
    await dialog.getByLabel("City").fill("Pune");
    await dialog.getByLabel("PIN code").fill("411038");
    await dialog.getByRole("button", { name: "Send request" }).click();
    const done = dialog.getByTestId("referral-request-done");
    const limited = dialog.getByRole("alert").filter({ hasText: "Too many requests. Please wait a moment and try again." });
    await expect(done.or(limited).first()).toBeVisible();
    if (await limited.isVisible()) blocked("this address's limit on referral requests was used by an earlier check within the window (per IP)");
    await expect(done).toContainText("Request received");
    const text = await done.innerText();
    reference = need(/RCR-[0-9A-F]{8}/.exec(text)?.[0], "the request reference");
    expect(text).toContain(`Thank you! Your request ${reference} has reached our referrals team. We will call or message you on +91 ******${mobile.slice(-4)} with your referral code, usually within one working day.`);
  } finally {
    await context.close();
  }
  const admin = await pageAs(browser, "admin");
  try {
    await admin.page.goto("/admin/referral-requests");
    await expect(admin.page.getByText(reference).first()).toBeVisible();
  } finally {
    await admin.context.close();
  }
  return `${reference} for ${mobile.slice(0, 2)}******${mobile.slice(-2)}; listed in /admin/referral-requests`;
}, local);

qa("TC-SREF-009", "the same mobile again within 24 h: 429 with the earlier reference; a 5-digit PIN is refused under the field", async ({ browser }) => {
  const mobile = uniqueMobile();
  const body = { name: "QA Repeat Owner", mobile, shopType: "STATIONERY_STORE", area: "Kothrud", city: "Pune", pincode: "411038" };
  const guest = await anonymous();
  const visitor = visitorHeaders();
  let reference = "";
  try {
    const first = await call(guest, "POST", "/api/referral-requests", body, visitor);
    expectStatus(first, 201, "the first request");
    reference = first.body.reference;
    const again = await call(guest, "POST", "/api/referral-requests", body, visitor);
    expectStatus(again, 429, "the same mobile again");
    expect(again.body.error.message).toMatch(new RegExp(`^We already have a request from this mobile number \\(${reference}, .+ IST\\)\\. Our team will contact you — there is no need to ask again\\.$`));
    expect(again.body.error.details?.reference).toBe(reference);
  } finally {
    await guest.dispose();
  }
  const person = await freshAccount("sref-pin");
  const { context, page } = await pageFor(browser, person);
  await context.setExtraHTTPHeaders(visitorHeaders().headers);
  try {
    await page.goto("/shop/register");
    await page.getByTestId("request-referral-code").click();
    const dialog = page.getByRole("dialog", { name: "Request a referral code" });
    await dialog.getByLabel("PIN code").fill("41100");
    await dialog.getByRole("button", { name: "Send request" }).click();
    await expect(dialog.getByText("A PIN code is 6 digits and does not start with 0.")).toBeVisible();
    await expect(dialog.getByTestId("referral-request-done")).toHaveCount(0);
  } finally {
    await context.close();
  }
  return `repeat → 429 (${reference}); PIN 41100 refused under the field`;
}, local);

qa("TC-SREF-010", "/r/<SHOP code> → 307 to /shop/register?ref=<code>, and the wizard shows the code with '✓ Applied'", async ({ browser }) => {
  return withRules({ shopReferrals: { enabled: true } }, async () => {
    const card = await call(await as("shop"), "GET", "/shop/manage/registration", undefined, { maxRedirects: 3 });
    const code = need(/SHOP[A-HJ-NP-Z2-9]{5}/.exec(card.text)?.[0], "shop A's SHOP code on My Shop → Registration and fee");
    const guest = await anonymous();
    try {
      const res = await call(guest, "GET", `/r/${code}`);
      expectStatus(res, 307, "the shop referral link");
      expect(res.location).toBe(`/shop/register?ref=${code}`);
    } finally {
      await guest.dispose();
    }
    const person = await freshAccount("sref-link");
    const { context, page } = await pageFor(browser, person);
    try {
      await page.goto(`/r/${code}`);
      await page.waitForURL((u) => u.pathname === "/shop/register" && u.searchParams.get("ref") === code);
      await expect(page.getByTestId("wizard-referral-code")).toHaveValue(code);
      await expect(page.getByText(/✓ Applied/)).toBeVisible();
    } finally {
      await context.close();
    }
    return `${code}: 307 → /shop/register?ref=${code}; ✓ Applied`;
  });
}, { ...local, mobile: true });

qa("TC-SREF-012", "promotional credit cannot leave the wallet: a debit beyond the non-promotional balance is refused", async () => {
  const made = await approvedShopOfNewOwner("sref-promo");
  // A shop wallet's balance moves only through its ledger (drizzle/0059 guard): credit ₹200 there, all of it promotional.
  await db()`insert into shop_wallets (shop_id) values (${made.shop.id}) on conflict (shop_id) do nothing`;
  const [wallet] = await db()<{ id: string; balance: number }[]>`select id, balance_paise::int as balance from shop_wallets where shop_id = ${made.shop.id}`;
  await db()`
    insert into shop_wallet_transactions (wallet_id, shop_id, type, direction, amount_paise, balance_before_paise, balance_after_paise, reason, idempotency_key)
    values (${wallet.id}, ${made.shop.id}, 'MANUAL_CREDIT', 'CREDIT', 20000, ${wallet.balance}, ${wallet.balance + 20000}, 'QA: shop-refers-shop reward (promotional credit)', ${`qa-promo-credit-${RUN}`})`;
  await db()`update shop_wallets set promo_balance_paise = ${wallet.balance + 20000} where id = ${wallet.id}`;
  const res = await call(await as("admin"), "POST", `/api/shops/${made.shop.id}/wallet/adjust`, { direction: "DEBIT", amountPaise: 5_000, reason: "QA: pay the promotional credit out", requestId: `qa-promo-${RUN}` });
  expectStatus(res, 402, "debit of promotional credit");
  expect(res.body.error.message).toMatch(/^The shop wallet holds ₹[\d,.]+, of which ₹[\d,.]+ is promotional credit that only pays GoKesari commission and delivery charges\.$/);
  return "debit refused: promotional credit pays commission and delivery charges only";
}, { ...local, partial: "commission / delivery charges taken from the promotional credit first is proven by tests/integration/shop-referrals.test.ts; a shop wallet has no bank withdrawal" });

