import { Card, Money } from "@/components/ui";

import type { CostRow } from "./types";

const Amount = ({ paise }: { paise: number | null }) =>
  paise == null ? (
    <span className="text-ink-500">—</span>
  ) : (
    <span className={paise < 0 ? "text-red-700" : undefined}>
      {paise < 0 ? "−" : ""}
      <Money paise={Math.abs(paise)} />
    </span>
  );

/** Delivery economics of recent delivered orders. Admin only — never shown to riders. */
export function CostTable({ rows }: { rows: CostRow[] }) {
  return (
    <section className="space-y-3" aria-labelledby="cost-heading">
      <h2 id="cost-heading" className="text-lg font-semibold text-ink-900">
        Delivery cost (admin only)
      </h2>
      <p className="text-sm text-ink-500">
        Recent delivered orders: what the customer and the shop paid for delivery, what the rider was paid, and the margin
        (customer fee + shop charge − rider payout).
      </p>
      <Card className="overflow-x-auto p-3">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-500">No delivered orders yet.</p>
        ) : (
          <table className="w-full text-left text-sm" data-testid="pay-plan-cost">
            <thead className="text-xs text-ink-500">
              <tr>
                <th className="py-1 pr-3">Order</th>
                <th className="py-1 pr-3 text-right">Customer delivery fee</th>
                <th className="py-1 pr-3 text-right">Shop delivery charge</th>
                <th className="py-1 pr-3 text-right">Rider payout</th>
                <th className="py-1 pr-3 text-right">Rider quote</th>
                <th className="py-1 text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.orderId} className="border-t border-cream-100">
                  <td className="py-1 pr-3">{r.orderNumber}</td>
                  <td className="py-1 pr-3 text-right"><Amount paise={r.customerDeliveryFeePaise} /></td>
                  <td className="py-1 pr-3 text-right"><Amount paise={r.shopDeliveryChargePaise} /></td>
                  <td className="py-1 pr-3 text-right"><Amount paise={r.riderPayoutPaise} /></td>
                  <td className="py-1 pr-3 text-right"><Amount paise={r.riderQuotePaise} /></td>
                  <td className="py-1 text-right font-medium"><Amount paise={r.marginPaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}
