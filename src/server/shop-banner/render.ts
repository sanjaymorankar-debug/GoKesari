/**
 * docs/shop-welcome-kit-2026-11: the printable "We are available on
 * GoKesari.com" banner for one shop — the owner's design (assets/template.png,
 * placeholders cleared) with the shop's name in the cream box and a QR code of
 * the shop's own page (/shops/<slug>) in the "Scan QR Code of Your Shop" box.
 * A customer who scans it lands straight on the shop: no searching on the site
 * or on Google.
 *
 * Output: a PNG (the full-size image) and an A4 landscape PDF for printing.
 * The name is drawn with Poppins Bold (assets/, SIL OFL 1.1), which covers
 * Latin and Devanagari, so Hindi and Marathi shop names print correctly. The
 * text is shrunk to fit the box, so long names stay on one line.
 *
 * All positions below are fractions of the template's size: a sharper
 * template (same layout, higher resolution) can replace assets/template.png
 * without touching this file.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { getEnv } from "@/lib/env";
import { imagePdf } from "@/lib/image-pdf";
import { qrMatrix } from "@/lib/qr";

const ASSETS = path.join(process.cwd(), "src", "server", "shop-banner", "assets");
export const BANNER_TEMPLATE_PATH = path.join(ASSETS, "template.png");

/**
 * The name must be drawn with the bundled Poppins Bold. sharp's own fontconfig
 * cannot load that file without a config file (none on a bare server; none for
 * the bundled library on a Mac), and pango on a Mac asks CoreText instead: the
 * name then fell back to another font — and a Hindi or Marathi name to empty
 * boxes on a server without Devanagari fonts. assets/fonts.conf adds this
 * folder (and keeps the system's config when there is one). Set before the
 * first text is drawn in the process, and only when the process has not chosen
 * its own.
 */
export const BANNER_FONTCONFIG_PATH = path.join(ASSETS, "fonts.conf");
process.env.FONTCONFIG_FILE ??= BANNER_FONTCONFIG_PATH;
process.env.PANGOCAIRO_BACKEND ??= "fc";

/**
 * The banner's languages (owner, 20-Nov-2026: every shop gets two banners, English and its local
 * language). en is the owner's design; mr / hi are built from it by
 * scripts/shop-banner/make-local-templates.py with the same layout.
 */
export const BANNER_LANGUAGES = ["en", "mr", "hi"] as const;
export type BannerLanguage = (typeof BANNER_LANGUAGES)[number];
export const BANNER_LANGUAGE_LABEL: Record<BannerLanguage, string> = { en: "English", mr: "Marathi (मराठी)", hi: "Hindi (हिंदी)" };

export function bannerTemplatePath(lang: BannerLanguage): string {
  return lang === "en" ? BANNER_TEMPLATE_PATH : path.join(ASSETS, `template-${lang}.png`);
}

/**
 * The shop's local language for its second banner: Marathi in Maharashtra and Goa, Hindi
 * elsewhere for now (the site's languages are English, Hindi and Marathi). Without a state, the
 * PIN code decides (40–44 = Maharashtra / Goa). Other scripts (Gujarati, Tamil, …) need their own
 * template and font: add them here and in the generator script.
 */
export function localBannerLanguage(shop: { state?: string | null; pincode?: string | null }): Exclude<BannerLanguage, "en"> {
  const state = (shop.state ?? "").trim().toLowerCase();
  if (state) return /maharashtra|^mh$|^goa$|^ga$/.test(state) ? "mr" : "hi";
  const pin = (shop.pincode ?? "").trim();
  return /^4[0-4]\d{4}$/.test(pin) ? "mr" : "hi";
}
export const BANNER_FONT_PATH = path.join(ASSETS, "Poppins-Bold.ttf");

/** The layout of assets/template.png (1536 × 1024), as fractions of its width and height. */
const LAYOUT = {
  /** The cream name box (inside its border); the name is centred in it. */
  name: { left: 270 / 1536, top: 716 / 1024, width: 780 / 1536, height: 82 / 1024 },
  /** The white QR area under "Scan QR Code of Your Shop". */
  qr: { left: 1155 / 1536, top: 614 / 1024, size: 190 / 1536 },
} as const;

const NAME_COLOUR = "#141e2d";
const MAX_NAME_LENGTH = 80;

export interface BannerInput {
  shopName: string;
  /** Default en. */
  lang?: BannerLanguage;
  /** What the QR code opens: the shop's public page. */
  url: string;
}

export interface RenderedBanner {
  png: Buffer;
  /** The same image as JPEG (smaller; shown inside the e-mail). */
  jpeg: Buffer;
  pdf: Buffer;
  width: number;
  height: number;
}

/** The shop's public page, on this site (gokesari.com or test.gokesari.com). */
export function shopPageUrl(slug: string): string {
  const base = (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
  return `${base}/shops/${encodeURIComponent(slug)}`;
}

/** Pango markup is XML: the name is escaped, and control characters dropped. */
export function bannerNameMarkup(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  const escaped = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<span foreground="${NAME_COLOUR}">${escaped || "GoKesari"}</span>`;
}

/** The QR code as SVG squares on white, `size` pixels square (quiet zone of one module). */
export function qrSvg(url: string, size: number): string {
  const qr = qrMatrix(url, "M");
  const cells = qr.size + 2;
  const parts: string[] = [];
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (qr.modules[row * qr.size + col]) parts.push(`M${col + 1} ${row + 1}h1v1h-1z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${cells} ${cells}" shape-rendering="crispEdges">` +
    `<rect width="${cells}" height="${cells}" fill="#fff"/><path d="${parts.join("")}" fill="#000"/></svg>`
  );
}

const templateCache = new Map<BannerLanguage, Promise<{ buffer: Buffer; width: number; height: number }>>();

function loadTemplate(lang: BannerLanguage) {
  let cached = templateCache.get(lang);
  if (!cached) {
    cached = (async () => {
      const buffer = await readFile(bannerTemplatePath(lang));
      const meta = await sharp(buffer).metadata();
      if (!meta.width || !meta.height) throw new Error("The shop banner template has no size.");
      return { buffer, width: meta.width, height: meta.height };
    })().catch((error) => {
      templateCache.delete(lang);
      throw error;
    });
    templateCache.set(lang, cached);
  }
  return cached;
}

export async function renderShopBanner(input: BannerInput): Promise<RenderedBanner> {
  const template = await loadTemplate(input.lang ?? "en");
  const { width, height } = template;

  const box = {
    left: Math.round(LAYOUT.name.left * width),
    top: Math.round(LAYOUT.name.top * height),
    width: Math.round(LAYOUT.name.width * width),
    height: Math.round(LAYOUT.name.height * height),
  };
  // Autofit: sharp picks the largest font size whose text fits width × height.
  const name = await sharp({
    text: {
      text: bannerNameMarkup(input.shopName),
      fontfile: BANNER_FONT_PATH,
      font: "Poppins Bold",
      width: box.width,
      height: box.height,
      align: "centre",
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  const nameLeft = box.left + Math.max(0, Math.round((box.width - name.info.width) / 2));
  const nameTop = box.top + Math.max(0, Math.round((box.height - name.info.height) / 2));

  const qrSize = Math.round(LAYOUT.qr.size * width);
  const qr = await sharp(Buffer.from(qrSvg(input.url, qrSize))).png().toBuffer();

  const composed = sharp(template.buffer).composite([
    { input: name.data, left: nameLeft, top: nameTop },
    { input: qr, left: Math.round(LAYOUT.qr.left * width), top: Math.round(LAYOUT.qr.top * height) },
  ]);
  const png = await composed.clone().png({ compressionLevel: 9 }).withMetadata({ density: 300 }).toBuffer();
  const jpeg = await composed.clone().flatten({ background: "#ffffff" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  const pdf = imagePdf({ jpeg, widthPx: width, heightPx: height, title: `${input.shopName} - GoKesari` });
  return { png, jpeg, pdf, width, height };
}

/** A safe file name for the shop's banner (`GoKesari-banner-<slug>`). */
export function bannerBasename(slug: string, lang: BannerLanguage = "en"): string {
  return `GoKesari-banner-${lang}-${slug.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "shop"}`;
}
