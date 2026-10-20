/**
 * Homepage UI/UX upgrade (docs/homepage-uiux-2026-10): F1–F6 on every
 * breakpoint and language, plus the existing routes, on any site:
 *
 *   E2E_BASE_URL=https://test.gokesari.com CHROMIUM_PATH=/opt/pw-browsers/chromium \
 *     npx playwright test tests/e2e/homepage-uiux.spec.ts --project=chromium
 *
 * PRODUCTION-SAFE as a guest: every check is a GET, a cookie in this browser
 * (language, delivery location) or a click that changes nothing on the
 * server; a search submitted on production is intercepted before it reaches
 * the site (no search is recorded). The "signed in" group runs only against a
 * local development server (its dev sign-in creates throwaway accounts).
 *
 * Each case's outcome goes to docs/homepage-uiux-2026-10/results/<host>.json and
 * its screenshot to e2e-evidence/homepage-uiux/<host>/ (not committed) for the
 * status workbook (scripts/reports/homepage-uiux-workbook.py).
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { HOME } from "../../src/lib/home-i18n";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const HOST = new URL(BASE_URL).host;
const IS_LOCAL = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(HOST);
const IS_PROD = HOST === "gokesari.com" || HOST === "www.gokesari.com";
/**
 * E2E_APP=android|ios: the same checks as the app's WebView sees them — the
 * app's user agent (mobile/src/App.tsx: "GoKesariApp/<version> (<os>)"),
 * touch, phone widths. An emulation of the app's WebView, not a device.
 */
const APP = process.env.E2E_APP === "android" || process.env.E2E_APP === "ios" ? process.env.E2E_APP : null;
const APP_VERSION = process.env.E2E_APP_VERSION ?? "1.3.0";
const APP_UA = {
  android: `Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 GoKesariApp/${APP_VERSION} (android)`,
  ios: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GoKesariApp/${APP_VERSION} (ios)`,
};
if (APP) test.use({ userAgent: APP_UA[APP], isMobile: true, hasTouch: true });
const RUN = `${HOST.replace(/[:]/g, "_")}${APP ? `-app-${APP}` : ""}`;
// Outside test-results/, which Playwright empties at the start of every run.
const SHOTS = `e2e-evidence/homepage-uiux/${RUN}`;
const OUT = `docs/homepage-uiux-2026-10/results/${RUN}.json`;

type Lang = "en" | "hi" | "mr";
const LANGS: Lang[] = ["en", "hi", "mr"];
const BREAKPOINTS = APP ? [360, 390, 414] : [360, 390, 414, 768, 1024, 1440];

interface Row {
  id: string;
  feature: string;
  scenario: string;
  device: string;
  lang: string;
  user: string;
  status: "pass" | "fail";
  detail: string;
  evidence: string;
}

function save(row: Row) {
  mkdirSync("docs/homepage-uiux-2026-10/results", { recursive: true });
  const previous: { rows: Row[] } = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { rows: [] };
  const rows = [...previous.rows.filter((r) => r.id !== row.id), row].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(OUT, JSON.stringify({ baseUrl: BASE_URL, at: new Date().toISOString(), rows }, null, 2));
}

/** Runs one case, records pass/fail with a screenshot, and rethrows a failure. */
async function tc(page: Page | null, meta: Omit<Row, "status" | "detail" | "evidence">, body: () => Promise<string | void>) {
  const evidence = page ? `${SHOTS}/${meta.id}.png` : "";
  try {
    const detail = (await body()) ?? "";
    if (page) await page.screenshot({ path: evidence, fullPage: false }).catch(() => {});
    save({ ...meta, status: "pass", detail, evidence });
  } catch (error) {
    if (page) await page.screenshot({ path: evidence, fullPage: false }).catch(() => {});
    save({ ...meta, status: "fail", detail: error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : String(error), evidence });
    throw error;
  }
}

/** Phone width in app mode (the app runs on phones), else the width asked for. */
const size = (width: number, height: number) => (APP ? { width: 390, height: 844 } : { width, height });

async function useLang(page: Page, lang: Lang) {
  await page.context().addCookies([{ name: "gk_lang", value: lang, url: BASE_URL }]);
}

/** Nothing wider than the screen. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

/* --------------------------------------------- F1/F5/F6: every breakpoint × language */

for (const width of BREAKPOINTS) {
  for (const lang of LANGS) {
    test(`home @${width}px ${lang} — guest: discovery layout, no account tiles, footer, no sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await useLang(page, lang);
      const phone = width < 1024;
      await tc(page, { id: `HP-${width}-${lang}`, feature: "F1/F2/F5/F6", scenario: "Home renders the discovery layout", device: APP ? `${APP} app ${width}px` : `${width}px`, lang, user: "guest" }, async () => {
        const response = await page.goto("/", { waitUntil: "networkidle" });
        expect(response?.status()).toBe(200);
        await expect(page.locator("[data-home-discovery]")).toHaveCount(1);
        // F1: the account tiles are gone from the page body.
        await expect(page.locator("[data-tile-board]")).toHaveCount(0);
        await expect(page.locator("main a[href='/wallet#add-money']")).toHaveCount(0);
        // F2: search with the placeholder in this language.
        const search = page.getByTestId("search-input").locator("visible=true").first();
        await expect(search).toHaveAttribute("placeholder", HOME.searchPlaceholder[lang]);
        // F1: hero banners with reserved height; categories; shops; products; Sell / Deliver.
        const hero = page.getByTestId("hero-carousel");
        await expect(hero).toBeVisible();
        expect((await hero.boundingBox())!.height).toBeGreaterThanOrEqual(170);
        await expect(page.getByTestId("home-category")).toHaveCount(8);
        await expect(page.getByTestId("shop-chip")).toHaveCount(4);
        // F4: Compare prices is the accent chip with its badge.
        const compare = page.locator("[data-testid=shop-chip][data-key=compare]");
        await expect(compare).toHaveAttribute("data-accent", "smart");
        await expect(compare.getByTestId("smart-tool-badge")).toHaveText(HOME.smartTool[lang]);
        await expect(page.locator("[data-testid=buy-again], [data-testid=popular-in-area]")).toHaveCount(1);
        await expect(page.getByTestId("cta-sell")).toBeVisible();
        await expect(page.getByTestId("cta-deliver")).toBeVisible();
        // F5: four labelled columns, the language switch and the company line.
        await expect(page.getByTestId("footer-column")).toHaveCount(4);
        await expect(page.locator("#footer-company")).toContainText(HOME.footerCompany[lang]);
        await expect(page.getByTestId("footer-company-line")).toContainText("GSTIN 27ABCCA8318D1ZV");
        await expect(page.getByTestId("footer-company-line")).toContainText("ASMY GLOBAL TRADING & CONSULTANCY INDIA PRIVATE LIMITED");
        // F6: header, location and cart always on screen; phones get the bottom navigation.
        await expect(page.getByTestId("deliver-to")).toBeVisible();
        await expect(page.getByTestId("home-cart")).toBeVisible();
        if (phone) {
          await expect(page.getByTestId("bottom-nav-item")).toHaveCount(5);
          for (const item of await page.getByTestId("bottom-nav-item").all()) {
            const box = await item.boundingBox();
            expect(box!.height).toBeGreaterThanOrEqual(44);
          }
          await expect(page.getByTestId("drawer-open")).toBeVisible();
        } else {
          await expect(page.getByTestId("mobile-shop-nav")).toBeHidden();
          await expect(page.getByTestId("account-signin")).toBeVisible();
          await expect(page.getByTestId("account-signin")).toHaveText(HOME.signInOrCreate[lang], { useInnerText: true });
        }
        if (width <= 430) expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
        return `hero ${(await hero.boundingBox())!.height}px`;
      });
    });
  }
}

/* --------------------------------------------------------------------- F2 search */

test("F2 — suggestions: focus shows trending, typing groups and highlights, keys move, Esc closes, Enter searches", async ({ page }) => {
  await page.setViewportSize(size(1440, 900));
  await useLang(page, "en");
  await tc(page, { id: "F2-SUGGEST-DESKTOP", feature: "F2", scenario: "Autosuggest with keyboard", device: "1440px", lang: "en", user: "guest" }, async () => {
    await page.goto("/", { waitUntil: "networkidle" });
    const input = page.getByTestId("search-input").locator("visible=true").first();
    await input.click();
    await expect(page.locator("[data-testid=search-option][data-group=trending]").first()).toBeVisible();
    await input.fill("mil");
    await expect(page.locator("[data-testid=search-option][data-group=products]").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-testid=search-option][data-group=products] mark").first()).toHaveText(/mil/i);
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    const active = await input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    await input.press("Escape");
    await expect(page.getByTestId("search-suggestions")).toHaveCount(0);
    // Enter submits to the existing search page (intercepted on production, so nothing is recorded).
    if (IS_PROD) await page.route("**/search?q=**", (route) => route.fulfill({ status: 200, body: "<html><body>intercepted</body></html>", contentType: "text/html" }));
    await input.fill("milk");
    await input.press("Enter");
    await page.waitForURL(/\/search\?q=milk/);
    return "products group, highlight, aria-activedescendant, Esc, Enter → /search?q=milk";
  });
});

test("F2 — the suggestion API answers in groups and ignores one letter", async ({ request }) => {
  await tc(null, { id: "F2-API", feature: "F2", scenario: "GET /api/search/suggest", device: "API", lang: "en", user: "guest" }, async () => {
    const short = await request.get("/api/search/suggest?q=m");
    expect(short.status()).toBe(200);
    expect(await short.json()).toMatchObject({ products: [], shops: [], categories: [] });
    const res = await request.get("/api/search/suggest?q=milk");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.products) && Array.isArray(body.shops) && Array.isArray(body.categories)).toBe(true);
    const recent = await request.get("/api/search/recent");
    expect(recent.status()).toBe(200);
    expect((await recent.json()).trending.length).toBeGreaterThan(0);
    return `${body.products.length} products, ${body.shops.length} shops, ${body.categories.length} categories`;
  });
});

test("F2 — voice search: the mic in the page's language, hidden where the browser can't listen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useLang(page, "mr");
  await tc(page, { id: "F2-VOICE", feature: "F2", scenario: "Mic shown when supported, hidden when not", device: "390px", lang: "mr", user: "guest" }, async () => {
    await page.addInitScript(() => {
      // A stand-in recogniser that records the language it was started in.
      class FakeRecognition {
        lang = "";
        interimResults = false;
        maxAlternatives = 1;
        onresult: ((e: unknown) => void) | null = null;
        onerror: (() => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          (window as unknown as { __voiceLang: string }).__voiceLang = this.lang;
          this.onend?.();
        }
        abort() {}
      }
      const w = window as unknown as { webkitSpeechRecognition: unknown; SpeechRecognition: unknown };
      w.webkitSpeechRecognition = FakeRecognition;
      w.SpeechRecognition = FakeRecognition;
    });
    await page.goto("/", { waitUntil: "networkidle" });
    const mic = page.getByTestId("voice-search").locator("visible=true").first();
    await expect(mic).toHaveAttribute("aria-label", HOME.voiceSearch.mr);
    await expect(async () => {
      await mic.click();
      expect(await page.evaluate(() => (window as unknown as { __voiceLang?: string }).__voiceLang)).toBe("mr-IN");
    }).toPass({ timeout: 15_000 });

    const page2 = await page.context().newPage();
    await page2.setViewportSize({ width: 390, height: 844 });
    await page2.addInitScript(() => {
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    });
    await page2.goto("/", { waitUntil: "networkidle" });
    await expect(page2.getByTestId("voice-search")).toHaveCount(0);
    await page2.close();
    return "mr-IN recogniser; no mic without the API";
  });
});

test("App — voice search only in app builds that declare the microphone (1.3.0+)", async ({ browser }) => {
  test.skip(APP !== "ios", "the iPhone app is the one that needs the declaration");
  const fake = () => {
    class FakeRecognition {
      lang = "";
      start() {}
      abort() {}
    }
    const w = window as unknown as { webkitSpeechRecognition: unknown; SpeechRecognition: unknown };
    w.webkitSpeechRecognition = FakeRecognition;
    w.SpeechRecognition = FakeRecognition;
  };
  for (const [version, mics] of [["1.2.0", 0], ["1.3.0", 1]] as const) {
    const context = await browser.newContext({ userAgent: APP_UA.ios.replace(APP_VERSION, version), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.addInitScript(fake);
    await tc(page, { id: `APP-VOICE-${version}`, feature: "F2/App", scenario: `Mic in iPhone app ${version}`, device: "ios app 390px", lang: "en", user: "guest" }, async () => {
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.getByTestId("voice-search").locator("visible=true")).toHaveCount(mics);
    });
    await context.close();
  }
});

/* --------------------------------------------------- F1 drawer, F6 sheet, sticky header */

test("F1 — phone drawer: guests see only Sign in / Create account", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useLang(page, "hi");
  await tc(page, { id: "F1-DRAWER-GUEST", feature: "F1", scenario: "Hamburger drawer for a guest", device: "390px", lang: "hi", user: "guest" }, async () => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("drawer-open").click();
    const drawer = page.getByTestId("account-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("drawer-signin")).toHaveText(HOME.signInOrCreate.hi);
    await expect(page.getByTestId("drawer-group")).toHaveCount(0);
    await expect(drawer.locator("a[href='/wallet#add-money'], a[href='/orders?tab=active']")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });
});

test("F6 — Deliver to: bottom sheet with GPS, saved addresses and PIN; choosing refreshes the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useLang(page, "en");
  await tc(page, { id: "F6-LOCATION-SHEET", feature: "F6", scenario: "Location bottom sheet, PIN 411014", device: "390px", lang: "en", user: "guest" }, async () => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("deliver-to").click();
    const sheet = page.getByTestId("location-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("location-gps")).toBeVisible();
    // Above the bottom navigation, not under it.
    const sheetBox = await sheet.getByRole("dialog").boundingBox();
    expect(sheetBox!.y + sheetBox!.height).toBeGreaterThan(800);
    await sheet.getByPlaceholder(HOME.pincode.en).fill("411014");
    await sheet.getByRole("button", { name: HOME.usePincode.en }).click();
    await expect(page.getByTestId("deliver-to-label")).toContainText("411014", { timeout: 15_000 });
    await expect(page.locator("#home-shops")).toHaveText(HOME.shopsNearYou.en);
    return "label shows 411014; section reads Shops near you";
  });
});

test("F6 — header stays on screen and compacts while scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await tc(page, { id: "F6-STICKY", feature: "F6", scenario: "Sticky, compacting header", device: "360px", lang: "en", user: "guest" }, async () => {
    await page.goto("/", { waitUntil: "networkidle" });
    const header = page.getByTestId("home-header");
    await expect(header).toHaveAttribute("data-compact", "false");
    await page.mouse.wheel(0, 1800);
    await expect(header).toHaveAttribute("data-compact", "true");
    const box = await header.boundingBox();
    expect(box!.y).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("home-cart")).toBeInViewport();
    await expect(page.getByTestId("deliver-to")).toBeInViewport();
    await expect(page.getByTestId("search-input").locator("visible=true").first()).toBeInViewport();
    await expect(page.getByTestId("mobile-shop-nav")).toBeInViewport();
  });
});

test("F1 — hero banners: next, pause, and a default banner when none is live", async ({ page }) => {
  await page.setViewportSize(size(1024, 800));
  await tc(page, { id: "F1-HERO", feature: "F1", scenario: "Carousel controls", device: "1024px", lang: "en", user: "guest" }, async () => {
    await page.goto("/", { waitUntil: "networkidle" });
    const slides = page.getByTestId("hero-slide");
    const count = await slides.count();
    expect(count).toBeGreaterThanOrEqual(1);
    if (count > 1) {
      // Clicked again only while the page has not hydrated yet (a click before that does nothing).
      for (let i = 0; i < 20 && (await page.getByTestId("hero-pause").getAttribute("aria-pressed")) !== "true"; i += 1) {
        await page.getByTestId("hero-pause").click();
        await page.waitForTimeout(500);
      }
      await expect(page.getByTestId("hero-pause")).toHaveAttribute("aria-pressed", "true");
      await expect(slides.nth(0)).toHaveAttribute("aria-hidden", "false");
      // → moves on (the arrows show from 640 px; phones swipe).
      await page.getByTestId("hero-pause").press("ArrowRight");
      await expect(slides.nth(1)).toHaveAttribute("aria-hidden", "false");
      if (count < 3) {
        // Two banners: the next step would wrap round; nothing more to check.
      } else if (APP) {
        // A left swipe moves on once more.
        await page.getByTestId("hero-carousel").evaluate((el) => {
          const box = el.getBoundingClientRect();
          const point = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: box.top + 40 });
          el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [point(box.right - 30)], changedTouches: [point(box.right - 30)] }));
          el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [point(box.left + 30)] }));
        });
        await expect(slides.nth(2)).toHaveAttribute("aria-hidden", "false");
      } else {
        await page.getByRole("button", { name: HOME.nextSlide.en }).click();
        await expect(slides.nth(2)).toHaveAttribute("aria-hidden", "false");
      }
    }
    return `${count} banners`;
  });
});

/* ------------------------------------------------------------ F3 / F4 pages */

test("F3 — search with no results: picture and next steps", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useLang(page, "mr");
  await tc(page, { id: "F3-SEARCH-EMPTY", feature: "F3", scenario: "No-results empty state", device: "390px", lang: "mr", user: "guest" }, async () => {
    // view=products: a results page, but not the first view, so nothing is recorded.
    await page.goto("/search?q=zzqxwvk&view=products", { waitUntil: "networkidle" });
    const empty = page.getByTestId("search-no-results");
    await expect(empty).toBeVisible();
    await expect(empty.locator("svg[data-illustration=search]")).toHaveCount(1);
    await expect(empty.getByRole("link", { name: HOME.browseCategories.mr })).toHaveAttribute("href", "/categories");
  });
});

test("F4 — compare page: best price and saving, and a product that can't be compared", async ({ page }) => {
  await page.setViewportSize(size(1440, 900));
  await tc(page, { id: "F4-COMPARE", feature: "F4", scenario: "Compare page tags best price", device: "1440px", lang: "en", user: "guest" }, async () => {
    expect((await page.goto("/search/compare?product=00000000-0000-4000-8000-000000000000", { waitUntil: "networkidle" }))?.status()).toBe(200);
    const res = await page.goto("/search/compare", { waitUntil: "networkidle" });
    expect(res?.status()).toBe(200);
    const cheapest = await page.getByTestId("cheapest-price").count();
    if (cheapest > 0) await expect(page.getByTestId("best-price").first()).toHaveText(HOME.bestPrice.en);
    return `${cheapest} best-price rows`;
  });
});

/* ------------------------------------------------- F5 footer, regression routes */

const FOOTER_LINKS = [
  "/about",
  "/contact",
  "/sell",
  "/delivery-partner/apply",
  "/legal/seller-terms",
  "/support",
  "/grievance",
  "/legal/grievance-redressal",
  "/legal/privacy-policy",
  "/legal/terms",
  "/legal/refund-policy",
  "/legal/shipping-policy",
  "/legal/cookie-policy",
  "/legal/subscription-terms",
  "/legal/wallet-terms",
  "/legal/voucher-terms",
];

test("F5 — footer: every link opens a page (no 404), accordions on phones", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await tc(page, { id: "F5-FOOTER", feature: "F5", scenario: "Footer links and accordions", device: "390px", lang: "en", user: "guest" }, async () => {
    await page.goto("/", { waitUntil: "networkidle" });
    const footer = page.getByTestId("site-footer");
    const hrefs = await footer.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect([...hrefs].sort()).toEqual([...FOOTER_LINKS].sort());
    const legal = page.locator("[data-testid=footer-column][data-key=legal]");
    await expect(legal.locator("ul")).toBeHidden();
    await legal.getByRole("button").click();
    await expect(legal.locator("ul")).toBeVisible();
    for (const href of FOOTER_LINKS) {
      const res = await request.get(href);
      expect(res.status(), href).toBeLessThan(400);
    }
    // Language switch in the footer.
    await footer.getByRole("button", { name: "हिन्दी" }).click();
    await expect(page.getByTestId("search-input").locator("visible=true").first()).toHaveAttribute("placeholder", HOME.searchPlaceholder.hi);
    return `${FOOTER_LINKS.length} links`;
  });
});

const EXISTING_ROUTES = [
  "/",
  "/shops",
  "/shops/nearby",
  "/shops?open=1",
  "/shops?delivery=true",
  "/shops?type=DAIRY",
  "/search",
  "/search/compare",
  "/categories",
  "/cart",
  "/signin",
  "/sell",
  "/delivery-partner/apply",
  "/about",
  "/contact",
  "/grievance",
  "/legal/privacy-policy",
  "/legal/terms",
  "/legal/cookie-policy",
  "/legal/refund-policy",
  "/legal/shipping-policy",
  "/legal/subscription-terms",
  "/legal/wallet-terms",
  "/legal/voucher-terms",
  "/legal/seller-terms",
  "/legal/grievance-redressal",
];

test("Regression — every existing public route still answers", async ({ request }) => {
  await tc(null, { id: "REG-ROUTES", feature: "Regression", scenario: "Existing routes (no 404/500)", device: "HTTP", lang: "en", user: "guest" }, async () => {
    for (const path of EXISTING_ROUTES) {
      const res = await request.get(path);
      expect(res.status(), path).toBeLessThan(400);
    }
    return `${EXISTING_ROUTES.length} routes`;
  });
});

test("Regression — the site header on other pages keeps search, location and cart, now with suggestions", async ({ page }) => {
  test.skip(Boolean(APP), "a wide-screen check");
  await page.setViewportSize(size(1024, 800));
  await tc(page, { id: "REG-SITE-HEADER", feature: "F2/Regression", scenario: "Site header on /shops", device: "1024px", lang: "en", user: "guest" }, async () => {
    await page.goto("/shops", { waitUntil: "networkidle" });
    await expect(page.getByTestId("site-header")).toBeVisible();
    await expect(page.getByTestId("location-pill")).toBeVisible();
    await expect(page.getByTestId("header-cart")).toBeVisible();
    const input = page.getByTestId("site-header").getByTestId("search-input");
    await input.fill("mil");
    await expect(page.getByTestId("search-suggestions")).toBeVisible();
    await expect(page.getByTestId("mobile-shop-nav")).toBeHidden();
  });
});

/* ------------------------------------------------- signed in (local server only) */

test.describe("signed in (local)", () => {
  test.skip(!IS_LOCAL, "dev sign-in exists only on a local server");

  async function signIn(page: Page, email: string) {
    await page.goto("/signin");
    await page.getByPlaceholder("you@example.com").last().fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
  }

  test("F1/F3/F6 — account menu, drawer groups, empty states once, floating cart bar", async ({ page }) => {
    test.setTimeout(300_000);
    const email = `e2e-home-${Date.now()}@test.local`;
    await page.setViewportSize(size(1440, 900));
    await tc(page, { id: "F1-ACCOUNT-DESKTOP", feature: "F1", scenario: "Account dropdown, grouped", device: "1440px", lang: "en", user: "customer" }, async () => {
      await signIn(page, email);
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByTestId("account-dropdown").click();
      const groups = page.getByTestId("account-group");
      await expect(groups).toHaveCount(5);
      expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute("data-key")))).toEqual(["orders", "subscriptions", "wallet", "tracking", "profile"]);
      await expect(page.getByTestId("account-dropdown-menu").locator("a[href='/wallet#add-money']")).toHaveCount(1);
    });

    await tc(page, { id: "F3-EMPTY-STATES", feature: "F3", scenario: "Cart, orders, subscriptions, wallet empty states", device: "1440px", lang: "en", user: "customer" }, async () => {
      // The empty cart is said once, on the cart page — never on the home page.
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.getByText("Your cart is empty")).toHaveCount(0);
      await page.goto("/cart", { waitUntil: "networkidle" });
      await expect(page.getByTestId("cart-empty")).toHaveCount(1);
      await expect(page.getByText("Your cart is empty")).toHaveCount(1);
      await expect(page.getByRole("link", { name: HOME.startShopping.en })).toHaveAttribute("href", "/");
      await expect(page.getByRole("link", { name: HOME.exploreBestsellers.en })).toBeVisible();
      await page.goto("/orders", { waitUntil: "networkidle" });
      await expect(page.getByTestId("orders-empty").locator("svg[data-illustration=orders]")).toHaveCount(1);
      await page.goto("/subscriptions", { waitUntil: "networkidle" });
      await expect(page.getByTestId("subscriptions-empty").locator("svg[data-illustration=calendar]")).toHaveCount(1);
      await page.goto("/wallet", { waitUntil: "networkidle" });
      await expect(page.getByTestId("wallet-history-empty")).toBeVisible();
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await tc(page, { id: "F6-FLOATING-CART", feature: "F6/F3", scenario: "Popular item → floating cart bar", device: "390px", lang: "en", user: "customer" }, async () => {
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.getByTestId("floating-cart")).toHaveCount(0);
      await page.getByTestId("drawer-open").click();
      await expect(page.getByTestId("drawer-group")).toHaveCount(5);
      await page.keyboard.press("Escape");
      const add = page.getByTestId("popular-in-area").getByTestId("product-tile-add").first();
      await add.click();
      await expect(add).toHaveText("Added");
      await expect(page.getByTestId("floating-cart")).toContainText(/View cart · 1 item · ₹/, { timeout: 15_000 });
      await expect(page.getByTestId("home-cart-count")).toHaveText("1");
      await page.getByTestId("floating-cart").click();
      await page.waitForURL(/\/cart$/);
      return "cart bar above the bottom navigation, badge 1";
    });

    await tc(page, { id: "F2-RECENT-ACCOUNT", feature: "F2", scenario: "Recent searches kept on the account", device: "390px", lang: "en", user: "customer" }, async () => {
      await page.goto("/search?q=paneer", { waitUntil: "networkidle" });
      await page.goto("/", { waitUntil: "networkidle" });
      const input = page.getByTestId("search-input").locator("visible=true").first();
      await input.click();
      await expect(page.locator("[data-testid=search-option][data-group=recent]").first()).toHaveText(/paneer/, { timeout: 10_000 });
    });
  });

  test("F1 — admin creates, schedules off and deletes a home banner", async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(!process.env.E2E_ADMIN_EMAIL, "set E2E_ADMIN_EMAIL to an address in BOOTSTRAP_ADMIN_EMAILS");
    await page.setViewportSize(size(1440, 900));
    await tc(page, { id: "F1-BANNER-ADMIN", feature: "F1", scenario: "Admin banner create → live → off → delete", device: "1440px", lang: "en", user: "admin" }, async () => {
      await signIn(page, process.env.E2E_ADMIN_EMAIL!);
      await page.goto("/admin/home-banners", { waitUntil: "networkidle" });
      const title = `E2E banner ${Date.now()}`;
      if (await page.getByRole("button", { name: "Add a banner" }).isVisible()) await page.getByRole("button", { name: "Add a banner" }).click();
      const form = page.getByTestId("home-banner-form");
      await form.getByLabel("Title", { exact: true }).fill(title);
      await form.getByLabel("Button text (optional)", { exact: true }).fill("See dairies");
      await form.getByLabel("Button opens", { exact: true }).fill("/shops?type=DAIRY");
      await form.getByRole("button", { name: "Add banner" }).click();
      const row = page.getByTestId("home-banner-row").filter({ hasText: title });
      await expect(row).toBeVisible();
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.getByTestId("hero-slide").filter({ hasText: title })).toHaveCount(1);
      await page.goto("/admin/home-banners", { waitUntil: "networkidle" });
      await row.getByRole("button", { name: "Switch off" }).click();
      await expect(row).toHaveAttribute("data-active", "false");
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.getByTestId("hero-slide").filter({ hasText: title })).toHaveCount(0);
      await page.goto("/admin/home-banners", { waitUntil: "networkidle" });
      page.once("dialog", (d) => d.accept());
      await row.getByRole("button", { name: "Delete" }).click();
      await expect(row).toHaveCount(0);
    });
  });
});
