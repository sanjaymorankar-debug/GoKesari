"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { RoleSwitcher } from "@/components/role-switcher";
import { formatPaiseCompact } from "@/lib/money";
import type { UserRole } from "@/server/db/schema";
import { signOutAction } from "@/server/sign-out-action";

interface Props {
  user: { id: string; name: string | null; email: string; role: UserRole } | null;
  /** Roles the user holds (GS-003) — a switcher appears when there are several. */
  roles?: UserRole[];
  cartCount: number;
  balancePaise: number | null;
  unreadCount: number;
}

const NAV = [
  { href: "/shops", label: "Shops" },
  { href: "/orders", label: "My Orders" },
  { href: "/subscriptions", label: "My Subscriptions" },
  { href: "/wallet", label: "My Wallet" },
  { href: "/society", label: "My Society" },
];

/**
 * Role-specific navigation (§22).
 *
 * This is convenience, not security — every destination re-checks capability
 * server-side. Hiding a link the user cannot use just keeps the header honest.
 */
const ROLE_NAV: Partial<Record<UserRole, { href: string; label: string }[]>> = {
  SHOP_OWNER: [
    { href: "/shop", label: "My Shop" },
    { href: "/shop/orders", label: "Orders" },
    { href: "/shop/returns", label: "Returns" },
    { href: "/shop/inventory", label: "Inventory" },
    { href: "/shop/product-categories", label: "My product categories" },
    { href: "/product-categories", label: "All product categories" },
    { href: "/shop/prices", label: "Price Updates" },
    { href: "/shop/finance", label: "Finance" },
    { href: "/shop/marketing", label: "Marketing" },
    { href: "/shop/offers", label: "Offers" },
    { href: "/shop/analytics", label: "Analytics" },
  ],
  OPERATOR: [
    { href: "/admin", label: "Operator Console" },
    { href: "/admin/shops", label: "Shop Product Management" },
    { href: "/admin/product-master", label: "Product Master" },
    { href: "/product-categories", label: "Product categories" },
    { href: "/admin/shop-categories", label: "Shop categories" },
    { href: "/admin/mrp", label: "MRP" },
    { href: "/admin/price-references", label: "Reference prices" },
    { href: "/admin/finance/exceptions", label: "Finance exceptions" },
    { href: "/admin/returns", label: "Returns" },
    { href: "/admin/image-moderation", label: "Image moderation" },
    { href: "/admin/suspensions", label: "Suspensions" },
    { href: "/admin/societies", label: "Societies" },
    { href: "/admin/ratings", label: "Ratings" },
    { href: "/admin/analytics", label: "Analytics" },
    { href: "/admin/campaigns", label: "Campaigns" },
    { href: "/admin/risk", label: "Risk" },
    { href: "/admin/consents", label: "Consent" },
    { href: "/admin/disputes", label: "Disputes" },
    { href: "/admin/cod", label: "COD cash" },
  ],
  ADMIN: [
    { href: "/admin", label: "Admin Console" },
    { href: "/admin/shops", label: "Shop Product Management" },
    { href: "/admin/product-master", label: "Product Master" },
    { href: "/product-categories", label: "Product categories" },
    { href: "/admin/shop-categories", label: "Shop categories" },
    { href: "/admin/mrp", label: "MRP" },
    { href: "/admin/price-references", label: "Reference prices" },
    { href: "/admin/finance", label: "Finance" },
    { href: "/admin/returns", label: "Returns" },
    { href: "/admin/suspensions", label: "Suspensions" },
    { href: "/admin/rider-earnings", label: "Rider earnings" },
    { href: "/admin/settings", label: "Business rules" },
    { href: "/admin/societies", label: "Societies" },
    { href: "/admin/ratings", label: "Ratings" },
    { href: "/admin/analytics", label: "Analytics" },
    { href: "/admin/campaigns", label: "Campaigns" },
    { href: "/admin/risk", label: "Risk" },
    { href: "/admin/consents", label: "Consent" },
    { href: "/admin/disputes", label: "Disputes" },
    { href: "/admin/cod", label: "COD cash" },
    { href: "/admin/coupons", label: "Coupons" },
    { href: "/admin/delivery-slots", label: "Delivery slots" },
    { href: "/admin/image-moderation", label: "Image moderation" },
    { href: "/admin/rider-changes", label: "Rider profile changes" },
    { href: "/admin/customer-referrals", label: "Customer referrals" },
    { href: "/admin/status-changes", label: "Status history" },
    { href: "/admin/subscriptions", label: "Subscriptions" },
  ],
  DELIVERY_PARTNER: [{ href: "/delivery-partner", label: "Delivery Partner" }],
};

/** Label for the role menu that replaces a long inline row of links. */
const ROLE_MENU_LABEL: Partial<Record<UserRole, string>> = {
  ADMIN: "Admin",
  OPERATOR: "Operator",
  SHOP_OWNER: "My Shop",
  DELIVERY_PARTNER: "Rider",
};

/**
 * A click-to-open menu. The panel is capped to the viewport width and height
 * (it scrolls inside itself), closes on outside click, Escape, or navigation —
 * so it can never run off the screen however many items it holds.
 */
function NavMenu({
  label,
  items,
  pathname,
  emphasis,
}: {
  label: string;
  items: { href: string; label: string }[];
  pathname: string;
  emphasis?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = items.some((i) => pathname.startsWith(i.href));

  // Close the menu on navigation (render-time sync, not an effect).
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-semibold transition-colors",
          active || open ? "bg-kesari-100 text-kesari-800" : emphasis ? "text-kesari-700 hover:bg-kesari-50" : "text-ink-600 hover:bg-cream-100",
        )}
      >
        {label}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={clsx("transition-transform", open && "rotate-180")}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          data-testid="nav-menu-panel"
          className="absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-cream-200 bg-white p-1.5 shadow-lg"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              className={clsx(
                "block rounded-lg px-3 py-2 text-sm",
                pathname === item.href ? "bg-kesari-50 font-semibold text-kesari-700" : "text-ink-700 hover:bg-cream-100",
              )}
            >
              {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Header per requirement §6, collapsing to a drawer on mobile (§52). */
export function SiteHeader({ user, roles = [], cartCount, balancePaise, unreadCount }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const dashboardHref =
    user?.role === "ADMIN"
      ? "/admin"
      : user?.role === "OPERATOR"
        ? "/operator"
        : user?.role === "SHOP_OWNER"
          ? "/shop"
          : user?.role === "DELIVERY_PARTNER"
            ? "/delivery-partner"
            : null;

  return (
    <header className="sticky top-0 z-40 border-b border-cream-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/gk-mark.png"
            alt="GoKesari"
            width={62}
            height={36}
            className="h-9 w-auto rounded-lg"
          />
          <span className="hidden flex-col sm:flex">
            <span className="text-lg font-bold leading-tight text-ink-900">
              Go<span className="text-kesari-600">Kesari</span>
            </span>
            <span className="text-xs font-medium leading-tight text-ink-500">Everything for Everyone</span>
          </span>
        </Link>

        <form action="/search" className="ml-2 min-w-0 max-w-xl flex-1">
          <input
            type="search"
            name="q"
            placeholder="Search products, shops, area or PIN code"
            aria-label="Search products, shops, area or PIN code"
            className="w-full rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm placeholder:text-ink-400 focus:border-kesari-500 focus:outline-none"
          />
        </form>

        <nav className="hidden items-center gap-1 xl:flex" aria-label="Main">
          {user && (ROLE_NAV[user.role] ?? []).length > 0 ? (
            <NavMenu
              label={ROLE_MENU_LABEL[user.role] ?? "Menu"}
              items={ROLE_NAV[user.role] ?? []}
              pathname={pathname}
              emphasis
            />
          ) : null}
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
                pathname.startsWith(item.href)
                  ? "bg-kesari-50 text-kesari-700"
                  : "text-ink-600 hover:bg-cream-100",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {balancePaise !== null ? (
            <Link
              href="/wallet"
              className="hidden rounded-lg bg-leaf-50 px-2.5 py-1.5 text-sm font-semibold text-leaf-700 sm:inline-block"
            >
              {formatPaiseCompact(balancePaise)}
            </Link>
          ) : null}

          <Link
            href="/cart"
            className="relative rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-600 hover:bg-cream-100"
            aria-label={`Cart, ${cartCount} items`}
          >
            Cart
            {cartCount > 0 ? (
              <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-kesari-600 px-1 text-[10px] font-bold text-white">
                {cartCount}
              </span>
            ) : null}
          </Link>

          {user ? (
            <div className="flex items-center gap-2">
              <RoleSwitcher active={user.role} roles={roles} />
              {dashboardHref ? (
                <Link
                  href={dashboardHref}
                  className="hidden rounded-lg border border-cream-200 px-2.5 py-1.5 text-sm font-medium text-ink-700 hover:bg-cream-100 md:inline-block"
                >
                  Dashboard
                </Link>
              ) : null}
              <Link
                href="/profile"
                className="relative grid h-8 w-8 place-items-center rounded-full bg-kesari-100 text-sm font-semibold text-kesari-700"
                aria-label="My Profile"
                title="My Profile"
              >
                {(user.name ?? user.email).charAt(0).toUpperCase()}
                {unreadCount > 0 ? (
                  <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />
                ) : null}
              </Link>
              {/* Every role, every page: an icon on phones, labelled from sm up. */}
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="flex items-center gap-1.5 rounded-lg border border-cream-200 p-1.5 text-sm font-medium text-ink-700 hover:bg-cream-100 sm:px-2.5"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
                    <path
                      d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M12 6l4 4-4 4M16 10H8"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="hidden whitespace-nowrap sm:inline">Sign out</span>
                </button>
              </form>
            </div>
          ) : (
            <Link
              href="/signin"
              className="rounded-lg bg-kesari-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-kesari-700"
            >
              Sign in
            </Link>
          )}

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg p-1.5 text-ink-600 hover:bg-cream-100 xl:hidden"
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
              <path
                d="M3 5h14M3 10h14M3 15h14"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {open ? (
        <nav className="max-h-[80vh] overflow-y-auto border-t border-cream-200 bg-white px-4 py-2 xl:hidden" aria-label="Menu">
          {user && (ROLE_NAV[user.role] ?? []).length > 0 ? (
            <details className="mb-1" open={(ROLE_NAV[user.role] ?? []).some((i) => pathname.startsWith(i.href))}>
              <summary className="cursor-pointer rounded-lg px-2 py-2 text-sm font-semibold text-kesari-700 hover:bg-cream-100">
                {ROLE_MENU_LABEL[user.role] ?? "Menu"}
              </summary>
              <div className="ml-2 border-l border-cream-200 pl-2">
                {(ROLE_NAV[user.role] ?? []).map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-lg px-2 py-1.5 text-sm text-ink-700 hover:bg-cream-100"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </details>
          ) : null}
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-2 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100"
            >
              {item.label}
            </Link>
          ))}
          {dashboardHref ? (
            <Link
              href={dashboardHref}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-2 py-2 text-sm font-medium text-kesari-700 hover:bg-cream-100"
            >
              Dashboard
            </Link>
          ) : null}
          {user ? (
            <form action={signOutAction} className="mt-1 border-t border-cream-200 pt-1">
              <button
                type="submit"
                className="block w-full rounded-lg px-2 py-2 text-left text-sm font-medium text-ink-700 hover:bg-cream-100"
              >
                Sign out
              </button>
            </form>
          ) : null}
        </nav>
      ) : null}
    </header>
  );
}
