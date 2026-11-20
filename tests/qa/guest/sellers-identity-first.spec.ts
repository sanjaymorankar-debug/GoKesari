/**
 * Identity-first shop registration (/shop/register) — production-safe part of TC-ONB-069:
 * the retired long form's and wizard's links (?form, ?wizard) land on the one registration
 * and keep a referral link's code. GETs only; nothing signs in or writes.
 *
 * Seller Central pages stream behind src/app/shop/loading.tsx, so the page's own redirect can
 * arrive as a 200 with a refresh to the new address (D-109, src/lib/request-path.ts) as well as
 * a 3xx; either is the same redirect for a browser, which is checked too.
 */
import { anonymous, call } from "../lib/http";
import { expect, qa } from "../lib/record";

const TARGET_URL = "/shop/register?ref=ABC123";

/** Where an answer sends the browser: a Location header, or the page's refresh tag. */
function redirectTarget(res: { status: number; location: string | null; text: string }): string | null {
  if ([301, 302, 303, 307, 308].includes(res.status)) return res.location ? new URL(res.location, "http://x").pathname + new URL(res.location, "http://x").search : null;
  const meta = res.text.match(/http-equiv="refresh" content="\d+;\s*url=([^"]+)"/i)?.[1];
  return meta ? meta.replace(/&amp;/g, "&") : null;
}

qa("TC-ONB-069", "old ?form and ?wizard registration links redirect to /shop/register?ref=ABC123 and land on the one registration flow", async ({ page }) => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    for (const old of ["/shop/register?form&ref=ABC123", "/shop/register?wizard&ref=ABC123"]) {
      const res = await call(guest, "GET", old);
      const to = redirectTarget(res);
      expect(to, `${old} → HTTP ${res.status}, no redirect found`).toBe(TARGET_URL);
      seen.push(`${old} → ${res.status} ${to}`);
    }
  } finally {
    await guest.dispose();
  }
  // In a browser both land on the one registration with the code kept (signed out: its sign-in step).
  for (const old of ["/shop/register?form&ref=ABC123", "/shop/register?wizard&ref=ABC123"]) {
    await page.goto(old);
    await page.waitForURL((u) => u.pathname === "/shop/register" && u.search === "?ref=ABC123", { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Register your shop" }).first()).toBeVisible();
    seen.push(`browser ${old} → ${new URL(page.url()).pathname}${new URL(page.url()).search}`);
  }
  return seen.join("; ");
}, { partial: "the identity-first screen with the code in the Referral code field needs a signed-in account (tests/qa/signed-in/sellers-identity-first.spec.ts)" });
