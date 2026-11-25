/**
 * docs/guest-checkout-2026-11: read-only reconciliation of multi-shop purchases — the group's online
 * payment against its shop orders: paid vs Σ child amounts, refunds per child (gateway and order
 * refunds), and each child's shop settlement. Finance / payment viewers only (FINANCE_VIEW or
 * PAYMENT_VIEW_ANY). 404 unless guest_cart_enabled and guest_checkout_enabled are both on.
 */
import { notFound, redirect } from "next/navigation";

import { Badge, Card, Money, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listGroupReconciliation, type ReconStatus } from "@/server/guest-checkout/reconciliation";
import { isGuestCheckoutOn } from "@/server/guest-checkout/tracking";

export const metadata = { title: "Order-group reconciliation" };
export const dynamic = "force-dynamic";

const TONE: Record<ReconStatus, "success" | "warning" | "danger" | "neutral"> = {
  MATCHED: "success",
  NOT_ONLINE: "neutral",
  NO_PAYMENT: "warning",
  AMOUNT_MISMATCH: "danger",
  REFUND_MISMATCH: "danger",
  DUPLICATE_PAYMENT: "danger",
};

export default async function OrderGroupReconciliationPage({ searchParams }: { searchParams: Promise<{ reference?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!(can(user.role, PERMISSIONS.FINANCE_VIEW) || can(user.role, PERMISSIONS.PAYMENT_VIEW_ANY))) redirect("/");
  if (!(await isGuestCheckoutOn())) notFound();
  const { reference } = await searchParams;
  const rows = await listGroupReconciliation({ reference: reference ?? null, limit: 50 });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Order-group reconciliation"
        description="Multi-shop purchases: the one online payment against the shop orders it paid for, refunds per shop order and each shop's settlement. Read-only."
      />
      <form className="flex gap-2" method="get">
        <input name="reference" defaultValue={reference ?? ""} placeholder="GK-20261123-AB12CD" className="w-64 rounded-lg border border-cream-200 px-3 py-2 text-sm" />
        <button className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white">Find</button>
      </form>
      {rows.length === 0 ? <Card className="p-4 text-sm text-ink-600">No order groups found.</Card> : null}
      {rows.map((g) => (
        <Card key={g.groupId} className="overflow-x-auto p-4" data-testid="recon-group">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold text-ink-900">{g.reference}</p>
              <p className="text-xs text-ink-500">
                {g.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })} · {g.customerEmail ?? "—"}
              </p>
            </div>
            <Badge tone={TONE[g.result.status]}>{g.result.status.replace(/_/g, " ").toLowerCase()}</Badge>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <dt className="text-ink-600">Paid (gateway)</dt>
            <dd><Money paise={g.result.paidPaise} /></dd>
            <dt className="text-ink-600">Shop orders at checkout</dt>
            <dd><Money paise={g.result.childrenTotalPaise} /></dd>
            <dt className="text-ink-600">Difference</dt>
            <dd className={g.result.differencePaise !== 0 ? "font-semibold text-red-700" : ""}><Money paise={g.result.differencePaise} /></dd>
            <dt className="text-ink-600">Refunded on payment</dt>
            <dd><Money paise={g.result.intentRefundedPaise} /></dd>
            <dt className="text-ink-600">Gateway refunds per shop order</dt>
            <dd><Money paise={g.result.childGatewayRefundsPaise} /></dd>
            <dt className="text-ink-600">Refund difference</dt>
            <dd className={g.result.refundDifferencePaise !== 0 ? "font-semibold text-red-700" : ""}><Money paise={g.result.refundDifferencePaise} /></dd>
          </dl>
          {g.intents.length > 0 ? (
            <p className="mt-2 text-xs text-ink-500">
              Payments: {g.intents.map((i) => `${i.gateway} ${i.status} ₹${(i.amountPaise / 100).toFixed(2)}`).join(" · ")}
            </p>
          ) : null}
          <table className="mt-3 w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-ink-500">
              <tr>
                <th className="py-1">Shop order</th>
                <th>Status</th>
                <th className="text-right">Total now</th>
                <th className="text-right">Part refunds</th>
                <th className="text-right">Gateway refunds</th>
                <th className="text-right">Order refunds</th>
                <th>Settlement</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {g.children.map((c) => (
                <tr key={c.orderId}>
                  <td className="py-1.5">
                    {c.shopName}
                    <span className="block text-xs text-ink-500">{c.orderNumber} · {c.paymentMethod}</span>
                  </td>
                  <td>{c.status}</td>
                  <td className="text-right"><Money paise={c.totalPaise} /></td>
                  <td className="text-right"><Money paise={c.partRefundedPaise} /></td>
                  <td className="text-right"><Money paise={c.gatewayRefundedPaise} /></td>
                  <td className="text-right"><Money paise={c.orderRefundedPaise} /></td>
                  <td>{c.settlement ? `${c.settlement.status}${c.settlement.paidAt ? " (paid)" : ""}` : "Not settled yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}
