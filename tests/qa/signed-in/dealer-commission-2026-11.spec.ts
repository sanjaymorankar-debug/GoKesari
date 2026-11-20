/**
 * TIERED dealer commission — owner's structure 20 / 4 / 3 % (DT-13 … DT-23) —
 * on a site with the staging test accounts (admin, operator, customer). There
 * is no dealer or team-member account on staging, so the checks here read the
 * TIERED settings the site runs with and the access rules; every amount is
 * proven on the local tier (tests/qa/local/dealer-commission-2026-11.spec.ts)
 * and by tests/integration/dealer-tiered-commission.test.ts.
 */
import { as, pageAs, plainCustomer } from "../lib/actors";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, manual, need, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 180_000 };

interface RuleRow {
  key: string;
  value: Record<string, unknown>;
  overridden: boolean;
}

async function tierRuleOnSite(): Promise<Record<string, unknown>> {
  const res = await call(await as("admin"), "GET", "/api/admin/settings");
  expectStatus(res, 200, "GET /api/admin/settings");
  return need((res.body.rules as RuleRow[]).find((r) => r.key === "dealerTieredCommission"), "rule dealerTieredCommission").value;
}

/** The TIERED settings card's text, as the admin reads it. */
async function tieredRuleText(browser: Parameters<typeof pageAs>[0]): Promise<string> {
  const { context, page } = await pageAs(browser, "admin");
  try {
    const res = await page.goto("/admin/dealers/commission/tiered");
    if (res?.status() === 404) blocked("dealer_programme_enabled is off on this site");
    await expect(page.getByTestId("tiered-rule")).toBeVisible();
    return (await page.getByTestId("tiered-rule").innerText()).replace(/\s+/g, " ");
  } finally {
    await context.close();
  }
}

qa("TC-TIER-014", "after migration 0150 the site's rule dealerTieredCommission has mainOverrideBp 300 (main dealer 3%) and the TIERED screen says so", async ({ browser }) => {
  const rule = await tierRuleOnSite();
  expect(rule.mainOverrideBp, "main dealer's share (PR #417, migration 0150)").toBe(300);
  expect([rule.directBp, rule.leadOverrideBp], "direct and lead unchanged").toEqual([2000, 400]);
  const text = await tieredRuleText(browser);
  expect(text).toContain("main-dealer override 3% — at most 27% of the fee per shop.");
  return `rule 20/4/3 (${rule.enabled ? "on" : "off"}); screen: main-dealer override 3%`;
}, { ...signed, partial: "the setting.changed audit entry, the per-dealer rates left alone and scripts/rollback-0150.sql are checked with the developer at the deploy" });

qa(["TC-TIER-018", "TC-TIER-020"], "TIERED settings on the site: target bonus 10% of the month's commission at 50 shops for every role; development 1% for 6 months in months of 100 shops; promotion 50 shops + 3 ready agents", async ({ browser }) => {
  const text = await tieredRuleText(browser);
  for (const role of ["Agent", "Team lead", "Main dealer"]) expect(text).toContain(`${role} 10% of the month's commission at 50 shops a month`);
  expect(text).toContain("Monthly target bonuses: on");
  expect(text).toContain("Promotion at 50 activated shops and 3 ready agents of his own; the former lead earns 1% on the new team for 6 months, for each month the new team registers at least 100 shops.");
  return "targets 50 shops / 10% for agent, lead, main dealer; promotion 50 + 3; development 1% × 6 months at 100 shops";
}, { ...signed, mobile: true, partial: "the bonus and development amounts at a month close need seeded months of 49 / 55 and 80 / 100 / 120 shops: proven by tests/integration/dealer-tiered-commission.test.ts (monthly target, development bonus)" });

qa("TC-TIER-031", "the TIERED screen: a customer is sent home; an operator reads it (read-only) and cannot change it (403)", async ({ browser }) => {
  const role = await plainCustomer();
  const { context, page } = await pageAs(browser, role);
  try {
    const res = await page.goto("/admin/dealers/commission/tiered");
    if (res?.status() === 404) blocked("dealer_programme_enabled is off on this site (the screen answers 404 to everyone)");
    await page.waitForURL((u) => u.pathname === "/", { timeout: 60_000 });
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
  const refused = await call(await as("ops"), "POST", "/api/admin/dealer-tiers", { action: "setModel", dealerId: "00000000-0000-4000-8000-000000000001", model: "TIERED", reason: "QA operator check" });
  expectStatus(refused, 403, "an operator changes a dealer's model");
  return `${role} → /; operator read-only, write 403`;
}, { ...signed, partial: "/dealer with the flag off is in the guest and local tiers; no dealer account on staging" });

manual("TC-TIER-027", "daily and weekly team reports", "the reports run inside the 05:00 IST daily cron (jobs dealer-team-report-daily / -weekly in /api/cron/daily, with every other 05:00 job) — no separate trigger, and staging has no dealer account to receive them; proven by tests/integration/dealer-tiered-commission.test.ts (team report)");
manual("TC-TIER-028", "month close: one payout per person with gross / TDS / net", "closing a month (Dealers → Commission → 'Close <month> now') closes it for every dealer on the site and cannot be undone; proven by tests/integration/dealer-tiered-commission.test.ts and dealer-monthly-payout.test.ts");
manual("TC-SREF-011", "shop-referral reward modes (welcome credit, membership month)", "needs a second shop registered with a SHOP code, approved, with its first delivered order, and the rule shopReferrals switched on the site; proven by tests/integration/shop-referrals.test.ts");
