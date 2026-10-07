import { ShopGridView, type ShopCardData } from "@/components/shop-grid-view";
import { EmptyState } from "@/components/ui";
import { isShopOpenNow } from "@/lib/shop-hours";
import { shopTypeLabel } from "@/lib/shop-types";
import type { Shop } from "@/server/db/schema";

/**
 * Only the columns a card is built from, so public search (searchShops) can
 * select just those. `distanceKm` is present when discovery ran against a
 * customer location (GS-019).
 */
type GridShop = Pick<
  Shop,
  | "id"
  | "slug"
  | "name"
  | "logoUrl"
  | "ownerName"
  | "area"
  | "city"
  | "pincode"
  | "deliveryAvailable"
  | "ratingAvgX100"
  | "ratingCount"
  | "shopType"
  | "openingHours"
> & { distanceKm?: number | null };

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
export function ShopGrid({ shops }: { shops: GridShop[] }) {
  if (shops.length === 0) {
    return <EmptyState title="No shops found." />;
  }

  // Open/closed is decided once, on the server, from IST opening hours.
  const now = new Date();
  const cards: ShopCardData[] = shops.map((shop) => ({
    id: shop.id,
    slug: shop.slug,
    name: shop.name,
    logoUrl: shop.logoUrl,
    ownerName: shop.ownerName,
    area: shop.area,
    city: shop.city,
    pincode: shop.pincode,
    deliveryAvailable: shop.deliveryAvailable,
    ratingAvgX100: shop.ratingAvgX100,
    ratingCount: shop.ratingCount,
    typeLabel: shopTypeLabel(shop.shopType),
    open: isShopOpenNow(shop, now),
    distanceKm: shop.distanceKm ?? null,
  }));

  return <ShopGridView shops={cards} />;
}
