import { redirect } from "next/navigation";

import { SetupChecklist } from "@/components/seller/setup-checklist";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getShopSetupChecklist } from "@/server/services/shop-setup-checklist";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Finish setting up your shop" };
export const dynamic = "force-dynamic";

/** "Finish set-up" on its own page (onboarding Phase B, G20) — the phone board links here. */
export default async function ShopSetupPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop/register");
  const shop = await activeShop(shops);
  const [lang, checklist] = await Promise.all([getBoardLang(), getShopSetupChecklist(shop)]);
  if (!checklist || checklist.complete) redirect("/shop");
  const slug = shop.status === "APPROVED" ? shop.slug : "";
  return (
    <div className="mx-auto max-w-3xl">
      <SetupChecklist lang={lang} checklist={checklist} shareHref={slug ? `/shops/${slug}` : null} />
    </div>
  );
}
