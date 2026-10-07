"use client";

/** F10 — staff review of shop owners' product photos. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SafeImage } from "@/components/safe-image";
import { Alert, Button, Card, EmptyState, inputClass } from "@/components/ui";

export interface PendingImageRow {
  id: string;
  url: string;
  productName: string;
  shopName: string | null;
  createdAt: string;
}

export function ImageModerationQueue({ rows }: { rows: PendingImageRow[] }) {
  if (rows.length === 0) return <EmptyState title="No photos waiting for review." />;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {rows.map((r) => (
        <Row key={r.id} row={r} />
      ))}
    </div>
  );
}

function Row({ row }: { row: PendingImageRow }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/image-moderation/${row.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return setError(body?.error?.message ?? "Action failed.");
    }
    router.refresh();
  }

  return (
    <Card className="space-y-2 p-3" data-testid="pending-image">
      <SafeImage src={row.url} alt={row.productName} className="h-48 w-full rounded object-contain bg-cream-50" />
      <p className="text-sm font-medium text-ink-900">{row.productName}</p>
      <p className="text-xs text-ink-500">
        {row.shopName ?? "Catalogue photo"} · {new Date(row.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
      </p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {rejecting ? (
        <div className="space-y-2">
          <input className={inputClass} placeholder="Reason (shown to the shop)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="danger" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => void decide("reject")}>
              Reject
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>
            Approve
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
          </Button>
        </div>
      )}
    </Card>
  );
}
