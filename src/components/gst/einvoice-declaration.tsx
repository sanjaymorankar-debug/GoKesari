"use client";

/** Module 2: the shop declares its turnover band (e-invoicing applies above ₹5 crore). */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";

const BANDS: [string, string][] = [
  ["BELOW_5_CR", "Up to ₹5 crore"],
  ["5_TO_10_CR", "₹5 – 10 crore"],
  ["10_TO_100_CR", "₹10 – 100 crore"],
  ["ABOVE_100_CR", "Above ₹100 crore"],
];

export function EinvoiceDeclaration({ shopId, band }: { shopId: string; band: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(band ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const res = await fetch(`/api/shops/${shopId}/gst/einvoice-declaration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ applicable: value !== "BELOW_5_CR", turnoverBand: value }),
    });
    setBusy(false);
    const data = res.ok ? null : await res.json().catch(() => null);
    setMessage(res.ok ? { tone: "success", text: "Saved." } : { tone: "danger", text: data?.error?.message ?? "Could not save." });
    router.refresh();
  }

  return (
    <form onSubmit={save} className="space-y-2">
      <Field label="Your aggregate turnover (all business, any financial year since 2017-18)" hint="E-invoicing (IRN) applies to B2B invoices when it has been above ₹5 crore. Ask your CA if unsure.">
        <select className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} required>
          <option value="">Choose…</option>
          {BANDS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </Field>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <Button type="submit" size="sm" disabled={busy || !value}>Save</Button>
    </form>
  );
}
