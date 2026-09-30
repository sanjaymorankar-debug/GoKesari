import type { Metadata, Viewport } from "next";

import Link from "next/link";

import { SiteHeader } from "@/components/site-header";
import { LEGAL_DOCS, LEGAL_ENTITY } from "@/lib/legal-docs";
import { getCurrentUser } from "@/server/authz/guards";
import { getCart } from "@/server/services/cart";
import { unreadCount } from "@/server/services/notifications";
import { listUserRoles } from "@/server/services/roles";
import { getWalletByUserId } from "@/server/services/wallet";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Your Neighbourhood, Now Online",
    template: "%s · Your Neighbourhood, Now Online",
  },
  description:
    "Every local shop near you, in one directory. Wallet payments and flexible daily subscriptions.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f97316",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Header state is resolved server-side so the cart count and balance are
  // always authoritative rather than optimistic client state.
  const user = await getCurrentUser();
  const [cart, wallet, unread, roles] = user
    ? await Promise.all([
        getCart(user.id).catch(() => null),
        getWalletByUserId(user.id).catch(() => null),
        unreadCount(user.id).catch(() => 0),
        // GS-003: roles the user can switch between.
        listUserRoles(user.id).catch(() => [user.role]),
      ])
    : [null, null, 0, []];

  return (
    <html lang="en">
      <body className="min-h-screen bg-cream-50">
        <SiteHeader
          user={user}
          roles={roles}
          cartCount={cart?.itemCount ?? 0}
          balancePaise={wallet?.balancePaise ?? null}
          unreadCount={unread}
        />
        <main className="mx-auto w-full max-w-[120rem] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          {children}
        </main>
        <footer className="border-t border-cream-200 bg-white">
          <div className="mx-auto max-w-[120rem] px-4 py-6 text-xs text-ink-500 sm:px-6 lg:px-8">
            <p className="mb-1">
              Your Neighbourhood, Now Online — every local shop near you, in
              one directory.
            </p>
            <p className="mb-3">
              {LEGAL_ENTITY.legalName} · GSTIN: {LEGAL_ENTITY.gstin}
            </p>
            <nav className="flex flex-wrap gap-x-4 gap-y-1">
              <Link href="/about" className="hover:text-ink-700 hover:underline">
                About Us
              </Link>
              <Link href="/contact" className="hover:text-ink-700 hover:underline">
                Contact Us
              </Link>
              <Link href="/delivery-partner/apply" className="hover:text-ink-700 hover:underline">
                Become a Delivery Partner
              </Link>
              {LEGAL_DOCS.map((doc) => (
                <Link key={doc.slug} href={`/legal/${doc.slug}`} className="hover:text-ink-700 hover:underline">
                  {doc.shortLabel}
                </Link>
              ))}
              <Link href="/grievance" className="hover:text-ink-700 hover:underline">
                File a complaint
              </Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
