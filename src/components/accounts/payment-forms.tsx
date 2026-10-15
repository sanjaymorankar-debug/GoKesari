"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

import { Button, Field, inputClass } from "@/components/ui";
import { accountsApi, rupees } from "./api";

/** "1,234.50" / "1234.5" → paise, or null when not a valid non-negative amount. */
export function parseRupees(raw: string): number | null {
  const s = raw.replace(/[,₹\s]/g, "");
  if (!s) return null;
  if (!/^\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Errors are read out as they appear. */
export function FormError({ message }: { message: string | null }) {
  return (
    <p aria-live="assertive" role={message ? "alert" : undefined} className="min-h-0 text-sm font-medium text-red-700">
      {message ?? ""}
    </p>
  );
}

/**
 * Cancel a document (sales invoice, payment, expense) with a reason:
 * DELETE /api/shops/{shopId}/accounts/{path} with { reason }. The books
 * post a reversal; nothing is erased.
 */
export function CancelEntryButton({ shopId, path, what, size = "sm" }: { shopId: string; path: string; what: string; size?: "sm" | "md" }) {
  const router = useRouter();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Say why it is cancelled.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await accountsApi(shopId, path, { method: "DELETE", body: { reason: reason.trim() } });
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size={size} onClick={() => setOpen(true)} aria-label={`Cancel ${what}`}>
        Cancel
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-1.5 rounded-xl border border-red-200 bg-red-50 p-2 sm:min-w-72">
      <label htmlFor={reasonId} className="text-xs font-semibold text-red-900">
        Why cancel this {what}?
      </label>
      <input id={reasonId} className={inputClass} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus required />
      <div className="flex gap-1.5">
        <Button type="submit" variant="danger" size="sm" disabled={busy}>
          {busy ? "Cancelling…" : `Cancel ${what}`}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Keep it
        </Button>
      </div>
      <FormError message={error} />
    </form>
  );
}

export interface LinkableDoc {
  id: string;
  /** PURCHASE = a supplier's bill (payments made); SALE = own invoice (receipts). */
  kind: "PURCHASE" | "SALE";
  label: string;
  totalPaise: number;
}

/** Record a payment to, or a receipt from, one party (POST payments). */
export function RecordPaymentForm({ shopId, partyId, partyKind, today, docs }: { shopId: string; partyId: string; partyKind: "SUPPLIER" | "CUSTOMER" | "BOTH"; today: string; docs: LinkableDoc[] }) {
  const router = useRouter();
  const [direction, setDirection] = useState<"PAID" | "RECEIVED">(partyKind === "CUSTOMER" ? "RECEIVED" : "PAID");
  const [mode, setMode] = useState<"CASH" | "BANK" | "UPI" | "CARD">("CASH");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [docId, setDocId] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const linkable = docs.filter((d) => (direction === "PAID" ? d.kind === "PURCHASE" : d.kind === "SALE"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const amountPaise = parseRupees(amount);
    if (!amountPaise) {
      setError("Enter the amount in rupees.");
      return;
    }
    if (date > today) {
      setError("The date cannot be in the future.");
      return;
    }
    const linked = linkable.find((d) => d.id === docId);
    setBusy(true);
    try {
      await accountsApi(shopId, "payments", {
        body: {
          partyId,
          direction,
          mode,
          amountPaise,
          paymentDate: date,
          purchaseInvoiceId: linked?.kind === "PURCHASE" ? linked.id : null,
          salesInvoiceId: linked?.kind === "SALE" ? linked.id : null,
          reference: reference.trim() || null,
          note: note.trim() || null,
        },
      });
      setAmount("");
      setReference("");
      setNote("");
      setDocId("");
      setDone(`${direction === "PAID" ? "Payment" : "Receipt"} of ${rupees(amountPaise)} saved.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2" aria-label="Record payment or receipt">
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-sm font-medium text-ink-700">Type</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {(["PAID", "RECEIVED"] as const).map((d) => (
            <label key={d} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-xl border px-2 text-sm font-semibold has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-kesari-500 ${direction === d ? "border-kesari-700 bg-kesari-50 text-kesari-800" : "border-[var(--gk-line)] bg-white text-ink-700"}`}>
              <input type="radio" name="direction" value={d} checked={direction === d} onChange={() => { setDirection(d); setDocId(""); }} className="sr-only" />
              {d === "PAID" ? "I paid them" : "I received from them"}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Amount (₹)">
        <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
      </Field>
      <Field label="Mode">
        <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="CASH">Cash</option>
          <option value="UPI">UPI</option>
          <option value="BANK">Bank transfer / cheque</option>
          <option value="CARD">Card</option>
        </select>
      </Field>
      <Field label="Date">
        <input type="date" className={inputClass} value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
      </Field>
      <Field label={direction === "PAID" ? "Against bill (optional)" : "Against invoice (optional)"} hint="Otherwise it settles the oldest dues first.">
        <select className={inputClass} value={docId} onChange={(e) => setDocId(e.target.value)}>
          <option value="">— Oldest first —</option>
          {linkable.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label} · {rupees(d.totalPaise)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reference (optional)" hint="UTR, cheque no.">
        <input className={inputClass} value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <Field label="Note (optional)">
        <input className={inputClass} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : direction === "PAID" ? "Save payment" : "Save receipt"}
        </Button>
        <p aria-live="polite" className="text-sm text-leaf-700">
          {done ?? ""}
        </p>
      </div>
      <div className="sm:col-span-2">
        <FormError message={error} />
      </div>
    </form>
  );
}
