/**
 * Customer referral link → a new customer (F11, TC-MKT-018): someone opens a
 * customer's /r/<code> signed out, signs up with an emailed code, and finds the
 * code pre-filled in the first-time setup's referral field. Saved, it is the
 * friend referral (PENDING) and /refer says they joined with a friend's code.
 * Cleared there, /refer's "Were you invited by a friend?" box still has it.
 *
 * Local tier: rule customerReferrals (off by default) is switched on for the
 * checks and restored; new people sign up through the local mail catcher.
 */
import type { Browser } from "@playwright/test";

import { guestContext, localUser, signInWithCode, uniqueEmail, withRule } from "../lib/auth-helpers";
import { db } from "../lib/db";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 300_000 };
const REFERRALS = { enabled: true, referrerRewardPaise: 5000, refereeRewardPaise: 5000, maxRewardsPerReferrer: 20, applyWithinDays: 30 };
const JOINED = "You joined with a friend's code — your reward arrives after your first order is delivered.";

async function referrerCode(): Promise<string> {
  const referrer = await localUser("ref-link-owner", { address: true });
  try {
    const res = await call(referrer.ctx, "GET", "/api/customer-referrals");
    expectStatus(res, 200, "GET /api/customer-referrals");
    return String(res.body.code);
  } finally {
    await referrer.ctx.dispose();
  }
}

/** Opens /r/<code> signed out (lower case, as typed), then signs a new person up in the same browser. */
async function arriveAndSignUp(browser: Browser, code: string, label: string) {
  const { context, page } = await guestContext(browser);
  await page.goto(`/r/${code.toLowerCase()}`);
  await page.waitForURL(/\/signin(\?|$)/);
  const cookie = (await context.cookies()).find((c) => c.name === "gk_ref");
  expect(cookie?.value, "the code is remembered (upper-case)").toBe(code);
  const days = (cookie!.expires * 1000 - Date.now()) / 86_400_000;
  expect(days, "for 30 days").toBeGreaterThan(29.9);
  expect(days).toBeLessThan(30.1);
  const email = uniqueEmail(label);
  await signInWithCode(page, email);
  const field = page.getByTestId("signup-referral-code");
  await expect(field, "the first-time setup asks for a referral code").toBeVisible();
  await expect(field, "pre-filled with the link's code").toHaveValue(code);
  return { context, page, email };
}

qa("TC-MKT-018", "a new customer who came by /r/<code> finds the code pre-filled at first-time setup; saved, /refer says they joined with a friend's code; signed in the link goes to /refer", async ({ browser }) => {
  return withRule("customerReferrals", REFERRALS, async () => {
    const code = await referrerCode();
    const { context, page, email } = await arriveAndSignUp(browser, code, "ref-link");
    try {
      await page.getByLabel("Full name").fill("QA Link Friend");
      await page.getByRole("button", { name: "Save and continue" }).click();
      await expect(page.getByRole("heading", { name: "Delivery address" })).toBeVisible();
      await page.goto("/refer");
      await expect(page.getByText(JOINED)).toBeVisible();
      const [row] = await db()<{ status: string }[]>`
        select r.status from customer_referrals r join users u on u.id = r.referee_user_id where u.email = ${email}`;
      expect(row?.status, "the friend referral is recorded").toBe("PENDING");
      await page.goto(`/r/${code}`);
      await page.waitForURL(/\/refer$/);
      return `/r/${code.toLowerCase()} → /signin (gk_ref=${code}, 30 days); new customer's setup pre-filled "${code}" → saved → PENDING; /refer: "${JOINED}"; signed in /r/${code} → /refer`;
    } finally {
      await context.close();
    }
  });
}, local);

qa("TC-MKT-018", "a new customer who clears the code at first-time setup still finds it pre-filled in /refer's 'Friend's referral code'", async ({ browser }) => {
  return withRule("customerReferrals", REFERRALS, async () => {
    const code = await referrerCode();
    const { context, page } = await arriveAndSignUp(browser, code, "ref-link-later");
    try {
      // "Referral code" without "(optional)": the admin made it mandatory, so it cannot be left empty.
      if (await page.getByText("Referral code (optional)").count() === 0) blocked("the referral code is mandatory at sign-up on this server (admin Referral settings), so it cannot be cleared");
      await page.getByTestId("signup-referral-code").fill("");
      await page.getByLabel("Full name").fill("QA Link Later");
      await page.getByRole("button", { name: "Save and continue" }).click();
      await expect(page.getByRole("heading", { name: "Delivery address" })).toBeVisible();
      await page.goto("/refer");
      await expect(page.getByRole("heading", { name: "Were you invited by a friend?" })).toBeVisible();
      await expect(page.getByTestId("apply-referral-code"), "the code from the link").toHaveValue(code);
      return `setup's field cleared → /refer "Were you invited by a friend?" with "${code}" pre-filled in "Friend's referral code"`;
    } finally {
      await context.close();
    }
  });
}, local);
