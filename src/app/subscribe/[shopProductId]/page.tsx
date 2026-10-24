import { notFound, redirect } from "next/navigation";

import { SubscribeForm } from "@/components/subscribe-form";
import { PageHeader } from "@/components/ui";
import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { listAddresses } from "@/server/services/addresses";
import { getShopProduct } from "@/server/services/catalogue";
import { getShopById } from "@/server/services/shops";
import { getWalletByUserId } from "@/server/services/wallet";

export const metadata = { title: "Subscribe" };
export const dynamic = "force-dynamic";

export default async function SubscribePage({
  params,
}: {
  params: Promise<{ shopProductId: string }>;
}) {
  const user = await getCurrentUser();
  const { shopProductId } = await params;
  if (!user) redirect(`/signin?next=/subscribe/${shopProductId}`);

  const shopProduct = await getShopProduct(shopProductId);
  if (!shopProduct) notFound();

  const [shop, wallet, addresses] = await Promise.all([
    getShopById(shopProduct.shopId),
    getWalletByUserId(user.id),
    listAddresses(user.id),
  ]);
  if (!shop || shop.status !== "APPROVED") notFound();

  // A subscription is a repeating online purchase, so it needs an online price.
  if (!shopProduct.product.subscribable || !shopProduct.onlineSaleEnabled) {
    notFound();
  }

  const today = todayIn(getEnv().APP_TIMEZONE);

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title={`Subscribe to ${shopProduct.product.name}`}
        description={`Delivered from ${shop.name}`}
      />
      <SubscribeForm
        shopProductId={shopProductId}
        productName={shopProduct.product.name}
        unit={shopProduct.product.unit}
        unitSizeMilli={shopProduct.product.unitSizeMilli}
        unitPricePaise={shopProduct.onlinePricePaise ?? 0}
        walletBalancePaise={wallet?.balancePaise ?? 0}
        defaultStartDate={addDays(today, 1)}
        minDate={today}
        // TC-SUB-013: the drop address for every delivery (the default is pre-selected).
        addresses={addresses.map((a) => ({
          id: a.id,
          label: a.label,
          line1: a.line1,
          area: a.area,
          city: a.city,
          pincode: a.pincode,
          isDefault: a.isDefault,
        }))}
      />
    </div>
  );
}
