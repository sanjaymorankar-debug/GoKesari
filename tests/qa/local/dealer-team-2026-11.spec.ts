/**
 * Team leads add agents (DT-28) and the main dealer promotes an agent (DT-29) —
 * TIERED dealer networks after PR #420 (owner, 20-Nov-2026; scenario TS-DLR-18),
 * on the local server.
 *
 * Local tier: dealer_programme_enabled and rule dealerTieredCommission are
 * switched on for each check and put back. Each check builds its own network
 * (lib/dealer-commission-helpers.ts tieredNetwork: main dealer M > team lead L1
 * > agent A1, every one with his own account and the agent agreement). The
 * promotion counts (50 activated shops, 3 ready agents) are arranged as
 * lib/dealer-team-helpers.ts describes; everything under test runs through the
 * dealer page or the API the page calls.
 */
import { as, pageAs } from "../lib/actors";
import { withFlags } from "../lib/billing-v2-helpers";
import { accruals, activatedShop, addMember, AGENT_AGREEMENT_VERSION, ledgerOf, SLAB_4999, tieredNetwork, tierAction } from "../lib/dealer-commission-helpers";
import { arrangeActivatedShops, codeOf, historyOf, ledgerCount, memberByEmployeeId, memberCtx, memberRow, notesOf, recruit, teamPost } from "../lib/dealer-team-helpers";
import { closeMonth, freeMonth, midMonth } from "../lib/dealer-territory-helpers";
import { db } from "../lib/db";
import { withRules } from "../lib/finance-helpers";
import { call, expectStatus, RUN } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { ctxFor, freshAccount, pageFor } from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 300_000 };

/** dealer_programme_enabled on, the rating bonus off, rule dealerTieredCommission on (plus `rule`). */
function tiered<T>(body: () => Promise<T>, rule: Record<string, unknown> = {}): Promise<T> {
  return withFlags({ dealer_programme_enabled: true, dealer_rating_bonus_enabled: false }, () => withRules({ dealerTieredCommission: { enabled: true, ...rule } }, body));
}

let n = 0;
const id = (tag: string) => `QA-${tag}-${RUN}-${++n}`;

/* ------------------------------------------- DT-28: a team lead adds agents */

qa("TC-TIER-033", "a team lead adds an agent on /dealer: added at once under him with his own code, no request or approval; the main dealer is told and the history shows it; nothing is paid for recruiting", async ({ browser }) => {
  return tiered(async () => {
    const net = await tieredNetwork("t033", { linkAccounts: true });
    const lead = need(net.lead.account, "L1's account");
    const ledgerBefore = await ledgerCount(net.dealerId);
    const employeeId = id("L1A");
    const name = `QA Lead Added ${RUN}`;
    const { context, page } = await pageFor(browser, lead);
    try {
      await page.goto("/dealer");
      const form = page.getByRole("region", { name: "Add an agent to your team" });
      await expect(form.getByRole("heading", { name: "Add an agent to your team" })).toBeVisible();
      await expect(form).toContainText("The agent joins your team at once with their own code, and your main dealer is told. You earn nothing for adding someone");
      await form.getByLabel("Their ID").fill(employeeId);
      await form.getByLabel("Name").fill(name);
      await form.getByLabel("Mobile (optional)").fill("9876501234");
      await form.getByRole("button", { name: "Add to my team" }).click();
      await expect(page.getByText(`${name} joined your team with their own code.`)).toBeVisible();
      // L1's team list (his own branch of the tree) shows the new agent under him.
      const tree = page.getByTestId("team-tree");
      await expect(tree.getByRole("listitem").filter({ hasText: name }).filter({ hasNotText: net.lead.name })).toContainText(`${name} (${employeeId} · +91••••••1234) · Agent · Level 3 · 0 shops`);
    } finally {
      await context.close();
    }
    const added = need(await memberByEmployeeId(net.dealerId, employeeId), "the new agent");
    expect(added, "an active agent at level 3 under L1, added by the dealer side").toMatchObject({ team_role: "AGENT", depth: 3, parent_id: net.lead.id, status: "ACTIVE", source: "DEALER" });
    const code = need(await codeOf(added.id), "the new agent's own referral code");
    const requests = await db()`select 1 from dealer_team_requests where dealer_id = ${net.dealerId} and lower(employee_id) = lower(${employeeId})`;
    expect(requests.length, "no request, no admin approval").toBe(0);
    // The main dealer is told, and his mapping history shows the change.
    const ownerCtx = await ctxFor(net.owner);
    const note = (await notesOf(ownerCtx)).find((x) => x.body === `${net.lead.name} (team lead) added ${name} (${employeeId}) to his team as an agent.`);
    expect(note, "M's notice").toBeTruthy();
    expect(note!.title).toBe("Your dealer team changed");
    const history = await historyOf(ownerCtx);
    expect(history.find((h) => h.memberId === added.id), "the mapping history has the new agent").toMatchObject({ role: "AGENT", level: 3, leadName: net.lead.name, reason: "added to the team" });
    const { context: mc, page: mp } = await pageFor(browser, net.owner);
    try {
      await mp.goto("/dealer");
      const leadRow = mp.getByTestId("team-tree").getByRole("listitem").filter({ hasText: net.lead.name }).first();
      await expect(leadRow, "M sees the agent in L1's team").toContainText(name);
    } finally {
      await mc.close();
    }
    expect(await ledgerCount(net.dealerId), "no commission entry for recruiting").toBe(ledgerBefore);
    return `${employeeId} added under L1 at once (code ${code.slice(0, 4)}…); M told "${note!.body}"; history row; ledger unchanged (${ledgerBefore})`;
  });
}, local);

qa("TC-TIER-034", "a team lead adds agents only, and only under himself: a team lead is refused (403); parentId = L2 is ignored (placed under L1); never a 4th level", async ({ browser }) => {
  return tiered(async () => {
    const net = await tieredNetwork("t034", { linkAccounts: true });
    const lead2 = await addMember(net, "TEAM_LEAD", null);
    const l1 = await memberCtx(net.lead);
    const asLead = await teamPost(l1, { action: "addMember", role: "TEAM_LEAD", employeeId: id("L1L"), name: "QA Lead By Lead" });
    expectStatus(asLead, 403, "a team lead adds a team lead");
    expect(asLead.body.error.message).toBe("A team lead adds agents only; the main dealer adds team leads.");
    const employeeId = id("L1X");
    const placed = await teamPost(l1, { action: "addMember", role: "AGENT", employeeId, name: "QA Agent For L2", parentId: lead2.id });
    expectStatus(placed, 200, "L1 adds an agent naming L2 as the parent");
    const row = await memberRow(placed.body.member.id);
    expect(row, "placed under L1 (parentId ignored), level 3").toMatchObject({ parent_id: net.lead.id, depth: 3, team_role: "AGENT" });
    const underL2 = await db()`select 1 from dealer_salespeople where parent_id = ${lead2.id}`;
    expect(underL2.length, "L2's team stays empty").toBe(0);
    const deeper = await db()`select 1 from dealer_salespeople where dealer_id = ${net.dealerId} and depth > 3`;
    expect(deeper.length, "never a 4th level").toBe(0);
    // The lead's form has no role or "reports to" choice.
    const { context, page } = await pageFor(browser, need(net.lead.account, "L1's account"));
    try {
      await page.goto("/dealer");
      const form = page.getByRole("region", { name: "Add an agent to your team" });
      await expect(form.getByLabel("Their ID")).toBeVisible();
      await expect(form.getByLabel("Role")).toHaveCount(0);
      await expect(form.getByLabel("Reports to")).toHaveCount(0);
    } finally {
      await context.close();
    }
    return "TEAM_LEAD by a lead → 403; parentId L2 ignored → under L1 at level 3; L2 empty; the form offers no role or parent";
  });
}, local);

qa("TC-TIER-035", "an agent cannot add anyone: no 'Add an agent' form, the API refuses (403); he asks for a sub-agent and only an admin decides; leads add directly and no longer appear there", async ({ browser }) => {
  return tiered(async () => {
    const net = await tieredNetwork("t035", { linkAccounts: true });
    const a1 = await memberCtx(net.agent);
    const refused = await teamPost(a1, { action: "addMember", role: "AGENT", employeeId: id("A1X"), name: "QA By Agent" });
    expectStatus(refused, 403, "an agent adds an agent");
    expect(refused.body.error.message).toBe("Only a team lead adds agents; an agent asks for a sub-agent instead.");
    const subId = id("A1S");
    const { context, page } = await pageFor(browser, need(net.agent.account, "A1's account"));
    try {
      await page.goto("/dealer");
      await expect(page.getByTestId("dealer-team")).toBeVisible();
      await expect(page.getByRole("region", { name: "Add an agent to your team" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Add a team member" })).toHaveCount(0);
      const ask = page.getByRole("region", { name: "Ask for a sub-agent" });
      await ask.getByLabel("Their ID").fill(subId);
      await ask.getByLabel("Name").fill("QA Sub Agent");
      await ask.getByRole("button", { name: "Send the request" }).click();
      await expect(page.getByText("Request sent. You will hear when it is decided.")).toBeVisible();
    } finally {
      await context.close();
    }
    // L1 adds an agent directly: no request of his appears.
    expectStatus(await teamPost(await memberCtx(net.lead), { action: "addMember", role: "AGENT", employeeId: id("L1D"), name: "QA Direct By Lead" }), 200, "L1 adds directly");
    const requests = await call(await as("admin"), "GET", `/api/admin/dealer-tiers?dealerId=${net.dealerId}`);
    expectStatus(requests, 200, "the admin's TIERED screen data");
    const mine = (requests.body.requests as { r: { employeeId: string; dealerId: string }; requesterRole: string }[]).filter((x) => x.r.dealerId === net.dealerId);
    expect(mine.map((x) => [x.r.employeeId, x.requesterRole]), "only the agent's request, none of the lead's").toEqual([[subId, "AGENT"]]);
    const admin = await pageAs(browser, "admin");
    try {
      await admin.page.goto(`/admin/dealers/commission/tiered?dealerId=${net.dealerId}`);
      const row = admin.page.getByTestId("team-requests").getByRole("listitem").filter({ hasText: subId });
      await expect(row).toContainText(`asked by ${net.agent.name} (Agent)`);
      await expect(row.getByRole("button", { name: "Approve" })).toBeVisible();
    } finally {
      await admin.context.close();
    }
    // Only an admin decides: the main dealer cannot.
    const requestId = (requests.body.requests as { r: { id: string; employeeId: string } }[]).find((x) => x.r.employeeId === subId)!.r.id;
    const byDealer = await call(await ctxFor(net.owner), "POST", "/api/admin/dealer-tiers", { action: "decideRequest", requestId, approve: true });
    expectStatus(byDealer, 403, "the main dealer decides a request");
    return "agent: no add form, API 403; request sent from /dealer and listed for the admin with Approve; the lead's direct add is not a request; M cannot decide (403)";
  });
}, { ...local, mobile: true });

qa("TC-TIER-036", "a team lead cannot add an agent with an ID already in the network (nothing created), nor while his place is inactive or his dealer is not approved", async ({ browser }) => {
  return tiered(async () => {
    const net = await tieredNetwork("t036", { linkAccounts: true });
    const [{ employee_id: taken }] = await db()<{ employee_id: string }[]>`select employee_id from dealer_salespeople where id = ${net.agent.id}`;
    const before = await db()<{ n: number }[]>`select count(*)::int as n from dealer_salespeople where dealer_id = ${net.dealerId}`;
    const { context, page } = await pageFor(browser, need(net.lead.account, "L1's account"));
    try {
      await page.goto("/dealer");
      const form = page.getByRole("region", { name: "Add an agent to your team" });
      await form.getByLabel("Their ID").fill(taken);
      await form.getByLabel("Name").fill("QA Duplicate");
      await form.getByRole("button", { name: "Add to my team" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Could not do that" })).toContainText("You already have an employee with this ID.");
    } finally {
      await context.close();
    }
    const after = await db()<{ n: number }[]>`select count(*)::int as n from dealer_salespeople where dealer_id = ${net.dealerId}`;
    expect(after[0].n, "nothing created").toBe(before[0].n);
    const l1 = await memberCtx(net.lead);
    const issues: string[] = [];
    // The admin sets L1 inactive (Dealers → employee → Deactivate).
    const off = await call(await as("admin"), "PATCH", `/api/admin/dealers/${net.dealerId}/salespeople/${net.lead.id}`, { status: "INACTIVE" });
    expectStatus(off, 200, "the admin deactivates L1");
    let inactive;
    try {
      inactive = await teamPost(l1, { action: "addMember", role: "AGENT", employeeId: id("L1I"), name: "QA While Inactive" });
    } finally {
      expectStatus(await call(await as("admin"), "PATCH", `/api/admin/dealers/${net.dealerId}/salespeople/${net.lead.id}`, { status: "ACTIVE" }), 200, "reactivate L1");
    }
    expectStatus(inactive, 403, "an inactive lead adds an agent");
    if (inactive.body.error.message !== "Your place in the team is not active.") issues.push(`inactive lead: "${inactive.body.error.message}" (expected "Your place in the team is not active.")`);
    // The dealer not approved (suspended), arranged on the dealer row and put back.
    await db()`update dealers set status = 'SUSPENDED' where id = ${net.dealerId}`;
    let suspended;
    try {
      suspended = await teamPost(l1, { action: "addMember", role: "AGENT", employeeId: id("L1S"), name: "QA While Suspended" });
    } finally {
      await db()`update dealers set status = 'APPROVED' where id = ${net.dealerId}`;
    }
    expectStatus(suspended, 403, "a lead of a suspended dealer adds an agent");
    if (suspended.body.error.message !== "Your dealer is not approved at present.") issues.push(`dealer not approved: "${suspended.body.error.message}"`);
    const final = await db()<{ n: number }[]>`select count(*)::int as n from dealer_salespeople where dealer_id = ${net.dealerId}`;
    expect(final[0].n, "nothing created by the refused adds").toBe(before[0].n);
    expect(issues, "refusal messages").toEqual([]);
    return "duplicate ID refused on the page; inactive lead and suspended dealer refused (403); nothing created";
  });
}, local);

qa("TC-TIER-037", "a lead-added agent's code works before his account is linked: the shop is his (20%), L1 4%, M 3%; his share waits for the agreement until an admin links him and he accepts; then released", async ({ browser }) => {
  return tiered(async () => {
    const net = await tieredNetwork("t037", { linkAccounts: true });
    const added = await teamPost(await memberCtx(net.lead), { action: "addMember", role: "AGENT", employeeId: id("A5"), name: `QA A5 ${RUN}` });
    expectStatus(added, 200, "L1 adds A5");
    const a5 = added.body.member as { id: string; name: string };
    const code = need(await codeOf(a5.id), "A5's code");
    const prospect = await ctxFor(await freshAccount("t037-prospect"));
    const check = await call(prospect, "GET", `/api/referral-codes/check?code=${code}`);
    expect(check.body, "A5's code is accepted before he has an account").toMatchObject({ valid: true });
    const shop = await activatedShop(net.dealerId, a5.id, SLAB_4999, { referralCode: code });
    expect(await accruals(shop.shopId), "20 / 4 / 3 % of ₹4,999").toEqual([
      ["DIRECT_1", a5.id, 99_980],
      ["OVERRIDE_LEAD", net.lead.id, 19_996],
      ["OVERRIDE_MAIN", null, 14_997],
    ]);
    const direct = need((await ledgerOf(shop.shopId)).find((r) => r.entry_type === "DIRECT_1"), "A5's entry");
    expect(direct.status, "waits: agreement not accepted").toBe("ON_HOLD");
    expect(direct.note ?? "").toContain("the agent agreement is not accepted yet");
    // Linking stays an admin action.
    const account = await freshAccount("t037-a5");
    const byDealer = await call(await ctxFor(net.owner), "POST", "/api/admin/dealer-tiers", { action: "linkAccount", memberId: a5.id, email: account.email });
    expectStatus(byDealer, 403, "the main dealer links an account");
    expectStatus(await tierAction({ action: "linkAccount", memberId: a5.id, email: account.email }), 200, "the admin links A5's account");
    const { context, page } = await pageFor(browser, account);
    try {
      await page.goto("/dealer");
      await expect(page.getByTestId("agent-agreement")).toBeVisible();
      await page.getByRole("button", { name: "I accept the agent agreement" }).click();
      await expect(page.getByText("Agreement accepted. Commission on hold has been released.")).toBeVisible();
    } finally {
      await context.close();
    }
    const [m] = await db()<{ v: string | null }[]>`select agreement_version as v from dealer_salespeople where id = ${a5.id}`;
    expect(m.v).toBe(AGENT_AGREEMENT_VERSION);
    const released = need((await ledgerOf(shop.shopId)).find((r) => r.id === direct.id), "the entry");
    expect(released.status, "released for the next payout").toBe("EARNED");
    return `code ${code.slice(0, 4)}… accepted; 999.80 (ON_HOLD) / 199.96 / 149.97; dealer link 403; admin linked, A5 accepted on /dealer → EARNED`;
  });
}, { ...local, partial: "the fee is recorded as paid by Finance (cash) instead of a sandbox checkout; the registration with A5's code, the approval and the ledger are real" });

/* -------------------------------------------- DT-29: promotion by the main dealer */

interface Promo {
  dealerId: string;
  owner: { id: string; email: string };
  leadId: string;
  leadName: string;
  a1: string;
  a2: string;
  a2Name: string;
  recruits: string[];
  m2agent: string;
}

/** M > L1 > (A1 below the rule: 2 shops, 1 ready agent; A2 meeting it: 50 shops, 3 ready agents) and a second network M2 > A9. */
async function promotionNetwork(): Promise<Promo & { net: Awaited<ReturnType<typeof tieredNetwork>>; a2m: Awaited<ReturnType<typeof addMember>> }> {
  const net = await tieredNetwork("promo", { linkAccounts: true });
  const a2m = await addMember(net, "AGENT", net.lead.id, undefined, true);
  await arrangeActivatedShops(net.dealerId, net.agent.id, net.lead.id, net.owner.id, 2);
  await arrangeActivatedShops(net.dealerId, a2m.id, net.lead.id, net.owner.id, 50);
  await recruit(net.agent, net.dealerId, 1);
  const recruits = await recruit(a2m, net.dealerId, 3);
  const other = await tieredNetwork("promo2", { linkAccounts: true });
  return { net, a2m, dealerId: net.dealerId, owner: net.owner, leadId: net.lead.id, leadName: net.lead.name, a1: net.agent.id, a2: a2m.id, a2Name: a2m.name, recruits, m2agent: other.agent.id };
}

qa("TC-TIER-038", "the main dealer sees 'Promotion: x/50 shops · y/3 ready agents' under each agent; 'Promote to team lead' only for the agent who meets the rule; none for team leads or himself", async ({ browser }) => {
  return tiered(async () => {
    const p = await promotionNetwork();
    const { context, page } = await pageFor(browser, p.owner);
    try {
      await page.goto("/dealer");
      const tree = page.getByTestId("team-tree");
      const agentRow = (name: string) => tree.getByRole("listitem").filter({ hasText: name }).filter({ hasNotText: p.leadName });
      await expect(agentRow(p.net.agent.name).getByTestId("promotion-progress")).toHaveText("Promotion: 2/50 shops · 1/3 ready agents");
      await expect(agentRow(p.net.agent.name).getByRole("button", { name: "Promote to team lead" })).toHaveCount(0);
      await expect(agentRow(p.a2Name).getByTestId("promotion-progress")).toContainText("Promotion: 50/50 shops · 3/3 ready agents");
      await expect(agentRow(p.a2Name).getByRole("button", { name: "Promote to team lead" })).toBeVisible();
      await expect(tree.getByRole("button", { name: "Promote to team lead" }), "one button in the whole team").toHaveCount(1);
      // The lead's own line and the main dealer's line carry no promotion control.
      const leadLine = tree.getByRole("listitem").filter({ hasText: p.leadName }).first().locator("p").first();
      await expect(leadLine).toContainText("Team lead");
      await expect(leadLine.getByTestId("promotion-progress")).toHaveCount(0);
      await expect(tree.getByRole("listitem").first()).toContainText("Level 1 (main dealer)");
      await expect(tree.getByRole("listitem").first().getByTestId("promotion-progress")).toHaveCount(0);
    } finally {
      await context.close();
    }
    return "A1 2/50 · 1/3 without a button; A2 50/50 · 3/3 with 'Promote to team lead'; lead and main dealer lines without";
  });
}, { ...local, partial: "the agents' activated shops are arranged in the database (50 approvals would take an hour); the ready agents came through approved sub-agent requests" });

qa("TC-TIER-039", "the main dealer promotes the eligible agent on /dealer: he reports to M with the agents he brought in; history 'promoted by the main dealer on the dealer page'; the former lead's 1% development bonus for 6 months, only in months that reach the minimum", async ({ browser }) => {
  return tiered(async () => {
    const p = await promotionNetwork();
    const { context, page } = await pageFor(browser, p.owner);
    try {
      await page.goto("/dealer");
      const row = page.getByTestId("team-tree").getByRole("listitem").filter({ hasText: p.a2Name }).filter({ hasNotText: p.leadName });
      await row.getByRole("button", { name: "Promote to team lead" }).click();
      await expect(page.getByText(`${p.a2Name} is now a team lead, with the agents he brought in.`)).toBeVisible();
    } finally {
      await context.close();
    }
    expect(await memberRow(p.a2), "A2: team lead reporting to M").toMatchObject({ team_role: "TEAM_LEAD", depth: 2, parent_id: null });
    for (const r of p.recruits) expect(await memberRow(r), "his recruits move under him").toMatchObject({ team_role: "AGENT", depth: 3, parent_id: p.a2 });
    const history = await historyOf(await ctxFor(p.owner));
    expect(history.find((h) => h.memberId === p.a2 && h.role === "TEAM_LEAD")?.reason, "the history").toBe("promoted to team lead: promoted by the main dealer on the dealer page");
    expect(history.filter((h) => p.recruits.includes(h.memberId) && h.reason === `moved with ${p.a2Name} on his promotion`).length).toBe(3);
    const [dev] = await db()<{ id: string; beneficiary_member_id: string; bp: number; months: number }[]>`
      select id, beneficiary_member_id, bp, (extract(year from age(ends_at, starts_at)) * 12 + extract(month from age(ends_at, starts_at)))::int as months
      from dealer_team_developments where team_lead_member_id = ${p.a2}`;
    expect(dev, "L1's development bonus: 1% for 6 months").toMatchObject({ beneficiary_member_id: p.leadId, bp: 100, months: 6 });
    const [audit] = await db()<{ v: { eligible: boolean; override: boolean; movedAgents: string[] } }[]>`
      select new_value as v from audit_logs where action = 'dealer.team_changed' and entity_id = ${p.a2} order by created_at desc limit 1`;
    expect(audit.v, "the same promotion an admin makes, eligible, no override").toMatchObject({ eligible: true, override: false });
    // The admin's TIERED screen shows A2 as a team lead with his three agents.
    const admin = await call(await as("admin"), "GET", `/api/admin/dealer-tiers?dealerId=${p.dealerId}`);
    const lead = (admin.body.tree.members as { id: string; role: string; agents: { id: string }[] }[]).find((m) => m.id === p.a2);
    expect(lead?.role).toBe("TEAM_LEAD");
    expect(lead?.agents.map((a) => a.id).sort()).toEqual([...p.recruits].sort());
    // A month in which A2's team activates at least the minimum pays L1 1% of each fee; a month below it pays nothing.
    const [rule] = (await call(await as("admin"), "GET", "/api/admin/settings")).body.rules.filter((r: { key: string }) => r.key === "dealerTieredCommission") as { value: { developmentMinShopsPerMonth: number } }[];
    const minimum = rule.value.developmentMinShopsPerMonth;
    return withRules({ dealerTieredCommission: { developmentMinShopsPerMonth: 2 } }, async () => {
      const s1 = await activatedShop(p.dealerId, p.a2);
      const s2 = await activatedShop(p.dealerId, p.recruits[0]);
      const s3 = await activatedShop(p.dealerId, p.recruits[1]);
      const reached = await freeMonth();
      const below = await freeMonth();
      await db()`update dealer_tier_shop_plans set activated_at = ${midMonth(reached)} where shop_id in ${db()([s1.shopId, s2.shopId])}`;
      await db()`update dealer_tier_shop_plans set activated_at = ${midMonth(below)} where shop_id = ${s3.shopId}`;
      await closeMonth(reached);
      await closeMonth(below);
      const rows = await db()<{ shop_id: string; amount_paise: number; status: string; note: string }[]>`
        select shop_id, amount_paise, status, note from dealer_commission_ledger where entry_type = 'DEVELOPMENT' and payee_member_id = ${p.leadId} order by shop_id`;
      const of = (shopId: string) => need(rows.find((r) => r.shop_id === shopId), `the development entry of shop ${shopId}`);
      expect(of(s1.shopId).amount_paise, "1% of ₹4,999 in the month with 2 shops").toBe(4_999);
      expect(of(s2.shopId).amount_paise).toBe(4_999);
      expect(of(s1.shopId).note).toContain(`${reached}: the team activated 2 shops — monthly minimum 2 reached`);
      expect(of(s3.shopId), "the month with 1 shop: nothing").toMatchObject({ amount_paise: 0, status: "REVERSED" });
      expect(of(s3.shopId).note).toContain("not reached");
      return `A2 promoted from /dealer with 3 agents; history and audit as an admin's promotion; L1 1% × 6 months; ${reached} (2 shops) ₹49.99 each, ${below} (1 shop) nothing — monthly minimum lowered from ${minimum} to 2 for the check`;
    });
  });
}, { ...local, timeout: 480_000, partial: "the page has no separate confirm step (the button promotes at once); the monthly minimum is lowered from the rule's 100 to 2 shops for the check, and A2's 50 shops are arranged" });

qa("TC-TIER-040", "the main dealer cannot promote an agent below the rule (409 NOT_ELIGIBLE, 'GoKesari can promote earlier on your request.'); an admin is refused the same way without an override, and promotes with an override and a reason (logged)", async () => {
  return tiered(async () => {
    const p = await promotionNetwork();
    const byDealer = await teamPost(await ctxFor(p.owner), { action: "promote", memberId: p.a1 });
    expectStatus(byDealer, 409, "M promotes A1 below the rule");
    expect(byDealer.body.error.details?.reason).toBe("NOT_ELIGIBLE");
    expect(byDealer.body.error.message).toBe("Not eligible yet: 2 of 50 activated shops, 1 of 3 ready agents. GoKesari can promote earlier on your request.");
    const noOverride = await tierAction({ action: "promote", memberId: p.a1, reason: "QA: promote without override" });
    expectStatus(noOverride, 409, "the admin without an override");
    expect(noOverride.body.error.message).toBe("Not eligible yet: 2 of 50 activated shops, 1 of 3 ready agents. An admin can promote anyway with an override and a reason.");
    expect((await memberRow(p.a1)).team_role, "still an agent").toBe("AGENT");
    const done = await tierAction({ action: "promote", memberId: p.a1, reason: "QA: promote anyway", override: true });
    expectStatus(done, 200, "the admin with an override and a reason");
    expect(done.body).toMatchObject({ role: "TEAM_LEAD" });
    const [audit] = await db()<{ v: { override: boolean; eligible: boolean; reason: string } }[]>`
      select new_value as v from audit_logs where action = 'dealer.team_changed' and entity_id = ${p.a1} order by created_at desc limit 1`;
    expect(audit.v, "logged as an override with the reason").toMatchObject({ override: true, eligible: false, reason: "QA: promote anyway" });
    return "M → 409 NOT_ELIGIBLE (2 of 50, 1 of 3); admin without override 409; with override → TEAM_LEAD, audit override:true";
  });
}, local);

qa("TC-TIER-041", "promotion is refused for another network's agent (404 'Team member') and for a team lead or an agent calling it (403); nothing changes", async () => {
  return tiered(async () => {
    const net = await tieredNetwork("t041", { linkAccounts: true });
    const other = await tieredNetwork("t041b");
    const other404 = await teamPost(await ctxFor(net.owner), { action: "promote", memberId: other.agent.id });
    expectStatus(other404, 404, "M promotes M2's agent");
    expect(other404.body.error.message).toBe("Team member was not found.");
    const byLead = await teamPost(await memberCtx(net.lead), { action: "promote", memberId: net.agent.id });
    expectStatus(byLead, 403, "L1 promotes A1");
    expect(byLead.body.error.message).toBe("Only the main dealer promotes an agent of his network.");
    const bySelf = await teamPost(await memberCtx(net.agent), { action: "promote", memberId: net.agent.id });
    expectStatus(bySelf, 403, "A1 promotes himself");
    expect(bySelf.body.error.message).toBe("Only the main dealer promotes an agent of his network.");
    expect((await memberRow(net.agent.id)).team_role).toBe("AGENT");
    expect((await memberRow(other.agent.id)).team_role).toBe("AGENT");
    return "other network 404 'Team member was not found.'; lead and agent 403; both still agents";
  });
}, local);

qa("TC-TIER-042", "after DT-28 / DT-29: M adds a team lead and an agent from /dealer; a move needs a reason and is logged; a 4th level is refused (422); lead-added agents appear in team performance under their lead", async ({ browser }) => {
  return tiered(async () => {
    const net = await tieredNetwork("t042", { linkAccounts: true });
    const leadId = id("ML");
    const agentId = id("MA");
    const leadName = `QA M Lead ${RUN}`;
    const agentName = `QA M Agent ${RUN}`;
    const { context, page } = await pageFor(browser, net.owner);
    try {
      await page.goto("/dealer");
      const form = page.getByRole("region", { name: "Add a team member" });
      await form.getByLabel("Employee ID").fill(leadId);
      await form.getByLabel("Name").fill(leadName);
      await form.getByLabel("Role").selectOption("TEAM_LEAD");
      await form.getByRole("button", { name: "Add to my team" }).click();
      await expect(page.getByText(`${leadName} was added to your team with their own code.`)).toBeVisible();
      await form.getByLabel("Employee ID").fill(agentId);
      await form.getByLabel("Name").fill(agentName);
      await form.getByLabel("Role").selectOption("AGENT");
      await form.getByLabel("Reports to").selectOption({ label: `${leadName} (${leadId})` });
      await form.getByRole("button", { name: "Add to my team" }).click();
      await expect(page.getByText(`${agentName} was added to your team with their own code.`)).toBeVisible();
    } finally {
      await context.close();
    }
    const newLead = need(await memberByEmployeeId(net.dealerId, leadId), "the new lead");
    const newAgent = need(await memberByEmployeeId(net.dealerId, agentId), "the new agent");
    expect(newLead).toMatchObject({ team_role: "TEAM_LEAD", depth: 2, parent_id: null });
    expect(newAgent).toMatchObject({ team_role: "AGENT", depth: 3, parent_id: newLead.id });
    // The admin moves A1 to the new lead: a reason is needed and the move is logged.
    const bare = await tierAction({ action: "placeMember", memberId: net.agent.id, role: "AGENT", parentId: newLead.id, reason: "" });
    expectStatus(bare, 422, "a move without a reason");
    const moved = await tierAction({ action: "placeMember", memberId: net.agent.id, role: "AGENT", parentId: newLead.id, reason: "QA: move to the new lead" });
    expectStatus(moved, 200, "a move with a reason");
    const logged = await db()`select 1 from audit_logs where action = 'dealer.team_changed' and entity_id = ${net.agent.id} and new_value->>'reason' = 'QA: move to the new lead'`;
    expect(logged.length, "the move is logged").toBe(1);
    // A 4th level: an agent under an agent.
    const fourth = await tierAction({ action: "placeMember", memberId: newAgent.id, role: "AGENT", parentId: net.agent.id, reason: "QA: try a 4th level" });
    expectStatus(fourth, 422, "a 4th level");
    expect(fourth.body.error.message).toBe("An agent can only report to a team lead or to the main dealer — a 4th level is not allowed.");
    const byDealer = await teamPost(await ctxFor(net.owner), { action: "addMember", role: "AGENT", employeeId: id("M4"), name: "QA Fourth", parentId: net.agent.id });
    expectStatus(byDealer, 422, "M adds an agent under an agent");
    // An agent added by a lead appears in this month's team performance, under his lead.
    const byLead = await teamPost(await memberCtx(net.lead), { action: "addMember", role: "AGENT", employeeId: id("L1P"), name: `QA Lead Perf ${RUN}` });
    expectStatus(byLead, 200, "L1 adds an agent");
    const perf = await call(await ctxFor(net.owner), "GET", "/api/dealer/team?view=performance&period=MONTH");
    expectStatus(perf, 200, "team performance this month");
    const row = (perf.body.report.rows as { name: string; role: string; parentName: string | null }[]).find((r) => r.name === `QA Lead Perf ${RUN}`);
    expect(row, "the lead-added agent is listed under L1").toMatchObject({ role: "AGENT", parentName: net.lead.name });
    return "M added a lead and an agent under him on /dealer; move without reason 422, with reason logged; 4th level 422 (admin and M); lead-added agent in team performance under L1";
  });
}, { ...local, mobile: true });
