/**
 * Onboarding v2 at phone size (375 × 812, touch) — the Android and iOS apps are WebView shells of these
 * same pages, so this is the layout they show (no device run). Each screen: loads, no sideways scroll,
 * the main action visible. Plus the licence inputs' camera / file attributes (Flow 2).
 */
import type { Page } from "@playwright/test";

import { pageAs } from "../lib/actors";
import { BASE_URL, blocked, expect, qa } from "../lib/record";
import { sellable } from "../lib/flows";

const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };

async function noSideScroll(page: Page, what: string) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, `${what}: page is ${scroll}px wide in a ${width}px viewport (sideways scroll)`).toBeLessThanOrEqual(width + 1);
}

qa(["TC-OV2-080"], "phone 375×812: the guest cart and the login sheet (bottom sheet) fit the screen; Continue reachable", async ({ browser }) => {
  const context = await browser.newContext({ ...PHONE, baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    const listing = await sellable("A");
    await page.goto("/shops");
    await page.evaluate((id) => window.localStorage.setItem("gk_guest_cart_v1", JSON.stringify({ lines: [{ shopProductId: id, quantity: 1 }], updatedAt: Date.now() })), listing.shopProductId);
    await page.goto("/cart");
    await expect(page.getByTestId("guest-cart-place-order")).toBeEnabled({ timeout: 60_000 });
    await noSideScroll(page, "/cart");
    await page.getByTestId("guest-cart-place-order").click();
    const dialog = page.getByTestId("login-sheet").getByRole("dialog");
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x, "sheet starts at the left edge").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "sheet within the width").toBeLessThanOrEqual(376);
    expect(box.y + box.height, "sheet bottom on screen").toBeLessThanOrEqual(813);
    await expect(page.getByTestId("login-sheet-consent-continue")).toBeInViewport();
    await noSideScroll(page, "/cart with the login sheet");
    return `cart + sheet fit (sheet ${Math.round(box.width)}×${Math.round(box.height)} at y=${Math.round(box.y)}); Continue in view`;
  } finally {
    await context.close();
  }
}, { tier: "signed" });

const SCREENS: { id: string; role: "customer2" | "shop" | "rider" | "admin" | "customer"; path: string; expectText: RegExp; what: string }[] = [
  { id: "TC-OV2-081", role: "customer2", path: "/cart", expectText: /Cart|cart/, what: "signed-in cart (payment choice, address after paying)" },
  { id: "TC-OV2-082", role: "customer2", path: "/orders/delivery-location", expectText: /delivery|Delivery|order/i, what: "delivery-location page" },
  { id: "TC-OV2-083", role: "shop", path: "/shop/register", expectText: /Register your shop/, what: "shop registration v2 (current step)" },
  { id: "TC-OV2-084", role: "customer2", path: "/franchise/start", expectText: /Become a franchisee/, what: "Become a franchisee" },
  { id: "TC-OV2-085", role: "customer2", path: "/dealer/team", expectText: /team/i, what: "My team" },
  { id: "TC-OV2-086", role: "customer", path: "/team/invitations", expectText: /request|invitation|team/i, what: "team requests (invitee)" },
  { id: "TC-OV2-087", role: "admin", path: "/admin/shop-documents/registration-licences", expectText: /Registration licences/, what: "admin registration-licences queue" },
];

for (const s of SCREENS) {
  qa([s.id], `phone 375×812: ${s.what} (${s.path}) loads without sideways scroll`, async ({ browser }) => {
    const { page, context } = await pageAs(browser, s.role, PHONE);
    try {
      const res = await page.goto(s.path);
      expect(res?.status() ?? 0, `${s.path} HTTP`).toBeLessThan(400);
      await expect(page.locator("main")).toContainText(s.expectText, { timeout: 60_000 });
      await noSideScroll(page, s.path);
      return `${s.role} ${new URL(page.url()).pathname}: loaded, no sideways scroll`;
    } finally {
      await context.close();
    }
  }, { tier: "signed" });
}

qa(["TC-OV2-088"], "licence step inputs: Upload = file picker (image/*, PDF), Scan = camera (image/*, capture=environment)", async () => {
  blocked(
    "not reachable on staging: the licence step comes after GST / PAN and the fee, and a new registration needs an owner-agreed test PAN / GSTIN (blocked since 23-Nov-2026). In code: src/components/registration/onboarding-v2-steps.tsx:436 accept=\"image/*,application/pdf\" (no capture), :445 accept=\"image/*\" capture=\"environment\"",
  );
}, { tier: "signed" });
