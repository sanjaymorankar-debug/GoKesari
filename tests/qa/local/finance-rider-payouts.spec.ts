/**
 * Rider bank account and payouts on the local server (TS-RPAY-01 … 05,
 * docs/gig-bank-payouts-2026-10): the re-entered account number, the bank
 * check's provider error and 3-a-day cap, a UPI ID keeping the ₹1 check,
 * withdrawals (₹100–₹10,000, ₹10,000 a day, IMPS, no fee, an e-mailed code
 * each time), the e-mailed code to change a verified account (10 minutes),
 * the monthly NEFT payout with the ₹100 carry-forward, refused transfers and
 * their retries, and TDS u/s 194C (1% with PAN, 20% without, above ₹30,000
 * single or ₹1,00,000 a year).
 *
 * Local tier: the three rider flags and rule riderPayouts (the owner's
 * 31-Oct-2026 values) are set for each check and put back after it; every
 * check uses new delivery partners (a new account, the full application,
 * an identity document, approved by operations) with unpaid earnings arranged
 * as finished deliveries leave them. Bank accounts are Cashfree's sandbox
 * test account, verified with the ₹1 test gateway; codes come from the local
 * mail catcher; the payout provider is SANDBOX (…98 paise always refused).
 * Monthly runs use a past month nobody else has unpaid earnings in.
 */
import type { Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { localUser } from "../lib/auth-helpers";
import { db } from "../lib/db";
import { cron, setRules, shopId } from "../lib/finance-helpers";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import {
  actionCode,
  ageActionCodes,
  ALL_RIDER_FLAGS_ON,
  applicant,
  approvedRider,
  arrangeEarnings,
  arrangePaidThisYear,
  notificationsTo,
  pageOf,
  quote,
  saveBankAccount,
  setFlags,
  TEST_BANK,
  transfersOf,
  unusedPastMonth,
  verifiedAccount,
  withdraw,
  withdrawalCode,
  type RiderFlag,
} from "../lib/rider-payout-helpers";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };

/** The owner's decisions of 31 Oct 2026 (rule riderPayouts defaults), set for every check. */
const PAYOUT_RULE = {
  withdrawalMinPaise: 10_000,
  withdrawalMaxPaise: 1_000_000,
  withdrawalDailyMaxPaise: 1_000_000,
  withdrawalFeePaise: 0,
  withdrawalMode: "IMPS",
  monthlyMinPaise: 10_000,
  payoutDayOfMonth: 5,
  payoutHourIst: 9,
  monthlyMode: "NEFT",
  maxRetries: 3,
  retryBackoffMinutes: 60,
  provider: "SANDBOX",
  sandboxAutoWebhook: true,
  tdsEnabled: true,
  tdsRatePanBp: 100,
  tdsRateNoPanBp: 2000,
  singlePaymentThresholdPaise: 3_000_000,
  annualThresholdPaise: 10_000_000,
};

const MESSAGES = {
  smallest: "The smallest withdrawal is ₹100.00.",
  largest: "The largest withdrawal is ₹10,000.00.",
  upTo600: "You can withdraw up to ₹600.00 — your unpaid earnings.",
  more100: "You can withdraw ₹100.00 more today (daily limit ₹10,000.00).",
  reached: "You have reached today's withdrawal limit of ₹10,000.00. Try again tomorrow.",
  notPartner: "Only delivery partners can withdraw earnings.",
  notApproved: "Withdrawals open once your delivery partner application is approved.",
  addVerify: "Add and verify your bank account below to withdraw.",
  addVerifyApi: "Add and verify your bank account first.",
  noProvider: "Withdrawals are not available right now. Please try again later.",
  otp: "That code is wrong or has expired. Check the latest email or request a new code.",
  reauth: "Confirm it's you first: we'll email you a code before your bank account can be changed.",
  cap: "The bank can be asked 3 times a day. Verify with ₹1 instead, or try tomorrow.",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** Flags (default: all three on) and rule riderPayouts set for `body`, always put back. */
async function payoutSetup<T>(body: () => Promise<T>, flags: Partial<Record<RiderFlag, boolean>> = ALL_RIDER_FLAGS_ON, rules: Record<string, Record<string, unknown>> = {}): Promise<T> {
  const restoreFlags = await setFlags(flags);
  let restoreRules: (() => Promise<void>) | null = null;
  try {
    restoreRules = await setRules({ riderPayouts: PAYOUT_RULE, ...rules });
    return await body();
  } finally {
    if (restoreRules) await restoreRules();
    await restoreFlags();
  }
}

/** The "Unpaid earnings" figure on My wallet. */
const unpaid = (page: Page) => page.getByText("Unpaid earnings", { exact: true }).locator("..");

/** Withdraw panel: type an amount and press Check. */
async function checkAmount(page: Page, rupees: string) {
  await page.getByLabel("Amount to withdraw in rupees").fill(rupees);
  await page.getByRole("button", { name: "Check", exact: true }).click();
}

/** Fills the bank account form of BankAccountManager (opened). */
async function fillBankForm(page: Page, holder: string, number: string, confirm: string, ifsc: string) {
  await page.getByRole("textbox", { name: "Account holder name" }).fill(holder);
  await page.getByRole("textbox", { name: "IFSC" }).fill(ifsc);
  await page.getByLabel("Account number", { exact: true }).fill(number);
  await page.getByRole("textbox", { name: "Re-enter account number" }).fill(confirm);
}

/** Presses Save on the bank account form and waits for the server's answer. */
async function saveAndWait(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/bank-account") && r.request().method() === "PUT"),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  return response;
}

/* ======================================================== TS-RPAY-01 */

qa(
  ["TC-RPAY-002"],
  "a re-entered account number that differs is refused on the form and by the server; nothing is saved",
  async ({ browser }) =>
    payoutSetup(async () => {
      const rider = await approvedRider("acmatch");
      const { context, page } = await pageOf(browser, rider);
      try {
        await page.goto("/gig/wallet");
        await expect(page.getByRole("heading", { name: "Add a bank account for payouts" })).toBeVisible();
        await fillBankForm(page, rider.name, TEST_BANK.accountNumber, "1111222244", TEST_BANK.ifsc);
        await expect(page.getByText("The two numbers do not match.", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("The two account numbers do not match.").first()).toBeVisible();
      } finally {
        await context.close();
      }
      const api = await call(rider.ctx, "PUT", "/api/bank-account", { method: "BANK_ACCOUNT", accountHolderName: rider.name, accountNumber: TEST_BANK.accountNumber, confirmAccountNumber: "1111222244", ifsc: TEST_BANK.ifsc });
      expectStatus(api, 422, "mismatched re-entered number");
      expect(api.body?.error?.details?.fields?.confirmAccountNumber).toBe("The two account numbers do not match.");
      expect((await call(rider.ctx, "GET", "/api/bank-account")).body.account, "nothing saved").toBeNull();
      return "form: \"The two numbers do not match.\"; save: 422 \"The two account numbers do not match.\"";
    }),
  {
    ...local,
    partial:
      "the bank's refusals (name not matching, IFSC not valid, NRE account) need Cashfree Secure ID sandbox answers — not reachable from the local server, and no sandbox data for those outcomes is documented for staging",
  },
);

qa(
  ["TC-RPAY-003"],
  "bank check: a provider error leaves the ₹1 check; after 3 checks in a day the 4th is refused with the 3-a-day message",
  async ({ browser }) =>
    payoutSetup(
      async () => {
        const rider = await approvedRider("bankcap");
        const { context, page } = await pageOf(browser, rider);
        try {
          await page.goto("/gig/wallet");
          await fillBankForm(page, rider.name, TEST_BANK.accountNumber, TEST_BANK.accountNumber, TEST_BANK.ifsc);
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await expect(page.getByTestId("bank-account").getByText("Not verified yet", { exact: true })).toBeVisible();
          const saved = (await call(rider.ctx, "GET", "/api/bank-account")).body.account;
          const result: string | null = saved?.bankCheck?.result ?? null;
          if (result === "ERROR") {
            await expect(page.getByText("Saved. We could not reach your bank just now — verify with ₹1 instead, or check with your bank again.", { exact: true })).toBeVisible();
          }
          // Earlier checks today (each one a call to the bank), up to 3.
          const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from bank_account_checks
            where user_id = ${rider.id} and result <> 'NOT_CONFIGURED' and created_at > now() - interval '24 hours'`;
          for (let i = n; i < 3; i++) {
            await db()`insert into bank_account_checks (bank_account_id, user_id, result, error_message) values (${saved.id}, ${rider.id}, 'ERROR', 'QA: an earlier check today')`;
          }
          await page.reload();
          await expect(page.getByTestId("bank-check-error")).toHaveText("We could not reach your bank just now to check this account.");
          await expect(page.getByRole("button", { name: "Verify with ₹1" })).toBeVisible();
          await page.getByRole("button", { name: "Check with my bank again" }).click();
          await expect(page.getByText(MESSAGES.cap, { exact: true })).toBeVisible();
          const api = await call(rider.ctx, "POST", "/api/bank-account/check", { accountId: saved.id });
          expectStatus(api, 429, "the 4th check of the day");
          expect(api.body?.error?.message).toBe(MESSAGES.cap);
          return `save → bank check ${result ?? "none"}; 4th check → 429 "${MESSAGES.cap}"`;
        } finally {
          await context.close();
        }
      },
      { rider_bank_account_enabled: true },
      { bankAccountCheck: { enabled: true, maxChecksPerDay: 3 } },
    ),
  {
    ...local,
    partial:
      "the \"could not reach your bank\" notice right after saving is asserted only when the local server has (even fake) Verification Suite keys — without keys the save is not checked with the bank; the 3-a-day cap is always checked (earlier checks arranged)",
  },
);

qa(
  ["TC-RPAY-004"],
  "shop owner: a UPI ID payout method is not checked with the bank (Secure ID) — it keeps the ₹1 check",
  async ({ browser }) => {
    const sid = shopId("A");
    const restoreRule = await setRules({ bankAccountCheck: { enabled: true } });
    const [previous] = await db()<{ id: string }[]>`select id from bank_accounts where shop_id = ${sid} and is_current`;
    const { context, page } = await pageAs(browser, "shop");
    try {
      const gateway = (await call(await as("shop"), "GET", "/api/bank-account")).body?.gateway as string;
      await page.goto(`/shop/bank-account?shop=${sid}`);
      await expect(page.getByRole("heading", { name: /^Payout bank account — / })).toBeVisible();
      if (await page.getByRole("button", { name: "Change details" }).isVisible()) await page.getByRole("button", { name: "Change details" }).click();
      await page.getByRole("radiogroup", { name: "Account type" }).getByText("UPI ID", { exact: true }).click();
      await page.getByRole("textbox", { name: "Account holder name" }).fill("QA Shop A Payouts");
      await page.getByRole("textbox", { name: "UPI ID" }).fill("testsuccess@gocash");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved. Now verify it with a ₹1 payment, refunded straight away.", { exact: true })).toBeVisible();
      await expect(page.getByTestId("bank-account").getByText("Not verified yet", { exact: true })).toBeVisible();
      const [row] = await db()<{ id: string; method: string; status: string; match_method: string | null }[]>`
        select id, method, status, match_method from bank_accounts where shop_id = ${sid} and is_current`;
      expect(row.method).toBe("UPI");
      expect(row.status).toBe("PENDING");
      const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from bank_account_checks where bank_account_id = ${row.id}`;
      expect(n, "no bank check (Secure ID) for a UPI ID, though the rule is on").toBe(0);
      if (gateway === "SIMULATOR") {
        await page.getByRole("button", { name: "Verify with ₹1" }).click();
        await expect(page.getByTestId("bank-simulator")).toContainText("TEST MODE — no money moves");
      } else {
        await expect(page.getByRole("button", { name: "Verify with ₹1" })).toBeVisible();
      }
      return `UPI ID saved PENDING, ${n} bank checks, "Verify with ₹1" offered (${gateway})`;
    } finally {
      await context.close();
      // Shop A's payout account as it was.
      await db()`update bank_accounts set is_current = false, superseded_at = now() where shop_id = ${sid} and is_current and id <> ${previous?.id ?? "00000000-0000-0000-0000-000000000000"}`;
      if (previous) await db()`update bank_accounts set is_current = true, superseded_at = null where id = ${previous.id}`;
      await restoreRule();
    }
  },
  local,
);

/* ======================================================== TS-RPAY-02 */

qa(
  ["TC-RPAY-005"],
  "rider withdraws ₹100 with the e-mailed code: IMPS, no fee, unpaid down by ₹100, statement shows the amount and status",
  async ({ browser }) =>
    payoutSetup(async () => {
      const rider = await approvedRider("wd");
      await verifiedAccount(rider);
      await arrangeEarnings(rider.partnerId, [30_000, 20_000]);
      const { context, page } = await pageOf(browser, rider);
      try {
        await page.goto("/gig/wallet");
        await expect(unpaid(page)).toContainText("₹500.00");
        await expect(page.getByRole("heading", { name: "Withdraw to bank" })).toBeVisible();
        await checkAmount(page, "100");
        await expect(page.getByText("You receive", { exact: true })).toBeVisible();
        // The quote: fee None, TDS None, ₹100.00 received.
        await expect(page.getByRole("main")).toContainText("Amount₹100.00FeeNone");
        await expect(page.getByRole("main")).toContainText("You receive₹100.00");
        await ageActionCodes(rider.email, "RIDER_WITHDRAWAL");
        const since = Date.now();
        await page.getByRole("button", { name: "Email me a code to confirm" }).click();
        const code = await actionCode(rider.email, since);
        await page.getByLabel("Confirmation code").fill(code);
        await page.getByRole("button", { name: "Withdraw ₹100.00" }).click();
        await expect(page.getByText(/^₹100\.00 (has been paid|is on its way) to your bank\.$/)).toBeVisible({ timeout: 30_000 });
        await expect(unpaid(page)).toContainText("₹400.00");
        const [t] = await transfersOf(rider.partnerId);
        expect(t, "a withdrawal transfer").toBeTruthy();
        expect({ kind: t.kind, mode: t.mode, gross: t.gross_paise, fee: t.fee_paise, tds: t.tds_paise }).toEqual({ kind: "WITHDRAWAL", mode: "IMPS", gross: 10_000, fee: 0, tds: 0 });
        await page.getByRole("link", { name: /Withdrawal · ₹100\.00/ }).click();
        await page.waitForURL(new RegExp(`/gig/wallet/payouts/${t.id}$`));
        await expect(page.getByRole("heading", { name: "Withdrawal statement" })).toBeVisible();
        const body = page.getByRole("main");
        await expect(body).toContainText("Amount₹100.00");
        await expect(body).toContainText("FeeNone");
        await expect(body).toContainText("Sent byIMPS");
        await expect(body).toContainText(/Paid|On its way/);
        return `transfer ${t.id.slice(0, 8)}: ${t.status}, IMPS, fee ₹0, TDS none; unpaid ₹500 → ₹400`;
      } finally {
        await context.close();
      }
    }),
  { ...local, mobile: true },
);

qa(
  ["TC-RPAY-006"],
  "withdrawal limits with ₹600 unpaid: ₹99, ₹10,001 and ₹700 refused with their messages; ₹100 and ₹600 accepted",
  async ({ browser }) =>
    payoutSetup(async () => {
      const rider = await approvedRider("wdlimits");
      await verifiedAccount(rider);
      await arrangeEarnings(rider.partnerId, [60_000]);
      const { context, page } = await pageOf(browser, rider);
      try {
        await page.goto("/gig/wallet");
        for (const [rupees, message] of [
          ["99", MESSAGES.smallest],
          ["10001", MESSAGES.largest],
          ["700", MESSAGES.upTo600],
        ] as const) {
          await checkAmount(page, rupees);
          await expect(page.getByText(message, { exact: true }), `₹${rupees}`).toBeVisible();
          await expect(page.getByRole("button", { name: "Email me a code to confirm" })).toHaveCount(0);
        }
        for (const rupees of ["100", "600"]) {
          await checkAmount(page, rupees);
          await expect(page.getByRole("button", { name: "Email me a code to confirm" }), `₹${rupees} accepted`).toBeVisible();
        }
      } finally {
        await context.close();
      }
      const done = await withdraw(rider, 60_000);
      expectStatus(done, 201, "withdraw the whole ₹600");
      expect((await call(rider.ctx, "GET", "/api/gig/wallet")).body.balance.availablePaise, "nothing left unpaid").toBe(0);
      return `₹99 / ₹10,001 / ₹700 refused with the case's messages; ₹100 and ₹600 pass the check; ₹600 withdrawn (${done.body.status})`;
    }),
  local,
);

qa(
  ["TC-RPAY-007"],
  "daily limit ₹10,000: after ₹9,900, ₹200 is refused (₹100 more today); after ₹100 more, today's limit is reached",
  async ({ browser }) =>
    payoutSetup(async () => {
      const rider = await approvedRider("wddaily");
      await verifiedAccount(rider);
      await arrangeEarnings(rider.partnerId, [1_000_000, 20_000]);
      expectStatus(await withdraw(rider, 990_000), 201, "withdraw ₹9,900");
      const { context, page } = await pageOf(browser, rider);
      try {
        await page.goto("/gig/wallet");
        await checkAmount(page, "200");
        await expect(page.getByText(MESSAGES.more100, { exact: true })).toBeVisible();
        expectStatus(await withdraw(rider, 10_000), 201, "withdraw ₹100 more");
        await page.reload();
        await checkAmount(page, "100");
        await expect(page.getByText(MESSAGES.reached, { exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
      const transfers = await transfersOf(rider.partnerId);
      expect(transfers.map((t) => t.gross_paise).sort((a, b) => a - b)).toEqual([10_000, 990_000]);
      return "₹9,900 + ₹100 withdrawn; ₹200 and then ₹100 refused with the daily-limit messages";
    }),
  local,
);

qa(
  ["TC-RPAY-008"],
  "only approved delivery partners can withdraw: a customer and a shop owner are not partners; an applicant waits for approval",
  async ({ browser }) =>
    payoutSetup(
      async () => {
        const seen: string[] = [];
        // A customer and shop A's owner: not delivery partners.
        const customer = await localUser("nonrider");
        const shopOwnerPartner = await db()<{ id: string }[]>`select id from delivery_partners where user_id = ${world().users.shop?.id ?? null}`;
        const people = [{ who: "customer", ctx: customer.ctx, open: () => pageOf(browser, customer) }];
        if (!shopOwnerPartner.length) people.push({ who: "shop owner", ctx: await as("shop"), open: () => pageAs(browser, "shop") });
        for (const person of people) {
          const { context, page } = await person.open();
          try {
            await page.goto("/gig/wallet");
            await expect(page.getByText("You're not a delivery partner yet", { exact: true })).toBeVisible();
          } finally {
            await context.close();
          }
          const res = await call(person.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000 });
          expectStatus(res, 403, `${person.who} withdraws`);
          expect(res.body?.error?.message).toBe(MESSAGES.notPartner);
          seen.push(`${person.who}: 403`);
        }
        // An applicant not approved yet.
        const pending = await applicant("unapproved");
        await arrangeEarnings(pending.partnerId, [20_000]);
        const { context, page } = await pageOf(browser, pending);
        try {
          await page.goto("/gig/wallet");
          await expect(page.getByText(MESSAGES.notApproved, { exact: true })).toBeVisible();
        } finally {
          await context.close();
        }
        const res = await call(pending.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000 });
        expectStatus(res, 409, "an applicant withdraws");
        expect(res.body?.error?.message).toBe(MESSAGES.notApproved);
        seen.push("applicant: 409");
        return seen.join("; ") + (shopOwnerPartner.length ? " (shop A's owner is also a partner here: not checked)" : "");
      },
      { rider_bank_account_enabled: true, rider_withdrawal_enabled: true },
    ),
  local,
);

qa(
  ["TC-RPAY-009"],
  "no verified bank account, no withdrawal: page and API ask for a verified account",
  async ({ browser }) =>
    payoutSetup(
      async () => {
        const rider = await approvedRider("nobank");
        await arrangeEarnings(rider.partnerId, [50_000]);
        const { context, page } = await pageOf(browser, rider);
        try {
          await page.goto("/gig/wallet");
          await expect(page.getByText(MESSAGES.addVerify, { exact: true })).toBeVisible();
          let res = await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000, code: "123456" });
          expectStatus(res, 409, "withdraw without a bank account");
          expect(res.body?.error?.message).toBe(MESSAGES.addVerifyApi);
          // Saved but not verified: the same.
          expectStatus(await saveBankAccount(rider.ctx, rider.name), 200, "save an unverified account");
          await page.reload();
          await expect(page.getByText(MESSAGES.addVerify, { exact: true })).toBeVisible();
          res = await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000, code: "123456" });
          expectStatus(res, 409, "withdraw with an unverified account");
          expect(res.body?.error?.message).toBe(MESSAGES.addVerifyApi);
        } finally {
          await context.close();
        }
        expect(await transfersOf(rider.partnerId)).toHaveLength(0);
        return `no account and an unverified one: "${MESSAGES.addVerify}" / 409 "${MESSAGES.addVerifyApi}"`;
      },
      { rider_bank_account_enabled: true, rider_withdrawal_enabled: true },
    ),
  local,
);

qa(
  ["TC-RPAY-010"],
  "rider payouts switched off (routes 404, options hidden) and with no payout provider (withdrawals not available)",
  async ({ browser }) => {
    const rider = await approvedRider("flagsoff");
    const seen: string[] = [];
    // The account is verified while the flags are on (a verified account is needed for the no-provider part).
    await payoutSetup(async () => {
      await verifiedAccount(rider);
      await arrangeEarnings(rider.partnerId, [50_000]);
    });
    const { context, page } = await pageOf(browser, rider);
    try {
      // 1. The bank account flag off: the wallet does not exist.
      await payoutSetup(
        async () => {
          const res = await page.goto("/gig/wallet");
          expect(res?.status(), "/gig/wallet with the flag off").toBe(404);
          const api = await call(rider.ctx, "GET", "/api/gig/wallet");
          expectStatus(api, 404, "GET /api/gig/wallet with the flag off");
          expect(api.body?.error?.message).toBe("This feature is not available.");
          await page.goto("/gig/profile");
          await expect(page.getByRole("link", { name: "My wallet" })).toHaveCount(0);
          seen.push("bank flag off: wallet 404, no My wallet link");
        },
        { rider_bank_account_enabled: false, rider_withdrawal_enabled: false, rider_monthly_payout_enabled: false },
      );
      // 2. Withdrawals off: no withdraw panel, its routes 404.
      await payoutSetup(
        async () => {
          await page.goto("/gig/wallet");
          await expect(page.getByRole("heading", { name: "Bank account" })).toBeVisible();
          await expect(page.getByRole("heading", { name: "Withdraw to bank" })).toHaveCount(0);
          expectStatus(await call(rider.ctx, "GET", "/api/gig/wallet/quote?amountPaise=10000"), 404, "quote with withdrawals off");
          expectStatus(await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000 }), 404, "withdraw with withdrawals off");
          seen.push("withdrawal flag off: panel hidden, quote and withdraw 404");
        },
        { rider_bank_account_enabled: true, rider_withdrawal_enabled: false },
      );
      // 3. Both on, but the payout provider cannot send (RazorpayX without keys).
      await payoutSetup(
        async () => {
          const wallet = await call(rider.ctx, "GET", "/api/gig/wallet");
          expectStatus(wallet, 200, "GET /api/gig/wallet");
          if (wallet.body.available) blocked("RazorpayX payout keys are set on the local server, so there is no 'no provider' state to show");
          await page.goto("/gig/wallet");
          await expect(page.getByText(MESSAGES.noProvider, { exact: true })).toBeVisible();
          const res = await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000, code: "123456" });
          expectStatus(res, 409, "withdraw with no provider");
          expect(res.body?.error?.message).toBe(MESSAGES.noProvider);
          seen.push("no provider: message on the page, 409 from the API");
        },
        { rider_bank_account_enabled: true, rider_withdrawal_enabled: true },
        { riderPayouts: { ...PAYOUT_RULE, provider: "RAZORPAYX" } },
      );
    } finally {
      await context.close();
    }
    return seen.join("; ");
  },
  local,
);

/* ======================================================== TS-RPAY-03 */

qa(
  ["TC-RPAY-011"],
  "every withdrawal needs a fresh e-mailed code: a wrong code, an earlier withdrawal's code and no code make no payout; the fresh code works once",
  async ({ browser }) =>
    payoutSetup(async () => {
      const rider = await approvedRider("wdcode");
      await verifiedAccount(rider);
      await arrangeEarnings(rider.partnerId, [100_000]);
      // UI: a wrong code.
      const { context, page } = await pageOf(browser, rider);
      let first = "";
      try {
        await page.goto("/gig/wallet");
        await checkAmount(page, "100");
        await ageActionCodes(rider.email, "RIDER_WITHDRAWAL");
        const since = Date.now();
        await page.getByRole("button", { name: "Email me a code to confirm" }).click();
        first = await actionCode(rider.email, since);
        const wrong = first.slice(0, -1) + String((Number(first.slice(-1)) + 1) % 10);
        await page.getByLabel("Confirmation code").fill(wrong);
        await page.getByRole("button", { name: "Withdraw ₹100.00" }).click();
        await expect(page.getByText(MESSAGES.otp, { exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
      expect(await transfersOf(rider.partnerId), "no payout after a wrong code").toHaveLength(0);
      // The right code works once; used again (an earlier withdrawal's code) it is refused.
      expectStatus(await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000, code: first }), 201, "the fresh code");
      await ageActionCodes(rider.email, "RIDER_WITHDRAWAL");
      const second = await withdrawalCode(rider, 10_000);
      const old = await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000, code: first });
      expectStatus(old, 422, "an earlier withdrawal's code");
      expect(old.body?.error?.message).toBe(MESSAGES.otp);
      expect(await transfersOf(rider.partnerId)).toHaveLength(1);
      // Without a code the API only e-mails a new one.
      await ageActionCodes(rider.email, "RIDER_WITHDRAWAL");
      const since = Date.now();
      const bare = await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000 });
      expectStatus(bare, 200, "no code");
      expect(bare.body?.codeSent?.maskedEmail, "a code is e-mailed instead").toBeTruthy();
      expect(await transfersOf(rider.partnerId), "no payout without a code").toHaveLength(1);
      const third = await actionCode(rider.email, since);
      const superseded = await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000, code: second });
      expectStatus(superseded, 422, "a code replaced by a newer one");
      expectStatus(await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000, code: third }), 201, "the newest code");
      const again = await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise: 10_000, code: third });
      expectStatus(again, 422, "the same code twice");
      expect(await transfersOf(rider.partnerId)).toHaveLength(2);
      return "wrong / earlier / replaced / reused codes → 422, no code → code e-mailed only; 2 payouts from 2 fresh codes";
    }),
  local,
);

qa(
  ["TC-RPAY-012"],
  "changing a verified rider bank account needs the e-mailed code; the grant lasts 10 minutes, then a new code is asked",
  async ({ browser }) =>
    payoutSetup(
      async () => {
        const rider = await approvedRider("reauth");
        await verifiedAccount(rider);
        const { context, page } = await pageOf(browser, rider);
        const changeTo = "1111222255";
        try {
          await page.goto("/gig/wallet");
          await expect(page.getByText("Your account is verified. To change or remove it, first confirm it's you with a code we email you.", { exact: true })).toBeVisible();
          // Without the code: refused.
          await page.getByRole("button", { name: "Change details" }).click();
          await fillBankForm(page, rider.name, changeTo, changeTo, TEST_BANK.ifsc);
          expect((await saveAndWait(page)).status(), "a change without the code").toBe(403);
          await expect(page.getByText(MESSAGES.reauth, { exact: true })).toBeVisible();
          // The code: the change is allowed for 10 minutes.
          await ageActionCodes(rider.email, "RIDER_BANK_CHANGE");
          let since = Date.now();
          await page.getByRole("button", { name: "Email me a code", exact: true }).click();
          await page.getByLabel("Confirmation code").fill(await actionCode(rider.email, since));
          await page.getByRole("button", { name: "Confirm", exact: true }).click();
          await expect(page.getByText(/^Confirmed\. Change your bank details below \(or remove the account\) before /)).toBeVisible();
          const [grant] = await db()<{ id: string; minutes: number }[]>`select id, round(extract(epoch from (expires_at - created_at)) / 60)::int as minutes
            from rider_security_grants where user_id = ${rider.id} and used_at is null order by created_at desc limit 1`;
          expect(grant?.minutes, "the grant lasts 10 minutes").toBe(10);
          // 11 minutes later: the grant has run out, the change is refused again.
          await db()`update rider_security_grants set expires_at = now() - interval '1 minute' where id = ${grant.id}`;
          expect((await saveAndWait(page)).status(), "a change after the grant ran out").toBe(403);
          await expect(page.getByText(MESSAGES.reauth, { exact: true })).toBeVisible();
          // A new code: the change goes through.
          await page.reload();
          await ageActionCodes(rider.email, "RIDER_BANK_CHANGE");
          since = Date.now();
          await page.getByRole("button", { name: "Email me a code", exact: true }).click();
          await page.getByLabel("Confirmation code").fill(await actionCode(rider.email, since));
          await page.getByRole("button", { name: "Confirm", exact: true }).click();
          await expect(page.getByText(/^Confirmed\. /)).toBeVisible();
          await page.getByRole("button", { name: "Change details" }).click();
          await fillBankForm(page, rider.name, changeTo, changeTo, TEST_BANK.ifsc);
          expect((await saveAndWait(page)).status(), "a change with a fresh code").toBe(200);
          await expect(page.getByText("Saved. Now verify it with a ₹1 payment, refunded straight away.", { exact: true })).toBeVisible();
        } finally {
          await context.close();
        }
        const account = (await call(rider.ctx, "GET", "/api/bank-account")).body.account;
        expect(account.accountNumberMasked).toContain("2255");
        return `refused without a code; code → 10-minute grant; expired grant refused; new code → changed to ••${account.accountNumberMasked.slice(-4)}`;
      },
      { rider_bank_account_enabled: true },
    ),
  local,
);

/* ======================================================== TS-RPAY-04 */

qa(
  ["TC-RPAY-013"],
  "monthly payout (admin Run now): rider with ≥ ₹100 paid by NEFT; rider under ₹100 carried forward; the 5th from 09:00 shown",
  async ({ browser }) =>
    payoutSetup(async () => {
      const { month, inside } = await unusedPastMonth();
      const paid = await approvedRider("monthpaid");
      await verifiedAccount(paid);
      await arrangeEarnings(paid.partnerId, [30_000, 20_000], inside);
      const carried = await approvedRider("monthcarry");
      await verifiedAccount(carried);
      await arrangeEarnings(carried.partnerId, [5_000], inside);
      const since = new Date();

      const { context, page } = await pageAs(browser, "admin");
      let runId = "";
      try {
        await page.goto("/admin/rider-payouts");
        await expect(page.getByText(/^Monthly run on day 5 from 09:00 IST \(on\)/)).toBeVisible();
        await page.getByLabel("Month to pay").fill(month);
        page.once("dialog", (dialog) => void dialog.accept());
        const [answer] = await Promise.all([
          page.waitForResponse((r) => r.url().endsWith("/api/admin/rider-payouts/runs") && r.request().method() === "POST", { timeout: 120_000 }),
          page.getByRole("button", { name: "Run now" }).click(),
        ]);
        expect(answer.status(), "Run now").toBe(200);
        const result = (await answer.json()) as { runId?: string; created?: number; skipped?: number | string };
        expect(result.created, `Run now created the payment (${JSON.stringify(result)})`).toBeGreaterThanOrEqual(1);
        runId = String(result.runId);
        await page.goto(`/admin/rider-payouts/${runId}`);
        await expect(page.getByRole("heading", { name: `Rider payout — ${monthLabel(month)}` })).toBeVisible();
        await expect(page.getByRole("main")).toContainText(`${paid.name} · ₹500.00`);
        await expect(page.getByRole("main")).toContainText(`${carried.name}Below the minimum · ₹50.00`);
      } finally {
        await context.close();
      }
      const [t] = await transfersOf(paid.partnerId);
      expect({ kind: t.kind, mode: t.mode, gross: t.gross_paise, run: t.run_id }).toEqual({ kind: "MONTHLY", mode: "NEFT", gross: 50_000, run: runId });
      expect(await transfersOf(carried.partnerId), "nothing sent under ₹100").toHaveLength(0);
      const notes = await notificationsTo(carried.id, since);
      const note = notes.find((n) => n.title === `${monthLabel(month)} earnings carried forward`);
      expect(note?.body, "the carry-forward notification").toContain("it is below the minimum payout.");

      const riderView = await pageOf(browser, paid);
      try {
        const p = riderView.page;
        await p.goto("/gig/wallet");
        await expect(p.getByText(/^On the 5th of every month \(from 09:00\) we pay what is still unpaid for the month before/)).toBeVisible();
        await p.getByRole("link", { name: /Monthly payout · ₹500\.00/ }).click();
        await expect(p.getByRole("heading", { name: "Monthly payout statement" })).toBeVisible();
        await expect(p.getByRole("main")).toContainText("Sent byNEFT");
      } finally {
        await riderView.context.close();
      }
      const carriedView = await pageOf(browser, carried);
      try {
        await carriedView.page.goto("/gig/wallet");
        await expect(unpaid(carriedView.page)).toContainText("₹50.00");
      } finally {
        await carriedView.context.close();
      }
      return `${monthLabel(month)}: ₹500 by NEFT (${t.status}); ₹50 carried forward and the rider told why`;
    }),
  local,
);

qa(
  ["TC-RPAY-014"],
  "a refused withdrawal goes straight back to the balance; a refused monthly transfer is retried 3 times, 60 min × attempt apart, then sent to finance",
  async ({ browser }) =>
    payoutSetup(async () => {
      // Withdrawal: the sandbox refuses amounts ending in 98 paise.
      const rider = await approvedRider("refused");
      await verifiedAccount(rider);
      await arrangeEarnings(rider.partnerId, [20_000]);
      const { context, page } = await pageOf(browser, rider);
      try {
        await page.goto("/gig/wallet");
        await checkAmount(page, "100.98");
        await ageActionCodes(rider.email, "RIDER_WITHDRAWAL");
        const since = Date.now();
        await page.getByRole("button", { name: "Email me a code to confirm" }).click();
        await page.getByLabel("Confirmation code").fill(await actionCode(rider.email, since));
        await page.getByRole("button", { name: "Withdraw ₹100.98" }).click();
        await expect(page.getByText("The bank refused the transfer: Beneficiary bank is offline (sandbox). The amount is back in your balance.", { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(unpaid(page)).toContainText("₹200.00");
        const [w] = await transfersOf(rider.partnerId);
        expect({ status: w.status, retries: w.retry_count, next: w.next_retry_at }).toEqual({ status: "RELEASED", retries: 0, next: null });
        await page.goto(`/gig/wallet/payouts/${w.id}`);
        await expect(page.getByText("Failed — back in balance", { exact: true })).toBeVisible();
        await expect(page.getByText("Beneficiary bank is offline (sandbox).", { exact: true })).toBeVisible();
      } finally {
        await context.close();
      }

      // Monthly: retried with the backoff, then flagged for finance.
      const { month, inside } = await unusedPastMonth();
      const monthly = await approvedRider("retries");
      await verifiedAccount(monthly);
      await arrangeEarnings(monthly.partnerId, [15_098], inside);
      const since = new Date();
      const run = await call(await as("admin"), "POST", "/api/admin/rider-payouts/runs", { month });
      expectStatus(run, 200, `run ${month}`);
      const gaps: number[] = [];
      let [t] = await transfersOf(monthly.partnerId);
      // The hourly job retries; the monthly flag goes off meanwhile so it does not pay last month for everyone.
      const restoreMonthly = await setFlags({ rider_monthly_payout_enabled: false });
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          expect(t.status, `after attempt ${attempt + 1}`).toBe("FAILED");
          if (attempt < 3) {
            expect(t.retry_count).toBe(attempt);
            expect(t.needs_review).toBe(false);
            gaps.push(Math.round((t.next_retry_at!.getTime() - t.updated_at.getTime()) / 60_000));
            await db()`update rider_bank_transfers set next_retry_at = now() - interval '1 minute' where id = ${t.id}`;
            expectStatus(await cron("hourly"), 200, "the hourly job");
            [t] = await transfersOf(monthly.partnerId);
          }
        }
      } finally {
        await restoreMonthly();
      }
      expect(gaps, "minutes to each retry: 60 × attempt").toEqual([60, 120, 180]);
      expect({ retries: t.retry_count, review: t.needs_review, next: t.next_retry_at }).toEqual({ retries: 3, review: true, next: null });
      const notes = await notificationsTo(monthly.id, since);
      expect(notes.some((n) => n.title === "Payment to your bank failed" && n.body.includes("Our finance team will retry it or return it to your balance.")), "the rider is told").toBe(true);
      const admin = await pageAs(browser, "admin");
      try {
        await admin.page.goto("/admin/rider-payouts");
        await expect(admin.page.getByRole("main")).toContainText(`${monthly.name} · Monthly payout · ₹150.98`);
      } finally {
        await admin.context.close();
      }
      return `withdrawal ₹100.98 refused → back in balance (RELEASED, no retry); monthly ₹150.98 retried after ${gaps.join(" / ")} min, then "Needs a decision"`;
    }),
  local,
);

/* ======================================================== TS-RPAY-05 */

qa(
  ["TC-RPAY-016"],
  "TDS 194C on a single payment: none at ₹30,000; above it 1% with PAN and 20% without, shown on the statement and in admin",
  async ({ browser }) =>
    payoutSetup(async () => {
      const withPan = await approvedRider("tdspan", { pan: true });
      const noPan = await approvedRider("tdsnopan", { pan: false });
      const atLimit = await approvedRider("tdsedge", { pan: true });
      for (const r of [withPan, noPan, atLimit]) await verifiedAccount(r);
      // What a payment would pay (the quote works the same TDS as a payment).
      const q = {
        pan30: await quote(withPan.ctx, 3_000_000),
        pan31: await quote(withPan.ctx, 3_100_000),
        noPan30: await quote(noPan.ctx, 3_000_000),
        noPan31: await quote(noPan.ctx, 3_100_000),
      };
      expect([q.pan30.tdsPaise, q.pan31.tdsPaise, q.pan31.tdsRateBp, q.noPan30.tdsPaise, q.noPan31.tdsPaise, q.noPan31.tdsRateBp]).toEqual([0, 31_000, 100, 0, 620_000, 2000]);

      const { month, inside } = await unusedPastMonth();
      await arrangeEarnings(withPan.partnerId, [3_100_000], inside);
      await arrangeEarnings(noPan.partnerId, [3_100_000], inside);
      await arrangeEarnings(atLimit.partnerId, [3_000_000], inside);
      expectStatus(await call(await as("admin"), "POST", "/api/admin/rider-payouts/runs", { month }), 200, `run ${month}`);
      const [a] = await transfersOf(withPan.partnerId);
      const [b] = await transfersOf(noPan.partnerId);
      const [c] = await transfersOf(atLimit.partnerId);
      expect([a.tds_paise, a.tds_rate_bp, a.net_paise]).toEqual([31_000, 100, 3_069_000]);
      expect([b.tds_paise, b.tds_rate_bp, b.net_paise]).toEqual([620_000, 2000, 2_480_000]);
      expect([c.tds_paise, c.net_paise]).toEqual([0, 3_000_000]);

      for (const [r, t, label, amount] of [
        [withPan, a, "TDS (1%, s.194C)", "₹310.00"],
        [noPan, b, "TDS (20%, s.194C)", "₹6,200.00"],
        [atLimit, c, "TDS", "None"],
      ] as const) {
        const view = await pageOf(browser, r);
        try {
          await view.page.goto(`/gig/wallet/payouts/${t.id}`);
          await expect(view.page.getByRole("main")).toContainText(`${label}${label === "TDS" ? "" : "− "}${amount}`);
        } finally {
          await view.context.close();
        }
      }
      const admin = await pageAs(browser, "admin");
      try {
        await admin.page.goto(`/admin/rider-payouts/${a.run_id}`);
        await expect(admin.page.getByRole("main")).toContainText("(gross ₹31,000.00, TDS ₹310.00)");
        await expect(admin.page.getByRole("main")).toContainText("(gross ₹31,000.00, TDS ₹6,200.00)");
        await expect(admin.page.getByRole("main")).toContainText("(gross ₹30,000.00, TDS ₹0.00)");
      } finally {
        await admin.context.close();
      }
      return "₹30,000: no TDS; ₹31,000 with PAN: ₹310 (1%); without PAN: ₹6,200 (20%) — on the statement and the admin run";
    }),
  { ...local, partial: "the yearly ₹1,00,000 limit is the next check" },
);

qa(
  ["TC-RPAY-016"],
  "TDS 194C over the year: none while the year's payments stay at ₹1,00,000; past it 1% of the year's total (with PAN), shown on the withdrawal",
  async ({ browser }) =>
    payoutSetup(async () => {
      const rider = await approvedRider("tdsyear", { pan: true });
      await verifiedAccount(rider);
      await arrangePaidThisYear(rider.partnerId, 9_900_000);
      await arrangeEarnings(rider.partnerId, [200_000]);
      const atLimit = await quote(rider.ctx, 100_000);
      expect(atLimit.tdsPaise, "₹99,000 + ₹1,000 = ₹1,00,000: not above the limit").toBe(0);
      const { context, page } = await pageOf(browser, rider);
      try {
        await page.goto("/gig/wallet");
        await checkAmount(page, "2000");
        await expect(page.getByText("TDS (1%)", { exact: true })).toBeVisible();
        await expect(page.getByText("− ₹1,010.00", { exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
      const done = await withdraw(rider, 200_000);
      expectStatus(done, 201, "withdraw ₹2,000");
      expect([done.body.tdsPaise, done.body.tdsRateBp, done.body.netPaise], "1% of ₹1,01,000").toEqual([101_000, 100, 99_000]);
      const view = await pageOf(browser, rider);
      try {
        await view.page.goto(`/gig/wallet/payouts/${done.body.id}`);
        await expect(view.page.getByRole("main")).toContainText("TDS (1%, s.194C)− ₹1,010.00");
      } finally {
        await view.context.close();
      }
      const admin = await pageAs(browser, "admin");
      try {
        await admin.page.goto("/admin/rider-payouts");
        await expect(admin.page.getByRole("main")).toContainText(`${rider.name} · ₹2,000.00 (TDS ₹1,010.00)`);
      } finally {
        await admin.context.close();
      }
      return "₹99,000 paid this year: ₹1,000 more → no TDS; ₹2,000 → ₹1,010 (1% of ₹1,01,000), on the statement and in admin";
    }),
  { ...local, partial: "single-payment limit and the 20% rate are the previous check" },
);
