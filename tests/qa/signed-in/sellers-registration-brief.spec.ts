/**
 * Shop registration — identity first (owner brief 08-Nov-2026,
 * docs/shop-onboarding-identity-first-2026-11/BRIEF.md). Own IDs RB-01 …, not in test-cases.xlsx yet.
 *
 * Signed tier, admin account: the wizard is the only registration flow (/shop/register).
 * These checks only look — nothing is sent to the
 * referral, GST or PAN routes, so no draft or shop is created.
 * The approval path itself (GST / PAN verified + payment → approved; failures → pending) is
 * proven by tests/integration/onboarding-wizard-step2.test.ts on both database layouts.
 */
import { pageAs, shopFreeCustomer } from "../lib/actors";
import { expect, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 180_000 };

// Owner brief 08-Nov-2026: verify → address → map pin → shop name → pay → live → products.
const TILES = ["Sign in", "Verify", "Address", "Pay", "Live"];

qa("RB-01", "wizard: the five steps are shown at the top in the brief's order, on one screen at 390 × 844 and 1280 × 800", async ({ browser }) => {
  const notes: string[] = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    const { context, page } = await pageAs(browser, "admin", { viewport });
    try {
      await page.goto("/shop/register");
      const tiles = page.getByTestId("registration-tiles").getByRole("listitem");
      await expect(tiles.first()).toBeVisible();
      const labels = (await tiles.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()).join(" | ");
      TILES.forEach((label, i) => expect(labels, `tile ${i + 1}`).toContain(`${i + 1}. ${label}`));
      // The whole tile board is inside the first screen, and the page does not scroll sideways.
      const box = await page.getByTestId("registration-tiles").boundingBox();
      expect(box && box.y + box.height <= viewport.height, "tile board inside the first screen").toBe(true);
      const scroll = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return el.scrollWidth - el.clientWidth;
      });
      expect(scroll, "horizontal scroll").toBeLessThanOrEqual(1);
      notes.push(`${viewport.width}px: 5 tiles, board bottom ${Math.round((box?.y ?? 0) + (box?.height ?? 0))}px`);
    } finally {
      await context.close();
    }
  }
  return notes.join("; ");
}, signed);

qa("RB-02", "after sign-in only the referral code and GST / PAN are asked; shop name and address are not", async ({ browser }) => {
  const { context, page } = await pageAs(browser, await shopFreeCustomer(), { viewport: { width: 390, height: 844 } });
  try {
    await page.goto("/shop/register");
    const tile = page.getByTestId("registration-tiles").getByRole("button", { name: /2\. Verify/ });
    if (await tile.isVisible().catch(() => false)) await tile.click();
    await expect(page.getByTestId("wizard-referral-code")).toBeVisible();
    await expect(page.getByTestId("gstin-input")).toBeVisible();
    await page.getByTestId("wizard-referral-code").fill("");
    await expect(page.getByTestId("request-referral-code")).toBeVisible();
    await expect(page.getByTestId("shop-name")).toHaveCount(0);
    await expect(page.getByTestId("address-line1")).toHaveCount(0);
    return "first screen: referral code + GST number only";
  } finally {
    await context.close();
  }
}, signed);
