"use client";

import { useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

/** A shop owner tells operations the recorded MRP looks wrong. The master MRP is not changed by this. */
export function MrpDisputeForm({ productId, shopId }: { productId: string; shopId: string }) {
  const [open, setOpen] = useState(false);
  const [claim, setClaim] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit() {
    const value = Number(claim.replace(/[₹,\s]/g, ""));
    if (!Number.isFinite(value) || value < 0) return setError("Enter the MRP printed on the pack, in rupees.");
    setBusy(true);
    setError(null);
    const res = await fetch("/api/mrp/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, shopId, claimedMrpPaise: rupeesToPaise(value), note: note || null }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) return setError(payload?.error?.message ?? "Could not send that.");
    setSent(true);
  }

  if (sent) return <p className="text-sm text-leaf-700">Thanks — operations will review the MRP. It stays as it is until they decide.</p>;
  if (!open) {
    return (
      <button type="button" className="text-sm font-medium text-kesari-700 underline" onClick={() => setOpen(true)}>
        MRP looks wrong?
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-cream-200 bg-white p-3">
      <Field label="MRP printed on the pack (₹)">
        <input className={inputClass} inputMode="decimal" value={claim} onChange={(e) => setClaim(e.target.value)} />
      </Field>
      <Field label="Anything that helps us check (optional)">
        <input className={inputClass} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !claim.trim()} onClick={submit}>
          Send for review
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
