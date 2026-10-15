import { SellerShell } from "@/components/seller/seller-shell";
import { SHOP_MENUS, visibleMenus } from "@/lib/board/menus";
import { groupSellerMenus } from "@/lib/seller/nav";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { loadShopCounts } from "@/server/board-data";
import { getBoardLang } from "@/server/board-lang";
import type { UserRole } from "@/server/db/schema";
import { unreadCount } from "@/server/services/notifications";
import { listUserRoles } from "@/server/services/roles";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = {
  title: { default: "Seller Central", template: "%s · GoKesari Seller Central" },
};

/**
 * GoKesari Seller Central: every shop owner page (/shop/…) — registration,
 * the seller home, orders, catalogue, payments, growth and account tools —
 * opens in the seller portal's own frame instead of the shopping site's.
 * Each page still runs its own sign-in and permission checks; this layout
 * only reads what the frame shows, each part best-effort. An owner with
 * several shops picks one in the top bar (src/lib/seller/active-shop.ts).
 */
export default async function SellerCentralLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const [lang, shops, roles, unread] = await Promise.all([
    getBoardLang(),
    user ? listShopsForOwner(user.id).catch(() => []) : Promise.resolve([]),
    user ? listUserRoles(user.id).catch(() => [user.role]) : Promise.resolve([] as UserRole[]),
    user ? unreadCount(user.id).catch(() => 0) : Promise.resolve(0),
  ]);
  const shop = shops.length > 0 ? await activeShop(shops) : null;
  const counts = shop ? await loadShopCounts(shop.id).catch(() => ({})) : {};
  const groups = user && shop ? groupSellerMenus(visibleMenus(SHOP_MENUS, user.role, { shopSlug: shop.slug }, "shop")) : [];

  return (
    <SellerShell
      lang={lang}
      user={user ? { name: user.name, email: user.email, role: user.role } : null}
      roles={roles}
      unreadCount={unread}
      shop={shop ? { id: shop.id, name: shop.name, slug: shop.slug, status: shop.status } : null}
      shops={shops.map((s) => ({ id: s.id, name: s.name }))}
      groups={groups}
      counts={counts}
    >
      {children}
    </SellerShell>
  );
}
