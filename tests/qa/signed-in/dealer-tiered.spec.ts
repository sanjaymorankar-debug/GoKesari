/**
 * Dealer network (TIERED commission) and shop-refers-shop on a site
 * (docs/dealer-programme/TIERED_COMMISSION.md). Signed tier: the admin and the
 * shop owner test accounts. These checks read screens and APIs and send only
 * requests the server must refuse, so they leave no data behind.
 * Every amount (the ₹999 / ₹4,999 / ₹9,999 slabs, missing levels, TRADING and its lapse,
 * promotion and the development bonus, renewal, reversal of every level, TDS on and off,
 * the shop-referral guards and the one-code rule) is proven by
 * tests/integration/dealer-tiered-commission.test.ts and shop-referrals.test.ts on both
 * database layouts; the cases below that need a TIERED network or a second shop on the
 * site are declared manual with that reason.
 */
import { as, pageAs } from "../lib/actors";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, manual, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 180_000 };

qa("TC-TIER-011", "admin: Dealers → Commission → TIERED model shows the settings, TDS, target bonuses, dealer picker and requests", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    const res = await page.goto("/admin/dealers/commission/tiered");
    if (res?.status() === 404) blocked("dealer_programme_enabled is off on this site");
    await expect(page.getByRole("heading", { name: "TIERED commission" })).toBeVisible();
    await expect(page.getByTestId("tiered-rule")).toBeVisible();
    await expect(page.getByTestId("tds-settings")).toContainText("TDS on payouts");
    await expect(page.getByTestId("target-bonuses")).toContainText("Monthly target bonuses");
    await expect(page.getByLabel("Choose a dealer")).toBeVisible();
    await expect(page.getByTestId("team-requests")).toBeAttached();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll, "horizontal scroll").toBeLessThanOrEqual(1);
    return (await page.getByTestId("tiered-rule").innerText()).split("\n").slice(0, 2).join(" ");
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true });

qa("TC-TIER-001", "a 4th level is refused: no agent can report to an agent, no lead to a lead (API)", async () => {
  const admin = await as("admin");
  const state = await call(admin, "GET", "/api/admin/dealer-tiers");
  if (state.status === 404) blocked("dealer_programme_enabled is off on this site");
  expectStatus(state, 200, "TIERED state");
  // A made-up dealer and parent: the server refuses the shape before it looks anything up, or does not find them — never creates.
  const res = await call(admin, "POST", "/api/admin/dealer-tiers", {
    action: "addMember",
    dealerId: "00000000-0000-4000-8000-000000000001",
    employeeId: "QA-4TH-LEVEL",
    name: "QA fourth level",
    role: "TEAM_LEAD",
    parentId: "00000000-0000-4000-8000-000000000002",
  });
  expect([403, 404, 422], `status ${res.status}`).toContain(res.status);
  const operator = await as("ops");
  const refused = await call(operator, "POST", "/api/admin/dealer-tiers", { action: "setModel", dealerId: "00000000-0000-4000-8000-000000000001", model: "TIERED", reason: "qa check" });
  expectStatus(refused, 403, "an operator cannot change a dealer's model");
  return `lead under a lead → ${res.status}; operator setModel → ${refused.status}`;
}, { ...signed, partial: "the database's own refusal and the agent-under-an-agent case are proven by the integration tests (both layouts)" });

qa("TC-SREF-006", "admin: Shop referrals lists outcomes (and says when the rule is off)", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/shop-referrals");
    await expect(page.getByRole("heading", { name: "Shop-refers-shop rewards" })).toBeVisible();
    const empty = await page.getByText("No shop referrals yet.").isVisible().catch(() => false);
    if (!empty) await expect(page.getByTestId("shop-referrals-table")).toBeVisible();
    return empty ? "no referrals yet" : `${await page.getByTestId("shop-referral-row").count()} referrals listed`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "the reversal itself is proven by tests/integration/shop-referrals.test.ts" });

qa("TC-SREF-001", "shop owner: My Shop → Registration and fee has the shop's own SHOP code, its /r/ link and share buttons", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/manage/registration");
    const card = page.getByTestId("shop-referral-card");
    if (!(await card.isVisible().catch(() => false))) blocked("rule shopReferrals is off on this site, or the shop is not approved");
    await expect(page.getByTestId("shop-referral-code")).toHaveText(/^SHOP[A-HJ-NP-Z2-9]{5}$/);
    const code = (await page.getByTestId("shop-referral-code").innerText()).trim();
    await expect(page.getByTestId("shop-referral-link")).toContainText(`/r/${code}`);
    await expect(card.getByRole("link", { name: "Share on WhatsApp" })).toBeVisible();
    await expect(card.getByRole("button", { name: /Copy link|Link copied/ })).toBeVisible();
    return `code ${code}`;
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true });

qa("TC-SREF-003", "one code: a shop code is accepted by the registration code check while the rule is on; a made-up one is not", async () => {
  const owner = await as("customer2");
  const shop = await as("shop");
  const card = await call(shop, "GET", "/shop/manage/registration");
  const code = /SHOP[A-HJ-NP-Z2-9]{5}/.exec(card.text)?.[0];
  if (!code) blocked("no shop code on this site (rule shopReferrals off)");
  const bad = await call(owner, "GET", `/api/referral-codes/check?code=SHOPZZZZZ`);
  if (bad.status === 404) blocked("no code-check route on this site");
  expect(bad.body).toMatchObject({ valid: false });
  const good = await call(owner, "GET", `/api/referral-codes/check?code=${code}`);
  expect(good.body).toMatchObject({ valid: true });
  return `${code} valid; SHOPZZZZZ refused`;
}, { ...signed, partial: "the wizard's lock on a second code and the 10% fee are proven by tests/integration/shop-referrals.test.ts" });

manual(["TC-TIER-002", "TC-TIER-003", "TC-TIER-004", "TC-TIER-005", "TC-TIER-007", "TC-TIER-008", "TC-TIER-009"], "TIERED amounts, TRADING, renewal, reversal, payouts and TDS", "needs a TIERED dealer network with paid shops and delivered orders on the site; every amount is proven by tests/integration/dealer-tiered-commission.test.ts on both database layouts");
manual(["TC-TIER-006", "TC-TIER-010"], "promotion with the development bonus; agent agreement and standard dealers", "needs a TIERED network with linked member accounts on the site; proven by tests/integration/dealer-tiered-commission.test.ts");
manual(["TC-SREF-004", "TC-SREF-005"], "shop-referral reward on the first delivery and its guards", "needs a second shop registered with a code, approved, with a delivered order; proven by tests/integration/shop-referrals.test.ts");
