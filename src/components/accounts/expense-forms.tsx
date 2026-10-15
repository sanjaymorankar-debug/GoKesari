"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button, Field, inputClass } from "@/components/ui";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/lib/accounts/constants";
import { accountsApi, rupees } from "./api";
import { FormError, parseRupees } from "./payment-forms";

type Mode = "CASH" | "BANK" | "UPI" | "CARD" | "CREDIT";

/** Add a shop expense (POST expenses): rent, electricity, salary… */
export function AddExpenseForm({ shopId, today, parties }: { shopId: string; today: string; parties: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ExpenseCategory>("RENT");
  const [amount, setAmount] = useState("");
  const [withGst, setWithGst] = useState(false);
  const [gst, setGst] = useState("");
  const [mode, setMode] = useState<Mode>("CASH");
  const [partyId, setPartyId] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const amountPaise = parseRupees(amount);
    if (!amountPaise) return setError("Enter the amount in rupees.");
    const gstPaise = withGst ? parseRupees(gst) : 0;
    if (gstPaise == null) return setError("Enter the GST in rupees, or untick “Bill has GST”.");
    if (gstPaise > amountPaise) return setError("GST cannot be more than the amount.");
    if (mode === "CREDIT" && !partyId) return setError("Not paid yet: choose who you owe.");
    if (date > today) return setError("The date cannot be in the future.");
    setBusy(true);
    try {
      await accountsApi(shopId, "expenses", {
        body: { category, amountPaise, gstPaise, mode, partyId: partyId || null, expenseDate: date, description: note.trim() || null },
      });
      setAmount("");
      setGst("");
      setNote("");
      setDone(`${EXPENSE_CATEGORY_LABELS[category]} ${rupees(amountPaise)} saved.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <Button onClick={() => setOpen(true)}>+ Add expense</Button>;
  }
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3 sm:grid-cols-3" aria-label="Add expense">
      <Field label="Category">
        <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {EXPENSE_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Amount (₹, total paid)">
        <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
      </Field>
      <Field label="Date">
        <input type="date" className={inputClass} value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
      </Field>
      <Field label="Paid by">
        <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="CASH">Cash</option>
          <option value="UPI">UPI</option>
          <option value="BANK">Bank transfer / cheque</option>
          <option value="CARD">Card</option>
          <option value="CREDIT">Not paid yet (owe a party)</option>
        </select>
      </Field>
      {mode === "CREDIT" ? (
        <Field label="Owed to">
          <select className={inputClass} value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
            <option value="">— Choose party —</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label="Note (optional)">
        <input className={inputClass} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. October rent" />
      </Field>
      <div className="flex flex-col gap-1.5 sm:col-span-3 sm:flex-row sm:items-end">
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-ink-700">
          <input type="checkbox" className="h-5 w-5" checked={withGst} onChange={(e) => setWithGst(e.target.checked)} />
          Bill has GST I can claim
        </label>
        {withGst ? (
          <div className="sm:w-56">
            <Field label="GST inside the amount (₹)">
              <input className={inputClass} inputMode="decimal" value={gst} onChange={(e) => setGst(e.target.value)} placeholder="0.00" />
            </Field>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save expense"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Close
        </Button>
        <p aria-live="polite" className="text-sm text-leaf-700">
          {done ?? ""}
        </p>
      </div>
      <div className="sm:col-span-3">
        <FormError message={error} />
      </div>
    </form>
  );
}
