/**
 * Customer referral links and the /refer page (F11): signed in, /r/<code> goes
 * straight to /refer; /refer shows the customer's own code and share link, and
 * that link opened in a private window sends the visitor to sign in with the
 * code remembered. Rule customerReferrals is OFF by default: with it off /refer
 * says "Referral rewards aren't available right now." and the checks block.
 *
 * Signed tier: customer 1 reads their own code; the redirect is followed in a
 * throw-away context so the shared session never carries a gk_ref cookie.
 */
import { onboardingV2On } from "../lib/onboarding-v2-helpers";
import { request as playwrightRequest } from "@playwright/test";

import { as, pageAs, storageFor } from "../lib/actors";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";

const signed = { tier: "signed" as const, timeout: 180_000 };
const OFF = "Referral rewards aren't available right now.";

qa("TC-MKT-018", "signed in, /r/<code> goes straight to /refer (307) and still remembers the code", async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: await storageFor("customer"), timeout: 120_000 });
  try {
    const res = await call(ctx, "GET", "/r/qa-link-2026");
    expect(res.status, "GET /r/<code> signed in").toBe(307);
    expect(new URL(res.location ?? "", BASE_URL).pathname, "redirect target").toBe("/refer");
    expect(res.headers["set-cookie"] ?? "", "the code in the gk_ref cookie").toMatch(/gk_ref=QALINK2026(;|$)/m);
    return `signed in: /r/qa-link-2026 → 307 ${res.location}; gk_ref=QALINK2026`;
  } finally {
    await ctx.dispose();
  }
}, { ...signed, partial: "signed-in half; the signed-out redirect is the guest check and the new customer's sign-up with the code is the local check" });

qa("TC-MKT-019", "/refer shows the customer's own code and share link; the link opened in a private window goes to sign-in with the code remembered", async ({ browser }) => {
  const summary = await call(await as("customer"), "GET", "/api/customer-referrals");
  expectStatus(summary, 200, "GET /api/customer-referrals");
  const code = String(summary.body.code ?? "");
  expect(code, "the customer has a referral code").toMatch(/^[A-Z0-9]{4,16}$/);
  const { context, page } = await pageAs(browser, "customer", { permissions: ["clipboard-read", "clipboard-write"] });
  let link = "";
  try {
    await page.goto("/refer");
    await expect(page.getByRole("heading", { name: "Refer a friend" })).toBeVisible();
    if (await page.getByText(OFF).isVisible().catch(() => false)) blocked("rule customerReferrals is off on this site (off by default): /refer says \"Referral rewards aren't available right now.\"");
    await expect(page.getByTestId("my-referral-code"), "the own code").toHaveText(code);
    const shown = page.getByText(new RegExp(`/r/${code}$`));
    await expect(shown, "the share link").toBeVisible();
    link = (await shown.innerText()).trim();
    const url = new URL(link);
    expect(url.host, "the link is on this site").toBe(new URL(BASE_URL).host);
    expect(url.pathname).toBe(`/r/${code}`);
    // Referral sharing (rule referralSharing, on since 26-Nov-2026): WhatsApp / SMS / Email / Copy link buttons
    // (docs/referral-sharing-2026-11); before it, one "Share on WhatsApp" link.
    const whatsapp = page.getByTestId("referral-share-buttons").getByTestId("share-whatsapp").or(page.getByRole("link", { name: "Share on WhatsApp" }));
    await expect(whatsapp).toHaveAttribute("href", new RegExp(`^https://wa\\.me/\\?text=.*${code}`));
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    // Referral sharing tags each channel's link (?c=cp for Copy link, docs/referral-sharing-2026-11).
    if (copied !== null) expect([link, `${link}?c=cp`], "what Copy link copied").toContain(copied);
  } finally {
    await context.close();
  }
  // A private window: no session, no cookies.
  const privateWindow = await browser.newContext({ baseURL: BASE_URL });
  try {
    const page2 = await privateWindow.newPage();
    await page2.goto(new URL(link).pathname);
    // docs/onboarding-v2-2026-11 (on on test.gokesari.com): a guest is never sent to sign in from a link — /r/<code>
    // opens the home page and keeps the code (as tests/qa/guest TC-MKT-018 accepts since #628).
    const v2 = await onboardingV2On("customer");
    await page2.waitForURL((u) => u.pathname === "/signin" || (v2 && u.pathname === "/"));
    const cookie = (await privateWindow.cookies()).find((c) => c.name === "gk_ref");
    expect(cookie?.value, "the code is remembered for sign-in").toBe(code);
  } finally {
    await privateWindow.close();
  }
  return `/refer: code ${code}, link ${link}, Copy link → "Link copied"; the link in a private window → /signin (or / with onboarding v2) with gk_ref=${code}`;
}, { ...signed, mobile: true });
