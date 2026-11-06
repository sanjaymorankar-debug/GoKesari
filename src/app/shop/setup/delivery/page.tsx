import { redirect } from "next/navigation";

import { DeliveryChoiceForm } from "@/components/seller/delivery-choice-form";
import { tr, UI } from "@/lib/board/i18n";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "How you deliver" };
export const dynamic = "force-dynamic";

/** "How you deliver" (onboarding Phase 2, WP3) — reached from the wizard's last screen and the set-up checklist. */
export default async function ShopDeliverySetupPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop/register");
  const shop = await activeShop(shops);
  const lang = await getBoardLang();
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">{tr(UI.deliveryTitle, lang)}</h1>
        <p className="text-sm text-ink-600">{tr(UI.deliveryIntro, lang)}</p>
      </div>
      <DeliveryChoiceForm lang={lang} shopId={shop.id} choice={shop.deliveryChoice} radiusKm={shop.serviceRadiusKm} />
    </div>
  );
}
