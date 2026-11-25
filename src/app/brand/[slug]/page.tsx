import Link from "next/link";
import { notFound } from "next/navigation";

import { Pager, paginate } from "@/components/board/list-tabs";
import { ProductGrid } from "@/components/product-grid";
import { SafeImage } from "@/components/safe-image";
import { EmptyState, PageHeader, Section } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { BBF } from "@/lib/brand-barcode-favourites-i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { getPublicBrandBySlug } from "@/server/services/brands";
import { getCartLineQuantities } from "@/server/services/cart";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { favouritesOn } from "@/server/services/favourites-flag";
import { nearbyOfferCounts } from "@/server/services/home-discovery";
import { serviceableShopIds } from "@/server/services/serviceability";

export const dynamic = "force-dynamic";

/**
 * A brand's products (docs/search-brand-barcode-favourites-2026-11): every Live listing of the brand,
 * from shops that deliver to the customer when they have a location (`?all=1` for every shop), nearest
 * first. Not found while the flag brand_barcode_favourites_enabled is off, or for an inactive brand.
 */
export default async function BrandPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ all?: string; page?: string }>;
}) {
  if (!(await favouritesOn())) notFound();
  const [{ slug }, { all, page: pageParam }, lang, user] = await Promise.all([params, searchParams, getBoardLang(), getCurrentUser()]);
  const brand = await getPublicBrandBySlug(decodeURIComponent(slug));
  if (!brand) notFound();

  const location = await getCustomerLocation(user?.id);
  const nearOnly = Boolean(location) && all !== "1";
  const distances = location ? await serviceableShopIds(location) : undefined;
  const shopIds = nearOnly && distances ? [...distances.keys()] : undefined;
  const [products, cartLines] = await Promise.all([
    listStorefrontProducts({ brandId: brand.id, shopIds, limit: 100 }),
    user ? getCartLineQuantities(user.id) : null,
  ]);
  if (distances) {
    const km = (id: string) => distances.get(id) ?? Number.POSITIVE_INFINITY;
    products.sort((a, b) => km(a.shopId) - km(b.shopId));
  }
  const page = paginate(products, pageParam, 12);
  const base = `/brand/${encodeURIComponent(brand.slug)}${all === "1" ? "?all=1" : ""}`;
  const compareCounts = distances ? await nearbyOfferCounts(page.rows.map((p) => p.productId), [...distances.keys()]) : undefined;

  return (
    <>
      <PageHeader
        title={brand.name}
        description={brand.description ?? undefined}
        action={brand.logoUrl ? <SafeImage src={brand.logoUrl} alt={brand.name} className="h-14 w-14 rounded-xl bg-white object-contain" /> : undefined}
      />
      {location ? (
        <p className="mb-4 text-xs text-ink-500">
          {nearOnly ? "Showing only shops that deliver to you. " : "Showing all shops. "}
          <Link prefetch={false} href={`/brand/${encodeURIComponent(brand.slug)}${nearOnly ? "?all=1" : ""}`} className="font-medium text-kesari-600 hover:underline">
            {nearOnly ? "Show all shops" : "Only shops that deliver to me"}
          </Link>
        </p>
      ) : null}
      <Section title={tr(BBF.brandProductsTitle, lang)}>
        {products.length > 0 ? (
          <>
            <div data-testid="brand-products">
              <ProductGrid products={page.rows} signedIn={Boolean(user)} cartLines={cartLines} distances={distances} compareCounts={compareCounts} favourites />
            </div>
            <Pager lang={lang} page={page.page} pageCount={page.pageCount} hrefFor={(n) => `${base}${base.includes("?") ? "&" : "?"}page=${n}`} />
          </>
        ) : (
          <EmptyState title={tr(BBF.brandEmpty, lang)} testId="brand-empty" />
        )}
      </Section>
    </>
  );
}
