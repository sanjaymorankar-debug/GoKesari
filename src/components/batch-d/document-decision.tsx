"use client";

/** Approve / reject (with a reason) one shop document — Operator-Limited (batch-2026-10 WS-D). */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, inputClass } from "@/components/ui";

export function DocumentDecision({ verificationId }: { verificationId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (decision === "reject" && reason.trim().length < 3) {
      setError("Write the reason the document is rejected.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/operator/documents/${verificationId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "Could not save the decision.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-2 space-y-2">
      <input className={inputClass} placeholder="Reason (required to reject)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>Approve</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide("reject")}>Reject</Button>
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
