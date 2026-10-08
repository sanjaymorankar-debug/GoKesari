"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, EmptyState, StatusBadge, inputClass } from "@/components/ui";

export interface RiderKycRow {
  id: string;
  label: string;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
  riderName: string;
  riderMobile: string;
  riderStatus: string;
  riderId: string;
  fileUrl: string;
}

/** C5: admin review of rider identity documents (open, accept, reject). */
export function RiderKycReviewQueue({ documents }: { documents: RiderKycRow[] }) {
  if (documents.length === 0) return <EmptyState title="No rider documents uploaded yet." />;
  return (
    <Card className="divide-y divide-cream-100" data-testid="rider-kyc-queue">
      {documents.map((d) => (
        <Row key={d.id} doc={d} />
      ))}
    </Card>
  );
}

function Row({ doc }: { doc: RiderKycRow }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "ACCEPTED" | "REJECTED") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/rider-documents/${doc.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason: reason || null }),
    });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) return setError(body?.error?.message ?? "Could not save the decision.");
    router.refresh();
  }

  return (
    <div className="space-y-2 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium text-ink-900">{doc.riderName}</span>
          <span className="text-xs text-ink-500">
            {" "}
            · {doc.riderId} · {doc.riderMobile} · rider {doc.riderStatus.toLowerCase()}
          </span>
          <span className="block">
            {doc.label}
            <span className="text-xs text-ink-500">
              {" "}
              · uploaded {new Date(doc.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
            </span>
          </span>
          {doc.rejectionReason ? <span className="block text-xs text-red-700">{doc.rejectionReason}</span> : null}
        </span>
        <span className="flex items-center gap-2">
          <StatusBadge status={doc.status} />
          <a href={doc.fileUrl} target="_blank" rel="noopener noreferrer" className="text-kesari-600 underline">
            Open document
          </a>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} max-w-xs`}
          placeholder="Reason (needed to reject)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button size="sm" disabled={busy} onClick={() => decide("ACCEPTED")}>
          Accept
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => decide("REJECTED")}>
          Reject
        </Button>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
