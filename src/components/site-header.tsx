"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";

import { formatPaiseCompact } from "@/lib/money";
import type { UserRole } from "@/server/db/schema";

interface Props {
  user: { id: string; name: string | null; email: string; role: UserRole } | null;
  cartCount: number;
  balancePaise: number | null;
  unreadCount: number;
}

const NAV = [
  { href: "/categories", label: "Categories" },
  { href: "/shops", label: "Shops" },
  { href: "/orders", label: "My Orders" },
  { href: "/subscriptions", label: "My Subscriptions" },
  { href: "/wallet", label: "My Wallet" },
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
    { href: "/shop/prices", label: "Price Updates" },
    { href: "/shop/finance", label: "Finance" },
  ],
  OPERATOR: [
    { href: "/admin", label: "Operator Console" },
    { href: "/admin/shops", label: "Shop Product Management" },
    { href: "/admin/product-master", label: "Product Master" },
    { href: "/admin/finance/exceptions", label: "Finance exceptions" },
  ],
  ADMIN: [
    { href: "/admin", label: "Admin Console" },
    { href: "/admin/shops", label: "Shop Product Management" },
    { href: "/admin/product-master", label: "Product Master" },
    { href: "/admin/finance", label: "Finance" },
  ],
  DELIVERY_PARTNER: [{ href: "/delivery-partner", label: "Delivery Partner" }],
};

/** Header per requirement §6, collapsing to a drawer on mobile (§52). */
export function SiteHeader({ user, cartCount, balancePaise, unreadCount }: Props) {
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
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-kesari-600 text-lg font-bold text-white">
            N
          </span>
          <span className="hidden text-base font-semibold text-ink-900 sm:inline">
            Your Neighbourhood, Now Online
          </span>
        </Link>

        <form action="/search" className="ml-2 min-w-0 flex-1">
          <input
            type="search"
            name="q"
            placeholder="Search products, shops, area or PIN code"
            aria-label="Search products, shops, area or PIN code"
            className="w-full rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm placeholder:text-ink-400 focus:border-kesari-500 focus:outline-none"
          />
        </form>

        <nav className="hidden items-center gap-1 lg:flex">
          {(user ? (ROLE_NAV[user.role] ?? []) : []).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "rounded-lg px-2.5 py-1.5 text-sm font-semibold transition-colors",
                pathname.startsWith(item.href)
                  ? "bg-kesari-100 text-kesari-800"
                  : "text-kesari-700 hover:bg-kesari-50",
              )}
            >
              {item.label}
            </Link>
          ))}
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
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
                aria-label="Profile"
              >
                {(user.name ?? user.email).charAt(0).toUpperCase()}
                {unreadCount > 0 ? (
                  <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />
                ) : null}
              </Link>
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
            className="rounded-lg p-1.5 text-ink-600 hover:bg-cream-100 lg:hidden"
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
        <nav className="border-t border-cream-200 bg-white px-4 py-2 lg:hidden">
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
        </nav>
      ) : null}
    </header>
  );
}
