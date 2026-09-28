import Link from "next/link";
import { notFound } from "next/navigation";

import { ProductGrid } from "@/app/page";
import { LocationBar } from "@/components/location-bar";
import { Badge, Card, EmptyState, Money, PageHeader, Section } from "@/components/ui";
import { formatQuantity, lineTotalPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { serviceableShopIds } from "@/server/services/serviceability";

export const dynamic = "force-dynamic";

/**
 * "All shops selling this product" + local price comparison (GS-021/022).
 *
 * Every offer is the same catalogue product (one canonical product id), so
 * pack size is identical across shops and prices compare like-for-like;
 * the per-unit price (per L, per kg…) is what shops set, and the pack price
 * is derived for display. External e-commerce prices are deliberately not
 * shown here (GS-023, Phase 2 — needs a lawful source, decision D7).
 */
export default async function ProductComparePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);
  const [offers, distances] = await Promise.all([
    listStorefrontProducts({ productId: id, limit: 100 }),
    location ? serviceableShopIds(location) : Promise.resolve(undefined),
  ]);
  if (offers.length === 0) notFound();

  const product = offers[0];
  const packMilli = product.unitSizeMilli;
  const mapped = offers.map((offer) => {
      const outOfStock = offer.trackInventory && offer.onlineStock <= 0;
      const buyable =
        offer.onlineSaleEnabled && offer.onlinePricePaise != null && offer.isAvailable && !outOfStock;
      return {
        offer,
        buyable,
        deliversHere: distances ? distances.has(offer.shopId) : null,
        distanceKm: distances?.get(offer.shopId) ?? null,
      };
    });
  type Row = (typeof mapped)[number];
  const rows = mapped.sort((a, b) => {
      // Buyable and delivering to the customer first, then cheapest, then nearest.
      const rank = (r: Row) => (r.buyable ? 0 : 2) + (r.deliversHere === false ? 1 : 0);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const price = (r: Row) => r.offer.onlinePricePaise ?? Number.POSITIVE_INFINITY;
      if (price(a) !== price(b)) return price(a) - price(b);
      return (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY);
    });
  const lowest = rows.find((r) => r.buyable && r.deliversHere !== false)?.offer.onlinePricePaise ?? null;
  const purchasable = rows
    .filter((r) => r.buyable && r.deliversHere !== false)
    .map((r) => r.offer);

  return (
    <>
      <PageHeader
        title={product.productName}
        description={`${product.categoryName} · sold by ${offers.length} shop${offers.length === 1 ? "" : "s"}`}
      />
      <LocationBar userId={user?.id ?? null} location={location} />

      <Section title="Compare prices">
        <Card className="divide-y divide-cream-200" data-testid="price-comparison">
          {rows.map(({ offer, buyable, deliversHere, distanceKm }) => (
            <div key={offer.shopProductId} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <Link
                  href={`/shops/${offer.shopSlug}`}
                  className="text-sm font-semibold text-ink-900 hover:text-kesari-700"
                >
                  {offer.shopName}
                </Link>
                <p className="text-xs text-ink-500">
                  {distanceKm != null ? `${distanceKm} km away · ` : null}
                  {deliversHere === false
                    ? "Does not deliver to your location"
                    : deliversHere
                      ? "Delivers to you"
                      : "Choose a location to check delivery"}
                </p>
              </div>
              <div className="flex items-center gap-3 text-right">
                {buyable && lowest != null && offer.onlinePricePaise === lowest ? (
                  <Badge tone="success">Lowest price</Badge>
                ) : null}
                {!buyable ? <Badge tone="warning">Not available online</Badge> : null}
                {offer.onlinePricePaise != null ? (
                  <div>
                    <p className="text-sm font-semibold text-ink-900">
                      <Money paise={offer.onlinePricePaise} />
                      <span className="text-xs font-normal text-ink-500"> / {offer.unit}</span>
                    </p>
                    {packMilli !== 1000 ? (
                      <p className="text-xs text-ink-500">
                        <Money paise={lineTotalPaise(offer.onlinePricePaise, packMilli)} /> per{" "}
                        {formatQuantity(packMilli, offer.unit)}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-xs text-ink-500">In-shop price only</p>
                )}
              </div>
            </div>
          ))}
        </Card>
      </Section>

      {purchasable.length > 0 ? (
        <Section title="Buy from">
          <ProductGrid products={purchasable} signedIn={Boolean(user)} distances={distances} compare={false} />
        </Section>
      ) : (
        <EmptyState
          title="No shop can deliver this to you online right now"
          description="Try another location, or visit one of the shops above."
        />
      )}
    </>
  );
}
