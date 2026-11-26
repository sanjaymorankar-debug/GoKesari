/**
 * Onboarding v2 (docs/onboarding-v2-2026-11, flag onboarding_v2) — the guest side, production-safe:
 * only GETs, clicks that stay in the browser, and requests the server must refuse.
 *
 * With the flag on (staging since migration 0215): no sign-in anywhere before checkout — a guest browses,
 * adds to the browser cart and "Place order" opens the login sheet over the cart (no /signin). With it off
 * (production until the owner's test pass) the checks are recorded "blocked" with the reason.
 */
import { anonymous, call, pace } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";

/** The flag answer of a v2 guest route: the consent API answers 404 FEATURE_NOT_AVAILABLE while it is off. */
async function v2On(): Promise<boolean> {
  const guest = await anonymous();
  try {
    // An empty body is refused (422) by an enabled route before anything is written; 404 = flag off.
    const res = await call(guest, "POST", "/api/onboarding-v2/customer/consent", {});
    return res.status !== 404;
  } finally {
    await guest.dispose();
  }
}

qa(["TC-OV2-001"], "guest: /shops → shop page → Add to cart → /cart → Place order opens the login sheet over the cart (never /signin)", async ({ page }) => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const signinVisits: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame() && /\/signin\b/.test(f.url())) signinVisits.push(f.url());
  });
  await page.goto("/shops");
  await expect(page).toHaveURL(/\/shops$/);
  const link = page.locator('a[href^="/shops/"]').first();
  await expect(link).toBeVisible();

  // A shop with something on sale online.
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
  await expect(page).toHaveURL(new RegExp(`/shops/${slug}`));
  await page.goto("/cart");
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByTestId("guest-cart-line").first()).toBeVisible();
  const placeOrder = page.getByTestId("guest-cart-place-order");
  await expect(placeOrder).toHaveText(/Place order/);
  await expect(placeOrder).toBeEnabled({ timeout: 60_000 });
  await placeOrder.click();
  const sheet = page.getByTestId("login-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Before you place your order" })).toBeVisible();
  await expect(sheet).toContainText("Step 1 of 3");
  await expect(sheet).toContainText("Your cart is kept");
  await expect(page).toHaveURL(/\/cart$/);
  // The cart is still there behind the sheet.
  expect(await page.evaluate(() => window.localStorage.getItem("gk_guest_cart_v1"))).toContain("shopProductId");
  expect(signinVisits, "no page sent the guest to sign in").toEqual([]);
  return `/shops → /shops/${slug} → Add to cart (still a guest) → /cart → "Place order" opened the login sheet step 1 of 3 on /cart; no /signin visit`;
}, { mobile: true });

qa(["TC-OV2-002"], "guest: the v2 account APIs refuse a caller without a session (401) and write nothing", async () => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    const calls: [string, string, unknown][] = [
      ["POST", "/api/onboarding-v2/customer/status", {}],
      ["POST", "/api/onboarding-v2/customer/mobile", { action: "send", mobile: "9000000000" }],
      ["POST", "/api/onboarding-v2/orders/delivery-location", { orderIds: [NO_SUCH_ID], addressId: NO_SUCH_ID }],
      ["GET", "/api/team", undefined],
      ["GET", "/api/team/invitations", undefined],
      ["POST", "/api/franchise/start", { model: "free" }],
      ["POST", "/api/shops/registration-draft/v2/fee", { slab: 1, shopName: "QA" }],
    ];
    for (const [method, path, body] of calls) {
      await pace();
      const res = await call(guest, method as "GET" | "POST", path, body);
      expect([401, 403], `${method} ${path} answered ${res.status}`).toContain(res.status);
      seen.push(`${method} ${path} → ${res.status}`);
    }
  } finally {
    await guest.dispose();
  }
  return seen.join("; ");
});

qa(["TC-OV2-003"], "guest: /franchise/start and /dealer/team send a guest to sign in (account pages), /team/invitations too", async ({ page }) => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const seen: string[] = [];
  for (const path of ["/franchise/start", "/dealer/team", "/team/invitations"]) {
    await page.goto(path);
    await expect(page, `${path}`).toHaveURL(/\/signin\b/);
    seen.push(`${path} → ${new URL(page.url()).pathname}`);
  }
  return seen.join("; ");
});
