import fs from "node:fs";
import path from "node:path";

import { escapeHtml } from "../template-engine";

import { LEGAL_ASSETS_DIR, withBrowser } from "./browser";

/**
 * Prints one agreement (a full HTML document) to an A4 PDF on the AGT letterhead
 * (docs/seller-agreements-2026-11): logo and contact strip at the top of every page, the wave band
 * and "Page X of Y" at the foot, the faint AGT globe as a watermark behind the text.
 *
 * Safety: the HTML comes from admin-published templates filled with shop data (escaped). The page
 * runs with JavaScript off and no network: the only resources it may load are the bundled fonts
 * and letterhead images, served from LEGAL_ASSETS_DIR under ASSET_ORIGIN.
 */

export const ASSET_ORIGIN = "https://legal-assets.gokesari.invalid";

const ASSET_TYPES: Record<string, string> = {
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".css": "text/css",
};

const cache = new Map<string, Buffer>();
function asset(name: string): Buffer {
  let data = cache.get(name);
  if (!data) {
    const full = path.join(LEGAL_ASSETS_DIR, name);
    if (!full.startsWith(LEGAL_ASSETS_DIR + path.sep)) throw new Error("bad asset path");
    data = fs.readFileSync(full);
    cache.set(name, data);
  }
  return data;
}

function dataUrl(name: string): string {
  return `data:${ASSET_TYPES[path.extname(name)] ?? "application/octet-stream"};base64,${asset(name).toString("base64")}`;
}

/** @font-face rules and base styles every agreement page uses. */
export function baseStyles(): string {
  const face = (family: string, file: string, weight: number, style = "normal") =>
    `@font-face{font-family:"${family}";src:url("${ASSET_ORIGIN}/fonts/${file}") format("truetype");font-weight:${weight};font-style:${style};font-display:block}`;
  return [
    face("GK Sans", "NotoSans-Regular.ttf", 400),
    face("GK Sans", "NotoSans-Bold.ttf", 700),
    face("GK Sans", "NotoSans-Italic.ttf", 400, "italic"),
    face("GK Deva", "NotoSansDevanagari-Regular.ttf", 400),
    face("GK Deva", "NotoSansDevanagari-Bold.ttf", 700),
    // Latin from Noto Sans, Devanagari from Noto Sans Devanagari, per character.
    `html{-webkit-print-color-adjust:exact;print-color-adjust:exact}`,
    `body{font-family:"GK Sans","GK Deva",sans-serif;font-size:10pt;line-height:1.45;color:#1a1a1a;margin:0}`,
    `:lang(mr),:lang(hi){font-family:"GK Deva","GK Sans",sans-serif;line-height:1.6}`,
    `.gk-watermark{position:fixed;top:50%;left:50%;width:120mm;transform:translate(-50%,-50%);opacity:.22;z-index:-1}`,
  ].join("\n");
}

function headerTemplate(): string {
  // Chromium renders header / footer templates in their own tiny document: inline styles and
  // data: images only, and font-size must be set explicitly.
  return `<div style="width:100%;margin:0 12mm;font-family:sans-serif;font-size:7.5pt;color:#1f3a68;display:flex;align-items:center;justify-content:space-between;-webkit-print-color-adjust:exact">
  <img src="${dataUrl("agt-logo.png")}" style="height:17mm" />
  <div style="text-align:right;line-height:1.5">
    <div>+91 91751 93009</div>
    <div>ceo@agtci.com</div>
    <div>www.agtci.com &nbsp;|&nbsp; www.gokesari.com</div>
    <div>Flat No. B-1102, Yin Yang CHS, Opp. EON IT Park, Kharadi, Pune</div>
  </div>
</div>`;
}

function footerTemplate(footerNote: string, pageNumbers: boolean): string {
  return `<div style="width:100%;font-family:sans-serif;font-size:7pt;color:#555;-webkit-print-color-adjust:exact">
  <div style="margin:0 12mm;display:flex;justify-content:space-between">
    <span>${escapeHtml(footerNote)}</span>
    ${pageNumbers ? `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>` : "<span></span>"}
  </div>
  <img src="${dataUrl("letterhead-wave.jpg")}" style="width:100%;height:9mm;object-fit:cover;display:block;margin-top:1mm" />
</div>`;
}

export function watermarkHtml(): string {
  return `<img class="gk-watermark" src="${ASSET_ORIGIN}/agt-watermark.png" alt="" />`;
}

export type PrintOptions = {
  /** Plain text shown at the foot of every page, e.g. "Seller SLA v1.0 · GK-SH-00123". */
  footerNote?: string;
  /** Without the letterhead (a bare test page). Default true. */
  letterhead?: boolean;
  /** "Page X of Y" in the footer. False for the certificate page appended to a signed copy. Default true. */
  pageNumbers?: boolean;
};

/** Prints a complete HTML document to PDF bytes. */
export async function printHtmlToPdf(html: string, options: PrintOptions = {}): Promise<Buffer> {
  const letterhead = options.letterhead ?? true;
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith(ASSET_ORIGIN + "/")) {
          const name = decodeURIComponent(url.slice(ASSET_ORIGIN.length + 1).split("?")[0]);
          const type = ASSET_TYPES[path.extname(name)];
          if (type && !name.includes("..")) {
            try {
              void request.respond({ status: 200, contentType: type, headers: { "Access-Control-Allow-Origin": "*" }, body: asset(name) });
              return;
            } catch {
              /* fall through to abort */
            }
          }
        }
        if (url.startsWith("data:") || url === "about:blank") {
          void request.continue();
          return;
        }
        void request.abort();
      });
      await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
      await page.evaluateHandle("document.fonts.ready").catch(() => undefined);
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        displayHeaderFooter: letterhead,
        headerTemplate: letterhead ? headerTemplate() : "<span></span>",
        footerTemplate: letterhead ? footerTemplate(options.footerNote ?? "", options.pageNumbers ?? true) : "<span></span>",
        margin: letterhead
          ? { top: "30mm", bottom: "22mm", left: "16mm", right: "16mm" }
          : { top: "15mm", bottom: "15mm", left: "16mm", right: "16mm" },
        timeout: 60_000,
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}
