import type { Metadata, Viewport } from "next";

import { Suspense } from "react";

import { AppInstallPrompt, INSTALL_EVENT_CATCHER } from "@/components/app-install/install-prompt";
import { AppAutoUpdate } from "@/components/app-install/app-auto-update";
import { NavigationFeedback } from "@/components/board/navigation-feedback";
import { OfflineBanner } from "@/components/board/offline-banner";
import { MobileShopNav } from "@/components/home/mobile-shop-nav";
import { RememberReturnTo } from "@/components/remember-return-to";
import { GuestCartMerge } from "@/components/guest-cart/guest-cart-merge";
import { GuestCartProvider } from "@/components/guest-cart/guest-cart-context";
import { PolicyReconsentGate } from "@/components/policy-reconsent-gate";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { parseStoreLink } from "@/lib/app-install";
import { shortLocationLabel } from "@/lib/location";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { listAddresses } from "@/server/services/addresses";
import { getCart, getCartItemCount } from "@/server/services/cart";
import { unreadCount } from "@/server/services/notifications";
import { listUserRoles } from "@/server/services/roles";
import { listShopsWhereStaff } from "@/server/services/shop-staff";
import { getWalletByUserId } from "@/server/services/wallet";
import { isSignupReferralAsked } from "@/server/services/customer-signup-referrals";
import { getRule } from "@/server/services/settings";
import { getReconsentState } from "@/server/services/policy-versions";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "GoKesari — Everything for Everyone, Everywhere",
    template: "%s · GoKesari",
  },
  description:
    "Every local shop near you, in one directory. Wallet payments and flexible daily subscriptions.",
  // Added to the iPhone home screen, the site opens full-screen like an app
  // (with src/app/manifest.ts); the status bar stays light, above the page.
  applicationName: "GoKesari",
  appleWebApp: { capable: true, title: "GoKesari", statusBarStyle: "default" },
  // Next emits the standard mobile-web-app-capable tag; iOS before 16.4 reads only Apple's own.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // iPhone notch and home bar: lets env(safe-area-inset-*) report real values; the bottom bars and
  // headers pad themselves with it (docs/ux-mobile-2026-11).
  viewportFit: "cover",
  themeColor: "#f97316",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Header state is resolved server-side so the cart count and balance are
  // always authoritative rather than optimistic client state.
  //
  // Every read starts at once. Each is a round trip to the database, and this
  // layout wraps every page: one after another they cost a round trip each on
  // every visit (several hundred ms on mobile with a far database).
  const user = await getCurrentUser();
  const homeDiscoveryRule = getRule("homeDiscovery").catch(() => ({ enabled: true }));
  const signedIn = user
    ? Promise.all([
        // The cart total for the phones' floating cart bar is read only when
        // there is a cart — chained behind the count, beside the other reads.
        getCartItemCount(user.id)
          .catch(() => 0)
          .then(async (count) => ({
            count,
            totalPaise:
              count > 0 && (await homeDiscoveryRule).enabled
                ? await getCart(user.id)
                    .then((c) => c.grandTotalPaise)
                    .catch(() => null)
                : null,
          })),
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
        // Referral links (docs/four-features-2026-10) for every signed-in user, when their rules are on.
        Promise.all([isSignupReferralAsked(), getRule("customerReferrals")])
          .then(([signup, friends]) => [
            ...(signup ? [{ href: "/referral", key: "referral" as const }] : []),
            ...(friends.enabled ? [{ href: "/refer", key: "invite" as const }] : []),
          ])
          .catch(() => []),
      ])
    : null;
  const [signedInState, location, lang, homeDiscovery, barcodeScan, guestCartEnabled, priceComparison, reconsent] = await Promise.all([
    signedIn,
    // The same location every page filters by (cookie, else the default address).
    getCustomerLocation(user?.id).catch(() => null),
    getBoardLang(),
    // docs/homepage-uiux-2026-10: phones' bottom navigation and floating cart bar (rule homeDiscovery).
    homeDiscoveryRule,
    // docs/search-brand-barcode-favourites-2026-11: the barcode scan button in the header search.
    isFeatureEnabled("brand_barcode_favourites_enabled").catch(() => false),
    // docs/guest-cart-2026-11: guests fill a browser cart (sign-in at Place order); signed-in users
    // need it only to move a guest cart left in this browser into their account cart.
    isFeatureEnabled("guest_cart_enabled").catch(() => false),
    // docs/price-comparison-off-2026-11: the phones' Compare tab only while the flag is on.
    isFeatureEnabled("local_price_comparison_enabled").catch(() => false),
    // docs/policy-reconsent-2026-11: a new policy version this user has not accepted (flag policy_reconsent_enabled).
    // One flag read (cached) when off; a failed read never blocks the site.
    user ? getReconsentState(user.id).catch(() => null) : null,
  ]);
  const [cart, balancePaise, unread, roles, addresses, staffShops, referralLinks] = signedInState ?? [
    { count: 0, totalPaise: null },
    null,
    0,
    [],
    [],
    [],
    [],
  ];
  const cartCount = cart.count;
  const cartTotalPaise = cart.totalPaise;

  return (
    <html lang="en">
      <body className="min-h-screen bg-cream-50">
        <GuestCartProvider enabled={guestCartEnabled && !user}>
        {/* docs/app-install-2026-10: holds Chrome's install event until the install prompt mounts. */}
        <script dangerouslySetInnerHTML={{ __html: INSTALL_EVENT_CATCHER }} />
        <OfflineBanner lang={lang} />
        {/* useSearchParams needs a boundary; it renders nothing until a link is tapped. */}
        <Suspense fallback={null}>
          <NavigationFeedback lang={lang} />
          <RememberReturnTo />
        </Suspense>
        <SiteHeader
          lang={lang}
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
          barcodeScan={barcodeScan}
        />
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
        <SiteFooter lang={lang} />
        {/* docs/app-install-2026-10: "Get the app" on every visit until installed. */}
        <AppInstallPrompt
          lang={lang}
          signedIn={Boolean(user)}
          stores={{
            android: parseStoreLink(process.env.MOBILE_APP_ANDROID_URL, "android"),
            ios: parseStoreLink(process.env.MOBILE_APP_IOS_URL, "ios"),
          }}
          shoppingNav={homeDiscovery.enabled}
          cartBar={cartCount > 0 && Boolean(user)}
        />
        {/* docs/silent-update-2026-11: new versions install and switch silently; no "Reload" prompt. */}
        <AppAutoUpdate userKey={user?.id ?? null} />
        {homeDiscovery.enabled ? <MobileShopNav lang={lang} signedIn={Boolean(user)} cartCount={cartCount} cartTotalPaise={cartTotalPaise} priceComparison={priceComparison} /> : null}
        {guestCartEnabled && user ? <GuestCartMerge /> : null}
        {reconsent?.needsReconsent ? <PolicyReconsentGate lang={lang} pending={reconsent.pending} /> : null}
        </GuestCartProvider>
      </body>
    </html>
  );
}
