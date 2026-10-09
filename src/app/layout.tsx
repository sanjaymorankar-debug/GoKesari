import type { Metadata, Viewport } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { shortLocationLabel } from "@/lib/location";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { listAddresses } from "@/server/services/addresses";
import { getCartItemCount } from "@/server/services/cart";
import { unreadCount } from "@/server/services/notifications";
import { listUserRoles } from "@/server/services/roles";
import { listShopsWhereStaff } from "@/server/services/shop-staff";
import { getWalletByUserId } from "@/server/services/wallet";
import { getRule } from "@/server/services/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "GoKesari — Everything for Everyone",
    template: "%s · GoKesari",
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
  const [cartCount, balancePaise, unread, roles, addresses, staffShops] = user
    ? await Promise.all([
        getCartItemCount(user.id).catch(() => 0),
        // No wallet row yet is a balance of zero; a failed read hides the pill
        // rather than showing a wrong ₹0.
        getWalletByUserId(user.id)
          .then((w) => w?.balancePaise ?? 0)
          .catch(() => null),
        unreadCount(user.id).catch(() => 0),
        // GS-003: roles the user can switch between.
        listUserRoles(user.id).catch(() => [user.role]),
        // Offered in the header's "Deliver to" chooser.
        listAddresses(user.id).catch(() => []),
        // Module 1: shops this user may edit product photos for as staff.
        listShopsWhereStaff(user.id).catch(() => []),
      ])
    : [0, null, 0, [], [], []];
  // The same location every page filters by (cookie, else the default address).
  const location = await getCustomerLocation(user?.id).catch(() => null);
  // Referral links (docs/four-features-2026-10) for every signed-in user, when their rules are on.
  const referralLinks = user
    ? await Promise.all([getRule("customerSignupReferral"), getRule("customerReferrals")])
        .then(([signup, friends]) => [
          ...(signup.enabled ? [{ href: "/referral", label: "My referral code" }] : []),
          ...(friends.enabled ? [{ href: "/refer", label: "Invite friends" }] : []),
        ])
        .catch(() => [])
    : [];

  return (
    <html lang="en">
      <body className="min-h-screen bg-cream-50">
        <SiteHeader
          user={user}
          roles={roles}
          cartCount={cartCount}
          balancePaise={balancePaise}
          unreadCount={unread}
          locationLabel={location ? shortLocationLabel(location) : null}
          savedAddresses={addresses.map((a) => ({
            id: a.id,
            label: `${a.label ? `${a.label} — ` : ""}${a.pincode}`,
          }))}
          helpsShops={staffShops.length > 0}
          referralLinks={referralLinks}
        />
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
