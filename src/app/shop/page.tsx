import { redirect } from "next/navigation";

import { HashRedirect } from "@/components/board/hash-redirect";
import { ShopBoard, type ShopAlert } from "@/components/board/shop-board";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { tr, UI, type Lang } from "@/lib/board/i18n";
import { ONBOARDING_STAGE_LABELS, ownerNextAction } from "@/lib/shop-onboarding";
import { getCurrentUser } from "@/server/authz/guards";
import { loadShopBoard } from "@/server/board-data";
import { getBoardHeaderData } from "@/server/board-header-data";
import { getBoardLang } from "@/server/board-lang";
import { shopBankPrompt } from "@/server/services/bank-accounts";
import { getShopLegalStatus, type ShopLegalStatus } from "@/server/services/legal-documents";
import { getShopOnboarding, type ShopOnboarding } from "@/server/services/shop-onboarding";
import { getActiveSuspension } from "@/server/services/shop-suspension";
import { getShopWalletStatus } from "@/server/services/shop-wallet";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "My Shop" };
export const dynamic = "force-dynamic";

/** Links into the old long dashboard (`/shop#products`) → the section's own page. */
const OLD_SECTIONS: Record<string, string> = {
  "excel-upload": "/shop/manage/excel-upload",
  location: "/shop/manage/location",
  products: "/shop/manage/products",
  registration: "/shop/manage/registration",
};

/**
 * Shop owner home (§40, §50): the Tile Board — account alerts, "Do now" and
 * all sixteen menus on one screen. What the old dashboard held below the
 * board now lives on its own pages under /shop/manage, opened from the
 * board (Today's work, products, Excel upload, area, hours, GST & PAN…).
 */
export default async function ShopDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="My Shop" />
        <EmptyState
          title="You haven't registered a shop yet"
          description="Register your dairy or bakery to start selling online."
          action={<LinkButton href="/shop/register">Add my shop</LinkButton>}
        />
      </>
    );
  }

  const shop = shops[0];
  const [lang, header, board, suspension, onboarding, wallet, legalStatus, bankPrompt] = await Promise.all([
    getBoardLang(),
    getBoardHeaderData(user),
    loadShopBoard(shop.id, user),
    shop.status === "SUSPENDED" ? getActiveSuspension(shop.id) : Promise.resolve(null),
    shop.status === "PENDING_APPROVAL" ? getShopOnboarding([shop.id]).then((m) => m.get(shop.id)) : Promise.resolve(undefined),
    getShopWalletStatus(shop.id),
    getShopLegalStatus(shop.id),
    shopBankPrompt(shop.id),
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

  return (
    <>
      <HashRedirect map={OLD_SECTIONS} />
      <ShopBoard lang={lang} user={user} header={header} shop={{ name: shop.name, slug: shop.slug }} data={board} alerts={alerts} />
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
