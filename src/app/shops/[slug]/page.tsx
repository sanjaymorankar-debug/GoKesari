import { notFound } from "next/navigation";
import Link from "next/link";

import { ListTabs, Pager } from "@/components/board/list-tabs";
import { ProductGrid } from "@/components/product-grid";
import { RatingBadge } from "@/components/rating-badge";
import { Badge, Card, ClassificationBadge, EmptyState, PageHeader } from "@/components/ui";
import { listShopReviews } from "@/server/services/ratings";
import { shopTypeLabel } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCartLineQuantities } from "@/server/services/cart";
import { listStorefrontCategories, listStorefrontProducts } from "@/server/services/catalogue";
import { getLiveOffers, listLiveOffersForShop, priceWithOffers } from "@/server/services/shop-offers";
import { getPublicShopBySlug, isShopOpenNow } from "@/server/services/shops";
import { getCustomerLocation } from "@/server/location";
import { nearbyOfferCounts } from "@/server/services/home-discovery";
import { serviceableShopIds } from "@/server/services/serviceability";

export const dynamic = "force-dynamic";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Products a page, within one category. */
const PAGE_SIZE = 6;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const shop = await getPublicShopBySlug(slug);
  return { title: shop?.name ?? "Shop" };
}

/** Public shop profile (§16). Only APPROVED shops resolve — others 404. */
export default async function ShopPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cat?: string; page?: string }>;
}) {
  const [{ slug }, query, lang] = await Promise.all([params, searchParams, getBoardLang()]);
  const shop = await getPublicShopBySlug(slug);
  if (!shop) notFound();

  const [user, categories] = await Promise.all([getCurrentUser(), listStorefrontCategories(shop.id)]);
  // One category at a time, one page at a time, straight from the database: the
  // page used to load the first 100 products only, so a big shop's later
  // categories never appeared (TC-CAT-050).
  const activeEntry = categories.find((c) => c.categoryName === query.cat) ?? categories[0] ?? null;
  const pageCount = Math.max(1, Math.ceil((activeEntry?.count ?? 0) / PAGE_SIZE));
  // A page number out of range shows the nearest page.
  const page = Math.min(pageCount, Math.max(1, Math.floor(Number(query.page) || 1)));
  const [listed, reviews, liveOffers, offerRows, cartLines] = await Promise.all([
    activeEntry
      ? listStorefrontProducts({ shopId: shop.id, categoryId: activeEntry.categoryId, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      : [],
    listShopReviews(shop.id, 5),
    listLiveOffersForShop(shop.id),
    getLiveOffers([shop.id]),
    user ? getCartLineQuantities(user.id) : null,
  ]);
  // F8: live shop offers lower the online price shown (and charged in the cart).
  const products = listed.map((p) => {
    const priced = priceWithOffers(
      p.onlinePricePaise,
      { shopId: shop.id, shopProductId: p.shopProductId, categoryId: p.categoryId ?? "" },
      offerRows,
    );
    return priced.offer ? { ...p, offerPricePaise: priced.unitPricePaise, offerTitle: priced.offer.title } : p;
  });

  const open = isShopOpenNow(shop);
  // Products are grouped by category, per §16 — generic across all 44 shop
  // types rather than assuming dairy/bakery.
  const activeCategory = activeEntry?.categoryName ?? "";
  // docs/homepage-uiux-2026-10 (F4): "Compare N prices" when other nearby shops sell the same product.
  const location = await getCustomerLocation(user?.id).catch(() => null);
  const nearby = location ? await serviceableShopIds(location).catch(() => null) : null;
  const compareCounts = nearby ? await nearbyOfferCounts(products.map((p) => p.productId), [...nearby.keys()]) : undefined;

  return (
    <>
      <Card className="mb-6 overflow-hidden">
        <div className="h-28 bg-gradient-to-br from-kesari-100 via-cream-100 to-leaf-100" />
        <div className="p-6">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <ClassificationBadge value={shop.classification} />
            <Badge>{shopTypeLabel(shop.shopType)}</Badge>
            {open ? (
              <Badge tone="success">Open now</Badge>
            ) : (
              <Badge tone="danger">Closed</Badge>
            )}
            {shop.deliveryAvailable ? <Badge tone="info">Delivery</Badge> : null}
          </div>

          <h1 className="text-2xl font-semibold text-ink-900">{shop.name}</h1>
          <div className="mt-1">
            <RatingBadge avgX100={shop.ratingAvgX100} count={shop.ratingCount} />
          </div>
          <p className="mt-2 text-sm font-medium text-ink-700" data-testid="shop-delivery-line">
            {shop.deliveryAvailable
              ? `Delivery ₹${(shop.deliveryFeePaise / 100).toFixed(0)}${
                  shop.freeDeliveryAbovePaise ? `, free above ₹${(shop.freeDeliveryAbovePaise / 100).toFixed(0)}` : ""
                }`
              : "Pickup only"}
            {/* Shown before the cart refuses a smaller order (TC-DISC-013). */}
            {shop.minOrderPaise > 0 ? ` · Minimum order ₹${(shop.minOrderPaise / 100).toFixed(0)}` : null}
          </p>
          {/* Products first: address, hours, owner and reviews open on request (they used to fill the first screen). */}
          <details className="mt-2" data-testid="shop-info">
            <summary className="flex min-h-11 cursor-pointer items-center gap-1 text-sm font-semibold text-kesari-800">
              Shop info, opening hours and reviews
            </summary>
          {reviews.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-ink-600" data-testid="shop-reviews">
              {reviews.slice(0, 5).map((review) => (
                <li key={review.id}>
                  <span className="text-kesari-500">{"★".repeat(review.score)}</span>
                  {review.comment ? <> &ldquo;{review.comment}&rdquo;</> : null}
                  <span className="text-xs text-ink-500"> — verified customer</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-sm text-ink-500">
            Owner / Proprietor: <span className="font-medium text-ink-700">{shop.ownerName}</span>
          </p>
          {shop.description ? (
            // The owner's line breaks are kept (TC-FLD-055); React still escapes the text.
            <p className="mt-1 whitespace-pre-line text-sm text-ink-600">{shop.description}</p>
          ) : null}

          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-medium text-ink-700">Address</dt>
              <dd className="text-ink-500">
                {shop.addressLine1}
                {shop.addressLine2 ? `, ${shop.addressLine2}` : ""}
                <br />
                {[shop.area, shop.city].filter(Boolean).join(", ")} —{" "}
                {shop.pincode}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-ink-700">Opening hours</dt>
              <dd className="text-ink-500">
                {shop.openingHours.length === 0 ? (
                  "Not specified"
                ) : (
                  <ul>
                    {shop.openingHours.slice(0, 7).map((h) => (
                      <li key={h.day}>
                        {DAY_NAMES[h.day]}:{" "}
                        {h.closed ? "Closed" : `${h.open}–${h.close}`}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-ink-700">Delivery</dt>
              <dd className="text-ink-500">
                {shop.deliveryAvailable
                  ? `₹${(shop.deliveryFeePaise / 100).toFixed(0)} delivery fee${
                      shop.freeDeliveryAbovePaise
                        ? `, free above ₹${(shop.freeDeliveryAbovePaise / 100).toFixed(0)}`
                        : ""
                    }`
                  : "Pickup only"}
                {shop.minOrderPaise > 0 ? `; minimum order ₹${(shop.minOrderPaise / 100).toFixed(0)}` : null}
              </dd>
            </div>
          </dl>
          </details>
        </div>
      </Card>

      {/*
        Full seller/contact disclosure (Consumer Protection (E-Commerce)
        Rules 2020, Rule 5) lives on its own page so this one stays focused
        on browsing and ordering — still one click away before purchase.
      */}
      {liveOffers.length > 0 ? (
        <Card className="mb-6 border-leaf-200 bg-leaf-50 p-4" data-testid="shop-offers">
          <h2 className="mb-2 font-semibold text-ink-900">Offers</h2>
          <ul className="space-y-1 text-sm text-ink-700">
            {liveOffers.map((o) => (
              <li key={o.id}>
                <span className="font-medium">{o.title}</span> — {o.label} on {o.appliesTo}
                <span className="text-xs text-ink-500">
                  {" "}
                  · until {o.endsAt.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mb-6">
        <Link
          href={`/shops/${shop.slug}/contact`}
          className="text-sm font-medium text-kesari-600 hover:underline"
        >
          Seller &amp; contact information →
        </Link>
      </div>

      {categories.length > 0 ? (
        <section className="mb-8" data-testid="shop-products">
          {/* One category at a time, six products a page: the shop page used to list every product. */}
          {categories.length > 1 ? (
            <ListTabs
              label="Product categories"
              active={activeCategory}
              tabs={categories.map((c) => ({
                key: c.categoryName,
                label: c.categoryName,
                href: `/shops/${shop.slug}?cat=${encodeURIComponent(c.categoryName)}`,
                count: c.count,
              }))}
            />
          ) : (
            <PageHeader title={activeCategory} />
          )}
          <ProductGrid products={products} signedIn={Boolean(user)} cartLines={cartLines} compareCounts={compareCounts} />
          <Pager
            lang={lang}
            page={page}
            pageCount={pageCount}
            hrefFor={(n) => `/shops/${shop.slug}?cat=${encodeURIComponent(activeCategory)}&page=${n}`}
          />
        </section>
      ) : null}

      {categories.length === 0 ? (
        <EmptyState
          title="This shop has not listed any products yet."
          description="Check back soon."
        />
      ) : null}
    </>
  );
}
