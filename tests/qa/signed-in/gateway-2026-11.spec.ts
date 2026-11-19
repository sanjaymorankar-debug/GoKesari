/**
 * Which gateway an online payment opens on this site, and what each outcome
 * does to the order (TC-PAY-036). Never real money: on test.gokesari.com
 * "Pay online" opens either the Cashfree SANDBOX (PAYMENT_GATEWAY=CASHFREE with
 * sandbox keys: /orders/pay/session/<intent> hands over to Cashfree's sandbox
 * checkout) or the built-in sandbox page (PAYMENT_GATEWAY=SANDBOX:
 * /orders/pay/sandbox/<ref>, "Pay (success)" / "Fail" / "Let it expire").
 * Paying at Cashfree's own page is done through the "Sandbox payment" workflow
 * with Cashfree's sandbox test data, so the outcome check blocks there.
 *
 * Signed tier: customer 1 orders from the test shop. Rule onlinePayments is OFF
 * by default; on a LOCAL run the file switches it on as the admin and restores
 * it afterwards (on staging the owner's setting is used and the checks block
 * while it is off).
 */
import { as, pageAs } from "../lib/actors";
import { sellable } from "../lib/flows";
import { call, expectStatus } from "../lib/http";
import { intentView, onlineCheckout, orderOf, putRule, restoreRule, ruleOf, sandboxPath, type RuleRow } from "../lib/money-helpers";
import { abandon } from "../lib/orders-helpers";
import { expect, qa, test } from "../lib/record";
import { IS_LOCAL } from "../lib/target";

const signed = { tier: "signed" as const, timeout: 300_000 };

let ruleBefore: RuleRow | null = null;
test.beforeAll(async () => {
  if (!IS_LOCAL) return;
  ruleBefore = await ruleOf("onlinePayments");
  await putRule("onlinePayments", { ...ruleBefore.value, enabled: true });
});
test.afterAll(async () => {
  if (ruleBefore) await restoreRule(ruleBefore);
  ruleBefore = null;
});

const SESSION_PAGE = /^\/orders\/pay\/session\/[0-9a-f-]{36}$/;

qa("TC-PAY-036", "Pay online opens this site's test gateway: the Cashfree sandbox from /orders/pay/session/<intent>, or the built-in 'Sandbox payment — Test payment page — no money moves.'", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const checkout = await onlineCheckout("customer", [{ listing }]);
  const order = checkout.orders[0];
  const url = checkout.payment.redirectUrl ?? "";
  const path = url.startsWith("http") ? new URL(url).pathname : url;
  const { context, page } = await pageAs(browser, "customer");
  try {
    if (SESSION_PAGE.test(path)) {
      expect(path, "the payer's own session page").toBe(`/orders/pay/session/${checkout.payment.intentId}`);
      const html = await call(await as("customer"), "GET", path);
      expectStatus(html, 200, "the Pay online page");
      expect(html.text).toContain("Pay online");
      // The launcher is handed CASHFREE_ENV: the sandbox on the test site, never production.
      expect(html.text, "Cashfree checkout in sandbox mode").toMatch(/mode\\?"\s*:\s*\\?"sandbox/);
      await page.goto(path);
      await page.waitForURL((u) => /(^|\.)cashfree\.com$/.test(u.hostname), { timeout: 60_000 });
      const host = new URL(page.url()).host;
      return `${order.orderNumber}: Pay online → ${path} ("Pay online", mode sandbox) → Cashfree's checkout at ${host}; order left waiting for payment (the attempt expires on its own)`;
    }
    expect(path, "the payment page is the Cashfree session page or the built-in sandbox page").toMatch(/^\/orders\/pay\/sandbox\/[^/]+$/);
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Sandbox payment" })).toBeVisible();
    await expect(page.getByText("Test payment page — no money moves.")).toBeVisible();
    const box = page.getByTestId("sandbox-checkout");
    for (const name of ["Pay (success)", "Fail", "Let it expire"]) await expect(box.getByRole("button", { name, exact: true })).toBeVisible();
    // Close the attempt again so the order does not hold stock.
    await box.getByTestId("sandbox-expire").click();
    await page.waitForURL(/\/orders\/payment-return\?intent=/, { timeout: 45_000 });
    return `${order.orderNumber}: Pay online → ${path}: "Sandbox payment — Test payment page — no money moves." with Pay (success) / Fail / Let it expire`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "which page opens; the three outcomes are the next check (built-in page) or the 'Sandbox payment' workflow (Cashfree)" });

qa("TC-PAY-036", "on the built-in sandbox page: Pay (success) confirms the order; Fail leaves it unpaid with 'Retry payment'; Let it expire ends the attempt (order PAYMENT_FAILED, retryable)", async ({ browser }) => {
  const listing = await sellable("A", 3);
  const seen: string[] = [];
  const outcomes = [
    { press: "sandbox-pay", title: "Payment received", body: "Your order is placed and paid.", intent: "CAPTURED", order: "CONFIRMED", retry: false },
    { press: "sandbox-fail", title: "Payment failed", body: "You have not been charged for this attempt. Your order is kept — you can pay again.", intent: "FAILED", order: "PAYMENT_FAILED", retry: true },
    { press: "sandbox-expire", title: "Payment not completed in time", body: "You have not been charged for this attempt. Your order is kept — you can pay again.", intent: "EXPIRED", order: "PAYMENT_FAILED", retry: true },
  ] as const;
  for (const o of outcomes) {
    const checkout = await onlineCheckout("customer", [{ listing }]);
    const order = checkout.orders[0];
    const path = sandboxPath(checkout.payment); // blocks where the site pays at Cashfree's own page
    const { context, page } = await pageAs(browser, "customer");
    try {
      await page.goto(path);
      const box = page.getByTestId("sandbox-checkout");
      await expect(box).toBeVisible();
      await box.getByLabel("UPI", { exact: true }).check();
      await box.getByTestId(o.press).click();
      await page.waitForURL(/\/orders\/payment-return\?intent=/, { timeout: 45_000 });
      const ret = page.getByTestId("payment-return");
      await expect(ret).toContainText(o.title);
      await expect(ret).toContainText(o.body);
      if (o.retry) await expect(ret.getByRole("button", { name: "Retry payment" })).toBeVisible();
      else await expect(ret.getByRole("button", { name: "Retry payment" })).toHaveCount(0);
    } finally {
      await context.close();
    }
    const row = await orderOf("customer", order.id);
    expect(row?.status, `${o.title}: the order`).toBe(o.order);
    if (o.order === "CONFIRMED") expect(row?.paidAt, "paid").toBeTruthy();
    else expect(row?.paidAt, "not paid").toBeNull();
    const view = await intentView("customer", checkout.payment.intentId);
    expect(view.status, `${o.title}: the attempt`).toBe(o.intent);
    expect(view.canRetry, `${o.title}: retry offered`).toBe(o.retry);
    seen.push(`${o.press.replace("sandbox-", "")}: "${o.title}" → order ${row?.status}, attempt ${view.status}${o.retry ? ", Retry payment" : ""}`);
    if (o.order === "CONFIRMED") await abandon(order.id);
  }
  return seen.join("; ");
}, { ...signed, partial: "outcomes on the built-in sandbox page; paying at Cashfree's sandbox checkout (UPI testsuccess@gocash / testfailure@gocash, card OTP 111000) runs through the 'Sandbox payment' workflow" });
