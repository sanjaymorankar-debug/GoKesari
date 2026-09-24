import Link from "next/link";

import { LocationBar } from "@/components/location-bar";
import { Card, PageHeader } from "@/components/ui";
import { ShopGrid } from "@/components/shop-grid";
import { SHOP_TYPES, type ShopTypeKey } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { serviceableShopIds } from "@/server/services/serviceability";
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
  delivery?: string;
  /** "1" = ignore the customer's location and list every shop. */
  all?: string;
};

/** Shop search with the §15 filter set. Filters live in the URL, so results are shareable. */
export default async function ShopsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);
  // With a location chosen, list only shops that deliver there, nearest
  // first (GS-019); `all=1` restores the unfiltered directory.
  const nearOnly = Boolean(location) && params.all !== "1";
  const distances = location ? await serviceableShopIds(location) : undefined;

  const found = await searchShops({
    ids: nearOnly && distances ? [...distances.keys()] : undefined,
    query: params.q || undefined,
    city: params.city || undefined,
    area: params.area || undefined,
    pincode: params.pincode || undefined,
    shopType: (params.type as ShopTypeKey) || undefined,
    classification: (params.classification as "KESARI" | "GREEN") || undefined,
    deliveryOnly: params.delivery === "true",
    limit: 48,
  });
  const shops = found
    .map((shop) => ({ ...shop, distanceKm: distances?.get(shop.id) ?? null }))
    .sort(
      (a, b) =>
        (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY),
    );
  const toggleParams = new URLSearchParams(
    Object.entries(params).filter(([key, value]) => key !== "all" && value) as [string, string][],
  );
  if (nearOnly) toggleParams.set("all", "1");

  return (
    <>
      <PageHeader
        title="Shops"
        description={`${shops.length} approved shop${shops.length === 1 ? "" : "s"} found`}
      />

      <LocationBar userId={user?.id ?? null} location={location} />
      {location ? (
        <p className="-mt-3 mb-6 text-xs text-ink-500">
          {nearOnly ? "Showing only shops that deliver to you. " : "Showing all shops. "}
          <Link href={`/shops?${toggleParams.toString()}`} className="font-medium text-kesari-600 hover:underline">
            {nearOnly ? "Show all shops" : "Only shops that deliver to me"}
          </Link>
        </p>
      ) : null}

      <Card className="mb-6 p-4">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {params.all === "1" ? <input type="hidden" name="all" value="1" /> : null}
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Shop name or area"
            aria-label="Shop name or area"
            className="rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none"
          />
          <input
            name="pincode"
            defaultValue={params.pincode ?? ""}
            placeholder="PIN code"
            aria-label="PIN code"
            inputMode="numeric"
            className="rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none"
          />
          <select
            name="type"
            defaultValue={params.type ?? ""}
            aria-label="Shop type"
            className="rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none"
          >
            <option value="">All shop types</option>
            {SHOP_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-ink-600">
            <input
              type="checkbox"
              name="delivery"
              value="true"
              defaultChecked={params.delivery === "true"}
              className="rounded border-cream-200"
            />
            Delivery available
          </label>

          <button
            type="submit"
            className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-700 sm:col-span-1"
          >
            Apply filters
          </button>
        </form>
      </Card>

      <ShopGrid shops={shops} />
    </>
  );
}
