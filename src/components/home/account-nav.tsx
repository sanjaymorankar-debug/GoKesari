"use client";

/**
 * Account navigation (docs/homepage-uiux-2026-10, F1): the Orders,
 * Subscriptions, Wallet, Tracking and Profile menus that used to be tiles on
 * the home page, now
 *  - wide screens: the header's "Account" dropdown;
 *  - phones: the side drawer behind the ☰ button.
 * Guests never see these menus — only "Sign in / Create account". The groups
 * and links come from the customer board's menus (lib/board/menus.ts), so
 * every destination stays exactly where it was.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

import { Icon, type IconName } from "@/components/board/icons";
import { RoleSwitcher } from "@/components/role-switcher";
import { formatRupees } from "@/lib/board/format";
import { LANG_NAME, LANG_SWITCH_LABEL, LANGUAGES, tr, UI, type Lang, type Text } from "@/lib/board/i18n";
import { BOARD_HOME, boardRoleFor, CUSTOMER_MENUS, visibleMenus, type LinkParams } from "@/lib/board/menus";
import { HOME } from "@/lib/home-i18n";
import type { UserRole } from "@/server/db/schema";
import { setLanguageAction } from "@/server/language-action";
import { signOutAction } from "@/server/sign-out-action";

export interface AccountUser {
  name: string | null;
  email: string;
  role: UserRole;
}

export interface AccountNavProps {
  lang: Lang;
  user: AccountUser | null;
  roles: string[];
  balancePaise: number | null;
  /** Shops I help with, referral pages — names already final. */
  extraLinks: { href: string; label: string }[];
  /** Values for `{placeholders}` (the active order, the first subscription). */
  params?: LinkParams;
}

const EXTRA_LINK_LABELS: Record<string, Text> = {
  "/shop/staff-access": UI.shopsIHelp,
  "/referral": UI.myReferralCode,
  "/refer": UI.inviteFriends,
};

interface Group {
  key: string;
  label: string;
  icon: IconName;
  links: { href: string; label: string }[];
}

/** The account groups: every customer menu except Shops (that is the page itself). */
function accountGroups(lang: Lang, role: UserRole, params: LinkParams): Group[] {
  return visibleMenus(CUSTOMER_MENUS, role, params)
    .filter((m) => m.key !== "shops")
    .map((m) => ({
      key: m.key,
      label: tr(m.label, lang),
      icon: m.icon ?? "user",
      links: [
        // The profile page itself heads its group.
        ...(m.key === "profile" ? [{ href: "/profile", label: tr(HOME.myProfile, lang) }] : []),
        ...m.items.map((i) => ({ href: i.href, label: tr(i.label, lang) })),
      ],
    }));
}

/** Seller Central / Admin board for the roles that have one. */
function boardLink(role: UserRole, lang: Lang): { href: string; label: string } | null {
  const board = boardRoleFor(role);
  if (board === "shop") return { href: BOARD_HOME.shop, label: tr(UI.shopBoard, lang) };
  if (board === "admin") return { href: BOARD_HOME.admin, label: tr(UI.adminBoard, lang) };
  if (board === "operator") return { href: BOARD_HOME.operator, label: tr(UI.operatorBoard, lang) };
  return null;
}

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

function SignOut({ lang }: { lang: Lang }) {
  return (
    <form action={signOutAction}>
      <button type="submit" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-ink-700 hover:bg-cream-100">
        <Icon name="log-out" size={16} />
        {tr(UI.signOut, lang)}
      </button>
    </form>
  );
}

/** Wide screens: "Account ▾" with the grouped menu, or "Sign in" for guests. */
export function AccountDropdown({ lang, user, roles, balancePaise, extraLinks, params = {} }: AccountNavProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }

  if (!user) {
    return (
      <Link
        href="/signin"
        data-testid="account-signin"
        className="flex h-11 items-center whitespace-nowrap rounded-xl bg-kesari-700 px-3 text-sm font-bold text-white hover:bg-kesari-800"
      >
        <span className="lg:hidden">{tr(UI.signIn, lang)}</span>
        <span className="max-lg:hidden">{tr(HOME.signInOrCreate, lang)}</span>
      </Link>
    );
  }

  const groups = accountGroups(lang, user.role, params);
  const board = boardLink(user.role, lang);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        data-testid="account-dropdown"
        className="flex h-11 items-center gap-2 rounded-xl px-1.5 hover:bg-kesari-50 lg:pr-2.5"
      >
        <span className="grid h-9 w-9 place-items-center rounded-full bg-kesari-700 text-sm font-bold text-white">{(user.name ?? user.email).charAt(0).toUpperCase()}</span>
        <span className="hidden flex-col text-left leading-tight lg:flex">
          <span className="text-xs text-ink-600">{tr(HOME.account, lang)}</span>
          <span className="max-w-[8rem] truncate text-sm font-semibold text-ink-900">{user.name ?? user.email}</span>
        </span>
        <Icon name="chevron-down" size={14} className={clsx("hidden text-kesari-700 transition-transform lg:block", open && "rotate-180")} />
      </button>
      {open ? (
        <div
          data-testid="account-dropdown-menu"
          className="absolute right-0 top-full z-50 mt-1 max-h-[80vh] w-[34rem] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-2xl border border-cream-200 bg-white p-3 shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-cream-200 px-1 pb-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink-900">{user.name ?? tr(UI.myProfile, lang)}</span>
              <span className="block truncate text-xs text-ink-600">{user.email}</span>
            </span>
            {balancePaise !== null ? (
              <Link href="/wallet" className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-kesari-50 px-3 text-sm font-bold tabular-nums text-kesari-800 hover:bg-kesari-100">
                <Icon name="wallet" size={16} />
                {formatRupees(balancePaise)}
              </Link>
            ) : null}
          </div>
          {roles.length > 1 ? (
            <div className="mb-2 flex items-center justify-between gap-2 border-b border-cream-200 px-1 pb-2 text-xs text-ink-600">
              {tr(UI.actingAs, lang)}
              <RoleSwitcher active={user.role} roles={roles} />
            </div>
          ) : null}
          {board ? (
            <Link href={board.href} className="mb-2 flex min-h-11 items-center gap-2 rounded-lg bg-kesari-50 px-3 text-sm font-bold text-kesari-800 hover:bg-kesari-100">
              <Icon name="layout-grid" size={16} />
              {board.label}
            </Link>
          ) : null}
          <nav aria-label={tr(HOME.account, lang)} className="grid grid-cols-2 gap-x-3 gap-y-2">
            {groups.map((g) => (
              <section key={g.key} data-testid="account-group" data-key={g.key}>
                <h3 className="flex items-center gap-1.5 px-1 pb-0.5 text-xs font-bold uppercase tracking-wide text-ink-600">
                  <Icon name={g.icon} size={14} className="text-kesari-700" />
                  {g.label}
                </h3>
                <ul>
                  {g.links.map((l) => (
                    <li key={`${g.key}-${l.href}-${l.label}`}>
                      <Link href={l.href} className="flex min-h-10 items-center rounded-lg px-2 text-sm text-ink-800 hover:bg-cream-100">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>
          {extraLinks.length > 0 ? (
            <ul className="mt-2 border-t border-cream-200 pt-2">
              {extraLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="flex min-h-10 items-center rounded-lg px-2 text-sm text-ink-800 hover:bg-cream-100">
                    {EXTRA_LINK_LABELS[l.href] ? tr(EXTRA_LINK_LABELS[l.href], lang) : l.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2 border-t border-cream-200 pt-1">
            <SignOut lang={lang} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Phones: the ☰ button and the side drawer it opens. */
export function AccountDrawer({ lang, user, roles, balancePaise, extraLinks, params = {} }: AccountNavProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  const explore: { href: string; label: string; icon: IconName }[] = [
    { href: "/", label: tr(HOME.home, lang), icon: "house" },
    { href: "/categories", label: tr(HOME.categories, lang), icon: "layout-grid" },
    { href: "/shops", label: tr(HOME.shopsNearYou, lang), icon: "store" },
    { href: "/search/compare", label: tr(HOME.compare, lang), icon: "scale" },
  ];
  const groups = user ? accountGroups(lang, user.role, params) : [];
  const board = user ? boardLink(user.role, lang) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={tr(HOME.openMenu, lang)}
        aria-expanded={open}
        aria-controls="account-drawer"
        data-testid="drawer-open"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-ink-900 hover:bg-kesari-50 lg:hidden"
      >
        <Icon name="menu" size={24} />
      </button>
      {/* In a portal: the sticky header is its own stacking context, which would keep the drawer under the bottom navigation. */}
      {open ? createPortal(
        <div className="fixed inset-0 z-[60] lg:hidden" data-testid="account-drawer-layer">
          <button type="button" tabIndex={-1} aria-label={tr(HOME.closeMenu, lang)} onClick={() => setOpen(false)} className="absolute inset-0 bg-ink-900/40" />
          <div
            id="account-drawer"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={tr(HOME.mainNav, lang)}
            data-testid="account-drawer"
            className="absolute inset-y-0 left-0 flex w-[min(20rem,86vw)] flex-col overflow-y-auto bg-white pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2 border-b border-cream-200 px-3 py-2">
              {user ? (
                <span className="flex min-w-0 items-center gap-2">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-kesari-700 font-bold text-white">{(user.name ?? user.email).charAt(0).toUpperCase()}</span>
                  <span className="min-w-0 leading-tight">
                    <span className="block truncate text-sm font-bold text-ink-900">{user.name ?? tr(UI.myProfile, lang)}</span>
                    <span className="block truncate text-xs text-ink-600">{user.email}</span>
                  </span>
                </span>
              ) : (
                <span className="text-base font-bold text-ink-900">GoKesari</span>
              )}
              <button type="button" onClick={() => setOpen(false)} aria-label={tr(HOME.closeMenu, lang)} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-ink-700 hover:bg-cream-100">
                <Icon name="x" size={22} />
              </button>
            </div>

            {user ? (
              <div className="space-y-1 border-b border-cream-200 px-3 py-2">
                {balancePaise !== null ? (
                  <Link href="/wallet" className="flex min-h-11 items-center justify-between rounded-xl bg-kesari-50 px-3 text-sm font-bold text-kesari-800">
                    <span className="flex items-center gap-2">
                      <Icon name="wallet" size={18} />
                      {tr(UI.walletBalance, lang)}
                    </span>
                    <span className="tabular-nums">{formatRupees(balancePaise)}</span>
                  </Link>
                ) : null}
                {roles.length > 1 ? (
                  <div className="flex min-h-11 items-center justify-between gap-2 px-1 text-xs text-ink-600">
                    {tr(UI.actingAs, lang)}
                    <RoleSwitcher active={user.role} roles={roles} />
                  </div>
                ) : null}
                {board ? (
                  <Link href={board.href} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-kesari-800 hover:bg-kesari-50">
                    <Icon name="layout-grid" size={18} />
                    {board.label}
                  </Link>
                ) : null}
              </div>
            ) : (
              <div className="border-b border-cream-200 px-3 py-3">
                <p className="mb-2 text-sm text-ink-700">{tr(HOME.signInPitch, lang)}</p>
                <Link href="/signin" data-testid="drawer-signin" className="flex h-12 items-center justify-center rounded-xl bg-kesari-700 text-base font-bold text-white hover:bg-kesari-800">
                  {tr(HOME.signInOrCreate, lang)}
                </Link>
              </div>
            )}

            <nav aria-label={tr(HOME.explore, lang)} className="border-b border-cream-200 px-3 py-2">
              <ul>
                {explore.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} aria-current={pathname === l.href ? "page" : undefined} className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm font-semibold text-ink-900 hover:bg-cream-100">
                      <Icon name={l.icon} size={18} className="text-kesari-700" />
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            {groups.length > 0 ? (
              <nav aria-label={tr(HOME.account, lang)} className="border-b border-cream-200 px-3 py-1">
                {groups.map((g) => (
                  <details key={g.key} className="group" data-testid="drawer-group" data-key={g.key}>
                    <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-xl px-2 text-sm font-bold text-ink-900 hover:bg-cream-100 [&::-webkit-details-marker]:hidden">
                      <Icon name={g.icon} size={18} className="text-kesari-700" />
                      <span className="flex-1">{g.label}</span>
                      <Icon name="chevron-down" size={16} className="text-ink-600 transition-transform group-open:rotate-180" />
                    </summary>
                    <ul className="pb-1 pl-9">
                      {g.links.map((l) => (
                        <li key={`${g.key}-${l.href}-${l.label}`}>
                          <Link href={l.href} className="flex min-h-11 items-center rounded-lg px-2 text-sm text-ink-800 hover:bg-cream-100">
                            {l.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
                {extraLinks.map((l) => (
                  <Link key={l.href} href={l.href} className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm font-semibold text-ink-900 hover:bg-cream-100">
                    <Icon name="gift" size={18} className="text-kesari-700" />
                    {EXTRA_LINK_LABELS[l.href] ? tr(EXTRA_LINK_LABELS[l.href], lang) : l.label}
                  </Link>
                ))}
              </nav>
            ) : null}

            <nav aria-label={tr(HOME.footerMakeMoney, lang)} className="border-b border-cream-200 px-3 py-2">
              <Link href="/sell" className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm font-semibold text-ink-900 hover:bg-cream-100">
                <Icon name="store" size={18} className="text-kesari-700" />
                {tr(HOME.sellOnGoKesari, lang)}
              </Link>
              <Link href="/delivery-partner/apply" className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm font-semibold text-ink-900 hover:bg-cream-100">
                <Icon name="bike" size={18} className="text-kesari-700" />
                {tr(HOME.becomeDeliveryPartner, lang)}
              </Link>
              <Link href="/contact" className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm font-semibold text-ink-900 hover:bg-cream-100">
                <Icon name="circle-help" size={18} className="text-kesari-700" />
                {tr(HOME.help, lang)}
              </Link>
            </nav>

            <div className="flex items-center justify-between gap-2 px-3 py-3">
              <span className="text-sm font-semibold text-ink-700">{tr(UI.language, lang)}</span>
              <form action={setLanguageAction} data-testid="drawer-language">
                <fieldset className="flex h-11 items-stretch overflow-hidden rounded-full border border-[#f2c9a5] bg-white">
                  <legend className="sr-only">{tr(UI.language, lang)}</legend>
                  {LANGUAGES.map((code) => (
                    <button
                      key={code}
                      type="submit"
                      name="lang"
                      value={code}
                      aria-pressed={code === lang}
                      lang={code}
                      aria-label={LANG_NAME[code]}
                      className={clsx("min-w-12 px-2.5 text-sm font-bold", code === lang ? "bg-kesari-700 text-white" : "text-ink-700 hover:bg-kesari-50")}
                    >
                      {LANG_SWITCH_LABEL[code]}
                    </button>
                  ))}
                </fieldset>
              </form>
            </div>
            {user ? (
              <div className="mt-auto border-t border-cream-200 px-3 py-2">
                <SignOut lang={lang} />
              </div>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
