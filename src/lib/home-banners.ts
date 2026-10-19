/**
 * Home hero banners (docs/homepage-uiux-2026-10, F1): which banner is live for
 * a visitor, and the built-in banners shown when none is. Pure functions and
 * data — no server imports — so the page, the admin screen and unit tests
 * share them.
 */
import { L, type Text } from "@/lib/board/i18n";

export interface BannerSlide {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
  ctaHref: string;
  kind: "DEAL" | "SEASONAL" | "NEW_SHOPS" | "GENERAL";
}

export interface BannerSchedule {
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  city: string | null;
  pincode: string | null;
}

/** Where the visitor is, as far as targeting needs: their PIN and the cities their shops are in. */
export interface BannerTarget {
  pincode: string | null;
  cities: readonly string[];
}

/**
 * Live now, and aimed at this visitor: switched on, inside its window (start
 * inclusive, end exclusive), and — when it names a PIN or a city — the
 * visitor's location matches. A targeted banner is never shown to a visitor
 * with no location.
 */
export function bannerIsLive(banner: BannerSchedule, now: Date, target: BannerTarget): boolean {
  if (!banner.active) return false;
  if (banner.startsAt && banner.startsAt.getTime() > now.getTime()) return false;
  if (banner.endsAt && banner.endsAt.getTime() <= now.getTime()) return false;
  if (banner.pincode && banner.pincode.trim() !== (target.pincode ?? "")) return false;
  if (banner.city) {
    const wanted = banner.city.trim().toLowerCase();
    if (!target.cities.some((c) => c.trim().toLowerCase() === wanted)) return false;
  }
  return true;
}

/** An in-site path or an https URL — the only links a banner may carry. */
export function isSafeBannerLink(href: string): boolean {
  return (href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")) || /^https:\/\/[^\s"'<>]+$/i.test(href);
}

/** The built-in banners, in the visitor's language, shown while no banner is live. */
export const DEFAULT_BANNERS: readonly {
  id: string;
  kind: BannerSlide["kind"];
  title: Text;
  subtitle: Text;
  cta: Text;
  href: string;
}[] = [
  {
    id: "default-daily",
    kind: "DEAL",
    title: L("Fresh every morning", "हर सुबह ताज़ा", "रोज सकाळी ताजे"),
    subtitle: L(
      "Milk, bread and daily needs from shops near you",
      "आपके पास की दुकानों से दूध, ब्रेड और रोज़ की ज़रूरतें",
      "जवळच्या दुकानांतून दूध, ब्रेड आणि रोजच्या गरजा",
    ),
    cta: L("Shop now", "अभी खरीदें", "आता खरेदी करा"),
    href: "/shops",
  },
  {
    id: "default-compare",
    kind: "GENERAL",
    title: L("Compare prices, save more", "दाम मिलाएँ, ज़्यादा बचाएँ", "दर तुलना करा, जास्त वाचवा"),
    subtitle: L(
      "The same product at every shop near you — the best price marked",
      "आपके पास की हर दुकान पर एक ही चीज़ — सबसे अच्छा दाम चिह्नित",
      "जवळच्या प्रत्येक दुकानातील तीच वस्तू — सर्वोत्तम दर दाखवलेला",
    ),
    cta: L("Compare prices", "दाम तुलना", "दर तुलना"),
    href: "/search/compare",
  },
  {
    id: "default-subscribe",
    kind: "SEASONAL",
    title: L("Daily milk, delivered", "रोज़ का दूध, घर पर", "रोजचे दूध, घरपोच"),
    subtitle: L(
      "Subscribe once — pause or change any day",
      "एक बार सब्सक्राइब करें — किसी भी दिन रोकें या बदलें",
      "एकदा सदस्यता घ्या — कोणत्याही दिवशी थांबवा किंवा बदला",
    ),
    cta: L("Find a dairy", "डेयरी खोजें", "डेअरी शोधा"),
    href: "/shops?type=DAIRY",
  },
];
