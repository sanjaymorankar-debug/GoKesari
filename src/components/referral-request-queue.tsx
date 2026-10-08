"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";
import { REFERRAL_REQUEST_STATUS_LABELS } from "@/lib/referral-requests";

export interface ReferralRequestRow {
  id: string;
  reference: string;
  name: string;
  mobile: string;
  shopTypeLabel: string;
  area: string;
  city: string;
  pincode: string;
  latitude: string | null;
  longitude: string | null;
  mapsUrl: string | null;
  locationStatus: "SHARED" | "NOT_SHARED";
  status: "NEW" | "CODE_ISSUED" | "REJECTED";
  issuedCode: string | null;
  decisionNote: string | null;
  emailStatus: string | null;
  emailError: string | null;
  createdAt: string;
}

const TONE = { NEW: "warning", CODE_ISSUED: "success", REJECTED: "danger" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/** Operations: referral-code requests from the shop registration form (docs/four-features-2026-10, feature 4). */
export function ReferralRequestQueue({ status, requests }: { status: string; requests: ReferralRequestRow[] }) {
  return (
    <div className="space-y-3">
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {[
          ["NEW", "New"],
          ["CODE_ISSUED", "Code issued"],
          ["REJECTED", "Rejected"],
          ["ALL", "All"],
        ].map(([key, label]) => (
          <Link
            key={key}
            href={`/admin/referral-requests?status=${key}`}
            className={key === status ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
          >
            {label}
          </Link>
        ))}
      </nav>
      {requests.length === 0 ? <EmptyState title="No requests here." /> : requests.map((r) => <RequestRow key={r.id} request={r} />)}
    </div>
  );
}

function RequestRow({ request }: { request: ReferralRequestRow }) {
  const router = useRouter();
  const [mode, setMode] = useState<"issue" | "reject" | null>(null);
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/admin/referral-requests/${request.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) return setError(payload?.error?.message ?? "Could not save.");
    setMode(null);
    router.refresh();
  }

  return (
    <Card className="p-4" data-testid="referral-request-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-ink-900">
            {request.name} <span className="text-sm font-normal text-ink-500">· {request.reference}</span>
          </p>
          <p className="text-sm text-ink-700">
            {request.shopTypeLabel} · {request.area}, {request.city} {request.pincode}
          </p>
          <p className="text-sm text-ink-700">
            <a href={`tel:${request.mobile}`} className="font-medium">
              {request.mobile}
            </a>{" "}
            · {when(request.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge tone={TONE[request.status]}>{REFERRAL_REQUEST_STATUS_LABELS[request.status]}</Badge>
          {request.emailStatus && request.emailStatus !== "SENT" ? <Badge tone="danger">email {request.emailStatus.toLowerCase().replace(/_/g, " ")}</Badge> : null}
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-600">
        {request.locationStatus === "SHARED" && request.mapsUrl ? (
          <>
            Location {request.latitude}, {request.longitude} ·{" "}
            <a href={request.mapsUrl} target="_blank" rel="noreferrer" className="font-medium text-kesari-700 hover:underline">
              Google Maps
            </a>
          </>
        ) : (
          "Location not shared"
        )}
      </p>
      {request.issuedCode ? (
        <p className="mt-1 text-sm">
          Code: <span className="font-mono font-semibold">{request.issuedCode}</span>
        </p>
      ) : null}
      {request.decisionNote ? <p className="mt-1 text-xs text-ink-500">Note: {request.decisionNote}</p> : null}
      {request.emailError ? <p className="mt-1 text-xs text-red-700">{request.emailError}</p> : null}

      {request.status === "NEW" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => setMode(mode === "issue" ? null : "issue")}>
            Issue a code
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setMode(mode === "reject" ? null : "reject")}>
            Reject
          </Button>
          {request.emailStatus !== "SENT" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act({ action: "resend_email" })}>
              Resend email
            </Button>
          ) : null}
        </div>
      ) : null}
      {mode === "issue" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <input className={`${inputClass} min-w-0 flex-1 uppercase`} placeholder="Code (leave empty to generate one)" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="Referral code to issue" />
          <input className={`${inputClass} min-w-0 flex-1`} placeholder="Note (optional)" value={text} onChange={(e) => setText(e.target.value)} aria-label="Note" />
          <Button size="sm" disabled={busy} onClick={() => void act({ action: "issue", code: code.trim() || null, note: text.trim() || null })}>
            Create and issue
          </Button>
        </div>
      ) : null}
      {mode === "reject" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <input className={`${inputClass} min-w-0 flex-1`} placeholder="Reason" value={text} onChange={(e) => setText(e.target.value)} aria-label="Reason for rejecting" />
          <Button size="sm" variant="danger" disabled={busy || text.trim().length < 3} onClick={() => void act({ action: "reject", reason: text })}>
            Reject request
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
