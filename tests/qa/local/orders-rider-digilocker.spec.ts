/**
 * Delivery partner Aadhaar through DigiLocker (TS-DEL-09, docs/gig-worker-2026-10):
 * the KYC page (/delivery-partner/kyc, "Step 2 of 3"), the DigiLocker mock
 * (/mobile-auth/digilocker-mock — the stand-in staging and local runs use; the
 * real DigiLocker needs a real Aadhaar and is never driven here), each outcome
 * (declined, expired, name mismatch, vendor down, already used by another
 * partner) and the admin's "Resend DigiLocker link".
 *
 * Local tier: every check registers its own new applicant (a new account, the
 * full registration form through the API) and sets rule riderVerification to
 * DigiLocker through the mock, put back afterwards. TC-DEL-035 arranges "the
 * same DigiLocker account" on two partners by giving the first partner's
 * verified check the token of the second partner's mock DigiLocker account.
 */
import type { Page } from "@playwright/test";

import {
  applicant,
  blindIndex,
  decideMock,
  digilockerMockRule,
  kycRow,
  mockHolderOf,
  notificationsTo,
  pageOf,
  riderPan,
  startDigilocker,
  type Rider,
} from "../lib/rider-payout-helpers";
import { pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus } from "../lib/http";
import { expect, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 240_000 };

const TEXT = {
  denied: "DigiLocker did not share your Aadhaar (consent was declined or not finished). Start again to retry.",
  expired: "The DigiLocker link expired before it was finished. Start again.",
  mismatch: "The name on the record doesn't match your registered name closely enough. Our team will check it.",
  down: "The verification service is not answering right now. We'll check again, or you can retry later.",
  alreadyUsed: "This number is already verified for another delivery partner. Contact support if it is yours.",
};

/** The Aadhaar card's status line (its masked number always has the "XXXX XXXX" form; the PAN's does not). */
const aadhaarStatus = (page: Page) => page.getByTestId("kyc-status").filter({ hasText: "XXXX XXXX" });

/** On the KYC page: tick the consent, then "Verify with DigiLocker" (or "Continue in DigiLocker") → the mock page. */
async function openDigilocker(page: Page, button: "Verify with DigiLocker" | "Continue in DigiLocker" = "Verify with DigiLocker") {
  await page.getByTestId("kyc-consent").check();
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.waitForURL(/\/mobile-auth\/digilocker-mock\?session=/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "DigiLocker — test page" })).toBeVisible();
}

/** On the mock page: one of its buttons, then back on the KYC page with ?digilocker=<result>. */
async function chooseOnMock(page: Page, label: string, result: "verified" | "pending" | "failed") {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForURL(new RegExp(`/delivery-partner/kyc\\?digilocker=${result}`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "PAN and Aadhaar verification" })).toBeVisible();
}

async function withMockRule<T>(body: () => Promise<T>): Promise<T> {
  const restore = await digilockerMockRule();
  try {
    return await body();
  } finally {
    await restore();
  }
}

qa(
  ["TC-DEL-032"],
  "rider verifies PAN and Aadhaar through the DigiLocker mock: back on ?digilocker=verified, Aadhaar Verified as XXXX XXXX 4321, only the name and last 4 kept",
  async ({ browser }) =>
    withMockRule(async () => {
      const rider = await applicant("dlok", { pan: false });
      const { context, page } = await pageOf(browser, rider);
      try {
        await page.goto("/delivery-partner/kyc");
        await expect(page.getByRole("heading", { name: "PAN and Aadhaar verification" })).toBeVisible();
        await expect(page.getByText(/^Step 2 of 3\./)).toBeVisible();
        // The buttons wait for the consent.
        await expect(page.getByRole("button", { name: "Verify with DigiLocker" })).toBeDisabled();
        await page.getByTestId("kyc-consent").check();
        await page.getByTestId("kyc-pan").fill(riderPan());
        await page.getByRole("button", { name: "Verify PAN" }).click();
        const panStatus = page.getByTestId("kyc-status").filter({ hasText: /XXXXX\d{4}[A-Z]/ });
        await expect(panStatus).toContainText("Verified", { timeout: 30_000 });

        await openDigilocker(page);
        await chooseOnMock(page, "Approve — share my Aadhaar", "verified");
        await expect(aadhaarStatus(page)).toContainText("Verified");
        await expect(aadhaarStatus(page)).toContainText("XXXX XXXX 4321");
        await expect(page.getByText("KYC complete")).toBeVisible();

        const row = await kycRow(rider.partnerId, "AADHAAR");
        expect(row, "the Aadhaar check row").not.toBeNull();
        expect(row!.status).toBe("VERIFIED");
        expect(row!.method).toBe("digilocker");
        expect(row!.number_masked).toBe("XXXX XXXX 4321");
        expect(row!.number_encrypted, "no Aadhaar number stored, not even encrypted").toBeNull();
        expect(row!.number_token, "a keyed token, never digits").toMatch(/^[0-9a-f]{64}$/);
        const kyc = await call(rider.ctx, "GET", "/api/delivery-partner/me/kyc");
        expect(JSON.stringify(kyc.body), "no 12-digit number in the partner's answer").not.toMatch(/\d{12}/);
        return `Aadhaar ${row!.number_masked} Verified by DigiLocker (mock); name kept: ${row!.name_on_record ?? "none (the mock shares none)"}`;
      } finally {
        await context.close();
      }
    }),
  { ...local, mobile: true, partial: "the page's re-check after DigiLocker (up to 6 × 5 s) is not exercised: the mock settles on the return link, so the page opens already Verified" },
);

qa(
  ["TC-DEL-033"],
  "declined consent and an expired link are explained (Failed) and a new attempt works",
  async ({ browser }) =>
    withMockRule(async () => {
      const rider = await applicant("dlretry", { pan: false });
      const { context, page } = await pageOf(browser, rider);
      try {
        await page.goto("/delivery-partner/kyc");
        // An unfinished link is offered again as "Continue in DigiLocker".
        await openDigilocker(page);
        const firstSession = new URL(page.url()).searchParams.get("session");
        await page.goto("/delivery-partner/kyc");
        await expect(page.getByRole("button", { name: "Continue in DigiLocker" })).toBeVisible();
        await openDigilocker(page, "Continue in DigiLocker");
        expect(new URL(page.url()).searchParams.get("session"), "the same DigiLocker link is handed out again").toBe(firstSession);

        await chooseOnMock(page, "Deny", "failed");
        await expect(aadhaarStatus(page)).toContainText("Failed");
        await expect(aadhaarStatus(page)).toContainText(TEXT.denied);
        await expect(page.getByRole("button", { name: "Verify with DigiLocker" })).toBeVisible();

        await openDigilocker(page);
        await chooseOnMock(page, "Let the link expire", "failed");
        await expect(aadhaarStatus(page)).toContainText("Failed");
        await expect(aadhaarStatus(page)).toContainText(TEXT.expired);

        await openDigilocker(page);
        await chooseOnMock(page, "Approve — share my Aadhaar", "verified");
        await expect(aadhaarStatus(page)).toContainText("Verified");
        expect((await kycRow(rider.partnerId, "AADHAAR"))!.status).toBe("VERIFIED");
        return "Deny → Failed with the declined message; expire → Failed with the expired message; retry → Verified";
      } finally {
        await context.close();
      }
    }),
  local,
);

qa(
  ["TC-DEL-034"],
  "name mismatch and DigiLocker down stay Pending with their messages and show in admin's rider verification",
  async ({ browser }) =>
    withMockRule(async () => {
      const mismatch = await applicant("dlname", { pan: false });
      const down = await applicant("dldown", { pan: false });
      const seen: string[] = [];
      for (const [rider, label, message] of [
        [mismatch, "Approve — Aadhaar in another name", TEXT.mismatch],
        [down, "DigiLocker is down", TEXT.down],
      ] as [Rider, string, string][]) {
        const { context, page } = await pageOf(browser, rider);
        try {
          await page.goto("/delivery-partner/kyc");
          await openDigilocker(page);
          await chooseOnMock(page, label, "pending");
          await expect(aadhaarStatus(page)).toContainText("Pending");
          await expect(aadhaarStatus(page)).toContainText(message);
          const row = await kycRow(rider.partnerId, "AADHAAR");
          expect(row!.status, `${label}: Pending, not Failed`).toBe("PENDING");
          seen.push(`${label}: ${row!.error_code}`);
        } finally {
          await context.close();
        }
      }
      const { context, page } = await pageAs(browser, "admin");
      try {
        await page.goto("/admin/rider-verification");
        const checks = page.getByTestId("admin-kyc-checks");
        const nameRow = checks.getByRole("listitem").filter({ hasText: mismatch.name }).filter({ hasText: "XXXX XXXX" });
        await expect(nameRow).toContainText("pending");
        await expect(nameRow).toContainText("Name on record: SOMEONE ELSE ENTIRELY");
        const downRow = checks.getByRole("listitem").filter({ hasText: down.name }).filter({ hasText: "XXXX XXXX" });
        await expect(downRow).toContainText("pending");
        await expect(downRow).toContainText("KYC provider not answering (vendor_source_down)");
        await expect(downRow.getByRole("button", { name: "Resend DigiLocker link" })).toBeVisible();
      } finally {
        await context.close();
      }
      return seen.join("; ");
    }),
  local,
);

qa(
  ["TC-DEL-035"],
  "an Aadhaar (DigiLocker account) already verified for one partner fails for another: already-used message, not verified",
  async ({ browser }) =>
    withMockRule(async () => {
      // Partner 1 verifies through DigiLocker.
      const first = await applicant("dlone", { pan: false });
      const one = await startDigilocker(first);
      const back = await decideMock(first, one.session!, "approve");
      expect(back.location, "partner 1 verified").toMatch(/digilocker=verified/);
      // Partner 2 opens DigiLocker; it is the same DigiLocker account as partner 1's (arranged: partner 1's
      // verified check carries the token of the account the mock signs partner 2 in as).
      const second = await applicant("dltwo", { pan: false });
      const two = await startDigilocker(second);
      const sameAccount = blindIndex("RIDER_AADHAAR_DIGILOCKER", mockHolderOf(two.session!));
      await db()`update delivery_partner_kyc_checks set number_token = ${sameAccount} where delivery_partner_id = ${first.partnerId} and doc_type = 'AADHAAR' and status = 'VERIFIED'`;

      const { context, page } = await pageOf(browser, second);
      try {
        await page.goto(two.url);
        await chooseOnMock(page, "Approve — share my Aadhaar", "failed");
        await expect(aadhaarStatus(page)).toContainText("Failed");
        await expect(aadhaarStatus(page)).toContainText(TEXT.alreadyUsed);
      } finally {
        await context.close();
      }
      const row = await kycRow(second.partnerId, "AADHAAR");
      expect(row!.status).toBe("FAILED");
      expect(row!.error_code).toBe("already_used");
      expect((await kycRow(first.partnerId, "AADHAAR"))!.status, "partner 1 stays Verified").toBe("VERIFIED");
      // "The same Aadhaar" is arranged by token: the mock signs every session in as a new DigiLocker account.
      return `partner 2: ${row!.status} (${row!.error_code}), ${row!.number_masked}; partner 1 stays Verified`;
    }),
  local,
);

qa(
  ["TC-DEL-036"],
  "admin resends the DigiLocker link: the partner is notified, the new link opens and verifies, the old link changes nothing",
  async ({ browser }) =>
    withMockRule(async () => {
      const rider = await applicant("dlresend", { pan: false });
      const old = await startDigilocker(rider);
      const before = await kycRow(rider.partnerId, "AADHAAR");
      expect(before!.status).toBe("PENDING");
      const since = new Date();

      const { context, page } = await pageAs(browser, "admin");
      try {
        await page.goto("/admin/rider-verification");
        const row = page.getByTestId("admin-kyc-checks").getByRole("listitem").filter({ hasText: rider.name }).filter({ hasText: "XXXX XXXX" });
        await row.getByRole("button", { name: "Resend DigiLocker link" }).click();
        await expect.poll(async () => (await kycRow(rider.partnerId, "AADHAAR"))!.session_id, { timeout: 20_000 }).not.toBe(before!.session_id);
      } finally {
        await context.close();
      }
      const after = await kycRow(rider.partnerId, "AADHAAR");
      expect(after!.error_code).toBe("digilocker_resent");
      const notes = await notificationsTo(rider.id, since);
      const note = notes.find((n) => n.title === "Finish your Aadhaar check in DigiLocker");
      expect(note, `the partner's notification (got: ${notes.map((n) => n.title).join(" | ")})`).toBeTruthy();
      expect(note!.action_url).toBe("/delivery-partner/kyc/digilocker/open");

      // The notification's link opens the new DigiLocker session.
      const open = await call(rider.ctx, "GET", "/delivery-partner/kyc/digilocker/open");
      expectStatus(open, 303, "the resend link");
      expect(open.location ?? "").toContain(`session=${after!.session_id}`);
      // The old link: DigiLocker's return for it finds no check; nothing changes.
      const stale = await decideMock(rider, old.session!, "approve");
      expect(stale.location, "the old link's return").toMatch(/digilocker=unknown/);
      expect((await kycRow(rider.partnerId, "AADHAAR"))!.status, "still Pending after the old link").toBe("PENDING");

      const { context: riderContext, page: riderPage } = await pageOf(browser, rider);
      try {
        await riderPage.goto("/delivery-partner/kyc");
        await expect(aadhaarStatus(riderPage)).toContainText("Pending");
        await expect(riderPage.getByRole("button", { name: "Continue in DigiLocker" })).toBeVisible();
        await riderPage.goto(open.location!);
        await chooseOnMock(riderPage, "Approve — share my Aadhaar", "verified");
        await expect(aadhaarStatus(riderPage)).toContainText("Verified");
      } finally {
        await riderContext.close();
      }
      return `session ${before!.session_id?.slice(-8)} → ${after!.session_id?.slice(-8)}; old link → unknown; new link → Verified`;
    }),
  local,
);
