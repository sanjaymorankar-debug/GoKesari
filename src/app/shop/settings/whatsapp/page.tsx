import { notFound, redirect } from "next/navigation";

import { ShopWhatsAppSettingsForm } from "@/components/shop-whatsapp-settings-form";
import { PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { listShopsForOwner } from "@/server/services/shops";
import { getShopWhatsAppSettings } from "@/server/whatsapp/shop-orders/contacts";
import { WHATSAPP_FLAG } from "@/server/whatsapp/shop-orders/state";

export const metadata = { title: "New orders on WhatsApp" };
export const dynamic = "force-dynamic";

/**
 * docs/smart-shopping-2026-11 (feature 3): the owner's WhatsApp order alerts —
 * on/off, their number and staff numbers, each shown "active on WhatsApp" or
 * "not on WhatsApp". Owner only (listShopsForOwner); 404 while the flag is off.
 */
export default async function ShopWhatsAppSettingsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops, (await searchParams).shop);
  if (!(await isFeatureEnabledForShop(WHATSAPP_FLAG, shop))) notFound();
  const settings = await getShopWhatsAppSettings(shop.id, user.id);
  return (
    <>
      <PageHeader
        title="New orders on WhatsApp"
        description={`${shop.name} — get each new order on WhatsApp with Accept and Reject buttons, plus updates when the customer cancels, a delivery partner is assigned and the order is delivered.`}
      />
      <ShopWhatsAppSettingsForm initial={settings} />
    </>
  );
}
