/**
 * Customer referral links (F11, src/app/r/[code]/route.ts) as a signed-out
 * visitor sees them: /r/<code> sends them to sign in and keeps the code in the
 * gk_ref cookie for 30 days. Production-safe: the link only sets a cookie in the
 * caller's own browser; nothing is written on the server. The signed-in redirect
 * and the code reaching a new customer are in tests/qa/signed-in/referral-links.spec.ts
 * and tests/qa/local/referral-links-2026-11.spec.ts.
 */
import { anonymous, call } from "../lib/http";
import { expect, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";

/** Not a shop code (SHOP…): those go to /shop/register while rule shopReferrals is on. */
const RAW = "qa-link-2026";
const CODE = "QALINK2026";

qa("TC-MKT-018", "signed out, /r/<code> answers 307 to /signin (or / with onboarding v2) and remembers the code (gk_ref cookie, 30 days, upper-case)", async ({ browser }) => {
  const guest = await anonymous();
  let header = "";
  try {
    const res = await call(guest, "GET", `/r/${RAW}`);
    expect(res.status, "GET /r/<code> signed out").toBe(307);
    // docs/onboarding-v2-2026-11: with onboarding_v2 on a guest is never sent to sign in from a link — the home
    // page opens instead and the code is remembered the same way. Off: /signin, as before.
    expect(["/signin", "/"], "redirect target").toContain(new URL(res.location ?? "", BASE_URL).pathname);
    header = res.headers["set-cookie"] ?? "";
    expect(header, "the code in the gk_ref cookie").toMatch(new RegExp(`gk_ref=${CODE}(;|$)`, "m"));
    expect(header, "kept 30 days").toMatch(/Max-Age=2592000/i);
    expect(header, "httpOnly").toMatch(/HttpOnly/i);
  } finally {
    await guest.dispose();
  }
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const page = await context.newPage();
    await page.goto(`/r/${RAW}`);
    await page.waitForURL((u) => u.pathname === "/signin" || u.pathname === "/");
    const cookie = (await context.cookies()).find((c) => c.name === "gk_ref");
    expect(cookie?.value, "the browser keeps the code").toBe(CODE);
    const days = (cookie!.expires * 1000 - Date.now()) / 86_400_000;
    expect(days, "the cookie lasts 30 days").toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    return `/r/${RAW} → 307 ${new URL(page.url()).pathname}; gk_ref=${CODE} for ${days.toFixed(2)} days (${header.split("\n").find((l) => l.startsWith("gk_ref"))?.slice(0, 120)})`;
  } finally {
    await context.close();
  }
}, { partial: "signed-out half; signed in → /refer and the code reaching a new customer run in the signed-in and local tiers" });
