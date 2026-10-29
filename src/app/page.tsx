import { cookies } from "next/headers";

import { CustomerBoard } from "@/components/board/customer-board";
import { HomePage, type HomePageData } from "@/components/home/home-page";
import type { ProductTile } from "@/components/home/product-tiles";
import { REFERRAL_COOKIE } from "@/lib/customer-referrals";
import { tr } from "@/lib/board/i18n";
import { DEFAULT_BANNERS, type BannerSlide } from "@/lib/home-banners";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { loadCustomerBoard } from "@/server/board-data";
import { getBoardHeaderData } from "@/server/board-header-data";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { customerCounts, getActiveOrder, getBuyAgain, getFirstActiveSubscriptionId } from "@/server/services/board-counts";
import { getCartItemCount } from "@/server/services/cart";
import { canApplyReferralCode } from "@/server/services/customer-referrals";
import { listLiveBanners } from "@/server/services/home-banners";
import { nearbyOfferCounts, popularInArea } from "@/server/services/home-discovery";
import { listNearbyShops } from "@/server/services/serviceability";
import { getRule } from "@/server/services/settings";
import { searchShops } from "@/server/services/shops";

export const dynamic = "force-dynamic";

/** Shops shown on the home page; the rest are one tap away on /shops. */
const HOME_SHOPS = 6;

/**
 * Marketplace home. With rule `homeDiscovery` on (the default), the
 * product-discovery home (docs/homepage-uiux-2026-10): search, hero banners,
 * categories, shops near you, Buy again / Popular in your area and the Sell /
 * Deliver links — the account tiles moved to the header's Account menu, the
 * phone drawer and the bottom navigation. Off: the Tile Board home as before.
 */
export default async function HomePageRoute() {
  const user = await getCurrentUser();
  // F11: arrived through a friend's referral link and not yet applied — prompt once signed in.
  const referralCode = (await cookies()).get(REFERRAL_COOKIE)?.value;
  // Reads start together rather than one after another: each one is a round trip
  // to the database in Singapore (performance check, 29 Oct 2026). The account
  // reads are only wasted when rule `homeDiscovery` is off.
  const [location, showReferral, lang, header, rule, [buyAgainRows, activeOrder, subscriptionId, cartCount]] = await Promise.all([
    getCustomerLocation(user?.id),
    user && referralCode ? canApplyReferralCode(user.id).catch(() => false) : false,
    getBoardLang(),
    getBoardHeaderData(user),
    getRule("homeDiscovery").catch(() => ({ enabled: true, bannerSeconds: 6 })),
    user
      ? Promise.all([getBuyAgain(user.id, 6), getActiveOrder(user.id), getFirstActiveSubscriptionId(user.id), getCartItemCount(user.id).catch(() => 0)])
      : ([undefined, undefined, undefined, 0] as const),
  ]);

  if (!rule.enabled) {
    const board = await loadCustomerBoard(user, location);
    return (
      <CustomerBoard
        lang={lang}
        user={user}
        header={header}
        data={board}
        timeZone={getEnv().APP_TIMEZONE}
        referralCode={showReferral ? referralCode : null}
      />
    );
  }

  // Banners and popular items need the nearby shops, and the compare counts need
  // the popular items; the counts and the fallback shop list need neither.
  const discovery = (location ? listNearbyShops(location).catch(() => []) : Promise.resolve([])).then(async (nearby) => {
    const nearbyIds = nearby.map((s) => s.id);
    const cities = [...new Set(nearby.map((s) => s.city).filter(Boolean))];
    // Buy again for customers with delivered orders; everyone else sees what is popular nearby.
    const popularRead =
      buyAgainRows && buyAgainRows.length > 0 ? Promise.resolve({ scope: "area" as const, items: [] }) : popularInArea(location, { nearbyShopIds: nearbyIds, cities });
    const [banners, popular, offerCounts] = await Promise.all([
      listLiveBanners({ pincode: location?.pincode ?? null, cities }),
      popularRead,
      // "Compare N prices" for products sold by two or more nearby shops.
      popularRead.then((p) => nearbyOfferCounts([...p.items, ...(buyAgainRows ?? [])].map((i) => i.productId), nearbyIds)),
    ]);
    return { nearby, banners, popular, offerCounts };
  });
  const [counts, shopsFallback, { nearby, banners, popular, offerCounts }] = await Promise.all([
    customerCounts(user?.id ?? null, location),
    location ? Promise.resolve([]) : searchShops({ limit: HOME_SHOPS }).catch(() => []),
    discovery,
  ]);
  const popularTiles: ProductTile[] = popular.items.map((p) => ({
    shopProductId: p.shopProductId,
    productId: p.productId,
    name: p.name,
    unit: p.unit,
    shopName: p.shopName,
    shopSlug: p.shopSlug,
    imageUrl: p.imageUrl,
    pricePaise: p.pricePaise,
    compareCount: offerCounts.get(p.productId) ?? 0,
  }));
  const buyAgain: ProductTile[] = (buyAgainRows ?? []).map((b) => ({
    shopProductId: b.shopProductId,
    productId: b.productId,
    name: b.name,
    unit: b.unit,
    shopName: b.shopName,
    shopSlug: b.shopSlug,
    imageUrl: b.imageUrl,
    pricePaise: b.pricePaise,
    compareCount: offerCounts.get(b.productId) ?? 0,
  }));

  const slides: BannerSlide[] =
    banners.length > 0
      ? banners
      : DEFAULT_BANNERS.map((b) => ({ id: b.id, kind: b.kind, title: tr(b.title, lang), subtitle: tr(b.subtitle, lang), imageUrl: null, ctaLabel: tr(b.cta, lang), ctaHref: b.href }));

  const data: HomePageData = {
    counts,
    banners: slides,
    bannerSeconds: rule.bannerSeconds,
    shops: location ? nearby.slice(0, HOME_SHOPS) : shopsFallback,
    hasLocation: Boolean(location),
    buyAgain,
    popular: { scope: popular.scope, items: popularTiles },
    referralCode: showReferral && referralCode ? referralCode : null,
  };

  return (
    <HomePage
      lang={lang}
      data={data}
      header={{
        lang,
        user: user ? { name: user.name, email: user.email, role: user.role } : null,
        roles: header.roles,
        balancePaise: header.balancePaise,
        extraLinks: header.extraLinks,
        params: { subscriptionId, activeOrderNumber: activeOrder?.orderNumber },
        unreadCount: header.unread,
        cartCount,
        locationLabel: header.locationLabel,
        savedAddresses: header.savedAddresses,
      }}
    />
  );
}
