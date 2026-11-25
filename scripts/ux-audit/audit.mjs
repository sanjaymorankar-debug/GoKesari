#!/usr/bin/env node
/**
 * UX audit (docs/ux-mobile-2026-11): screenshots each role's key screens at the
 * eight widths of the owner's brief and measures, per screen:
 *   overflowX   — the page scrolls sideways (something is wider than the screen)
 *   smallInputs — text boxes under 16 px (iOS Safari zooms into them)
 *   smallTargets— links/buttons under 44×44 px (visible ones)
 *   clipped     — elements whose text is cut off without an ellipsis
 *   overlaps    — badge/count elements that overlap a sibling
 *
 * Usage: node scripts/ux-audit/audit.mjs <baseUrl> <outDir> [authDir] [label]
 *   authDir holds staging-<role>.json storage states (tests/qa sign-in).
 * Phone widths run in WebKit (Safari's engine), the rest in Chromium.
 */
import { chromium, webkit } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [base, outDir, authDir = ".e2e-auth", label = "run"] = process.argv.slice(2);
if (!base || !outDir) {
  console.error("usage: audit.mjs <baseUrl> <outDir> [authDir] [label]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const WIDTHS = [
  { key: "se-375", w: 375, h: 667, engine: "webkit", mobile: true },
  { key: "ip15-390", w: 390, h: 844, engine: "webkit", mobile: true },
  { key: "promax-430", w: 430, h: 932, engine: "webkit", mobile: true },
  { key: "android-360", w: 360, h: 800, engine: "chromium", mobile: true },
  { key: "android-412", w: 412, h: 915, engine: "chromium", mobile: true },
  { key: "ipad-768", w: 768, h: 1024, engine: "webkit", mobile: true },
  { key: "desk-1280", w: 1280, h: 800, engine: "chromium", mobile: false },
  { key: "desk-1440", w: 1440, h: 900, engine: "chromium", mobile: false },
];

const SCREENS = (process.env.UX_SCREENS ?? "guest:/,customer:/orders,shop:/shop,shop:/shop/my-products,shop:/shop/orders,admin:/admin,ops:/admin,rider:/delivery-partner")
  .split(",")
  .map((s) => {
    const [role, path] = s.split(":");
    return { role, path };
  });
const ONLY = process.env.UX_WIDTHS ? process.env.UX_WIDTHS.split(",") : null;

const measure = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && r.bottom > 0 && r.top < innerHeight * 3;
  };
  const doc = document.documentElement;
  const overflowX = doc.scrollWidth > doc.clientWidth + 1;
  const inputs = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea")].filter(vis);
  const smallInputs = inputs.filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).length;
  const targets = [...document.querySelectorAll("a[href],button,[role=button],input[type=checkbox],select")].filter(vis);
  const small = targets.filter((t) => {
    const r = t.getBoundingClientRect();
    return r.width < 44 - 0.5 || r.height < 44 - 0.5;
  });
  const smallTargets = small.length;
  const smallSamples = small.slice(0, 6).map((t) => `${(t.textContent || t.getAttribute("aria-label") || t.tagName).trim().slice(0, 24)} ${Math.round(t.getBoundingClientRect().width)}×${Math.round(t.getBoundingClientRect().height)}`);
  const clippedEls = [...document.querySelectorAll("body *")].filter((el) => {
    if (!vis(el) || el.children.length > 0 || el.getBoundingClientRect().width <= 2) return false; // sr-only text is 1 px wide
    const cs = getComputedStyle(el);
    if (cs.textOverflow === "ellipsis") return false;
    const hidden = cs.overflow === "hidden" || cs.overflowX === "hidden";
    return hidden && el.scrollWidth > el.clientWidth + 2 && (el.textContent || "").trim().length > 2;
  });
  const truncated = [...document.querySelectorAll("body *")].filter((el) => {
    if (!vis(el)) return false;
    const cs = getComputedStyle(el);
    return cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1;
  });
  const badges = [...document.querySelectorAll("[data-testid=board-count]")].filter(vis);
  let overlaps = 0;
  for (let i = 0; i < badges.length; i++)
    for (let j = i + 1; j < badges.length; j++) {
      const a = badges[i].getBoundingClientRect();
      const b = badges[j].getBoundingClientRect();
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps++;
    }
  return {
    overflowX,
    smallInputs,
    smallTargets,
    smallSamples,
    clipped: clippedEls.length,
    clippedSamples: clippedEls.slice(0, 6).map((e) => (e.textContent || "").trim().slice(0, 30)),
    truncated: truncated.length,
    truncatedSamples: truncated.slice(0, 6).map((e) => (e.textContent || "").trim().slice(0, 30)),
    overlaps,
    title: document.title,
    finalPath: location.pathname,
  };
};

const results = [];
const chrome = await chromium.launch();
// UX_WEBKIT=1 uses Playwright WebKit for the Apple sizes (hangs on some Macs); otherwise Chromium with the same viewport.
const browsers = { webkit: process.env.UX_WEBKIT ? await webkit.launch() : chrome, chromium: chrome };
try {
  for (const s of SCREENS) {
    const state = s.role === "guest" ? undefined : join(authDir, `staging-${s.role}.json`);
    if (state && !existsSync(state)) {
      console.log(`skip ${s.role}: no session`);
      continue;
    }
    for (const w of WIDTHS) {
      if (ONLY && !ONLY.includes(w.key)) continue;
      const ctx = await browsers[w.engine].newContext({
        viewport: { width: w.w, height: w.h },
        deviceScaleFactor: 2,
        isMobile: w.mobile && (w.engine === "chromium" || !process.env.UX_WEBKIT),
        hasTouch: w.mobile,
        storageState: state,
        userAgent: w.engine === "webkit" && !process.env.UX_WEBKIT ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" : undefined,
      });
      const page = await ctx.newPage();
      const name = `${label}_${s.role}_${s.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home"}_${w.key}`;
      try {
        await page.goto(base + s.path, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await page.evaluate(() => localStorage.setItem("gk-seller-tour-v1", "seen")).catch(() => {});
        const m = await page.evaluate(measure);
        await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: false });
        results.push({ label, role: s.role, path: s.path, width: w.key, engine: w.engine, ...m, shot: `${name}.png` });
        console.log(`${name}: overflow=${m.overflowX} smallInputs=${m.smallInputs} smallTargets=${m.smallTargets} clipped=${m.clipped} truncated=${m.truncated} overlaps=${m.overlaps} → ${m.finalPath}`);
      } catch (e) {
        results.push({ label, role: s.role, path: s.path, width: w.key, error: String(e).slice(0, 200) });
        console.log(`${name}: ERROR ${String(e).slice(0, 120)}`);
      } finally {
        await ctx.close();
      }
    }
  }
} finally {
  if (browsers.webkit !== chrome) await browsers.webkit.close();
  await chrome.close();
}
writeFileSync(join(outDir, `${label}-results.json`), JSON.stringify(results, null, 2));
console.log(`wrote ${results.length} results`);
