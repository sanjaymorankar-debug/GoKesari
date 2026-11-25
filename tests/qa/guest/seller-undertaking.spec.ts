/**
 * Seller undertaking: fresh, safe and compliant goods (docs/seller-undertaking-2026-11). Production-safe:
 * only a GET of the public Seller Terms and requests the server must refuse.
 */
import { anonymous, call, pace } from "../lib/http";
import { expect, qa } from "../lib/record";

qa("TC-SUND-001", "the seller undertaking API refuses a caller without a session (401) for both status and acceptance", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    for (const [method, body] of [
      ["GET", undefined],
      ["POST", { acceptUndertaking: true, acceptTerms: true }],
    ] as const) {
      await pace();
      const res = await call(guest, method, "/api/seller/undertaking", body);
      expect(res.status, `${method} /api/seller/undertaking`).toBe(401);
      seen.push(`${method} → 401`);
    }
  } finally {
    await guest.dispose();
  }
  return seen.join("; ");
});

qa("TC-SUND-002", "the Seller Terms page shows the seller undertaking with its version, promise and numbered clauses", async ({ page }) => {
  await page.goto("/legal/seller-terms");
  await expect(page.getByRole("heading", { name: "Seller undertaking: fresh, safe and compliant goods" })).toBeVisible();
  await expect(page.getByText(/^Version \d{4}-\d{2}-\d{2}, effective /)).toBeVisible();
  await expect(page.getByText("I promise never to send expired, stale or non-compliant goods", { exact: false })).toBeVisible();
  const clauses = page.getByTestId("seller-undertaking-clauses").getByRole("listitem");
  expect(await clauses.count()).toBeGreaterThanOrEqual(9);
  return `${await clauses.count()} clauses shown`;
});
