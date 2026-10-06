import { notFound, redirect } from "next/navigation";

import { PrintButton } from "@/components/print-button";
import { Card, LinkButton } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { amountInWords, canViewInvoice, getInvoice, type InvoiceSnapshot } from "@/server/services/invoices";

export const metadata = { title: "Invoice" };
export const dynamic = "force-dynamic";

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** NEW-007: the shop's tax invoice / bill of supply for one order — customer, shop and operations. */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const invoice = await getInvoice(id).catch(() => null);
  if (!invoice || !(await canViewInvoice(invoice, user))) notFound();
  const s = invoice.snapshot as unknown as InvoiceSnapshot;
  const intra = s.supplyType === "INTRA";

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
        <LinkButton href={`/api/invoices/${invoice.id}/pdf`}>Download PDF</LinkButton>
        <PrintButton />
      </div>
      <Card className="space-y-5 p-6 text-sm print:border-0 print:shadow-none" data-testid="invoice">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink-900">{s.kind === "TAX_INVOICE" ? "Tax invoice" : "Bill of supply"}</h1>
            <p className="text-ink-600">Invoice no. {s.invoiceNumber}</p>
          </div>
          <div className="text-right text-ink-600">
            <p>Date: {date(s.issuedAt)}</p>
            <p>Order {s.orderNumber} · {date(s.orderDate)}</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase text-ink-500">Sold by</p>
            <p className="font-medium text-ink-900">
              {s.seller.legalName}
              {s.seller.legalName !== s.seller.name ? ` (${s.seller.name})` : ""}
            </p>
            <p className="text-ink-600">{s.seller.address}</p>
            <p className="text-ink-600">{s.seller.gstin ? `GSTIN ${s.seller.gstin}` : "Not GST-registered"}</p>
            {s.seller.panMasked ? <p className="text-ink-600">PAN {s.seller.panMasked}</p> : null}
            {s.seller.fssai ? <p className="text-ink-600">FSSAI {s.seller.fssai}</p> : null}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase text-ink-500">Bill to / ship to</p>
            <p className="font-medium text-ink-900">{s.buyer.name}</p>
            <p className="text-ink-600">{s.buyer.address}</p>
            {s.buyer.gstin ? <p className="text-ink-600">GSTIN {s.buyer.gstin}</p> : null}
            <p className="text-ink-600">
              Place of supply {s.placeOfSupply} · {intra ? "intra-state (CGST + SGST)" : "inter-state (IGST)"}
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="border-b border-cream-200 text-xs uppercase text-ink-500">
              <tr>
                <th className="py-2 pr-2">Item</th>
                <th className="py-2 pr-2">HSN/SAC</th>
                <th className="py-2 pr-2">Qty</th>
                <th className="py-2 pr-2 text-right">GST</th>
                <th className="py-2 pr-2 text-right">Taxable</th>
                {intra ? (
                  <>
                    <th className="py-2 pr-2 text-right">CGST</th>
                    <th className="py-2 pr-2 text-right">SGST</th>
                  </>
                ) : (
                  <th className="py-2 pr-2 text-right">IGST</th>
                )}
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-100">
              {s.lines.map((l, i) => (
                <tr key={i}>
                  <td className="py-2 pr-2">
                    {l.description}
                    {l.rateAssumed ? " *" : ""}
                  </td>
                  <td className="py-2 pr-2">{l.hsn ?? "—"}</td>
                  <td className="py-2 pr-2">{l.quantity}</td>
                  <td className="py-2 pr-2 text-right">{pct(l.rateBp)}</td>
                  <td className="py-2 pr-2 text-right">{formatPaise(l.taxablePaise)}</td>
                  {intra ? (
                    <>
                      <td className="py-2 pr-2 text-right">{formatPaise(l.cgstPaise)}</td>
                      <td className="py-2 pr-2 text-right">{formatPaise(l.sgstPaise)}</td>
                    </>
                  ) : (
                    <td className="py-2 pr-2 text-right">{formatPaise(l.igstPaise)}</td>
                  )}
                  <td className="py-2 text-right">{formatPaise(l.grossPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="ml-auto max-w-xs space-y-1">
          <div className="flex justify-between"><dt>Taxable value</dt><dd>{formatPaise(s.totals.taxablePaise)}</dd></div>
          {intra ? (
            <>
              <div className="flex justify-between"><dt>CGST</dt><dd>{formatPaise(s.totals.cgstPaise)}</dd></div>
              <div className="flex justify-between"><dt>SGST</dt><dd>{formatPaise(s.totals.sgstPaise)}</dd></div>
            </>
          ) : (
            <div className="flex justify-between"><dt>IGST</dt><dd>{formatPaise(s.totals.igstPaise)}</dd></div>
          )}
          <div className="flex justify-between border-t border-cream-200 pt-1 font-semibold text-ink-900">
            <dt>Total (tax inclusive)</dt>
            <dd>{formatPaise(s.totals.totalPaise)}</dd>
          </div>
        </dl>
        <p className="text-ink-600">{amountInWords(s.totals.totalPaise)}</p>

        <div className="border-t border-cream-200 pt-3 text-ink-600">
          {s.payment.deliveryFeePaise > 0 ? (
            <p>Delivery fee charged by GoKesari (not part of this invoice): {formatPaise(s.payment.deliveryFeePaise)}</p>
          ) : null}
          {s.payment.couponPaise > 0 ? (
            <p>
              Coupon {s.payment.couponCode} paid by GoKesari: {formatPaise(s.payment.couponPaise)}
            </p>
          ) : null}
          <p>
            Paid by the customer ({s.payment.method === "COD" ? "cash on delivery" : "GoKesari wallet"}):{" "}
            {formatPaise(s.payment.paidByCustomerPaise)}
          </p>
          {s.notes.map((n) => (
            <p key={n} className="mt-1 text-xs text-ink-500">
              {n}
            </p>
          ))}
          <p className="mt-1 text-xs text-ink-500">Computer-generated document issued through GoKesari on behalf of the seller.</p>
        </div>
      </Card>
    </div>
  );
}
