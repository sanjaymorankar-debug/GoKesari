/** Image audit 26-Nov-2026: banner pictures stay on the banner's subject; puja and other shop types get their own fallback icon. */
import { describe, expect, it } from "vitest";

import { categoryEmoji } from "@/lib/board/product-look";
import { BANNER_ART, bannerSubject, DEFAULT_BANNERS, type BannerSlide } from "@/lib/home-banners";

const slide = (over: Partial<BannerSlide>): BannerSlide => ({
  id: "b1",
  title: "",
  subtitle: null,
  imageUrl: null,
  ctaLabel: null,
  ctaHref: "/shops",
  kind: "GENERAL",
  ...over,
});

describe("banner subject", () => {
  it("the daily-milk banner is dairy, never a diya", () => {
    const subject = bannerSubject(slide({ id: "default-subscribe", kind: "SEASONAL", ctaHref: "/shops?type=DAIRY" }));
    expect(subject).toBe("dairy");
    expect(BANNER_ART[subject]).not.toContain("🪔");
  });

  it("every built-in banner has its own subject", () => {
    const subjects = DEFAULT_BANNERS.map((b) => bannerSubject(slide({ id: b.id, kind: b.kind, ctaHref: b.href })));
    expect(subjects).toEqual(["dailyNeeds", "compare", "dairy"]);
  });

  it("admin banners follow the shop type they link to, then their words", () => {
    expect(bannerSubject(slide({ ctaHref: "/shops?type=PHARMACY" }))).toBe("pharmacy");
    expect(bannerSubject(slide({ ctaHref: "/puja" }))).toBe("puja");
    expect(bannerSubject(slide({ title: "Diwali puja offers" }))).toBe("puja");
    expect(bannerSubject(slide({ title: "Fresh paneer" }))).toBe("dairy");
    expect(bannerSubject(slide({ kind: "NEW_SHOPS", title: "Welcome" }))).toBe("newShops");
    expect(bannerSubject(slide({ title: "Hello" }))).toBe("general");
  });

  it("puja art is only puja items and medicine art only medical items", () => {
    expect(BANNER_ART.puja).not.toContain("🥛");
    expect(BANNER_ART.pharmacy.every((e) => ["💊", "🩹", "🌡️", "🩺"].includes(e))).toBe(true);
  });
});

describe("product fallback icon", () => {
  it("puja goods get a diya, even camphor tablets", () => {
    expect(categoryEmoji("Puja Samagri", "Mangalam Camphor Tablets – Pack")).toBe("🪔");
  });
  it("other shop types no longer fall back to the shopping bag", () => {
    expect(categoryEmoji("Hardware and Building Materials", "Cement 50 kg")).toBe("🧰");
    expect(categoryEmoji("Newspaper", "Lokmat")).toBe("📰");
  });
  it("existing categories are unchanged", () => {
    expect(categoryEmoji("Dairy", "Amul Milk 500 ml")).toBe("🥛");
    expect(categoryEmoji("Pharmacy", "Paracetamol 500 mg tablet")).toBe("💊");
  });
});

describe("shop photo needed (owner rule 26-Nov: no manufacturer image → shop owner uploads and overrides)", () => {
  it("no image or a shared sample picture needs the shop's own photo", async () => {
    const { needsOwnPhoto } = await import("@/lib/board/product-look");
    expect(needsOwnPhoto(null)).toBe(true);
    expect(needsOwnPhoto("")).toBe(true);
    expect(needsOwnPhoto("/images/puja/puja-kapur.svg")).toBe(true);
  });
  it("a real uploaded photo does not", async () => {
    const { needsOwnPhoto } = await import("@/lib/board/product-look");
    expect(needsOwnPhoto("/api/images/e21db1eb-ab34-44d4-9bba-be70d025b0d1")).toBe(false);
  });
});
