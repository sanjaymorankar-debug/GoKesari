/**
 * Automatic sign-out at the end of the session lifetime (QA package 1,
 * TC-AUTH-044). Local tier: a session whose lifetime has run out is minted
 * with the local server's secret (waiting 30 days is not practical), and the
 * person then signs in again with an emailed code from the local mail catcher.
 */
import { ageCodes, browserWithCookie, guestContext, localUser, mintSession, SESSION_COOKIE, sessionUser, signInWithCode } from "../lib/auth-helpers";
import { expect, qa } from "../lib/record";

qa("TC-AUTH-044", "after the session lifetime a click is sent to sign in without an error page, and signing in again returns to the page asked for", async ({ browser }) => {
  const user = await localUser("lifetime");
  // The lifetime a fresh sign-in gets: the session cookie's own expiry.
  const { context: fresh, page: login } = await guestContext(browser);
  let lifetimeDays = 0;
  try {
    await signInWithCode(login, user.email);
    const cookie = (await fresh.cookies()).find((c) => c.name === SESSION_COOKIE);
    lifetimeDays = Math.round(((cookie?.expires ?? 0) * 1000 - Date.now()) / 86_400_000);
  } finally {
    await fresh.close();
  }
  expect(lifetimeDays, "session lifetime (days)").toBeGreaterThan(0);
  const expired = await mintSession(user.id, user.email, -60);
  const { context, page } = await browserWithCookie(browser, expired);
  try {
    await page.goto("/profile");
    await expect(page.locator("body")).not.toContainText(/Something went wrong|Application error|Internal Server Error/);
    await expect(page, "the expired session is sent to sign in").toHaveURL(/\/signin/);
    expect(await sessionUser(context.request), "not signed in").toBeNull();
    const asked = "/wallet";
    await page.goto(asked);
    await expect(page).toHaveURL(/\/signin/);
    const target = new URL(page.url());
    await ageCodes(user.email); // past the resend cooldown since the first sign-in
    await signInWithCode(page, user.email);
    // Every sign-in passes through /onboarding, which sends a complete profile on.
    await page.waitForURL((u) => !u.pathname.startsWith("/onboarding"), { timeout: 15_000 }).catch(() => {});
    const landed = new URL(page.url()).pathname;
    expect(landed, `signed in again; the sign-in page was ${target.pathname}${target.search} and after the code it went to ${landed}, not back to ${asked}`).toBe(asked);
    return `lifetime ${lifetimeDays} days; expired session → /signin, no error page; signed in again → ${asked}`;
  } finally {
    await context.close();
  }
}, { tier: "local", timeout: 180_000, partial: "the lifetime is not waited out: a session whose expiry has passed is minted with the local secret" });
