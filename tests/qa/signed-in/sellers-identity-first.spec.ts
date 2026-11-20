/**
 * Identity-first shop registration (/shop/register, owner brief 08-Nov-2026) — the part of
 * TC-ONB-048 … TC-ONB-069 that is safe on test.gokesari.com: the identity screen looked at and
 * typed into by a test account that owns no shop.
 *
 * Nothing reaches the government check and no registration is created: every wizard write the
 * page tries is stopped in the browser (guardWizardWrites), except the unknown referral code
 * NOSUCH99 in TC-ONB-053, which the server refuses before it creates anything. The numbers typed
 * are made up for the run (or fail the screen's own format check) and never leave the browser.
 * The checks themselves (verified, refused, service down, hourly limit) and the later steps are
 * in tests/qa/local/sellers-identity-first.spec.ts, with the local mock KYC vendor.
 */
import type { Page } from "@playwright/test";

import { pageAs } from "../lib/actors";
import { blocked, expect, qa } from "../lib/record";
import {
  gstCertificatePhoto,
  guardWizardWrites,
  IDENTITY,
  needEditableReferral,
  openIdentityScreen,
  PHOTO_GSTIN,
  scenarioGstin,
  scenarioPan,
  shopFreeAccount,
} from "../lib/identity-first-helpers";

const signed = { tier: "signed" as const, timeout: 240_000 };

/** "Referral code (optional)" or "Referral code" (Admin › Referral settings, shop: mandatory). */
async function referralRequired(page: Page) {
  const optional = await page.getByText("Referral code (optional)", { exact: true }).isVisible();
  if (!optional) await expect(page.getByText("Referral code", { exact: true })).toBeVisible();
  return !optional;
}

/** Makes "Verify …" usable when a code is required: a 3-character code typed (never sent: the format check stops first, or the write is stopped). */
async function satisfyRequiredCode(page: Page) {
  const field = page.getByTestId("wizard-referral-code");
  if ((await referralRequired(page)) && (await field.getAttribute("readonly")) === null && (await field.inputValue()).trim().length < 3) {
    await field.fill("QAX");
  }
}

qa("TC-ONB-048", "identity screen: Referral code, GST number, a read-only PAN taken from characters 3–12 of the GSTIN, the consent box and Verify GSTIN (disabled until consent) — nothing sent", async ({ browser }) => {
  const { context, page } = await pageAs(browser, await shopFreeAccount());
  try {
    const stopped = await guardWizardWrites(page);
    await openIdentityScreen(page);
    const required = await referralRequired(page);
    await expect(page.getByTestId("wizard-referral-code")).toBeVisible();
    await expect(page.getByText(IDENTITY.gstLabel, { exact: true })).toBeVisible();
    const { gstin } = scenarioGstin("P");
    await page.getByTestId("gstin-input").fill(gstin);
    await expect(page.getByText(IDENTITY.derivedPanLabel, { exact: true })).toBeVisible();
    const derived = page.getByTestId("derived-pan");
    await expect(derived).toHaveValue(gstin.slice(2, 12));
    await expect(derived).toHaveAttribute("readonly", "");
    const consent = page.getByRole("checkbox", { name: IDENTITY.consent });
    await expect(consent).not.toBeChecked();
    const verify = page.getByTestId("verify-identity");
    await expect(verify).toHaveText("Verify GSTIN");
    await expect(verify, "Verify GSTIN before the consent box is ticked").toBeDisabled();
    await consent.check();
    await satisfyRequiredCode(page);
    await expect(verify, "Verify GSTIN once the consent box is ticked").toBeEnabled();
    expect(stopped, "nothing was sent").toEqual([]);
    return `label "${required ? "Referral code" : "Referral code (optional)"}", "${IDENTITY.gstLabel}", read-only PAN ${gstin.slice(2, 12)} from ${gstin.slice(0, 2)}…; Verify GSTIN disabled → enabled by the consent; not clicked`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "the check itself (Verified, Owner or Address next, ✓ Verified from GST) is proven in the local tier with the mock vendor — no government check is made on staging" });

qa("TC-ONB-049", "GSTIN format: a 14-character value and one without Z at position 14 show the format message and send nothing; lower case is upper-cased as typed", async ({ browser }) => {
  const { context, page } = await pageAs(browser, await shopFreeAccount());
  try {
    const stopped = await guardWizardWrites(page);
    await openIdentityScreen(page);
    await page.getByRole("checkbox", { name: IDENTITY.consent }).check();
    await satisfyRequiredCode(page);
    const field = page.getByTestId("gstin-input");
    const verify = page.getByTestId("verify-identity");
    for (const bad of ["27ABCDE1234F1Z", "27ABCDE1234F1X5"]) {
      await field.fill(bad);
      await expect(verify).toBeEnabled();
      await verify.click();
      await expect(page.getByText(IDENTITY.gstFormat, { exact: true }), `${bad}: format message`).toBeVisible();
      await expect(page.getByTestId("derived-pan"), `${bad}: no PAN taken from it`).toHaveCount(0);
    }
    await field.fill("27abcde1234f1z5");
    await expect(field, "lower case is upper-cased").toHaveValue("27ABCDE1234F1Z5");
    await expect(page.getByTestId("derived-pan")).toHaveValue("ABCDE1234F");
    expect(stopped, "no check was sent for any of them").toEqual([]);
    return "27ABCDE1234F1Z and 27ABCDE1234F1X5 → format message, nothing sent; 27abcde1234f1z5 → 27ABCDE1234F1Z5";
  } finally {
    await context.close();
  }
}, signed);

qa("TC-ONB-050", "PAN route: “I don't have GST, use PAN”, Verify PAN only with both ticks (not GST-registered + consent); “I have a GST number” switches back", async ({ browser }) => {
  const { context, page } = await pageAs(browser, await shopFreeAccount());
  try {
    const stopped = await guardWizardWrites(page);
    await openIdentityScreen(page);
    await satisfyRequiredCode(page);
    await page.getByRole("button", { name: IDENTITY.usePan }).click();
    await expect(page.getByText(IDENTITY.panLabel, { exact: true })).toBeVisible();
    await page.getByTestId("pan-input").fill(scenarioPan("P"));
    const verify = page.getByTestId("verify-identity");
    await expect(verify).toHaveText("Verify PAN");
    const declaration = page.getByRole("checkbox", { name: IDENTITY.declaration });
    const consent = page.getByRole("checkbox", { name: IDENTITY.consent });
    await expect(verify, "no ticks").toBeDisabled();
    await consent.check();
    await expect(verify, "consent only").toBeDisabled();
    await consent.uncheck();
    await declaration.check();
    await expect(verify, "declaration only").toBeDisabled();
    await consent.check();
    await expect(verify, "both ticks").toBeEnabled();
    await page.getByRole("button", { name: IDENTITY.useGst }).click();
    await expect(page.getByTestId("gstin-input")).toBeVisible();
    await expect(page.getByText(IDENTITY.gstLabel, { exact: true })).toBeVisible();
    await expect(page.getByTestId("pan-input")).toHaveCount(0);
    expect(stopped, "nothing was sent").toEqual([]);
    return "Verify PAN disabled with no / one tick, enabled with both; “I have a GST number” → GST number field again";
  } finally {
    await context.close();
  }
}, { ...signed, partial: "verifying the PAN and moving on is proven in the local tier (mock vendor); staging's Sandbox.co.in test keys refused every PAN (D2)" });

qa("TC-ONB-051", "PAN format: ABCDE1234, ABCD12345F and 1BCDE1234F each show “Enter the 10-character PAN, for example ABCDE1234F.” and send nothing", async ({ browser }) => {
  const { context, page } = await pageAs(browser, await shopFreeAccount());
  try {
    const stopped = await guardWizardWrites(page);
    await openIdentityScreen(page);
    await satisfyRequiredCode(page);
    await page.getByRole("button", { name: IDENTITY.usePan }).click();
    await page.getByRole("checkbox", { name: IDENTITY.declaration }).check();
    await page.getByRole("checkbox", { name: IDENTITY.consent }).check();
    const verify = page.getByTestId("verify-identity");
    for (const bad of ["ABCDE1234", "ABCD12345F", "1BCDE1234F"]) {
      await page.getByTestId("pan-input").fill(bad);
      await verify.click();
      await expect(page.getByText(IDENTITY.panFormat, { exact: true }), `${bad}: format message`).toBeVisible();
    }
    expect(stopped, "no check was sent").toEqual([]);
    return "three malformed PANs → the format message each time, nothing sent";
  } finally {
    await context.close();
  }
}, signed);

qa("TC-ONB-053", "unknown referral code NOSUCH99 is refused before the GSTIN is checked, with “Request a referral code”; a mandatory code keeps Verify disabled under 3 characters", async ({ browser }) => {
  const { context, page } = await pageAs(browser, await shopFreeAccount());
  try {
    // The referral answer may reach the site (an unknown code is refused before anything is made); the GSTIN never does.
    const stopped = await guardWizardWrites(page, (path) => path === "/api/shops/registration-draft/referral");
    await openIdentityScreen(page);
    await needEditableReferral(page);
    const required = await referralRequired(page);
    const code = page.getByTestId("wizard-referral-code");
    const verify = page.getByTestId("verify-identity");
    const request = page.getByTestId("request-referral-code");
    await code.fill("");
    await expect(request, "the link while the field is empty").toBeVisible();
    await expect(request).toHaveText("Request a referral code");
    await page.getByTestId("gstin-input").fill(scenarioGstin("P").gstin);
    await page.getByRole("checkbox", { name: IDENTITY.consent }).check();
    if (required) {
      await expect(verify, "mandatory code, empty").toBeDisabled();
      await code.fill("NO");
      await expect(verify, "mandatory code, 2 characters").toBeDisabled();
    }
    await code.fill("NOSUCH99");
    await expect(request, "no link while a code is typed").toHaveCount(0);
    await expect(verify).toBeEnabled();
    await verify.click();
    const tail = required ? "request one" : "leave it empty";
    await expect(page.getByText(`Referral code NOSUCH99 does not exist. Check the code, or ${tail}.`, { exact: true })).toBeVisible();
    await expect(page.getByText("Referral code NOSUCH99 does not exist.", { exact: true }), "under the field").toBeVisible();
    await expect(request, "the link while the field is in error").toBeVisible();
    expect(stopped.filter((s) => s.path.endsWith("/gstin")), "the GSTIN was not checked").toEqual([]);
    return `${required ? "mandatory" : "optional"} code: NOSUCH99 → "…does not exist. Check the code, or ${tail}."; link shown empty / in error, hidden while typing${required ? "; Verify disabled empty and at 2 characters" : ""}`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "the expired code and both referral settings (mandatory and optional) are proven in the local tier" });

qa("TC-ONB-054", "Referral code stops at 32 characters and is upper-cased; “Employee ID or name” (dealer programme on) stops at 120", async ({ browser }) => {
  const { context, page } = await pageAs(browser, await shopFreeAccount());
  try {
    const stopped = await guardWizardWrites(page);
    await openIdentityScreen(page);
    await needEditableReferral(page);
    const code = page.getByTestId("wizard-referral-code");
    await code.fill("");
    await code.pressSequentially("ab12cd");
    await expect(code, "upper-cased").toHaveValue("AB12CD");
    await code.fill("");
    await code.pressSequentially("Q".repeat(33));
    await expect(code, "32 characters at most").toHaveValue("Q".repeat(32));
    const summary = page.getByText("Employee ID or name (optional)", { exact: true });
    let programme = "off";
    if (await summary.isVisible()) {
      programme = "on";
      const employee = page.getByTestId("wizard-employee-id");
      if (!(await employee.isVisible())) await summary.click();
      await employee.fill("");
      await employee.pressSequentially("E".repeat(121));
      await expect(employee, "120 characters at most").toHaveValue("E".repeat(120));
    } else {
      await expect(page.getByTestId("wizard-employee-id")).toHaveCount(0);
    }
    expect(stopped, "nothing was sent").toEqual([]);
    return `33 typed → 32 kept; ab12cd → AB12CD; dealer programme ${programme} here: Employee ID ${programme === "on" ? "stops at 120" : "not shown"}`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "the dealer programme in its other state (the flag switched on and off) is proven in the local tier" });

qa("TC-ONB-055", "“📷 Read it from a photo of your GST certificate”: a clear photo fills the GST number field (not verified); a blurred one says “Couldn't read — type it” and leaves it unchanged", async ({ browser }) => {
  const { context, page } = await pageAs(browser, await shopFreeAccount());
  try {
    const stopped = await guardWizardWrites(page);
    await openIdentityScreen(page);
    const field = page.getByTestId("gstin-input");
    await field.fill("");
    const opener = page.getByText("📷 Read it from a photo of your GST certificate", { exact: true });
    const photos = page.getByLabel("Photos of your documents");
    // Blurred first, on an empty field.
    await opener.click();
    await photos.setInputFiles({ name: "gst-blurred.jpg", mimeType: "image/jpeg", buffer: await gstCertificatePhoto(PHOTO_GSTIN, 25) });
    await expect(page.getByText("Couldn't read — type it", { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Choose which document this is.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "These numbers are right — check them online" })).toBeDisabled();
    await expect(field, "the blurred photo leaves the field unchanged").toHaveValue("");
    await opener.click();
    await expect(page.getByTestId("document-scan")).toHaveCount(0);
    // Then the clear photo.
    await opener.click();
    await photos.setInputFiles({ name: "gst-clear.jpg", mimeType: "image/jpeg", buffer: await gstCertificatePhoto(PHOTO_GSTIN) });
    await expect(page.getByText("Number found — please check", { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByLabel("GST number (GSTIN)", { exact: true })).toHaveValue(PHOTO_GSTIN);
    await page.getByRole("button", { name: "These numbers are right — check them online" }).click();
    await expect(field, "the clear photo fills the GST number field").toHaveValue(PHOTO_GSTIN);
    await expect(page.getByTestId("document-scan"), "the reader closes").toHaveCount(0);
    await expect(page.getByTestId("verify-identity")).toHaveText("Verify GSTIN");
    expect(stopped, "nothing was verified or sent").toEqual([]);
    return `blurred → "Couldn't read — type it", field empty; clear → ${PHOTO_GSTIN} read on the device and put in the field, still to be verified`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "the photos are generated test images (a clear and a blurred REG-06), not camera shots; the PAN-card route is not run" });

qa("TC-ONB-069", "signed in: /shop/register?form&ref=ABC123 and ?wizard&ref=ABC123 land on /shop/register?ref=ABC123 with the identity screen and ABC123 in Referral code", async ({ browser }) => {
  const { context, page } = await pageAs(browser, await shopFreeAccount());
  try {
    const stopped = await guardWizardWrites(page);
    const seen: string[] = [];
    for (const old of ["/shop/register?form&ref=ABC123", "/shop/register?wizard&ref=ABC123"]) {
      await page.goto(old);
      await page.waitForURL((u) => u.pathname === "/shop/register" && u.search === "?ref=ABC123", { timeout: 30_000 });
      const waiting = page.getByTestId("registration-waiting");
      await expect(waiting.or(page.getByTestId("registration-tiles")).first()).toBeVisible();
      if (await waiting.isVisible()) blocked("this account has a shop waiting for its fee or approval, so the wizard is not shown");
      const heading = page.getByRole("heading", { name: IDENTITY.heading });
      if (!(await heading.isVisible())) blocked("this account's registration is past the identity step, so the link's code is not shown there");
      const field = page.getByTestId("wizard-referral-code");
      if ((await field.getAttribute("readonly")) !== null && (await field.inputValue()) !== "ABC123") {
        blocked(`this account's registration already holds referral code ${await field.inputValue()} (locked)`);
      }
      await expect(field).toHaveValue("ABC123");
      seen.push(old);
    }
    const sent = stopped.filter((s) => s.path.endsWith("/referral")).map((s) => s.body);
    if (sent.length) expect(sent.join(" "), "the code from the link is the one the wizard applies").toContain("ABC123");
    return `${seen.join(" and ")} → /shop/register?ref=ABC123, "Verify your business" with ABC123${sent.length ? " (its check stopped in the browser)" : ""}`;
  } finally {
    await context.close();
  }
}, signed);
