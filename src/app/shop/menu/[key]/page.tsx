import { notFound, redirect } from "next/navigation";

import { MenuHub } from "@/components/board/menu-hub";
import { SHOP_MENUS, visibleMenus } from "@/lib/board/menus";
import { getCurrentUser } from "@/server/authz/guards";
import { loadShopBoard } from "@/server/board-data";
import { getBoardLang } from "@/server/board-lang";
import { listShopsForOwner } from "@/server/services/shops";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return { title: SHOP_MENUS.find((m) => m.key === key)?.label.en ?? "My Shop" };
}

/** A shop owner tile's menu page: every function of that area, with live counts. */
export default async function ShopMenuPage({ params }: { params: Promise<{ key: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];
  const { key } = await params;

  const menu = visibleMenus(SHOP_MENUS, user.role, { shopSlug: shop.slug }, "shop").find((m) => m.key === key);
  if (!menu) notFound();

  const [lang, data] = await Promise.all([getBoardLang(), loadShopBoard(shop.id, user)]);
  return (
    <MenuHub
      lang={lang}
      menu={menu}
      counts={data.counts}
      ticks={{ bankVerified: data.facts.bankVerified, shopVerified: data.facts.shopVerified }}
      boardHref="/shop"
    />
  );
}
