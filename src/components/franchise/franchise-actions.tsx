"use client";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

/** Renew a franchise (optionally with a renewal coupon), or pay / cancel a reserved booking, from the owner's page. */
export function FranchiseActions({ kind, id, label, cancel, coupon }: { kind: "renew" | "pay"; id: string; label: string; cancel?: boolean; coupon?: boolean }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res =
        kind === "renew"
          ? await fetch(`/api/franchise/allocations/${id}/renew`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ couponCode: code.trim() || null }) })
          : await fetch(`/api/franchise/bookings/${id}/pay`, { method: "POST" });
      const p = await res.json().catch(() => null);
      if (!res.ok) throw new Error(p?.error?.message ?? "The payment could not be started.");
      if (p?.checkoutUrl) window.location.assign(p.checkoutUrl);
      else window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }
  async function drop() {
    setBusy(true);
    const res = await fetch(`/api/franchise/bookings/${id}`, { method: "DELETE" });
    if (!res.ok) setError((await res.json().catch(() => null))?.error?.message ?? "Could not cancel.");
    window.location.reload();
  }
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {coupon ? <input className={`${inputClass} w-40 uppercase`} placeholder="Coupon (optional)" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={30} aria-label="Renewal coupon code" data-testid={`franchise-renew-coupon-${id}`} /> : null}
        <Button size="sm" onClick={go} disabled={busy} data-testid={`franchise-${kind}-${id}`}>
          {busy ? "Please wait…" : label}
        </Button>
        {cancel ? (
          <Button size="sm" variant="secondary" onClick={drop} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
