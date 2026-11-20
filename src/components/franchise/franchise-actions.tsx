"use client";
import { useState } from "react";

import { Alert, Button } from "@/components/ui";

/** Renew an area, or pay / cancel a reserved booking, from the owner's page. */
export function FranchiseActions({ kind, id, label, cancel }: { kind: "renew" | "pay"; id: string; label: string; cancel?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(kind === "renew" ? `/api/franchise/allocations/${id}/renew` : `/api/franchise/bookings/${id}/pay`, { method: "POST" });
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
      <div className="flex flex-wrap gap-2">
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
