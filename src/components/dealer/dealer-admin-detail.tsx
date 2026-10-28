"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { DEALER_TYPE_LABELS, type DealerType } from "@/lib/dealers";

interface Doc {
  id: string;
  docType: string;
  label: string;
  fileName: string;
  sizeBytes: number;
  status: "SUBMITTED" | "ACCEPTED" | "REJECTED";
  reviewNote: string | null;
  uploadedAt: string;
}

interface Dealer {
  id: string;
  status: string;
  statusLabel: string;
  statusReason: string | null;
  dealerType: DealerType;
  mobileMasked: string | null;
  mobileVerified: boolean;
  mobileVerificationMethod: string | null;
  email: string | null;
  panMasked: string | null;
  gstin: string | null;
  shopActNumber: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; pincode: string | null; state: string | null };
  bank: { holderName: string | null; accountMasked: string | null; ifsc: string | null; status: string; reason: string | null };
  agreement: { version: string | null; acceptedAt: string | null; start: string | null; end: string | null };
  territories: string[];
  territoryNames: string[];
  requirements: { docType: string; label: string; required: boolean; status: string }[];
  documents: Doc[];
  codes: { id: string; code: string; kind: string; status: string; salespersonId: string | null }[];
  isInternal: boolean;
  source: string;
}

interface Employee {
  id: string;
  employeeId: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  code: string | null;
}

const addYear = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Staff view of one dealer (docs/dealer-programme). Everything is shown
 * masked. Admin-only controls (the server checks again): accept / reject a
 * document, reveal PAN or account number with a reason (audited), the
 * decision, replacing a code, and switching an employee off or on.
 */
export function DealerAdminDetail({ isAdmin, dealer, employees, today }: { isAdmin: boolean; dealer: Dealer; employees: Employee[]; today: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(addYear(today));
  const [byCall, setByCall] = useState(false);
  const [bankByDoc, setBankByDoc] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  async function post(url: string, body: unknown, label: string, done: string, method = "POST") {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(done);
      router.refresh();
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function reveal(what: "PAN" | "BANK_ACCOUNT") {
    const why = window.prompt(`Why do you need to see the full ${what === "PAN" ? "PAN" : "account number"}? (recorded in the audit log)`);
    if (!why) return;
    const res = await post(`/api/admin/dealers/${dealer.id}/reveal`, { what, reason: why }, `reveal-${what}`, "Shown below; the reveal is logged.");
    if (res?.value) setRevealed((r) => ({ ...r, [what]: res.value }));
  }

  const decide = (action: string) =>
    post(
      `/api/admin/dealers/${dealer.id}/decision`,
      action === "APPROVE" ? { action, agreementStart: start, agreementEnd: end, mobileConfirmedByCall: byCall, bankVerifiedByDocument: bankByDoc } : { action, reason },
      `decide-${action}`,
      `Done: ${action.toLowerCase()}.`,
    );

  return (
    <div className="space-y-4" data-testid="dealer-admin-detail">
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className="space-y-2 p-4 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone={dealer.status === "APPROVED" ? "success" : dealer.status === "PENDING" ? "warning" : "neutral"}>{dealer.statusLabel}</Badge>
          <span>{DEALER_TYPE_LABELS[dealer.dealerType]}</span>
          {dealer.isInternal ? <Badge tone="info">Internal (GoKesari Direct)</Badge> : null}
          {dealer.source === "LEGACY_MIGRATION" && !dealer.isInternal ? <Badge tone="info">Former distributor</Badge> : null}
        </p>
        {dealer.statusReason ? <p>Reason: {dealer.statusReason}</p> : null}
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <div>
            <dt className="text-ink-500">Mobile</dt>
            <dd>
              {dealer.mobileMasked ?? "—"} {dealer.mobileVerified ? <Badge tone="success">verified ({dealer.mobileVerificationMethod?.toLowerCase()})</Badge> : <Badge tone="warning">not verified</Badge>}
            </dd>
          </div>
          <div>
            <dt className="text-ink-500">Email</dt>
            <dd>{dealer.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-ink-500">PAN</dt>
            <dd>
              {revealed.PAN ?? dealer.panMasked ?? "—"}{" "}
              {isAdmin && dealer.panMasked && !revealed.PAN ? (
                <button type="button" className="min-h-11 text-kesari-800 underline" onClick={() => reveal("PAN")}>
                  Reveal
                </button>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-ink-500">GSTIN / Shop Act</dt>
            <dd>
              {dealer.gstin ?? "—"} / {dealer.shopActNumber ?? "—"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-ink-500">Address</dt>
            <dd>{[dealer.address.line1, dealer.address.line2, dealer.address.city, dealer.address.pincode, dealer.address.state].filter(Boolean).join(", ") || "—"}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-ink-500">Bank</dt>
            <dd>
              {dealer.bank.holderName ?? "—"} · {revealed.BANK_ACCOUNT ?? dealer.bank.accountMasked ?? "—"} · {dealer.bank.ifsc ?? "—"}{" "}
              <Badge tone={dealer.bank.status === "VERIFIED" ? "success" : dealer.bank.status === "FAILED" ? "danger" : "warning"}>{dealer.bank.status.toLowerCase().replace("_", " ")}</Badge>
              {dealer.bank.reason ? <span className="block text-xs text-ink-600">{dealer.bank.reason}</span> : null}
              {isAdmin && dealer.bank.accountMasked && !revealed.BANK_ACCOUNT ? (
                <button type="button" className="mr-3 min-h-11 text-kesari-800 underline" onClick={() => reveal("BANK_ACCOUNT")}>
                  Reveal
                </button>
              ) : null}
              {isAdmin && dealer.bank.accountMasked && dealer.bank.status !== "VERIFIED" ? (
                <button type="button" className="min-h-11 text-kesari-800 underline" onClick={() => post(`/api/admin/dealers/${dealer.id}/bank-check`, {}, "bank", "Bank asked again.")}>
                  Check with the bank
                </button>
              ) : null}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-ink-500">Areas</dt>
            <dd>{dealer.territoryNames.join(", ") || "—"}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-ink-500">Agreement</dt>
            <dd>
              {dealer.agreement.acceptedAt ? `Version ${dealer.agreement.version} accepted ${dealer.agreement.acceptedAt.slice(0, 10)}` : "Not accepted"}
              {dealer.agreement.start ? ` · valid ${dealer.agreement.start} to ${dealer.agreement.end}` : ""}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Documents</h2>
        <ul className="divide-y divide-cream-200 text-sm">
          {dealer.requirements.map((r) => (
            <li key={r.docType} className="py-1">
              {r.label} {r.required ? <Badge tone="warning">required</Badge> : <Badge>optional</Badge>} <Badge tone={r.status === "ACCEPTED" ? "success" : r.status === "REJECTED" ? "danger" : r.status === "MISSING" ? "neutral" : "info"}>{r.status.toLowerCase()}</Badge>
            </li>
          ))}
        </ul>
        <ul className="space-y-2 text-sm" data-testid="dealer-documents">
          {dealer.documents.map((d) => (
            <li key={d.id} className="rounded-xl border border-cream-200 p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-semibold">{d.label}</span> · {d.fileName} · {Math.ceil(d.sizeBytes / 1024)} KB · {d.uploadedAt.slice(0, 10)}{" "}
                  <Badge tone={d.status === "ACCEPTED" ? "success" : d.status === "REJECTED" ? "danger" : "info"}>{d.status.toLowerCase()}</Badge>
                  {d.reviewNote ? <span className="block text-xs text-ink-600">{d.reviewNote}</span> : null}
                </span>
                {isAdmin ? (
                  <a className="inline-flex min-h-11 items-center text-kesari-800 underline" href={`/api/dealer/documents/${d.id}`} target="_blank" rel="noopener noreferrer">
                    Open (logged)
                  </a>
                ) : null}
              </div>
              {isAdmin && d.status === "SUBMITTED" ? (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Button size="sm" disabled={busy !== null} onClick={() => post(`/api/admin/dealers/${dealer.id}/documents/${d.id}`, { decision: "ACCEPTED" }, `doc-${d.id}`, `${d.label} accepted.`)}>
                    Accept
                  </Button>
                  <input
                    className={`${inputClass} max-w-xs`}
                    placeholder="Why rejected (sent to the dealer)"
                    value={notes[d.id] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [d.id]: e.target.value }))}
                    maxLength={500}
                    aria-label={`Reason for rejecting ${d.label}`}
                  />
                  <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => post(`/api/admin/dealers/${dealer.id}/documents/${d.id}`, { decision: "REJECTED", note: notes[d.id] ?? "" }, `doc-${d.id}`, `${d.label} rejected.`)}>
                    Reject
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Codes</h2>
        {dealer.codes.length === 0 ? <p className="text-sm text-ink-600">No code yet — it is issued on approval.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm" data-testid="dealer-codes">
          {dealer.codes.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span>
                <span className="font-mono">{c.code}</span> · {c.kind === "SALESPERSON" ? `employee ${employees.find((e) => e.id === c.salespersonId)?.name ?? ""}` : c.kind.toLowerCase()}{" "}
                <Badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>{c.status.toLowerCase()}</Badge>
              </span>
              {isAdmin && (c.status === "ACTIVE" || c.status === "SUSPENDED") && c.kind !== "LEGACY" ? (
                <button
                  type="button"
                  className="min-h-11 text-kesari-800 underline"
                  onClick={() => {
                    const why = window.prompt("Why replace this code? The old one stops working for new registrations.");
                    if (why) void post(`/api/admin/dealers/${dealer.id}/codes/${c.id}/replace`, { reason: why }, `code-${c.id}`, "Code replaced.");
                  }}
                >
                  Replace
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Employees</h2>
        {employees.length === 0 ? <p className="text-sm text-ink-600">None.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm">
          {employees.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span>
                {e.name} · ID {e.employeeId} {e.code ? <span className="font-mono">· {e.code}</span> : null} <Badge tone={e.status === "ACTIVE" ? "success" : "neutral"}>{e.status.toLowerCase()}</Badge>
              </span>
              {isAdmin ? (
                <button
                  type="button"
                  className="min-h-11 text-kesari-800 underline"
                  onClick={() => post(`/api/admin/dealers/${dealer.id}/salespeople/${e.id}`, { status: e.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }, `emp-${e.id}`, "Employee updated.", "PATCH")}
                >
                  {e.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {isAdmin && !dealer.isInternal ? (
        <Card className="space-y-3 p-4" data-testid="dealer-decision">
          <h2 className="text-base font-bold text-ink-900">Decision</h2>
          {dealer.status === "PENDING" ? (
            <div className="space-y-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Agreement starts">
                  <input type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
                </Field>
                <Field label="Agreement ends">
                  <input type="date" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
                </Field>
              </div>
              {!dealer.mobileVerified ? (
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" checked={byCall} onChange={(e) => setByCall(e.target.checked)} />I called the dealer on this number and confirmed it.
                </label>
              ) : null}
              {dealer.bank.status !== "VERIFIED" ? (
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" checked={bankByDoc} onChange={(e) => setBankByDoc(e.target.checked)} />I checked the account against the accepted cancelled cheque / bank proof.
                </label>
              ) : null}
              <Button disabled={busy !== null} onClick={() => decide("APPROVE")}>
                Approve and issue the code
              </Button>
            </div>
          ) : null}
          {["PENDING", "APPROVED", "SUSPENDED"].includes(dealer.status) ? (
            <div className="space-y-2 border-t border-cream-200 pt-3">
              <Field label="Reason (sent to the dealer)">
                <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </Field>
              <div className="flex flex-wrap gap-2">
                {dealer.status === "PENDING" ? (
                  <Button variant="danger" disabled={busy !== null} onClick={() => decide("REJECT")}>
                    Reject
                  </Button>
                ) : null}
                {dealer.status === "APPROVED" ? (
                  <Button variant="secondary" disabled={busy !== null} onClick={() => decide("SUSPEND")}>
                    Suspend
                  </Button>
                ) : null}
                {dealer.status === "SUSPENDED" ? (
                  <Button disabled={busy !== null} onClick={() => decide("REACTIVATE")}>
                    Reactivate
                  </Button>
                ) : null}
                {dealer.status !== "PENDING" ? (
                  <Button variant="danger" disabled={busy !== null} onClick={() => window.confirm("Terminate this dealer? Every code stops working and employees lose access. Shops stay live.") && decide("TERMINATE")}>
                    Terminate
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
