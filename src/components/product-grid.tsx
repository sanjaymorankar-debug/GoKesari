import { ProductCard } from "@/components/product-card";
import type { listStorefrontProducts } from "@/server/services/catalogue";

/** Product cards grid shared by home, search, category, shop and product pages. */
export function ProductGrid({
  products,
  signedIn,
  distances,
  compare = true,
}: {
  /** F8: a product may carry a live shop offer's price and title. */
  products: (Awaited<ReturnType<typeof listStorefrontProducts>>[number] & {
    offerPricePaise?: number | null;
    offerTitle?: string | null;
  })[];
  signedIn: boolean;
  /** shopId -> km, from serviceability.ts, when a customer location is set. */
  distances?: ReadonlyMap<string, number | null>;
  /** Show the "Compare prices" link (off on the comparison page itself). */
  compare?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {products.map((p) => (
        <ProductCard
          key={p.shopProductId}
          signedIn={signedIn}
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
            onlineStock: p.onlineStock,
            subscribable: p.subscribable,
            shopName: p.shopName,
            shopSlug: p.shopSlug,
            productId: compare ? p.productId : undefined,
            distanceKm: distances?.get(p.shopId) ?? null,
            offerPricePaise: p.offerPricePaise ?? null,
            offerTitle: p.offerTitle ?? null,
          }}
        />
      ))}
    </div>
  );
}
