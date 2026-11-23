"use client";

/**
 * RBAC v2 Phase 3 bank reconciliation desk (docs/rbac/03-phase3-accounting.md §Bank reconciliation).
 * The Accountant imports a statement, matches or excludes each line and submits it; the CA signs it off on the
 * "To approve" tab. The server decides every permission; this only hides buttons.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function errorText(payload: { error?: { message?: string; details?: { fields?: Record<string, string>; rows?: { row: number; message: string }[] } } } | null): string {
  const details = payload?.error?.details;
  if (details?.rows?.length) {
    const shown = details.rows.slice(0, 8).map((r) => `Row ${r.row}: ${r.message}`);
    return [payload?.error?.message, ...shown, details.rows.length > 8 ? `… and ${details.rows.length - 8} more.` : ""].filter(Boolean).join("\n");
  }
  if (details?.fields) return Object.values(details.fields).join(" ");
  return payload?.error?.message ?? "That did not work.";
}

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body instanceof FormData || body === undefined ? undefined : { "content-type": "application/json" },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(payload));
  return payload;
}

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  OPEN: "warning",
  SUBMITTED: "info",
  RECONCILED: "success",
  UNMATCHED: "danger",
  MATCHED: "success",
  EXCLUDED: "neutral",
};

/* ----------------------------------------------------------------- import */

interface Preview {
  lineCount: number;
  periodFrom: string | null;
  periodTo: string | null;
  totalDebitPaise: number;
  totalCreditPaise: number;
  openingBalancePaise: number | null;
  closingBalancePaise: number | null;
  errors: { row: number; message: string }[];
  warnings: string[];
}

export function BankStatementImport() {
  const router = useRouter();
  const [accountLabel, setAccountLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function send(previewOnly: boolean) {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("accountLabel", accountLabel);
      if (previewOnly) form.set("preview", "1");
      const result = await call("/api/staff/accounting/bank-statements", "POST", form);
      if (previewOnly) {
        setPreview(result as Preview);
      } else {
        setMsg({
          tone: "success",
          text: `${result.statement.statementNumber} imported: ${result.matched} matched automatically, ${result.suggested} with a suggestion, ${result.unmatched - result.suggested} to match by hand.`,
        });
        setPreview(null);
        setFile(null);
        router.push(`/staff/accounting?tab=bank&statement=${result.statement.id}`);
      }
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <p className="mb-1 font-semibold text-ink-900">Import a bank statement</p>
      <p className="mb-2 text-sm text-ink-600">
        CSV or Excel as downloaded from the bank. Columns are recognised by name (Date, Narration, Ref No, Withdrawal / Deposit or Debit / Credit, Balance).
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
        <input
          className={inputClass}
          placeholder="Account, e.g. HDFC current ••1234"
          value={accountLabel}
          onChange={(e) => setAccountLabel(e.target.value)}
          aria-label="Bank account name"
        />
        <input
          className={inputClass}
          type="file"
          accept=".csv,.xlsx"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
          }}
          aria-label="Statement file"
        />
      </div>
      {preview ? (
        <div className="mt-2 grid gap-1 text-sm text-ink-700">
          <p>
            {preview.lineCount} lines, {preview.periodFrom} to {preview.periodTo}. Debits {rupees(preview.totalDebitPaise)}, credits {rupees(preview.totalCreditPaise)}.
            {preview.openingBalancePaise != null && preview.closingBalancePaise != null
              ? ` Opening ${rupees(preview.openingBalancePaise)}, closing ${rupees(preview.closingBalancePaise)}.`
              : " The file has no balance column."}
          </p>
          {preview.errors.length ? (
            <Alert tone="danger" title={`${preview.errors.length} rows have problems — fix them before importing`}>
              {preview.errors.slice(0, 10).map((e) => (
                <span key={e.row} className="block">
                  Row {e.row}: {e.message}
                </span>
              ))}
            </Alert>
          ) : null}
          {preview.warnings.length ? (
            <Alert tone="warning">
              {preview.warnings.slice(0, 10).map((w) => (
                <span key={w} className="block">
                  {w}
                </span>
              ))}
            </Alert>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy || !file} onClick={() => send(true)}>
          Check file
        </Button>
        <Button size="sm" disabled={busy || !file || accountLabel.trim().length < 3 || (preview?.errors.length ?? 0) > 0} onClick={() => send(false)}>
          Import and match
        </Button>
      </div>
      {msg ? (
        <div className="mt-2 whitespace-pre-line">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------- list */

export interface BankStatementRow {
  id: string;
  statementNumber: string;
  accountLabel: string;
  periodFrom: string;
  periodTo: string;
  lineCount: number;
  status: string;
  rejectionComment: string | null;
}

export function BankStatementList({ rows }: { rows: BankStatementRow[] }) {
  if (!rows.length) return <EmptyState title="No bank statements yet" description="Imported statements appear here with their reconciliation status." />;
  return (
    <div className="grid gap-2">
      {rows.map((r) => (
        <Link key={r.id} href={`/staff/accounting?tab=bank&statement=${r.id}`} className="block min-h-11 rounded-xl border border-cream-200 bg-white p-3 hover:border-kesari-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink-900">{r.statementNumber}</span>
            <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
            <span className="text-sm text-ink-600">{r.accountLabel}</span>
          </div>
          <p className="text-sm text-ink-600">
            {r.periodFrom} to {r.periodTo} · {r.lineCount} lines
          </p>
          {r.rejectionComment ? <p className="text-sm text-red-700">Sent back by the CA: {r.rejectionComment}</p> : null}
        </Link>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- detail */

export interface BankLineRow {
  id: string;
  lineNo: number;
  txnDate: string;
  description: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  status: string;
  matchLabel: string | null;
  matchMethod: string | null;
  note: string | null;
  suggestion: { label: string; amountPaise: number; why: string } | null;
}

export interface BankStatementDetailProps {
  id: string;
  statementNumber: string;
  accountLabel: string;
  periodFrom: string;
  periodTo: string;
  status: string;
  mine: boolean;
  canPrepare: boolean;
  rejectionComment: string | null;
  warnings: string[];
  totals: { debitPaise: number; creditPaise: number; openingPaise: number | null; closingPaise: number | null };
  check: { unmatched: number; matched: number; excluded: number; balanceDifferencePaise: number | null };
  lines: BankLineRow[];
  filter: string;
  unrecorded: { kind: string; id: string; label: string; amountPaise: number; date: string | null; reference: string | null }[];
}

interface Candidate {
  kind: string;
  id: string;
  label: string;
  amountPaise: number;
  date: string | null;
  reference: string | null;
}

export function BankStatementDetail(p: BankStatementDetailProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const editable = p.canPrepare && p.status === "OPEN";

  async function act(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (done) setMsg({ tone: "success", text: done });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    } finally {
      setBusy(null);
    }
  }

  async function loadCandidates(lineId: string, q = "") {
    setBusy(`find:${lineId}`);
    try {
      const res = await call(`/api/staff/accounting/bank-lines/${lineId}${q ? `?q=${encodeURIComponent(q)}` : ""}`, "GET");
      setCandidates(res as Candidate[]);
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    } finally {
      setBusy(null);
    }
  }

  const base = `/staff/accounting?tab=bank&statement=${p.id}`;
  const lineAction = (lineId: string, body: unknown) => call(`/api/staff/accounting/bank-lines/${lineId}`, "POST", body);

  return (
    <div className="grid gap-3">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink-900">{p.statementNumber}</span>
          <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
          <span className="text-sm text-ink-600">{p.accountLabel}</span>
        </div>
        <p className="mt-1 text-sm text-ink-700">
          {p.periodFrom} to {p.periodTo} · debits {rupees(p.totals.debitPaise)} · credits {rupees(p.totals.creditPaise)}
          {p.totals.openingPaise != null && p.totals.closingPaise != null ? ` · opening ${rupees(p.totals.openingPaise)} · closing ${rupees(p.totals.closingPaise)}` : ""}
        </p>
        <p className="mt-1 text-sm">
          <span className="text-leaf-700">{p.check.matched} matched</span> · <span className="text-ink-600">{p.check.excluded} excluded</span> ·{" "}
          <span className={p.check.unmatched ? "text-red-700" : "text-ink-600"}>{p.check.unmatched} unmatched</span>
          {p.check.balanceDifferencePaise ? <span className="text-red-700"> · balances differ by {rupees(Math.abs(p.check.balanceDifferencePaise))}</span> : null}
        </p>
        {p.rejectionComment ? <p className="mt-1 text-sm text-red-700">Sent back by the CA: {p.rejectionComment}</p> : null}
        {p.warnings.length ? (
          <div className="mt-2">
            <Alert tone="warning">
              {p.warnings.slice(0, 5).map((w) => (
                <span key={w} className="block">
                  {w}
                </span>
              ))}
            </Alert>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <a className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline" href={`/api/staff/accounting/bank-statements/${p.id}?format=csv`}>
            Download CSV
          </a>
          {editable ? (
            <>
              <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act("auto", () => call(`/api/staff/accounting/bank-statements/${p.id}/auto-match`, "POST"), "Automatic matching run again.")}>
                Match again
              </Button>
              {p.mine ? (
                <Button
                  size="sm"
                  disabled={!!busy || p.check.unmatched > 0 || !!p.check.balanceDifferencePaise}
                  onClick={() => act("submit", () => call(`/api/staff/accounting/bank-statements/${p.id}/submit`, "POST"), "Sent to the CA for sign-off.")}
                >
                  Submit to CA
                </Button>
              ) : null}
              {p.mine ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => {
                    if (!window.confirm(`Delete ${p.statementNumber}? Its matches are released; you can import the file again.`)) return;
                    void act("delete", async () => {
                      await call(`/api/staff/accounting/bank-statements/${p.id}`, "DELETE");
                      router.push("/staff/accounting?tab=bank");
                    });
                  }}
                >
                  Delete
                </Button>
              ) : null}
            </>
          ) : null}
          {p.canPrepare && p.mine && p.status === "SUBMITTED" ? (
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act("withdraw", () => call(`/api/staff/accounting/bank-statements/${p.id}/withdraw`, "POST"), "Withdrawn; you can change it again.")}>
              Withdraw
            </Button>
          ) : null}
        </div>
        {msg ? (
          <div className="mt-2 whitespace-pre-line">
            <Alert tone={msg.tone}>{msg.text}</Alert>
          </div>
        ) : null}
      </Card>

      <nav className="flex flex-wrap gap-1" aria-label="Line filter">
        {[
          ["", "All"],
          ["UNMATCHED", "Unmatched"],
          ["MATCHED", "Matched"],
          ["EXCLUDED", "Excluded"],
          ["unrecorded", "Paid, not in bank"],
        ].map(([key, label]) => (
          <Link
            key={key}
            href={key ? `${base}&lines=${key}` : base}
            className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold ${p.filter === key ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700"}`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {p.filter === "unrecorded" ? (
        p.unrecorded.length ? (
          <div className="grid gap-2">
            <p className="text-sm text-ink-600">Recorded as paid between {p.periodFrom} and {p.periodTo}, but no line of any statement is matched to them yet.</p>
            {p.unrecorded.map((u) => (
              <div key={`${u.kind}:${u.id}`} className="rounded-xl border border-cream-200 bg-white p-3 text-sm">
                <p className="font-semibold text-ink-900">
                  {rupees(u.amountPaise)} · {u.label}
                </p>
                <p className="text-ink-600">
                  {u.date ?? "no date"} · ref {u.reference ?? "none recorded"}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="Nothing missing" description="Every payout and refund recorded as paid in these dates is on a bank statement." />
        )
      ) : (
        <div className="grid gap-2">
          {p.lines.length === 0 ? <EmptyState title="No lines here" description="Try another filter." /> : null}
          {p.lines.map((l) => (
            <div key={l.id} className="rounded-xl border border-cream-200 bg-white p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ink-500">#{l.lineNo}</span>
                <span className="text-ink-700">{l.txnDate}</span>
                <span className={`font-semibold ${l.debitPaise ? "text-ink-900" : "text-leaf-700"}`}>
                  {l.debitPaise ? `− ${rupees(l.debitPaise)}` : `+ ${rupees(l.creditPaise)}`}
                </span>
                <Badge tone={STATUS_TONE[l.status]}>{l.status === "MATCHED" && l.matchMethod === "AUTO" ? "MATCHED (auto)" : l.status}</Badge>
              </div>
              <p className="break-words text-ink-700">{l.description || "—"}</p>
              {l.reference ? <p className="break-all text-ink-500">Ref {l.reference}</p> : null}
              {l.matchLabel ? <p className="text-leaf-700">→ {l.matchLabel}</p> : null}
              {l.note ? <p className="text-ink-600">Note: {l.note}</p> : null}
              {l.status === "UNMATCHED" && l.suggestion ? (
                <p className="text-ink-700">
                  Suggested: {l.suggestion.label} ({rupees(l.suggestion.amountPaise)}). <span className="text-ink-500">{l.suggestion.why}</span>
                </p>
              ) : null}
              {editable ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  {l.status === "UNMATCHED" ? (
                    <>
                      {l.suggestion && l.suggestion.amountPaise === (l.debitPaise || l.creditPaise) ? (
                        <Button size="sm" disabled={!!busy} onClick={() => act(l.id, () => lineAction(l.id, { action: "accept" }), `Line ${l.lineNo} matched.`)}>
                          Accept suggestion
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!!busy}
                        onClick={() => {
                          setOpenLine(openLine === l.id ? null : l.id);
                          setCandidates([]);
                          setSearch("");
                          setReason("");
                          if (openLine !== l.id) void loadCandidates(l.id);
                        }}
                      >
                        {openLine === l.id ? "Close" : "Find match / exclude"}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act(l.id, () => lineAction(l.id, { action: "unmatch" }), `Line ${l.lineNo} is unmatched again.`)}>
                      Undo
                    </Button>
                  )}
                </div>
              ) : null}
              {editable && openLine === l.id ? (
                <div className="mt-2 grid gap-2 rounded-lg bg-cream-50 p-2">
                  <div className="flex flex-wrap gap-2">
                    <input
                      className={`${inputClass} min-w-0 flex-1`}
                      placeholder="Search reference, shop or entry number"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      aria-label="Search records"
                    />
                    <Button size="sm" variant="secondary" disabled={!!busy || search.trim().length < 3} onClick={() => loadCandidates(l.id, search.trim())}>
                      Search
                    </Button>
                  </div>
                  {candidates.length ? (
                    candidates.map((c) => (
                      <div key={`${c.kind}:${c.id}`} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 break-words">
                          {rupees(c.amountPaise)} · {c.label} · {c.date ?? "no date"}
                          {c.reference ? ` · ref ${c.reference}` : ""}
                        </span>
                        <Button
                          size="sm"
                          disabled={!!busy}
                          onClick={() =>
                            act(l.id, async () => {
                              await lineAction(l.id, { action: "match", kind: c.kind, id: c.id });
                              setOpenLine(null);
                            }, `Line ${l.lineNo} matched.`)
                          }
                        >
                          Match
                        </Button>
                      </div>
                    ))
                  ) : (
                    <p className="text-ink-600">No unmatched record of this amount within 10 days. Search, or post a journal entry for it first.</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <input
                      className={`${inputClass} min-w-0 flex-1`}
                      placeholder="Or exclude: reason (bank charges, interest …)"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      aria-label="Reason to exclude"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!!busy || reason.trim().length < 5}
                      onClick={() =>
                        act(l.id, async () => {
                          await lineAction(l.id, { action: "exclude", reason });
                          setOpenLine(null);
                        }, `Line ${l.lineNo} excluded.`)
                      }
                    >
                      Exclude
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
