/**
 * The manufacturer portal (/manufacturer, F9.1.2) and its APIs refuse a caller
 * without a session, and the bulk-upload API refuses a call without a valid key.
 * Production-safe: every request is one the server must refuse.
 */
import { anonymous, call, callApp, refusesGuest } from "../lib/http";
import { expect, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";

const PAGES = ["/manufacturer", "/manufacturer/upload", "/manufacturer/keys", "/manufacturer/jobs"];
const KEY_REFUSED = "A valid manufacturer API key is required (Authorization: Bearer <key>).";

qa(["TC-MFR-001", "TC-MFR-003"], "signed out, the manufacturer portal goes to sign-in, its APIs answer 401, and the upload API refuses a missing or unknown key", async ({ page }) => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    for (const path of PAGES) {
      const res = await callApp(guest, "GET", path);
      expect(res.status, `${path} signed out`).toBe(307);
      expect(new URL(res.location ?? "", BASE_URL).pathname, `${path} goes to`).toBe("/signin");
      seen.push(`${path} → 307 /signin`);
    }
    for (const [method, path] of [["GET", "/api/pmd/manufacturer/keys"], ["GET", "/api/pmd/manufacturer/uploads"]] as const) {
      const res = await call(guest, method, path);
      expect(res.status, `${method} ${path} signed out`).toBe(401);
      seen.push(`${method} ${path} → 401`);
    }
    const body = { products: [{ GTIN: "8901058000009", "Product Name": "QA never stored", Brand: "QA" }] };
    const none = await call(guest, "POST", "/api/pmd/v1/manufacturer/products", body);
    expect(none.status, "no key").toBe(401);
    const madeUp = await call(guest, "POST", "/api/pmd/v1/manufacturer/products", body, { headers: { authorization: "Bearer gkm_qaMadeUpKeyThatWasNeverIssued123456" } });
    expect(madeUp.status, "an unknown key").toBe(401);
    expect(madeUp.body?.error?.message ?? madeUp.text).toContain(KEY_REFUSED);
    expect(refusesGuest(madeUp)).toBe(true);
    seen.push(`POST /api/pmd/v1/manufacturer/products: no key → ${none.status}, unknown key → ${madeUp.status} "${KEY_REFUSED}"`);
  } finally {
    await guest.dispose();
  }
  await page.goto("/manufacturer");
  await page.waitForURL(/\/signin(\?|$)/);
  return seen.join("; ") + "; in the browser /manufacturer → /signin";
}, { partial: "signed-out half; the non-member (signed in) and the revoked key (a member's own key) run in the signed-in and local tiers" });
