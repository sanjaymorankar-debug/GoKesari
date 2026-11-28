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

import sharp, { type OverlayOptions } from "sharp";

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
 * The banner's languages (owner, 20-Nov-2026: English and the shop's local language; 28-Nov-2026:
 * every shop gets all three — English, Marathi and Hindi — see shopBannerLanguages). en is the owner's design; mr / hi are built from it by
 * scripts/shop-banner/make-local-templates.py with the same layout.
 */
export const BANNER_LANGUAGES = ["en", "mr", "hi"] as const;
export type BannerLanguage = (typeof BANNER_LANGUAGES)[number];
export const BANNER_LANGUAGE_LABEL: Record<BannerLanguage, string> = { en: "English", mr: "Marathi (मराठी)", hi: "Hindi (हिंदी)" };

/** Every banner a shop gets (owner, 28-Nov-2026): English first, then its local language, then the other one. */
export function shopBannerLanguages(local: Exclude<BannerLanguage, "en">): BannerLanguage[] {
  return ["en", local, local === "mr" ? "hi" : "mr"];
}

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
  /** 26-Nov-2026: with an owner line, the name takes the upper part of the box and the owner line the lower part. */
  nameWithOwner: { left: 270 / 1536, top: 706 / 1024, width: 780 / 1536, height: 60 / 1024 },
  owner: { left: 300 / 1536, top: 768 / 1024, width: 720 / 1536, height: 34 / 1024 },
  /** The white QR area under the shop-QR heading. */
  qr: { left: 1155 / 1536, top: 614 / 1024, size: 190 / 1536 },
  /** The shop-QR heading inside its box (white): "Order online" since 26-Nov-2026. */
  qrHeading: { left: 1126 / 1536, top: 545 / 1024, width: 250 / 1536, height: 66 / 1024 },
  /**
   * 26-Nov-2026: the "Pay here (UPI)" panel, beside the shop QR, in place of the third feature column
   * (shops without a UPI id keep that column). Its frame, label and QR, in template pixels.
   */
  upi: {
    cover: { left: 733 / 1536, top: 508 / 1024, width: 352 / 1536, height: 178 / 1024 },
    frame: { left: 752 / 1536, top: 515 / 1024, width: 312 / 1536, height: 166 / 1024 },
    label: { left: 768 / 1536, top: 530 / 1024, width: 136 / 1536, height: 92 / 1024 },
    hint: { left: 768 / 1536, top: 626 / 1024, width: 136 / 1536, height: 46 / 1024 },
    qr: { left: 908 / 1536, top: 523 / 1024, size: 150 / 1536 },
  },
} as const;

const NAME_COLOUR = "#141e2d";
const FRAME_COLOUR = "#f26522";
const MAX_NAME_LENGTH = 80;
const MAX_OWNER_LENGTH = 60;

/** 26-Nov-2026 owner brief: the shop-QR heading, the UPI panel and the owner line, per banner language. */
export const BANNER_TEXT: Record<BannerLanguage, { orderOnline: string; payHere: string; anyUpiApp: string; owner: string }> = {
  en: { orderOnline: "Order online\nScan this QR", payHere: "Pay here\n(UPI)", anyUpiApp: "Scan with any\nUPI app", owner: "Owner" },
  mr: { orderOnline: "ऑनलाइन ऑर्डर करा\nहा QR स्कॅन करा", payHere: "येथे पैसे द्या\n(UPI)", anyUpiApp: "कोणत्याही UPI\nॲपने स्कॅन करा", owner: "मालक" },
  hi: { orderOnline: "ऑनलाइन ऑर्डर करें\nयह QR स्कैन करें", payHere: "यहाँ भुगतान\nकरें (UPI)", anyUpiApp: "किसी भी UPI\nऐप से स्कैन करें", owner: "मालिक" },
};

export interface BannerInput {
  shopName: string;
  /** Default en. */
  lang?: BannerLanguage;
  /** What the QR code opens: the shop's public page. */
  url: string;
  /**
   * 26-Nov-2026: the owner's name, printed under the shop name ("Owner: …"). Cleaned by
   * bannerOwnerName(): left out when blank, an e-mail address or a placeholder.
   */
  ownerName?: string | null;
  /** 26-Nov-2026: what the "Pay here (UPI)" QR holds (upiBannerPayload()); no panel when null. */
  upiPayload?: string | null;
}

/** The UPI id format the shop's accounts settings accept (accounts/books.ts). */
export const UPI_VPA_PATTERN = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/;

/**
 * The owner line's name, or null when there is nothing fit to print: blank, "null" / "undefined" / "NA" style
 * placeholders, an e-mail address, a phone number or anything without a letter. A name typed (or read from
 * PAN) in capitals is printed in title case ("SUNITA PATIL" → "Sunita Patil"); any other spelling is kept.
 */
export function bannerOwnerName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 2) return null;
  if (/@/.test(name) || !/\p{L}/u.test(name)) return null;
  if (/^(null|undefined|none|nil|n\.?a\.?|n\/a|not available|unknown|test|owner|shop owner|-+|\.+)$/i.test(name)) return null;
  const titled = /[a-z]/.test(name) || !/[A-Z]/.test(name) ? name : name.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  return titled.slice(0, MAX_OWNER_LENGTH).trim();
}

/**
 * The "Pay here (UPI)" QR's text: an uploaded payment QR the owner saved (already checked by parseUpiQr) wins;
 * else `upi://pay` with the shop's UPI id, payee = the shop's name and no amount (the customer types it).
 * Null when the shop has neither: the banner then has no UPI panel.
 */
export function upiBannerPayload(input: { uploadedQr?: string | null; vpa?: string | null; shopName: string }): string | null {
  const uploaded = input.uploadedQr ? parseUpiQr(input.uploadedQr) : null;
  if (uploaded) return uploaded.payload;
  const vpa = input.vpa?.trim();
  if (!vpa || !UPI_VPA_PATTERN.test(vpa)) return null;
  const payee = input.shopName.replace(/\s+/g, " ").trim().slice(0, 50) || "GoKesari shop";
  return `upi://pay?pa=${vpa}&pn=${encodeURIComponent(payee)}&cu=INR`;
}

/**
 * An uploaded payment QR's text, checked: it must be a UPI payment QR (`upi://pay?…` with a valid payee
 * address `pa`) and must not fix an amount (`am`): a banner QR is scanned for every bill. Null otherwise.
 */
export function parseUpiQr(text: string): { payload: string; vpa: string; payeeName: string | null } | null {
  const payload = text.trim();
  if (payload.length > 512 || !/^upi:\/\/pay\?/i.test(payload)) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(payload.slice(payload.indexOf("?") + 1));
  } catch {
    return null;
  }
  const vpa = params.get("pa")?.trim() ?? "";
  if (!UPI_VPA_PATTERN.test(vpa)) return null;
  const amount = params.get("am");
  if (amount && Number(amount) > 0) return null;
  return { payload, vpa, payeeName: params.get("pn")?.trim() || null };
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

type Frac = { left: number; top: number; width: number; height: number };
const px = (f: Frac, width: number, height: number) => ({
  left: Math.round(f.left * width),
  top: Math.round(f.top * height),
  width: Math.round(f.width * width),
  height: Math.round(f.height * height),
});

const escapeMarkup = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Text drawn to fit a box (sharp picks the largest font size whose text fits width × height), centred in it.
 * Poppins Bold covers Latin and Devanagari, so Marathi / Hindi lines and names shape correctly.
 */
async function fittedText(markup: string, box: { left: number; top: number; width: number; height: number }, align: "centre" | "left" = "centre") {
  const out = await sharp({
    text: { text: markup, fontfile: BANNER_FONT_PATH, font: "Poppins Bold", width: box.width, height: box.height, align, rgba: true },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    input: out.data,
    left: box.left + (align === "centre" ? Math.max(0, Math.round((box.width - out.info.width) / 2)) : 0),
    top: box.top + Math.max(0, Math.round((box.height - out.info.height) / 2)),
  };
}

const svgRect = (w: number, h: number, body: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);

export async function renderShopBanner(input: BannerInput): Promise<RenderedBanner> {
  const lang = input.lang ?? "en";
  const template = await loadTemplate(lang);
  const { width, height } = template;
  const words = BANNER_TEXT[lang];
  const layers: OverlayOptions[] = [];

  // The shop name, and under it "Owner: …" when the shop has a printable owner name.
  const owner = bannerOwnerName(input.ownerName);
  layers.push(await fittedText(bannerNameMarkup(input.shopName), px(owner ? LAYOUT.nameWithOwner : LAYOUT.name, width, height)));
  if (owner) {
    layers.push(await fittedText(`<span foreground="${NAME_COLOUR}">${escapeMarkup(`${words.owner}: ${owner}`)}</span>`, px(LAYOUT.owner, width, height)));
  }

  // The shop QR's heading: "Order online" (the template's "Scan QR Code of Your Shop" is painted over in white).
  const heading = px(LAYOUT.qrHeading, width, height);
  layers.push({ input: svgRect(heading.width, heading.height, `<rect width="100%" height="100%" fill="#fff"/>`), left: heading.left, top: heading.top });
  layers.push(await fittedText(`<span foreground="${NAME_COLOUR}">${escapeMarkup(words.orderOnline)}</span>`, { ...heading, left: heading.left + 6, width: heading.width - 12, top: heading.top + 4, height: heading.height - 8 }));

  const qrSize = Math.round(LAYOUT.qr.size * width);
  layers.push({ input: await sharp(Buffer.from(qrSvg(input.url, qrSize))).png().toBuffer(), left: Math.round(LAYOUT.qr.left * width), top: Math.round(LAYOUT.qr.top * height) });

  // "Pay here (UPI)": beside the shop QR, over the third feature column.
  if (input.upiPayload) {
    const cover = px(LAYOUT.upi.cover, width, height);
    const frame = px(LAYOUT.upi.frame, width, height);
    const stroke = Math.max(3, Math.round(width / 300));
    layers.push({ input: svgRect(cover.width, cover.height, `<rect width="100%" height="100%" fill="#fff"/>`), left: cover.left, top: cover.top });
    layers.push({
      input: svgRect(
        frame.width,
        frame.height,
        `<rect x="${stroke / 2}" y="${stroke / 2}" width="${frame.width - stroke}" height="${frame.height - stroke}" rx="${Math.round(frame.height / 9)}" fill="#fff" stroke="${FRAME_COLOUR}" stroke-width="${stroke}"/>`,
      ),
      left: frame.left,
      top: frame.top,
    });
    layers.push(await fittedText(`<span foreground="${FRAME_COLOUR}">${escapeMarkup(words.payHere)}</span>`, px(LAYOUT.upi.label, width, height)));
    layers.push(await fittedText(`<span foreground="${NAME_COLOUR}">${escapeMarkup(words.anyUpiApp)}</span>`, px(LAYOUT.upi.hint, width, height)));
    const upiSize = Math.round(LAYOUT.upi.qr.size * width);
    layers.push({ input: await sharp(Buffer.from(qrSvg(input.upiPayload, upiSize))).png().toBuffer(), left: Math.round(LAYOUT.upi.qr.left * width), top: Math.round(LAYOUT.upi.qr.top * height) });
  }

  const composed = sharp(template.buffer).composite(layers);
  const png = await composed.clone().png({ compressionLevel: 9 }).withMetadata({ density: 300 }).toBuffer();
  const jpeg = await composed.clone().flatten({ background: "#ffffff" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  const pdf = imagePdf({ jpeg, widthPx: width, heightPx: height, title: `${input.shopName} - GoKesari` });
  return { png, jpeg, pdf, width, height };
}

/** A safe file name for the shop's banner (`GoKesari-banner-<slug>`). */
export function bannerBasename(slug: string, lang: BannerLanguage = "en"): string {
  return `GoKesari-banner-${lang}-${slug.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "shop"}`;
}
