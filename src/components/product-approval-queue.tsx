"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";

export interface PendingProductRow {
  id: string;
  name: string;
  categoryName: string;
  unit: string;
  description: string | null;
  createdByName: string | null;
  createdAt: string;
}

/**
 * Admin publish queue for shop-owner-created products (product management
 * brief: "Do not expose ... unless an Admin explicitly approves/publishes").
 * Until a decision is made here, the product is usable only in the shop that
 * created it — approving is what lets other shops find it via search.
 */
export function ProductApprovalQueue({ rows }: { rows: PendingProductRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyState title="No products awaiting publication." description="Products a shop owner creates land here before other shops can find them." />
    );
  }

  async function decide(id: string, decision: "APPROVED" | "REJECTED") {
    if (decision === "REJECTED" && reasonFor !== id) {
      setReasonFor(id);
      return;
    }
    if (decision === "REJECTED" && !reason.trim()) {
      setError("A reason is required to reject a product.");
      return;
    }
    setBusyId(id);
    setError(null);
    const response = await fetch(`/api/products/${id}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason: decision === "REJECTED" ? reason : null }),
    });
    setBusyId(null);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save.");
      return;
    }
    setReasonFor(null);
    setReason("");
    router.refresh();
  }

  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card className="divide-y divide-cream-200">
        {rows.map((row) => (
          <div key={row.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium text-ink-900">{row.name}</p>
                <p className="text-xs text-ink-500">
                  {row.categoryName} · per {row.unit} · created by{" "}
                  {row.createdByName ?? "a shop owner"} on{" "}
                  {new Date(row.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
                </p>
                {row.description ? (
                  <p className="mt-1 text-sm text-ink-600">{row.description}</p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Badge>Pending publish</Badge>
                <Button
                  size="sm"
                  disabled={busyId === row.id}
                  onClick={() => decide(row.id, "APPROVED")}
                >
                  Publish
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === row.id}
                  onClick={() => decide(row.id, "REJECTED")}
                >
                  Reject
                </Button>
              </div>
            </div>
            {reasonFor === row.id ? (
              <div className="mt-2 flex gap-2">
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason for rejection"
                  className={inputClass}
                />
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busyId === row.id}
                  onClick={() => decide(row.id, "REJECTED")}
                >
                  Confirm reject
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </Card>
    </div>
  );
}
