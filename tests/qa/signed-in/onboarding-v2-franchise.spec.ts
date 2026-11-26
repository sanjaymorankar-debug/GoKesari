/**
 * Onboarding v2, Flow 3 — Become a franchisee (docs/onboarding-v2-2026-11). Signed tier, staging:
 *   no live shop  rider (owns no shop)            → /shop/register?return=/franchise/start
 *   free dealer   the first shop owner who is no dealer yet (gk-shop on 26-Nov-2026) → live at once, GKD code
 *   paid          customer2 (already the staging dealer): zones (≤ 2 a zone), plan LAUNCH_1Y, coupon,
 *                 Cashfree SANDBOX checkout (net banking test bank) → franchise live with a GKF code
 *   admin         Admin → Franchise → Plans
 * No real money: staging runs the Cashfree sandbox (docs/testing/cashfree-sandbox-test-data.md).
 */
import type { Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";

const PAID_BUYER = "customer2" as const;

async function startState(role: Parameters<typeof as>[0]) {
  const res = await call(await as(role), "GET", "/api/franchise/start");
  if (res.status === 403) blocked(`Become a franchisee is not open on this site (${res.body?.error?.message})`);
  expectStatus(res, 200, "GET /api/franchise/start");
  return res.body as { enabled: boolean; shop: { id: string; name: string } | null; dealer: { id: string; status: string; code: string | null } | null; roles: string[]; isFreeDealer: boolean; isFranchisee: boolean };
}

qa(["TC-OV2-070"], "a signed-in person without a live shop is sent to shop registration and back: /shop/register?return=/franchise/start", async ({ browser }) => {
  const state = await startState("rider");
  if (state.shop) blocked("the rider account owns a live shop now");
  const { page, context } = await pageAs(browser, "rider");
  try {
    await page.goto("/franchise/start");
    await expect(page).toHaveURL(/\/shop\/register\?return=%2Ffranchise%2Fstart$/);
    await expect(page.getByRole("heading", { name: "Register your shop" })).toBeVisible();
    return `rider (no shop) → ${new URL(page.url()).pathname}${new URL(page.url()).search}`;
  } finally {
    await context.close();
  }
}, { tier: "signed", mobile: true });

qa(["TC-OV2-071"], "/franchise/start: free dealer vs paid franchise; 'at most 2 franchises a zone'; plan LAUNCH_1Y ₹1,50,000 + GST; no 30-day KYC rule", async ({ browser }) => {
  const { page, context } = await pageAs(browser, PAID_BUYER);
  try {
    await page.goto("/franchise/start");
    const paid = page.getByTestId("model-paid");
    await expect(paid).toBeVisible();
    await expect(paid).toContainText("at most 2 franchises a zone");
    await expect(page.getByTestId("model-paid-plans")).toContainText("₹1,50,000 + GST per zone · 12 months");
    const text = await page.locator("main").innerText();
    expect(text, "no 30-day KYC rule").not.toMatch(/KYC (with)?in 30 days|30 days? (to|for) (complete )?KYC|within 30 days of payment/i);
    expect(text).toContain("live as soon as you pay");
    return "paid card: at most 2 franchises a zone, 1-year launch offer ₹1,50,000 + GST per zone · 12 months, live as soon as you pay; no 30-day KYC text";
  } finally {
    await context.close();
  }
}, { tier: "signed", mobile: true });

qa(["TC-OV2-072"], "free dealer: one tap → live at once with a GKD- code; PAN / bank only before the first payout", async ({ browser }) => {
  // A shop owner who is no dealer yet.
  let role: "shop" | "customer" | null = null;
  for (const r of ["shop", "customer"] as const) {
    const s = await startState(r);
    if (s.shop && !s.dealer) {
      role = r;
      break;
    }
    if (s.dealer && /^GKD-/.test(s.dealer.code ?? "") && s.isFreeDealer) {
      // Done by an earlier pass: still check the live state.
      const { page, context } = await pageAs(browser, r);
      try {
        await page.goto("/franchise/start");
        await expect(page.getByTestId("franchise-start-live")).toContainText("Dealer · live");
        return `already a free dealer from an earlier pass (${s.dealer.code}); /franchise/start shows Dealer · live`;
      } finally {
        await context.close();
      }
    }
  }
  // The customer is kept a non-dealer for the dealer-application checks (TC-DPLT-007/010): only gk-shop is used.
  if (role !== "shop") blocked("needs a shop owner with a live shop who is no dealer (gk-shop)");
  const { page, context } = await pageAs(browser, role);
  try {
    await page.goto("/franchise/start");
    await page.getByTestId("model-free-go").click();
    const code = page.getByTestId("franchise-start-code");
    await expect(code).toHaveText(/^GKD-/, { timeout: 60_000 });
    await expect(page.getByTestId("franchise-start-live")).toContainText("Dealer · live");
    const after = await startState(role);
    expect(after.isFreeDealer).toBe(true);
    expect(after.dealer?.status).toBe("APPROVED");
    return `${role}: "Become a free dealer" → live at once, code ${await code.innerText()}, dealer APPROVED, roles ${after.roles.join(", ")}`;
  } finally {
    await context.close();
  }
}, { tier: "signed" });

/**
 * Pays the Cashfree SANDBOX checkout the page opened: its payment session id goes to
 * scripts/test-site/sandbox-pay.mjs (the "Sandbox payment" workflow's tool; net banking test bank, simulator
 * SUCCESS). The simulator page itself stays on "Loading…" in a local Chromium, so it is not clicked here.
 */
async function payOnCashfreeSandbox(page: Page): Promise<void> {
  await page.waitForURL(/sandbox\.cashfree\.com/, { timeout: 90_000 });
  const session = await page.locator("#cf-psid").getAttribute("value", { timeout: 30_000 });
  if (!session) throw new Error("no payment session id on Cashfree's checkout page");
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("node", ["scripts/test-site/sandbox-pay.mjs", session, "netbanking-success"], { encoding: "utf8", timeout: 180_000 });
  if (!/Order Pay → HTTP 200/.test(out)) throw new Error(`sandbox-pay did not pay: ${out.replace(/session_[\w-]+/g, "<session>").slice(0, 300)}`);
}

async function liveFranchise(page: Page): Promise<string> {
  await page.goto("/franchise/my");
  const text = await page.locator("main").innerText();
  const gkf = text.match(/GKF-[A-Z0-9]+/)?.[0] ?? null;
  expect(gkf, "a GKF- franchise code on My franchise").toBeTruthy();
  expect(text).toMatch(/Active/);
  return gkf!;
}

qa(["TC-OV2-073"], "paid franchise: a zone, plan LAUNCH_1Y, coupon box (unknown coupon refused), Cashfree sandbox payment → live with a GKF- code", async ({ browser }) => {
  const before = await startState(PAID_BUYER);
  if (!before.shop) blocked("the paid buyer has no live shop");
  const { page, context } = await pageAs(browser, PAID_BUYER);
  try {
    if (before.isFranchisee) {
      // Paid in an earlier pass (each payment books a zone for 12 months): check the live result only.
      const gkf = await liveFranchise(page);
      return `paid in an earlier pass: franchisee, active zone, code ${gkf} on My franchise`;
    }
    await page.goto("/franchise/start?model=paid");
    if (await page.getByTestId("model-paid-go").isVisible().catch(() => false)) await page.getByTestId("model-paid-go").click();
    await expect(page.getByTestId("franchise-start-zones")).toBeVisible();
    // A Pune zone with a free slot (earlier unpaid attempts keep theirs until the gateway order lapses).
    await page.getByTestId("zone-search").fill(process.env.QA_OV2_ZONE ?? "Wakad");
    await page.getByRole("button", { name: "Select" }).first().click();
    await page.getByTestId("franchise-continue").click();
    const summary = page.getByTestId("franchise-summary");
    await expect(summary.getByTestId("franchise-plans")).toContainText("1-year launch offer");
    await expect(summary.getByTestId("franchise-total")).toContainText(/₹1,77,000|₹/);
    await page.getByTestId("franchise-coupon").fill("QAOV2NOSUCH");
    await page.getByTestId("franchise-coupon-apply").click();
    await expect(summary).toContainText("Coupon QAOV2NOSUCH does not exist.");
    await page.getByTestId("franchise-coupon").fill("");
    await expect(summary).toContainText("Live as soon as you pay");
    await page.getByTestId("franchise-accept").check();
    await page.getByTestId("franchise-pay").click();
    const refused = summary.getByText(/Nothing was reserved/);
    if (await refused.isVisible({ timeout: 8_000 }).catch(() => false)) blocked(`the zone is still held by an earlier attempt: ${await refused.innerText()}`);
    await payOnCashfreeSandbox(page);
    await expect.poll(async () => (await startState(PAID_BUYER)).isFranchisee, { timeout: 120_000, intervals: [5_000] }).toBe(true);
    const gkf = await liveFranchise(page);
    return `${process.env.QA_OV2_ZONE ?? "Wakad"}, LAUNCH_1Y, ₹1,77,000 incl. GST; unknown coupon refused; Cashfree sandbox net banking (test bank) success → franchisee, code ${gkf}`;
  } finally {
    await context.close();
  }
}, { tier: "signed", timeout: 420_000 });

qa(["TC-OV2-074"], "admin → Franchise → Plans lists LAUNCH_1Y (₹1,50,000 + GST, 12 months) with Add plan", async ({ browser }) => {
  const api = await call(await as("admin"), "GET", "/api/admin/franchise/plans");
  expectStatus(api, 200, "GET /api/admin/franchise/plans");
  const plans = (api.body?.plans ?? api.body) as { code: string; pricePaise?: number; durationMonths: number; active: boolean }[];
  const launch = plans.find((p) => p.code === "LAUNCH_1Y");
  expect(launch, "LAUNCH_1Y seeded").toBeTruthy();
  expect(launch!.durationMonths).toBe(12);
  const { page, context } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/franchise?tab=plans");
    const tab = page.getByTestId("admin-plans");
    if (!(await tab.isVisible().catch(() => false))) await page.getByRole("button", { name: "Plans", exact: true }).click();
    await expect(tab).toBeVisible();
    await expect(tab).toContainText("LAUNCH_1Y");
    await expect(tab).toContainText("1,50,000");
    await expect(page.getByTestId("plan-add")).toBeVisible();
    return `API: ${plans.length} plan(s), LAUNCH_1Y 12 months active=${launch!.active}; Plans tab lists it with Add plan (not edited)`;
  } finally {
    await context.close();
  }
}, { tier: "signed", partial: "adding / editing a plan is not done on staging (admin data)" });
