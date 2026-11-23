/**
 * Guest cart (docs/guest-cart-2026-11, owner 23-Nov-2026): "ask the customer
 * to sign in only when he is going to raise an order". Production-safe: only
 * GETs, the read-only price preview and requests the server must refuse.
 *
 * With the flag guest_cart_enabled on, a guest adds to a cart kept in the
 * browser, opens /cart and is asked to sign in only at "Place order". With it
 * off, the site behaves as before (cart → sign-in). Either way checkout, the
 * account cart and the merge refuse a caller without a session.
 */
import { anonymous, call, pace } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";

async function flagOn(): Promise<boolean> {
  const guest = await anonymous();
  try {
    const res = await call(guest, "POST", "/api/cart/preview", { lines: [] });
    // 200 = switched on; 404 FEATURE_NOT_AVAILABLE = off.
    expect([200, 404], `POST /api/cart/preview answered ${res.status}`).toContain(res.status);
    return res.status === 200;
  } finally {
    await guest.dispose();
  }
}

qa("TC-GCART-001", "checkout, the account cart and the guest-cart merge refuse a caller without a session (401)", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    const calls: [string, string, unknown][] = [
      ["POST", "/api/checkout", {}],
      ["GET", "/api/cart", undefined],
      ["POST", "/api/cart", { shopProductId: NO_SUCH_ID, quantity: 1 }],
      ["POST", "/api/cart/merge", { lines: [{ shopProductId: NO_SUCH_ID, quantity: 1 }] }],
    ];
    for (const [method, path, body] of calls) {
      await pace();
      const res = await call(guest, method as "GET" | "POST", path, body);
      expect(res.status, `${method} ${path}`).toBe(401);
      seen.push(`${method} ${path} → 401`);
    }
  } finally {
    await guest.dispose();
  }
  return seen.join("; ");
});

qa("TC-GCART-002", "the guest price preview refuses bad input and prices an unknown listing as missing, saving nothing", async () => {
  if (!(await flagOn())) blocked("guest_cart_enabled is off on this site (the preview answers 404, as before)");
  const guest = await anonymous();
  try {
    const bad = await call(guest, "POST", "/api/cart/preview", { lines: [{ shopProductId: "not-a-uuid", quantity: 1 }] });
    expect([400, 422], "a malformed line").toContain(bad.status);
    const tooMany = await call(guest, "POST", "/api/cart/preview", {
      lines: Array.from({ length: 51 }, (_, i) => ({ shopProductId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, quantity: 1 })),
    });
    expect([400, 422], "51 lines (limit 50)").toContain(tooMany.status);
    const missing = await call(guest, "POST", "/api/cart/preview", { lines: [{ shopProductId: NO_SUCH_ID, quantity: 2 }] });
    expect(missing.status).toBe(200);
    expect(missing.body.missingShopProductIds).toEqual([NO_SUCH_ID]);
    expect(missing.body.groups).toEqual([]);
    return "bad line and 51 lines refused; unknown listing → 200, listed as missing, no groups";
  } finally {
    await guest.dispose();
  }
});

qa("TC-GCART-003", "a guest adds to the cart without signing in, opens /cart, and is asked to sign in only at Place order", async ({ page }) => {
  if (!(await flagOn())) {
    // Off: the old behaviour — the cart sends a guest to sign in.
    await page.goto("/cart");
    await expect(page).toHaveURL(/\/signin\b/);
    blocked("guest_cart_enabled is off on this site: /cart sends a guest to sign-in, as before");
  }
  const guest = await anonymous();
  let slug: string | null = null;
  try {
    const shops = await call(guest, "GET", "/api/shops?limit=24");
    const list = (Array.isArray(shops.body) ? shops.body : (shops.body?.shops ?? [])) as { id: string; slug: string }[];
    for (const shop of list.slice(0, 10)) {
      await pace();
      const products = await call(guest, "GET", `/api/shops/${shop.id}/products?limit=5`);
      const rows = (Array.isArray(products.body) ? products.body : (products.body?.products ?? [])) as unknown[];
      if (products.status === 200 && rows.length) {
        slug = shop.slug;
        break;
      }
    }
  } finally {
    await guest.dispose();
  }
  if (!slug) blocked("no approved shop with products online is listed on this site");

  await page.goto(`/shops/${slug}`);
  const add = page.getByTestId("product-card").getByRole("button", { name: "Add to cart" }).first();
  if ((await add.count()) === 0) blocked(`/shops/${slug}: no product can be bought online now`);
  await add.click();
  // Still a guest on the shop page: nothing sent to sign-in.
  await expect(page).toHaveURL(new RegExp(`/shops/${slug}`));
  const stored = await page.evaluate(() => window.localStorage.getItem("gk_guest_cart_v1"));
  expect(stored, "the guest cart in the browser").toContain("shopProductId");

  await page.goto("/cart");
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByTestId("guest-cart-line").first()).toBeVisible();
  const placeOrder = page.getByTestId("guest-cart-place-order");
  await expect(placeOrder).toBeEnabled();
  await placeOrder.click();
  await expect(page).toHaveURL(/\/signin\b/);
  const returnTo = (await page.context().cookies()).find((c) => c.name === "gk_return_to")?.value;
  expect(decodeURIComponent(returnTo ?? ""), "page to come back to after sign-in").toBe("/cart");
  return `/shops/${slug}: Add to cart as a guest (no sign-in), /cart shows the line, Place order → /signin, return-to /cart`;
}, { mobile: true });
