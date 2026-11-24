import { redirect } from "next/navigation";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";

import { ShopOffersManager } from "@/components/shop-offers-manager";
import { PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRule } from "@/server/services/settings";
import { listShopOffers, offerTargetsForShop } from "@/server/services/shop-offers";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Offers" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Offers", "ऑफ़र", "ऑफर"),
  description: L(
    "{shop} — discounts on a product or a whole category for set dates. Customers see them on your shop page and pay the offer price.",
    "{shop} — तय तारीखों के लिए किसी उत्पाद या पूरी श्रेणी पर छूट। ग्राहक इन्हें आपकी दुकान के पेज पर देखते हैं और ऑफ़र की कीमत चुकाते हैं।",
    "{shop} — ठरलेल्या तारखांसाठी एखाद्या उत्पादनावर किंवा संपूर्ण श्रेणीवर सूट. ग्राहकांना ती तुमच्या दुकानाच्या पानावर दिसते आणि ते ऑफरची किंमत देतात.",
  ),
} as const;

/** F8: the shop owner's own offers, shown on the shop page and applied in the cart. */
export default async function ShopOffersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.MARKETING_MANAGE_OWN)) redirect("/");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);
  const [rows, targets, rule] = await Promise.all([listShopOffers(shop.id), offerTargetsForShop(shop.id), getRule("shopOffers")]);
  const lang = await getBoardLang();
  return (
    <>
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang).replace("{shop}", shop.name)}
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
