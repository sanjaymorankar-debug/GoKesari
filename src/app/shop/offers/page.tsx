import { redirect } from "next/navigation";

import { ShopOffersManager } from "@/components/shop-offers-manager";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRule } from "@/server/services/settings";
import { listShopOffers, offerTargetsForShop } from "@/server/services/shop-offers";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Offers" };
export const dynamic = "force-dynamic";

/** F8: the shop owner's own offers, shown on the shop page and applied in the cart. */
export default async function ShopOffersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.MARKETING_MANAGE_OWN)) redirect("/");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];
  const [rows, targets, rule] = await Promise.all([listShopOffers(shop.id), offerTargetsForShop(shop.id), getRule("shopOffers")]);
  return (
    <>
      <PageHeader
        title="Offers"
        description={`${shop.name} — discounts on a product or a whole category for set dates. Customers see them on your shop page and pay the offer price.`}
      />
      <ShopOffersManager
        shopId={shop.id}
        enabled={rule.enabled}
        products={targets.products}
        categories={targets.categories}
        rows={rows.map((r) => ({
          id: r.id,
          title: r.title,
          targetType: r.targetType,
          shopProductId: r.shopProductId,
          categoryId: r.categoryId,
          targetName: r.targetName,
          discountType: r.discountType,
          percent: r.percent,
          flatPaise: r.flatPaise,
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt.toISOString(),
          active: r.active,
        }))}
      />
    </>
  );
}
