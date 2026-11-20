/**
 * docs/shop-welcome-kit-2026-11: the shop's printable banners (English + local language) and the
 * welcome e-mail that carries them when a shop goes live.
 */
import jsQR from "jsqr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { imagePdf } from "@/lib/image-pdf";
import { BANNER_FONT_PATH, BANNER_FONTCONFIG_PATH, bannerBasename, bannerNameMarkup, localBannerLanguage, renderShopBanner } from "@/server/shop-banner/render";
import { LOCAL_PRINT_LINE, PRINT_STEPS, welcomeBannerCid, welcomeKitHtml, welcomeKitText } from "@/server/shop-banner/welcome-kit";

async function decodeQr(png: Buffer): Promise<string | null> {
  // The QR sits in the right-hand box (≈ x 1150–1350, y 610–810 of 1536 × 1024).
  const { data, info } = await sharp(png).extract({ left: 1120, top: 590, width: 260, height: 240 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
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

describe("welcome e-mail", () => {
  const shopUrl = "https://gokesari.com/shops/samarth-tea-center-s2nkf";

  it("tells the owner to print both banners in colour and put them up at the shop", () => {
    const text = welcomeKitText("Samarth Tea Center", shopUrl, "mr");
    expect(text).toContain("Welcome to GoKesari");
    expect(text).toContain("English and Marathi");
    expect(text).toMatch(/Print in COLOUR on a colour page/);
    expect(text).toContain(shopUrl);
    expect(text).toContain(LOCAL_PRINT_LINE.mr);
    for (const step of PRINT_STEPS) expect(text).toContain(step);
  });

  it("has every instruction the owner asked for, links to add products, Marketing and Help, and a local-language line", () => {
    const text = welcomeKitText("Samarth Tea Center", shopUrl, "hi");
    expect(text).toMatch(/Congratulations|Welcome to GoKesari/);
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
    expect(welcomeKitHtml("Samarth Tea Center", shopUrl, "mr")).toContain(LOCAL_PRINT_LINE.mr);
  });

  it("shows both banners inline and escapes the shop name", () => {
    const html = welcomeKitHtml("Ram & Sons", shopUrl, "hi");
    expect(html).toContain(`cid:${welcomeBannerCid("en")}`);
    expect(html).toContain(`cid:${welcomeBannerCid("hi")}`);
    expect(html).toContain("Ram &amp; Sons");
    expect(html).toContain("Print them in colour");
  });
});
