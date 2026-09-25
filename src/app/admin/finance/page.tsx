import Link from "next/link";
import { redirect } from "next/navigation";

import {
  AdjustmentForm,
  BatchActions,
  CommissionRateForm,
  PrepareBatchButton,
  RefundDeliveredForm,
  ResolveRecordButton,
  RunReconciliationButton,
} from "@/components/finance-actions";
import { Alert, Card, EmptyState, Money, PageHeader, Section, StatusBadge } from "@/components/ui";
import { addDays, isIsoDate, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { SHOP_TYPES, shopTypeLabel } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listDeliveryPartners } from "@/server/services/delivery-partners";
import {
  countReconciliationByStatus,
  getFinanceSummary,
  getOrderFinancialTrace,
  getPayablesOverview,
  listAdjustments,
  listCommissionRates,
  listReconciliationRecords,
  listRiderPayouts,
  listShopSettlements,
  SETTLEMENT_HOLD_DAYS,
} from "@/server/services/finance";
import { searchShopsAdmin } from "@/server/services/shops";

export const metadata = { title: "Finance" };
export const dynamic = "force-dynamic";

/**
 * Admin finance console (Slice 6, Part J): marketplace figures, what shops
 * and riders are owed, commission, settlements, payouts, adjustments,
 * refunds, reconciliation and a per-order money trace with its journal.
 * Admin only (FINANCE_VIEW) — operators use /admin/finance/exceptions.
 */
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; trace?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.FINANCE_VIEW)) {
    redirect(can(user.role, PERMISSIONS.FINANCE_EXCEPTIONS_VIEW) ? "/admin/finance/exceptions" : "/");
  }

  const params = await searchParams;
  const today = todayIn(getEnv().APP_TIMEZONE);
  const from = params.from && isIsoDate(params.from) ? params.from : addDays(today, -30);
  const to = params.to && isIsoDate(params.to) ? params.to : addDays(today, 1);

  const canManage = can(user.role, PERMISSIONS.FINANCE_MANAGE);
  const canPrepare = can(user.role, PERMISSIONS.FINANCE_PREPARE);
  const canRefund = can(user.role, PERMISSIONS.ORDER_REFUND);

  const [summary, payables, rates, settlements, payouts, adjustments, reconCounts, openRecords, shopList, riders] =
    await Promise.all([
      getFinanceSummary(from, to),
      getPayablesOverview(),
      listCommissionRates(),
      listShopSettlements({ limit: 50 }),
      listRiderPayouts({ limit: 50 }),
      listAdjustments({ limit: 30 }),
      countReconciliationByStatus(),
      listReconciliationRecords({ statuses: ["UNMATCHED", "PARTIAL", "EXCEPTION"], limit: 100 }),
      canManage ? searchShopsAdmin({ status: "APPROVED", limit: 500 }) : Promise.resolve([]),
      canManage ? listDeliveryPartners({ status: "APPROVED", limit: 500 }) : Promise.resolve([]),
    ]);
  const trace = params.trace ? await getOrderFinancialTrace(params.trace).catch(() => null) : null;

  return (
    <>
      <PageHeader
        title="Finance"
        description="Money is paid outside the system; this records it. Operational exceptions: see the exceptions page."
      />
      <p className="-mt-4 mb-6 text-sm">
        <Link href="/admin/finance/exceptions" className="font-medium text-kesari-700 underline">
          Financial exceptions →
        </Link>
      </p>

      <Card className="mb-6 p-4">
        <form className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-500">From</span>
            <input type="date" name="from" defaultValue={from} className="rounded-lg border border-cream-200 px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-500">To (exclusive)</span>
            <input type="date" name="to" defaultValue={to} className="rounded-lg border border-cream-200 px-2 py-1" />
          </label>
          <button type="submit" className="rounded-lg bg-kesari-600 px-3 py-1.5 font-medium text-white">
            Apply
          </button>
        </form>
      </Card>

      <Section title="Marketplace">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="finance-summary">
          <Figure label="GMV (delivered)" paise={summary.gmvPaise} hint={`${summary.deliveredOrders} orders · goods ₹${(summary.goodsPaise / 100).toFixed(2)}`} />
          <Figure label="Paid order value" paise={summary.paidOrderValuePaise} hint={`${summary.paidOrders} paid · ${summary.cancelledOrders} cancelled/refunded`} />
          <Figure label="Gateway payments (top-ups)" paise={summary.gatewayPaymentsPaise} />
          <Figure label="Refunds to wallets" paise={summary.walletRefundsPaise} hint={`after delivery ₹${(summary.refundsAfterDeliveryPaise / 100).toFixed(2)}`} />
          <Figure label="Commission" paise={summary.commissionPaise} />
          <Figure label="Delivery fee revenue" paise={summary.deliveryFeeRevenuePaise} />
          <Figure label="Discounts (promotional credit)" paise={summary.discountPaise} />
          <Figure label="Rider cost" paise={summary.riderCostPaise} />
          <Figure label="Platform net" paise={summary.platformNetPaise} hint="commission + fees − riders − discounts − platform refunds" />
        </div>
      </Section>

      <Section title="Currently owed (not yet in a batch)">
        <div className="grid gap-3 lg:grid-cols-2">
          <Card className="p-4">
            <p className="mb-2 text-sm font-semibold">Shops</p>
            {payables.shops.length === 0 ? (
              <p className="text-sm text-ink-500">Nothing owed.</p>
            ) : (
              <ul className="divide-y divide-cream-100 text-sm">
                {payables.shops.map((s) => (
                  <li key={s.shopId} className="flex justify-between py-1.5">
                    <span>{s.shopName} · {s.orders} orders</span>
                    <Money paise={s.payable} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="p-4">
            <p className="mb-2 text-sm font-semibold">Delivery partners</p>
            {payables.riders.length === 0 ? (
              <p className="text-sm text-ink-500">Nothing owed.</p>
            ) : (
              <ul className="divide-y divide-cream-100 text-sm">
                {payables.riders.map((r) => (
                  <li key={r.deliveryPartnerId} className="flex justify-between py-1.5">
                    <span>{r.partnerName} · {r.deliveries} trips</span>
                    <Money paise={r.earnings} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </Section>

      <Section title="Commission rates">
        <Card className="p-4">
          {rates.length === 0 ? (
            <p className="mb-3 text-sm text-ink-500">No rate set — commission is 0% until a default is saved.</p>
          ) : (
            <ul className="mb-4 divide-y divide-cream-100 text-sm">
              {rates.map((r) => (
                <li key={r.id} className="flex justify-between py-1.5">
                  <span>
                    {r.scope === "DEFAULT"
                      ? "Platform default"
                      : r.scope === "SHOP_TYPE"
                        ? `Shop type: ${shopTypeLabel(r.shopType!)}`
                        : `Shop: ${r.shopName ?? r.shopId}`}
                  </span>
                  <span className="font-medium">{(r.rateBp / 100).toFixed(2)}%</span>
                </li>
              ))}
            </ul>
          )}
          {canManage ? (
            <CommissionRateForm
              shopTypes={SHOP_TYPES.map((t) => ({ key: t.key, label: t.label }))}
              shops={shopList.map((s) => ({ id: s.id, name: s.name }))}
            />
          ) : null}
        </Card>
      </Section>

      <Section title="Shop settlements (weekly)">
        <p className="mb-3 text-xs text-ink-500">
          Delivered orders join a batch once {SETTLEMENT_HOLD_DAYS} days have passed and they are not under dispute.
          Pending → approved → sent to bank → paid (or failed / reversed).
        </p>
        {canPrepare ? (
          <div className="mb-3">
            <PrepareBatchButton kind="settlements" />
          </div>
        ) : null}
        {settlements.length === 0 ? (
          <EmptyState title="No settlements yet." />
        ) : (
          <Card className="divide-y divide-cream-100">
            {settlements.map(({ settlement: s, shopName }) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <p className="font-medium text-ink-900">{shopName}</p>
                  <p className="text-xs text-ink-500">
                    Week from {s.periodStart} · {s.orderCount} orders · goods <Money paise={s.goodsPaise} /> − commission{" "}
                    <Money paise={s.commissionPaise} /> · refunds <Money paise={s.refundsPaise} /> · adjustments{" "}
                    <Money paise={s.adjustmentsPaise} />
                    {s.paymentReference ? ` · ref ${s.paymentReference}` : ""}
                    {s.failureReason ? ` · ${s.failureReason}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={s.status} />
                  <span className="font-semibold">
                    <Money paise={s.netPayablePaise} />
                  </span>
                  {canManage ? <BatchActions kind="settlements" id={s.id} status={s.status} /> : null}
                </div>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Rider payouts (weekly)">
        {canPrepare ? (
          <div className="mb-3">
            <PrepareBatchButton kind="rider-payouts" />
          </div>
        ) : null}
        {payouts.length === 0 ? (
          <EmptyState title="No payouts yet." />
        ) : (
          <Card className="divide-y divide-cream-100">
            {payouts.map(({ payout: p, partnerName }) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <p className="font-medium text-ink-900">{partnerName}</p>
                  <p className="text-xs text-ink-500">
                    Week from {p.periodStart} · {p.earningsCount} trips · earnings <Money paise={p.grossPaise} /> ·
                    adjustments <Money paise={p.adjustmentsPaise} />
                    {p.paymentReference ? ` · ref ${p.paymentReference}` : ""}
                    {p.failureReason ? ` · ${p.failureReason}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={p.status} />
                  <span className="font-semibold">
                    <Money paise={p.amountPaise} />
                  </span>
                  {canManage ? <BatchActions kind="rider-payouts" id={p.id} status={p.status} /> : null}
                </div>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Adjustments">
        {canManage ? (
          <Card className="mb-3 p-4">
            <AdjustmentForm
              shops={shopList.map((s) => ({ id: s.id, name: s.name }))}
              riders={riders.map((r) => ({ id: r.id, name: r.fullName }))}
            />
          </Card>
        ) : null}
        {adjustments.length === 0 ? (
          <EmptyState title="No adjustments yet." />
        ) : (
          <Card className="divide-y divide-cream-100">
            {adjustments.map(({ adjustment: a, orderNumber }) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  {a.type.replace(/_/g, " ").toLowerCase()}
                  {orderNumber ? ` · ${orderNumber}` : ""} — {a.reason}
                  {a.customerRefundPaise > 0 ? (
                    <span className="text-xs text-ink-500">
                      {" "}
                      (customer refunded <Money paise={a.customerRefundPaise} />)
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={a.status} />
                  <Money paise={a.amountPaise} />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      {canRefund ? (
        <Section title="Refund a delivered order">
          <Card className="p-4">
            <RefundDeliveredForm />
          </Card>
        </Section>
      ) : null}

      <Section title="Reconciliation">
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
          {["MATCHED", "UNMATCHED", "PARTIAL", "EXCEPTION", "RECONCILED"].map((status) => (
            <span key={status} className="flex items-center gap-1">
              <StatusBadge status={status} /> {reconCounts[status] ?? 0}
            </span>
          ))}
        </div>
        {canManage ? (
          <div className="mb-3">
            <RunReconciliationButton from={from} to={to} />
          </div>
        ) : null}
        {openRecords.length === 0 ? (
          <Alert tone="success">No open reconciliation items.</Alert>
        ) : (
          <Card className="divide-y divide-cream-100" data-testid="reconciliation-records">
            {openRecords.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <p className="font-medium text-ink-900">
                    {r.entityType.toLowerCase()} · {r.checkType.replace(/_/g, " ").toLowerCase()} ·{" "}
                    {r.entityType === "ORDER" || r.entityType === "RIDER" ? (
                      <Link href={`/admin/finance?trace=${encodeURIComponent(r.reference)}`} className="text-kesari-700 underline">
                        {r.reference}
                      </Link>
                    ) : (
                      r.reference
                    )}
                  </p>
                  <p className="text-xs text-ink-500">
                    {r.detail}
                    {r.expectedPaise != null
                      ? ` Expected ₹${(r.expectedPaise / 100).toFixed(2)}, found ₹${((r.actualPaise ?? 0) / 100).toFixed(2)}.`
                      : ""}
                  </p>
                </div>
                <span className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  <ResolveRecordButton id={r.id} />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Order money trace">
        <Card className="p-4">
          <form className="flex flex-wrap gap-2 text-sm">
            <input type="hidden" name="from" value={from} />
            <input type="hidden" name="to" value={to} />
            <input name="trace" defaultValue={params.trace ?? ""} placeholder="Order number" className="rounded-lg border border-cream-200 px-3 py-1.5" />
            <button type="submit" className="rounded-lg border border-cream-200 px-3 py-1.5 font-medium">
              Trace
            </button>
          </form>
          {params.trace && !trace ? <p className="mt-3 text-sm text-ink-500">No order with that number.</p> : null}
          {trace ? (
            <div className="mt-4 space-y-2 text-sm" data-testid="order-trace">
              <p>
                <span className="font-medium">{trace.order.orderNumber}</span> ({trace.order.source.toLowerCase()}) ·{" "}
                <StatusBadge status={trace.order.status} /> · total <Money paise={trace.order.totalPaise} /> · refunded{" "}
                <Money paise={trace.order.refundedPaise} />
              </p>
              <p>
                Payment:{" "}
                {trace.payment ? (
                  <>
                    {trace.payment.method} · {trace.payment.status} · <Money paise={trace.payment.amountPaise} />
                    {trace.payment.promotionalPaise > 0 ? <> (incl. <Money paise={trace.payment.promotionalPaise} /> promotional)</> : null} · ref{" "}
                    {trace.payment.reference}
                  </>
                ) : (
                  "none"
                )}
              </p>
              <ul className="list-disc pl-5 text-xs text-ink-600">
                {trace.walletEntries.map((w) => (
                  <li key={w.id}>
                    wallet {w.type} <Money paise={w.amountPaise} /> — {w.description}
                  </li>
                ))}
              </ul>
              {trace.snapshot ? (
                <p>
                  Delivered: GMV <Money paise={trace.snapshot.gmvPaise} /> · commission {(trace.snapshot.commissionRateBp / 100).toFixed(2)}% ={" "}
                  <Money paise={trace.snapshot.commissionPaise} /> · shop payable <Money paise={trace.snapshot.shopPayablePaise} />
                </p>
              ) : (
                <p className="text-ink-500">No delivered snapshot.</p>
              )}
              <p className="font-medium">Journal</p>
              <ul className="list-disc pl-5 text-xs text-ink-600">
                {trace.ledger.map((l) => (
                  <li key={l.id}>
                    {l.entityType} {l.direction} {l.entryType.replace(/_/g, " ").toLowerCase()} <Money paise={l.amountPaise} />
                    {l.reference ? ` · ref ${l.reference}` : ""}
                  </li>
                ))}
              </ul>
              <p>
                Settlement: {trace.settlement ? `${trace.settlement.status} (week ${trace.settlement.periodStart})` : "not yet"} · Rider earning:{" "}
                {trace.riderEarning ? <Money paise={trace.riderEarning.totalPaise} /> : "none"}
              </p>
            </div>
          ) : null}
        </Card>
      </Section>
    </>
  );
}

function Figure({ label, paise, hint }: { label: string; paise: number; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-ink-900">
        <Money paise={paise} />
      </p>
      {hint ? <p className="mt-0.5 text-xs text-ink-400">{hint}</p> : null}
    </Card>
  );
}
