/**
 * Price comparison between local shops switched off (docs/price-comparison-off-2026-11,
 * owner decision 24-Nov-2026: flag local_price_comparison_enabled OFF on both sites).
 * Production-safe: GETs of public pages only.
 *
 * Off means: /search/compare answers 404, no product card or menu offers
 * "Compare N prices" / "Compare prices", the home page has no comparison block
 * or banner leading to it, and the product page lists shops nearest-first with
 * no "Lowest price" tag. A failure here on test.gokesari.com or gokesari.com
 * means the flag was switched on against the owner's decision — or a surface
 * escaped the flag.
 */
import type { Page } from "@playwright/test";

import { expect, qa } from "../lib/record";
import { open } from "../lib/shopping-helpers";
import { TARGET } from "../lib/target";

async function noCompareLinks(page: Page, path: string): Promise<void> {
  await open(page, path);
  await expect(page.getByTestId("compare-n-prices"), `${path}: "Compare N prices" link`).toHaveCount(0);
  await expect(page.locator('a[href^="/search/compare"]'), `${path}: a link to /search/compare`).toHaveCount(0);
  await expect(page.getByTestId("home-price-comparison"), `${path}: comparison block`).toHaveCount(0);
}

qa("TC-PCOMP-001", "price comparison off: /search/compare (with or without ?product=) answers 404 and shows no prices", async ({ page }) => {
  const seen: string[] = [];
  for (const path of ["/search/compare", "/search/compare?product=9b6a16c0-a990-4d70-8c9b-32974a1862f1"]) {
    const res = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(res?.status(), `${path} must be 404 while local_price_comparison_enabled is off`).toBe(404);
    await expect(page.getByTestId("home-price-comparison")).toHaveCount(0);
    seen.push(`${path} → ${res?.status()}`);
  }
  return `${TARGET}: ${seen.join("; ")}`;
}, { mobile: true });

qa("TC-PCOMP-002", "price comparison off: home, search and the shops list offer no 'Compare N prices' link, Compare tab or comparison banner", async ({ page }) => {
  const paths = ["/", "/search?q=milk", "/shops", "/categories"];
  for (const path of paths) await noCompareLinks(page, path);
  return `${TARGET}: no comparison link on ${paths.join(", ")}`;
}, { mobile: true, partial: "the phone bottom bar is covered by the mobile project (no a[href^=/search/compare] on the page)" });

qa("TC-PCOMP-003", "price comparison off: a product page lists its shops nearest-first with no 'Lowest price' tag", async ({ page }) => {
  await open(page, "/search?q=milk");
  const productLink = page.locator('a[href^="/products/"]').first();
  if (!(await productLink.count())) return `${TARGET}: no product listed for 'milk' — nothing to check`;
  const href = await productLink.getAttribute("href");
  await open(page, href!);
  const list = page.getByTestId("price-comparison");
  if (!(await list.count())) return `${TARGET}: ${href} lists no shop`;
  await expect(list).toHaveAttribute("data-mode", "nearest");
  await expect(list).not.toContainText("Lowest price");
  await expect(page.getByRole("heading", { name: "Compare prices" })).toHaveCount(0);
  return `${TARGET}: ${href} — shops nearest-first, no 'Lowest price'`;
}, { mobile: true });
