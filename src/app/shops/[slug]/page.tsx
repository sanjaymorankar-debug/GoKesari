import { notFound } from "next/navigation";
import Link from "next/link";

import { ProductGrid } from "@/app/page";
import { RatingBadge } from "@/components/rating-actions";
import { Badge, Card, ClassificationBadge, EmptyState, PageHeader } from "@/components/ui";
import { listShopReviews } from "@/server/services/ratings";
import { shopTypeLabel } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { getPublicShopBySlug, isShopOpenNow } from "@/server/services/shops";

export const dynamic = "force-dynamic";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const shop = await getPublicShopBySlug(slug);
  if (!shop) notFound();

  const user = await getCurrentUser();
  const [products, reviews] = await Promise.all([
    listStorefrontProducts({ shopId: shop.id, limit: 100 }),
    listShopReviews(shop.id, 5),
  ]);

  // Products are grouped by category, per §16 — generic across all 44 shop
  // types rather than assuming dairy/bakery.
  const byCategory = new Map<string, typeof products>();
  for (const product of products) {
    const key = product.categoryName;
    const group = byCategory.get(key);
    if (group) group.push(product);
    else byCategory.set(key, [product]);
  }
  const open = isShopOpenNow(shop);

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
          {reviews.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-ink-600" data-testid="shop-reviews">
              {reviews.slice(0, 5).map((review) => (
                <li key={review.id}>
                  <span className="text-kesari-500">{"★".repeat(review.score)}</span>
                  {review.comment ? <> &ldquo;{review.comment}&rdquo;</> : null}
                  <span className="text-xs text-ink-400"> — verified customer</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-sm text-ink-500">
            Owner / Proprietor: <span className="font-medium text-ink-700">{shop.ownerName}</span>
          </p>
          {shop.description ? (
            <p className="mt-1 text-sm text-ink-600">{shop.description}</p>
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
              </dd>
            </div>
          </dl>
        </div>
      </Card>

      {/*
        Full seller/contact disclosure (Consumer Protection (E-Commerce)
        Rules 2020, Rule 5) lives on its own page so this one stays focused
        on browsing and ordering — still one click away before purchase.
      */}
      <div className="mb-6">
        <Link
          href={`/shops/${shop.slug}/contact`}
          className="text-sm font-medium text-kesari-600 hover:underline"
        >
          Seller &amp; contact information →
        </Link>
      </div>

      {Array.from(byCategory.entries()).map(([categoryName, items]) => (
        <section key={categoryName} className="mb-8">
          <PageHeader title={categoryName} />
          <ProductGrid products={items} signedIn={Boolean(user)} />
        </section>
      ))}

      {products.length === 0 ? (
        <EmptyState
          title="This shop has not listed any products yet."
          description="Check back soon."
        />
      ) : null}
    </>
  );
}
