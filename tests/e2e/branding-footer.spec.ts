/**
 * Tasks 4 and 5 (October 2026): the footer and the GoKesari wordmark /
 * tagline, on desktop and phone widths. The footer is now the organised one
 * of docs/homepage-uiux-2026-10 (F5): labelled columns, accordions on phones.
 * Runs against any site:
 *   E2E_BASE_URL=https://test.gokesari.com npx playwright test tests/e2e/branding-footer.spec.ts
 * Public pages only — no sign-in, no data written.
 */
import { expect, test, type Page } from "@playwright/test";

const SAFFRON = "rgb(194, 65, 12)"; // kesari-700

const VIEWPORTS = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

/** Every link the footer had before, plus Help (/support) in the Support column. */
const FOOTER_LINKS = [
  "/support",
  "/about",
  "/contact",
  "/sell",
  "/delivery-partner/apply",
  "/legal/seller-terms",
  "/legal/privacy-policy",
  "/legal/terms",
  "/legal/cookie-policy",
  "/legal/refund-policy",
  "/legal/shipping-policy",
  "/legal/subscription-terms",
  "/legal/wallet-terms",
  "/legal/voucher-terms",
  "/legal/grievance-redressal",
  "/grievance",
];

async function color(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);
}

for (const vp of VIEWPORTS) {
  test.describe(`branding and footer — ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("footer: four labelled columns keep every link, and the company line shows the GSTIN", async ({ page }) => {
      await page.goto("/");
      const footer = page.getByTestId("site-footer");
      await footer.scrollIntoViewIfNeeded();
      const hrefs = await footer.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
      expect(hrefs.sort()).toEqual([...FOOTER_LINKS].sort());
      await expect(footer.getByTestId("footer-column")).toHaveCount(4);
      expect(await footer.locator("h2").allInnerTexts()).toEqual(["Company", "Make Money", "Support", "Legal"]);
      await expect(page.getByTestId("footer-company-line")).toContainText("GSTIN");
      // Phones fold the columns into accordions; wide screens show them open.
      const links = footer.locator("[data-key=legal] ul");
      if (vp.name === "phone") await expect(links).toBeHidden();
      else await expect(links).toBeVisible();
      // No horizontal scroll from the footer on a phone.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test("every footer link opens a page", async ({ page, request }) => {
      for (const href of FOOTER_LINKS) {
        const res = await request.get(href);
        expect(res.status(), href).toBeLessThan(400);
      }
      await page.goto("/");
    });

    test("wordmark: Go and Kesari saffron, G and K bold; tagline saffron and bold", async ({ page }) => {
      await page.goto("/");
      await page.getByTestId("site-footer").scrollIntoViewIfNeeded();
      const scope = "[data-testid=site-footer] ";
      expect(await color(page, `${scope}[data-testid=brand-go]`)).toBe(SAFFRON);
      expect(await color(page, `${scope}[data-testid=brand-kesari]`)).toBe(SAFFRON);
      expect(await color(page, `${scope}[data-testid=brand-tagline]`)).toBe(SAFFRON);
      const weights = await page
        .locator(`${scope}[data-testid=brand-wordmark] .font-extrabold`)
        .evaluateAll((els) => els.map((e) => [e.textContent, Number(getComputedStyle(e).fontWeight)]));
      expect(weights).toEqual([
        ["G", 800],
        ["K", 800],
      ]);
      const taglineWeight = await page.locator(`${scope}[data-testid=brand-tagline]`).evaluate((e) => Number(getComputedStyle(e).fontWeight));
      expect(taglineWeight).toBeGreaterThanOrEqual(700);
    });

    test("sign-in page shows the wordmark and the tagline", async ({ page }) => {
      await page.goto("/signin");
      const brand = page.getByTestId("signin-brand");
      await expect(brand).toContainText("GoKesari");
      await expect(brand).toContainText("Everything for Everyone");
      expect(await color(page, "[data-testid=signin-brand] [data-testid=brand-go]")).toBe(SAFFRON);
    });
  });
}
