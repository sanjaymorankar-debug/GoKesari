import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { ShopProductMediaEditor } from "@/components/shop-product-media-editor";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { shopProducts, shops } from "@/server/db/schema";
import { getListingMedia } from "@/server/services/shop-media";
import { catalogueAccessFor } from "@/server/services/shop-staff";

export const metadata = { title: "Photos & description" };
export const dynamic = "force-dynamic";

/**
 * Module 1 (docs/three-modules-2026-10): one shop product's photos and
 * descriptions, for the shop's owner, its staff and GoKesari support.
 * `id` is the shop listing (shop_products.id).
 */
export default async function ShopProductMediaPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [row] = await db
    .select({ shopId: shopProducts.shopId, shopName: shops.name })
    .from(shopProducts)
    .innerJoin(shops, eq(shops.id, shopProducts.shopId))
    .where(eq(shopProducts.id, id));
  if (!row) notFound();
  const via = await catalogueAccessFor(row.shopId, user);
  if (!via) notFound();

  const view = await getListingMedia(row.shopId, id);
  const back = via === "STAFF" ? `/shop/staff-access?shopId=${row.shopId}` : "/shop/catalogue";

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={view.listing.productName}
        description={
          <>
            {row.shopName} · code {view.listing.productCode}
            {view.listing.gtin ? ` · barcode ${view.listing.gtin}` : view.listing.barcode ? ` · barcode ${view.listing.barcode}` : ""}
          </>
        }
        action={
          <LinkButton href={back} variant="secondary">
            Back
          </LinkButton>
        }
      />
      <ShopProductMediaEditor shopId={row.shopId} initial={JSON.parse(JSON.stringify(view))} />
    </div>
  );
}
