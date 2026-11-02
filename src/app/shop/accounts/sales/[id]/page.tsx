import Link from "next/link";
import { notFound } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { CancelEntryButton } from "@/components/accounts/payment-forms";
import { Alert, Badge } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { formatMilli } from "@/lib/accounts/units";
import { gstState, stateLabel } from "@/lib/gst-states";
import { formatPaise } from "@/lib/money";
import { loadAccountsPage } from "@/server/accounts/page";
import { getSettings } from "@/server/accounts/books";
import { counterBillKind, getSalesInvoice } from "@/server/accounts/sales";
import { counterBillShareText, whatsappShareUrl } from "@/server/invoicing/outputs";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";

export const metadata = { title: "Sales invoice" };
export const dynamic = "force-dynamic";

const SIDE_LINK = "inline-flex min-h-10 items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold text-ink-900 hover:bg-kesari-50";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODE_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", BANK: "Bank transfer", CARD: "Card", CREDIT: "Credit (to be paid)" };
const dateLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/** docs/inventory-accounting-2026-10, Part 2: one tax invoice with its Rule 46 particulars. */
export default async function SalesInvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const { shop, lang, shopQuery } = await loadAccountsPage(await searchParams);
  if (!UUID.test(id)) notFound();
  let data: Awaited<ReturnType<typeof getSalesInvoice>>;
  try {
    data = await getSalesInvoice(shop.id, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const { invoice: inv, lines } = data;
  const cancelled = inv.status === "CANCELLED";
  const docTitle = counterBillKind(shop) === "TAX_INVOICE" ? "Tax invoice" : "Bill of supply";
  const [billingV2, settings] = await Promise.all([isFeatureEnabledForShop("billing_v2", shop), getSettings(shop.id)]);
  const address = [shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.pincode].filter(Boolean).join(", ");

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="sales" shopQuery={shopQuery} />
      <AccountsHeader
        title={`Invoice ${inv.invoiceNo}`}
        subtitle={`${dateLabel(inv.invoiceDate)} · ${inv.buyerName ?? "Cash customer"}`}
        action={
          <div className="flex flex-wrap items-start gap-1.5">
            <Link href={`/shop/accounts/sales${shopQuery}`} className="inline-flex min-h-10 items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold text-ink-900 hover:bg-kesari-50">
              ← All invoices
            </Link>
            <a href={`/api/shops/${shop.id}/accounts/sales/${inv.id}/pdf`} download className="inline-flex min-h-10 items-center rounded-xl bg-kesari-700 px-3 text-sm font-bold text-white hover:bg-kesari-800">
              Download PDF
            </a>
            {/* Billing v2 (QA D-115): the 80 mm receipt, the JSON and a WhatsApp share. */}
            {billingV2 ? (
              <>
                <a href={`/api/shops/${shop.id}/accounts/sales/${inv.id}/receipt`} download className={SIDE_LINK}>
                  80 mm receipt
                </a>
                <a href={`/api/shops/${shop.id}/accounts/sales/${inv.id}`} className={SIDE_LINK}>
                  JSON
                </a>
                {cancelled ? null : (
                  <a
                    href={whatsappShareUrl(counterBillShareText({ kind: counterBillKind(shop), invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate, shopName: shop.name, totalPaise: inv.totalPaise, upiVpa: settings.upiVpa }))}
                    target="_blank"
                    rel="noreferrer"
                    className={SIDE_LINK}
                  >
                    Share on WhatsApp
                  </a>
                )}
              </>
            ) : null}
            {cancelled ? null : <CancelEntryButton shopId={shop.id} path={`sales/${inv.id}`} what="invoice" />}
          </div>
        }
      />

      {cancelled ? (
        <div className="mb-3">
          <Alert tone="danger" title="This invoice is cancelled">
            {inv.cancelReason ? `Reason: ${inv.cancelReason}. ` : ""}Its stock was put back and its entries were reversed in the books.
          </Alert>
        </div>
      ) : null}

      <article className="rounded-2xl border border-[var(--gk-line)] bg-white p-3 sm:p-4" aria-label={docTitle}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--gk-line)] pb-2">
          <h2 className="text-lg font-bold text-ink-900">{docTitle}</h2>
          {cancelled ? <Badge tone="danger">Cancelled</Badge> : <Badge tone="success">Issued</Badge>}
        </div>

        <div className="grid gap-3 py-3 text-sm sm:grid-cols-2">
          <section aria-label="Supplier">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-600">From</p>
            <p className="font-bold text-ink-900">{shop.legalBusinessName ?? shop.name}</p>
            {address ? <p className="text-ink-700">{address}</p> : null}
            <p className="text-ink-700">GSTIN: {shop.gstin ?? "—"}</p>
            <p className="text-ink-700">State: {stateLabel(inv.sellerStateCode) ?? inv.sellerStateCode}</p>
          </section>
          <section aria-label="Recipient">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-600">Bill to</p>
            <p className="font-bold text-ink-900">{inv.buyerName ?? "Cash customer"}</p>
            {inv.buyerGstin ? <p className="text-ink-700">GSTIN: {inv.buyerGstin}</p> : <p className="text-ink-700">Unregistered buyer (B2C)</p>}
            <p className="text-ink-700">
              Place of supply: {gstState(inv.placeOfSupply)?.name ?? inv.placeOfSupply} ({inv.placeOfSupply})
            </p>
            {inv.partyId ? (
              <Link href={`/shop/accounts/parties/${inv.partyId}${shopQuery}`} className="text-kesari-700 underline">
                Customer account
              </Link>
            ) : null}
          </section>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-y border-[var(--gk-line)] py-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-ink-600">Invoice no.</dt>
            <dd className="font-semibold">{inv.invoiceNo}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-600">Date</dt>
            <dd className="font-semibold">{dateLabel(inv.invoiceDate)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-600">Supply</dt>
            <dd className="font-semibold">{inv.interState ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-600">Payment</dt>
            <dd className="font-semibold">
              {MODE_LABEL[inv.paymentMode] ?? inv.paymentMode}
              {inv.dueDate ? ` · due ${dateLabel(inv.dueDate)}` : ""}
            </dd>
          </div>
        </dl>

        <div className="-mx-3 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">Items</caption>
            <thead>
              <tr className="border-b border-[var(--gk-line)] text-left text-xs text-ink-600">
                <th scope="col" className="px-2 py-1.5">#</th>
                <th scope="col" className="px-2 py-1.5">Item</th>
                <th scope="col" className="px-2 py-1.5">HSN</th>
                <th scope="col" className="px-2 py-1.5 text-right">Qty</th>
                <th scope="col" className="px-2 py-1.5 text-right">Rate</th>
                <th scope="col" className="px-2 py-1.5 text-right">Disc.</th>
                <th scope="col" className="px-2 py-1.5 text-right">Taxable</th>
                <th scope="col" className="px-2 py-1.5 text-right">GST</th>
                <th scope="col" className="px-2 py-1.5 text-right">{inv.interState ? "IGST" : "CGST + SGST"}</th>
                <th scope="col" className="px-2 py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {lines.map((l) => (
                <tr key={l.id} className="border-b border-[var(--gk-line)] last:border-b-0">
                  <td className="px-2 py-1.5 text-ink-600">{l.lineNo}</td>
                  <td className="px-2 py-1.5 font-medium text-ink-900">
                    {l.shopProductId ? (
                      <Link href={`/shop/accounts/stock/${l.shopProductId}${shopQuery}`} className="hover:underline">
                        {l.description}
                      </Link>
                    ) : (
                      l.description
                    )}
                  </td>
                  <td className="px-2 py-1.5">{l.hsn ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right">{formatMilli(l.qtyMilli, l.unit)}</td>
                  <td className="px-2 py-1.5 text-right">{formatPaise(l.ratePaise)}</td>
                  <td className="px-2 py-1.5 text-right">{l.discountPaise ? formatPaise(l.discountPaise) : "—"}</td>
                  <td className="px-2 py-1.5 text-right">{formatPaise(l.taxablePaise)}</td>
                  <td className="px-2 py-1.5 text-right">{l.gstRateBp / 100}%</td>
                  <td className="px-2 py-1.5 text-right">{inv.interState ? formatPaise(l.igstPaise) : `${formatPaise(l.cgstPaise)} + ${formatPaise(l.sgstPaise)}`}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{formatPaise(l.totalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="ml-auto mt-3 grid max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm tabular-nums">
          <dt className="text-ink-700">Taxable value</dt>
          <dd className="text-right">{formatPaise(inv.taxablePaise)}</dd>
          {inv.interState ? (
            <>
              <dt className="text-ink-700">IGST</dt>
              <dd className="text-right">{formatPaise(inv.igstPaise)}</dd>
            </>
          ) : (
            <>
              <dt className="text-ink-700">CGST</dt>
              <dd className="text-right">{formatPaise(inv.cgstPaise)}</dd>
              <dt className="text-ink-700">SGST</dt>
              <dd className="text-right">{formatPaise(inv.sgstPaise)}</dd>
            </>
          )}
          {inv.cessPaise ? (
            <>
              <dt className="text-ink-700">Cess</dt>
              <dd className="text-right">{formatPaise(inv.cessPaise)}</dd>
            </>
          ) : null}
          {inv.roundOffPaise ? (
            <>
              <dt className="text-ink-700">Round off</dt>
              <dd className="text-right">{formatPaise(inv.roundOffPaise)}</dd>
            </>
          ) : null}
          <dt className="mt-1 border-t border-[var(--gk-line)] pt-1 font-bold">Total</dt>
          <dd className="mt-1 border-t border-[var(--gk-line)] pt-1 text-right text-lg font-bold">{formatPaise(inv.totalPaise)}</dd>
        </dl>
        {inv.note ? <p className="mt-2 text-sm text-ink-700">Note: {inv.note}</p> : null}
        <p className="mt-3 text-xs text-ink-600">Computer-generated invoice. Stock of listed products went down when it was issued.</p>
      </article>
    </div>
  );
}
