"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { LocationPanel, OPEN_LOCATION_EVENT } from "@/components/location-picker";
import { RoleSwitcher } from "@/components/role-switcher";
import { formatPaiseCompact } from "@/lib/money";
import type { Lang } from "@/lib/tile-board/i18n";
import { signOutAction } from "@/server/sign-out-action";

import { Icon } from "./icon";
import { LanguageSwitch } from "./language-switch";

export interface BoardHeaderText {
  deliverTo: string;
  chooseLocation: string;
  language: string;
  notifications: string;
  account: string;
  signIn: string;
  signOut: string;
  actingAs: string;
  search: string;
  searchPlaceholder: string;
}

export interface BoardHeaderProps {
  lang: Lang;
  text: BoardHeaderText;
  /** Signed-in user, or null for a visitor. */
  user: { name: string | null; email: string; role: string } | null;
  roles: string[];
  unreadCount: number;
  /** Customer screen: the "Deliver to" chooser. */
  location?: { label: string | null; savedAddresses: { id: string; label: string }[] };
  /** Staff screens: "My shop" over the shop's name, "Admin" over "Admin console". */
  title?: { overline: string; name: string };
  /** Wide screens, customer: the search box and wallet balance sit in the header. */
  showSearch?: boolean;
  walletBalancePaise?: number | null;
  /** The account menu's destinations, already in the chosen language. */
  accountLinks: { href: string; label: string }[];
}

/** Closes a popover on outside click or Escape. */
function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

/**
 * The Tile Board's header: logo, where you are (delivery place or role),
 * language, notifications and the account menu — one row, on every width.
 *
 * It replaces the site header on the four role home screens only; every other
 * page keeps the site header as it is.
 */
export function BoardHeader({
  lang,
  text,
  user,
  roles,
  unreadCount,
  location,
  title,
  showSearch = false,
  walletBalancePaise = null,
  accountLinks,
}: BoardHeaderProps) {
  const [locationOpen, setLocationOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  useDismiss(accountRef, accountOpen, () => setAccountOpen(false));

  // "Choose your location" links elsewhere on the page open the chooser here.
  useEffect(() => {
    if (!location) return;
    const open = () => {
      setLocationOpen(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener(OPEN_LOCATION_EVENT, open);
    return () => window.removeEventListener(OPEN_LOCATION_EVENT, open);
  }, [location]);

  const initial = user ? (user.name ?? user.email).charAt(0).toUpperCase() : "";

  return (
    <header className="relative z-40 shrink-0 border-b border-kesari-100 bg-white" data-testid="tile-board-header">
      <div className="flex h-14 items-center gap-2 px-3 lg:h-[68px] lg:gap-4 lg:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="GoKesari">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/gk-mark.png" alt="" width={62} height={36} className="h-8 w-auto rounded-lg lg:h-9" />
          <span className="hidden flex-col lg:flex">
            <span className="text-lg font-bold leading-tight text-ink-900">
              Go<span className="text-kesari-600">Kesari</span>
            </span>
            <span className="text-xs font-medium leading-tight text-ink-500">Everything for Everyone</span>
          </span>
        </Link>

        {location ? (
          <button
            type="button"
            onClick={() => setLocationOpen((value) => !value)}
            aria-expanded={locationOpen}
            aria-controls="location-panel"
            data-testid="board-location-pill"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl py-1 text-left lg:max-w-[20rem] lg:flex-none lg:gap-2 lg:bg-kesari-50 lg:px-3 lg:py-2"
          >
            <Icon name="map-pin" size={18} className="shrink-0 text-kesari-600" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-[11px] font-medium text-ink-500">{text.deliverTo}</span>
              <span className="truncate text-[13px] font-bold text-ink-900 lg:text-sm" data-testid="board-location-label">
                {location.label ?? text.chooseLocation}
              </span>
            </span>
            <Icon
              name="chevron-down"
              size={14}
              className={`shrink-0 text-kesari-700 transition-transform ${locationOpen ? "rotate-180" : ""}`}
            />
          </button>
        ) : title ? (
          <div className="flex min-w-0 flex-1 flex-col leading-tight lg:flex-none">
            <span className="text-[11px] font-medium text-ink-500">{title.overline}</span>
            <span className="truncate text-[14px] font-bold text-ink-900 lg:text-base" data-testid="board-title">
              {title.name}
            </span>
          </div>
        ) : (
          <span className="flex-1" />
        )}

        {showSearch ? (
          <form action="/search" role="search" className="hidden min-w-0 flex-1 lg:block">
            <label className="flex h-11 items-center gap-2.5 rounded-xl border border-kesari-200 bg-kesari-50/60 px-3.5 focus-within:border-kesari-500">
              <Icon name="search" size={18} className="shrink-0 text-ink-500" />
              <input
                type="search"
                name="q"
                placeholder={text.searchPlaceholder}
                aria-label={text.search}
                className="min-w-0 flex-1 bg-transparent text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none"
              />
            </label>
          </form>
        ) : (
          <span className="hidden flex-1 lg:block" />
        )}

        <LanguageSwitch lang={lang} label={text.language} />

        {walletBalancePaise !== null && user ? (
          <Link
            href="/wallet"
            data-testid="board-wallet"
            className="hidden items-center gap-2 rounded-xl bg-kesari-50 px-3 py-2 text-sm font-bold tabular-nums text-ink-900 hover:bg-kesari-100 lg:flex"
          >
            <Icon name="wallet" size={18} className="text-kesari-600" />
            {formatPaiseCompact(walletBalancePaise)}
          </Link>
        ) : null}

        {user ? (
          <Link
            href="/profile#notifications"
            aria-label={unreadCount > 0 ? `${text.notifications} (${unreadCount})` : text.notifications}
            data-testid="board-bell"
            className="relative grid h-9 w-8 shrink-0 place-items-center rounded-lg text-ink-900 hover:bg-kesari-50"
          >
            <Icon name="bell" size={20} />
            {unreadCount > 0 ? (
              <span className="absolute -right-0.5 top-0 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : null}
          </Link>
        ) : null}

        {user ? (
          <div ref={accountRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setAccountOpen((value) => !value)}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              aria-label={text.account}
              data-testid="board-account"
              className="flex items-center gap-2 rounded-full p-0.5 hover:bg-kesari-50 lg:bg-kesari-50 lg:pr-3"
            >
              <span className="grid h-8 w-8 place-items-center rounded-full bg-kesari-600 text-sm font-bold text-white">
                {initial}
              </span>
              <span className="hidden max-w-[8rem] truncate text-sm font-semibold text-ink-900 lg:block">
                {user.name?.trim().split(/\s+/)[0] ?? user.email}
              </span>
            </button>
            {accountOpen ? (
              <div
                role="menu"
                data-testid="board-account-menu"
                className="absolute right-0 top-full z-50 mt-1 w-60 max-w-[calc(100vw-1.5rem)] rounded-xl border border-kesari-100 bg-white p-1.5 shadow-lg"
              >
                <div className="border-b border-kesari-100 px-3 pb-2 pt-1.5">
                  <p className="truncate text-sm font-semibold text-ink-900">{user.name ?? text.account}</p>
                  <p className="truncate text-xs text-ink-500">{user.email}</p>
                </div>
                {roles.length > 1 ? (
                  <div className="flex items-center justify-between gap-2 border-b border-kesari-100 px-3 py-2 text-xs text-ink-500">
                    {text.actingAs}
                    <RoleSwitcher active={user.role} roles={roles} />
                  </div>
                ) : null}
                <div className="py-1">
                  {accountLinks.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      role="menuitem"
                      className="block rounded-lg px-3 py-2 text-sm text-ink-700 hover:bg-kesari-50"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
                <form action={signOutAction} className="border-t border-kesari-100 pt-1">
                  <button
                    type="submit"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-700 hover:bg-kesari-50"
                  >
                    <Icon name="log-out" size={16} />
                    {text.signOut}
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        ) : (
          <Link
            href="/signin"
            data-testid="board-sign-in"
            className="shrink-0 rounded-lg bg-kesari-600 px-3 py-2 text-[13px] font-semibold leading-none text-white hover:bg-kesari-800"
          >
            {text.signIn}
          </Link>
        )}
      </div>

      {location && locationOpen ? (
        <LocationPanel
          currentLabel={location.label}
          savedAddresses={location.savedAddresses}
          onClose={() => setLocationOpen(false)}
        />
      ) : null}
    </header>
  );
}
