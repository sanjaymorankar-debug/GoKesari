/**
 * Onboarding v2 (docs/onboarding-v2-2026-11, flag onboarding_v2: ON on test.gokesari.com, OFF on gokesari.com)
 * for the older checks whose expected screens it changes: they accept both behaviours, like
 * tests/qa/guest/guest-cart.spec.ts TC-GCART-003.
 *
 *  - the cart preselects no payment ("Choose how to pay") and offers the wallet only when it covers the total;
 *  - the mobile is asked in the checkout sign-in sheet (verified by an SMS code), not on the cart page.
 */
import type { Page } from "@playwright/test";

import { as } from "./actors";
import { call } from "./http";
import type { Role } from "./world";

const known = new Map<Role, boolean>();

/** Whether onboarding_v2 is on for this site: the sheet's status route answers 404 while it is off. */
export async function onboardingV2On(role: Role = "customer"): Promise<boolean> {
  const cached = known.get(role);
  if (cached != null) return cached;
  const res = await call(await as(role), "POST", "/api/onboarding-v2/customer/status", {});
  const on = res.status !== 404;
  known.set(role, on);
  return on;
}

/** The cart's pay button under either flow ("Choose how to pay" is v2's button before a payment is chosen). */
export const PAY_BUTTON = /Pay from wallet|Place order|Pay online|Choose how to pay/i;

/**
 * v2 preselects no payment: chooses `method` when nothing is chosen and it is offered (a no-op with the flag off,
 * where the wallet is already chosen). Returns whether a choice was made here.
 */
export async function pickPaymentIfNone(page: Page, method: "Wallet" | "Cash on delivery" = "Wallet"): Promise<boolean> {
  const fieldset = page.getByTestId("payment-method");
  await fieldset.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await fieldset.count()) === 0) return false;
  if ((await fieldset.locator("input[type=radio]:checked").count()) > 0) return false;
  const radio = fieldset.getByRole("radio", { name: method, exact: true });
  if ((await radio.count()) === 0 || !(await radio.isEnabled())) return false;
  await radio.check();
  return true;
}

/**
 * QA E-42: verifies the account's mobile again through the sheet's SMS code (the MOCK outbox, read as admin), so a
 * check that changed the number does not leave later v2 checkouts at the sheet's MOBILE step. Only while v2 is on and
 * the account is at that step; answers what it did (never throws — it runs in `finally`).
 */
export async function reverifyMobile(role: Role, mobile10: string): Promise<string> {
  try {
    if (!(await onboardingV2On(role))) return "onboarding_v2 off: nothing to verify";
    const status = await call(await as(role), "POST", "/api/onboarding-v2/customer/status", {});
    if (status.body?.step !== "MOBILE") return `sheet step ${status.body?.step ?? status.status}: mobile already fine`;
    const since = Date.now();
    const sent = await call(await as(role), "POST", "/api/onboarding-v2/customer/mobile", { action: "send", mobile: mobile10 });
    if (sent.status !== 200 || sent.body?.status !== "CODE_SENT") return `code not sent (${sent.status} ${sent.body?.status ?? ""})`;
    let code: string | null = null;
    for (let i = 0; i < 20 && !code; i++) {
      const out = await call(await as("admin"), "GET", `/api/admin/test-messages?to=${mobile10}`);
      const m = ((out.body?.messages ?? []) as { body: string; createdAt: string }[]).find((x) => new Date(x.createdAt).getTime() >= since - 5_000);
      code = m?.body.match(/\b(\d{6})\b/)?.[1] ?? null;
      if (!code) await new Promise((r) => setTimeout(r, 3_000));
    }
    if (!code) return "no SMS in the mock outbox: verify the mobile by hand (E-42)";
    const ok = await call(await as(role), "POST", "/api/onboarding-v2/customer/mobile", { action: "verify", mobile: mobile10, code });
    return ok.status === 200 ? "mobile verified again" : `verify answered ${ok.status}`;
  } catch (error) {
    return `re-verify failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
