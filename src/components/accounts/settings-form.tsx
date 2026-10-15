"use client";

/**
 * Inventory & Accounting settings (docs/inventory-accounting-2026-10): stock
 * valuation, where purchased stock goes, GST filing frequency, invoice prefix
 * and reminder windows → PATCH settings. Every change is logged on the server.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";

import { accountsApi, ApiError } from "./api";

export interface AccountsSettingsValues {
  valuationMethod: "FIFO" | "WAVG";
  purchaseChannel: "ONLINE" | "OFFLINE";
  filingFrequency: "MONTHLY" | "QUARTERLY";
  salesInvoicePrefix: string;
  reminderDaysBefore: number;
  expiryAlertDays: number;
}

function Choice<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string; hint: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-semibold text-ink-900">{legend}</legend>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={
              "flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border p-2.5 text-sm " +
              (value === o.value ? "border-kesari-500 bg-kesari-50" : "border-[var(--gk-line)] bg-white hover:bg-cream-100")
            }
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5 h-5 w-5 shrink-0 accent-kesari-600" />
            <span>
              <span className="block font-semibold text-ink-900">{o.label}</span>
              <span className="block text-xs text-ink-600">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function AccountsSettingsForm({ shopId, initial }: { shopId: string; initial: AccountsSettingsValues }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof AccountsSettingsValues>(key: K, value: AccountsSettingsValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false);
  };

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await accountsApi<AccountsSettingsValues>(shopId, "settings", {
        method: "PATCH",
        body: { ...values, salesInvoicePrefix: values.salesInvoicePrefix.trim() },
      });
      setValues((v) => ({ ...v, salesInvoicePrefix: updated.salesInvoicePrefix ?? v.salesInvoicePrefix }));
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const dirty = (Object.keys(initial) as (keyof AccountsSettingsValues)[]).some((k) => initial[k] !== values[k]);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Choice
        name="valuationMethod"
        legend="Stock valuation"
        value={values.valuationMethod}
        onChange={(v) => set("valuationMethod", v)}
        options={[
          { value: "FIFO", label: "FIFO (first in, first out)", hint: "Stock bought first is treated as sold first — cost follows your oldest purchase prices." },
          { value: "WAVG", label: "Weighted average", hint: "Every unit costs the average of what you paid — smooths out price changes." },
        ]}
      />
      <Choice
        name="purchaseChannel"
        legend="Purchased stock goes to"
        value={values.purchaseChannel}
        onChange={(v) => set("purchaseChannel", v)}
        options={[
          { value: "ONLINE", label: "Online stock", hint: "A confirmed bill adds to the stock customers can order on GoKesari." },
          { value: "OFFLINE", label: "In-shop stock", hint: "A confirmed bill adds to your counter (in-shop) stock only." },
        ]}
      />
      <Choice
        name="filingFrequency"
        legend="GST filing"
        value={values.filingFrequency}
        onChange={(v) => set("filingFrequency", v)}
        options={[
          { value: "MONTHLY", label: "Monthly", hint: "GSTR-1 by the 11th and GSTR-3B by the 20th of the next month." },
          { value: "QUARTERLY", label: "Quarterly (QRMP)", hint: "Pay by PMT-06 in months 1–2; GSTR-1 and GSTR-3B after the quarter." },
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Sales invoice prefix" hint="1–6 letters, digits, / or - (e.g. INV)">
          <input
            className={`${inputClass} min-h-11 uppercase`}
            value={values.salesInvoicePrefix}
            onChange={(e) => set("salesInvoicePrefix", e.target.value.toUpperCase())}
            maxLength={6}
            required
          />
        </Field>
        <Field label="GST reminder (days before due date)" hint="0 to 30">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={30}
            className={`${inputClass} min-h-11`}
            value={values.reminderDaysBefore}
            onChange={(e) => set("reminderDaysBefore", Math.max(0, Math.min(30, Math.trunc(Number(e.target.value) || 0))))}
            required
          />
        </Field>
        <Field label="Expiry alert (days ahead)" hint="0 to 365">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            className={`${inputClass} min-h-11`}
            value={values.expiryAlertDays}
            onChange={(e) => set("expiryAlertDays", Math.max(0, Math.min(365, Math.trunc(Number(e.target.value) || 0))))}
            required
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
        <div aria-live="polite" className="min-w-0 flex-1">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {saved ? <p className="text-sm font-semibold text-green-800">Saved.</p> : null}
        </div>
      </div>
      {values.valuationMethod !== initial.valuationMethod ? (
        <p className="text-xs text-ink-600">Changing the valuation method changes stock value and profit for every period from now on. Tell your CA.</p>
      ) : null}
    </form>
  );
}
