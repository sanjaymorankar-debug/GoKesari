import { Card, EmptyState, Money, Section, StatusBadge } from "@/components/ui";
import { addDays } from "@/lib/dates";
import { listStatementsForShop } from "@/server/payouts/statements";
import { listPlatformInvoices, listPlatformNotes } from "@/server/platform-invoices/service";
import { getRule } from "@/server/services/settings";

/**
 * /shop/finance → Statements (batch-2026-10 WS-E): the shop's payout
 * statements (PDF and CSV, with the bank's UTR) and GoKesari's tax invoices
 * for its fees. Shown once automated payouts or GoKesari invoicing has
 * produced anything, or while rule payouts is on.
 */
export async function ShopPayoutStatements({ shopId }: { shopId: string }) {
  const [rule, statements, invoices, notes] = await Promise.all([
    getRule("payouts"),
    listStatementsForShop(shopId, 30),
    listPlatformInvoices({ shopId, limit: 30 }),
    listPlatformNotes({ shopId, limit: 30 }),
  ]);
  if (!rule.enabled && statements.length === 0 && invoices.length === 0) return null;
  return (
    <Section id="statements" title="Statements">
      <p className="mb-3 text-xs text-ink-500">
        Payouts every {rule.cycleDays} days to your verified bank account: delivered orders less commission, GST on GoKesari&apos;s fees, TCS and TDS, refunds and adjustments. Each statement is also emailed to you as PDF and CSV.
      </p>
      {statements.length === 0 ? (
        <EmptyState title="No payout statements yet." />
      ) : (
        <Card className="mb-4 divide-y divide-cream-100" data-testid="payout-statements">
          {statements.map(({ item, cycleStart, cycleEnd }) => (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div>
                <p className="font-medium text-ink-900">
                  {cycleStart} to {addDays(cycleEnd, -1)}
                </p>
                <p className="text-xs text-ink-500">
                  {item.utr ? `Paid · UTR ${item.utr}` : item.holdReason ? `On hold (${item.holdReason.toLowerCase().replace(/_/g, " ")})` : item.failureReason ?? ""}
                </p>
                <a className="inline-flex min-h-11 items-center text-xs font-medium text-kesari-700 hover:underline" href={`/api/payouts/statements/${item.id}`}>
                  Statement PDF
                </a>
                <span className="text-xs text-ink-500"> · </span>
                <a className="inline-flex min-h-11 items-center text-xs font-medium text-kesari-700 hover:underline" href={`/api/payouts/statements/${item.id}?format=csv`}>
                  CSV
                </a>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={item.status} />
                <span className="font-semibold">
                  <Money paise={item.amountPaise} />
                </span>
              </div>
            </div>
          ))}
        </Card>
      )}
      {invoices.length > 0 ? (
        <>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">GoKesari&apos;s invoices for its fees</h3>
          <Card className="divide-y divide-cream-100" data-testid="platform-invoices">
            {invoices.map(({ invoice }) => (
              <div key={invoice.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <a className="inline-flex min-h-11 items-center font-medium text-kesari-700 hover:underline" href={`/api/platform-invoices/${invoice.id}/pdf`}>
                  {invoice.invoiceNumber}
                </a>
                <span className="flex items-center gap-2 text-xs text-ink-500">
                  GST deducted from payout <Money paise={invoice.gstDeductedPaise} />
                  <span className="text-sm font-semibold text-ink-900">
                    <Money paise={invoice.totalPaise} />
                  </span>
                </span>
              </div>
            ))}
            {notes.map((n) => (
              <div key={n.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <a className="inline-flex min-h-11 items-center font-medium text-kesari-700 hover:underline" href={`/api/platform-invoices/notes/${n.id}/pdf`}>
                  {n.kind === "CREDIT" ? "Credit" : "Debit"} note {n.noteNumber}
                </a>
                <Money paise={n.kind === "CREDIT" ? -n.totalPaise : n.totalPaise} />
              </div>
            ))}
          </Card>
        </>
      ) : null}
    </Section>
  );
}
