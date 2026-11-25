"use client";

/**
 * docs/tax-register/BOOKS.md: postings queued by paid payouts. The Accountant turns one into a
 * journal draft (then submits it to the CA as usual) or dismisses it with a reason. The month's
 * statutory liabilities (TCS / TDS / GST payable) are shown for challans and returns.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";

export interface AutoPostingRow {
  id: string;
  sourceType: string;
  entryDate: string;
  narration: string;
  totalPaise: number;
  status: string;
  lines: { accountCode: string; accountName: string; debitPaise: number; creditPaise: number }[];
  dismissedReason: string | null;
  journalEntryId: string | null;
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function call(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
  return payload;
}

export function AutoPostings({ rows, canPrepare, month, liabilities }: { rows: AutoPostingRow[]; canPrepare: boolean; month: string; liabilities: { accountCode: string; accountName: string; postedPaise: number; pendingPaise: number }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  async function act(id: string, body: unknown, done: string) {
    setBusy(id);
    setMsg(null);
    try {
      await call(`/api/staff/accounting/auto-postings/${id}`, body);
      setMsg({ tone: "success", text: done });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="grid gap-4">
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-ink-900">Statutory liabilities</h3>
          <form className="flex items-center gap-2" action="/staff/accounting">
            <input type="hidden" name="tab" value="auto" />
            <input className={inputClass} type="month" name="month" defaultValue={month} aria-label="Month" />
            <Button type="submit" size="sm" variant="secondary">Show</Button>
          </form>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-500">
              <th className="py-1">Account</th>
              <th className="py-1 text-right">Posted</th>
              <th className="py-1 text-right">Waiting as postings</th>
            </tr>
          </thead>
          <tbody>
            {liabilities.map((l) => (
              <tr key={l.accountCode} className="border-t border-cream-200">
                <td className="py-1">{l.accountCode} {l.accountName}</td>
                <td className="py-1 text-right">{rupees(l.postedPaise)}</td>
                <td className="py-1 text-right">{rupees(l.pendingPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!rows.length ? (
        <EmptyState title="No postings yet" description="With the auto_journals flag on, every payout that is paid queues a posting here." />
      ) : (
        rows.map((r) => (
          <Card key={r.id} className="space-y-2 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={r.status === "PENDING" ? "warning" : r.status === "DRAFTED" ? "success" : "neutral"}>{r.status}</Badge>
              <span className="font-medium text-ink-900">{r.narration}</span>
              <span className="text-xs text-ink-500">{r.entryDate} · {r.sourceType} · {rupees(r.totalPaise)}</span>
            </div>
            <table className="w-full text-xs">
              <tbody>
                {r.lines.map((l, i) => (
                  <tr key={i} className="border-t border-cream-100">
                    <td className="py-0.5">{l.accountCode} {l.accountName}</td>
                    <td className="py-0.5 text-right">{l.debitPaise ? rupees(l.debitPaise) : ""}</td>
                    <td className="py-0.5 text-right">{l.creditPaise ? rupees(l.creditPaise) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.dismissedReason && <p className="text-xs text-ink-600">Dismissed: {r.dismissedReason}</p>}
            {canPrepare && r.status === "PENDING" && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={busy === r.id} onClick={() => act(r.id, { action: "draft" }, "Journal draft created: submit it to the CA from the Journals tab.")}>Create journal draft</Button>
                <input className={`${inputClass} max-w-xs`} placeholder="Reason to dismiss" value={reason[r.id] ?? ""} onChange={(e) => setReason((s) => ({ ...s, [r.id]: e.target.value }))} />
                <Button size="sm" variant="ghost" disabled={busy === r.id || (reason[r.id] ?? "").trim().length < 5} onClick={() => act(r.id, { action: "dismiss", reason: reason[r.id] }, "Dismissed.")}>Dismiss</Button>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
