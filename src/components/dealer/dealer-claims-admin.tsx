"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, inputClass } from "@/components/ui";

export interface AdminClaim {
  id: string;
  dealerId: string;
  dealerName: string;
  status: string;
  phoneTail: string;
  note: string;
  shopId: string | null;
  shopName: string | null;
  currentDealerName: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

/**
 * Staff decide dealers' attribution claims (docs/dealer-programme): uphold
 * (the shop moves to the claiming dealer, audited) or reject, with the reason
 * sent to the dealer. Admin and operator.
 */
export function DealerClaimsAdmin({ claims }: { claims: AdminClaim[] }) {
  const router = useRouter();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: "UPHELD" | "REJECTED") {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/dealer-disputes/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note: notes[id] ?? "" }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3" data-testid="dealer-claims-admin">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {claims.length === 0 ? <p className="text-sm text-ink-600">No claims.</p> : null}
      {claims.map((c) => (
        <div key={c.id} className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{c.dealerName}</span> claims the shop with mobile ending {c.phoneTail}
            <Badge tone={c.status === "OPEN" ? "warning" : c.status === "UPHELD" ? "success" : "neutral"}>{c.status.toLowerCase()}</Badge>
          </p>
          <p className="mt-1 text-ink-700">{c.note}</p>
          <p className="mt-1 text-ink-600">
            {c.shopName ? `Shop found: ${c.shopName} — counted now for ${c.currentDealerName ?? "no dealer"}.` : "No shop with this mobile was found."} Raised {c.createdAt.slice(0, 10)}.
          </p>
          {c.status === "OPEN" ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <input
                className={`${inputClass} max-w-md`}
                placeholder="Reason (sent to the dealer)"
                value={notes[c.id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))}
                maxLength={1000}
                aria-label="Reason for the decision"
              />
              {c.shopId ? (
                <Button size="sm" disabled={busy !== null} onClick={() => decide(c.id, "UPHELD")}>
                  Uphold — move the shop
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => decide(c.id, "REJECTED")}>
                Reject
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-ink-600">Decision: {c.resolutionNote}</p>
          )}
        </div>
      ))}
    </div>
  );
}
