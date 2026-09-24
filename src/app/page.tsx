import Link from "next/link";

import { ProductCard } from "@/components/product-card";
import { ShopGrid } from "@/components/shop-grid";
import { Card, Section } from "@/components/ui";
import { SHOP_TYPES } from "@/lib/shop-types";
import { LocationBar } from "@/components/location-bar";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { listServiceableShops } from "@/server/services/serviceability";
import { searchShops } from "@/server/services/shops";

export const dynamic = "force-dynamic";

/** Marketplace home (requirement §6). All content comes from the database. */
export default async function HomePage() {
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);
  const [featuredShops, kesariShops, greenShops, nearbyShops] = await Promise.all([
    searchShops({ limit: 4 }),
    searchShops({ classification: "KESARI", limit: 4 }),
    searchShops({ classification: "GREEN", limit: 4 }),
    location ? listServiceableShops(location, { limit: 8 }) : Promise.resolve([]),
  ]);

  return (
    <>
      <section className="mb-10 overflow-hidden rounded-2xl bg-gradient-to-br from-kesari-50 via-cream-100 to-leaf-50 px-6 py-10 sm:px-10 sm:py-14">
        <h1 className="max-w-2xl text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
          Your Neighbourhood, Now Online
        </h1>
        <p className="mt-3 max-w-xl text-base text-ink-600">
          Find a shop near you by product, area or PIN code — grocery,
          pharmacy, jewellery, hardware and every other kind of local shop.
        </p>

        <form action="/search" className="mt-6 flex max-w-xl gap-2">
          <input
            type="search"
            name="q"
            placeholder="Search a product, a shop, an area or PIN code"
            aria-label="Search"
            className="min-w-0 flex-1 rounded-lg border border-cream-200 bg-white px-4 py-2.5 text-sm focus:border-kesari-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-lg bg-kesari-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-kesari-700"
          >
            Search
          </button>
        </form>
      </section>

      <LocationBar userId={user?.id ?? null} location={location} />

      {location ? (
        <Section title="Shops that deliver to you" href="/shops">
          <ShopGrid shops={nearbyShops} />
        </Section>
      ) : null}

      {/* Every shop type is browsable, even without an account (§6). */}
      <Section title="Browse all categories" href="/categories">
        <div className="flex flex-wrap gap-2">
          {SHOP_TYPES.map((t) => (
            <Link
              key={t.key}
              href={`/category/${t.key}`}
              className="rounded-full border border-cream-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-kesari-300 hover:text-kesari-700"
            >
              {t.label}
            </Link>
          ))}
        </div>
      </Section>

      <Section title="Featured shops" href="/shops">
        <ShopGrid shops={featuredShops} />
      </Section>

      {kesariShops.length > 0 ? (
        <Section title="Kesari shops" href="/shops?classification=KESARI">
          <ShopGrid shops={kesariShops} />
        </Section>
      ) : null}

      {greenShops.length > 0 ? (
        <Section title="Green shops" href="/shops?classification=GREEN">
          <ShopGrid shops={greenShops} />
        </Section>
      ) : null}

      <Card className="mb-6 flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h2 className="text-lg font-semibold text-ink-900">
            Run a shop?
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            List your shop and start taking online orders — grocery, dairy,
            bakery, pharmacy or any of our 44 shop types.
          </p>
        </div>
        <Link
          href="/shop/register"
          className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-700"
        >
          Add my shop
        </Link>
      </Card>

      <Card className="mb-6 flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h2 className="text-lg font-semibold text-ink-900">
            Want to deliver for GoKesari?
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Join as an independent delivery partner — flexible hours, earn per
            delivery.
          </p>
        </div>
        <Link
          href="/delivery-partner/apply"
          className="rounded-lg border border-kesari-300 bg-white px-4 py-2 text-sm font-medium text-kesari-700 hover:bg-kesari-50"
        >
          Become a Delivery Partner
        </Link>
      </Card>
    </>
  );
}

export function ProductGrid({
  products,
  signedIn,
  distances,
  compare = true,
}: {
  products: Awaited<ReturnType<typeof listStorefrontProducts>>;
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
          }}
        />
      ))}
    </div>
  );
}
