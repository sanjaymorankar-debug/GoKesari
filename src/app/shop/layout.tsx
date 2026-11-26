import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { SellerShell } from "@/components/seller/seller-shell";
import { IdentityGraceBanner } from "@/components/seller/identity-grace-banner";
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
import { noteSellerIdentityPrompt } from "@/server/services/identity-verification";
import { shopMenuFeatures } from "@/server/board-data";
import { RegistrationBanner } from "@/components/seller/registration-status";
import { ownerRegistrationStatus } from "@/server/services/shop-registration-subscription";
import { SellerUndertakingGate } from "@/components/seller/seller-undertaking-gate";
import { sellerUndertakingGateApplies } from "@/server/services/seller-undertaking";
import { AgreementsGate } from "@/components/agreements/agreements-gate";
import { AGREEMENT_GATE_OPEN_PATHS, AGREEMENT_REASON_TEXT, AGREEMENTS_LATER_COOKIE } from "@/lib/seller-agreements";

/** Registration pages carry their own undertaking checkbox, so the gate never covers them. */
/** The first live shop (of at most five) whose owner must sign its agreements now. */
async function agreementsGateFor(shops: { id: string; status: string }[]) {
  const { getAgreementStatus } = await import("@/server/legal-agreements/requirements");
  for (const shop of shops.filter((s) => s.status === "APPROVED" || s.status === "SUSPENDED").slice(0, 5)) {
    const status = await getAgreementStatus(shop.id);
    if (status.required && status.reason && status.reason !== "REGISTRATION") {
      return { shopId: shop.id, shopName: status.shopName, graceUntil: status.graceUntil, overdue: status.overdue, reason: status.reason };
    }
  }
  return null;
}

function isRegistrationPath(path: string): boolean {
  return ["/shop/register", "/shop/join"].some((p) => path === p || path.startsWith(`${p}/`));
}

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
  // docs/seller-undertaking-2026-11: with the flag on, an owner who has not accepted the current
  // undertaking + Seller Terms sees the acknowledgement instead of any Seller Central page. Registration
  // (/shop/register, /shop/join) has its own checkboxes and is never blocked. Best-effort: an error never
  // locks an owner out.
  if (user && shops.length > 0 && !isRegistrationPath(path) && (await sellerUndertakingGateApplies(user.id).catch(() => false))) {
    return <SellerUndertakingGate ownerName={user.name} />;
  }
  // docs/seller-agreements-2026-11 (flag on): an existing shop that must sign (or re-confirm) its agreements gets a
  // blocking screen; postponable for the day during the grace period. Best-effort: an error never locks an owner out.
  if (user && shops.length > 0 && !AGREEMENT_GATE_OPEN_PATHS.some((p) => path.startsWith(p))) {
    const gate = await agreementsGateFor(shops).catch(() => null);
    if (gate) {
      const later = (await cookies()).get(AGREEMENTS_LATER_COOKIE)?.value;
      if (gate.overdue || later !== gate.shopId) {
        return <AgreementsGate shopId={gate.shopId} shopName={gate.shopName} graceUntil={gate.graceUntil} overdue={gate.overdue} reasonText={AGREEMENT_REASON_TEXT[gate.reason]} />;
      }
    }
  }
  const shop = shops.length > 0 ? await activeShop(shops) : null;
  const counts = shop ? await loadShopCounts(shop.id).catch(() => ({})) : {};
  const features = user && shop ? await shopMenuFeatures(shop) : [];
  const groups = user && shop ? groupSellerMenus(visibleMenus(SHOP_MENUS, user.role, { shopSlug: shop.slug, features }, "shop")) : [];
  // 0210 registration subscription: red (unpaid / grace / expired) or amber (expiring) banner on every screen until paid.
  const registration =
    user && shop && (shop.status === "APPROVED" || shop.status === "PENDING_APPROVAL" || shop.status === "SUSPENDED") ? await ownerRegistrationStatus(shop) : null;

  // docs/identity-verification-2026-11 (flag on): an unverified shop owner is asked here; the grace period starts once.
  const identity = user && shops.length > 0 ? await noteSellerIdentityPrompt(user.id).catch(() => null) : null;

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
      {identity?.required ? <IdentityGraceBanner graceEndsAt={identity.graceEndsAt} graceOver={identity.graceOver} /> : null}
      {children}
    </SellerShell>
  );
}
