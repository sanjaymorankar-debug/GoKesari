"use client";

/**
 * docs/onboarding-v2-2026-11 (Flow 2): Admin → Shop documents → Registration licences — one row per licence a shop
 * owner gave at registration. Operators open the file, approve it or reject it with a reason (the owner is asked
 * again). Works at phone width (cards, no table).
 */
import Link from "next/link";
import { useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

export interface RegistrationLicenceRow {
  id: string;
  shopId: string | null;
  shopName: string | null;
  licenceKey: string;
  option: string;
  status: "VERIFIED" | "PENDING_OPERATOR" | "PROMISED" | "REJECTED";
  statusReason: string | null;
  licenceNumber: string | null;
  holderName: string | null;
  validUntil: string | null;
  issuingAuthority: string | null;
  hasFile: boolean;
  updatedAtIst: string;
  promiseAcceptedAtIst: string | null;
  promiseDueAtIst: string | null;
}

const TONE = { VERIFIED: "success", PENDING_OPERATOR: "warning", PROMISED: "neutral", REJECTED: "danger" } as const;
const OPTION: Record<string, string> = { ENTER: "Entered", UPLOAD: "Uploaded", SCAN: "Scanned", LATER: "Upload later" };

export function RegistrationLicencesAdmin({ rows: initial }: { rows: RegistrationLicenceRow[] }) {
  const [rows, setRows] = useState(initial);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusy(id);
    setError(null);
    const response = await fetch(`/api/admin/registration-licences/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, reason: reason[id] ?? null }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(null);
    if (!response?.ok) {
      setError(payload?.error?.message ?? "Could not save the decision. Please try again.");
      return;
    }
    setRows((list) => list.map((r) => (r.id === id ? { ...r, status: payload.status, statusReason: payload.statusReason } : r)));
  }

  if (rows.length === 0) return <p className="text-sm text-ink-600">Nothing here.</p>;
  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {rows.map((r) => (
        <Card key={r.id} className="space-y-1 rounded-xl p-3 text-sm" data-testid="registration-licence-row">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-ink-900">
              {r.licenceKey.replace(/^DOC:/, "").replace(/_/g, " ")} · {r.shopId ? <Link href={`/admin/shops/${r.shopId}`} className="text-kesari-700 underline">{r.shopName ?? "Shop"}</Link> : "Registration in progress"}
            </p>
            <Badge tone={TONE[r.status]}>{r.status.replace("_", " ").toLowerCase()}</Badge>
          </div>
          <p className="text-ink-700">
            {OPTION[r.option] ?? r.option}
            {r.licenceNumber ? ` · ${r.licenceNumber}` : ""}
            {r.holderName ? ` · ${r.holderName}` : ""}
            {r.validUntil ? ` · valid until ${r.validUntil}` : ""}
            {r.issuingAuthority ? ` · ${r.issuingAuthority}` : ""}
          </p>
          {r.statusReason ? <p className="text-xs text-ink-500">{r.statusReason}</p> : null}
          {r.status === "PROMISED" ? (
            <p className="text-xs text-ink-600">
              Promised {r.promiseAcceptedAtIst ?? "—"} · due {r.promiseDueAtIst ?? "set when the shop goes live"} (reminded on the 1st and 15th)
            </p>
          ) : null}
          <p className="text-xs text-ink-500">Updated {r.updatedAtIst}</p>
          <div className="flex flex-wrap items-center gap-2">
            {r.hasFile ? (
              <a href={`/api/admin/registration-licences/${r.id}/file`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-kesari-700 underline">
                Open the file
              </a>
            ) : null}
            {r.status === "PENDING_OPERATOR" ? (
              <>
                <Button disabled={busy === r.id} onClick={() => void decide(r.id, "approve")}>
                  Approve
                </Button>
                <input
                  className={`${inputClass} max-w-xs`}
                  placeholder="Reason, to reject"
                  value={reason[r.id] ?? ""}
                  onChange={(e) => setReason((m) => ({ ...m, [r.id]: e.target.value }))}
                />
                <Button variant="danger" disabled={busy === r.id || !(reason[r.id] ?? "").trim()} onClick={() => void decide(r.id, "reject")}>
                  Reject
                </Button>
              </>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
