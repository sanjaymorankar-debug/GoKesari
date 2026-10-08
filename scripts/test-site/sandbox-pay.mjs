#!/usr/bin/env node
/**
 * Pays a Cashfree SANDBOX checkout session with Cashfree's test instruments —
 * test tooling for test.gokesari.com end-to-end runs from places that cannot
 * open Cashfree's checkout (docs/four-features-2026-10, TEST_RESULTS.md).
 * Used by .github/workflows/sandbox-pay.yml. Sandbox only: the host is
 * hard-coded, so a production session id simply fails. No credentials: a
 * payment session id is all Cashfree's Order Pay API needs.
 *
 *   node scripts/test-site/sandbox-pay.mjs <payment_session_id> <instrument> [card_number]
 *   instrument: upi-success | upi-failure | card-success | card-failure |
 *               netbanking-success | netbanking-failure
 */
const SANDBOX = "https://sandbox.cashfree.com/pg";
const [session, instrument, cardNumber] = process.argv.slice(2);
if (!session || !instrument) {
  console.error("usage: sandbox-pay.mjs <payment_session_id> <instrument> [card_number]");
  process.exit(2);
}
const outcome = instrument.endsWith("-failure") ? "failure" : "success";

function paymentMethod() {
  if (instrument.startsWith("upi-")) {
    // Cashfree's sandbox VPAs: the collect request succeeds / fails by itself.
    return { upi: { channel: "collect", upi_id: outcome === "success" ? "testsuccess@gocash" : "testfailure@gocash" } };
  }
  if (instrument.startsWith("card-")) {
    return {
      card: {
        channel: "link",
        card_number: cardNumber || "4111111111111111",
        card_holder_name: "Test Holder",
        card_expiry_mm: "12",
        card_expiry_yy: "30",
        card_cvv: "123",
      },
    };
  }
  if (instrument.startsWith("netbanking-")) return { netbanking: { channel: "link", netbanking_bank_code: 3003 } };
  throw new Error(`unknown instrument ${instrument}`);
}

const res = await fetch(`${SANDBOX}/orders/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-version": "2023-08-01" },
  body: JSON.stringify({ payment_session_id: session, payment_method: paymentMethod() }),
});
const body = await res.json().catch(() => null);
const card = body?.payment_method === "card" ? " (card details not echoed)" : "";
console.log(`Order Pay → HTTP ${res.status}${card}`);
console.log(JSON.stringify({ action: body?.action, channel: body?.channel, payment_method: body?.payment_method, cf_payment_id: body?.cf_payment_id, message: body?.message, code: body?.code, type: body?.type, url: body?.data?.url ? "(present)" : null }, null, 2));
if (!res.ok) process.exit(1);

const url = body?.data?.url;
if (!url) {
  console.log("No authentication page (UPI collect): the sandbox settles it by itself in a few seconds.");
  process.exit(0);
}

// Card / net banking: Cashfree's sandbox authentication page has a success and a failure choice.
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const describe = async (label) => {
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
  const buttons = await page.locator("button, input[type=submit], a").evaluateAll((els) => els.map((e) => (e.innerText || e.value || "").trim()).filter(Boolean).slice(0, 20));
  console.log(`${label}: ${new URL(page.url()).host} | ${text}\n  controls: ${JSON.stringify(buttons)}`);
};
await describe("authentication page");
// Cashfree's simulator: an OTP box (the page prints the test OTP), the outcome
// to send (SUCCESS / PENDING / USER_DROPPED / FAILED) and Submit.
const shown = (await page.locator("body").innerText().catch(() => "")).match(/OTP\s*-\s*(\d{4,8})/);
const otp = page.locator("input:not([type=radio]):not([type=checkbox]):not([type=hidden]):not([type=submit])").first();
if (await otp.count()) await otp.fill(shown?.[1] ?? "111000");
const status = outcome === "success" ? "SUCCESS" : "FAILED";
const radio = page.getByLabel(status, { exact: true });
if (await radio.count()) await radio.first().check({ force: true });
else await page.getByText(status, { exact: true }).first().click().catch(() => {});
const failureType = page.locator("select").first();
if (outcome !== "success" && (await failureType.count())) {
  const options = await failureType.locator("option").allInnerTexts();
  if (options.length > 1) await failureType.selectOption({ index: 1 });
}
await page.waitForTimeout(500);
const submit = page.getByRole("button", { name: /submit|pay|confirm/i }).first();
if (await submit.count()) {
  await submit.click({ timeout: 15000 });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(4000);
  await describe("after submitting");
} else {
  console.log("No submit control found on the page.");
  process.exitCode = 1;
}
await browser.close();
