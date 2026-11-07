#!/usr/bin/env node
/**
 * Pays a Cashfree SANDBOX checkout session with Cashfree's test instruments —
 * test tooling for test.gokesari.com end-to-end runs from places that cannot
 * open Cashfree's checkout (docs/four-features-2026-10, TEST_RESULTS.md).
 * Used by .github/workflows/sandbox-pay.yml. Sandbox only: the host is
 * hard-coded, so a production session id simply fails. No credentials: a
 * payment session id is all Cashfree's Order Pay API needs.
 *
 *   node scripts/test-site/sandbox-pay.mjs <payment_session_id> <instrument> [card_number | wallet_provider]
 *   instrument: upi-success | upi-failure | card-success | card-failure |
 *               debit-card-success | credit-card-success (the card must be of that type:
 *               otherwise the attempt is dropped, nothing is paid, and the run fails) |
 *               netbanking-success | netbanking-failure
 *   docs/payments-cashfree-audit-2026-11 adds:
 *               wallet-success | wallet-failure (third argument: the wallet, default phonepe;
 *               paytm, amazon, mobikwik, freecharge, airtel, jio, ola …) |
 *               card-pending | wallet-pending (the simulator leaves the payment PENDING) |
 *               card-dropped | wallet-dropped (the customer cancels: USER_DROPPED) |
 *               upi-intent | upi-qr (prints what Cashfree returns for an intent / QR payment;
 *               the sandbox cannot open a UPI app, so nothing is paid)
 */
const SANDBOX = "https://sandbox.cashfree.com/pg";
const [session, instrument, cardNumber] = process.argv.slice(2);
if (!session || !instrument) {
  console.error("usage: sandbox-pay.mjs <payment_session_id> <instrument> [card_number]");
  process.exit(2);
}
const outcome = instrument.endsWith("-failure") ? "failure" : "success";
// The simulator's choice: SUCCESS / FAILED, or PENDING / USER_DROPPED for the new instruments.
const simulatorStatus = instrument.endsWith("-pending") ? "PENDING" : instrument.endsWith("-dropped") ? "USER_DROPPED" : outcome === "success" ? "SUCCESS" : "FAILED";

function paymentMethod() {
  if (instrument === "upi-intent") return { upi: { channel: "link" } };
  if (instrument === "upi-qr") return { upi: { channel: "qrcode" } };
  if (instrument.startsWith("wallet-")) {
    // Cashfree "app" payments (wallets); the sandbox shows the same simulator page as cards.
    return { app: { channel: "link", provider: cardNumber || "phonepe", phone: "8714268343" } };
  }
  if (instrument.startsWith("upi-")) {
    // Cashfree's sandbox VPAs: the collect request succeeds / fails by itself.
    return { upi: { channel: "collect", upi_id: outcome === "success" ? "testsuccess@gocash" : "testfailure@gocash" } };
  }
  if (instrument.includes("card-")) {
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
if (instrument === "upi-intent" || instrument === "upi-qr") {
  // An intent / QR payment hands back a upi:// link or a QR image for a phone; only its shape is shown.
  const payload = body?.data?.payload ?? {};
  console.log(`UPI ${instrument === "upi-qr" ? "QR" : "intent"}: payload keys ${JSON.stringify(Object.keys(payload))}, url ${url ? "(present)" : "none"}`);
  const sample = typeof payload.default === "string" ? payload.default : typeof payload.qrcode === "string" ? payload.qrcode : "";
  console.log(`  starts with: ${sample.slice(0, 18)}…`);
  process.exit(0);
}
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
const wantType = instrument.startsWith("debit-card") ? "Debit Card" : instrument.startsWith("credit-card") ? "Credit Card" : null;
const pageText = await page.locator("body").innerText().catch(() => "");
const wrongType = wantType && !pageText.includes(wantType);
if (wrongType) console.log(`This card is not a ${wantType} here — dropping the attempt (nothing is paid).`);
const status = wrongType ? "USER_DROPPED" : simulatorStatus;
const radio = page.getByLabel(status, { exact: true });
if (await radio.count()) await radio.first().check({ force: true });
else await page.getByText(status, { exact: true }).first().click().catch(() => {});
const failureType = page.locator("select").first();
if (status === "FAILED" && (await failureType.count())) {
  const options = await failureType.locator("option").allInnerTexts();
  if (options.length > 1) await failureType.selectOption({ index: 1 });
}
// Cashfree's simulator (Nov 2026) has a "Select failure type" dropdown button, not a <select>:
// Submit stays disabled until a failure type is chosen.
const picker = page.getByRole("button", { name: /select failure type/i }).first();
if (status === "FAILED" && (await picker.count())) {
  await picker.click().catch(() => {});
  await page.waitForTimeout(400);
  const option = page.locator(".dropdown-menu .dropdown-item, .dropdown-menu a, .dropdown-menu li, [role=option], [role=menuitem]").first();
  if (await option.count()) {
    console.log(`failure type: ${(await option.innerText().catch(() => "")).trim()}`);
    await option.click().catch(() => {});
  }
}
await page.waitForTimeout(500);
const submit = page.getByRole("button", { name: /submit|pay|confirm/i }).first();
if (await submit.count()) {
  await submit.click({ timeout: 15000 });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(4000);
  await describe("after submitting");
  if (wrongType) process.exitCode = 3;
} else {
  console.log("No submit control found on the page.");
  process.exitCode = 1;
}
await browser.close();
