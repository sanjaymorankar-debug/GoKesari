"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";
import { LEGAL_DOC_STATE_LABELS, type LegalDocState } from "@/lib/legal-documents";

export interface ReviewDoc {
  id: string | null;
  docType: string;
  label: string;
  state: LegalDocState;
  numberMasked: string | null;
  issuingCouncil: string | null;
  expiryDate: string | null;
  rejectionReason: string | null;
  submittedAt: string | null;
  deadline: string | null;
  blocking: boolean;
  expiringSoon: boolean;
  files: { id: string; contentType: string; createdAt: string }[];
  shopId: string;
  shopName: string;
  shopStatus: string;
  city: string;
}

const FILTERS = [
  ["to_review", "To review"],
  ["rejected", "Rejected"],
  ["missing", "Not uploaded"],
  ["expiring", "Expiring soon"],
  ["approved", "Approved"],
  ["all", "All"],
] as const;

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** Operations screen (docs/four-features-2026-10, feature 2): view, approve or reject legal documents. */
export function LegalDocumentReviewQueue({ filter, documents }: { filter: string; documents: ReviewDoc[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sweep() {
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/admin/legal-documents/sweep", { method: "POST" });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    setMessage(
      response.ok
        ? payload?.skipped
          ? "Legal documents are switched off (Business rules → legalDocuments)."
          : `Checked ${payload.shopsChecked} live shops: ${payload.requirementsStarted} new requirement(s) started, ${payload.remindersSent} expiry reminder(s) sent.`
        : (payload?.error?.message ?? "Could not run the check."),
    );
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
          {FILTERS.map(([key, label]) => (
            <Link
              key={key}
              href={`/admin/legal-documents?filter=${key}`}
              className={key === filter ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
            >
              {label}
            </Link>
          ))}
        </nav>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void sweep()}>
          Check all live shops now
        </Button>
      </div>
      {message ? <Alert tone="info">{message}</Alert> : null}
      {documents.length === 0 ? (
        <EmptyState title="Nothing here." />
      ) : (
        documents.map((doc) => <ReviewRow key={`${doc.shopId}-${doc.docType}`} doc={doc} onDone={() => router.refresh()} />)
      )}
    </div>
  );
}

function ReviewRow({ doc, onDone }: { doc: ReviewDoc; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/admin/legal-documents/${doc.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason: decision === "reject" ? reason : null }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not save the decision.");
      return;
    }
    setRejecting(false);
    onDone();
  }

  return (
    <Card className="p-4" data-testid="legal-doc-review-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-ink-900">
            {doc.shopName} <span className="text-sm font-normal text-ink-500">· {doc.city} · shop {doc.shopStatus.toLowerCase().replace(/_/g, " ")}</span>
          </p>
          <p className="text-sm text-ink-700">{doc.label}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge tone={doc.state === "APPROVED" ? "success" : doc.state === "SUBMITTED" ? "info" : "danger"}>{LEGAL_DOC_STATE_LABELS[doc.state]}</Badge>
          {doc.blocking ? <Badge tone="danger">orders blocked</Badge> : null}
          {doc.expiringSoon ? <Badge tone="warning">expires soon</Badge> : null}
        </div>
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-0.5 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-500">Number</dt>
          <dd className="font-mono">{doc.numberMasked ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">{doc.issuingCouncil ? "Issuing council" : "Expiry"}</dt>
          <dd>{doc.issuingCouncil ?? (doc.expiryDate ? dateLabel(`${doc.expiryDate}T00:00:00+05:30`) : "—")}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">{doc.submittedAt ? "Submitted" : "Deadline"}</dt>
          <dd>{doc.submittedAt ? dateLabel(doc.submittedAt) : doc.deadline ? dateLabel(doc.deadline) : "before going live"}</dd>
        </div>
      </dl>
      {doc.rejectionReason ? <p className="mt-1 text-xs text-red-700">Rejected: {doc.rejectionReason}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {doc.files[0] ? (
          <a className="text-sm font-medium text-kesari-700 hover:underline" href={`/api/legal-documents/files/${doc.files[0].id}`} target="_blank" rel="noreferrer">
            Open the uploaded copy
          </a>
        ) : null}
        {doc.state === "SUBMITTED" ? (
          <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>
            Approve
          </Button>
        ) : null}
        {doc.state === "SUBMITTED" || doc.state === "APPROVED" ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejecting((v) => !v)}>
            Reject
          </Button>
        ) : null}
      </div>
      {rejecting ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            className={`${inputClass} min-w-0 flex-1`}
            placeholder="Reason, shown to the shop (e.g. number does not match the copy)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Reason for rejecting"
          />
          <Button size="sm" variant="danger" disabled={busy || reason.trim().length < 5} onClick={() => void decide("reject")}>
            Reject with reason
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
