/**
 * The manufacturer portal (/manufacturer, F9.1.2) is for members of a
 * manufacturer account only: a signed-in person who is not a member sees "No
 * manufacturer account", the upload and keys pages send them back there, and
 * the portal APIs answer 403. There is no manufacturer account on staging; the
 * member's own journeys (upload, keys) run in tests/qa/local/manufacturer-2026-11.spec.ts.
 *
 * Signed tier: customer 1 and shop A's owner only look and are refused; the
 * POST for a key is refused before anything is made.
 */
import { as, pageAs } from "../lib/actors";
import { call } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import type { Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 180_000 };
const NOT_MEMBER = "You are not a member of a manufacturer account.";

qa("TC-MFR-001", "a signed-in person who is not a manufacturer member is refused: 'No manufacturer account', upload and keys go back to /manufacturer, the APIs answer 403", async ({ browser }) => {
  const seen: string[] = [];
  for (const role of ["customer", "shop"] as Role[]) {
    const { context, page } = await pageAs(browser, role);
    try {
      await page.goto("/manufacturer");
      // A member gets the manufacturer Tile Board instead.
      if (await page.locator('[data-tile-board="manufacturer"]').count()) blocked(`the ${role} account is a manufacturer member on this site`);
      await expect(page.getByText("No manufacturer account", { exact: true })).toBeVisible();
      await expect(page.getByText("Ask GoKesari to link your sign-in to your company's manufacturer account.")).toBeVisible();
      for (const path of ["/manufacturer/upload", "/manufacturer/keys", "/manufacturer/jobs"]) {
        await page.goto(path);
        await page.waitForURL((url) => url.pathname === "/manufacturer");
      }
    } finally {
      await context.close();
    }
    const ctx = await as(role);
    for (const [method, path, body] of [
      ["GET", "/api/pmd/manufacturer/keys", undefined],
      ["GET", "/api/pmd/manufacturer/uploads", undefined],
      ["POST", "/api/pmd/manufacturer/keys", { label: "QA must be refused" }],
    ] as const) {
      const res = await call(ctx, method, path, body);
      expect(res.status, `${role}: ${method} ${path}`).toBe(403);
      expect(res.body?.error?.message, `${role}: ${method} ${path}`).toBe(NOT_MEMBER);
    }
    seen.push(`${role}: "No manufacturer account"; /upload, /keys, /jobs → /manufacturer; keys and uploads APIs → 403 "${NOT_MEMBER}"`);
  }
  return seen.join("; ");
}, { ...signed, mobile: true, partial: "signed-in non-member half; the signed-out half is the guest check" });
