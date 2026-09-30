import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { ProductImagesManager } from "@/components/product-images-manager";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { products, shopProducts, shops } from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { listImages } from "@/server/services/product-images";

export const metadata = { title: "Product photos" };
export const dynamic = "force-dynamic";

/**
 * Photos for one listing. `id` is the shop listing (SKU). The owner manages the
 * listing's own photos; catalogue staff — and the shop that created the product —
 * can also manage the product-wide photos every shop shows by default.
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
  const view = (i: (typeof listing)[number]) => ({ id: i.id, url: i.url, altText: i.altText, isPrimary: i.isPrimary });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={`Photos — ${row.product.name}`}
        description={`${row.shop.name}. A photo set on this listing is what your customers see; without one, the product's own photos are used.`}
        action={<LinkButton href="/shop" variant="secondary">Back to my shop</LinkButton>}
      />
      <ProductImagesManager
        productId={row.product.id}
        shopProductId={row.sp.id}
        images={listing.map(view)}
        max={limits.maxPerProduct}
        title="This shop's photos"
        hint="Shown for your listing only."
      />
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
