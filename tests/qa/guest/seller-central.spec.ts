/**
 * Old short links that still resolve (src/app/bakery, src/app/dairy): each
 * sends the visitor to its category page. Production-safe: page loads only.
 * The Seller Central frame itself needs a shop owner (tests/qa/signed-in/seller-central.spec.ts).
 */
import { anonymous, call } from "../lib/http";
import { expect, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";

const SHORT_LINKS = [
  { from: "/bakery", to: "/category/BAKERY", heading: "Bakery" },
  { from: "/dairy", to: "/category/DAIRY", heading: "Dairy Shop" },
] as const;

qa("TC-UX-010", "/bakery and /dairy redirect to /category/BAKERY and /category/DAIRY", async ({ page }) => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    for (const link of SHORT_LINKS) {
      const res = await call(guest, "GET", link.from);
      expect([307, 308], `${link.from} answers a redirect`).toContain(res.status);
      expect(new URL(res.location ?? "", BASE_URL).pathname, `${link.from} goes to`).toBe(link.to);
      await page.goto(link.from);
      await page.waitForURL((url) => url.pathname === link.to);
      await expect(page.getByRole("heading", { name: link.heading, exact: true }).first()).toBeVisible();
      seen.push(`${link.from} → ${res.status} ${link.to} ("${link.heading}")`);
    }
  } finally {
    await guest.dispose();
  }
  return seen.join("; ");
}, { mobile: true });
