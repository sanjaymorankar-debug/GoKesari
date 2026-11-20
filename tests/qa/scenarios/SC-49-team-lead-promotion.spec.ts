/**
 * SC-49 — a team lead grows his team and the main dealer promotes an agent
 * (DT-28 / DT-29, PR #420; with DT-20 promotion and DT-23 20 / 4 / 3 %): the
 * lead adds an agent on /dealer (the main dealer is told), the agent signs a
 * shop with his own code (his share waits until an admin links his account and
 * he accepts the agreement), he reaches 50 shops and 3 ready agents, the main
 * dealer promotes him on /dealer, and a month in which his new team reaches the
 * minimum pays the former lead the development bonus.
 *
 * Local tier (lib/dealer-team-helpers.ts): 49 of his 50 shops are arranged
 * activated shops; the monthly minimum for the development bonus is lowered
 * from 100 to 2 shops for the journey; the month is an old one closed with
 * "Close <month> now".
 */
import { withFlags } from "../lib/billing-v2-helpers";
import { accruals, activatedShop, AGENT_AGREEMENT_VERSION, ledgerOf, tieredNetwork, tierAction } from "../lib/dealer-commission-helpers";
import { arrangeActivatedShops, codeOf, memberCtx, memberRow, notesOf, recruit, teamPost } from "../lib/dealer-team-helpers";
import { closeMonth, freeMonth, midMonth } from "../lib/dealer-territory-helpers";
import { db } from "../lib/db";
import { withRules } from "../lib/finance-helpers";
import { RUN } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { ctxFor, freshAccount, pageFor } from "../lib/sellers-helpers";

qa("SC-49", "team lead adds an agent (main dealer told); the agent's shop pays 20 / 4 / 3 % (his share held until linked and agreed); at 50 shops and 3 ready agents the main dealer promotes him on /dealer with his recruits; the former lead's 1% development bonus in a month that reaches the minimum", async ({ browser }) => {
  return withFlags({ dealer_programme_enabled: true, dealer_rating_bonus_enabled: false }, () =>
    withRules({ dealerTieredCommission: { enabled: true, developmentMinShopsPerMonth: 2 } }, async () => {
      const net = await tieredNetwork("sc49", { linkAccounts: true });
      // 1. The lead adds an agent; the main dealer is told.
      const name = `SC-49 Agent ${RUN}`;
      const added = await teamPost(await memberCtx(net.lead), { action: "addMember", role: "AGENT", employeeId: `SC49-${RUN}`, name });
      expect(added.status, added.text).toBe(200);
      const a5 = added.body.member.id as string;
      expect(await memberRow(a5)).toMatchObject({ team_role: "AGENT", parent_id: net.lead.id, depth: 3 });
      const told = (await notesOf(await ctxFor(net.owner))).some((x) => x.body === `${net.lead.name} (team lead) added ${name} (SC49-${RUN}) to his team as an agent.`);
      expect(told, "the main dealer is told").toBe(true);
      // 2. He signs a shop with his own code: 20 / 4 / 3 %, his share held until linked and agreed.
      const shop = await activatedShop(net.dealerId, a5, undefined, { referralCode: need(await codeOf(a5), "his code") });
      expect(await accruals(shop.shopId)).toEqual([
        ["DIRECT_1", a5, 99_980],
        ["OVERRIDE_LEAD", net.lead.id, 19_996],
        ["OVERRIDE_MAIN", null, 14_997],
      ]);
      const direct = need((await ledgerOf(shop.shopId)).find((r) => r.entry_type === "DIRECT_1"), "his entry");
      expect(direct.status).toBe("ON_HOLD");
      const account = await freshAccount("sc49-agent");
      expect((await tierAction({ action: "linkAccount", memberId: a5, email: account.email })).status).toBe(200);
      expect((await teamPost(await ctxFor(account), { action: "acceptAgreement", version: AGENT_AGREEMENT_VERSION })).status).toBe(200);
      expect(need((await ledgerOf(shop.shopId)).find((r) => r.id === direct.id), "his entry").status, "released").toBe("EARNED");
      await db()`update dealer_salespeople set pan_hash = ${`qa-pan-${a5}`}, pan_last4 = '234F', bank_status = 'VERIFIED', bank_account_last4 = '4321', bank_verified_at = now() where id = ${a5}`;
      // 3. 50 activated shops (49 arranged + his real one) and 3 ready agents he brought in.
      await arrangeActivatedShops(net.dealerId, a5, net.lead.id, net.owner.id, 49);
      const recruits = await recruit({ account, name }, net.dealerId, 3);
      // 4. The main dealer promotes him on /dealer.
      const { context, page } = await pageFor(browser, net.owner);
      try {
        await page.goto("/dealer");
        const row = page.getByTestId("team-tree").getByRole("listitem").filter({ hasText: name }).filter({ hasNotText: net.lead.name });
        await expect(row.getByTestId("promotion-progress")).toContainText("Promotion: 50/50 shops · 3/3 ready agents");
        await row.getByRole("button", { name: "Promote to team lead" }).click();
        await expect(page.getByText(`${name} is now a team lead, with the agents he brought in.`)).toBeVisible();
      } finally {
        await context.close();
      }
      expect(await memberRow(a5)).toMatchObject({ team_role: "TEAM_LEAD", depth: 2, parent_id: null });
      for (const r of recruits) expect((await memberRow(r)).parent_id, "his recruits move with him").toBe(a5);
      // 5. A month in which his new team activates the minimum: the former lead earns 1% of each fee.
      const s1 = await activatedShop(net.dealerId, a5);
      const s2 = await activatedShop(net.dealerId, recruits[0]);
      const month = await freeMonth();
      await db()`update dealer_tier_shop_plans set activated_at = ${midMonth(month)} where shop_id in ${db()([s1.shopId, s2.shopId])}`;
      await closeMonth(month);
      const dev = await db()<{ shop_id: string; amount_paise: number }[]>`select shop_id, amount_paise from dealer_commission_ledger where entry_type = 'DEVELOPMENT' and payee_member_id = ${net.lead.id} and amount_paise > 0`;
      expect(dev.map((x) => x.amount_paise).sort(), "1% of ₹4,999 on each").toEqual([4_999, 4_999]);
      const promoted = await accruals(s2.shopId);
      expect(promoted.find((r) => r[0] === "OVERRIDE_LEAD")?.[1], "the new lead earns the override on his recruit's shop").toBe(a5);
      return `lead added ${name} (M told); 999.80 held → released; promoted at 50/50 · 3/3 with 3 recruits; ${month}: L1 ₹49.99 × 2 development bonus`;
    }),
  );
}, { tier: "local", timeout: 600_000, partial: "49 of the 50 shops are arranged; the fee is recorded by Finance (cash), not paid through the sandbox; the development minimum is lowered from 100 to 2 shops a month" });
