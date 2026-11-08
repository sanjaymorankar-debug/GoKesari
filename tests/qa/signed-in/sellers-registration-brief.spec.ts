/**
 * Shop registration — identity first (owner brief 08-Nov-2026,
 * docs/shop-onboarding-identity-first-2026-11/BRIEF.md). Own IDs RB-01 …, not in test-cases.xlsx yet.
 *
 * Signed tier, admin account: an admin may open the wizard at /shop/register?wizard=1 while
 * shop_onboarding_wizard_enabled is off. These checks only look — nothing is sent to the
 * referral, GST or PAN routes, so no draft or shop is created.
 * The approval path itself (GST / PAN verified + payment → approved; failures → pending) is
 * proven by tests/integration/onboarding-wizard-step2.test.ts on both database layouts.
 */
import { pageAs } from "../lib/actors";
import { expect, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 180_000 };

// Owner brief 08-Nov-2026: verify → address → map pin → shop name → pay → live → products.
const TILES = ["Verify", "Address", "Map pin", "Shop name", "Pay", "Live", "Products"];

qa("RB-01", "wizard: the seven steps are shown at the top in the brief's order, on one screen at 390 × 844 and 1280 × 800", async ({ browser }) => {
  const notes: string[] = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    const { context, page } = await pageAs(browser, "admin", { viewport });
    try {
      await page.goto("/shop/register?wizard=1");
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
      notes.push(`${viewport.width}px: 7 tiles, board bottom ${Math.round((box?.y ?? 0) + (box?.height ?? 0))}px`);
    } finally {
      await context.close();
    }
  }
  return notes.join("; ");
}, signed);

qa("RB-02", "'Verify your business' first: the referral code and 'Do you have a GST number?' — Yes asks the GSTIN, No asks the PAN", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin", { viewport: { width: 390, height: 844 } });
  try {
    await page.goto("/shop/register?wizard=1");
    const heading = page.getByRole("heading", { name: "Verify your business" });
    if (!(await heading.isVisible().catch(() => false))) {
      // The admin account already has a draft past step 1: open the step from its tile.
      await page.getByTestId("registration-tiles").getByRole("button", { name: /1\. Verify/ }).click();
    }
    await expect(heading).toBeVisible();
    await expect(page.getByTestId("registration-tiles")).toHaveCount(1);
    await expect(page.getByTestId("wizard-referral-code")).toBeVisible();
    await expect(page.getByText("Do you have a GST number?", { exact: true })).toBeVisible();
    await page.getByTestId("has-gst-yes").click();
    await expect(page.getByText("Enter your 15-digit GSTIN")).toBeVisible();
    await expect(page.getByTestId("gstin-input")).toHaveAttribute("maxlength", "15");
    // The verify button is on the first screen at phone size — no scrolling to reach it.
    const verify = await page.getByTestId("verify-identity").boundingBox();
    expect(verify && verify.y + verify.height <= 844, "Verify button inside the screen").toBe(true);
    await page.getByTestId("has-gst-no").click();
    await expect(page.getByText("Enter your 10-character PAN")).toBeVisible();
    await expect(page.getByTestId("pan-input")).toHaveAttribute("maxlength", "10");
    // Nothing above the verify screen: no shop name, address or map before it.
    await expect(page.getByTestId("shop-name")).toHaveCount(0);
    await expect(page.getByTestId("address-line1")).toHaveCount(0);
    return "Verify your business: referral + GST yes/no; GSTIN (15) and PAN (10) fields; verify button within 844px";
  } finally {
    await context.close();
  }
}, signed);
