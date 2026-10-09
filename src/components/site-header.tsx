"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { LanguageSwitch } from "@/components/board/board-header";
import { Icon, type IconName } from "@/components/board/icons";
import { LocationPanel, OPEN_LOCATION_EVENT } from "@/components/location-picker";
import { RoleSwitcher } from "@/components/role-switcher";
import { StandaloneBackButton } from "@/components/standalone-back-button";
import { L, LANG_TAG, tr, UI, type Lang, type Text } from "@/lib/board/i18n";
import { BOARD_HOME, boardRoleFor } from "@/lib/board/menus";
import { formatPaiseCompact } from "@/lib/money";
import type { UserRole } from "@/server/db/schema";
import { signOutAction } from "@/server/sign-out-action";

interface Props {
  lang: Lang;
  user: { id: string; name: string | null; email: string; role: UserRole } | null;
  /** Roles the user holds (GS-003) — a switcher appears when there are several. */
  roles?: UserRole[];
  cartCount: number;
  balancePaise: number | null;
  unreadCount: number;
  /** The chosen delivery location as the pill shows it, or null when none is chosen. */
  locationLabel: string | null;
  /** The signed-in user's saved addresses, offered in the location chooser. */
  savedAddresses: { id: string; label: string }[];
  /** Module 1: the user is staff of at least one shop (edits its product photos and descriptions). */
  helpsShops?: boolean;
  /** Referral links (docs/four-features-2026-10): only those whose rule is switched on. */
  referralLinks?: { href: string; key: "referral" | "invite" }[];
}

/** Customer destinations in the row on wide screens (on phones the home board holds them). */
const CUSTOMER_NAV: { href: string; label: Text; auth?: boolean }[] = [
  { href: "/shops", label: UI.shops },
  { href: "/orders", label: UI.orders, auth: true },
  { href: "/subscriptions", label: UI.subscriptions, auth: true },
];

/** Account menu destinations, in the page's language. */
const ACCOUNT_NAV: { href: string; label: Text }[] = [
  { href: "/profile", label: L("My profile", "मेरी प्रोफ़ाइल", "माझे प्रोफाइल") },
  { href: "/wallet", label: L("My wallet", "मेरा वॉलेट", "माझे वॉलेट") },
  { href: "/orders", label: L("My orders", "मेरे ऑर्डर", "माझ्या ऑर्डर") },
  { href: "/society", label: L("My society", "मेरी सोसाइटी", "माझी सोसायटी") },
  { href: "/profile/bank-account", label: L("Bank account", "बैंक खाता", "बँक खाते") },
];

/** A delivery partner's own pages (not one of the four board roles). */
const RIDER_NAV: { href: string; label: Text }[] = [
  { href: "/delivery-partner", label: L("Delivery partner", "डिलीवरी पार्टनर", "डिलिव्हरी पार्टनर") },
  { href: "/gig/orders", label: UI.riderHome },
  { href: "/gig/profile", label: L("My delivery profile", "मेरी डिलीवरी प्रोफ़ाइल", "माझे डिलिव्हरी प्रोफाइल") },
  { href: "/gig/id-card", label: L("My ID card", "मेरा आईडी कार्ड", "माझे ओळखपत्र") },
];

/** Closes a popover on outside click or Escape. */
function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

/**
 * The header on every page that is not a home board — the same one-row look
 * as the boards' header (Tile Board). One clear way to every function:
 *  - customers and visitors: "Deliver to", search, Shops / Orders /
 *    Subscriptions (wide screens), wallet and cart;
 *  - shop owners, admins and operators: a "Board" button back to their home
 *    board, where every menu and submenu is. The long role menus that used to
 *    sit here (12–36 links) are gone; admins and operators no longer see
 *    customer items (cart, deliver-to, wallet).
 * The language switch is on every page.
 */
export function SiteHeader({
  lang,
  user,
  roles = [],
  cartCount,
  balancePaise,
  unreadCount,
  locationLabel,
  savedAddresses,
  helpsShops = false,
  referralLinks = [],
}: Props) {
  const pathname = usePathname();
  const [locationOpen, setLocationOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const closeAccount = useCallback(() => setAccountOpen(false), []);
  useDismiss(accountRef, accountOpen, closeAccount);

  // Close everything on navigation (render-time sync, not an effect).
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setAccountOpen(false);
    setLocationOpen(false);
  }

  // "Change location" links elsewhere on the page open the chooser here.
  useEffect(() => {
    const openLocation = () => {
      setLocationOpen(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener(OPEN_LOCATION_EVENT, openLocation);
    return () => window.removeEventListener(OPEN_LOCATION_EVENT, openLocation);
  }, []);

  const role = user?.role ?? null;
  const board = boardRoleFor(role);
  const isStaff = role === "ADMIN" || role === "OPERATOR";
  const isRider = role === "DELIVERY_PARTNER";
  /** Customer items (deliver-to, cart, wallet) — not for admins, operators or riders at work. */
  const shopsForThem = !isStaff && !isRider;
  const boardLink: { href: string; label: Text; icon: IconName } | null =
    board === "shop"
      ? { href: BOARD_HOME.shop, label: UI.shopBoard, icon: "layout-grid" }
      : board === "admin"
        ? { href: BOARD_HOME.admin, label: UI.adminBoard, icon: "layout-grid" }
        : board === "operator"
          ? { href: BOARD_HOME.operator, label: UI.operatorBoard, icon: "layout-grid" }
          : isRider
            ? { href: "/gig/orders", label: UI.riderHome, icon: "bike" }
            : null;

  const accountNav = [
    ...(shopsForThem ? ACCOUNT_NAV : ACCOUNT_NAV.filter((i) => i.href === "/profile")),
    ...(isRider ? RIDER_NAV : []),
    ...(helpsShops ? [{ href: "/shop/staff-access", label: UI.shopsIHelp }] : []),
    ...referralLinks.map((r) => ({ href: r.key === "referral" ? "/referral" : "/refer", label: r.key === "referral" ? UI.myReferralCode : UI.inviteFriends })),
  ];

  return (
    <header lang={LANG_TAG[lang]} className="sticky top-0 z-40 border-b border-[var(--gk-line)] bg-white" data-testid="site-header">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-1.5 px-2 sm:gap-2 sm:px-4 lg:h-16 lg:gap-3 lg:px-6">
        <StandaloneBackButton />
        <Link href="/" className="flex min-h-11 shrink-0 items-center gap-2 py-1" aria-label={`GoKesari — ${tr(UI.home, lang)}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/gk-mark.png" alt="" width={62} height={36} className="h-8 w-auto rounded-lg lg:h-10" />
          <span className="hidden flex-col xl:flex">
            <span className="text-lg font-bold leading-tight text-ink-900">
              Go<span className="text-kesari-700">Kesari</span>
            </span>
            <span className="text-xs font-medium leading-tight text-ink-600">Everything for Everyone</span>
          </span>
        </Link>

        {boardLink ? (
          <Link
            href={boardLink.href}
            data-testid="header-board"
            className={clsx(
              "flex h-11 min-w-0 shrink items-center gap-1.5 rounded-xl border-2 px-2.5 text-sm font-bold",
              pathname === boardLink.href ? "border-kesari-700 bg-kesari-700 text-white" : "border-kesari-600 bg-white text-kesari-800 hover:bg-kesari-50",
            )}
          >
            <Icon name={boardLink.icon} size={18} className="shrink-0" />
            <span className="truncate">{tr(boardLink.label, lang)}</span>
          </Link>
        ) : null}

        {shopsForThem && !boardLink ? (
          <button
            type="button"
            onClick={() => setLocationOpen((v) => !v)}
            aria-expanded={locationOpen}
            aria-controls="location-panel"
            data-testid="location-pill"
            className="flex min-h-11 min-w-0 shrink items-center gap-1.5 rounded-xl px-1 py-1 text-left hover:bg-kesari-50 lg:border lg:border-[#f2c9a5] lg:bg-kesari-50 lg:px-3"
          >
            <Icon name="map-pin" size={20} className="shrink-0 text-kesari-700" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="whitespace-nowrap text-xs font-medium text-ink-600">{tr(UI.deliverTo, lang)}</span>
              <span className="truncate text-sm font-bold text-ink-900" data-testid="location-label">
                {locationLabel ?? tr(UI.chooseLocation, lang)}
              </span>
            </span>
            <Icon name="chevron-down" size={14} className={clsx("hidden shrink-0 text-kesari-700 transition-transform min-[400px]:block", locationOpen && "rotate-180")} />
          </button>
        ) : null}

        {shopsForThem ? (
          <form action="/search" role="search" className="mx-1 hidden min-w-0 flex-1 md:block">
            <label className="flex h-11 items-center gap-2 rounded-xl border border-[#f2c9a5] bg-[#fffaf4] px-3 focus-within:border-kesari-600">
              <Icon name="search" size={18} className="shrink-0 text-ink-600" />
              <input
                type="search"
                name="q"
                placeholder={tr(UI.searchPlaceholder, lang)}
                aria-label={tr(UI.searchLabel, lang)}
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink-900 placeholder:text-ink-600 focus:outline-none"
              />
            </label>
          </form>
        ) : (
          <span className="flex-1" />
        )}

        {shopsForThem && !boardLink ? (
          <nav className="hidden items-center gap-1 lg:flex" aria-label={tr(UI.board, lang)}>
            {CUSTOMER_NAV.filter((i) => !i.auth || user).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                className={clsx(
                  "flex h-11 items-center whitespace-nowrap rounded-xl px-3 text-sm font-semibold",
                  pathname.startsWith(item.href) ? "bg-kesari-50 text-kesari-800" : "text-ink-700 hover:bg-cream-100",
                )}
              >
                {tr(item.label, lang)}
              </Link>
            ))}
          </nav>
        ) : null}

        <span className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
          {shopsForThem ? (
            <Link
              href="/search"
              className="grid h-11 w-11 place-items-center min-[360px]:h-12 min-[360px]:w-12 rounded-xl text-ink-900 hover:bg-kesari-50 md:hidden"
              aria-label={tr(UI.search, lang)}
              data-testid="header-search"
            >
              <Icon name="search" size={22} />
            </Link>
          ) : null}

          <LanguageSwitch lang={lang} />

          {shopsForThem && balancePaise !== null ? (
            <Link
              href="/wallet"
              className="hidden h-11 items-center gap-1.5 rounded-xl bg-kesari-50 px-3 text-sm font-bold tabular-nums text-kesari-800 hover:bg-kesari-100 sm:flex"
              aria-label={`${tr(UI.walletBalance, lang)} ${formatPaiseCompact(balancePaise)}`}
              data-testid="header-wallet"
            >
              <Icon name="wallet" size={18} />
              {formatPaiseCompact(balancePaise)}
            </Link>
          ) : null}

          {shopsForThem ? (
            <Link
              href="/cart"
              className="relative grid h-11 w-11 place-items-center min-[360px]:h-12 min-[360px]:w-12 rounded-xl text-ink-900 hover:bg-kesari-50"
              aria-label={`${tr(UI.cart, lang)}, ${cartCount} ${tr(UI.items, lang)}`}
              data-testid="header-cart"
            >
              <Icon name="shopping-cart" size={22} />
              {cartCount > 0 ? (
                <span className="absolute right-0.5 top-0.5 grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-kesari-700 px-1 text-xs font-bold text-white ring-2 ring-white">
                  {cartCount}
                </span>
              ) : null}
            </Link>
          ) : null}

          {user ? (
            <Link
              href="/profile?tab=notifications"
              className="relative hidden h-12 w-12 place-items-center rounded-xl text-ink-900 hover:bg-kesari-50 min-[400px]:grid"
              aria-label={`${tr(UI.notifications, lang)}${unreadCount > 0 ? `, ${unreadCount} ${tr(UI.unread, lang)}` : ""}`}
              data-testid="header-bell"
            >
              <Icon name="bell" size={22} />
              {unreadCount > 0 ? (
                <span className="absolute right-0.5 top-0.5 grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-red-700 px-1 text-xs font-bold text-white ring-2 ring-white">
                  {unreadCount}
                </span>
              ) : null}
            </Link>
          ) : null}

          {user ? (
            <div ref={accountRef} className="relative">
              <button
                type="button"
                onClick={() => setAccountOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                aria-label={tr(UI.account, lang)}
                data-testid="account-button"
                className="relative grid h-11 w-11 place-items-center min-[360px]:h-12 min-[360px]:w-12 rounded-full hover:bg-kesari-50"
              >
                <span className="grid h-9 w-9 place-items-center rounded-full bg-kesari-700 text-sm font-bold text-white">
                  {(user.name ?? user.email).charAt(0).toUpperCase()}
                </span>
                {unreadCount > 0 ? <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-red-700 ring-2 ring-white min-[400px]:hidden" /> : null}
              </button>
              {accountOpen ? (
                <div
                  role="menu"
                  data-testid="account-menu"
                  className="absolute right-0 top-full z-50 mt-1 max-h-[80vh] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-cream-200 bg-white p-1.5 shadow-lg"
                >
                  <div className="border-b border-cream-200 px-3 pb-2 pt-1.5">
                    <p className="truncate text-sm font-semibold text-ink-900">{user.name ?? tr(UI.myProfile, lang)}</p>
                    <p className="truncate text-sm text-ink-600">{user.email}</p>
                  </div>
                  {roles.length > 1 ? (
                    <div className="flex items-center justify-between gap-2 border-b border-cream-200 px-3 py-2 text-sm text-ink-600">
                      {tr(UI.actingAs, lang)}
                      <RoleSwitcher active={user.role} roles={roles} />
                    </div>
                  ) : null}
                  <div className="py-1">
                    {boardLink ? (
                      <Link href={boardLink.href} role="menuitem" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-bold text-kesari-800 hover:bg-cream-100">
                        <Icon name={boardLink.icon} size={16} />
                        {tr(boardLink.label, lang)}
                      </Link>
                    ) : null}
                    {user && unreadCount > 0 ? (
                      <Link href="/profile?tab=notifications" role="menuitem" className="flex min-h-11 items-center justify-between rounded-lg px-3 text-sm text-ink-700 hover:bg-cream-100 min-[400px]:hidden">
                        {tr(UI.notifications, lang)}
                        <span className="rounded-full bg-red-700 px-1.5 text-xs font-bold text-white">{unreadCount}</span>
                      </Link>
                    ) : null}
                    {shopsForThem && balancePaise !== null ? (
                      <Link href="/wallet" role="menuitem" className="flex min-h-11 items-center justify-between rounded-lg px-3 text-sm text-ink-700 hover:bg-cream-100 sm:hidden">
                        {tr(UI.wallet, lang)}
                        <span className="font-bold tabular-nums text-kesari-800">{formatPaiseCompact(balancePaise)}</span>
                      </Link>
                    ) : null}
                    {accountNav.map((item) => (
                      <Link key={item.href} href={item.href} role="menuitem" className="flex min-h-11 items-center rounded-lg px-3 text-sm text-ink-700 hover:bg-cream-100">
                        {tr(item.label, lang)}
                      </Link>
                    ))}
                  </div>
                  <form action={signOutAction} className="border-t border-cream-200 pt-1">
                    <button
                      type="submit"
                      role="menuitem"
                      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-ink-700 hover:bg-cream-100"
                    >
                      <Icon name="log-out" size={16} />
                      {tr(UI.signOut, lang)}
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
          ) : (
            <Link href="/signin" className="flex h-11 items-center whitespace-nowrap rounded-xl bg-kesari-700 px-3 text-sm font-bold text-white hover:bg-kesari-800">
              {tr(UI.signIn, lang)}
            </Link>
          )}
        </span>
      </div>

      {locationOpen ? (
        <LocationPanel currentLabel={locationLabel} savedAddresses={savedAddresses} onClose={() => setLocationOpen(false)} />
      ) : null}
    </header>
  );
}
