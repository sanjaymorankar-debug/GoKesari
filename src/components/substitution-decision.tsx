"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";

/** Approve or reject a substitute the shop proposed for an unavailable item (GS-035). */
export function SubstitutionDecision({ orderId, itemId }: { orderId: string; itemId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/orders/${orderId}/items/${itemId}/substitution`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve }),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Your choice could not be saved.");
      return;
    }
    router.refresh();
  }

  return (
    <span className="mt-1 flex flex-wrap items-center gap-2" data-testid="substitution-decision">
      <Button size="sm" disabled={busy} onClick={() => decide(true)}>
        Accept substitute
      </Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide(false)}>
        No thanks — refund it
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
