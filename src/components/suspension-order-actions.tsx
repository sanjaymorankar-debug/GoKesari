"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";

/** Operator decision for one order the suspension policy held (or could not cancel). */
export function SuspensionOrderActions({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "CANCEL_REFUND" | "CONTINUE") {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/suspensions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, decision }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ?? "That did not work.");
      return;
    }
    router.refresh();
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => decide("CONTINUE")}>
        Let the shop finish it
      </Button>
      <Button size="sm" variant="danger" disabled={busy} onClick={() => decide("CANCEL_REFUND")}>
        Cancel &amp; refund
      </Button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </span>
  );
}
