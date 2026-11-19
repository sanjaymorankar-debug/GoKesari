/**
 * The built-in sandbox payment page (/orders/pay/sandbox/<ref>, batch-2026-10
 * WS-A) never runs on gokesari.com: there it says "Not available — The sandbox
 * payment page only runs on the test site." (src/app/orders/pay/sandbox/[ref]/page.tsx,
 * sandboxAllowed() in src/server/payments/gateway/registry.ts). On the test site
 * and the local server, where the sandbox may run, a made-up reference is not found.
 *
 * Production-safe: one page load, no sign-in, no order, no payment.
 */
import { expect, qa } from "../lib/record";
import { IS_PROD, TARGET } from "../lib/target";

qa("TC-PAY-038", "the sandbox payment page is refused: on production 'Not available', elsewhere a made-up reference is not found; never a payment form", async ({ page }) => {
  const res = await page.goto("/orders/pay/sandbox/test");
  const status = res?.status() ?? 0;
  expect(status, "no server error").toBeLessThan(500);
  // Whatever the site, no way to pay: no sandbox form, no Pay / Fail / Let it expire.
  await expect(page.getByTestId("sandbox-checkout")).toHaveCount(0);
  for (const name of ["Pay (success)", "Fail", "Let it expire"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  if (IS_PROD) {
    await expect(page.getByText("Not available", { exact: true })).toBeVisible();
    await expect(page.getByText("The sandbox payment page only runs on the test site.")).toBeVisible();
    return `gokesari.com /orders/pay/sandbox/test → HTTP ${status}: "Not available — The sandbox payment page only runs on the test site."; no payment form`;
  }
  expect(status, `${TARGET}: a made-up sandbox reference`).toBe(404);
  await expect(page.getByTestId("not-found-state")).toBeVisible();
  return `${TARGET} (sandbox allowed): /orders/pay/sandbox/test → 404 page; no payment form`;
});
