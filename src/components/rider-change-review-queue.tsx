"use client";

/** F2 — admin review of rider identity / bank changes. Values are masked; approving applies them encrypted. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, EmptyState, inputClass } from "@/components/ui";

export interface RiderChangeRow {
  id: string;
  riderName: string;
  riderMobile: string;
  masked: Record<string, string>;
  createdAt: string;
}

const LABELS: Record<string, string> = {
  panNumber: "PAN",
  governmentIdType: "Government ID type",
  governmentIdNumber: "Government ID number",
  bankAccountHolderName: "Bank account holder",
  bankAccountNumber: "Bank account number",
  bankIfsc: "IFSC",
  drivingLicenceNumber: "Driving licence",
};

export function RiderChangeReviewQueue({ rows }: { rows: RiderChangeRow[] }) {
  if (rows.length === 0) return <EmptyState title="No rider changes waiting for review." />;
  return <div className="space-y-3">{rows.map((r) => <Row key={r.id} row={r} />)}</div>;
}

function Row({ row }: { row: RiderChangeRow }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/rider-change-requests/${row.id}/decision`, {
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
    <Card className="space-y-2 p-4" data-testid="rider-change-request">
      <p className="font-semibold text-ink-900">
        {row.riderName} <span className="font-normal text-ink-500">· {row.riderMobile}</span>
      </p>
      <ul className="text-sm text-ink-700">
        {Object.entries(row.masked).map(([k, v]) => (
          <li key={k}>{LABELS[k] ?? k}: <span className="font-mono">{v}</span></li>
        ))}
      </ul>
      <p className="text-xs text-ink-500">Requested {new Date(row.createdAt).toLocaleString("en-IN")}. Check the rider&apos;s documents before approving.</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => decide("approve")}>Approve</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejecting(!rejecting)}>Reject</Button>
      </div>
      {rejecting ? (
        <div className="flex gap-2">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason shown to the rider" />
          <Button size="sm" variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => decide("reject")}>Confirm reject</Button>
        </div>
      ) : null}
    </Card>
  );
}
