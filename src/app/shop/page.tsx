import { redirect } from "next/navigation";

import { HashRedirect } from "@/components/board/hash-redirect";
import { RegisterOptions } from "@/components/seller/register-options";
import { SellerHome, type ShopAlert } from "@/components/seller/seller-home";
import { tr, UI, type Lang } from "@/lib/board/i18n";
import { SHOP_MENUS, visibleMenus } from "@/lib/board/menus";
import { groupSellerMenus } from "@/lib/seller/nav";
import { ONBOARDING_STAGE_LABELS, ownerNextAction } from "@/lib/shop-onboarding";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { loadShopBoard } from "@/server/board-data";
import { getBoardLang } from "@/server/board-lang";
import { defaultWindow, getMarketplaceKpis } from "@/server/services/analytics";
import { shopBankPrompt } from "@/server/services/bank-accounts";
import { getShopLegalStatus, type ShopLegalStatus } from "@/server/services/legal-documents";
import { isReferralRequired } from "@/server/services/referral-settings";
import { getRule } from "@/server/services/settings";
import { getShopOnboarding, type ShopOnboarding } from "@/server/services/shop-onboarding";
import { getActiveSuspension } from "@/server/services/shop-suspension";
import { getShopWalletStatus } from "@/server/services/shop-wallet";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: { absolute: "Seller Central · GoKesari" } };
export const dynamic = "force-dynamic";

/** Links into the old long dashboard (`/shop#products`) → the section's own page. */
const OLD_SECTIONS: Record<string, string> = {
  "excel-upload": "/shop/prices#excel-upload",
  location: "/shop/manage/location",
  products: "/shop/manage/products",
  registration: "/shop/manage/registration",
};

/**
 * Seller Central home (§40, §50): what needs doing first (account alerts),
 * today's order pipeline, the shop's numbers and account health, and every
 * seller tool grouped by job. Before a shop exists it is the start of
 * registration. The sections of the old long dashboard live on their own
 * pages under /shop/manage.
 */
export default async function ShopDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    const [selfService, referralRequired] = await Promise.all([
      getRule("selfRegistration").then((r) => r.enabled).catch(() => false),
      isReferralRequired("shop").catch(() => false),
    ]);
    return (
      <div data-testid="seller-welcome">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">Welcome to Seller Central</h1>
        <p className="mt-1 max-w-2xl text-ink-600">
          You haven&apos;t registered a shop yet. Choose how you&apos;d like to register — once your shop is set up, your
          orders, products, payments and every other seller tool will be here.
        </p>
        <div className="mt-6">
          <RegisterOptions selfService={selfService} referralRequired={referralRequired} signedIn />
        </div>
      </div>
    );
  }

  const shop = shops[0];
  const window = defaultWindow(30);
  const [lang, board, suspension, onboarding, wallet, legalStatus, bankPrompt, kpis] = await Promise.all([
    getBoardLang(),
    loadShopBoard(shop.id, user),
    shop.status === "SUSPENDED" ? getActiveSuspension(shop.id) : Promise.resolve(null),
    shop.status === "PENDING_APPROVAL" ? getShopOnboarding([shop.id]).then((m) => m.get(shop.id)) : Promise.resolve(undefined),
    getShopWalletStatus(shop.id),
    getShopLegalStatus(shop.id),
    shopBankPrompt(shop.id),
    // The shop's last 30 days for the performance card; best-effort, and only for owners who may see reports.
    can(user.role, PERMISSIONS.REPORT_VIEW_SHOP) ? getMarketplaceKpis({ ...window, shopId: shop.id }).catch(() => null) : Promise.resolve(null),
  ]);

  const alerts = shopAlerts(lang, {
    status: shop.status,
    suspensionReason: suspension?.reason ?? null,
    rejectionReason: shop.rejectionReason,
    onboarding,
    wallet,
    legalStatus,
    bankPrompt,
  });
  const docs = legalStatus.enabled ? legalStatus.documents : [];

  return (
    <>
      <HashRedirect map={OLD_SECTIONS} />
      <SellerHome
        lang={lang}
        userName={user.name}
        shop={{ name: shop.name, slug: shop.slug, status: shop.status }}
        alerts={alerts}
        counts={board.counts}
        facts={board.facts}
        kpis={kpis}
        legal={legalStatus.enabled ? { blocking: docs.filter((d) => d.blocking).length, dueSoon: docs.filter((d) => !d.blocking && (d.deadline || d.expiringSoon)).length } : null}
        groups={groupSellerMenus(visibleMenus(SHOP_MENUS, user.role, { shopSlug: shop.slug }, "shop"))}
      />
    </>
  );
}

/**
 * What the owner must act on, most serious first — the same conditions the
 * old dashboard's notices used, now on the first screen instead of below it.
 */
function shopAlerts(
  lang: Lang,
  s: {
    status: string;
    suspensionReason: string | null;
    rejectionReason: string | null;
    onboarding: ShopOnboarding | undefined;
    wallet: Awaited<ReturnType<typeof getShopWalletStatus>>;
    legalStatus: ShopLegalStatus;
    bankPrompt: Awaited<ReturnType<typeof shopBankPrompt>>;
  },
): ShopAlert[] {
  const out: ShopAlert[] = [];
  const today = "/shop/manage/today";
  if (s.status === "SUSPENDED") {
    out.push({ key: "suspended", tone: "danger", icon: "lock", title: tr(UI.shopSuspended, lang), detail: s.suspensionReason, action: tr(UI.details, lang), href: today });
  }
  if (s.status === "REJECTED") {
    out.push({ key: "rejected", tone: "danger", icon: "circle-alert", title: tr(UI.registrationRejected, lang), detail: s.rejectionReason, action: tr(UI.fixNow, lang), href: "/shop/register" });
  }
  const docs = s.legalStatus.enabled ? s.legalStatus.documents : [];
  const blocking = docs.filter((d) => d.blocking);
  if (s.wallet.enabled && !s.wallet.canAcceptOrders) {
    out.push({ key: "wallet", tone: "danger", icon: "wallet", title: tr(UI.rechargeWallet, lang), action: tr(UI.recharge, lang), href: "/shop/wallet" });
  }
  if (blocking.length > 0) {
    out.push({ key: "legal", tone: "danger", icon: "file-check", title: tr(UI.legalDocsDue, lang), detail: blocking.map((d) => d.label).join(", "), action: tr(UI.upload, lang), href: "/shop/legal-documents" });
  }
  if (s.status === "PENDING_APPROVAL") {
    const next = s.onboarding ? ownerNextAction(s.onboarding) : null;
    out.push({
      key: "approval",
      tone: "warning",
      icon: "clock",
      title: `${tr(UI.awaitingApproval, lang)}${s.onboarding ? ` — ${ONBOARDING_STAGE_LABELS[s.onboarding.stage].toLowerCase()}` : ""}`,
      detail: next?.text ?? null,
      action: next ? tr(UI.next, lang) : tr(UI.details, lang),
      href: next?.href ?? today,
    });
  }
  if (s.wallet.enabled && s.wallet.canAcceptOrders && s.wallet.lowBalance) {
    out.push({ key: "walletLow", tone: "warning", icon: "wallet", title: tr(UI.rechargeWallet, lang), action: tr(UI.recharge, lang), href: "/shop/wallet" });
  }
  const pending = docs.filter((d) => !d.blocking && (d.deadline || d.expiringSoon));
  if (blocking.length === 0 && pending.length > 0) {
    out.push({ key: "legalSoon", tone: "warning", icon: "file-check", title: tr(UI.legalDocsDue, lang), detail: pending.map((d) => d.label).join(", "), action: tr(UI.upload, lang), href: "/shop/legal-documents" });
  }
  if (s.bankPrompt && s.bankPrompt !== "VERIFIED") {
    out.push({ key: "bank", tone: "warning", icon: "landmark", title: tr(UI.addPayoutBank, lang), action: tr(UI.fixNow, lang), href: "/shop/bank-account" });
  }
  return out;
}
