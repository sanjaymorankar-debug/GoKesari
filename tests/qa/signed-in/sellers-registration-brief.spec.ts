/**
 * Shop registration redesign — "follow the brief" (owner decision 29 Oct 2026,
 * docs/shop-onboarding-wizard-2026-10/BRIEF_REDESIGN.md). Own IDs RB-01 …, not in
 * test-cases.xlsx yet.
 *
 * Signed tier, admin account: an admin may open the wizard at /shop/register?wizard=1 while
 * shop_onboarding_wizard_enabled is off. These checks only look and click the yes / no
 * questions — nothing is sent to the GST / PAN routes, so no draft or shop is created.
 * The approval path itself (GST / PAN verified + payment → approved; failures → pending) is
 * proven by tests/integration/onboarding-wizard-step2.test.ts on both database layouts.
 */
import { pageAs } from "../lib/actors";
import { expect, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 180_000 };

const TILES = ["GST number", "PAN", "Udyam", "FSSAI", "Turnover & fee", "Payment", "Approval", "Location", "Category", "Products"];

qa("RB-01", "wizard: the ten steps are shown at the top in the brief's order, on one screen at 390 × 844 and 1280 × 800", async ({ browser }) => {
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
      notes.push(`${viewport.width}px: 10 tiles, board bottom ${Math.round((box?.y ?? 0) + (box?.height ?? 0))}px`);
    } finally {
      await context.close();
    }
  }
  return notes.join("; ");
}, signed);

qa("RB-02", "wizard: 'Do you have a GST number?' → No → 'Do you have a PAN number?' → No → 'A valid PAN or GST is required to register' with the firm types", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin", { viewport: { width: 390, height: 844 } });
  try {
    await page.goto("/shop/register?wizard=1");
    await expect(page.getByRole("heading", { name: /Do you have a GST number\?/ })).toBeVisible();
    await page.getByRole("radiogroup", { name: "Do you have a GST number?" }).getByRole("button", { name: "No" }).click();
    await expect(page.getByRole("heading", { name: /Do you have a PAN number\?/ })).toBeVisible();
    await page.getByRole("radiogroup", { name: "Do you have a PAN number?" }).getByRole("button", { name: "No" }).click();
    const message = page.getByText("A valid PAN or GST is required to register");
    await expect(message).toBeVisible();
    await expect(page.getByText(/shops, professionals \(advocates, doctors, CAs\), companies, industries and startups/)).toBeVisible();
    // No number field is offered: nothing can be sent without a PAN or GST.
    await expect(page.getByLabel(/^PAN$|GST number \(GSTIN\)/)).toHaveCount(0);
    // Back to Yes on PAN: the PAN field and the declaration appear.
    await page.getByRole("radiogroup", { name: "Do you have a PAN number?" }).getByRole("button", { name: "Yes" }).click();
    await expect(page.getByLabel("PAN", { exact: true })).toBeVisible();
    return "GST No → PAN question; PAN No → 'A valid PAN or GST is required to register' with the firm types and no number field; PAN Yes → PAN field";
  } finally {
    await context.close();
  }
}, signed);
