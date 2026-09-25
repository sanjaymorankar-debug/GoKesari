import { redirect } from "next/navigation";

import { Card, EmptyState, Money, PageHeader, Section, StatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import {
  getShopPendingPayable,
  listOrderFinancialsForShop,
  listShopSettlements,
  resolveCommissionRate,
  SETTLEMENT_HOLD_DAYS,
} from "@/server/services/finance";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop Finance" };
export const dynamic = "force-dynamic";

/**
 * A shop owner's money view (NAV-010): what is owed for delivered orders not
 * yet settled, the commission rate that applies, per-order payable, and
 * weekly settlement statements with their bank references.
 */
export default async function ShopFinancePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SETTLEMENT_VIEW_OWN)) redirect("/");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];

  const [pending, rate, recent, settlements] = await Promise.all([
    getShopPendingPayable(shop.id),
    resolveCommissionRate(shop),
    listOrderFinancialsForShop(shop.id, 30),
    listShopSettlements({ shopId: shop.id, limit: 30 }),
  ]);

  return (
    <>
      <PageHeader
        title="Finance"
        description={`${shop.name} — commission ${(rate.rateBp / 100).toFixed(2)}% on goods; delivery fees go to the platform, which pays the rider.`}
      />

      <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-ink-500">Not yet settled</p>
          <p className="mt-1 text-xl font-bold text-ink-900"><Money paise={pending.netPaise} /></p>
          <p className="text-xs text-ink-400">{pending.orders} delivered orders</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Goods value</p>
          <p className="mt-1 text-xl font-bold text-ink-900"><Money paise={pending.goodsPaise} /></p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Commission</p>
          <p className="mt-1 text-xl font-bold text-ink-900"><Money paise={pending.commissionPaise} /></p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Refunds / adjustments</p>
          <p className="mt-1 text-xl font-bold text-ink-900">
            <Money paise={pending.refundsPaise + pending.adjustmentsPaise} />
          </p>
          <p className="text-xs text-ink-400">
            refunds <Money paise={pending.refundsPaise} /> · other <Money paise={pending.adjustmentsPaise} />
          </p>
        </Card>
      </section>

      <Section title="Settlements">
        <p className="mb-3 text-xs text-ink-500">
          Prepared weekly for orders delivered at least {SETTLEMENT_HOLD_DAYS} days earlier, then paid to your bank account.
        </p>
        {settlements.length === 0 ? (
          <EmptyState title="No settlements yet." />
        ) : (
          <Card className="divide-y divide-cream-100">
            {settlements.map(({ settlement: s }) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <p className="font-medium text-ink-900">Week from {s.periodStart}</p>
                  <p className="text-xs text-ink-500">
                    {s.orderCount} orders · goods <Money paise={s.goodsPaise} /> − commission <Money paise={s.commissionPaise} />
                    {s.refundsPaise !== 0 ? <> · refunds <Money paise={s.refundsPaise} /></> : null}
                    {s.adjustmentsPaise !== 0 ? <> · adjustments <Money paise={s.adjustmentsPaise} /></> : null}
                    {s.paymentReference ? ` · paid, ref ${s.paymentReference}` : ""}
                    {s.failureReason ? ` · ${s.failureReason}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={s.status} />
                  <span className="font-semibold"><Money paise={s.netPayablePaise} /></span>
                </div>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Delivered orders">
        {recent.length === 0 ? (
          <EmptyState title="No delivered orders yet." />
        ) : (
          <Card className="divide-y divide-cream-100">
            {recent.map(({ financial: f, orderNumber, settlementStatus }) => (
              <div key={f.orderId} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  {orderNumber}
                  <span className="ml-2 text-xs text-ink-500">
                    goods <Money paise={f.goodsPaise} /> · {(f.commissionRateBp / 100).toFixed(2)}% commission{" "}
                    <Money paise={f.commissionPaise} />
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-ink-500">
                    {settlementStatus ? `settlement ${settlementStatus.toLowerCase()}` : "not yet settled"}
                  </span>
                  <span className="font-semibold"><Money paise={f.shopPayablePaise} /></span>
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>
    </>
  );
}
