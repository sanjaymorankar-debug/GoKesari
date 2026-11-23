"use client";

/**
 * RBAC v2 Phase 3 accounting desk (docs/rbac/03-phase3-accounting.md). The Accountant drafts, submits,
 * withdraws and reverses journal entries and proposes rate changes; the CA closes and reopens periods
 * (approvals are on the Approvals tab). The server decides every permission; this only hides buttons.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";

export interface JournalRow {
  id: string;
  entryNumber: string;
  entryDate: string;
  periodCode: string;
  narration: string;
  status: string;
  totalPaise: number;
  mine: boolean;
  rejectionComment: string | null;
}
export interface PeriodRow {
  code: string;
  status: string;
  closedAtIst: string | null;
  note: string | null;
}
export interface RateRow {
  id: string;
  title: string;
  status: string;
  effectiveIst: string;
  mine: boolean;
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toPaise = (v: string) => Math.round(Number(v || "0") * 100);

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
    throw new Error((fields ? Object.values(fields).join(" ") : null) ?? payload?.error?.message ?? "That did not work.");
  }
  return payload;
}

interface DraftLine {
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
}

export function JournalComposer({ today }: { today: string }) {
  const router = useRouter();
  const [entryDate, setEntryDate] = useState(today);
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([
    { accountCode: "", accountName: "", debit: "", credit: "" },
    { accountCode: "", accountName: "", debit: "", credit: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const debit = lines.reduce((s, l) => s + toPaise(l.debit), 0);
  const credit = lines.reduce((s, l) => s + toPaise(l.credit), 0);

  async function save(submit: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const entry = await call("/api/staff/accounting/journals", "POST", {
        entryDate,
        narration,
        lines: lines.map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, debitPaise: toPaise(l.debit), creditPaise: toPaise(l.credit) })),
      });
      if (submit) await call(`/api/staff/accounting/journals/${entry.id}/submit`, "POST");
      setMsg({ tone: "success", text: `${entry.entryNumber} ${submit ? "sent to the CA for approval" : "saved as a draft"}.` });
      setNarration("");
      setLines([
        { accountCode: "", accountName: "", debit: "", credit: "" },
        { accountCode: "", accountName: "", debit: "", credit: "" },
      ]);
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    } finally {
      setBusy(false);
    }
  }

  const set = (i: number, k: keyof DraftLine, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <Card>
      <p className="mb-2 font-semibold text-ink-900">New journal entry</p>
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <input type="date" className={inputClass} value={entryDate} onChange={(e) => setEntryDate(e.target.value)} aria-label="Entry date" />
        <input className={inputClass} placeholder="Narration" value={narration} onChange={(e) => setNarration(e.target.value)} aria-label="Narration" />
      </div>
      <div className="mt-2 grid gap-1">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 gap-1 sm:grid-cols-[7rem_1fr_8rem_8rem]">
            <input className={inputClass} placeholder="Code" value={l.accountCode} onChange={(e) => set(i, "accountCode", e.target.value)} aria-label={`Line ${i + 1} account code`} />
            <input className={inputClass} placeholder="Account" value={l.accountName} onChange={(e) => set(i, "accountName", e.target.value)} aria-label={`Line ${i + 1} account name`} />
            <input className={inputClass} inputMode="decimal" placeholder="Debit ₹" value={l.debit} onChange={(e) => set(i, "debit", e.target.value)} aria-label={`Line ${i + 1} debit`} />
            <input className={inputClass} inputMode="decimal" placeholder="Credit ₹" value={l.credit} onChange={(e) => set(i, "credit", e.target.value)} aria-label={`Line ${i + 1} credit`} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, { accountCode: "", accountName: "", debit: "", credit: "" }])}>
          + Line
        </Button>
        <span className={debit === credit && debit > 0 ? "text-sm text-leaf-700" : "text-sm text-red-700"}>
          Debits {rupees(debit)} · Credits {rupees(credit)}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => save(false)}>
          Save draft
        </Button>
        <Button size="sm" disabled={busy || debit !== credit || debit === 0} onClick={() => save(true)}>
          Submit to CA
        </Button>
      </div>
      {msg ? (
        <div className="mt-2">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      ) : null}
    </Card>
  );
}

export function JournalList({ rows, canPrepare, today }: { rows: JournalRow[]; canPrepare: boolean; today: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  async function act(id: string, url: string, body?: unknown) {
    setBusy(id);
    try {
      await call(url, "POST", body);
      setMsg((m) => ({ ...m, [id]: "Done." }));
      router.refresh();
    } catch (e) {
      setMsg((m) => ({ ...m, [id]: e instanceof Error ? e.message : "That did not work." }));
    } finally {
      setBusy(null);
    }
  }
  if (rows.length === 0) return <EmptyState title="No journal entries yet" />;
  return (
    <div className="grid gap-2">
      {rows.map((r) => (
        <Card key={r.id}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{r.entryNumber}</span>
            <Badge tone={r.status === "POSTED" ? "success" : r.status === "REJECTED" ? "danger" : r.status === "SUBMITTED" ? "warning" : "neutral"}>{r.status}</Badge>
            <span className="text-sm text-ink-600">
              {r.entryDate} · {rupees(r.totalPaise)}
            </span>
            <span className="flex-1" />
            {canPrepare && r.mine && r.status === "DRAFT" ? (
              <Button size="sm" disabled={busy === r.id} onClick={() => act(r.id, `/api/staff/accounting/journals/${r.id}/submit`)}>
                Submit
              </Button>
            ) : null}
            {canPrepare && r.mine && r.status === "SUBMITTED" ? (
              <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => act(r.id, `/api/staff/accounting/journals/${r.id}/withdraw`)}>
                Withdraw
              </Button>
            ) : null}
            {canPrepare && r.status === "POSTED" ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === r.id}
                onClick={() => {
                  const reason = window.prompt("Why is this entry reversed?");
                  if (reason) void act(r.id, `/api/staff/accounting/journals/${r.id}/reverse`, { entryDate: today, reason });
                }}
              >
                Reverse
              </Button>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-ink-700">{r.narration}</p>
          {r.rejectionComment ? <p className="mt-1 text-sm text-red-700">CA: {r.rejectionComment}</p> : null}
          {msg[r.id] ? <p className="mt-1 text-sm text-ink-600">{msg[r.id]}</p> : null}
        </Card>
      ))}
    </div>
  );
}

export function PeriodList({ rows, canClose }: { rows: PeriodRow[]; canClose: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  async function act(code: string, action: "CLOSE" | "REOPEN") {
    const reason = action === "REOPEN" ? window.prompt(`Why reopen ${code}?`) : null;
    if (action === "REOPEN" && !reason) return;
    try {
      await call(`/api/staff/accounting/periods/${code}`, "POST", { action, reason });
      setMsg(`${code} ${action === "CLOSE" ? "closed" : "reopened"}.`);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That did not work.");
    }
  }
  return (
    <div className="grid gap-2">
      {msg ? <Alert tone="info">{msg}</Alert> : null}
      {rows.length === 0 ? <EmptyState title="No periods yet" description="A month appears when its first entry is drafted." /> : null}
      {rows.map((p) => (
        <Card key={p.code}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{p.code}</span>
            <Badge tone={p.status === "OPEN" ? "success" : "neutral"}>{p.status}</Badge>
            {p.closedAtIst ? <span className="text-sm text-ink-600">closed {p.closedAtIst} IST</span> : null}
            <span className="flex-1" />
            {canClose ? (
              <Button size="sm" variant="secondary" onClick={() => act(p.code, p.status === "OPEN" ? "CLOSE" : "REOPEN")}>
                {p.status === "OPEN" ? "Close period" : "Reopen"}
              </Button>
            ) : null}
          </div>
          {p.note ? <p className="mt-1 text-sm text-ink-600">{p.note}</p> : null}
        </Card>
      ))}
    </div>
  );
}

export function RateProposals({ rows, canPropose }: { rows: RateRow[]; canPropose: boolean }) {
  const router = useRouter();
  const [kind, setKind] = useState<"COMMISSION" | "REGISTRATION_FEE" | "DELIVERY_CHARGE">("COMMISSION");
  const [value, setValue] = useState("");
  const [effective, setEffective] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  async function propose() {
    try {
      const effectiveAt = new Date(`${effective}:00+05:30`).toISOString();
      await call("/api/staff/accounting/rates", "POST", {
        rateKind: kind,
        scope: kind === "COMMISSION" ? "DEFAULT" : undefined,
        rateBp: kind === "COMMISSION" ? Math.round(Number(value) * 100) : undefined,
        amountPaise: kind === "COMMISSION" ? undefined : toPaise(value),
        effectiveAt,
        reason,
      });
      setMsg({ tone: "success", text: "Proposed. The CA approves it, then an admin activates it." });
      setValue("");
      setReason("");
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    }
  }
  return (
    <div className="grid gap-2">
      {canPropose ? (
        <Card>
          <p className="mb-2 font-semibold">Propose a rate change</p>
          <div className="grid gap-2 sm:grid-cols-4">
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Rate">
              <option value="COMMISSION">Default commission (%)</option>
              <option value="REGISTRATION_FEE">Registration fee (₹)</option>
              <option value="DELIVERY_CHARGE">Delivery charge (₹)</option>
            </select>
            <input className={inputClass} inputMode="decimal" placeholder={kind === "COMMISSION" ? "New %" : "New ₹"} value={value} onChange={(e) => setValue(e.target.value)} aria-label="New value" />
            <input type="datetime-local" className={inputClass} value={effective} onChange={(e) => setEffective(e.target.value)} aria-label="Effective from (IST)" />
            <input className={inputClass} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          </div>
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={!value || !effective || reason.trim().length < 5} onClick={propose}>
              Send to CA
            </Button>
          </div>
          {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
        </Card>
      ) : null}
      {rows.length === 0 ? <EmptyState title="No rate proposals" /> : null}
      {rows.map((r) => (
        <Card key={r.id}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{r.title}</span>
            <Badge tone={r.status === "ACTIVATED" ? "success" : r.status === "REJECTED" || r.status === "FAILED" ? "danger" : "warning"}>{r.status}</Badge>
            <span className="text-sm text-ink-600">from {r.effectiveIst} IST</span>
          </div>
        </Card>
      ))}
    </div>
  );
}
