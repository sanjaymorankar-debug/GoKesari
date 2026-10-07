import Link from "next/link";
import { notFound } from "next/navigation";

import { MrpDisputeForm } from "@/components/mrp-dispute-form";
import { SafeImage } from "@/components/safe-image";
import { ProductGrid } from "@/components/product-grid";
import { LocationBar } from "@/components/location-bar";
import { Badge, Card, EmptyState, Money, PageHeader, Section } from "@/components/ui";
import { formatQuantity, lineTotalPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { getCartLineQuantities } from "@/server/services/cart";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { products } from "@/server/db/schema";
import { listReferencesForProduct } from "@/server/services/price-references";
import { galleryFor } from "@/server/services/product-images";
import { serviceableShopIds } from "@/server/services/serviceability";
import { listShopsForOwner } from "@/server/services/shops";
import { eq } from "drizzle-orm";

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
  const [offers, distances, cartLines] = await Promise.all([
    listStorefrontProducts({ productId: id, limit: 100 }),
    location ? serviceableShopIds(location) : Promise.resolve(undefined),
    user ? getCartLineQuantities(user.id) : null,
  ]);
  if (offers.length === 0) notFound();

  const product = offers[0];
  const packMilli = product.unitSizeMilli;

  // Three different numbers, kept apart: the printed MRP, each shop's price (compared below),
  // and external reference prices (shown only where the settings allow).
  const [master] = await db
    .select({ kind: products.kind, mrpPaise: products.mrpPaise, verification: products.mrpVerificationStatus })
    .from(products)
    .where(eq(products.id, id));
  const viewer = !user
    ? "CUSTOMER"
    : can(user.role, PERMISSIONS.PRICE_REFERENCE_MANAGE)
      ? "STAFF"
      : can(user.role, PERMISSIONS.SHOP_PRODUCT_MANAGE_OWN)
        ? "SHOP"
        : "CUSTOMER";
  const references = await listReferencesForProduct(id, viewer);
  const gallery = await galleryFor(id, null);
  const ownShop =
    user && can(user.role, PERMISSIONS.PRODUCT_MRP_DISPUTE) ? (await listShopsForOwner(user.id))[0] : undefined;
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

      <div className="mb-4 flex gap-3 overflow-x-auto" data-testid="product-gallery">
        {gallery.length === 0 ? (
          <SafeImage src={product.imageUrl} alt={product.productName} className="h-40 w-40 shrink-0 rounded-xl bg-cream-100 object-cover" />
        ) : (
          gallery.map((image) => (
            <SafeImage
              key={image.id}
              src={image.url}
              alt={image.altText ?? product.productName}
              className="h-40 w-40 shrink-0 rounded-xl bg-cream-100 object-cover"
            />
          ))
        )}
      </div>

      {master?.kind === "PACKAGED" && master.mrpPaise != null ? (
        <p className="mb-4 text-sm text-ink-600" data-testid="product-mrp">
          MRP <Money paise={master.mrpPaise} />
          {master.verification === "VERIFIED" ? null : <span className="text-ink-400"> (not yet verified)</span>}
          {ownShop ? (
            <span className="ml-3">
              <MrpDisputeForm productId={id} shopId={ownShop.id} />
            </span>
          ) : null}
        </p>
      ) : null}

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
                ) : offer.offlinePricePaise != null ? (
                  <p className="text-xs text-ink-500">In-shop price only</p>
                ) : (
                  <p className="text-sm font-medium text-ink-700">Price on request</p>
                )}
              </div>
            </div>
          ))}
        </Card>
      </Section>

      {references.length > 0 ? (
        <Section title="Reference prices">
          <Card className="divide-y divide-cream-200" data-testid="reference-prices">
            <p className="p-4 text-xs text-ink-500">
              Seen outside Gokesari. These are not the MRP and not any shop&apos;s selling price.
            </p>
            {references.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
                <span className="text-ink-700">
                  {r.sourceName}
                  {r.marketLocation ? ` · ${r.marketLocation}` : ""}
                  <span className="text-xs text-ink-500">
                    {" "}
                    · {new Date(r.referencedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
                    {r.verificationStatus !== "VERIFIED" ? ` · ${r.verificationStatus.toLowerCase()}` : ""}
                  </span>
                </span>
                <span className="font-semibold text-ink-900">
                  <Money paise={r.pricePaise} />
                  {r.unitBasis ? <span className="text-xs font-normal text-ink-500"> {r.unitBasis}</span> : null}
                </span>
              </div>
            ))}
          </Card>
        </Section>
      ) : null}

      {purchasable.length > 0 ? (
        <Section title="Buy from">
          <ProductGrid products={purchasable} signedIn={Boolean(user)} cartLines={cartLines} distances={distances} compare={false} />
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
