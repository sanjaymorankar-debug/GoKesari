import { redirect } from "next/navigation";

import { CodDepositForm } from "@/components/growth-actions";
import { Card, EmptyState, Money, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getCodLimits, listCodCashHeld } from "@/server/services/cod";

export const metadata = { title: "Cash on delivery" };
export const dynamic = "force-dynamic";

/**
 * COD cash held by riders and shops (GS-030). Record a deposit when cash is
 * handed over; anything still held is deducted in the next weekly payout or
 * settlement automatically.
 */
export default async function CodPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.COD_CASH_MANAGE)) redirect("/");
  const [holders, codLimits] = await Promise.all([listCodCashHeld(), getCodLimits()]);
  const total = holders.reduce((sum, h) => sum + h.heldPaise, 0);

  return (
    <>
      <PageHeader
        title="Cash on delivery"
        description={
          <>
            <Money paise={total} /> held. Limits: <Money paise={codLimits.maxOrderPaise} /> per order,{" "}
            {codLimits.maxOpenOrders} open COD orders per customer, paused after {codLimits.maxFailures} failed COD deliveries in{" "}
            {codLimits.failureWindowDays} days.
          </>
        }
      />
      {holders.length === 0 ? (
        <EmptyState title="No cash waiting to be handed over." />
      ) : (
        <Card className="divide-y divide-cream-100" data-testid="cod-holders">
          {holders.map((h) => (
            <div key={`${h.party}:${h.id}`} className="flex flex-wrap items-end justify-between gap-3 p-3 text-sm">
              <div>
                <p className="font-medium text-ink-900">
                  {h.name} <span className="text-xs text-ink-500">({h.party === "RIDER" ? "rider" : "shop"})</span>
                </p>
                <p className="text-xs text-ink-500">
                  Holds <Money paise={h.heldPaise} /> from {h.orders} orders
                </p>
              </div>
              <CodDepositForm party={h.party} id={h.id} heldPaise={h.heldPaise} />
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
