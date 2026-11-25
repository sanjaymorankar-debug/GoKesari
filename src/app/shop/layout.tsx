import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { SellerShell } from "@/components/seller/seller-shell";
import { SHOP_MENUS, visibleMenus } from "@/lib/board/menus";
import { packingSlipOrderId, REQUEST_PATH_HEADER, shopPageNeedsSignIn } from "@/lib/request-path";
import { groupSellerMenus } from "@/lib/seller/nav";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { loadShopCounts } from "@/server/board-data";
import { getBoardLang } from "@/server/board-lang";
import { findPackingSlip } from "@/server/packing-slip-page";
import type { UserRole } from "@/server/db/schema";
import { registrationFeeDue } from "@/server/services/registration-fee-payment";
import { unreadCount } from "@/server/services/notifications";
import { listUserRoles } from "@/server/services/roles";
import { listShopsForOwner } from "@/server/services/shops";
import { shopMenuFeatures } from "@/server/board-data";
import { RegistrationBanner } from "@/components/seller/registration-status";
import { ownerRegistrationStatus } from "@/server/services/shop-registration-subscription";

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
 *
 * D-131 / D-109: the two answers a page cannot give once it streams behind
 * loading.tsx are given here first — a signed-out visitor gets a real redirect
 * to sign-in, and a packing slip that does not exist a real 404.
 */
export default async function SellerCentralLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const path = (await headers()).get(REQUEST_PATH_HEADER) ?? "";
  if (!user && shopPageNeedsSignIn(path)) redirect("/signin");
  const slipOrderId = user ? packingSlipOrderId(path) : null;
  if (slipOrderId && !(await findPackingSlip(slipOrderId))) notFound();
  const [lang, shops, roles, unread] = await Promise.all([
    getBoardLang(),
    user ? listShopsForOwner(user.id).catch(() => []) : Promise.resolve([]),
    user ? listUserRoles(user.id).catch(() => [user.role]) : Promise.resolve([] as UserRole[]),
    user ? unreadCount(user.id).catch(() => 0) : Promise.resolve(0),
  ]);
  const shop = shops.length > 0 ? await activeShop(shops) : null;
  const counts = shop ? await loadShopCounts(shop.id).catch(() => ({})) : {};
  const features = user && shop ? await shopMenuFeatures(shop) : [];
  const groups = user && shop ? groupSellerMenus(visibleMenus(SHOP_MENUS, user.role, { shopSlug: shop.slug, features }, "shop")) : [];
  // 0205 registration subscription: red (unpaid / grace / expired) or amber (expiring) banner on every screen until paid.
  const registration =
    user && shop && (shop.status === "APPROVED" || shop.status === "PENDING_APPROVAL" || shop.status === "SUSPENDED") ? await ownerRegistrationStatus(shop) : null;

  return (
    <SellerShell
      lang={lang}
      user={user ? { name: user.name, email: user.email, role: user.role } : null}
      roles={roles}
      unreadCount={unread}
      shop={shop ? { id: shop.id, name: shop.name, slug: shop.slug, status: shop.status, feeDue: registrationFeeDue(shop) > 0 } : null}
      shops={shops.map((s) => ({ id: s.id, name: s.name }))}
      groups={groups}
      counts={counts}
      banner={<RegistrationBanner view={registration} />}
    >
      {children}
    </SellerShell>
  );
}
