"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { DeliverToPill, LocationPanel, OPEN_LOCATION_EVENT } from "@/components/location-picker";
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
  /** The chosen delivery location as the pill shows it, or null when none is chosen. */
  locationLabel: string | null;
  /** The signed-in user's saved addresses, offered in the location chooser. */
  savedAddresses: { id: string; label: string }[];
}

/** The main row. Wallet has its own balance pill; the rest sit in the account menu. */
const NAV = [
  { href: "/shops", label: "Shops" },
  { href: "/orders", label: "Orders" },
  { href: "/subscriptions", label: "Subscriptions" },
];

/** Account destinations: the avatar menu on wide screens, the drawer on narrow ones. */
const ACCOUNT_NAV = [
  { href: "/profile", label: "My Profile" },
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
    { href: "/shop/disputes", label: "Disputes" },
    { href: "/shop/inventory", label: "Inventory" },
    { href: "/shop/catalogue", label: "Photo catalogue" },
    { href: "/shop/product-categories", label: "My product categories" },
    { href: "/product-categories", label: "All product categories" },
    { href: "/shop/prices", label: "Price Updates" },
    { href: "/shop/finance", label: "Finance" },
    { href: "/shop/wallet", label: "Wallet" },
    { href: "/shop/marketing", label: "Marketing" },
    { href: "/shop/offers", label: "Offers" },
    { href: "/shop/analytics", label: "Analytics" },
  ],
  OPERATOR: [
    { href: "/admin", label: "Operator Console" },
    { href: "/admin/dashboard", label: "Dashboard" },
    { href: "/admin/orders", label: "Order monitoring" },
    { href: "/admin/exceptions", label: "Operations exceptions" },
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
    { href: "/admin/dashboard", label: "Dashboard" },
    { href: "/admin/orders", label: "Order monitoring" },
    { href: "/admin/exceptions", label: "Operations exceptions" },
    { href: "/admin/shops", label: "Shop Product Management" },
    { href: "/admin/product-master", label: "Product Master" },
    { href: "/product-categories", label: "Product categories" },
    { href: "/admin/shop-categories", label: "Shop categories" },
    { href: "/admin/mrp", label: "MRP" },
    { href: "/admin/price-references", label: "Reference prices" },
    { href: "/admin/finance", label: "Finance" },
    { href: "/admin/shop-wallets", label: "Shop wallets" },
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
    { href: "/admin/rider-kyc", label: "Rider documents" },
    { href: "/admin/customer-referrals", label: "Customer referrals" },
    { href: "/admin/status-changes", label: "Status history" },
    { href: "/admin/subscriptions", label: "Subscriptions" },
  ],
  DELIVERY_PARTNER: [
    { href: "/delivery-partner", label: "Delivery Partner" },
    { href: "/gig/orders", label: "My deliveries" },
    { href: "/gig/profile", label: "My delivery profile" },
    { href: "/gig/id-card", label: "My ID card" },
  ],
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

/** Site-wide search: products, shops, area or PIN code. Enter submits. */
function HeaderSearch({ className }: { className?: string }) {
  return (
    <form action="/search" role="search" className={className}>
      <input
        type="search"
        name="q"
        placeholder="Search products, shops, area or PIN code"
        aria-label="Search products, shops, area or PIN code"
        className="w-full rounded-xl border border-cream-200 bg-cream-50 px-3 py-2 text-sm placeholder:text-ink-500 focus:border-kesari-500 focus:outline-none"
      />
    </form>
  );
}

/**
 * Header per requirement §6: logo, "Deliver to", search, the three customer
 * destinations, wallet balance, cart and the account menu. Below `lg` the
 * links move into a drawer (§52) and the search takes a row of its own.
 */
export function SiteHeader({
  user,
  roles = [],
  cartCount,
  balancePaise,
  unreadCount,
  locationLabel,
  savedAddresses,
}: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  useDismiss(accountRef, accountOpen, () => setAccountOpen(false));

  // Close everything on navigation (render-time sync, not an effect).
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setOpen(false);
    setAccountOpen(false);
    setLocationOpen(false);
  }

  // "Change location" links elsewhere on the page open the chooser here.
  useEffect(() => {
    const openLocation = () => {
      setOpen(false);
      setLocationOpen(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener(OPEN_LOCATION_EVENT, openLocation);
    return () => window.removeEventListener(OPEN_LOCATION_EVENT, openLocation);
  }, []);

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
  const roleItems = user ? (ROLE_NAV[user.role] ?? []) : [];

  return (
    <header className="sticky top-0 z-40 border-b border-cream-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
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

        <DeliverToPill
          label={locationLabel}
          open={locationOpen}
          onToggle={() => {
            setOpen(false);
            setLocationOpen((v) => !v);
          }}
        />

        {/* One search box: in the row from md up, on a row of its own below. */}
        <HeaderSearch className="order-last min-w-0 basis-full md:order-none md:min-w-[10rem] md:flex-1 md:basis-0" />

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
          {roleItems.length > 0 && user ? (
            <NavMenu
              label={ROLE_MENU_LABEL[user.role] ?? "Menu"}
              items={roleItems}
              pathname={pathname}
              emphasis
            />
          ) : null}
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname.startsWith(item.href) ? "page" : undefined}
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

        {/* Tap areas sit 4px low: inside the header on one row, and clear of
            the logo when a narrow screen wraps this to a second. */}
        <div className="ml-auto flex shrink-0 items-center gap-2 md:ml-0 [--tap-dy:4px]">
          {balancePaise !== null ? (
            <Link
              href="/wallet"
              // The same pill on every page: one balance, one colour.
              className="tap-target rounded-lg bg-kesari-50 px-2.5 py-1.5 text-sm font-semibold tabular-nums text-kesari-700 hover:bg-kesari-100 [--tap-w:44px]"
              aria-label={`Wallet balance ${formatPaiseCompact(balancePaise)}`}
              data-testid="header-wallet"
            >
              {formatPaiseCompact(balancePaise)}
            </Link>
          ) : null}

          <Link
            href="/cart"
            className="tap-target flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-ink-700 hover:bg-cream-100 [--tap-w:44px]"
            aria-label={`Cart, ${cartCount} items`}
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
              <path
                d="M2 3h2.2l2 9.2a1 1 0 0 0 1 .8h7.3a1 1 0 0 0 1-.8L17 6H5.2"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="8" cy="16.2" r="1.2" fill="currentColor" />
              <circle cx="14.2" cy="16.2" r="1.2" fill="currentColor" />
            </svg>
            <span className="hidden sm:inline">Cart</span>
            {cartCount > 0 ? (
              <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-kesari-600 px-1 text-[10px] font-bold text-white">
                {cartCount}
              </span>
            ) : null}
          </Link>

          {user ? (
            <div ref={accountRef} className="relative">
              <button
                type="button"
                onClick={() => setAccountOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                aria-label="Account menu"
                className="tap-target flex items-center gap-1 rounded-full p-0.5 pr-1 hover:bg-cream-100 [--tap-w:44px]"
              >
                <span className="relative grid h-8 w-8 place-items-center rounded-full bg-kesari-100 text-sm font-semibold text-kesari-700">
                  {(user.name ?? user.email).charAt(0).toUpperCase()}
                  {unreadCount > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />
                  ) : null}
                </span>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={clsx("text-ink-600 transition-transform", accountOpen && "rotate-180")}>
                  <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                </svg>
              </button>
              {accountOpen ? (
                <div
                  role="menu"
                  data-testid="account-menu"
                  className="absolute right-0 top-full z-50 mt-1 w-60 max-w-[calc(100vw-1.5rem)] rounded-xl border border-cream-200 bg-white p-1.5 shadow-lg"
                >
                  <div className="border-b border-cream-200 px-3 pb-2 pt-1.5">
                    <p className="truncate text-sm font-semibold text-ink-900">{user.name ?? "My account"}</p>
                    <p className="truncate text-xs text-ink-500">{user.email}</p>
                  </div>
                  {roles.length > 1 ? (
                    <div className="flex items-center justify-between gap-2 border-b border-cream-200 px-3 py-2 text-xs text-ink-500">
                      Acting as
                      <RoleSwitcher active={user.role} roles={roles} />
                    </div>
                  ) : null}
                  <div className="py-1">
                    {dashboardHref ? (
                      <Link href={dashboardHref} role="menuitem" className="block rounded-lg px-3 py-2 text-sm font-medium text-kesari-700 hover:bg-cream-100">
                        Dashboard
                      </Link>
                    ) : null}
                    {ACCOUNT_NAV.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        role="menuitem"
                        className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-ink-700 hover:bg-cream-100"
                      >
                        {item.label}
                        {item.href === "/profile" && unreadCount > 0 ? (
                          <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{unreadCount}</span>
                        ) : null}
                      </Link>
                    ))}
                  </div>
                  <form action={signOutAction} className="border-t border-cream-200 pt-1">
                    <button
                      type="submit"
                      role="menuitem"
                      className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-700 hover:bg-cream-100"
                    >
                      Sign out
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
          ) : (
            <Link
              href="/signin"
              className="tap-target rounded-lg bg-kesari-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-kesari-800"
            >
              Sign in
            </Link>
          )}

          <button
            type="button"
            onClick={() => {
              setLocationOpen(false);
              setOpen((v) => !v);
            }}
            // Last item in the row: the tap area widens to the right, into the
            // page margin, and stays clear of the control to its left.
            className="tap-target rounded-lg p-1.5 text-ink-600 hover:bg-cream-100 lg:hidden [--tap-dx:8px] [--tap-w:40px]"
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

      {locationOpen ? (
        <LocationPanel
          currentLabel={locationLabel}
          savedAddresses={savedAddresses}
          onClose={() => setLocationOpen(false)}
        />
      ) : null}

      {open ? (
        <nav className="max-h-[80vh] overflow-y-auto border-t border-cream-200 bg-white px-4 py-2 lg:hidden" aria-label="Menu">
          {roleItems.length > 0 && user ? (
            <details className="mb-1" open={roleItems.some((i) => pathname.startsWith(i.href))}>
              <summary className="cursor-pointer rounded-lg px-2 py-2 text-sm font-semibold text-kesari-700 hover:bg-cream-100">
                {ROLE_MENU_LABEL[user.role] ?? "Menu"}
              </summary>
              <div className="ml-2 border-l border-cream-200 pl-2">
                {roleItems.map((item) => (
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
          {[...NAV, ...(user ? ACCOUNT_NAV : [])].map((item) => (
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
