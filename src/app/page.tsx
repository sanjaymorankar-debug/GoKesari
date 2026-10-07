import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";

import { HomePriceComparison } from "@/components/home-price-comparison";
import { HomeShopsBoundary } from "@/components/home-shops-boundary";
import { OpenLocationButton } from "@/components/location-picker";
import { ShopGrid } from "@/components/shop-grid";
import { TomorrowDeliveryCard } from "@/components/tomorrow-delivery-card";
import { Alert, Section } from "@/components/ui";
import { REFERRAL_COOKIE } from "@/lib/customer-referrals";
import { locationAreaName, shortLocationLabel, type CustomerLocation } from "@/lib/location";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { canApplyReferralCode } from "@/server/services/customer-referrals";
import { homePriceComparison } from "@/server/services/price-comparison";
import { listNearbyShops } from "@/server/services/serviceability";
import { searchShops } from "@/server/services/shops";
import { getTomorrowDelivery, type TomorrowDelivery } from "@/server/services/tomorrow-delivery";

export const dynamic = "force-dynamic";

/** One-tap searches under the hero's search box. */
const QUICK_SEARCHES = ["Groceries", "Dairy", "Bakery", "Pharmacy", "Hardware", "Stationery"];

/** Fewer shops than this and the "more shops are joining" card fills the row. */
const INVITE_BELOW = 4;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function utcDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** "Thu 8 Oct" — from the calendar date itself, so it cannot disagree with "tomorrow". */
function shortDayLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(utcDate(iso))
    .replace(",", "");
}

function cutoffLabel(hour: number): string {
  return `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * Marketplace home (requirement §6). All content comes from the database.
 *
 * The header and the search hero are sent as soon as they're ready; the shop
 * list, which waits on the database, streams in behind a skeleton. A slow or
 * cold database therefore delays the shop cards only, not the first paint of
 * the page.
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);

  // F11: arrived through a friend's referral link and not yet applied — prompt once signed in.
  const referralCode = (await cookies()).get(REFERRAL_COOKIE)?.value;
  const showReferral =
    user && referralCode ? await canApplyReferralCode(user.id).catch(() => false) : false;

  // Tomorrow's subscription deliveries sit beside the hero. Never let them
  // take the home page down: without them the hero simply spans the row.
  const tomorrow: TomorrowDelivery | null = user
    ? await getTomorrowDelivery(user.id).catch((error) => {
        console.error("[home] tomorrow's delivery failed", error);
        return null;
      })
    : null;

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

      <div className={`mb-10 grid gap-5 ${tomorrow ? "lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)]" : ""}`}>
        <section className="flex flex-col justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-kesari-50 via-cream-100 to-leaf-50 px-6 py-8 sm:px-8 sm:py-10">
          <h1 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
            What are you looking for?
          </h1>
          <p className="mt-2 max-w-xl text-base text-ink-600">
            {location ? (
              <>
                Shops near <strong className="font-semibold text-ink-900">{shortLocationLabel(location)}</strong>{" "}
                that have it, in one search.
              </>
            ) : (
              <>
                Search for what you need and we will show you who has it.{" "}
                <OpenLocationButton>Choose your location</OpenLocationButton> to see shops near you.
              </>
            )}
          </p>

          <form action="/search" className="mt-5 flex max-w-xl gap-2">
            <input
              type="search"
              name="q"
              placeholder="e.g. milk, paracetamol, screws"
              aria-label="Search for a product"
              className="min-w-0 flex-1 rounded-lg border border-cream-200 bg-white px-4 py-2.5 text-sm placeholder:text-ink-500 focus:border-kesari-500 focus:outline-none"
            />
            <button
              type="submit"
              className="tap-target rounded-lg bg-kesari-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-kesari-800"
            >
              Search
            </button>
          </form>

          <ul className="mt-4 flex flex-wrap gap-2" aria-label="Popular searches">
            {QUICK_SEARCHES.map((term) => (
              <li key={term}>
                <Link
                  href={`/search?q=${encodeURIComponent(term)}`}
                  className="tap-target inline-block rounded-full border border-cream-200 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:border-kesari-300 hover:bg-kesari-50 [--tap-h:44px]"
                >
                  {term}
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {tomorrow ? (
          <TomorrowDeliveryCard
            date={tomorrow.date}
            dateLabel={shortDayLabel(tomorrow.date)}
            lines={tomorrow.lines}
            walletBalancePaise={tomorrow.walletBalancePaise}
            cutoffLabel={cutoffLabel(tomorrow.cutoffHour)}
            beforeCutoff={tomorrow.beforeCutoff}
            following={
              tomorrow.following
                ? {
                    dayName: WEEKDAYS[utcDate(tomorrow.following.date).getUTCDay()],
                    costPaise: tomorrow.following.costPaise,
                  }
                : null
            }
          />
        ) : null}
      </div>

      {/* If the list fails or its part of the stream is cut off, the
          boundary shows a retry card in its place, not an error page. */}
      <HomeShopsBoundary>
        <Suspense fallback={<HomeShopsSkeleton />}>
          <HomeShopSections location={location} />
        </Suspense>
      </HomeShopsBoundary>
    </>
  );
}

/**
 * Everything below the hero. The two sign-up cards come with the shop list
 * rather than ahead of it: if they sat after the skeleton, the list arriving
 * would push them down while they could be on screen (a layout shift).
 */
async function HomeShopSections({ location }: { location: CustomerLocation | null }) {
  const [shops, compared] = await Promise.all([
    // With a location: every shop near it, delivering or pickup-only.
    // Without one: a first look at the directory.
    location ? listNearbyShops(location, { limit: 8 }) : searchShops({ limit: 8 }),
    // F9: never let the comparison take the home page down.
    homePriceComparison(location).catch((error) => {
      console.error("[home] price comparison failed", error);
      return [];
    }),
  ]);
  const area = location ? locationAreaName(location) : null;

  return (
    <>
      <Section
        title={location ? `Shops near ${area ?? "you"}` : "Shops on GoKesari"}
        href="/shops"
        linkLabel="View all shops"
      >
        <ShopGrid
          shops={shops}
          filterChips
          viewToggle={false}
          inviteArea={shops.length < INVITE_BELOW ? (area ?? true) : null}
        />
      </Section>

      {compared.length > 0 ? (
        <Section title="Compare prices near you">
          <HomePriceComparison products={compared} />
        </Section>
      ) : null}

      <div className="mb-6 grid gap-3 md:grid-cols-2">
        <CallToAction
          title="Run a shop?"
          text="Grocery, dairy, bakery, pharmacy or any local shop."
          href="/shop/register"
          label="Add my shop"
          primary
        />
        <CallToAction
          title="Want to deliver for GoKesari?"
          text="Flexible hours, earn per delivery."
          href="/delivery-partner/apply"
          label="Become a partner"
        />
      </div>
    </>
  );
}

function CallToAction({
  title,
  text,
  href,
  label,
  primary = false,
}: {
  title: string;
  text: string;
  href: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cream-200 bg-white px-4 py-3.5 shadow-sm">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink-900">{title}</h2>
        <p className="text-sm text-ink-500">{text}</p>
      </div>
      <Link
        href={href}
        className={`tap-target whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium ${
          primary
            ? "bg-kesari-600 text-white hover:bg-kesari-800"
            : "border border-kesari-300 bg-white text-kesari-700 hover:bg-kesari-50"
        }`}
      >
        {label}
      </Link>
    </div>
  );
}

/**
 * Stand-in for the shop list while it loads: one section at the real cards'
 * size. At least a screen tall, so nothing below it (the footer) is on screen
 * when the list replaces it and nothing visibly moves.
 */
function HomeShopsSkeleton() {
  return (
    <div className="min-h-screen" role="status">
      <span className="sr-only">Loading shops…</span>
      <div className="mb-10" aria-hidden>
        <div className="mb-3 flex items-baseline justify-between">
          <div className="h-7 w-48 rounded-md bg-cream-200" />
          <div className="h-5 w-28 rounded-md bg-cream-200" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-cream-200 bg-white">
              <div className="h-20 bg-kesari-50" />
              <div className="h-[150px] space-y-2 p-3.5">
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
