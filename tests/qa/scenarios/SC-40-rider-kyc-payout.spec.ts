/**
 * SC-40 — Delivery partner: DigiLocker KYC to first withdrawal
 * (docs/gig-worker-2026-10, docs/gig-bank-payouts-2026-10), one partner end
 * to end on the local server:
 *
 *   1. applies, verifies PAN and Aadhaar on the KYC page (DigiLocker mock);
 *      operations approves
 *   2. earns (unpaid earnings, as finished deliveries leave them)
 *   3. adds a bank account — checked with the bank (Secure ID) when the
 *      server has the Cashfree Verification Suite keys, else with the ₹1 test
 *      gateway
 *   4. withdraws ₹100 with the e-mailed code: IMPS, no fee, no TDS
 *   5. the monthly payout (admin "Run now" for a past month): NEFT; TDS
 *      checked against the 194C limits (none below them)
 *
 * Local tier: rule riderVerification (DigiLocker mock), the three rider flags
 * and rule riderPayouts are set for the run and put back.
 */
import { as } from "../lib/actors";
import { setRules } from "../lib/finance-helpers";
import { call, expectStatus } from "../lib/http";
import { expect, qa } from "../lib/record";
import {
  actionCode,
  ageActionCodes,
  ALL_RIDER_FLAGS_ON,
  applicant,
  approve,
  arrangeEarnings,
  kycRow,
  pageOf,
  riderPan,
  saveBankAccount,
  SECURE_ID_SAMPLE,
  setFlags,
  transfersOf,
  unusedPastMonth,
  verifiedAccount,
} from "../lib/rider-payout-helpers";

qa(
  "SC-40",
  "delivery partner: DigiLocker KYC, approval, earnings, bank account, ₹100 withdrawal with the e-mailed code, monthly NEFT payout, TDS within the 194C limits",
  async ({ browser }) => {
    const restoreFlags = await setFlags(ALL_RIDER_FLAGS_ON);
    let restoreRules: (() => Promise<void>) | null = null;
    const steps: string[] = [];
    try {
      restoreRules = await setRules({
        riderVerification: { aadhaarMethod: "digilocker", digilockerProvider: "mock" },
        riderPayouts: {
          withdrawalMinPaise: 10_000,
          withdrawalMaxPaise: 1_000_000,
          withdrawalDailyMaxPaise: 1_000_000,
          withdrawalFeePaise: 0,
          withdrawalMode: "IMPS",
          monthlyMinPaise: 10_000,
          monthlyMode: "NEFT",
          provider: "SANDBOX",
          sandboxAutoWebhook: true,
          tdsEnabled: true,
          tdsRatePanBp: 100,
          tdsRateNoPanBp: 2000,
          singlePaymentThresholdPaise: 3_000_000,
          annualThresholdPaise: 10_000_000,
        },
      });

      /* 1. PAN and Aadhaar (DigiLocker mock) on the KYC page; operations approves. */
      const rider = await applicant("journey", { pan: false });
      const { context, page } = await pageOf(browser, rider);
      try {
        await page.goto("/delivery-partner/kyc");
        await page.getByTestId("kyc-consent").check();
        await page.getByTestId("kyc-pan").fill(riderPan());
        await page.getByRole("button", { name: "Verify PAN" }).click();
        await expect(page.getByTestId("kyc-status").filter({ hasText: /XXXXX\d{4}[A-Z]/ })).toContainText("Verified", { timeout: 30_000 });
        await page.getByRole("button", { name: "Verify with DigiLocker" }).click();
        await page.waitForURL(/\/mobile-auth\/digilocker-mock\?session=/);
        await page.getByRole("button", { name: "Approve — share my Aadhaar", exact: true }).click();
        await page.waitForURL(/\/delivery-partner\/kyc\?digilocker=verified/);
        await expect(page.getByTestId("kyc-status").filter({ hasText: "XXXX XXXX" })).toContainText("XXXX XXXX 4321");
      } finally {
        await context.close();
      }
      const aadhaar = await kycRow(rider.partnerId, "AADHAAR");
      expect({ status: aadhaar?.status, masked: aadhaar?.number_masked, stored: aadhaar?.number_encrypted }, "Aadhaar kept masked only").toEqual({ status: "VERIFIED", masked: "XXXX XXXX 4321", stored: null });
      await approve(rider);
      steps.push("KYC: PAN Verified, Aadhaar XXXX XXXX 4321 (DigiLocker mock); approved");

      /* 2. Earnings. */
      await arrangeEarnings(rider.partnerId, [40_000, 30_000]);
      steps.push("earned ₹700");

      /* 3. Bank account: the bank check when the server can ask the bank, else ₹1. */
      const bankCheck = await call(await as("admin"), "GET", "/api/admin/bank-account-check");
      const secureId = bankCheck.status === 200 && bankCheck.body.enabled && bankCheck.body.configured && bankCheck.body.env === "sandbox";
      if (secureId) {
        const saved = await saveBankAccount(rider.ctx, SECURE_ID_SAMPLE.name, SECURE_ID_SAMPLE);
        expectStatus(saved, 200, "save the bank account");
        expect({ status: saved.body.status, by: saved.body.matchMethod }, "verified by the bank check").toEqual({ status: "VERIFIED", by: "BANK_CHECK" });
        steps.push("bank account verified with the bank (Secure ID)");
      } else {
        await verifiedAccount(rider);
        steps.push("bank account verified with ₹1 (no Verification Suite keys on this server)");
      }

      /* 4. ₹100 withdrawal with the e-mailed code. */
      const wallet = await pageOf(browser, rider);
      try {
        const p = wallet.page;
        await p.goto("/gig/wallet");
        await p.getByLabel("Amount to withdraw in rupees").fill("100");
        await p.getByRole("button", { name: "Check", exact: true }).click();
        await expect(p.getByRole("main")).toContainText("Amount₹100.00FeeNone");
        await ageActionCodes(rider.email, "RIDER_WITHDRAWAL");
        const since = Date.now();
        await p.getByRole("button", { name: "Email me a code to confirm" }).click();
        await p.getByLabel("Confirmation code").fill(await actionCode(rider.email, since));
        await p.getByRole("button", { name: "Withdraw ₹100.00" }).click();
        await expect(p.getByText(/^₹100\.00 (has been paid|is on its way) to your bank\.$/)).toBeVisible({ timeout: 30_000 });
      } finally {
        await wallet.context.close();
      }
      const [w] = await transfersOf(rider.partnerId);
      expect({ kind: w.kind, mode: w.mode, gross: w.gross_paise, fee: w.fee_paise, tds: w.tds_paise }).toEqual({ kind: "WITHDRAWAL", mode: "IMPS", gross: 10_000, fee: 0, tds: 0 });
      steps.push(`withdrew ₹100 by IMPS, fee ₹0, TDS ₹0 (${w.status})`);

      /* 5. Monthly payout for a past month (admin Run now); TDS against the 194C limits. */
      const { month, inside } = await unusedPastMonth();
      await arrangeEarnings(rider.partnerId, [25_000], inside);
      const run = await call(await as("admin"), "POST", "/api/admin/rider-payouts/runs", { month });
      expectStatus(run, 200, `Run now ${month}`);
      const monthly = (await transfersOf(rider.partnerId)).find((t) => t.kind === "MONTHLY");
      expect(monthly, "a monthly payment").toBeTruthy();
      expect({ mode: monthly!.mode, gross: monthly!.gross_paise, tds: monthly!.tds_paise }).toEqual({ mode: "NEFT", gross: 25_000, tds: 0 });
      const left = (await call(rider.ctx, "GET", "/api/gig/wallet")).body.balance.availablePaise;
      expect(left, "the rest stays unpaid for the next payout").toBe(60_000);
      steps.push(`monthly ${month}: ₹250 by NEFT, TDS ₹0 (below ₹30,000 single and ₹1,00,000 a year); ₹600 still unpaid`);
      return steps.join(" → ");
    } finally {
      if (restoreRules) await restoreRules();
      await restoreFlags();
    }
  },
  {
    tier: "local",
    timeout: 420_000,
    partial:
      "deliveries are arranged as earnings rows (the delivery itself is SC-GW / SC-01); the bank check uses the ₹1 test gateway unless the local server has Cashfree Verification Suite sandbox keys; TDS above the limits is TC-RPAY-016",
  },
);
