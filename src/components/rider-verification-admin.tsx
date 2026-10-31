"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

export interface AdminKycRow {
  id: string;
  docType: "PAN" | "AADHAAR";
  status: "PENDING" | "VERIFIED" | "FAILED";
  numberMasked: string;
  reason: string | null;
  riderName: string;
  riderMobile: string;
  nameOnRecord: string | null;
  nameMatchScore: number | null;
  provider: string;
  updatedAt: string;
}

export interface AdminDocRow {
  id: string;
  label: string;
  status: "UPLOADED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED";
  statusLabel: string;
  rejectionReason: string | null;
  contentType: string;
  sizeBytes: number;
  riderName: string;
  riderMobile: string;
  fileUrl: string;
  createdAt: string;
}

export interface AdminPartnerRow {
  id: string;
  fullName: string;
  mobile: string;
  status: string;
  availability: "OFFLINE" | "ACTIVE" | "READY";
  overridden: boolean;
  overrideReason: string | null;
}

interface SocietyRef {
  societyId: string;
  name: string;
  area: string | null;
  city: string;
  reason: string | null;
}

const KYC_TONE = { VERIFIED: "success", PENDING: "warning", FAILED: "danger" } as const;
const DOC_TONE = { UPLOADED: "info", UNDER_REVIEW: "warning", APPROVED: "success", REJECTED: "danger" } as const;

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.ok) return null;
    const payload = await response.json().catch(() => null);
    return payload?.error?.message ?? "That didn't work. Try again.";
  } catch {
    return "Could not reach the server.";
  }
}

/** Gig worker flow: admin review of partner KYC (feature 2), police verification (3), gate override (5) and society access (7/8). */
export function RiderVerificationAdmin({ kyc, docs, partners }: { kyc: AdminKycRow[]; docs: AdminDocRow[]; partners: AdminPartnerRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, url: string, method: string, body?: unknown) {
    setBusy(key);
    setError(null);
    const problem = await send(url, method, body);
    setBusy(null);
    if (problem) setError(problem);
    else router.refresh();
  }

  return (
    <div className="space-y-6">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card className="p-5" data-testid="admin-kyc-checks">
        <h2 className="mb-3 font-semibold text-ink-900">PAN and Aadhaar checks</h2>
        {kyc.length === 0 ? <p className="text-sm text-ink-500">No checks yet.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm">
          {kyc.map((c) => (
            <li key={c.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink-900">{c.riderName}</span>
                <span className="text-ink-500">{c.riderMobile}</span>
                <Badge>{c.docType === "PAN" ? "PAN" : "Aadhaar"}</Badge>
                <span className="font-mono">{c.numberMasked}</span>
                <Badge tone={KYC_TONE[c.status]}>{c.status.toLowerCase()}</Badge>
              </div>
              <p className="text-xs text-ink-500">
                {c.reason ? `${c.reason} · ` : ""}
                {c.nameOnRecord ? `Name on record: ${c.nameOnRecord}${c.nameMatchScore != null ? ` (match ${c.nameMatchScore}/100)` : ""} · ` : ""}
                via {c.provider} · {new Date(c.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
              </p>
              <DecisionButtons
                busy={busy === c.id}
                options={[
                  { label: "Mark verified", value: "VERIFIED", needsNote: true },
                  { label: "Mark failed", value: "FAILED", needsNote: true, danger: true },
                ]}
                onDecide={(value, note) => run(c.id, `/api/admin/rider-kyc-checks/${c.id}/decision`, "POST", { decision: value, note })}
              />
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5" data-testid="admin-background-docs">
        <h2 className="mb-3 font-semibold text-ink-900">Police verification forms and character certificates</h2>
        {docs.length === 0 ? <p className="text-sm text-ink-500">No documents yet.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm">
          {docs.map((d) => (
            <li key={d.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink-900">{d.riderName}</span>
                <span className="text-ink-500">{d.riderMobile}</span>
                <span>{d.label}</span>
                <Badge tone={DOC_TONE[d.status]}>{d.statusLabel}</Badge>
                <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-kesari-700 underline">
                  Open file ({d.contentType === "application/pdf" ? "PDF" : "image"}, {Math.round(d.sizeBytes / 1000)} KB)
                </a>
              </div>
              {d.rejectionReason ? <p className="text-xs text-red-700">Reason: {d.rejectionReason}</p> : null}
              <DecisionButtons
                busy={busy === d.id}
                options={[
                  ...(d.status === "UPLOADED" ? [{ label: "Start review", value: "UNDER_REVIEW", needsNote: false }] : []),
                  ...(d.status !== "APPROVED" ? [{ label: "Approve", value: "APPROVED", needsNote: false }] : []),
                  ...(d.status !== "REJECTED" ? [{ label: "Reject", value: "REJECTED", needsNote: true, danger: true }] : []),
                ]}
                onDecide={(value, note) => run(d.id, `/api/admin/rider-background-docs/${d.id}/decision`, "POST", { status: value, reason: note || null })}
              />
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5" data-testid="admin-partners">
        <h2 className="mb-3 font-semibold text-ink-900">Partners: verification gate and societies</h2>
        <ul className="divide-y divide-cream-200 text-sm">
          {partners.map((p) => (
            <PartnerRow key={p.id} partner={p} busy={busy} run={run} />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function DecisionButtons({
  options,
  onDecide,
  busy,
}: {
  options: { label: string; value: string; needsNote: boolean; danger?: boolean }[];
  onDecide: (value: string, note: string) => void;
  busy: boolean;
}) {
  const [note, setNote] = useState("");
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note / reason" className={`${inputClass} max-w-xs`} />
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={o.danger ? "danger" : "secondary"}
          disabled={busy || (o.needsNote && note.trim().length < 3)}
          onClick={() => onDecide(o.value, note.trim())}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function PartnerRow({
  partner,
  busy,
  run,
}: {
  partner: AdminPartnerRow;
  busy: string | null;
  run: (key: string, url: string, method: string, body?: unknown) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [access, setAccess] = useState<{ authorised: SocietyRef[]; blocked: SocietyRef[] } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; area: string | null; city: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const response = await fetch(`/api/admin/delivery-partners/${partner.id}/societies`);
    const payload = await response.json().catch(() => null);
    if (response.ok) setAccess(payload.data ?? payload);
    else setMessage(payload?.error?.message ?? "Could not load the societies.");
  }

  async function search() {
    const response = await fetch(`/api/admin/societies-search?q=${encodeURIComponent(query)}`);
    const payload = await response.json().catch(() => null);
    setResults(response.ok ? (payload.data ?? payload).societies : []);
  }

  async function decide(societyId: string, decision: "AUTHORISED" | "BLOCKED" | null) {
    setMessage(null);
    const problem =
      decision === null
        ? await send(`/api/admin/delivery-partners/${partner.id}/societies?societyId=${societyId}`, "DELETE")
        : await send(`/api/admin/delivery-partners/${partner.id}/societies`, "PUT", { societyId, access: decision, reason: reason.trim() || null });
    if (problem) setMessage(problem);
    await load();
  }

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink-900">{partner.fullName}</span>
        <span className="text-ink-500">{partner.mobile}</span>
        <Badge>{partner.status.toLowerCase()}</Badge>
        <Badge tone={partner.availability === "READY" ? "success" : partner.availability === "ACTIVE" ? "info" : "neutral"}>
          {partner.availability.toLowerCase()}
        </Badge>
        {partner.overridden ? <Badge tone="warning">gate overridden</Badge> : null}
        <Button size="sm" variant="ghost" onClick={() => (open ? setOpen(false) : (setOpen(true), void load()))}>
          {open ? "Close" : "Manage"}
        </Button>
      </div>
      {open ? (
        <div className="space-y-3 rounded-lg border border-cream-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (needed to block or override)" className={`${inputClass} max-w-sm`} />
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null || reason.trim().length < 3}
              onClick={() =>
                run(`gate-${partner.id}`, `/api/delivery-partner/${partner.id}`, "PATCH", {
                  action: "override_availability",
                  enabled: !partner.overridden,
                  reason: reason.trim(),
                })
              }
            >
              {partner.overridden ? "Restore the verification gate" : "Override the verification gate"}
            </Button>
          </div>
          <div>
            <p className="mb-1 font-medium text-ink-700">Societies</p>
            {access ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {(["authorised", "blocked"] as const).map((kind) => (
                  <div key={kind}>
                    <p className="text-xs font-semibold uppercase text-ink-500">
                      {kind === "authorised" ? "Authorised" : "Blocked"} ({access[kind].length})
                    </p>
                    <ul className="text-sm">
                      {access[kind].map((s) => (
                        <li key={s.societyId} className="flex items-center justify-between gap-2">
                          <span>
                            {s.name}
                            {s.area ? `, ${s.area}` : ""}, {s.city}
                            {s.reason ? <span className="text-xs text-ink-500"> — {s.reason}</span> : null}
                          </span>
                          <Button size="sm" variant="ghost" onClick={() => void decide(s.societyId, null)}>
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-ink-500">Loading…</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a society" className={`${inputClass} max-w-xs`} />
            <Button size="sm" variant="secondary" disabled={query.trim().length < 2} onClick={() => void search()}>
              Search
            </Button>
          </div>
          <ul className="text-sm">
            {results.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-1">
                <span>
                  {r.name}
                  {r.area ? `, ${r.area}` : ""}, {r.city}
                </span>
                <Button size="sm" variant="secondary" onClick={() => void decide(r.id, "AUTHORISED")}>
                  Authorise
                </Button>
                <Button size="sm" variant="danger" disabled={reason.trim().length < 3} onClick={() => void decide(r.id, "BLOCKED")}>
                  Block
                </Button>
              </li>
            ))}
          </ul>
          {message ? <p className="text-xs text-red-700">{message}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
