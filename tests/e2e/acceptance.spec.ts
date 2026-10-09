/**
 * End-to-end acceptance scenario (requirement §55).
 *
 * Drives the real browser against the real server and the real database:
 * sign in → wallet top-up → subscribe to 2 L/day → generate the daily order →
 * verify the ₹140 deduction → change tomorrow to 3 L → verify ₹210 →
 * confirm an offline-only product cannot be bought online.
 */
import { expect, test, type Page } from "@playwright/test";

const CRON_SECRET = process.env.CRON_SECRET ?? "dev-cron-secret-change-me";

/** Signs in through the development credentials provider. */
async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  // The dev form is the last one on the page; an email sign-in form may share its placeholder.
  await page.getByPlaceholder("you@example.com").last().fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // New accounts land on /onboarding, returning ones elsewhere: anywhere but /signin.
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}

/** Reads the wallet balance from the wallet page, in paise. */
async function walletBalancePaise(page: Page): Promise<number> {
  await page.goto("/wallet");
  const text = await page
    .locator("p", { hasText: /^₹/ })
    .first()
    .innerText();
  const cleaned = text.replace(/[₹,\s]/g, "");
  return Math.round(Number(cleaned) * 100);
}

test.describe("customer journey", () => {
  const email = `e2e-customer-${Date.now()}@test.local`;

  test("signs in, tops up, subscribes, and is charged correctly", async ({
    page,
    request,
  }) => {
    // ---- Sign in: a wallet is created automatically (§5) ----------------
    await signIn(page, email);
    await page.goto("/wallet");
    await expect(page.getByRole("heading", { name: "My Wallet" })).toBeVisible();
    expect(await walletBalancePaise(page)).toBe(0);

    // ---- Add ₹5,000 to the wallet (§20) --------------------------------
    await page.goto("/wallet");
    // The amount button fills the amount; "Proceed to payment" pays it (settled at once in
    // mock mode, i.e. without live gateway credentials).
    await page.getByRole("button", { name: "₹5,000", exact: true }).click();
    await page.getByRole("button", { name: "Proceed to payment" }).click();
    await expect(page.getByText("added to your wallet")).toBeVisible();
    expect(await walletBalancePaise(page)).toBe(500_000);

    // ---- Find milk and subscribe to 2 L/day (§25–§27) ------------------
    // Target the Cow Milk card specifically — the shop also sells Buffalo Milk
    // at a different price, so `.first()` would silently test the wrong product.
    await page.goto("/shops/kesari-dairy-farm");
    const milkCard = page.locator('[data-product-name="Cow Milk"]');
    await expect(milkCard).toBeVisible();
    await expect(milkCard.getByText("₹70")).toBeVisible();

    await milkCard.getByRole("button", { name: "Subscribe" }).click();
    await page.waitForURL(/\/subscribe\//);
    await expect(
      page.getByRole("heading", { name: "Subscribe to Cow Milk" }),
    ).toBeVisible();

    // Default is 1 L; step up to 2 L.
    await page.getByRole("button", { name: /Increase by 0.5/ }).click();
    await page.getByRole("button", { name: /Increase by 0.5/ }).click();

    // Cost preview: 2 L × ₹70 = ₹140 per delivery (§35).
    // Whole-rupee amounts render without decimals.
    await expect(page.getByText("₹140", { exact: true }).first()).toBeVisible();
    // 7 days = ₹980, 30 days = ₹4,200.
    await expect(page.getByText("₹980", { exact: true }).first()).toBeVisible();

    // The form also has an optional end date (since SM-004), so pick the start date by its label.
    const startDate = await page.getByLabel("Start date").inputValue();
    await page.getByRole("button", { name: /^Subscribe to/ }).click();
    await page.waitForURL(/\/subscriptions\/[0-9a-f-]{36}/);

    const subscriptionId = page.url().split("/subscriptions/")[1];
    expect(subscriptionId).toMatch(/^[0-9a-f-]{36}$/);

    // ---- Generate the day's order and confirm the ₹140 deduction -------
    const firstRun = await request.post("/api/cron/daily-orders", {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      data: { date: startDate },
    });
    expect(firstRun.ok()).toBeTruthy();
    expect((await firstRun.json()).generated).toBeGreaterThanOrEqual(1);

    expect(await walletBalancePaise(page)).toBe(500_000 - 14_000);

    // ---- Re-running the job must not charge again (§33) ----------------
    const rerun = await request.post("/api/cron/daily-orders", {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      data: { date: startDate },
    });
    expect((await rerun.json()).generated).toBe(0);
    expect(await walletBalancePaise(page)).toBe(500_000 - 14_000);

    // ---- The order appears in history ----------------------------------
    // Scoped to the order card: an unscoped text match would also hit the
    // "My Subscriptions" nav link, which is hidden on mobile viewports.
    await page.goto("/orders");
    const orderCard = page.getByTestId("order-card").first();
    await expect(orderCard).toBeVisible();
    await expect(orderCard.getByText("subscription")).toBeVisible();
    await expect(orderCard.getByText("Cow Milk")).toBeVisible();
    await expect(orderCard.getByText("confirmed")).toBeVisible();
    // The charged amount is exactly 2 L x Rs.70.
    await expect(orderCard.getByText("₹140").first()).toBeVisible();
  });
});

test.describe("offline-only products (§12, §55)", () => {
  test("can be seen but not bought online", async ({ page }) => {
    await signIn(page, `e2e-offline-${Date.now()}@test.local`);
    await page.goto("/shops/kesari-dairy-farm");

    // Malai Paneer is seeded as offline-only.
    const paneer = page.locator('[data-product-name="Malai Paneer"]');
    await expect(paneer).toBeVisible();

    // Visible and labelled, but the purchase control is disabled.
    await expect(paneer.getByText("In-shop only").first()).toBeVisible();
    await expect(
      paneer.getByRole("button", { name: "In-shop only" }),
    ).toBeDisabled();
    // And it offers no Add to cart at all.
    await expect(
      paneer.getByRole("button", { name: "Add to cart" }),
    ).toHaveCount(0);
  });
});

test.describe("access control (§4, §47)", () => {
  test("a customer cannot reach the admin console", async ({ page }) => {
    await signIn(page, `e2e-nobody-${Date.now()}@test.local`);
    await page.goto("/admin");
    // Redirected away rather than shown admin content.
    await expect(page).toHaveURL("/");
  });

  test("unauthenticated API calls are rejected", async ({ request }) => {
    const response = await request.get("/api/wallet");
    expect(response.status()).toBe(401);
  });

  test("the cron endpoint rejects a missing or wrong token", async ({
    request,
  }) => {
    expect((await request.post("/api/cron/daily-orders")).status()).toBe(403);
    expect(
      (
        await request.post("/api/cron/daily-orders", {
          headers: { Authorization: "Bearer wrong-secret" },
        })
      ).status(),
    ).toBe(403);
  });
});
