"use client";

/**
 * The home page header (docs/homepage-uiux-2026-10, F1/F2/F6). Sticky on
 * every screen size and compacting once the page scrolls:
 *  - phones: ☰ (side drawer) · logo · "Deliver to" · bell · cart with its
 *    item count, and the full-width search on the row below — both rows stay
 *    on screen while scrolling;
 *  - wide screens: logo · "Deliver to" · the wide search, centred ·
 *    language · bell · cart · "Account" dropdown (or "Sign in").
 * "Deliver to" opens the location sheet (GPS, saved addresses, PIN).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import clsx from "clsx";

import { LanguageSwitch } from "@/components/board/board-header";
import { Icon } from "@/components/board/icons";
import { BrandTagline, BrandWordmark } from "@/components/brand-wordmark";
import { OPEN_LOCATION_EVENT } from "@/components/location-picker";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { StandaloneBackButton } from "@/components/standalone-back-button";
import { LANG_TAG, tr, UI } from "@/lib/board/i18n";
import { HOME } from "@/lib/home-i18n";

import { AccountDrawer, AccountDropdown, type AccountNavProps } from "./account-nav";
import { LocationSheet } from "./location-sheet";
import { SearchBox } from "./search-box";

export interface HomeHeaderProps extends AccountNavProps {
  unreadCount: number;
  cartCount: number;
  locationLabel: string | null;
  savedAddresses: { id: string; label: string }[];
}

export function HomeHeader(props: HomeHeaderProps) {
  const { lang, user, unreadCount, cartCount, locationLabel, savedAddresses } = props;
  const [compact, setCompact] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setCompact(window.scrollY > 24));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // "Change location" links further down the page open the sheet.
  useEffect(() => {
    const open = () => setLocationOpen(true);
    window.addEventListener(OPEN_LOCATION_EVENT, open);
    return () => window.removeEventListener(OPEN_LOCATION_EVENT, open);
  }, []);

  return (
    <header
      lang={LANG_TAG[lang]}
      data-testid="home-header"
      data-compact={compact ? "true" : "false"}
      className={clsx("sticky top-0 z-40 border-b border-[var(--gk-line)] bg-white pt-[env(safe-area-inset-top)] transition-shadow", compact && "shadow-md")}
    >
      <div className={clsx("mx-auto flex w-full max-w-[1600px] items-center gap-1 px-2 transition-[height] duration-200 sm:gap-2 sm:px-4 lg:gap-3 lg:px-6", compact ? "h-12 lg:h-14" : "h-14 lg:h-16")}>
        <StandaloneBackButton />
        <AccountDrawer {...props} />
        {/* Not prefetched: the home page is rendered per request, so a prefetch here was a second full home render on every visit (performance check, 29 Oct 2026). */}
        <Link href="/" prefetch={false} className="flex min-h-11 shrink-0 items-center gap-2 py-1" aria-label={`GoKesari — ${tr(UI.home, lang)}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/gk-mark.png" alt="" width={62} height={36} className={clsx("w-auto rounded-lg transition-[height]", compact ? "h-7" : "h-8 lg:h-10")} />
          <span className={clsx("hidden flex-col xl:flex", compact && "xl:hidden")}>
            <BrandWordmark className="text-lg leading-tight" />
            <BrandTagline className="text-xs leading-tight" />
          </span>
        </Link>

        <button
          type="button"
          onClick={() => setLocationOpen(true)}
          aria-haspopup="dialog"
          data-testid="deliver-to"
          className="flex min-h-11 min-w-0 shrink items-center gap-1.5 rounded-xl px-1 py-1 text-left hover:bg-kesari-50 lg:max-w-[16rem] lg:border lg:border-[#f2c9a5] lg:bg-kesari-50 lg:px-3"
        >
          <Icon name="map-pin" size={20} className="shrink-0 text-kesari-700" />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className={clsx("whitespace-nowrap text-xs font-medium text-ink-600", compact && "max-lg:hidden")}>{tr(HOME.deliverTo, lang)}</span>
            <span className="truncate text-sm font-bold text-ink-900" data-testid="deliver-to-label">
              {locationLabel ?? tr(HOME.setLocation, lang)}
            </span>
          </span>
          <Icon name="chevron-down" size={14} className="hidden shrink-0 text-kesari-700 min-[400px]:block" />
        </button>

        <SearchBox lang={lang} signedIn={Boolean(user)} className="mx-auto hidden w-full max-w-2xl flex-1 lg:block" />

        <span className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1.5">
          <span className="hidden lg:flex">
            <LanguageSwitch lang={lang} />
          </span>
          {user ? (
            <NotificationBell
              lang={lang}
              unreadCount={unreadCount}
              accountKey={user.email}
              testId="home-bell"
              wrapperClassName="relative hidden min-[360px]:block"
              badgeClassName="right-0"
              className="relative grid h-11 w-11 place-items-center rounded-xl text-ink-900 hover:bg-kesari-50"
            />
          ) : null}
          <Link
            href="/cart"
            data-testid="home-cart"
            aria-label={`${tr(UI.cart, lang)}, ${cartCount} ${tr(UI.items, lang)}`}
            className="relative grid h-11 w-11 place-items-center rounded-xl text-ink-900 hover:bg-kesari-50"
          >
            <Icon name="shopping-cart" size={24} />
            {cartCount > 0 ? (
              <span data-testid="home-cart-count" className="absolute right-0 top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-kesari-700 px-1 text-xs font-bold tabular-nums text-white ring-2 ring-white">
                {cartCount > 99 ? "99+" : cartCount}
              </span>
            ) : null}
          </Link>
          <span className="hidden lg:block">
            <AccountDropdown {...props} />
          </span>
        </span>
      </div>

      <div className="px-2 pb-2 sm:px-4 lg:hidden">
        <SearchBox lang={lang} signedIn={Boolean(user)} size="lg" />
      </div>

      {locationOpen ? (
        <LocationSheet lang={lang} currentLabel={locationLabel} savedAddresses={savedAddresses} signedIn={Boolean(user)} onClose={() => setLocationOpen(false)} />
      ) : null}
    </header>
  );
}
