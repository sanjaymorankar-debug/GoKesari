import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { EditPartyForm } from "@/components/accounts/party-forms";
import { CancelEntryButton, RecordPaymentForm, type LinkableDoc } from "@/components/accounts/payment-forms";
import { Badge, EmptyState } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { stateLabel } from "@/lib/gst-states";
import { formatPaise } from "@/lib/money";
import { todayIst } from "@/server/accounts/books";
import { listPayments } from "@/server/accounts/money";
import { loadAccountsPage } from "@/server/accounts/page";
import { partyLedger } from "@/server/accounts/parties";
import { listPurchases } from "@/server/accounts/purchases";
import { listSalesInvoices } from "@/server/accounts/sales";

export const metadata = { title: "Party account" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_LABEL = { SUPPLIER: "Supplier", CUSTOMER: "Customer", BOTH: "Supplier & customer" } as const;
const VOUCHER_LABEL: Record<string, string> = {
  PURCHASE: "Bill",
  SALE: "Sale",
  PAYMENT: "Payment",
  RECEIPT: "Receipt",
  EXPENSE: "Expense",
  WRITE_OFF: "Write-off",
  OPENING: "Opening",
  REVERSAL: "Reversal",
};
const MODE_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", BANK: "Bank", CARD: "Card" };
const dateLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });

function sourceHref(sourceType: string, sourceId: string, shopQuery: string): string | null {
  if (sourceType === "PURCHASE") return `/shop/accounts/purchases/${sourceId}${shopQuery}`;
  if (sourceType === "SALE") return `/shop/accounts/sales/${sourceId}${shopQuery}`;
  return null;
}

/** docs/inventory-accounting-2026-10, Part 2: one supplier / customer — details, ledger, payments. */
export default async function PartyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const { shop, lang, shopQuery } = await loadAccountsPage(await searchParams);
  if (!UUID.test(id)) notFound();
  let ledger: Awaited<ReturnType<typeof partyLedger>>;
  try {
    ledger = await partyLedger(shop.id, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const { party, lines, balancePaise } = ledger;
  const [payments, bills, invoices] = await Promise.all([listPayments(shop.id, { partyId: id }), listPurchases(shop.id, { partyId: id }), listSalesInvoices(shop.id)]);
  const docs: LinkableDoc[] = [
    ...bills.filter((b) => b.status === "CONFIRMED").map((b) => ({ id: b.id, kind: "PURCHASE" as const, label: `Bill ${b.invoiceNo} · ${b.invoiceDate}`, totalPaise: b.totalPaise })),
    ...invoices.filter((s) => s.partyId === id && s.status === "ISSUED").map((s) => ({ id: s.id, kind: "SALE" as const, label: `Invoice ${s.invoiceNo} · ${s.invoiceDate}`, totalPaise: s.totalPaise })),
  ];
  const docLabel = new Map(docs.map((d) => [d.id, d.label]));
  const rows = [...lines].reverse();

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="parties" shopQuery={shopQuery} />
      <AccountsHeader
        title={party.name}
        subtitle={KIND_LABEL[party.kind]}
        action={
          <Link href={`/shop/accounts/parties${shopQuery}`} className="inline-flex min-h-10 items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold text-ink-900 hover:bg-green-50">
            ← All parties
          </Link>
        }
      />

      <div className="mb-3 grid gap-2 lg:grid-cols-[1fr_1.4fr]">
        <section className="flex flex-col gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3" aria-label="Party details">
          <div className={clsx("rounded-xl px-3 py-2", balancePaise > 0 ? "bg-red-50" : balancePaise < 0 ? "bg-green-100" : "bg-cream-100")}>
            <p className="text-xs font-semibold text-ink-600">Balance</p>
            <p className={clsx("text-2xl font-bold tabular-nums", balancePaise > 0 ? "text-red-800" : balancePaise < 0 ? "text-green-800" : "text-ink-700")}>{formatPaise(Math.abs(balancePaise))}</p>
            <p className="text-xs text-ink-700">{balancePaise > 0 ? "You owe them" : balancePaise < 0 ? "They owe you" : "Settled"}</p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-ink-600">GSTIN</dt>
            <dd className="font-medium">{party.gstin ? `${party.gstin}${party.stateCode ? ` · ${stateLabel(party.stateCode) ?? party.stateCode}` : ""}` : "—"}</dd>
            <dt className="text-ink-600">Phone</dt>
            <dd className="font-medium">{party.phone ? <a href={`tel:${party.phone}`} className="text-kesari-700 underline">{party.phone}</a> : "—"}</dd>
            <dt className="text-ink-600">Email</dt>
            <dd className="break-all font-medium">{party.email ?? "—"}</dd>
            <dt className="text-ink-600">Address</dt>
            <dd className="font-medium">{party.address ?? "—"}</dd>
            <dt className="text-ink-600">Credit days</dt>
            <dd className="font-medium">{party.creditDays}</dd>
          </dl>
          <EditPartyForm shopId={shop.id} party={{ id: party.id, kind: party.kind, name: party.name, gstin: party.gstin, phone: party.phone, email: party.email, address: party.address, creditDays: party.creditDays }} />
        </section>

        <section className="rounded-2xl border border-[var(--gk-line)] bg-white p-3" aria-labelledby="record-payment">
          <h2 id="record-payment" className="mb-2 text-base font-bold text-ink-900">
            Record payment or receipt
          </h2>
          <RecordPaymentForm shopId={shop.id} partyId={party.id} partyKind={party.kind} today={todayIst()} docs={docs} />
        </section>
      </div>

      <section className="mb-3" aria-labelledby="ledger">
        <h2 id="ledger" className="mb-1 text-base font-bold text-ink-900">
          Account (newest first)
        </h2>
        <p className="mb-2 text-xs text-ink-600">Credit = bills from them, money received from them. Debit = payments to them, sales to them on credit. Balance: positive means you owe them.</p>
        {rows.length === 0 ? (
          <EmptyState title="No entries yet" />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-[var(--gk-line)] bg-white">
            <table className="w-full min-w-[38rem] text-sm">
              <caption className="sr-only">Ledger of {party.name}</caption>
              <thead>
                <tr className="border-b border-[var(--gk-line)] text-left text-xs text-ink-600">
                  <th scope="col" className="px-3 py-2">Date</th>
                  <th scope="col" className="px-3 py-2">Entry</th>
                  <th scope="col" className="px-3 py-2 text-right">Debit</th>
                  <th scope="col" className="px-3 py-2 text-right">Credit</th>
                  <th scope="col" className="px-3 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rows.map((l) => {
                  const link = l.sourceId ? sourceHref(l.sourceType, l.sourceId, shopQuery) : null;
                  return (
                    <tr key={l.id} className="border-b border-[var(--gk-line)] last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-2 text-ink-700">{dateLabel(l.entryDate)}</td>
                      <td className="px-3 py-2">
                        <span className="font-semibold text-ink-900">{VOUCHER_LABEL[l.voucherType] ?? l.voucherType}</span>
                        {l.docRef ? link ? (
                          <Link href={link} className="ml-1 text-kesari-700 underline">
                            {l.docRef}
                          </Link>
                        ) : (
                          <span className="ml-1 text-ink-700">{l.docRef}</span>
                        ) : link ? (
                          <Link href={link} className="ml-1 text-kesari-700 underline">
                            open
                          </Link>
                        ) : null}
                        {l.narration ? <span className="block text-xs text-ink-600">{l.narration}</span> : null}
                      </td>
                      <td className="px-3 py-2 text-right">{l.debitPaise ? formatPaise(l.debitPaise) : ""}</td>
                      <td className="px-3 py-2 text-right">{l.creditPaise ? formatPaise(l.creditPaise) : ""}</td>
                      <td className={clsx("px-3 py-2 text-right font-semibold", l.balancePaise > 0 ? "text-red-800" : l.balancePaise < 0 ? "text-green-800" : "")}>
                        {formatPaise(Math.abs(l.balancePaise))} {l.balancePaise > 0 ? "Cr" : l.balancePaise < 0 ? "Dr" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="payments">
        <h2 id="payments" className="mb-2 text-base font-bold text-ink-900">
          Payments and receipts
        </h2>
        {payments.length === 0 ? (
          <EmptyState title="No payments recorded" />
        ) : (
          <ul className="overflow-hidden rounded-2xl border border-[var(--gk-line)] bg-white">
            {payments.map(({ p }) => {
              const linked = p.purchaseInvoiceId ?? p.salesInvoiceId;
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--gk-line)] px-3 py-2 last:border-b-0">
                  <span className="min-w-0 flex-1">
                    <span className={clsx("block text-sm font-bold tabular-nums", p.status === "CANCELLED" ? "text-ink-500 line-through" : "text-ink-900")}>
                      {p.direction === "PAID" ? "Paid" : "Received"} {formatPaise(p.amountPaise)}
                    </span>
                    <span className="block text-xs text-ink-600">
                      {dateLabel(p.paymentDate)} · {MODE_LABEL[p.mode] ?? p.mode}
                      {p.reference ? ` · ref ${p.reference}` : ""}
                      {linked ? ` · ${docLabel.get(linked) ?? "against a bill"}` : ""}
                      {p.note ? ` · ${p.note}` : ""}
                    </span>
                  </span>
                  {p.status === "CANCELLED" ? <Badge tone="danger">Cancelled</Badge> : <CancelEntryButton shopId={shop.id} path={`payments/${p.id}`} what="payment" />}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
