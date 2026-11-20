import Link from "next/link";
import { redirect } from "next/navigation";

import { PujaShopManager } from "@/components/puja/puja-shop-manager";
import { EmptyState, PageHeader } from "@/components/ui";
import { shopTypeLabel } from "@/lib/shop-types";
import { PUJA_SHOP_TYPE_KEY } from "@/lib/puja";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Puja Samagri — my shop" };
export const dynamic = "force-dynamic";

const TABS = ["setup", "browse", "create", "removed", "prices"] as const;

/**
 * Shop owner's Puja Samagri & Temple Supplies screen (docs/puja-samagri-2026-11, brief §5):
 * take the master catalogue (stock 100, deselect first), browse and add, create own product
 * types and products, restore removed products, answer price requests.
 */
export default async function ShopPujaPage({ searchParams }: { searchParams: Promise<{ shop?: string; tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/shop/puja");
  const params = await searchParams;
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="Puja Samagri" />
        <EmptyState title="You haven't registered a shop yet" />
        <p className="mt-3 text-center text-sm">
          <Link className="font-semibold text-kesari-800 underline" href="/shop/register">
            Register a Puja Samagri shop
          </Link>
        </p>
      </>
    );
  }
  const shop = await activeShop(shops, params.shop);
  const tab = (TABS as readonly string[]).includes(params.tab ?? "") ? (params.tab as (typeof TABS)[number]) : "setup";
  const suffix = shops.length > 1 ? `?shop=${shop.id}` : "";
  return (
    <div className="mx-auto max-w-6xl space-y-3">
      <PageHeader
        title="🪔 Puja Samagri & Temple Supplies"
        description={`${shop.name} · ${shop.shopType === PUJA_SHOP_TYPE_KEY ? "Puja Samagri shop" : `${shopTypeLabel(shop.shopType)} — Puja Samagri as an added type`}`}
      />
      <PujaShopManager shopId={shop.id} initialTab={tab} myProductsHref={`/shop/my-products${suffix}`} bulkHref="/shop/product-import" />
    </div>
  );
}
