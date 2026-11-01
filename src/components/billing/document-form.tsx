"use client";

/**
 * Billing v2 (docs/billing §4.1): the form for the shop's credit / debit
 * notes, receipt / refund vouchers, delivery challans and estimates. It only
 * collects the lines; the server works out the tax, the number and the books.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";

const KINDS = [
  ["CREDIT_NOTE", "Credit note (on a sales invoice)"],
  ["DEBIT_NOTE", "Debit note (on a sales invoice)"],
  ["RECEIPT_VOUCHER", "Receipt voucher (advance received)"],
  ["REFUND_VOUCHER", "Refund voucher (advance returned)"],
  ["DELIVERY_CHALLAN", "Delivery challan"],
  ["ESTIMATE", "Estimate / quotation"],
] as const;

interface Line {
  description: string;
  hsn: string;
  qty: string;
  unit: string;
  rate: string;
  gst: string;
}
const blank = (): Line => ({ description: "", hsn: "", qty: "1", unit: "", rate: "", gst: "5" });

export function DocumentForm({ shopId, backHref, invoices, receipts }: { shopId: string; backHref: string; invoices: { id: string; label: string }[]; receipts: { id: string; label: string }[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("CREDIT_NOTE");
  const [againstSalesId, setAgainstSalesId] = useState("");
  const [againstDocumentId, setAgainstDocumentId] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [buyerGstin, setBuyerGstin] = useState("");
  const [paymentMode, setPaymentMode] = useState("CASH");
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(false);
  const [includesTax, setIncludesTax] = useState(false);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onInvoice = kind === "CREDIT_NOTE" || kind === "DEBIT_NOTE";
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        kind,
        againstSalesId: onInvoice ? againstSalesId || null : null,
        againstDocumentId: kind === "REFUND_VOUCHER" ? againstDocumentId || null : null,
        buyerName: buyerName || null,
        buyerGstin: buyerGstin || null,
        paymentMode: kind === "DELIVERY_CHALLAN" || kind === "ESTIMATE" ? null : paymentMode,
        reason: reason || null,
        restock: kind === "CREDIT_NOTE" ? restock : false,
        pricesIncludeTax: includesTax,
        lines: lines
          .filter((l) => l.description.trim())
          .map((l) => ({
            description: l.description.trim(),
            hsn: l.hsn.trim() || null,
            qtyMilli: Math.round(Number(l.qty) * 1000),
            unit: l.unit.trim() || null,
            ratePaise: Math.round(Number(l.rate) * 100),
            gstRateBp: Math.round(Number(l.gst) * 100),
          })),
      };
      const response = await fetch(`/api/shops/${shopId}/accounts/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "The document was not issued.");
      router.push(backHref);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The document was not issued.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3" data-testid="document-form">
      <Field label="Document">
        <select id="doc-kind" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      {onInvoice ? (
        <Field label="Against sales invoice">
          <select id="doc-invoice" className={inputClass} value={againstSalesId} onChange={(e) => setAgainstSalesId(e.target.value)} required>
            <option value="">Choose…</option>
            {invoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {kind === "REFUND_VOUCHER" ? (
        <Field label="Refund of advance (receipt voucher)">
          <select id="doc-receipt" className={inputClass} value={againstDocumentId} onChange={(e) => setAgainstDocumentId(e.target.value)} required>
            <option value="">Choose…</option>
            {receipts.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {!onInvoice && kind !== "REFUND_VOUCHER" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer name">
            <input id="doc-buyer" className={inputClass} value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
          </Field>
          <Field label="Customer GSTIN (optional)">
            <input id="doc-gstin" className={inputClass} value={buyerGstin} onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())} maxLength={15} />
          </Field>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {kind !== "DELIVERY_CHALLAN" && kind !== "ESTIMATE" ? (
          <Field label="Paid / settled by">
            <select id="doc-mode" className={inputClass} value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
              {["CASH", "UPI", "BANK", "CARD", "CREDIT"].map((m) => (
                <option key={m} value={m}>
                  {m === "CREDIT" ? "On account (credit)" : m}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Reason / note">
          <input id="doc-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        {kind === "CREDIT_NOTE" ? (
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Goods came back into stock
          </label>
        ) : null}
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={includesTax} onChange={(e) => setIncludesTax(e.target.checked)} /> Rates include GST
        </label>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-bold text-ink-900">Lines</legend>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 gap-1.5 sm:grid-cols-6">
            <input aria-label={`Line ${i + 1} item`} placeholder="Item / description" className={`${inputClass} col-span-2`} value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
            <input aria-label={`Line ${i + 1} HSN`} placeholder="HSN/SAC" className={inputClass} value={l.hsn} onChange={(e) => set(i, { hsn: e.target.value })} />
            <input aria-label={`Line ${i + 1} quantity`} placeholder="Qty" inputMode="decimal" className={inputClass} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} />
            <input aria-label={`Line ${i + 1} rate`} placeholder="Rate ₹" inputMode="decimal" className={inputClass} value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} />
            <input aria-label={`Line ${i + 1} GST percent`} placeholder="GST %" inputMode="decimal" className={inputClass} value={l.gst} onChange={(e) => set(i, { gst: e.target.value })} />
          </div>
        ))}
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}>
            + Add line
          </Button>
        </div>
      </fieldset>
      {error ? (
        <Alert tone="danger" title="Not issued">
          {error}
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Issuing…" : "Issue document"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.push(backHref)}>
          Back
        </Button>
      </div>
    </form>
  );
}
