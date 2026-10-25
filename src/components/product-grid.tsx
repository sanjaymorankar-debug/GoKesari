import { ProductCard } from "@/components/product-card";
import type { CartLineQuantity } from "@/server/services/cart";
import type { listStorefrontProducts } from "@/server/services/catalogue";

/** Product cards grid shared by home, search, category, shop and product pages. */
export function ProductGrid({
  products,
  signedIn,
  cartLines,
  distances,
  compare = true,
  compareCounts,
}: {
  /** F8: a product may carry a live shop offer's price and title. */
  products: (Awaited<ReturnType<typeof listStorefrontProducts>>[number] & {
    offerPricePaise?: number | null;
    offerTitle?: string | null;
  })[];
  signedIn: boolean;
  /**
   * shopProductId -> the viewer's cart line (getCartLineQuantities), so a card
   * for something already in the cart opens on its in-cart controls; null when
   * signed out.
   */
  cartLines: ReadonlyMap<string, CartLineQuantity> | null;
  /** shopId -> km, from serviceability.ts, when a customer location is set. */
  distances?: ReadonlyMap<string, number | null>;
  /** Show the "Compare prices" link (off on the comparison page itself). */
  compare?: boolean;
  /** docs/homepage-uiux-2026-10 (F4): productId → nearby shops selling it; "Compare N prices" from 2. */
  compareCounts?: ReadonlyMap<string, number>;
}) {
  return (
    // Phones: two products a row (it was one, so a category ran to 13 screens).
    <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      {products.map((p) => (
        <ProductCard
          key={p.shopProductId}
          signedIn={signedIn}
          cartLine={cartLines?.get(p.shopProductId) ?? null}
          product={{
            shopProductId: p.shopProductId,
            productName: p.productName,
            categoryName: p.categoryName,
            unit: p.unit,
            imageUrl: p.imageUrl,
            onlinePricePaise: p.onlinePricePaise,
            offlinePricePaise: p.offlinePricePaise,
            onlineSaleEnabled: p.onlineSaleEnabled,
            offlineSaleEnabled: p.offlineSaleEnabled,
            isAvailable: p.isAvailable,
            trackInventory: p.trackInventory,
            // The card needs only "is there any" and the stepper's limit (99), not the shop's count (TC-SPI-027).
            onlineStock: p.trackInventory ? Math.min(p.onlineStock, 99) : p.onlineStock,
            subscribable: p.subscribable,
            kind: p.kind,
            unitSizeMilli: p.unitSizeMilli,
            shopName: p.shopName,
            shopSlug: p.shopSlug,
            productId: compare ? p.productId : undefined,
            compareCount: compare ? (compareCounts?.get(p.productId) ?? 0) : 0,
            distanceKm: distances?.get(p.shopId) ?? null,
            offerPricePaise: p.offerPricePaise ?? null,
            offerTitle: p.offerTitle ?? null,
            shortDescription: p.shortDescription ?? null,
            detailsHref: `/products/${p.productId}?shop=${encodeURIComponent(p.shopSlug)}`,
            mrpPaise: p.mrpPaise ?? null,
          }}
        />
      ))}
    </div>
  );
}
