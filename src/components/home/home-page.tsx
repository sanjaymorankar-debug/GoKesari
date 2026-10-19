/**
 * The product-discovery home page (docs/homepage-uiux-2026-10): sticky header
 * with search → hero banners → categories → shops near you (with filters) →
 * Buy again / Popular in your area → Sell / Deliver → footer (root layout).
 * Account items live in the header's Account menu and, on phones, the side
 * drawer and the bottom navigation (root layout).
 *
 * A server component: every part is read best-effort, so a failed read drops
 * that part, never the page.
 */
import Link from "next/link";

import { Icon, type IconName } from "@/components/board/icons";
import { ShopGrid, type GridShop } from "@/components/shop-grid";
import { formatCount } from "@/lib/board/format";
import { LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";
import { CUSTOMER_CATEGORIES, CUSTOMER_MENUS, type Counts } from "@/lib/board/menus";
import type { BannerSlide } from "@/lib/home-banners";
import { HOME } from "@/lib/home-i18n";

import type { AccountNavProps } from "./account-nav";
import { HeroCarousel } from "./hero-carousel";
import { HomeHeader } from "./home-header";
import { ProductTiles, type ProductTile } from "./product-tiles";

export interface HomePageData {
  counts: Counts;
  banners: BannerSlide[];
  bannerSeconds: number;
  /** Shops near the visitor (or a few from the directory without a location). */
  shops: GridShop[];
  hasLocation: boolean;
  /** Real "Buy again" items (delivered orders); empty for guests and new customers. */
  buyAgain: ProductTile[];
  popular: { scope: "area" | "city" | "platform" | "catalogue"; items: ProductTile[] };
  referralCode: string | null;
}

function SectionHeading({ id, title, href, linkLabel }: { id: string; title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="mb-2.5 flex items-end justify-between gap-3">
      <h2 id={id} className="text-lg font-extrabold text-ink-900 sm:text-xl">
        {title}
      </h2>
      {href && linkLabel ? (
        <Link href={href} className="inline-flex min-h-11 shrink-0 items-center gap-0.5 text-sm font-bold text-kesari-700 hover:underline">
          {linkLabel}
          <Icon name="chevron-right" size={16} />
        </Link>
      ) : null}
    </div>
  );
}

/** Nearby · Open now · Delivers here · Compare prices — the last one the accent "Smart tool". */
function ShopChips({ lang, counts }: { lang: Lang; counts: Counts }) {
  const shopsMenu = CUSTOMER_MENUS.find((m) => m.key === "shops");
  const chips = (shopsMenu?.items ?? []).map((item) => ({
    key: item.key,
    href: item.href,
    label: tr(item.label, lang),
    icon: (item.icon ?? "store") as IconName,
    count: item.count ? counts[item.count] : undefined,
  }));
  return (
    <nav aria-label={tr(HOME.shopFilters, lang)} className="mb-3">
      <ul className="flex flex-wrap gap-2">
        {chips.map((chip) =>
          chip.key === "compare" ? (
            <li key={chip.key}>
              <Link
                href={chip.href}
                data-testid="shop-chip"
                data-key={chip.key}
                data-accent="smart"
                className="flex h-11 items-center gap-1.5 whitespace-nowrap rounded-full bg-indigo-700 pl-3 pr-1.5 text-sm font-bold text-white shadow-sm hover:bg-indigo-800"
              >
                <Icon name="scale" size={16} />
                {chip.label}
                <span className="ml-0.5 inline-flex items-center gap-0.5 rounded-full bg-white px-2 py-0.5 text-[0.6875rem] font-extrabold uppercase tracking-wide text-indigo-800" data-testid="smart-tool-badge">
                  <Icon name="sparkles" size={11} />
                  {tr(HOME.smartTool, lang)}
                </span>
              </Link>
            </li>
          ) : (
            <li key={chip.key}>
              <Link
                href={chip.href}
                data-testid="shop-chip"
                data-key={chip.key}
                className="flex h-11 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--gk-line)] bg-white px-3.5 text-sm font-semibold text-ink-900 hover:border-kesari-300 hover:bg-kesari-50"
              >
                <Icon name={chip.icon} size={16} className="text-kesari-700" />
                {chip.label}
                {chip.count ? <span className="rounded-full bg-kesari-50 px-1.5 text-xs font-bold tabular-nums text-kesari-800">{formatCount(chip.count)}</span> : null}
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

function JoinCards({ lang }: { lang: Lang }) {
  const cards = [
    { href: "/sell", icon: "store" as const, title: tr(HOME.sellTitle, lang), text: tr(HOME.sellText, lang), cta: tr(HOME.getStarted, lang), tone: "bg-kesari-50 border-kesari-300", testId: "cta-sell" },
    { href: "/delivery-partner/apply", icon: "bike" as const, title: tr(HOME.deliverTitle, lang), text: tr(HOME.deliverText, lang), cta: tr(HOME.applyNow, lang), tone: "bg-leaf-50 border-leaf-300", testId: "cta-deliver" },
  ];
  return (
    <section aria-labelledby="home-join" className="grid gap-3 sm:grid-cols-2">
      <h2 id="home-join" className="sr-only">
        {tr(HOME.footerMakeMoney, lang)}
      </h2>
      {cards.map((c) => (
        <Link key={c.href} href={c.href} data-testid={c.testId} className={`flex items-center gap-4 rounded-2xl border p-4 hover:shadow-md ${c.tone}`}>
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-white text-kesari-700 shadow-sm">
            <Icon name={c.icon} size={28} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-extrabold text-ink-900">{c.title}</span>
            <span className="mt-0.5 block text-sm text-ink-700">{c.text}</span>
          </span>
          <span className="hidden h-11 shrink-0 items-center gap-1 rounded-xl bg-ink-900 px-3 text-sm font-bold text-white sm:flex">
            {c.cta}
            <Icon name="chevron-right" size={16} />
          </span>
        </Link>
      ))}
    </section>
  );
}

export function HomePage({ lang, header, data }: { lang: Lang; header: AccountNavProps & { unreadCount: number; cartCount: number; locationLabel: string | null; savedAddresses: { id: string; label: string }[] }; data: HomePageData }) {
  const signedIn = Boolean(header.user);
  const popularTitle =
    data.popular.scope === "area"
      ? HOME.popularInArea
      : data.popular.scope === "city"
        ? HOME.popularInCity
        : data.popular.scope === "platform"
          ? HOME.popularOnGoKesari
          : HOME.freshPicks;

  return (
    <div data-home-discovery="" lang={LANG_TAG[lang]} className="min-h-[100svh] bg-[var(--gk-bg)] text-ink-900">
      <HomeHeader {...header} />
      <h1 className="sr-only">GoKesari — {tr(HOME.shopsNearYou, lang)}</h1>

      <div className="mx-auto w-full max-w-[1600px] space-y-6 px-3 pb-6 pt-3 sm:px-4 lg:space-y-8 lg:px-6 lg:pt-5">
        {data.referralCode ? (
          <Link href="/refer" data-testid="home-invite" className="flex min-h-12 items-center gap-3 rounded-2xl border-2 border-kesari-600 bg-white px-3 text-sm font-bold text-ink-900">
            <Icon name="gift" size={20} className="shrink-0 text-kesari-700" />
            <span className="min-w-0 flex-1 truncate">
              {tr(UI.applyInvite, lang)} · {data.referralCode}
            </span>
            <Icon name="chevron-right" size={18} className="text-kesari-700" />
          </Link>
        ) : null}

        <HeroCarousel lang={lang} slides={data.banners} intervalSeconds={data.bannerSeconds} />

        <section aria-labelledby="home-categories">
          <SectionHeading id="home-categories" title={tr(HOME.shopByCategory, lang)} href="/categories" linkLabel={tr(HOME.allCategories, lang)} />
          <ul className="grid grid-cols-4 gap-2 sm:gap-3 lg:grid-cols-8">
            {CUSTOMER_CATEGORIES.map((c) => (
              <li key={c.key}>
                <Link
                  href={c.href}
                  data-testid="home-category"
                  data-key={c.key}
                  className="flex h-full min-h-[5.5rem] flex-col items-center justify-center gap-1.5 rounded-2xl border border-[var(--gk-line)] bg-white px-1 py-2 text-center hover:border-kesari-300 hover:shadow-sm lg:min-h-[7rem]"
                >
                  <span aria-hidden className={`grid h-11 w-11 place-items-center rounded-xl text-2xl lg:h-14 lg:w-14 lg:text-3xl ${c.bg}`}>
                    {c.emoji}
                  </span>
                  <span className="line-clamp-2 text-[0.8125rem] font-semibold leading-tight text-ink-900 lg:text-sm">
                    <span className="sm:hidden">{c.short?.[lang] ?? tr(c.label, lang)}</span>
                    <span className="max-sm:hidden">{tr(c.label, lang)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="home-shops" data-testid="home-shops">
          <SectionHeading
            id="home-shops"
            title={tr(data.hasLocation ? HOME.shopsNearYou : HOME.shopsOnGoKesari, lang)}
            href="/shops"
            linkLabel={tr(HOME.seeAll, lang)}
          />
          <ShopChips lang={lang} counts={data.counts} />
          {!data.hasLocation ? (
            <p className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm text-ink-700" data-testid="home-set-location">
              <Icon name="map-pin" size={16} className="text-kesari-700" />
              {tr(HOME.setLocationPrompt, lang)}
            </p>
          ) : null}
          {data.shops.length > 0 ? (
            <ShopGrid shops={data.shops} viewToggle={false} rail />
          ) : (
            <p className="rounded-xl bg-white px-4 py-6 text-center text-sm text-ink-700">{tr(HOME.noShopsNearby, lang)}</p>
          )}
        </section>

        {data.buyAgain.length > 0 ? (
          <section aria-labelledby="home-buy-again" data-testid="buy-again">
            <SectionHeading id="home-buy-again" title={tr(UI.buyAgain, lang)} href="/orders?tab=past" linkLabel={tr(HOME.seeAll, lang)} />
            <ProductTiles lang={lang} items={data.buyAgain} signedIn={signedIn} testId="buy-again-grid" />
          </section>
        ) : (
          <section id="popular" aria-labelledby="home-popular" data-testid="popular-in-area" data-scope={data.popular.scope} className="scroll-mt-32">
            <SectionHeading id="home-popular" title={tr(popularTitle, lang)} href="/shops" linkLabel={tr(HOME.seeAll, lang)} />
            {data.popular.items.length > 0 ? (
              <ProductTiles lang={lang} items={data.popular.items} signedIn={signedIn} testId="popular-grid" />
            ) : (
              <p className="rounded-xl bg-white px-4 py-6 text-center text-sm text-ink-700">{tr(HOME.popularEmpty, lang)}</p>
            )}
          </section>
        )}

        <JoinCards lang={lang} />
      </div>
    </div>
  );
}
