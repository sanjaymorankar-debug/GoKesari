/**
 * Helpers for the 20-Nov-2026 cases of group F (referral links, Seller Central,
 * gateway, manufacturer portal and the R2 regression retests):
 *
 *   phonePage   a Pixel 7 (Android Chrome) page, signed in as a role or a guest. The
 *               phone-only checks emulate the phone themselves (as tests/qa/guest/app-install.spec.ts
 *               does), so they run once, on the desktop project, and are still phone checks.
 *   gtin13      GTINs for the manufacturer upload: a valid one per call, and one with a wrong check digit.
 *   CLS         a layout-shift recorder (Lighthouse's session windows) for the nearby-shops page.
 */
import { devices, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { randomInt } from "node:crypto";

import { as, storageFor } from "./actors";
import { BASE_URL, IS_REMOTE } from "./target";
import type { Role } from "./world";

export type ContextOptions = Exclude<Parameters<Browser["newContext"]>[0], undefined>;

/** Pixel 7 emulation (412 × 915, touch, Android Chrome user agent) for a context of our own. */
export function phoneOptions(extra: ContextOptions = {}): ContextOptions {
  return { ...devices["Pixel 7"], defaultBrowserType: undefined, baseURL: BASE_URL, ...extra } as ContextOptions;
}

/** Waits for the network to settle after each visit on a deployed site (as actors.pageAs does). */
function settleAfterGoto(page: Page) {
  if (!IS_REMOTE) return;
  const goto = page.goto.bind(page);
  page.goto = async (url, gotoOptions) => {
    const res = await goto(url, gotoOptions);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    return res;
  };
}

/** A phone page, signed in as `role` (its saved session / minted cookie), or a guest when `role` is null. */
export async function phonePage(browser: Browser, role: Role | null, extra: ContextOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
  if (role) await as(role); // the account's factors (dual_auth) before its pages
  const storage = role ? { storageState: await storageFor(role) } : {};
  const context = await browser.newContext(phoneOptions({ ...storage, ...extra }));
  const page = await context.newPage();
  settleAfterGoto(page);
  return { context, page };
}

/** Horizontal overflow of the page in CSS pixels (0 when it fits the screen). */
export async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
}

/** Whether a locator's box lies inside the screen's width. */
export async function insideScreenWidth(page: Page, target: Locator): Promise<{ inside: boolean; left: number; right: number; width: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  if (!box) return { inside: false, left: -1, right: -1, width };
  return { inside: box.x >= -0.5 && box.x + box.width <= width + 0.5, left: Math.round(box.x), right: Math.round(box.x + box.width), width };
}

/* ------------------------------------------------------------------ GTINs */

function gtinCheckDigit(first12: string): number {
  const sum = [...first12].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

/** A valid GTIN-13 (Indian 890 prefix) no earlier run used. */
export function gtin13(): string {
  const body = `890${String(Date.now()).slice(-6)}${String(randomInt(0, 1000)).padStart(3, "0")}`;
  return `${body}${gtinCheckDigit(body)}`;
}

/** The same GTIN with a wrong check digit (refused as GTIN_CHECK_DIGIT). */
export function wrongCheckDigit(gtin: string): string {
  const last = Number(gtin.slice(-1));
  return `${gtin.slice(0, -1)}${(last + 1) % 10}`;
}

/* -------------------------------------------------------------------- CLS */

/**
 * Records layout shifts from the first paint (added with page.addInitScript before the visit):
 * `total` is every shift without recent input, `max` the largest session window as Lighthouse
 * counts CLS (shifts less than 1 s apart, a window at most 5 s long).
 */
export const LAYOUT_SHIFT_RECORDER = `(() => {
  const w = window;
  w.__gkCls = { total: 0, max: 0, entries: 0 };
  let session = 0, first = 0, last = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        w.__gkCls.total += e.value;
        w.__gkCls.entries += 1;
        if (session && e.startTime - last < 1000 && e.startTime - first < 5000) session += e.value;
        else { session = e.value; first = e.startTime; }
        last = e.startTime;
        w.__gkCls.max = Math.max(w.__gkCls.max, session);
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) { w.__gkCls.error = String(e); }
})();`;

export async function layoutShift(page: Page): Promise<{ total: number; max: number; entries: number; error?: string }> {
  return page.evaluate(() => (window as unknown as { __gkCls: { total: number; max: number; entries: number; error?: string } }).__gkCls);
}
