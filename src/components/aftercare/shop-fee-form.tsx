"use client";

/**
 * The shop owner's after-packing cancellation fee (F6.1.3, batch-2026-10
 * WS-C), within the limits GoKesari set. Amounts are typed in rupees and sent
 * in paise; the server refuses anything above the limits.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { formatPaise } from "@/lib/money";

export function ShopFeeForm({
  shopId,
  initial,
  limits,
}: {
  shopId: string;
  initial: { enabled: boolean; feeType: "FLAT" | "PERCENT"; feePaise: number; feeBp: number; capPaise: number | null; own: boolean };
  limits: { maxFeePaise: number; maxFeeBp: number };
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [feeType, setFeeType] = useState(initial.feeType);
  const [fee, setFee] = useState((initial.feePaise / 100).toFixed(2));
  const [percent, setPercent] = useState((initial.feeBp / 100).toString());
  const [cap, setCap] = useState(initial.capPaise != null ? (initial.capPaise / 100).toFixed(2) : "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    const body = {
      enabled,
      feeType,
      feePaise: Math.round(Number(fee || "0") * 100),
      feeBp: Math.round(Number(percent || "0") * 100),
      capPaise: cap.trim() ? Math.round(Number(cap) * 100) : null,
    };
    const res = await fetch(`/api/shops/${shopId}/cancellation-fee`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
      setMessage({ ok: false, text: fields ? Object.values(fields).join(" ") : (payload?.error?.message ?? "Could not save.") });
      return;
    }
    setMessage({ ok: true, text: "Saved. New cancellations use this fee." });
    router.refresh();
  }

  async function reset() {
    setBusy(true);
    await fetch(`/api/shops/${shopId}/cancellation-fee`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <Card className="space-y-4 p-5" data-testid="shop-fee-form">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Charge a fee when a customer cancels a packed order
      </label>
      <Field label="Fee type">
        <select className={inputClass} value={feeType} onChange={(e) => setFeeType(e.target.value as "FLAT" | "PERCENT")}>
          <option value="FLAT">Fixed amount</option>
          <option value="PERCENT">Percentage of the items</option>
        </select>
      </Field>
      {feeType === "FLAT" ? (
        <Field label="Fee (₹)" hint={`At most ${formatPaise(limits.maxFeePaise)}.`}>
          <input className={inputClass} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Percentage (%)" hint={`At most ${(limits.maxFeeBp / 100).toFixed(2)}%.`}>
            <input className={inputClass} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} />
          </Field>
          <Field label="Most it can be (₹)" hint={`Leave empty for ${formatPaise(limits.maxFeePaise)}.`}>
            <input className={inputClass} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
        </div>
      )}
      {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save fee"}
        </Button>
        {initial.own ? (
          <Button variant="secondary" disabled={busy} onClick={reset}>
            Use GoKesari&apos;s default
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
