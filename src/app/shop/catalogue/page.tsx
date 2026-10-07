import { redirect } from "next/navigation";

import { PhotoCatalogue } from "@/components/photo-catalogue";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { needsPhoto, needsPrice } from "@/lib/photo-catalogue";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopPhotoCatalogue } from "@/server/services/product-images";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Photo catalogue" };
export const dynamic = "force-dynamic";

/**
 * The shop owner's photo catalogue: each product with its photo and price, as
 * customers see them. Photos are added and prices set from the tiles; both go
 * through the same APIs (and checks) as the rest of the shop pages.
 */
export default async function ShopCataloguePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];

  const tiles = await listShopPhotoCatalogue(shop.id);
  const withPhoto = tiles.length - tiles.filter(needsPhoto).length;
  const withoutPrice = tiles.filter(needsPrice).length;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Photo catalogue"
        description={
          tiles.length === 0
            ? `${shop.name} — your products, each with its photo and price.`
            : `${shop.name} — ${withPhoto} of ${tiles.length} products have a photo${withoutPrice > 0 ? `, ${withoutPrice} still need a price` : ""}. Customers see the same photo and price on your shop page.`
        }
        action={
          <div className="flex flex-wrap gap-2">
            {shop.status === "APPROVED" ? (
              <LinkButton href={`/shops/${shop.slug}`} variant="secondary">
                View my shop page
              </LinkButton>
            ) : null}
            <LinkButton href="/shop" variant="secondary">
              Back to my shop
            </LinkButton>
          </div>
        }
      />
      {tiles.length === 0 ? (
        <EmptyState
          title="No products yet"
          description="Add products to your shop first; each one then appears here for its photo and price."
          action={<LinkButton href="/shop">Add products</LinkButton>}
        />
      ) : (
        <PhotoCatalogue tiles={tiles} />
      )}
    </div>
  );
}
