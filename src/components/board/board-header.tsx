"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { LocationPanel, OPEN_LOCATION_EVENT } from "@/components/location-picker";
import { RoleSwitcher } from "@/components/role-switcher";
import { StandaloneBackButton } from "@/components/standalone-back-button";
import { formatCount, formatRupees } from "@/lib/board/format";
import { L, LANG_NAME, LANG_SWITCH_LABEL, LANGUAGES, tr, UI, type Lang } from "@/lib/board/i18n";
import { setLanguageAction } from "@/server/language-action";
import { signOutAction } from "@/server/sign-out-action";

import { Icon } from "./icons";

/** Account menu links, in the board's language. */
const ACCOUNT_LINKS = [
  { href: "/profile", label: L("My profile", "मेरी प्रोफ़ाइल", "माझे प्रोफाइल") },
  { href: "/wallet", label: L("My wallet", "मेरा वॉलेट", "माझे वॉलेट") },
  { href: "/orders", label: L("My orders", "मेरे ऑर्डर", "माझ्या ऑर्डर") },
  { href: "/society", label: L("My society", "मेरी सोसाइटी", "माझी सोसायटी") },
  { href: "/profile/bank-account", label: L("Bank account", "बैंक खाता", "बँक खाते") },
];

export interface BoardHeaderProps {
  lang: Lang;
  user: { name: string | null; email: string; role: string } | null;
  roles: string[];
  unreadCount: number;
  /** Extra account links (shops I help with, referral pages) — names already final. */
  extraLinks?: { href: string; label: string }[];
  /** Customer: "Deliver to" chooser; staff: a small role line and a name. */
  context:
    | { kind: "customer"; locationLabel: string | null; savedAddresses: { id: string; label: string }[]; balancePaise: number | null }
    | { kind: "staff"; roleLine: string; title: string };
}

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
 * The language switch: three submit buttons on one form, so it works with or
 * without JavaScript. The server stores the cookie and re-renders the page.
 */
export function LanguageSwitch({ lang }: { lang: Lang }) {
  return (
    <form action={setLanguageAction} className="shrink-0" data-testid="language-switch">
      <fieldset className="flex h-9 items-stretch overflow-hidden rounded-full border border-[#f2c9a5] bg-white">
        <legend className="sr-only">{tr(UI.language, lang)}</legend>
        {LANGUAGES.map((code) => (
          <button
            key={code}
            type="submit"
            name="lang"
            value={code}
            aria-pressed={code === lang}
            lang={code}
            title={LANG_NAME[code]}
            aria-label={LANG_NAME[code]}
            className={clsx(
              "min-w-[1.625rem] px-0.5 text-[0.8125rem] font-bold leading-none sm:min-w-[2.5rem] sm:px-2.5",
              code === lang ? "bg-kesari-700 text-white" : "text-ink-700 hover:bg-kesari-50",
            )}
          >
            {LANG_SWITCH_LABEL[code]}
          </button>
        ))}
      </fieldset>
    </form>
  );
}

/**
 * The compact board header (one 56px row on phones): logo, context, language
 * switch, notifications and the account menu. Used only on the four role home
 * screens; every other page keeps the site header.
 */
export function BoardHeader({ lang, user, roles, unreadCount, extraLinks = [], context }: BoardHeaderProps) {
  const pathname = usePathname();
  const [accountOpen, setAccountOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const closeAccount = useCallback(() => setAccountOpen(false), []);
  useDismiss(accountRef, accountOpen, closeAccount);

  // Close popovers on navigation (render-time sync, not an effect).
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setAccountOpen(false);
    setLocationOpen(false);
  }

  // "Change location" links further down the page open the chooser here.
  useEffect(() => {
    if (context.kind !== "customer") return;
    const open = () => {
      setLocationOpen(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener(OPEN_LOCATION_EVENT, open);
    return () => window.removeEventListener(OPEN_LOCATION_EVENT, open);
  }, [context.kind]);

  const unread = formatCount(unreadCount);
  const balance = context.kind === "customer" ? formatRupees(context.balancePaise) : null;

  return (
    <header className="sticky top-0 z-40 border-b border-[#f6dcc4] bg-white" data-testid="board-header">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-1.5 px-3 sm:gap-3 sm:px-4 lg:h-16 lg:px-6">
        {/* iPhone home-screen app only (no browser toolbar there); hidden on "/". */}
        <StandaloneBackButton />
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="GoKesari home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/gk-mark.png" alt="" width={62} height={36} className="h-7 w-auto rounded-lg sm:h-8 lg:h-10" />
          <span className="hidden flex-col xl:flex">
            <span className="text-lg font-bold leading-tight text-ink-900">
              Go<span className="text-kesari-700">Kesari</span>
            </span>
            <span className="text-xs font-medium leading-tight text-ink-600">Everything for Everyone</span>
          </span>
        </Link>

        {context.kind === "customer" ? (
          <button
            type="button"
            onClick={() => setLocationOpen((v) => !v)}
            aria-expanded={locationOpen}
            aria-controls="location-panel"
            data-testid="board-location"
            className="flex min-w-0 shrink items-center gap-1.5 rounded-xl px-1 py-1 text-left hover:bg-kesari-50 lg:border lg:border-[#f2c9a5] lg:bg-kesari-50 lg:px-3"
          >
            <Icon name="map-pin" size={20} className="shrink-0 text-kesari-700" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="whitespace-nowrap text-[0.6875rem] font-medium text-ink-600 lg:text-xs">{tr(UI.deliverTo, lang)}</span>
              <span className="truncate text-sm font-bold text-ink-900" data-testid="board-location-label">
                {context.locationLabel ?? tr(UI.chooseLocation, lang)}
              </span>
            </span>
            <Icon name="chevron-down" size={14} className={clsx("hidden shrink-0 text-kesari-700 transition-transform min-[400px]:block", locationOpen && "rotate-180")} />
          </button>
        ) : (
          <span className="flex min-w-0 flex-col leading-tight" data-testid="board-context">
            <span className="truncate text-[0.6875rem] font-medium text-ink-600 lg:text-xs">{context.roleLine}</span>
            <span className="truncate text-sm font-bold text-ink-900 lg:text-base">{context.title}</span>
          </span>
        )}

        {context.kind === "customer" ? (
          <form action="/search" role="search" className="mx-2 hidden min-w-0 flex-1 lg:block">
            <label className="flex h-11 items-center gap-2 rounded-xl border border-[#f2c9a5] bg-[#fffaf4] px-3 focus-within:border-kesari-600">
              <Icon name="search" size={18} className="shrink-0 text-ink-600" />
              <input
                type="search"
                name="q"
                placeholder={tr(UI.searchPlaceholder, lang)}
                aria-label={tr(UI.searchLabel, lang)}
                className="min-w-0 flex-1 bg-transparent text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none"
              />
            </label>
          </form>
        ) : (
          <span className="flex-1" />
        )}

        <span className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <LanguageSwitch lang={lang} />

          {balance && user ? (
            <Link
              href="/wallet"
              className="hidden h-10 items-center gap-1.5 rounded-xl bg-kesari-50 px-3 text-sm font-bold tabular-nums text-kesari-800 hover:bg-kesari-100 lg:flex"
              data-testid="board-wallet"
            >
              <Icon name="wallet" size={18} />
              {balance}
            </Link>
          ) : null}

          {user ? (
            <Link
              href="/profile#notifications"
              className="relative grid h-10 w-8 place-items-center rounded-xl text-ink-900 hover:bg-kesari-50"
              aria-label={`${tr(UI.notifications, lang)}${unread ? `, ${unreadCount} ${tr(UI.unread, lang)}` : ""}`}
              data-testid="board-bell"
            >
              <Icon name="bell" size={22} />
              {unread ? (
                <span className="absolute right-0 top-0.5 grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-red-700 px-1 text-[0.6875rem] font-bold text-white ring-2 ring-white">
                  {unread}
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
                data-testid="board-account"
                className="flex h-10 items-center gap-2 rounded-full hover:bg-kesari-50 lg:p-0.5 lg:pr-3"
              >
                <span className="grid h-8 w-8 place-items-center rounded-full bg-kesari-700 text-sm font-bold text-white">
                  {(user.name ?? user.email).charAt(0).toUpperCase()}
                </span>
                <span className="hidden max-w-[8rem] truncate text-sm font-semibold text-ink-900 lg:inline">{user.name ?? user.email}</span>
              </button>
              {accountOpen ? (
                <div
                  role="menu"
                  data-testid="board-account-menu"
                  className="absolute right-0 top-full z-50 mt-1 max-h-[80vh] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-cream-200 bg-white p-1.5 shadow-lg"
                >
                  <div className="border-b border-cream-200 px-3 pb-2 pt-1.5">
                    <p className="truncate text-sm font-semibold text-ink-900">{user.name ?? tr(UI.myProfile, lang)}</p>
                    <p className="truncate text-xs text-ink-600">{user.email}</p>
                  </div>
                  {roles.length > 1 ? (
                    <div className="flex items-center justify-between gap-2 border-b border-cream-200 px-3 py-2 text-xs text-ink-600">
                      {tr(UI.actingAs, lang)}
                      <RoleSwitcher active={user.role} roles={roles} />
                    </div>
                  ) : null}
                  <div className="py-1">
                    {[...ACCOUNT_LINKS.map((l) => ({ href: l.href, label: tr(l.label, lang) })), ...extraLinks].map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        role="menuitem"
                        className="block rounded-lg px-3 py-2 text-sm text-ink-700 hover:bg-cream-100"
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                  <form action={signOutAction} className="border-t border-cream-200 pt-1">
                    <button
                      type="submit"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-700 hover:bg-cream-100"
                    >
                      <Icon name="log-out" size={16} />
                      {tr(UI.signOut, lang)}
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
          ) : (
            <Link
              href="/signin"
              className="flex h-9 items-center whitespace-nowrap rounded-xl bg-kesari-700 px-2.5 text-sm font-bold text-white hover:bg-kesari-800"
            >
              {tr(UI.signIn, lang)}
            </Link>
          )}
        </span>
      </div>

      {context.kind === "customer" && locationOpen ? (
        <LocationPanel
          currentLabel={context.locationLabel}
          savedAddresses={context.savedAddresses}
          onClose={() => setLocationOpen(false)}
        />
      ) : null}
    </header>
  );
}
