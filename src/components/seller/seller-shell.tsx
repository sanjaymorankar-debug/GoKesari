"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

import { LanguageSwitch } from "@/components/board/board-header";
import { Icon } from "@/components/board/icons";
import { CountBadge, TONE_ICON } from "@/components/board/tiles";
import { RoleSwitcher } from "@/components/role-switcher";
import { StandaloneBackButton } from "@/components/standalone-back-button";
import { LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";
import type { Counts, ResolvedMenu } from "@/lib/board/menus";
import { SELLER_TEXT, shopStatusPill, type ResolvedSellerGroup } from "@/lib/seller/nav";
import type { UserRole } from "@/server/db/schema";
import { signOutAction } from "@/server/sign-out-action";

interface Props {
  lang: Lang;
  user: { name: string | null; email: string; role: UserRole } | null;
  roles: UserRole[];
  unreadCount: number;
  /** The owner's shop; null for a visitor or someone still registering (no sidebar then). */
  shop: { name: string; slug: string; status: string } | null;
  groups: ResolvedSellerGroup[];
  counts: Counts;
  children: ReactNode;
}

const HOME = "/shop";

/** The path part of a link (no query, no hash). */
function pathOf(href: string): string {
  return href.split(/[?#]/)[0];
}

/** How closely a link's path matches the page: longer wins, 0 is no match. */
function matchScore(href: string, pathname: string): number {
  const path = pathOf(href);
  if (path === HOME) return pathname === HOME ? path.length : 0;
  if (pathname === path || pathname.startsWith(`${path}/`)) return path.length;
  return 0;
}

/** The menu the current page belongs to: its own link, or one of its submenus, matches best. */
function activeMenuKey(groups: ResolvedSellerGroup[], pathname: string): string | null {
  let best: { key: string; score: number } | null = null;
  for (const g of groups) {
    for (const m of g.menus) {
      for (const href of [m.href, ...m.items.map((i) => i.href), ...m.more.map((i) => i.href)]) {
        const score = matchScore(href, pathname);
        if (score > 0 && (!best || score > best.score)) best = { key: m.key, score };
      }
    }
  }
  return best?.key ?? null;
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
 * GoKesari Seller Central: the shop owner's own portal, apart from the
 * shopping site (modelled on Amazon Seller Central). Every page under /shop
 * renders inside it:
 *  - a dark seller top bar — Seller Central home, the shop and its status,
 *    the public store page, language, notifications and the account menu;
 *  - a sidebar of every seller tool, grouped by job (Orders, Catalogue,
 *    Payments, Growth, Account) with live badges and a "Find a tool" search.
 *    On phones it is a drawer behind the menu button.
 * The site's shopping header (cart, deliver-to, wallet) and footer step aside
 * while it is on screen (globals.css, `[data-seller-central]`).
 */
export function SellerShell({ lang, user, roles, unreadCount, shop, groups, counts, children }: Props) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const closeAccount = useCallback(() => setAccountOpen(false), []);
  useDismiss(accountRef, accountOpen, closeAccount);

  // Close the drawer and menus on navigation (render-time sync, not an effect).
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setDrawerOpen(false);
    setAccountOpen(false);
  }

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    // The page behind the drawer does not scroll while it is open.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [drawerOpen]);

  const withNav = shop !== null && groups.length > 0;
  const pill = shop ? shopStatusPill(shop.status) : null;
  const storeHref = shop?.status === "APPROVED" ? `/shops/${shop.slug}` : null;

  return (
    <div data-seller-central lang={LANG_TAG[lang]} className="flex min-h-[100svh] flex-col bg-slate-100 text-ink-900">
      <header className="sticky top-0 z-40 bg-ink-900 text-white shadow-sm" data-testid="seller-topbar">
        <div className="flex h-14 items-center gap-1.5 px-2 sm:gap-2 sm:px-4 lg:h-16 lg:px-6">
          {withNav ? (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg hover:bg-white/10 lg:hidden"
              aria-label={tr(SELLER_TEXT.openMenu, lang)}
              aria-expanded={drawerOpen}
              aria-controls="seller-drawer"
              data-testid="seller-menu-button"
            >
              <MenuIcon />
            </button>
          ) : null}
          <StandaloneBackButton />
          <Link href={HOME} className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg py-1 pr-1" aria-label={`GoKesari ${tr(SELLER_TEXT.sellerCentral, lang)}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/gk-mark.png" alt="" width={62} height={36} className="h-8 w-auto rounded-md bg-white p-0.5 lg:h-9" />
            <span className="hidden flex-col leading-tight min-[400px]:flex">
              <span className="text-base font-bold">
                Go<span className="text-kesari-300">Kesari</span>
              </span>
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">{tr(SELLER_TEXT.sellerCentral, lang)}</span>
            </span>
          </Link>

          {shop && pill ? (
            <div className="ml-1 hidden min-w-0 items-center gap-2 border-l border-white/20 pl-3 md:flex" data-testid="seller-shop">
              <Icon name="store" size={18} className="shrink-0 text-kesari-300" />
              <span className="truncate text-sm font-semibold">{shop.name}</span>
              <span className={clsx("shrink-0 rounded-full px-2 py-0.5 text-xs font-bold", pill.className)}>{tr(pill.label, lang)}</span>
            </div>
          ) : null}

          <span className="flex-1" />

          <span className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            {storeHref ? (
              <Link
                href={storeHref}
                className="hidden h-10 items-center gap-1.5 rounded-lg border border-white/25 px-3 text-sm font-semibold hover:bg-white/10 lg:flex"
                data-testid="seller-visit-store"
              >
                <Icon name="store" size={16} />
                {tr(SELLER_TEXT.visitStore, lang)}
              </Link>
            ) : null}

            <LanguageSwitch lang={lang} />

            {user ? (
              <Link
                href="/profile?tab=notifications"
                className="relative grid h-11 w-11 place-items-center rounded-lg hover:bg-white/10"
                aria-label={`${tr(UI.notifications, lang)}${unreadCount > 0 ? `, ${unreadCount} ${tr(UI.unread, lang)}` : ""}`}
                data-testid="seller-bell"
              >
                <Icon name="bell" size={22} />
                {unreadCount > 0 ? (
                  <span className="absolute right-0.5 top-0.5 grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-red-600 px-1 text-xs font-bold text-white ring-2 ring-ink-900">
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
                  data-testid="seller-account-button"
                  className="grid h-11 w-11 place-items-center rounded-full hover:bg-white/10"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-kesari-600 text-sm font-bold text-white">
                    {(user.name ?? user.email).charAt(0).toUpperCase()}
                  </span>
                </button>
                {accountOpen ? (
                  <div
                    role="menu"
                    data-testid="seller-account-menu"
                    className="absolute right-0 top-full z-50 mt-1 max-h-[80vh] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 text-ink-900 shadow-xl"
                  >
                    <div className="border-b border-slate-200 px-3 pb-2 pt-1.5">
                      <p className="truncate text-sm font-semibold">{user.name ?? tr(UI.myProfile, lang)}</p>
                      <p className="truncate text-sm text-ink-600">{user.email}</p>
                      {shop ? <p className="mt-1 truncate text-sm font-medium text-kesari-800">{shop.name}</p> : null}
                    </div>
                    {roles.length > 1 ? (
                      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 text-sm text-ink-600">
                        {tr(UI.actingAs, lang)}
                        <RoleSwitcher active={user.role} roles={roles} />
                      </div>
                    ) : null}
                    <div className="py-1">
                      <MenuLink href={HOME} icon="layout-grid" label={tr(SELLER_TEXT.sellerCentral, lang)} strong />
                      {storeHref ? <MenuLink href={storeHref} icon="store" label={tr(SELLER_TEXT.visitStore, lang)} /> : null}
                      <MenuLink href="/profile" icon="user" label={tr(UI.myProfile, lang)} />
                      <MenuLink href="/contact" icon="life-buoy" label={tr(SELLER_TEXT.help, lang)} />
                      <MenuLink href="/legal/seller-terms" icon="scroll-text" label={tr(SELLER_TEXT.sellerTerms, lang)} />
                      <MenuLink href="/" icon="shopping-cart" label={tr(SELLER_TEXT.shopOnGoKesari, lang)} />
                    </div>
                    <form action={signOutAction} className="border-t border-slate-200 pt-1">
                      <button type="submit" role="menuitem" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-ink-700 hover:bg-slate-100">
                        <Icon name="log-out" size={16} />
                        {tr(UI.signOut, lang)}
                      </button>
                    </form>
                  </div>
                ) : null}
              </div>
            ) : (
              <Link href="/signin" className="flex h-11 items-center whitespace-nowrap rounded-lg bg-kesari-600 px-3 text-sm font-bold text-white hover:bg-kesari-700">
                {tr(UI.signIn, lang)}
              </Link>
            )}
          </span>
        </div>
        {shop && pill ? (
          // Phones: the shop and its status on a slim second line.
          <div className="flex items-center gap-2 border-t border-white/10 px-3 py-1.5 text-sm md:hidden">
            <Icon name="store" size={16} className="shrink-0 text-kesari-300" />
            <span className="min-w-0 truncate font-semibold">{shop.name}</span>
            <span className={clsx("ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-bold", pill.className)}>{tr(pill.label, lang)}</span>
          </div>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        {withNav ? (
          // The white column runs the full page height; the menu inside stays in view while the page scrolls.
          <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block xl:w-72" data-testid="seller-sidebar">
            <div className="sticky top-16 h-[calc(100svh-4rem)] overflow-y-auto">
              <SellerNav lang={lang} groups={groups} counts={counts} pathname={pathname} />
            </div>
          </aside>
        ) : null}

        {withNav && drawerOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden" id="seller-drawer" role="dialog" aria-modal="true" aria-label={tr(SELLER_TEXT.sellerMenu, lang)}>
            <button type="button" className="absolute inset-0 bg-ink-900/50" aria-label={tr(SELLER_TEXT.closeMenu, lang)} onClick={() => setDrawerOpen(false)} />
            <div className="absolute inset-y-0 left-0 flex w-80 max-w-[86vw] flex-col bg-white shadow-2xl" data-testid="seller-drawer">
              <div className="flex h-14 shrink-0 items-center justify-between bg-ink-900 px-3 text-white">
                <span className="text-sm font-bold uppercase tracking-wider">{tr(SELLER_TEXT.sellerCentral, lang)}</span>
                <button type="button" onClick={() => setDrawerOpen(false)} className="grid h-11 w-11 place-items-center rounded-lg hover:bg-white/10" aria-label={tr(SELLER_TEXT.closeMenu, lang)}>
                  <Icon name="x" size={22} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SellerNav lang={lang} groups={groups} counts={counts} pathname={pathname} />
              </div>
            </div>
          </div>
        ) : null}

        <div className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7" data-testid="seller-content" data-seller-content>
          <div className={clsx("mx-auto w-full", withNav ? "max-w-6xl" : "max-w-5xl")}>{children}</div>
        </div>
      </div>
    </div>
  );
}

function MenuLink({ href, icon, label, strong }: { href: string; icon: Parameters<typeof Icon>[0]["name"]; label: string; strong?: boolean }) {
  return (
    <Link
      href={href}
      role="menuitem"
      className={clsx("flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm hover:bg-slate-100", strong ? "font-bold text-kesari-800" : "text-ink-700")}
    >
      <Icon name={icon} size={16} />
      {label}
    </Link>
  );
}

function MenuIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

interface ToolHit {
  key: string;
  href: string;
  label: string;
  context: string | null;
}

/** Every tool, flat, for "Find a tool": each menu, then its submenus labelled with the menu's name. */
function allTools(groups: ResolvedSellerGroup[], lang: Lang): (ToolHit & { haystack: string })[] {
  const out: (ToolHit & { haystack: string })[] = [];
  const seen = new Set<string>();
  const push = (hit: ToolHit, words: string[]) => {
    if (seen.has(hit.href)) return;
    seen.add(hit.href);
    out.push({ ...hit, haystack: words.join(" ").toLowerCase() });
  };
  for (const g of groups) {
    for (const m of g.menus) {
      const menuLabel = tr(m.label, lang);
      push({ key: m.key, href: m.href, label: menuLabel, context: tr(g.label, lang) }, [menuLabel, m.label.en, tr(g.label, lang)]);
      for (const item of [...m.items, ...m.more]) {
        const label = tr(item.label, lang);
        push({ key: `${m.key}.${item.key}`, href: item.href, label, context: menuLabel }, [label, item.label.en, menuLabel, m.label.en]);
      }
    }
  }
  return out;
}

/** The sidebar: Home, "Find a tool", then each group's menus; the open page's menu shows its submenus. */
function SellerNav({
  lang,
  groups,
  counts,
  pathname,
}: {
  lang: Lang;
  groups: ResolvedSellerGroup[];
  counts: Counts;
  pathname: string;
}) {
  const [query, setQuery] = useState("");
  const active = activeMenuKey(groups, pathname);
  const tools = useMemo(() => allTools(groups, lang), [groups, lang]);
  const q = query.trim().toLowerCase();
  const hits = q ? tools.filter((t) => t.haystack.includes(q)).slice(0, 12) : [];

  return (
    <nav aria-label={tr(SELLER_TEXT.sellerMenu, lang)} className="flex flex-col gap-1 p-3" data-testid="seller-nav">
      <label className="mb-1 flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-2.5 focus-within:border-kesari-600 focus-within:bg-white">
        <Icon name="search" size={16} className="shrink-0 text-ink-500" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr(SELLER_TEXT.findTool, lang)}
          aria-label={tr(SELLER_TEXT.findToolLabel, lang)}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none"
          data-testid="seller-find-tool"
        />
      </label>

      {q ? (
        hits.length > 0 ? (
          <ul className="flex flex-col gap-0.5" data-testid="seller-tool-hits">
            {hits.map((hit) => (
              <li key={hit.key}>
                <Link href={hit.href} className="flex min-h-11 flex-col justify-center rounded-lg px-3 py-1.5 hover:bg-kesari-50">
                  <span className="text-sm font-semibold text-ink-900">{hit.label}</span>
                  {hit.context ? <span className="text-xs text-ink-500">{hit.context}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-2 text-sm text-ink-500">{tr(SELLER_TEXT.noToolFound, lang)}</p>
        )
      ) : (
        <>
          <NavLink href={HOME} current={pathname === HOME} icon="layout-grid" label={tr(SELLER_TEXT.home, lang)} />
          {groups.map((g) => (
            <section key={g.key} className="mt-3" aria-labelledby={`seller-group-${g.key}`}>
              <h2 id={`seller-group-${g.key}`} className="mb-1 px-3 text-xs font-bold uppercase tracking-wider text-ink-500">
                {tr(g.label, lang)}
              </h2>
              <ul className="flex flex-col gap-0.5">
                {g.menus.map((m) => (
                  <li key={m.key}>
                    <MenuEntry lang={lang} menu={m} counts={counts} open={active === m.key} pathname={pathname} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </nav>
  );
}

function NavLink({ href, current, icon, label }: { href: string; current: boolean; icon: Parameters<typeof Icon>[0]["name"]; label: string }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={clsx(
        "flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm font-semibold",
        current ? "bg-kesari-50 text-kesari-800" : "text-ink-700 hover:bg-slate-100",
      )}
    >
      <Icon name={icon} size={18} className={current ? "text-kesari-700" : "text-ink-500"} />
      {label}
    </Link>
  );
}

function MenuEntry({ lang, menu, counts, open, pathname }: { lang: Lang; menu: ResolvedMenu; counts: Counts; open: boolean; pathname: string }) {
  const value = menu.count ? counts[menu.count] : undefined;
  const subs = [...menu.items, ...menu.more];
  return (
    <>
      <Link
        href={menu.href}
        aria-current={open && pathOf(menu.href) === pathname ? "page" : undefined}
        data-testid="seller-nav-menu"
        data-key={menu.key}
        className={clsx(
          "flex min-h-11 items-center gap-2.5 rounded-lg border-l-4 px-2.5 text-sm font-semibold",
          open ? "border-kesari-600 bg-kesari-50 text-ink-900" : "border-transparent text-ink-700 hover:bg-slate-100",
        )}
      >
        <Icon name={menu.icon ?? "store"} size={18} className={clsx("shrink-0", TONE_ICON[menu.tone])} />
        <span className="min-w-0 flex-1 truncate">{tr(menu.label, lang)}</span>
        <CountBadge value={value} tone={menu.urgent ? "alert" : "accent"} />
      </Link>
      {open && subs.length > 0 ? (
        <ul className="mb-1 ml-6 mt-0.5 flex flex-col border-l border-slate-200 pl-2" data-testid="seller-nav-subs">
          {subs.map((item) => {
            const n = item.count ? counts[item.count] : undefined;
            const here = pathOf(item.href) === pathname && !item.href.includes("?") && !item.href.includes("#");
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  aria-current={here ? "page" : undefined}
                  className={clsx(
                    "flex min-h-10 items-center gap-2 rounded-md px-2.5 text-sm",
                    here ? "font-semibold text-kesari-800" : "text-ink-600 hover:bg-slate-100 hover:text-ink-900",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{tr(item.label, lang)}</span>
                  <CountBadge value={n} tone={item.urgent ? "alert" : "soft"} />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
