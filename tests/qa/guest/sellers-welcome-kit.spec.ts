/**
 * Shop welcome kit (docs/shop-welcome-kit-2026-11, PR #431) — what a signed-out visitor gets.
 * Production-safe: only requests the server must refuse, and the public shop page the QR opens.
 */
import { anonymous, call } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

qa(["TC-WKIT-006", "TC-WKIT-009"], "Signed out: the banner download and the admin welcome-kit route answer 401", async () => {
  const shop = need(world().shops.A?.id, "shop A's id in the world");
  const guest = await anonymous();
  try {
    const seen: string[] = [];
    for (const path of [`/api/shops/${shop}/banner`, `/api/shops/${shop}/banner?lang=local&format=png`, "/api/admin/shops/welcome-kit"]) {
      const res = await call(guest, "GET", path);
      expect(res.status, `${path} signed out`).toBe(401);
      expect(res.headers["content-type"] ?? "", `${path} answers JSON, not a file`).toContain("application/json");
      seen.push(`${path} → ${res.status}`);
    }
    const post = await call(guest, "POST", "/api/admin/shops/welcome-kit", { bulk: { city: "Pune" } });
    expect(post.status, "POST /api/admin/shops/welcome-kit signed out").toBe(401);
    seen.push(`POST /api/admin/shops/welcome-kit → ${post.status}`);
    return seen.join("; ");
  } finally {
    await guest.dispose();
  }
});

qa("TC-WKIT-007", "The QR target /shops/<slug> is a public page that shows the shop", async ({ page }) => {
  const shop = need(world().shops.A, "shop A in the world");
  const slug = need(shop.slug, "shop A's slug in the world");
  const res = await page.goto(`/shops/${slug}`);
  expect(res?.status(), `/shops/${slug}`).toBe(200);
  await expect(page.getByRole("heading", { name: shop.name }).first()).toBeVisible();
  return `/shops/${slug} → 200, "${shop.name}" shown to a signed-out visitor`;
}, { mobile: true, partial: "the QR code itself is read from the banner in the signed-in check" });
