/**
 * docs/shop-welcome-kit-2026-11: the shop's printable banners (English + local language) and the
 * welcome e-mail that carries them when a shop goes live. 26-Nov-2026: owner line, "Order online" and
 * "Pay here (UPI)" QRs, personalised e-mail (TC-WKIT-019 … 024).
 */
import jsQR from "jsqr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { imagePdf } from "@/lib/image-pdf";
import {
  BANNER_FONT_PATH,
  BANNER_FONTCONFIG_PATH,
  bannerBasename,
  bannerNameMarkup,
  bannerOwnerName,
  localBannerLanguage,
  parseUpiQr,
  renderShopBanner,
  upiBannerPayload,
} from "@/server/shop-banner/render";
import {
  LOCAL_PRINT_LINE,
  PRINT_STEPS,
  SUPPORT_PHONE,
  WELCOME_FOOTER,
  welcomeBannerCid,
  welcomeKitHtml,
  welcomeKitText,
  welcomeKitTitle,
  type WelcomeKitContent,
} from "@/server/shop-banner/welcome-kit";

async function decodeQr(png: Buffer): Promise<string | null> {
  // The QR sits in the right-hand box (≈ x 1150–1350, y 610–810 of 1536 × 1024).
  const { data, info } = await sharp(png).extract({ left: 1120, top: 590, width: 260, height: 240 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

/** The "Pay here (UPI)" QR (≈ x 908–1058, y 523–673), read from a phone-photo-like copy (1000 px wide, blurred, JPEG). */
async function decodeRegion(png: Buffer, region: { left: number; top: number; width: number; height: number }): Promise<string | null> {
  const k = 1000 / 1536;
  const photo = await sharp(png).resize(1000).blur(0.7).jpeg({ quality: 65 }).toBuffer();
  const r = { left: Math.round(region.left * k), top: Math.round(region.top * k), width: Math.round(region.width * k), height: Math.round(region.height * k) };
  const { data, info } = await sharp(photo).extract(r).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}
const UPI_REGION = { left: 880, top: 500, width: 200, height: 200 };
const SHOP_QR_REGION = { left: 1110, top: 600, width: 280, height: 220 };

/** Rows of ink in a region (to tell whether a line was drawn there). */
async function inkRows(png: Buffer, region: { left: number; top: number; width: number; height: number }): Promise<number> {
  const { data, info } = await sharp(png).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let rows = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 3;
      if (data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) {
        rows += 1;
        break;
      }
    }
  }
  return rows;
}

describe("shop banner", () => {
  const url = "https://test.gokesari.com/shops/samarth-tea-center-s2nkf";

  it.each(["en", "mr", "hi"] as const)("draws the %s banner with a QR code that opens the shop page", async (lang) => {
    const banner = await renderShopBanner({ shopName: "Samarth Tea Center", url, lang });
    expect(banner.width).toBe(1536);
    expect(banner.height).toBe(1024);
    expect(banner.png.subarray(1, 4).toString()).toBe("PNG");
    expect(banner.jpeg[0]).toBe(0xff);
    expect(banner.pdf.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(await decodeQr(banner.png)).toBe(url);
  });

  it("prints Devanagari names and escapes markup characters", async () => {
    expect(bannerNameMarkup("Ram & Sons <Kirana>")).toContain("Ram &amp; Sons &lt;Kirana&gt;");
    const banner = await renderShopBanner({ shopName: "समर्थ चहा केंद्र", url, lang: "mr" });
    expect(banner.png.length).toBeGreaterThan(100_000);
  });

  it("picks Marathi for Maharashtra and Goa, Hindi elsewhere (PIN code when no state)", () => {
    expect(localBannerLanguage({ state: "Maharashtra" })).toBe("mr");
    expect(localBannerLanguage({ state: " maharashtra " })).toBe("mr");
    expect(localBannerLanguage({ state: "MH" })).toBe("mr");
    expect(localBannerLanguage({ state: "Goa" })).toBe("mr");
    expect(localBannerLanguage({ state: "Madhya Pradesh" })).toBe("hi");
    expect(localBannerLanguage({ state: "Karnataka", pincode: "411007" })).toBe("hi"); // the state wins over the PIN
    for (const pin of ["400001", "411007", "422001", "431001", "440001", "444001"]) expect(localBannerLanguage({ state: null, pincode: pin })).toBe("mr");
    for (const pin of ["110001", "380001", "450001", "390001", ""]) expect(localBannerLanguage({ state: null, pincode: pin })).toBe("hi");
    expect(localBannerLanguage({ state: "", pincode: "403001" })).toBe("mr"); // Goa PIN, no state
  });

  it("draws the name with the bundled Poppins (fontconfig set up), wrapping long names onto two lines", async () => {
    expect(process.env.FONTCONFIG_FILE).toBeTruthy();
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(process.env.FONTCONFIG_FILE!)).toBe(true);
    if (process.env.FONTCONFIG_FILE === BANNER_FONTCONFIG_PATH) expect(readFileSync(BANNER_FONTCONFIG_PATH, "utf8")).toContain('<dir prefix="relative">.</dir>');
    // The name as render.ts draws it (auto-fit into the 780 × 82 box): count the lines of ink.
    const lines = async (name: string) => {
      const { data, info } = await sharp({ text: { text: bannerNameMarkup(name), fontfile: BANNER_FONT_PATH, font: "Poppins Bold", width: 780, height: 82, align: "centre", rgba: true } })
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.width).toBeLessThanOrEqual(780);
      expect(info.height).toBeLessThanOrEqual(82);
      let runs = 0;
      let inInk = false;
      let gap = 0;
      for (let y = 0; y < info.height; y += 1) {
        let ink = false;
        for (let x = 0; x < info.width && !ink; x += 1) ink = data[(y * info.width + x) * info.channels + 3] > 128;
        if (ink) {
          if (!inInk && (runs === 0 || gap >= 2)) runs += 1;
          inInk = true;
          gap = 0;
        } else {
          gap += 1;
          inInk = false;
        }
      }
      return runs;
    };
    expect(await lines("Samarth Tea Center")).toBe(1);
    expect(await lines("Shree Samarth Kirana General Stores and Dairy Products Supplier Pune")).toBe(2);
  });

  it("names the files per language and slug", () => {
    expect(bannerBasename("samarth-tea-center-s2nkf", "mr")).toBe("GoKesari-banner-mr-samarth-tea-center-s2nkf");
  });

  it("wraps a JPEG in a one-page A4 landscape PDF", () => {
    const pdf = imagePdf({ jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), widthPx: 1536, heightPx: 1024 }).toString("latin1");
    expect(pdf).toContain("/MediaBox [0 0 841.89 595.28]");
    expect(pdf).toContain("/Filter /DCTDecode");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});

describe("shop banner — 26-Nov-2026 personalisation", () => {
  const url = "https://gokesari.com/shops/samarth-tea-center-s2nkf";
  const upi = upiBannerPayload({ vpa: "samarth.tea@okhdfcbank", shopName: "Samarth Tea Center" });

  it("TC-WKIT-019: cleans the owner name — no line for blank, null, placeholder or e-mail; capitals in title case", () => {
    for (const bad of [null, undefined, "", "  ", "null", "NULL", "undefined", "N/A", "NA", "owner", "Shop Owner", "-", "owner@example.com", "9876543210", "x"]) {
      expect(bannerOwnerName(bad as string | null | undefined)).toBeNull();
    }
    expect(bannerOwnerName("SUNITA RAMESH PATIL")).toBe("Sunita Ramesh Patil");
    expect(bannerOwnerName("  Sunita   patil ")).toBe("Sunita patil");
    expect(bannerOwnerName("सुनीता पाटील")).toBe("सुनीता पाटील");
    expect(bannerOwnerName("D'SOUZA-KHAN")).toBe("D'Souza-Khan");
  });

  it("TC-WKIT-020: builds the UPI QR from the UPI ID (payee = shop name, no amount) and checks uploaded QRs", () => {
    expect(upi).toBe("upi://pay?pa=samarth.tea@okhdfcbank&pn=Samarth%20Tea%20Center&cu=INR");
    expect(upi).not.toMatch(/[?&]am=/);
    expect(upiBannerPayload({ vpa: null, shopName: "X" })).toBeNull();
    expect(upiBannerPayload({ vpa: "not a vpa", shopName: "X" })).toBeNull();
    const merchant = "upi://pay?pa=Q123456@ybl&pn=SAMARTH%20TEA&mc=5411&mode=02";
    expect(upiBannerPayload({ uploadedQr: merchant, vpa: "samarth.tea@okhdfcbank", shopName: "X" })).toBe(merchant); // upload wins
    expect(parseUpiQr(merchant)).toEqual({ payload: merchant, vpa: "Q123456@ybl", payeeName: "SAMARTH TEA" });
    expect(parseUpiQr("upi://pay?pa=a@ybl&am=250.00")).toBeNull(); // fixed amount
    expect(parseUpiQr("https://gokesari.com/shops/x")).toBeNull();
    expect(parseUpiQr("upi://pay?pn=NoPayee")).toBeNull();
  });

  it.each(["en", "mr", "hi"] as const)("TC-WKIT-021: %s banner — both QRs scan from a phone-size photo", async (lang) => {
    const banner = await renderShopBanner({ shopName: "Samarth Tea Center", url, lang, ownerName: "Sunita Patil", upiPayload: upi });
    expect(await decodeRegion(banner.png, SHOP_QR_REGION)).toBe(url);
    expect(await decodeRegion(banner.png, UPI_REGION)).toBe(upi);
  });

  it("TC-WKIT-022: no UPI panel without a UPI ID; the owner line only with a printable name", async () => {
    const plain = await renderShopBanner({ shopName: "Samarth Tea Center", url, lang: "en", ownerName: "owner@example.com", upiPayload: null });
    const named = await renderShopBanner({ shopName: "Samarth Tea Center", url, lang: "en", ownerName: "Sunita Patil", upiPayload: null });
    expect(await decodeRegion(plain.png, UPI_REGION)).toBeNull();
    expect(await decodeRegion(plain.png, SHOP_QR_REGION)).toBe(url);
    // An unprintable owner name draws exactly the banner without one; a real name changes it.
    const none = await renderShopBanner({ shopName: "Samarth Tea Center", url, lang: "en", ownerName: null, upiPayload: null });
    expect(plain.png.equals(none.png)).toBe(true);
    expect(named.png.equals(none.png)).toBe(false);
    // The owner line sits in the lower part of the name box, under a smaller shop name.
    const ownerBand = { left: 300, top: 772, width: 720, height: 28 };
    const gapBand = { left: 300, top: 764, width: 720, height: 6 };
    expect(await inkRows(named.png, ownerBand)).toBeGreaterThan(12);
    expect(await inkRows(named.png, gapBand)).toBeLessThan(6);
    // Devanagari owner line on the local banner draws as well.
    const mr = await renderShopBanner({ shopName: "समर्थ चहा केंद्र", url, lang: "mr", ownerName: "सुनीता पाटील", upiPayload: upi });
    expect(await inkRows(mr.png, ownerBand)).toBeGreaterThan(12);
  });
});

describe("welcome e-mail", () => {
  const shopUrl = "https://gokesari.com/shops/samarth-tea-center-s2nkf";
  const content = (over: Partial<WelcomeKitContent> = {}): WelcomeKitContent => ({
    shopName: "Samarth Tea Center",
    ownerName: "Sunita Patil",
    shopUrl,
    local: "mr",
    upi: "samarth.tea@okhdfcbank",
    ...over,
  });

  it("TC-WKIT-023: opens with the owner's name and the shop, ends with the contact line and the company footer", () => {
    const text = welcomeKitText(content());
    expect(text.startsWith("Dear Sunita Patil, congratulations! Samarth Tea Center is now live on GoKesari.com")).toBe(true);
    expect(welcomeKitTitle("Samarth Tea Center")).toBe("Congratulations! Samarth Tea Center is now live on GoKesari.com");
    expect(text).toContain("support@gokesari.com");
    expect(text).toContain(SUPPORT_PHONE);
    expect(SUPPORT_PHONE).toBe("+91 91751 93009");
    expect(text.trimEnd().endsWith(WELCOME_FOOTER)).toBe(true);
    expect(WELCOME_FOOTER).toBe("gokesari.com is a unit of ASMY GLOBAL TRADING & CONSULTANCY INDIA PRIVATE LIMITED");
    expect(welcomeKitText(content({ ownerName: null })).startsWith("Dear Shop Owner, congratulations!")).toBe(true);
    const html = welcomeKitHtml(content());
    expect(html).toContain("Dear Sunita Patil,");
    expect(html).toContain("mailto:support@gokesari.com");
    expect(html).toContain("tel:+919175193009");
    expect(html).toContain("ASMY GLOBAL TRADING &amp; CONSULTANCY INDIA PRIVATE LIMITED");
  });

  it("TC-WKIT-024: names the UPI QR when there is one, else says how to add a UPI ID in Settings", () => {
    expect(welcomeKitText(content())).toContain('"Pay here (UPI)" QR for your UPI ID samarth.tea@okhdfcbank');
    const none = welcomeKitText(content({ upi: null }));
    expect(none).toContain("Add your UPI ID");
    expect(none).toContain("Accounts → Settings → UPI ID");
    expect(none).toContain("/shop/accounts/settings");
    expect(welcomeKitHtml(content({ upi: null }))).toContain("/shop/accounts/settings");
  });

  it("tells the owner to print both banners in colour and put them up at the shop", () => {
    const text = welcomeKitText(content());
    expect(text).toContain("English and Marathi");
    expect(text).toMatch(/Print in COLOUR on a colour page/);
    expect(text).toContain(shopUrl);
    expect(text).toContain(LOCAL_PRINT_LINE.mr);
    for (const step of PRINT_STEPS) expect(text).toContain(step);
  });

  it("has every instruction the owner asked for, links to add products, Marketing and Help, and a local-language line", () => {
    const text = welcomeKitText(content({ local: "hi" }));
    expect(text).toMatch(/congratulations/);
    expect(text).toMatch(/not black and white/);
    expect(text).toMatch(/A4 paper \(landscape, "Fit to page"\)/);
    expect(text).toMatch(/sticker or flex/);
    expect(text).toMatch(/scan the QR code with your phone/);
    expect(text).toMatch(/counter or shop entrance at eye level/);
    expect(text).toMatch(/Laminate/);
    expect(text).toContain("Scan this to order from our shop on GoKesari.");
    expect(text).toContain("/shop/manage/products");
    expect(text).toContain("/shop/marketing");
    expect(text).toContain("/support");
    expect(text).toContain(LOCAL_PRINT_LINE.hi);
    expect(welcomeKitHtml(content())).toContain(LOCAL_PRINT_LINE.mr);
  });

  it("shows both banners inline and escapes the shop name", () => {
    const html = welcomeKitHtml(content({ shopName: "Ram & Sons", local: "hi" }));
    expect(html).toContain(`cid:${welcomeBannerCid("en")}`);
    expect(html).toContain(`cid:${welcomeBannerCid("hi")}`);
    expect(html).toContain("Ram &amp; Sons");
    expect(html).toContain("Print them in colour");
  });
});
