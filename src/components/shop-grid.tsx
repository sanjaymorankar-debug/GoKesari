import type { ReactNode } from "react";

import { ShopGridView, type ShopCardData } from "@/components/shop-grid-view";
import { EmptyState } from "@/components/ui";
import { displayShopName, isNewShop } from "@/lib/shop-display";
import { isShopOpenNow, shopHoursLabel } from "@/lib/shop-hours";
import { shopTypeLabel } from "@/lib/shop-types";
import type { Shop } from "@/server/db/schema";

/**
 * Only the columns a card is built from, so public search (searchShops) can
 * select just those. The optional fields are present when discovery ran
 * against a customer location (GS-019, listNearbyShops).
 */
export type GridShop = Pick<
  Shop,
  | "id"
  | "slug"
  | "name"
  | "logoUrl"
  | "area"
  | "city"
  | "pincode"
  | "deliveryAvailable"
  | "ratingAvgX100"
  | "ratingCount"
  | "shopType"
  | "openingHours"
> & {
  preparationTimeMinutes?: number;
  createdAt?: Date | null;
  distanceKm?: number | null;
  /** Whether home delivery reaches the customer's location; undefined when no location is known. */
  deliversHere?: boolean;
  /** The shop has subscribable products, which are delivered whatever its order delivery setting. */
  subscriptionDelivery?: boolean;
  /** Paused: by the owner, below its wallet minimum, or (four-features O-4) missing a legal document. */
  ordersPaused?: boolean;
};

/**
 * One honest line about how a customer gets their order from this shop. A
 * shop is never called plain "Pickup only" while it also runs delivered
 * subscriptions — that contradicted the customer's own daily deliveries.
 */
function fulfilmentLine(shop: GridShop): string {
  const distance = shop.distanceKm != null ? ` · ${shop.distanceKm} km` : "";
  if (shop.deliveryAvailable) {
    if (shop.deliversHere === true) return `Delivers to you${distance}`;
    // A paused shop is not "outside its delivery area": it takes no new orders at all for now.
    if (shop.deliversHere === false && shop.ordersPaused) return `Not taking new orders right now${distance}`;
    if (shop.deliversHere === false) return `Pickup · outside its delivery area${distance}`;
    return "Home delivery available";
  }
  if (shop.subscriptionDelivery) return `Pickup for orders · subscriptions delivered${distance}`;
  const prep = shop.preparationTimeMinutes;
  return `Pickup only${prep ? ` · ready in about ${prep} min` : ""}${distance}`;
}

/**
 * Shop grid/list (requirement §15). Classification is deliberately not shown
 * here — the Kesari/Green filter is disabled and the badge removed from cards
 * until that's re-enabled.
 *
 * A server component on purpose: it reduces each shop row to the fields a
 * card displays before anything crosses to the browser. Handing the rows to
 * the client view directly would serialise every column (owner phone,
 * registration fee, GST/PAN fields) into the page's HTML.
 */
export function ShopGrid({
  shops,
  filterChips = false,
  viewToggle = true,
  toolbar,
  inviteArea,
  empty,
}: {
  shops: GridShop[];
  /** Offer quick filter chips (type, open now, delivers to me) over these shops. */
  filterChips?: boolean;
  /** Show the Grid / List switch. */
  viewToggle?: boolean;
  /** Shown on the left of the view switch, e.g. a sort control. */
  toolbar?: ReactNode;
  /**
   * Show the "more shops are joining" invite card after the shops. A string
   * names the area ("Kharadi"); true shows it without one.
   */
  inviteArea?: string | true | null;
  /** Replaces the default "No shops found." card. */
  empty?: ReactNode;
}) {
  if (shops.length === 0 && !inviteArea) {
    return empty ?? <EmptyState title="No shops found." />;
  }

  // Open/closed is decided once, on the server, from IST opening hours.
  const now = new Date();
  const cards: ShopCardData[] = shops.map((shop) => ({
    id: shop.id,
    slug: shop.slug,
    name: displayShopName(shop.name),
    logoUrl: shop.logoUrl,
    area: shop.area,
    city: shop.city,
    pincode: shop.pincode,
    ratingAvgX100: shop.ratingAvgX100,
    ratingCount: shop.ratingCount,
    typeKey: shop.shopType,
    typeLabel: shopTypeLabel(shop.shopType),
    open: isShopOpenNow(shop, now),
    hoursLabel: shopHoursLabel(shop, now),
    isNew: isNewShop(shop.createdAt, now),
    fulfilment: fulfilmentLine(shop),
    pickupOnly: !shop.deliveryAvailable,
    deliversHere: shop.deliversHere ?? null,
  }));

  return (
    <ShopGridView
      shops={cards}
      filterChips={filterChips}
      viewToggle={viewToggle}
      toolbar={toolbar}
      inviteArea={inviteArea ?? null}
    />
  );
}
