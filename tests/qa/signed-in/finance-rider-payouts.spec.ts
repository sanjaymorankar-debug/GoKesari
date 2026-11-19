/**
 * Rider bank payouts with the test accounts (docs/gig-bank-payouts-2026-10),
 * for test.gokesari.com and the local server: the bank check with Cashfree's
 * Secure ID sandbox (TC-RPAY-001), who may withdraw (TC-RPAY-008), the
 * switched-off state (TC-RPAY-010) and the admin rider-payouts page and its
 * "Run now" (TC-RPAY-015).
 *
 * Signed tier: the feature flags are read (Admin → Feature flags), never
 * changed — a check that needs a flag that is off is blocked ("Not Applicable"
 * in the case's words). Nothing here sends an e-mailed code (staging codes go
 * to the owner's mailbox) and "Run now" is only proven with a month that is
 * not over, so no payout run is started on the site.
 */
import { as, me, pageAs } from "../lib/actors";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import { needFlagsOn, riderFlags, SECURE_ID_SAMPLE } from "../lib/rider-payout-helpers";
import type { Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };

qa(
  ["TC-RPAY-001"],
  "Rider 1's bank account is verified with the bank (Cashfree Secure ID sandbox sample) without a ₹1 payment",
  async ({ browser }) => {
    await needFlagsOn(["rider_bank_account_enabled"]);
    const status = await call(await as("admin"), "GET", "/api/admin/bank-account-check");
    expectStatus(status, 200, "GET /api/admin/bank-account-check");
    if (!status.body.enabled) blocked("rule bankAccountCheck is off on this site");
    if (!status.body.configured) blocked("the Cashfree Verification Suite keys are not set on this site");
    if (status.body.env !== "sandbox") blocked(`the bank check uses Cashfree ${status.body.env} here; only its sandbox sample account may be sent`);
    const current = (await call(await as("rider"), "GET", "/api/bank-account")).body?.account as { status: string; matchMethod: string | null } | null;
    const { context, page } = await pageAs(browser, "rider");
    try {
      await page.goto("/gig/wallet");
      const card = page.getByTestId("bank-account");
      if (current?.status === "VERIFIED") {
        if (current.matchMethod !== "BANK_CHECK") {
          blocked("Rider 1's account is already verified by the ₹1 check; changing it needs the e-mailed code, which a spec cannot read on this site");
        }
        await expect(card.getByTestId("bank-check-verified")).toContainText("Verified with your bank");
        return "already verified with the bank by an earlier run (changing it needs the e-mailed code)";
      }
      if (current) await card.getByRole("button", { name: "Change details" }).click();
      await card.getByRole("textbox", { name: "Account holder name" }).fill(SECURE_ID_SAMPLE.name);
      await card.getByRole("textbox", { name: "IFSC" }).fill(SECURE_ID_SAMPLE.ifsc);
      await card.getByLabel("Account number", { exact: true }).fill(SECURE_ID_SAMPLE.accountNumber);
      await card.getByRole("textbox", { name: "Re-enter account number" }).fill(SECURE_ID_SAMPLE.accountNumber);
      await card.getByRole("button", { name: "Save", exact: true }).click();
      await expect(card.getByText("Saved and verified with your bank — no ₹1 payment needed.", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(card.getByText("Verified", { exact: true })).toBeVisible();
      await expect(card.getByTestId("bank-check-verified")).toContainText("Verified with your bank");
      await expect(card.getByRole("button", { name: "Verify with ₹1" })).toHaveCount(0);
    } finally {
      await context.close();
    }
    const after = (await call(await as("rider"), "GET", "/api/bank-account")).body.account;
    expect({ status: after.status, matchMethod: after.matchMethod }).toEqual({ status: "VERIFIED", matchMethod: "BANK_CHECK" });
    return `verified with the bank (${after.matchedAccountHolderName ?? "name at bank not shown"}), no ₹1 payment`;
  },
  { ...signed, mobile: true },
);

/**
 * Whether `role` has a delivery partner profile, as the wallet sees it (whatever role the account is
 * acting as: an account that applied once keeps its profile). One that has none is a customer or a
 * shop owner here.
 */
async function isPartner(role: Role): Promise<boolean> {
  const res = await call(await as(role), "GET", "/api/gig/wallet");
  expectStatus(res, 200, `GET /api/gig/wallet as ${role}`);
  return Boolean(res.body?.partner);
}

qa(
  ["TC-RPAY-008"],
  "a customer and a shop owner are not delivery partners: the wallet says so and the withdraw API refuses",
  async ({ browser }) => {
    await needFlagsOn(["rider_bank_account_enabled", "rider_withdrawal_enabled"]);
    const customer = (await isPartner("customer")) ? ((await isPartner("customer2")) ? null : "customer2") : "customer";
    const people: Role[] = [...(customer ? [customer as Role] : []), ...((await isPartner("shop")) ? [] : (["shop"] as Role[]))];
    if (!people.length) blocked("every customer and shop test account here also has a delivery partner profile");
    const seen: string[] = [];
    for (const role of people) {
      const { context, page } = await pageAs(browser, role);
      try {
        await page.goto("/gig/wallet");
        await expect(page.getByText("You're not a delivery partner yet", { exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
      // Refused before any code is e-mailed.
      const res = await call(await as(role), "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000 });
      expectStatus(res, 403, `${role} withdraws`);
      expect(res.body?.error?.message).toBe("Only delivery partners can withdraw earnings.");
      seen.push(`${role} (${(await me(role)).role}): 403`);
    }
    return seen.join("; ");
  },
  { ...signed, partial: "the unapproved applicant (\"Withdrawals open once your delivery partner application is approved.\") is checked on the local run: staging has no unapproved applicant account" },
);

qa(
  ["TC-RPAY-010"],
  "with the rider payout flags off on this site, the wallet and its withdrawal routes answer 404",
  async ({ browser }) => {
    const flags = await riderFlags();
    if (flags.rider_bank_account_enabled && flags.rider_withdrawal_enabled) {
      blocked("the rider payout flags are on on this site; switching them off (and the no-provider state) is checked on the local run");
    }
    const rider = await as("rider");
    const seen: string[] = [];
    if (!flags.rider_bank_account_enabled) {
      const wallet = await call(rider, "GET", "/api/gig/wallet");
      expectStatus(wallet, 404, "GET /api/gig/wallet with rider_bank_account_enabled off");
      expect(wallet.body?.error?.message).toBe("This feature is not available.");
      const { context, page } = await pageAs(browser, "rider");
      try {
        const res = await page.goto("/gig/wallet");
        expect(res?.status(), "/gig/wallet with the flag off").toBe(404);
      } finally {
        await context.close();
      }
      seen.push("rider_bank_account_enabled off: /gig/wallet and its API 404");
    } else {
      const { context, page } = await pageAs(browser, "rider");
      try {
        await page.goto("/gig/wallet");
        await expect(page.getByRole("heading", { name: "Bank account" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Withdraw to bank" })).toHaveCount(0);
      } finally {
        await context.close();
      }
      seen.push("rider_withdrawal_enabled off: no withdraw panel");
    }
    expectStatus(await call(rider, "GET", "/api/gig/wallet/quote?amountPaise=10000"), 404, "quote with the flag off");
    expectStatus(await call(rider, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000 }), 404, "withdraw with the flag off");
    return [...seen, "quote and withdraw 404"].join("; ");
  },
  { ...signed, partial: "the flag-on state with no payout provider (\"Withdrawals are not available right now…\") is checked on the local run" },
);

qa(
  ["TC-RPAY-015"],
  "admin rider payouts: FINANCE_VIEW to see it (admin yes, operator and limited operator no), only an ADMIN can Run now",
  async ({ browser }) => {
    const flags = await riderFlags();
    const seen: string[] = [];
    // The API: the list needs FINANCE_VIEW, Run now needs ADMIN. A month that is not over pays nobody.
    const admin = await as("admin");
    expectStatus(await call(admin, "GET", "/api/admin/rider-payouts/runs"), 200, "admin lists the runs");
    const run = await call(admin, "POST", "/api/admin/rider-payouts/runs", { month: "2099-01" });
    if (flags.rider_monthly_payout_enabled) {
      expectStatus(run, 409, "admin Run now for a month not over");
      expect(run.body?.error?.message).toBe("January 2099 is not over yet.");
    } else {
      expectStatus(run, 200, "admin Run now with the monthly flag off");
      expect(run.body?.skipped).toBe("Monthly rider payout is off (feature flag).");
    }
    seen.push(`admin: list 200, Run now accepted (${run.status})`);
    for (const role of ["ops", "oplim"] as const) {
      const ctx = await as(role);
      expectStatus(await call(ctx, "GET", "/api/admin/rider-payouts/runs"), 403, `${role} lists the runs`);
      expectStatus(await call(ctx, "POST", "/api/admin/rider-payouts/runs", { month: "2099-01" }), 403, `${role} Run now`);
      const { context, page } = await pageAs(browser, role);
      try {
        await page.goto("/admin/rider-payouts");
        expect(new URL(page.url()).pathname, `${role} is sent away from /admin/rider-payouts`).not.toBe("/admin/rider-payouts");
      } finally {
        await context.close();
      }
      seen.push(`${role}: 403 / page refused`);
    }
    // The page itself (it exists while the rider bank account flag is on).
    const { context, page } = await pageAs(browser, "admin");
    try {
      const res = await page.goto("/admin/rider-payouts");
      if (flags.rider_bank_account_enabled) {
        await expect(page.getByRole("heading", { name: "Rider payouts", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
        seen.push("admin page with Run now");
      } else {
        expect(res?.status(), "the page with rider_bank_account_enabled off").toBe(404);
        seen.push("admin page 404 (rider_bank_account_enabled off)");
      }
    } finally {
      await context.close();
    }
    return seen.join("; ");
  },
  { ...signed, partial: "a FINANCE_VIEW user who is not an ADMIN (seeing the page without Run now) has no test account; operators have no FINANCE_VIEW" },
);
