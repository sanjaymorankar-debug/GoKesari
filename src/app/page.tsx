import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";

import { HomePriceComparison } from "@/components/home-price-comparison";
import { HomeShopsBoundary } from "@/components/home-shops-boundary";
import { ShopGrid } from "@/components/shop-grid";
import { Alert, Card, Section } from "@/components/ui";
import { REFERRAL_COOKIE } from "@/lib/customer-referrals";
import { LocationBar } from "@/components/location-bar";
import type { CustomerLocation } from "@/lib/location";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { canApplyReferralCode } from "@/server/services/customer-referrals";
import { homePriceComparison } from "@/server/services/price-comparison";
import { listServiceableShops } from "@/server/services/serviceability";
import { searchShops } from "@/server/services/shops";

export const dynamic = "force-dynamic";

/**
 * Marketplace home (requirement §6). All content comes from the database.
 *
 * The header, search hero and "Deliver to" block are sent as soon as they're
 * ready; the shop lists, which wait on the database, stream in behind a
 * skeleton. A slow or cold database therefore delays the shop cards only,
 * not the first paint of the page.
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);

  // F11: arrived through a friend's referral link and not yet applied — prompt once signed in.
  const referralCode = (await cookies()).get(REFERRAL_COOKIE)?.value;
  const showReferral =
    user && referralCode ? await canApplyReferralCode(user.id).catch(() => false) : false;

  return (
    <>
      {showReferral ? (
        <div className="mb-4" data-testid="referral-banner">
          <Alert tone="success" title="You were invited by a friend">
            <Link href="/refer" className="font-medium underline">
              Apply code {referralCode}
            </Link>{" "}
            to get your welcome reward after your first delivered order.
          </Alert>
        </div>
      ) : null}
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
            className="min-w-0 flex-1 rounded-lg border border-cream-200 bg-white px-4 py-2.5 text-sm placeholder:text-ink-500 focus:border-kesari-500 focus:outline-none"
          />
          <button
            type="submit"
            className="tap-target rounded-lg bg-kesari-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-kesari-800"
          >
            Search
          </button>
        </form>
      </section>

      <LocationBar userId={user?.id ?? null} location={location} />

      {/* If the lists fail or their part of the stream is cut off, the
          boundary shows a retry card in their place, not an error page. */}
      <HomeShopsBoundary>
        <Suspense fallback={<HomeShopsSkeleton />}>
          <HomeShopSections location={location} />
        </Suspense>
      </HomeShopsBoundary>
    </>
  );
}

/**
 * Everything below "Deliver to". The two sign-up cards come with the shop
 * lists rather than ahead of them: if they sat after the skeleton, the lists
 * arriving would push them down while they could be on screen (a layout
 * shift).
 */
async function HomeShopSections({ location }: { location: CustomerLocation | null }) {
  const [featuredShops, kesariShops, greenShops, nearbyShops, compared] = await Promise.all([
    searchShops({ limit: 4 }),
    searchShops({ classification: "KESARI", limit: 4 }),
    searchShops({ classification: "GREEN", limit: 4 }),
    location ? listServiceableShops(location, { limit: 8 }) : Promise.resolve([]),
    // F9: never let the comparison take the home page down.
    homePriceComparison(location).catch((error) => {
      console.error("[home] price comparison failed", error);
      return [];
    }),
  ]);

  return (
    <>
      {location ? (
        <Section title="Shops that deliver to you" href="/shops">
          <ShopGrid shops={nearbyShops} />
        </Section>
      ) : null}

      {compared.length > 0 ? (
        <Section title="Compare prices near you">
          <HomePriceComparison products={compared} />
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
          className="tap-target rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800"
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
          className="tap-target rounded-lg border border-kesari-300 bg-white px-4 py-2 text-sm font-medium text-kesari-700 hover:bg-kesari-50"
        >
          Become a Delivery Partner
        </Link>
      </Card>
    </>
  );
}

/**
 * Stand-in for the shop lists while they load: one "Featured shops" section
 * at the real cards' size. At least a screen tall, so nothing below it (the
 * footer) is on screen when the lists replace it and nothing visibly moves.
 */
function HomeShopsSkeleton() {
  return (
    <div className="min-h-screen" role="status">
      <span className="sr-only">Loading shops…</span>
      <div className="mb-10" aria-hidden>
        <div className="mb-3 flex items-baseline justify-between">
          <div className="h-7 w-40 rounded-md bg-cream-200" />
          <div className="h-5 w-16 rounded-md bg-cream-200" />
        </div>
        <div className="mb-3 flex justify-end gap-1">
          <div className="h-[30px] w-[63px] rounded-lg border border-cream-200" />
          <div className="h-[30px] w-[60px] rounded-lg border border-cream-200" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-cream-200 bg-white">
              <div className="h-24 bg-gradient-to-br from-cream-100 to-cream-200" />
              <div className="h-[214px] space-y-2 p-4">
                <div className="h-5 w-24 rounded-full bg-cream-100" />
                <div className="h-6 w-3/4 rounded-md bg-cream-200" />
                <div className="h-4 w-1/2 rounded-md bg-cream-100" />
                <div className="h-4 w-2/3 rounded-md bg-cream-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
