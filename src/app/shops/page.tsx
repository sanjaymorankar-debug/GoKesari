import Link from "next/link";

import { OpenLocationButton } from "@/components/location-picker";
import { ShopFilters, ShopSortSelect } from "@/components/shop-filters";
import { ShopGrid, type GridShop } from "@/components/shop-grid";
import { EmptyState, LinkButton } from "@/components/ui";
import { locationAreaName, shortLocationLabel } from "@/lib/location";
import { isShopOpenNow } from "@/lib/shop-hours";
import { parseShopSort } from "@/lib/shop-sort";
import { SHOP_TYPE_KEYS, shopTypeLabel, type ShopTypeKey } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { listNearbyShops } from "@/server/services/serviceability";
import { searchShops } from "@/server/services/shops";

export const metadata = { title: "Shops" };
export const dynamic = "force-dynamic";

type Search = {
  q?: string;
  city?: string;
  area?: string;
  pincode?: string;
  type?: string;
  classification?: string;
  /** "true" = only shops that deliver to me (or, with no location, that deliver at all). */
  delivery?: string;
  /** "1" = only shops open right now. */
  open?: string;
  sort?: string;
  /** "1" = ignore the customer's location and list every shop. */
  all?: string;
};

/** Fewer shops than this (and no filter in use) and the invite card fills the row. */
const INVITE_BELOW = 4;

/** Shop search with the §15 filter set. Filters live in the URL, so results are shareable. */
export default async function ShopsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);
  // With a location chosen, list the shops near it — delivering or
  // pickup-only — nearest first (GS-019); `all=1` restores the whole directory.
  const nearOnly = Boolean(location) && params.all !== "1";
  const nearby = location ? await listNearbyShops(location) : [];
  const nearbyById = new Map(nearby.map((shop) => [shop.id, shop]));
  const shopType = (SHOP_TYPE_KEYS as readonly string[]).includes(params.type ?? "")
    ? (params.type as ShopTypeKey)
    : undefined;

  // Text and place filters run in the database (they also match a shop's
  // categories); type, open-now and delivers-to-me are applied below so the
  // filter bar can tell which of them would still leave something to show.
  const found = await searchShops({
    ids: nearOnly ? [...nearbyById.keys()] : undefined,
    query: params.q || undefined,
    city: params.city || undefined,
    area: params.area || undefined,
    pincode: params.pincode || undefined,
    classification: (params.classification as "KESARI" | "GREEN") || undefined,
    limit: 100,
  });
  const now = new Date();
  const scope = found.map((shop) => {
    const near = nearbyById.get(shop.id);
    const card: GridShop = {
      ...shop,
      distanceKm: near?.distanceKm ?? null,
      deliversHere: location ? (near?.deliversHere ?? false) : undefined,
      subscriptionDelivery: near?.subscriptionDelivery,
      ordersPaused: near?.ordersPaused,
    };
    return {
      card,
      open: isShopOpenNow(shop, now),
      delivers: location ? (near?.deliversHere ?? false) : shop.deliveryAvailable,
    };
  });

  const wantOpen = params.open === "1";
  const wantDelivery = params.delivery === "true";
  const sort = parseShopSort(params.sort, Boolean(location));
  const shops = scope
    .filter(
      (s) =>
        (!shopType || s.card.shopType === shopType) && (!wantOpen || s.open) && (!wantDelivery || s.delivers),
    )
    .map((s) => s.card)
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "rating"
          ? b.ratingAvgX100 - a.ratingAvgX100 || b.ratingCount - a.ratingCount || a.name.localeCompare(b.name)
          : (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY) ||
            a.name.localeCompare(b.name),
    );

  // What the filter bar offers: only what would narrow this list.
  const narrows = (count: number) => count > 0 && count < scope.length;
  const types = [...new Set(scope.map((s) => s.card.shopType))]
    .map((key) => ({ key, label: shopTypeLabel(key) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const filtered = Boolean(
    params.q || params.city || params.area || params.pincode || params.classification || shopType || wantOpen || wantDelivery,
  );

  // "Widen the search": to the city most nearby shops are in, when known.
  const cityCounts = new Map<string, number>();
  for (const shop of nearby) cityCounts.set(shop.city, (cityCounts.get(shop.city) ?? 0) + 1);
  const city = [...cityCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const area = location ? locationAreaName(location) : null;
  const count = `${shops.length} shop${shops.length === 1 ? "" : "s"}`;

  return (
    <>
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">Shops</h1>
        <p className="mt-1 text-sm text-ink-600" data-testid="shop-count">
          {location ? (
            <>
              {count} {nearOnly ? "near" : "listed · your location is"}{" "}
              <strong className="font-semibold text-ink-900">{shortLocationLabel(location)}</strong> ·{" "}
              <OpenLocationButton>Change location</OpenLocationButton>
            </>
          ) : (
            <>
              {count} · <OpenLocationButton>Choose your location</OpenLocationButton> to see the ones near you
            </>
          )}
        </p>
      </div>

      <ShopFilters
        types={types}
        showOpenNow={narrows(scope.filter((s) => s.open).length)}
        showDeliversToMe={narrows(scope.filter((s) => s.delivers).length)}
      />

      <ShopGrid
        shops={shops}
        toolbar={shops.length > 1 ? <ShopSortSelect value={sort} hasLocation={Boolean(location)} /> : null}
        viewToggle={shops.length > 0}
        inviteArea={nearOnly && !filtered && shops.length < INVITE_BELOW ? (area ?? true) : null}
        empty={
          <EmptyState
            title={filtered ? "No shops match these filters." : "No shops found."}
            description={filtered ? "Try a different name, or clear the filters to see every shop here." : undefined}
            action={
              filtered ? (
                <LinkButton href={params.all === "1" ? "/shops?all=1" : "/shops"} variant="secondary">
                  Clear filters
                </LinkButton>
              ) : undefined
            }
          />
        }
      />

      {location ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cream-200 bg-slate-50 px-4 py-3">
          <p className="text-sm text-ink-700">
            {nearOnly
              ? `Not finding what you need nearby? Widen the search to ${city ? `all of ${city}` : "every shop on GoKesari"}.`
              : `Showing shops beyond your area${params.city ? ` in ${params.city}` : ""}.`}
          </p>
          <Link
            href={nearOnly ? `/shops?all=1${city ? `&city=${encodeURIComponent(city)}` : ""}` : "/shops"}
            className="tap-target whitespace-nowrap rounded-lg border border-cream-200 bg-white px-3.5 py-2 text-sm font-medium text-ink-900 hover:bg-cream-100"
          >
            {nearOnly ? (city ? `Show all ${city} shops` : "Show all shops") : `Only shops near ${area ?? "me"}`}
          </Link>
        </div>
      ) : null}
    </>
  );
}
