"use client";

import Link from "next/link";
import clsx from "clsx";
import { useEffect, useState } from "react";

import { Icon } from "@/components/board/icons";
import { L, tr, type Lang } from "@/lib/board/i18n";
import type { Counts } from "@/lib/board/menus";

/*
 * The shop owner's bottom tab bar on phones and tablets (docs/ux-mobile-2026-11):
 * Home | Orders (red badge for new orders) | Products | Wallet | More.
 * Fixed above the iPhone home bar (safe-area inset); each tab is at least
 * 56 px tall and a fifth of the screen wide. Desktop keeps the sidebar.
 * Also holds the three-step first-visit tour (Orders → Products → Wallet).
 */

export const SELLER_TABS_TEXT = {
  home: L("Home", "होम", "होम"),
  orders: L("Orders", "ऑर्डर", "ऑर्डर"),
  products: L("Products", "उत्पाद", "उत्पादने"),
  wallet: L("Wallet", "वॉलेट", "वॉलेट"),
  more: L("More", "और", "अधिक"),
  tabs: L("Seller tabs", "सेलर टैब", "सेलर टॅब"),
  newOrders: L("new orders", "नए ऑर्डर", "नवीन ऑर्डर"),
  tourSkip: L("Skip", "छोड़ें", "वगळा"),
  tourNext: L("Next", "आगे", "पुढे"),
  tourDone: L("Got it", "समझ गया", "समजले"),
  tourStep: L("Step {n} of 3", "चरण {n} / 3", "पायरी {n} / 3"),
} as const;

const TOUR = [
  {
    tab: "orders",
    title: L("Your orders are here", "आपके ऑर्डर यहाँ हैं", "तुमच्या ऑर्डर इथे आहेत"),
    text: L(
      "A red number means new orders. Tap Orders, then Accept order.",
      "लाल नंबर का मतलब नए ऑर्डर। ऑर्डर पर टैप करें, फिर ऑर्डर स्वीकारें।",
      "लाल आकडा म्हणजे नवीन ऑर्डर. ऑर्डरवर टॅप करा, मग ऑर्डर स्वीकारा.",
    ),
  },
  {
    tab: "products",
    title: L("Add products and change prices", "उत्पाद जोड़ें और कीमत बदलें", "उत्पादने जोडा आणि किंमत बदला"),
    text: L(
      "Products shows every item with its MRP, price and stock. Change them and tap Save changes.",
      "उत्पाद में हर आइटम की MRP, कीमत और स्टॉक है। बदलें और 'Save changes' दबाएँ।",
      "उत्पादनेमध्ये प्रत्येक वस्तूची MRP, किंमत आणि साठा आहे. बदला आणि 'Save changes' दाबा.",
    ),
  },
  {
    tab: "wallet",
    title: L("Your money", "आपका पैसा", "तुमचे पैसे"),
    text: L(
      "Wallet shows your balance and every payment to your bank.",
      "वॉलेट में आपका बैलेंस और बैंक में हर भुगतान दिखता है।",
      "वॉलेटमध्ये तुमची शिल्लक आणि बँकेत आलेले प्रत्येक पेमेंट दिसते.",
    ),
  },
] as const;

const TOUR_KEY = "gk-seller-tour-v1";

type TabKey = "home" | "orders" | "products" | "wallet";

const TABS: { key: TabKey; href: string; icon: Parameters<typeof Icon>[0]["name"]; match: (p: string) => boolean }[] = [
  { key: "home", href: "/shop", icon: "house", match: (p) => p === "/shop" },
  { key: "orders", href: "/shop/orders", icon: "package", match: (p) => p.startsWith("/shop/orders") },
  {
    key: "products",
    href: "/shop/my-products",
    icon: "tag",
    match: (p) => ["/shop/my-products", "/shop/manage/products", "/shop/product-categories", "/shop/products", "/shop/prices", "/shop/inventory", "/shop/product-import", "/shop/catalogue"].some((x) => p.startsWith(x)),
  },
  { key: "wallet", href: "/shop/wallet", icon: "wallet", match: (p) => p.startsWith("/shop/wallet") || p.startsWith("/shop/finance") },
];

export function SellerBottomNav({ lang, counts, pathname, onMore, moreOpen }: { lang: Lang; counts: Counts; pathname: string; onMore: () => void; moreOpen: boolean }) {
  const [tourStep, setTourStep] = useState<number | null>(null);

  useEffect(() => {
    try {
      // Automated browsers (QA runs) never see it: it would cover the page they drive.
      if (!navigator.webdriver && !window.localStorage.getItem(TOUR_KEY)) {
        const t = setTimeout(() => setTourStep(0), 600);
        return () => clearTimeout(t);
      }
    } catch {
      /* private mode: no tour */
    }
  }, []);

  const endTour = () => {
    setTourStep(null);
    try {
      window.localStorage.setItem(TOUR_KEY, new Date().toISOString());
    } catch {
      /* ignore */
    }
  };

  const tour = tourStep != null ? TOUR[tourStep] : null;
  const newOrders = counts.shopNew ?? 0;
  const needsPrice = counts.shopNeedsPrice ?? 0;

  return (
    <>
      <nav
        aria-label={tr(SELLER_TABS_TEXT.tabs, lang)}
        className={clsx("fixed inset-x-0 bottom-0 border-t border-slate-300 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_10px_rgba(0,0,0,0.06)] lg:hidden", tour ? "z-[61]" : "z-40")}
        data-testid="seller-bottom-nav"
      >
        <ul className="mx-auto grid h-16 max-w-xl grid-cols-5">
          {TABS.map((t) => {
            const here = t.match(pathname);
            const badge = t.key === "orders" ? newOrders : t.key === "products" ? needsPrice : 0;
            const glow = tour?.tab === t.key;
            return (
              <li key={t.key} className="min-w-0">
                <Link
                  href={t.href}
                  aria-current={here ? "page" : undefined}
                  data-testid={`seller-tab-${t.key}`}
                  className={clsx(
                    "relative flex h-16 flex-col items-center justify-center gap-0.5 text-xs font-semibold",
                    here ? "text-kesari-800" : "text-ink-700",
                    glow && "z-[61] rounded-xl bg-white ring-4 ring-kesari-500",
                  )}
                >
                  <span className={clsx("relative grid h-8 w-12 place-items-center rounded-full", here && "bg-kesari-100")}>
                    <Icon name={t.icon} size={22} />
                    {badge > 0 ? (
                      <span
                        className={clsx(
                          "absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-bold leading-none text-white",
                          t.key === "orders" ? "bg-red-700" : "bg-amber-700",
                        )}
                        data-testid={`seller-tab-${t.key}-badge`}
                      >
                        {badge > 99 ? "99+" : badge}
                        <span className="sr-only"> {t.key === "orders" ? tr(SELLER_TABS_TEXT.newOrders, lang) : "need price"}</span>
                      </span>
                    ) : null}
                  </span>
                  <span className="max-w-full truncate px-0.5">{tr(SELLER_TABS_TEXT[t.key], lang)}</span>
                </Link>
              </li>
            );
          })}
          <li className="min-w-0">
            <button
              type="button"
              onClick={onMore}
              aria-expanded={moreOpen}
              aria-controls="seller-drawer"
              data-testid="seller-tab-more"
              className="flex h-16 w-full flex-col items-center justify-center gap-0.5 text-xs font-semibold text-ink-700"
            >
              <span className="grid h-8 w-12 place-items-center rounded-full">
                <Icon name="menu" size={22} />
              </span>
              <span>{tr(SELLER_TABS_TEXT.more, lang)}</span>
            </button>
          </li>
        </ul>
      </nav>

      {tour ? (
        <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-labelledby="seller-tour-title" data-testid="seller-tour">
          <div className="absolute inset-0 bg-ink-900/60" onClick={endTour} aria-hidden />
          <div className="absolute inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] mx-auto max-w-md rounded-2xl bg-white p-4 shadow-2xl">
            <p className="text-xs font-bold uppercase tracking-wider text-kesari-800">{tr(SELLER_TABS_TEXT.tourStep, lang).replace("{n}", String((tourStep ?? 0) + 1))}</p>
            <h2 id="seller-tour-title" className="mt-1 text-lg font-bold text-ink-900">
              {tr(tour.title, lang)}
            </h2>
            <p className="mt-1 text-base text-ink-700">{tr(tour.text, lang)}</p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={endTour} className="min-h-12 flex-1 rounded-xl border border-slate-400 text-base font-semibold text-ink-800" data-testid="seller-tour-skip">
                {tr(SELLER_TABS_TEXT.tourSkip, lang)}
              </button>
              <button
                type="button"
                onClick={() => (tourStep! >= TOUR.length - 1 ? endTour() : setTourStep(tourStep! + 1))}
                className="min-h-12 flex-1 rounded-xl bg-kesari-700 text-base font-bold text-white"
                data-testid="seller-tour-next"
              >
                {tr(tourStep! >= TOUR.length - 1 ? SELLER_TABS_TEXT.tourDone : SELLER_TABS_TEXT.tourNext, lang)}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
