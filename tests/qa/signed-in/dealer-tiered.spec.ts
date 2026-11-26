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
    const rule = (await page.getByTestId("tiered-rule").innerText()).split("\n").slice(0, 2).join(" ");
    // Override 20-Nov-2026 (DT-21): the team tree and Team performance once a dealer is chosen.
    const values = await page.getByLabel("Choose a dealer").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    if (!values.length) return `${rule}; no approved dealer to open on this site`;
    await page.goto(`/admin/dealers/commission/tiered?dealerId=${values[0]}`);
    const perf = page.getByTestId("team-performance");
    await expect(perf.getByRole("heading", { name: "Team performance" })).toBeVisible();
    await expect(perf.getByRole("group", { name: "Period" })).toBeVisible();
    return `${rule}; dealer opened: Team performance shown`;
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true, partial: "the team tree of a TIERED dealer with members, and the dealer's own live card on /dealer, need a dealer account (none on staging): local tier TC-TIER-024 / 025" });

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
    // Referral sharing (rule referralSharing, on on both sites since 26-Nov-2026; docs/referral-sharing-2026-11): the
    // card's buttons are WhatsApp / SMS / Email / Copy link, each carrying the code and its /r/ link; before it,
    // "Share on WhatsApp", "Share" and "Copy link".
    const shared = card.getByTestId("share-whatsapp");
    if (await shared.count()) {
      await expect(shared).toHaveAttribute("href", new RegExp(`^https://wa\\.me/\\?text=.*${code}.*%2Fr%2F${code}`));
      await expect(card.getByTestId("share-sms")).toHaveAttribute("href", new RegExp(`^sms:.*${code}`));
      await expect(card.getByTestId("share-email")).toHaveAttribute("href", new RegExp(`^mailto:.*${code}`));
      await expect(card.getByRole("button", { name: /Copy link|Link copied/ })).toBeVisible();
      return `code ${code}; WhatsApp / SMS / Email links carry the code and /r/${code}; Copy link`;
    }
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
}, { ...signed, partial: "the wizard's lock on a second code (REFERRAL_CODE_LOCKED) and the 10% fee (₹999 → ₹899.10 + GST) are proven by tests/integration/shop-referrals.test.ts" });

manual(["TC-TIER-003", "TC-TIER-004", "TC-TIER-008", "TC-TIER-009"], "TIERED TRADING, reversal, payouts and TDS", "needs a TIERED dealer network with paid shops and delivered orders on the site; every amount is proven by tests/integration/dealer-tiered-commission.test.ts on both database layouts");
manual("TC-TIER-010", "agent agreement and standard dealers", "needs a TIERED network with linked member accounts on the site; proven by tests/integration/dealer-tiered-commission.test.ts");

/** The TIERED settings card as the admin reads it (whitespace folded). */
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

// Overrides of 20-Nov-2026 (DT-13 … DT-23): the site's TIERED settings are the owner's structure. The amounts per shop
// are proven on the local tier (tests/qa/local/dealer-commission-2026-11.spec.ts) and by the integration tests.
qa("TC-TIER-002", "TIERED settings: direct 20% all at activation (no TRADING wait), lead 4%, main dealer 3% — at most 27% a shop", async ({ browser }) => {
  const text = await tieredRuleText(browser);
  expect(text).toContain("Direct 20% (all of it when the shop pays and is approved) · team-lead override 4% · main-dealer override 3% — at most 27% of the fee per shop.");
  expect(text).toContain("No trading condition: everything is earned at activation and paid on the payout day of the next month. No per-shop cap.");
  return "20 / 4 / 3 %, all at activation, no cap";
}, { ...signed, partial: "₹999 → ₹199.80 / ₹39.96 / ₹29.97 and the ₹4,999 / ₹9,999 amounts need a TIERED network with paid shops: local tier TC-TIER-012 and tests/integration/dealer-tiered-commission.test.ts" });

qa("TC-TIER-005", "TIERED settings: renewal 10% to the signer, 2% to the lead, 1% to the main dealer within 3 years", async ({ browser }) => {
  const text = await tieredRuleText(browser);
  expect(text).toContain("Renewal commission: 10% to whoever signed the shop, 2% to the team lead, 1% to the main dealer — on renewals paid within 3 years of activation.");
  return "renewal 10 / 2 / 1 % for 3 years";
}, { ...signed, partial: "₹99.90 / ₹19.98 / ₹9.99 on a ₹999 renewal, nothing after 3 years or when switched off: local tier TC-TIER-017 (₹4,999) and tests/integration/dealer-tiered-commission.test.ts" });

qa("TC-TIER-006", "TIERED settings: promotion at 50 activated shops and 3 ready agents; the former lead's 1% for 6 months only in months of 100 shops", async ({ browser }) => {
  const text = await tieredRuleText(browser);
  expect(text).toContain("Promotion at 50 activated shops and 3 ready agents of his own; the former lead earns 1% on the new team for 6 months, for each month the new team registers at least 100 shops.");
  return "promotion 50 + 3; development 1% × 6 months at 100 shops";
}, { ...signed, partial: "'Promote anyway (override)' below the bar and the move with his agents: local tier TC-TIER-019; the 100-shop months: tests/integration/dealer-tiered-commission.test.ts" });

qa("TC-TIER-007", "TIERED settings: monthly target bonus 10% of the month's commission at 50 shops, for agent, team lead and main dealer", async ({ browser }) => {
  const text = await tieredRuleText(browser);
  expect(text).toContain("Monthly target bonuses: on");
  for (const role of ["Agent", "Team lead", "Main dealer"]) expect(text).toContain(`${role} 10% of the month's commission at 50 shops a month`);
  return "target 50 shops, 10%, every role";
}, { ...signed, partial: "the BONUS entries at a month close (50+ shops: 10% of direct + override; 49: none) and one draft payout per payee: tests/integration/dealer-tiered-commission.test.ts" });
manual(["TC-SREF-004", "TC-SREF-005"], "shop-referral reward on the first delivery and its guards", "needs a second shop registered with a code, approved, with a delivered order; proven by tests/integration/shop-referrals.test.ts");

qa("TC-DPAY-004", "admin: the four payout reports download as CSV and XLSX; an operator reads them but not the bank file", async () => {
  const admin = await as("admin");
  const notes: string[] = [];
  for (const report of ["summary", "lines", "pending", "failed"]) {
    const csv = await call(admin, "GET", `/api/admin/dealer-payout-reports?report=${report}&format=csv`);
    if (csv.status === 404) blocked("dealer_programme_enabled is off on this site");
    expectStatus(csv, 200, `${report} CSV`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const xlsx = await call(admin, "GET", `/api/admin/dealer-payout-reports?report=${report}&format=xlsx`);
    expectStatus(xlsx, 200, `${report} XLSX`);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    notes.push(report);
  }
  const ops = await as("ops");
  expectStatus(await call(ops, "GET", "/api/admin/dealer-payout-reports?report=summary&format=json"), 200, "operator reads the reports");
  expectStatus(await call(ops, "GET", "/api/admin/dealer-commission?bankFile=1"), 403, "operator: no bank file");
  return `${notes.join(", ")} in CSV and XLSX; operator read-only`;
}, { ...signed, partial: "the statement email's CSV is proven by tests/integration/dealer-payouts-pan-tds.test.ts" });

qa("TC-TDS-003", "admin: TDS on commission shows dated rows (CA-confirmed or not), certificates, challans, downloads and exceptions", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/tds-commission");
    await expect(page.getByRole("heading", { name: "TDS on commission" })).toBeVisible();
    await expect(page.getByTestId("tds-rows")).toContainText(/PAN/);
    await expect(page.getByTestId("tds-certificates")).toBeAttached();
    await expect(page.getByTestId("tds-exceptions")).toBeAttached();
    await expect(page.getByRole("link", { name: /26Q data/ })).toBeVisible();
    return (await page.getByTestId("tds-rows").innerText()).split("\n")[0];
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true, partial: "the payee's TDS card needs a dealer account on the site" });

manual(["TC-DPAY-001", "TC-DPAY-002", "TC-DPAY-003"], "payouts by PAN, holds and the minimum, maker-checker and the automatic transfer", "needs dealers and team members with earnings and a month close on the site; proven by tests/integration/dealer-payouts-pan-tds.test.ts on both database layouts");
manual(["TC-TDS-001", "TC-TDS-002"], "the unconfirmed-row block, the CA's confirmation, modes and certificates", "needs a CA account and payouts on the site; proven by tests/integration/dealer-payouts-pan-tds.test.ts on both database layouts");
