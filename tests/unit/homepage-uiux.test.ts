/**
 * docs/homepage-uiux-2026-10 — pure parts of the product-discovery home:
 * three-language wording, banner scheduling and targeting, search helpers,
 * where the phone bottom navigation shows, and the new routes.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { showsShoppingNav } from "@/components/home/mobile-shop-nav";
import { LANGUAGES } from "@/lib/board/i18n";
import { bannerIsLive, DEFAULT_BANNERS, isSafeBannerLink } from "@/lib/home-banners";
import { fill, HOME } from "@/lib/home-i18n";
import { appAllowsVoiceSearch } from "@/lib/mobile-app";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { TABLE_OWNERSHIP } from "@/server/db/split/ownership";
import { RULES } from "@/server/config/rules";
import { likePattern, matchCategories, normaliseQuery } from "@/server/services/search-suggest";

describe("three-language wording", () => {
  it("has English, Hindi and Marathi for every new label", () => {
    for (const [key, text] of Object.entries(HOME)) {
      for (const lang of LANGUAGES) expect(text[lang].trim(), `${key}.${lang}`).not.toBe("");
    }
    for (const b of DEFAULT_BANNERS) {
      for (const lang of LANGUAGES) {
        expect(b.title[lang]).not.toBe("");
        expect(b.subtitle[lang]).not.toBe("");
        expect(b.cta[lang]).not.toBe("");
      }
    }
  });

  it("keeps the requested search placeholder", () => {
    expect(HOME.searchPlaceholder.en).toBe("Search for milk, bread, or medicines…");
  });

  it("fills placeholders", () => {
    expect(fill(HOME.comparePricesN.en, { n: 3 })).toBe("Compare 3 prices");
    expect(fill(HOME.comparePricesN.hi, { n: 3 })).toBe("3 दाम मिलाएँ");
    expect(fill(HOME.saveVsHighest.en, { amount: "₹4" })).toBe("Save ₹4 vs the highest price");
  });
});

describe("hero banners: live now and aimed at this visitor", () => {
  const now = new Date("2026-10-20T10:00:00Z");
  const base = { active: true, startsAt: null, endsAt: null, city: null, pincode: null };
  const anyone = { pincode: null, cities: [] };

  it("follows the switch and the window (start inclusive, end exclusive)", () => {
    expect(bannerIsLive(base, now, anyone)).toBe(true);
    expect(bannerIsLive({ ...base, active: false }, now, anyone)).toBe(false);
    expect(bannerIsLive({ ...base, startsAt: now }, now, anyone)).toBe(true);
    expect(bannerIsLive({ ...base, startsAt: new Date("2026-10-20T10:00:01Z") }, now, anyone)).toBe(false);
    expect(bannerIsLive({ ...base, endsAt: now }, now, anyone)).toBe(false);
  });

  it("matches PIN and city targeting, never for a visitor without a location", () => {
    expect(bannerIsLive({ ...base, pincode: "411014" }, now, anyone)).toBe(false);
    expect(bannerIsLive({ ...base, pincode: "411014" }, now, { pincode: "411014", cities: [] })).toBe(true);
    expect(bannerIsLive({ ...base, city: "Pune" }, now, { pincode: null, cities: ["PUNE "] })).toBe(true);
    expect(bannerIsLive({ ...base, city: "Pune" }, now, { pincode: null, cities: ["Mumbai"] })).toBe(false);
  });

  it("links only to this site or https", () => {
    expect(isSafeBannerLink("/shops?type=DAIRY")).toBe(true);
    expect(isSafeBannerLink("https://gokesari.com/offers")).toBe(true);
    for (const bad of ["//evil.example", "javascript:alert(1)", "http://x.example", "/\\evil"]) expect(isSafeBannerLink(bad)).toBe(false);
  });
});

describe("search helpers", () => {
  it("normalises what is stored", () => {
    expect(normaliseQuery("  Cow   MILK ")).toBe("cow milk");
    expect(normaliseQuery("x".repeat(100))).toHaveLength(80);
  });

  it("escapes LIKE wildcards", () => {
    expect(likePattern("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });

  it("finds categories in every language, in the visitor's language", () => {
    expect(matchCategories("dair", "en")[0]).toEqual({ key: "dairy", label: "Dairy", href: "/shops?type=DAIRY" });
    expect(matchCategories("दवा", "hi")[0]).toMatchObject({ key: "pharmacy", label: "दवाइयाँ" });
    expect(matchCategories("बेकरी", "mr")[0]).toMatchObject({ key: "bakery" });
    expect(matchCategories("a", "en")).toEqual([]);
  });
});

describe("voice search inside the app", () => {
  it("is offered in browsers and in app builds from 1.3.0 only", () => {
    expect(appAllowsVoiceSearch("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1")).toBe(true);
    expect(appAllowsVoiceSearch(null)).toBe(true);
    expect(appAllowsVoiceSearch("Mozilla/5.0 GoKesariApp/1.2.0 (ios)")).toBe(false);
    expect(appAllowsVoiceSearch("Mozilla/5.0 GoKesariApp/1.3.0 (ios)")).toBe(true);
    expect(appAllowsVoiceSearch("Mozilla/5.0 GoKesariApp/1.10.2 (android)")).toBe(true);
    expect(appAllowsVoiceSearch("Mozilla/5.0 GoKesariApp/2.0.0 (ios)")).toBe(true);
  });
});

describe("phone bottom navigation", () => {
  it("shows on the shopping pages only", () => {
    for (const path of ["/", "/categories", "/shops", "/shops/nearby", "/search", "/search/compare", "/products/x", "/orders", "/wallet", "/profile/addresses"]) {
      expect(showsShoppingNav(path), path).toBe(true);
    }
    for (const path of ["/cart", "/signin", "/shop", "/shop/orders", "/admin", "/operator", "/gig/orders", "/delivery-partner/apply", "/sell", "/orders/payment-return", "/legal/terms"]) {
      expect(showsShoppingNav(path), path).toBe(false);
    }
  });
});

describe("new routes, permission, rule and tables", () => {
  const app = join(process.cwd(), "src/app");
  it("has the pages and APIs it links to", () => {
    for (const file of [
      "admin/home-banners/page.tsx",
      "api/admin/home-banners/route.ts",
      "api/admin/home-banners/[id]/route.ts",
      "api/admin/home-banners/image/route.ts",
      "api/search/suggest/route.ts",
      "api/search/recent/route.ts",
      "search/compare/page.tsx",
      "support/page.tsx",
      "grievance/page.tsx",
    ]) {
      expect(existsSync(join(app, file)), file).toBe(true);
    }
  });

  it("lets admins and operators manage banners, nobody else", () => {
    expect(can("ADMIN", PERMISSIONS.HOME_BANNER_MANAGE)).toBe(true);
    expect(can("OPERATOR", PERMISSIONS.HOME_BANNER_MANAGE)).toBe(true);
    for (const role of ["CUSTOMER", "SHOP_OWNER", "DELIVERY_PARTNER", "OPERATOR_LIMITED"] as const) {
      expect(can(role, PERMISSIONS.HOME_BANNER_MANAGE), role).toBe(false);
    }
  });

  it("switches the new home on by default, with a way back", () => {
    expect(RULES.homeDiscovery.defaults).toEqual({ enabled: true, bannerSeconds: 6 });
    expect(RULES.homeDiscovery.schema.safeParse({ enabled: false, bannerSeconds: 2 }).success).toBe(false);
  });

  it("puts the new tables in the core database", () => {
    expect(TABLE_OWNERSHIP.home_banners).toBe("platform");
    expect(TABLE_OWNERSHIP.search_queries).toBe("platform");
  });
});
