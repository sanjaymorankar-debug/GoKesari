/**
 * App install prompt and updates (docs/app-install-2026-10) as a visitor sees
 * them, on an Android Chrome phone and an iPhone Safari profile. Production-
 * safe: only page loads, browser storage in a fresh context, and GETs.
 *
 * Chrome's beforeinstallprompt / appinstalled events cannot be produced by a
 * test browser on demand, so TC-APP-004 dispatches them itself (the page code
 * that handles them is the one under test); a real install is the manual part.
 */
import { devices, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { anonymous, call, expectStatus } from "../lib/http";
import { expect, manual, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";

const PROMPT = "app-install-prompt";
/** The prompt waits up to 1.5 s for Chrome's install event before it decides. */
const SHOWS = { timeout: 15_000 };

async function phone(browser: Browser, kind: "android" | "iphone", userAgentSuffix = ""): Promise<{ context: BrowserContext; page: Page }> {
  const device = kind === "android" ? devices["Pixel 7"] : devices["iPhone 15"];
  const context = await browser.newContext({
    ...device,
    // Chromium runs both profiles: the iPhone profile is its size and user agent.
    defaultBrowserType: undefined,
    baseURL: BASE_URL,
    userAgent: `${device.userAgent}${userAgentSuffix}`,
  } as Parameters<Browser["newContext"]>[0]);
  return { context, page: await context.newPage() };
}

async function declines(page: Page): Promise<number> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("gk_app_install_declines") ?? '{"count":0}').count as number);
}

qa(["TC-APP-001", "TC-APP-002", "TC-APP-003"], "the prompt shows on the first visit, Not now hides it for that page view, and it returns on visits 2 and 3", async ({ browser }) => {
  const { context, page } = await phone(browser, "android");
  try {
    await page.goto("/");
    const sheet = page.getByTestId(PROMPT);
    await expect(sheet).toBeVisible(SHOWS);
    await expect(sheet.getByRole("heading", { name: "Get the GoKesari app" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Not now" })).toBeVisible();
    // Non-blocking: the page's own search stays usable under the sheet.
    await expect(page.getByRole("searchbox").or(page.getByRole("combobox")).first()).toBeEnabled();

    await sheet.getByRole("button", { name: "Not now" }).click();
    await expect(sheet).toHaveCount(0);
    expect(await declines(page)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("gk_app_installed"))).toBeNull();

    await page.goto("/products");
    await expect(page.getByTestId(PROMPT)).toBeVisible(SHOWS);
    await page.getByTestId(PROMPT).getByRole("button", { name: "Not now" }).click();
    await page.goto("/");
    await expect(page.getByTestId(PROMPT)).toBeVisible(SHOWS);
    expect(await declines(page)).toBe(2);
  } finally {
    await context.close();
  }
  return "visit 1 shown; Not now closed it (declines 1, no installed flag); visits 2 and 3 shown again (declines 2)";
});

qa("TC-APP-004", "Install opens Chrome's dialog; after install the prompt is gone and stays gone", async ({ browser }) => {
  const { context, page } = await phone(browser, "android");
  try {
    await page.goto("/");
    await expect(page.getByTestId(PROMPT)).toBeVisible(SHOWS);
    const result = await page.evaluate(async () => {
      const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
      let prompted = false;
      event.prompt = async () => void (prompted = true);
      event.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(event);
      await new Promise((r) => setTimeout(r, 300));
      const method = document.querySelector<HTMLElement>("[data-testid=app-install-prompt]")?.dataset.method;
      document.querySelector<HTMLButtonElement>("[data-testid=app-install-button]")?.click();
      await new Promise((r) => setTimeout(r, 300));
      window.dispatchEvent(new Event("appinstalled"));
      return { suppressed: event.defaultPrevented, method, prompted };
    });
    expect(result).toEqual({ suppressed: true, method: "native-prompt", prompted: true });
    await expect(page.getByTestId(PROMPT)).toHaveCount(0);
    await page.reload();
    await page.waitForTimeout(3000);
    await expect(page.getByTestId(PROMPT)).toHaveCount(0);
  } finally {
    await context.close();
  }
  return "Chrome's mini-bar suppressed, Install called its dialog, accepted → no prompt, none after reload";
}, { partial: "Chrome's real install dialog on a phone (manual)" });

qa(["TC-APP-005", "TC-APP-006"], "no prompt once installed, nor inside the native app", async ({ browser }) => {
  const seen: string[] = [];
  const installed = await phone(browser, "android");
  try {
    await installed.page.goto("/");
    await installed.page.evaluate(() => localStorage.setItem("gk_app_installed", new Date().toISOString()));
    await installed.page.reload();
    await installed.page.waitForTimeout(3000);
    await expect(installed.page.getByTestId(PROMPT)).toHaveCount(0);
    seen.push("installed flag: none");
  } finally {
    await installed.context.close();
  }
  for (const kind of ["android", "iphone"] as const) {
    const app = await phone(browser, kind, ` GoKesariApp/1.4.0 (${kind === "android" ? "android" : "ios"})`);
    try {
      await app.page.goto("/");
      await app.page.waitForTimeout(3000);
      await expect(app.page.getByTestId(PROMPT)).toHaveCount(0);
      await expect(app.page.getByTestId("app-update-prompt")).toHaveCount(0);
      seen.push(`native app (${kind}): none`);
    } finally {
      await app.context.close();
    }
  }
  return seen.join("; ");
}, { partial: "standalone display mode and getInstalledRelatedApps need a real install (covered by unit tests)" });

qa(["TC-APP-007", "TC-APP-013"], "iPhone: Add to Home Screen guide, and the whole sheet fits the phone screen", async ({ browser }) => {
  const { context, page } = await phone(browser, "iphone");
  try {
    await page.goto("/");
    const sheet = page.getByTestId(PROMPT);
    await expect(sheet).toBeVisible(SHOWS);
    await expect(sheet).toHaveAttribute("data-method", "ios-guide");
    await sheet.getByRole("button", { name: "Install" }).click();
    const guide = page.getByTestId("app-install-guide");
    await expect(guide).toBeVisible();
    await expect(guide.getByRole("listitem")).toHaveText([/Tap Share/, /Add to Home Screen/, /Tap Add/]);
    const fit = await page.evaluate(() => {
      const box = document.querySelector("[data-testid=app-install-prompt]")!.getBoundingClientRect();
      const buttons = [...document.querySelectorAll<HTMLElement>("[data-testid=app-install-prompt] button")].map((b) => b.getBoundingClientRect().height);
      return { top: box.top, bottom: box.bottom, vh: window.innerHeight, sideways: document.documentElement.scrollWidth > window.innerWidth, minButton: Math.min(...buttons) };
    });
    expect(fit.top, "sheet starts on screen").toBeGreaterThanOrEqual(0);
    expect(fit.bottom, "sheet ends on screen").toBeLessThanOrEqual(fit.vh + 1);
    expect(fit.sideways, "no sideways scroll").toBe(false);
    expect(fit.minButton, "tap targets").toBeGreaterThanOrEqual(44);
    return `guide shown; sheet ${Math.round(fit.bottom - fit.top)} px tall in a ${fit.vh} px screen, buttons ≥ ${Math.round(fit.minButton)} px`;
  } finally {
    await context.close();
  }
}, { partial: "Safari's own Share sheet (manual on an iPhone)" });

qa(["TC-APP-009", "TC-APP-011"], "service worker served fresh with a versioned static cache; the native update endpoint answers per platform", async () => {
  const guest = await anonymous();
  try {
    const sw = await call(guest, "GET", "/sw.js");
    expectStatus(sw, 200, "GET /sw.js");
    expect(sw.text).toMatch(/GoKesari service worker — version \S+/);
    expect(sw.text).toContain('const CACHE = "gk-static-" + VERSION');
    expect(sw.text).toContain("/_next/static/");
    const version = await call(guest, "GET", "/api/app/version");
    expectStatus(version, 200, "GET /api/app/version");
    for (const platform of ["android", "ios"]) {
      expect(Object.keys(version.body[platform]).sort()).toEqual(["latest", "minimum", "url"]);
      const latest = version.body[platform].latest as string | null;
      if (latest !== null) expect(latest).toMatch(/^\d+\.\d+\.\d+$/);
    }
    return `${sw.text.split("\n")[0]}; app version: ${JSON.stringify(version.body)}`;
  } finally {
    await guest.dispose();
  }
});

manual("TC-APP-010", "a new deploy is picked up by the installed app (Reload bar)", "needs two deploys of the site with the app open between them; checked on the local server by restarting it (new build version) and on each site after its deploy");
manual("TC-APP-012", "the native app offers a newer build and installs it over the old one", "needs an installed 1.4.0 build on an Android phone and an iPhone, and a higher version published to the store / APK link");
