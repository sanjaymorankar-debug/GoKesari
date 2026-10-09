import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { ProductImagesManager } from "@/components/product-images-manager";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { products, shopProducts, shops } from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { listImages } from "@/server/services/product-images";

export const metadata = { title: "Product photos" };
export const dynamic = "force-dynamic";

/**
 * Photos for one listing. `id` is the shop listing (SKU). The listing's own
 * photos and descriptions are edited on /shop/products/{id}/media (Module 1:
 * EXIF removed, WebP sizes, staff access); catalogue staff — and the shop that
 * created the product — manage the product-wide photos every shop shows by
 * default here.
 */
export default async function ListingImagesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [row] = await db
    .select({ sp: shopProducts, product: products, shop: shops })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(eq(shopProducts.id, id));
  if (!row) notFound();
  const staff = user.role === "OPERATOR" || user.role === "ADMIN";
  if (row.shop.ownerId !== user.id && !staff) notFound();
  const mayEditProduct = staff || row.product.createdBy === user.id;

  const [listing, master, limits] = await Promise.all([
    listImages(row.product.id, row.sp.id),
    listImages(row.product.id, null),
    getRule("images"),
  ]);
  if (!mayEditProduct) redirect(`/shop/products/${row.sp.id}/media`);
  const view = (i: (typeof listing)[number]) => ({
    id: i.id,
    url: i.url,
    altText: i.altText,
    isPrimary: i.isPrimary,
    moderationStatus: i.moderationStatus,
    rejectionReason: i.rejectionReason,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={`Photos — ${row.product.name}`}
        description={`${row.shop.name}. A photo set on this listing is what your customers see; without one, the product's own photos are used.`}
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/shop/catalogue" variant="secondary">Photo catalogue</LinkButton>
            <LinkButton href="/shop" variant="secondary">Back to my shop</LinkButton>
          </div>
        }
      />
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="text-sm">
          <p className="font-semibold text-ink-900">This shop&apos;s photos and description</p>
          <p className="text-ink-500">{listing.length} photo{listing.length === 1 ? "" : "s"} of your own. Shown for your listing only.</p>
        </div>
        <LinkButton href={`/shop/products/${row.sp.id}/media`}>Edit photos &amp; description</LinkButton>
      </Card>
      {mayEditProduct ? (
        <ProductImagesManager
          productId={row.product.id}
          shopProductId={null}
          images={master.map(view)}
          max={limits.maxPerProduct}
          title="Product photos (every shop)"
          hint="Used by any shop that has not set its own."
        />
      ) : null}
    </div>
  );
}
