/**
 * Tasks 4 and 5 (October 2026): the compact footer and the GoKesari
 * wordmark / tagline, on desktop and phone widths. Runs against any site:
 *   E2E_BASE_URL=https://test.gokesari.com npx playwright test tests/e2e/branding-footer.spec.ts
 * Public pages only — no sign-in, no data written.
 */
import { expect, test, type Page } from "@playwright/test";

const GREEN = "rgb(21, 128, 61)"; // leaf-700
const SAFFRON = "rgb(194, 65, 12)"; // kesari-700

const VIEWPORTS = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

/** Every link the footer had before it was made compact. */
const FOOTER_LINKS = [
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

    test("footer is compact, keeps every link, and shows company + GSTIN on one small line", async ({ page }) => {
      await page.goto("/");
      const footer = page.getByTestId("site-footer");
      await footer.scrollIntoViewIfNeeded();
      const hrefs = await footer.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
      expect(hrefs.sort()).toEqual([...FOOTER_LINKS].sort());
      const box = await footer.boundingBox();
      // The old footer was ~300 px tall on desktop and ~900 px on a phone.
      expect(box!.height).toBeLessThan(vp.name === "desktop" ? 140 : 260);
      await expect(page.getByTestId("footer-company-line")).toContainText("GSTIN");
      const fontSize = await footer.locator("a").first().evaluate((a) => parseFloat(getComputedStyle(a).fontSize));
      expect(fontSize).toBeLessThanOrEqual(12);
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

    test("wordmark: Go green, Kesari saffron, G and K bold; tagline green and bold", async ({ page }) => {
      await page.goto("/");
      await page.getByTestId("site-footer").scrollIntoViewIfNeeded();
      const scope = "[data-testid=site-footer] ";
      expect(await color(page, `${scope}[data-testid=brand-go]`)).toBe(GREEN);
      expect(await color(page, `${scope}[data-testid=brand-kesari]`)).toBe(SAFFRON);
      expect(await color(page, `${scope}[data-testid=brand-tagline]`)).toBe(GREEN);
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
      expect(await color(page, "[data-testid=signin-brand] [data-testid=brand-go]")).toBe(GREEN);
    });
  });
}

/** Links whose dot is wrong: shown at the start of a line, or hidden mid-line. */
async function misplacedDots(page: Page) {
  return page.getByTestId("site-footer").locator("nav ul").evaluateAll((uls) =>
    uls.flatMap((ul) => {
      const wrong: string[] = [];
      let top: number | null = null;
      for (const li of Array.from(ul.querySelectorAll<HTMLElement>(":scope > li:not([data-line-break])"))) {
        const lineStart = top === null || li.offsetTop > top + 2;
        const dotShown = getComputedStyle(li.querySelector("span")!).display !== "none";
        if (dotShown === lineStart) wrong.push(`${li.textContent?.replace("·", "").trim()} (${lineStart ? "line start" : "mid-line"})`);
        top = li.offsetTop;
      }
      return wrong;
    }),
  );
}

test("footer: no line starts with a dot and no link loses its dot, at any width", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("site-footer").scrollIntoViewIfNeeded();
  // 412 px (Pixel 7) is where a link fitted on the line above only without its dot.
  for (const width of [320, 360, 390, 412, 430, 600, 768, 1024, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => misplacedDots(page), { message: `${width}px` }).toEqual([]);
  }
});
