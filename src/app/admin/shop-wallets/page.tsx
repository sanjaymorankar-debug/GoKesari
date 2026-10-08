import { redirect } from "next/navigation";

import { ShopWalletAdjustForm } from "@/components/shop-wallet-adjust-form";
import { Alert, Badge, Card, EmptyState, Money, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRule } from "@/server/services/settings";
import { listShopWallets } from "@/server/services/shop-wallet";

export const metadata = { title: "Shop wallets" };
export const dynamic = "force-dynamic";

/**
 * Every approved shop's prepaid wallet, lowest balance first, with a manual
 * credit / debit (rule shopWallet, docs/shop-wallet-delivery-otp-2026-10).
 * Administrators only: manual wallet entries are WALLET_ADJUST.
 */
export default async function ShopWalletsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.WALLET_ADJUST)) redirect("/");

  const [rules, wallets] = await Promise.all([getRule("shopWallet"), listShopWallets()]);

  return (
    <>
      <PageHeader
        title="Shop wallets"
        description="Prepaid balances that pay GoKesari's commission and delivery charge when an order is delivered. Levels and charges are set in Business rules → shopWallet; commission rates under Finance."
      />
      {!rules.enabled ? (
        <div className="mb-6">
          <Alert tone="info" title="Rule shopWallet is off">
            Nothing is charged to shop wallets and no shop is blocked from accepting orders until it is switched on.
          </Alert>
        </div>
      ) : null}
      {wallets.length === 0 ? (
        <EmptyState title="No approved shops yet." />
      ) : (
        <Card className="divide-y divide-cream-100">
          {wallets.map((w) => (
            <div key={w.shopId} className="space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-ink-900">{w.shopName}</span>
                <span className="flex items-center gap-2">
                  {w.belowMinimum ? <Badge tone="danger">below minimum</Badge> : null}
                  <span className={`font-semibold ${w.balancePaise < 0 ? "text-red-700" : ""}`}>
                    <Money paise={w.balancePaise} />
                  </span>
                </span>
              </div>
              <ShopWalletAdjustForm shopId={w.shopId} />
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
