import { notFound, redirect } from "next/navigation";

import { CONSULT_MODE_LABELS, type ConsultMode } from "@/lib/consult/constants";
import { formatIst, formatSlot } from "@/lib/consult/time";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { receiptView } from "@/server/consult/views";

export const metadata = { title: "Receipt" };
export const dynamic = "force-dynamic";

/** A booking's receipt — a tax invoice when the firm is GST-registered (fees GST-inclusive). Print to save as PDF. */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  if (!user) redirect(`/signin?callbackUrl=/consult/bookings/${id}/receipt`);
  const r = await receiptView(id, user).catch(() => null);
  if (!r) notFound();
  return (
    <article className="mx-auto max-w-2xl rounded-2xl border-2 border-[var(--gk-line)] bg-white p-6 text-sm print:border-0" data-testid="consult-receipt">
      <header className="flex flex-wrap justify-between gap-2 border-b border-cream-200 pb-3">
        <div>
          <h1 className="text-xl font-extrabold">{r.title}</h1>
          <p>No. {r.number}</p>
          <p>Date {formatIst(r.issuedAt)}</p>
        </div>
        <div className="text-right">
          <p className="font-bold">{r.firm.legalName}</p>
          {r.firm.name !== r.firm.legalName ? <p>{r.firm.name}</p> : null}
          <p className="max-w-64">{r.firm.address}</p>
          {r.firm.gstin ? <p>GSTIN {r.firm.gstin}</p> : null}
        </div>
      </header>
      <section className="py-3">
        <p>
          Billed to <strong>{r.customer.name}</strong>
          {r.customer.phone ? `, ${r.customer.phone}` : ""}
          {r.customer.email ? `, ${r.customer.email}` : ""}
        </p>
        <p>
          Appointment {r.booking.number}: {formatSlot(r.booking.when)} · {CONSULT_MODE_LABELS[r.booking.mode as ConsultMode]?.en}
        </p>
      </section>
      <table className="w-full">
        <thead>
          <tr className="border-b border-cream-200 text-left">
            <th className="py-1">Service{r.booking.sac ? ` (SAC ${r.booking.sac})` : ""}</th>
            <th className="py-1 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.label}>
              <td className="py-1">{l.label}</td>
              <td className="py-1 text-right">{formatPaise(l.amountPaise)}</td>
            </tr>
          ))}
          {r.split ? (
            <>
              <tr className="text-ink-600">
                <td className="py-1">Taxable value</td>
                <td className="py-1 text-right">{formatPaise(r.split.taxablePaise)}</td>
              </tr>
              <tr className="text-ink-600">
                <td className="py-1">CGST</td>
                <td className="py-1 text-right">{formatPaise(r.split.cgstPaise)}</td>
              </tr>
              <tr className="text-ink-600">
                <td className="py-1">SGST</td>
                <td className="py-1 text-right">{formatPaise(r.split.sgstPaise)}</td>
              </tr>
            </>
          ) : null}
        </tbody>
      </table>
      <dl className="mt-3 grid grid-cols-2 gap-1 border-t border-cream-200 pt-3">
        <dt>Paid online</dt>
        <dd className="text-right">{formatPaise(r.paidOnlinePaise)}</dd>
        <dt>Paid at the visit</dt>
        <dd className="text-right">{formatPaise(r.paidOfflinePaise)}</dd>
        {r.refundPaise ? (
          <>
            <dt>Refunded</dt>
            <dd className="text-right">− {formatPaise(r.refundPaise)}</dd>
          </>
        ) : null}
        <dt className="font-bold">Balance due</dt>
        <dd className="text-right font-bold">{formatPaise(r.duePaise)}</dd>
      </dl>
      <p className="mt-4 text-xs text-ink-500">{r.title === "Tax invoice" ? "Fees include GST. " : "The consultant is not GST-registered for this service: no tax is charged. "}Issued through GoKesari (ASMI Global Trading and Consulting India Pvt Ltd) on behalf of the consultant.</p>
    </article>
  );
}
