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

/* ------------------------------------------------------------ banner art
 * Image audit 26-Nov-2026: a banner with no photo used one emoji per *kind*,
 * so "Daily milk, delivered" (SEASONAL) showed a diya. Each banner now gets
 * a picture set drawn from its own subject — dairy banners show only dairy,
 * puja banners only puja items — and the set fills the picture panel. */

export type BannerSubject =
  | "dailyNeeds"
  | "dairy"
  | "bakery"
  | "grocery"
  | "fruitVeg"
  | "sweets"
  | "pharmacy"
  | "puja"
  | "household"
  | "compare"
  | "newShops"
  | "general";

/** Four pictures per subject: the first is the large one. Every picture belongs to that subject only. */
export const BANNER_ART: Record<BannerSubject, readonly [string, string, string, string]> = {
  dailyNeeds: ["🥛", "🍞", "🥚", "🧈"],
  dairy: ["🥛", "🧈", "🧀", "🍦"],
  bakery: ["🍞", "🥐", "🎂", "🍪"],
  grocery: ["🍚", "🌾", "🫘", "🧂"],
  fruitVeg: ["🥬", "🍅", "🍌", "🥕"],
  sweets: ["🍬", "🍮", "🍩", "🍫"],
  pharmacy: ["💊", "🩹", "🌡️", "🩺"],
  puja: ["🪔", "🌼", "🔔", "🥥"],
  household: ["🧴", "🧽", "🧻", "🧼"],
  compare: ["⚖️", "🏷️", "🏪", "💰"],
  newShops: ["🏪", "🛍️", "📍", "🛒"],
  general: ["🛍️", "🏪", "🛒", "📦"],
};

const SUBJECT_BY_DEFAULT_ID: Record<string, BannerSubject> = {
  "default-daily": "dailyNeeds",
  "default-compare": "compare",
  "default-subscribe": "dairy",
};

const SUBJECT_BY_SHOP_TYPE: Record<string, BannerSubject> = {
  DAIRY: "dairy",
  BAKERY: "bakery",
  GROCERY_KIRANA: "grocery",
  FRUIT_VEGETABLE: "fruitVeg",
  SWEET_SHOP: "sweets",
  PHARMACY: "pharmacy",
  PUJA_SAMAGRI: "puja",
  SUPERMARKET: "household",
};

const SUBJECT_BY_WORDS: [RegExp, BannerSubject][] = [
  [/puja|pooja|samagri|diya|temple|festival|diwali/i, "puja"],
  [/medic|pharma|health|doctor|tablet/i, "pharmacy"],
  [/milk|dairy|paneer|curd|ghee/i, "dairy"],
  [/bread|bakery|cake|biscuit/i, "bakery"],
  [/fruit|vegetable|sabzi/i, "fruitVeg"],
  [/sweet|mithai/i, "sweets"],
  [/grocery|kirana|atta|rice|dal/i, "grocery"],
  [/household|clean|detergent/i, "household"],
  [/compare|price/i, "compare"],
];

/** What a banner is about, from its built-in id, the shop type it links to, then its words. */
export function bannerSubject(slide: Pick<BannerSlide, "id" | "title" | "subtitle" | "ctaHref" | "kind">): BannerSubject {
  const builtIn = SUBJECT_BY_DEFAULT_ID[slide.id];
  if (builtIn) return builtIn;
  const type = /[?&]type=([A-Z_]+)/.exec(slide.ctaHref)?.[1];
  if (type && SUBJECT_BY_SHOP_TYPE[type]) return SUBJECT_BY_SHOP_TYPE[type];
  if (/^\/puja/.test(slide.ctaHref)) return "puja";
  if (/^\/health|^\/medicines?/.test(slide.ctaHref)) return "pharmacy";
  const words = `${slide.title} ${slide.subtitle ?? ""}`;
  const hit = SUBJECT_BY_WORDS.find(([re]) => re.test(words));
  if (hit) return hit[1];
  return slide.kind === "NEW_SHOPS" ? "newShops" : "general";
}
