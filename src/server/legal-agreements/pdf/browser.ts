import fs from "node:fs";
import path from "node:path";

import type { Browser } from "puppeteer-core";

/**
 * Headless Chromium for printing agreements to PDF (docs/seller-agreements-2026-11).
 *
 * Why a browser: the agreements are HTML (letterhead, tables, page numbers) in English, Marathi and
 * Hindi. Devanagari needs real OpenType shaping (conjuncts, matras, reph) that only a text engine
 * such as Chromium's HarfBuzz does correctly; the site's own PDF writers (src/lib/pdf.ts,
 * src/lib/health/pdf-writer.ts) are WinAnsi-only.
 *
 * Where the binary comes from (owner decision 26-Nov-2026: no apt on gk-db-1):
 *   1. LEGAL_PDF_CHROMIUM_PATH, if set (any Chromium / Chrome for Testing);
 *   2. on Linux, @sparticuz/chromium: a self-contained Chromium with its own libraries, unpacked
 *      to /tmp on first use;
 *   3. otherwise (developer Macs, CI), Playwright's Chromium (playwright-core, a dev dependency).
 *
 * One browser is shared and closed after IDLE_MS without use, so the ~250 MB it takes is held
 * only while agreements are being printed.
 */

const IDLE_MS = 60_000;

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let inUse = 0;

async function resolveLaunch(): Promise<{ executablePath: string; args: string[] }> {
  const common = ["--no-first-run", "--no-default-browser-check", "--disable-extensions", "--font-render-hinting=none"];
  const explicit = process.env.LEGAL_PDF_CHROMIUM_PATH?.trim();
  if (explicit) return { executablePath: explicit, args: [...common, "--no-sandbox", "--disable-gpu"] };
  if (process.platform === "linux") {
    // gk-db-1 (Ubuntu, no apt): Chromium needs libnspr4 / libnss3 and friends, which @sparticuz/chromium
    // carries in al2023.tar.br but unpacks (and adds to LD_LIBRARY_PATH) only where it detects an Amazon
    // Linux 2023 runtime. Without them Chromium exits at once ("libnspr4.so: cannot open shared object
    // file") — seen on gokesari.com 27-Nov-2026. This detection variable is read only by that package; it
    // must be set before the first import, which runs the check.
    process.env.CODEBUILD_BUILD_IMAGE ??= "nodejs22-gokesari-bundled-libs";
    const { default: chromium } = await import("@sparticuz/chromium");
    return { executablePath: await chromium.executablePath(), args: [...chromium.args, ...common] };
  }
  // Development only: Playwright's own Chromium. The module name is built at run time so the
  // production bundle does not try to include a dev dependency.
  const moduleName = ["playwright", "core"].join("-");
  const pw = (await import(/* webpackIgnore: true */ moduleName)) as { chromium: { executablePath(): string } };
  const executablePath = pw.chromium.executablePath();
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error("No Chromium for agreement PDFs: set LEGAL_PDF_CHROMIUM_PATH or run `npx playwright install chromium`.");
  }
  return { executablePath, args: [...common, "--no-sandbox"] };
}

async function launch(): Promise<Browser> {
  const { default: puppeteer } = await import("puppeteer-core");
  const { executablePath, args } = await resolveLaunch();
  const browser = await puppeteer.launch({ executablePath, args, headless: true, pipe: true });
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

/** Runs `fn` with the shared browser; the browser closes itself after a minute without use. */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  inUse += 1;
  try {
    browserPromise ??= launch().catch((error) => {
      browserPromise = null;
      throw error;
    });
    const browser = await browserPromise;
    return await fn(browser);
  } finally {
    inUse -= 1;
    if (inUse === 0) {
      idleTimer = setTimeout(() => {
        const pending = browserPromise;
        browserPromise = null;
        idleTimer = null;
        void pending?.then((b) => b.close()).catch(() => undefined);
      }, IDLE_MS);
      idleTimer.unref?.();
    }
  }
}

export const LEGAL_ASSETS_DIR = path.join(process.cwd(), "src", "server", "legal-agreements", "assets");
