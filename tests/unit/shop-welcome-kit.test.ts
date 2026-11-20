/**
 * docs/shop-welcome-kit-2026-11: the shop's printable banners (English + local language) and the
 * welcome e-mail that carries them when a shop goes live.
 */
import jsQR from "jsqr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { imagePdf } from "@/lib/image-pdf";
import { bannerBasename, bannerNameMarkup, localBannerLanguage, renderShopBanner } from "@/server/shop-banner/render";
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
    expect(localBannerLanguage({ state: "Goa" })).toBe("mr");
    expect(localBannerLanguage({ state: "Madhya Pradesh" })).toBe("hi");
    expect(localBannerLanguage({ state: null, pincode: "411007" })).toBe("mr");
    expect(localBannerLanguage({ state: null, pincode: "110001" })).toBe("hi");
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

  it("shows both banners inline and escapes the shop name", () => {
    const html = welcomeKitHtml("Ram & Sons", shopUrl, "hi");
    expect(html).toContain(`cid:${welcomeBannerCid("en")}`);
    expect(html).toContain(`cid:${welcomeBannerCid("hi")}`);
    expect(html).toContain("Ram &amp; Sons");
    expect(html).toContain("Print them in colour");
  });
});
