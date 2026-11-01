/**
 * Shop registration redesign — "follow the brief" (owner decision 29 Oct 2026,
 * docs/shop-onboarding-wizard-2026-10/BRIEF_REDESIGN.md), updated for the owner's brief of
 * 30 Oct 2026 (FLOW_2026-10-30-b.md). Own IDs RB-01 …, not in test-cases.xlsx yet.
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

// Owner brief 30 Oct 2026 (FLOW_2026-10-30-b.md): the fee before the address and map pin.
const TILES = ["Referral", "Email", "Documents", "Validate", "Confirm details", "Payment", "Live", "Address & location", "Category", "Products"];

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

qa("RB-02", "wizard screen 2: one checklist at the top, then 'Enter Referral Code' and 'Request Referral Code', then the documents to keep ready", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin", { viewport: { width: 390, height: 844 } });
  try {
    await page.goto("/shop/register?wizard=1");
    const heading = page.getByRole("heading", { name: "1. Your referral code" });
    if (!(await heading.isVisible().catch(() => false))) {
      // The admin account already has a draft past step 1: open the step from its tile.
      await page.getByTestId("registration-tiles").getByRole("button", { name: /1\. Referral/ }).click();
    }
    await expect(heading).toBeVisible();
    // Exactly one checklist: the tile board.
    await expect(page.getByTestId("registration-tiles")).toHaveCount(1);
    const options = page.getByTestId("referral-options");
    await expect(options.getByRole("heading", { name: "Enter Referral Code" })).toBeVisible();
    await expect(options.getByRole("button", { name: "Request Referral Code" })).toBeVisible();
    await expect(page.getByTestId("wizard-referral-code")).toBeVisible();
    // The documents list comes after the two options.
    const list = page.getByTestId("documents-list");
    await expect(list.getByRole("listitem")).toHaveCount(6);
    const below = await page.evaluate(() => {
      const o = document.querySelector('[data-testid="referral-options"]')!.getBoundingClientRect();
      const l = document.querySelector('[data-testid="documents-list"]')!.getBoundingClientRect();
      return l.top >= o.bottom;
    });
    expect(below, "documents list below the referral options").toBe(true);
    return "tile board once; Enter / Request Referral Code side by side; 6 documents listed below them";
  } finally {
    await context.close();
  }
}, signed);
