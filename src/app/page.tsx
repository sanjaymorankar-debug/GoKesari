import Link from "next/link";

import { ShopGrid } from "@/components/shop-grid";
import { Card, Section } from "@/components/ui";
import { LocationBar } from "@/components/location-bar";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
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
          What are you looking for?
        </h1>
        <p className="mt-3 max-w-xl text-base text-ink-600">
          Find products at nearby shops — search for what you need and we
          will show you who has it close to you.
        </p>

        <form action="/search" className="mt-6 flex max-w-xl gap-2">
          <input
            type="search"
            name="q"
            placeholder="Search for a product, e.g. milk, paracetamol, screws"
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
            bakery, pharmacy or any other kind of local shop.
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
