"use client";

/**
 * Phones (docs/homepage-uiux-2026-10, F1/F6): the fixed bottom navigation —
 * Home · Categories · Compare · Orders · Account — and, while the cart has
 * items, a floating "View cart · N items · ₹total" bar just above it, so
 * checkout is never a scroll away.
 *
 * Shown only on the shopping pages (home, categories, shops, search, product
 * and the customer's own pages); never in Seller Central, the admin and
 * operator consoles, the rider app, sign-in or checkout, which have their
 * own bottom actions. Wide screens never show it.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

import { Icon, type IconName } from "@/components/board/icons";
import { formatRupees } from "@/lib/board/format";
import { LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";
import { HOME } from "@/lib/home-i18n";

/** Pages that get the bottom navigation (a path equal to one, or under it). */
const SHOPPING_PATHS = [
  "/categories",
  "/category",
  "/shops",
  "/search",
  "/products",
  "/orders",
  "/subscriptions",
  "/wallet",
  "/profile",
  "/society",
  "/refer",
  "/referral",
  "/returns",
  "/notifications",
  "/dairy",
  "/bakery",
  "/about",
  "/contact",
] as const;
/** Inside those, pages with their own bottom actions. */
const EXCEPT = ["/orders/payment-return", "/wallet/payment-return"] as const;

export function showsShoppingNav(pathname: string): boolean {
  if (EXCEPT.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return false;
  return pathname === "/" || SHOPPING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function MobileShopNav({
  lang,
  signedIn,
  cartCount,
  cartTotalPaise,
}: {
  lang: Lang;
  signedIn: boolean;
  cartCount: number;
  /** The cart's total as checkout would charge it; null when not known. */
  cartTotalPaise: number | null;
}) {
  const pathname = usePathname();
  if (!showsShoppingNav(pathname)) return null;

  const items: { key: string; href: string; label: string; icon: IconName; active: boolean }[] = [
    { key: "home", href: "/", label: tr(HOME.home, lang), icon: "house", active: pathname === "/" },
    { key: "categories", href: "/categories", label: tr(HOME.categories, lang), icon: "layout-grid", active: pathname.startsWith("/categor") },
    { key: "compare", href: "/search/compare", label: tr(HOME.compare, lang), icon: "scale", active: pathname.startsWith("/search/compare") },
    { key: "orders", href: signedIn ? "/orders" : "/signin", label: tr(HOME.orders, lang), icon: "package", active: pathname.startsWith("/orders") },
    { key: "account", href: signedIn ? "/profile" : "/signin", label: tr(HOME.account, lang), icon: "user", active: pathname.startsWith("/profile") },
  ];
  const showCart = cartCount > 0 && signedIn;

  return (
    <>
      {/* Keeps the page's last lines clear of the fixed bars. */}
      <div aria-hidden className={clsx("lg:hidden", showCart ? "h-[calc(8rem+env(safe-area-inset-bottom))]" : "h-[calc(4rem+env(safe-area-inset-bottom))]")} />
      <div lang={LANG_TAG[lang]} className="fixed inset-x-0 bottom-0 z-40 lg:hidden" data-testid="mobile-shop-nav">
        {showCart ? (
          <div className="px-2 pb-2">
            <Link
              href="/cart"
              data-testid="floating-cart"
              className="mx-auto flex h-14 max-w-xl items-center gap-3 rounded-2xl bg-kesari-700 px-4 text-white shadow-lg shadow-kesari-700/30 hover:bg-kesari-800"
            >
              <Icon name="shopping-cart" size={22} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-base font-bold">
                {tr(UI.viewCart, lang)} · <span className="tabular-nums">{cartCount}</span> {cartCount === 1 ? tr(UI.item, lang) : tr(UI.items, lang)}
                {cartTotalPaise !== null ? <span className="tabular-nums"> · {formatRupees(cartTotalPaise)}</span> : null}
              </span>
              <Icon name="chevron-right" size={20} className="shrink-0" />
            </Link>
          </div>
        ) : null}
        <nav aria-label={tr(HOME.mainNav, lang)} className="border-t border-[var(--gk-line)] bg-white pb-[env(safe-area-inset-bottom)]">
          <ul className="mx-auto grid h-16 max-w-xl grid-cols-5">
            {items.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  aria-current={item.active ? "page" : undefined}
                  data-testid="bottom-nav-item"
                  data-key={item.key}
                  className={clsx(
                    "flex h-full flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-semibold leading-tight",
                    item.active ? "text-kesari-800" : "text-ink-600 hover:text-ink-900",
                  )}
                >
                  <span className={clsx("grid h-7 w-12 place-items-center rounded-full", item.active && "bg-kesari-100")}>
                    <Icon name={item.icon} size={20} />
                  </span>
                  <span className="max-w-full truncate px-0.5">{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </>
  );
}
