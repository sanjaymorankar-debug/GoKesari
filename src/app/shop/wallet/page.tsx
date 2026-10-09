import { redirect } from "next/navigation";

import { ShopWalletBanner } from "@/components/shop-wallet-banner";
import { ShopWalletTopUp } from "@/components/shop-wallet-topup";
import { Alert, Badge, Card, EmptyState, Money, PageHeader, Section } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getShopWalletView } from "@/server/services/shop-wallet";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop Wallet" };
export const dynamic = "force-dynamic";

const ENTRY_LABELS: Record<string, string> = {
  TOP_UP: "Recharge",
  COMMISSION: "Commission",
  DELIVERY_CHARGE: "Delivery charge",
  MANUAL_CREDIT: "Credit by GoKesari",
  MANUAL_DEBIT: "Debit by GoKesari",
  COMMISSION_REFUND: "Commission returned",
};

const dateTime = (d: Date) =>
  d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * The shop's prepaid wallet (docs/shop-wallet-delivery-otp-2026-10): balance,
 * the levels that matter, recharge, and every ledger entry with the order it
 * belongs to and the balance after it.
 */
export default async function ShopWalletPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SETTLEMENT_VIEW_OWN)) redirect("/");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];
  const wallet = await getShopWalletView(shop.id, { limit: 100 });

  return (
    <>
      <PageHeader
        title="Wallet"
        description={`${shop.name} — GoKesari's commission and delivery charge are deducted from this prepaid balance when an order is delivered.`}
      />

      {!wallet.enabled ? (
        <div className="mb-6">
          <Alert tone="info" title="Not switched on yet">
            Prepaid shop wallets are not in use yet. Commission is still taken from your weekly settlement, as shown on Finance.
          </Alert>
        </div>
      ) : (
        <ShopWalletBanner {...wallet} />
      )}

      <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-ink-500">Balance</p>
          <p className={`mt-1 text-xl font-bold ${wallet.balancePaise < 0 ? "text-red-700" : "text-ink-900"}`} data-testid="shop-wallet-balance">
            <Money paise={wallet.balancePaise} />
          </p>
          <p className="mt-1">
            {wallet.canAcceptOrders ? <Badge tone="success">accepting orders</Badge> : <Badge tone="danger">recharge to accept orders</Badge>}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Minimum to accept orders</p>
          <p className="mt-1 text-xl font-bold text-ink-900"><Money paise={wallet.minBalancePaise} /></p>
          <p className="text-xs text-ink-500">
            reminder below <Money paise={wallet.lowBalanceThresholdPaise} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Commission per delivered order</p>
          <p className="mt-1 text-xl font-bold text-ink-900">{(wallet.commissionRateBp / 100).toFixed(2)}%</p>
          <p className="text-xs text-ink-500">of the goods value</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Delivery charge</p>
          <p className="mt-1 text-xl font-bold text-ink-900">
            <Money paise={wallet.deliveryChargePerKmPaise} /> <span className="text-sm font-medium text-ink-500">per km</span>
          </p>
          <p className="text-xs text-ink-500">
            {wallet.deliveryChargePaise > 0 ? (
              <>
                plus <Money paise={wallet.deliveryChargePaise} /> per order,{" "}
              </>
            ) : null}
            shop to customer, for orders a GoKesari rider delivers (<Money paise={wallet.deliveryChargeUnknownDistancePaise} /> if the distance is not known)
          </p>
        </Card>
      </section>

      {wallet.enabled ? (
        <div className="mb-8">
          <ShopWalletTopUp shopId={shop.id} minPaise={wallet.topupMinPaise} maxPaise={wallet.topupMaxPaise} />
        </div>
      ) : null}

      <Section id="history" title="Wallet history">
        {wallet.transactions.length === 0 ? (
          <EmptyState title="No wallet entries yet." />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="shop-wallet-ledger">
              <thead className="bg-cream-50 text-left text-xs text-ink-500">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Entry</th>
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-right">Balance after</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-100">
                {wallet.transactions.map((t) => (
                  <tr key={t.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-500">{dateTime(t.createdAt)}</td>
                    <td className="px-3 py-2">{ENTRY_LABELS[t.type] ?? t.type}</td>
                    <td className="px-3 py-2">{t.orderNumber ?? "—"}</td>
                    <td className="px-3 py-2 text-ink-600">{t.reason}</td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-medium ${t.direction === "CREDIT" ? "text-leaf-700" : "text-red-700"}`}>
                      {t.direction === "CREDIT" ? "+" : "−"}
                      <Money paise={t.amountPaise} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <Money paise={t.balanceAfterPaise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>
    </>
  );
}
