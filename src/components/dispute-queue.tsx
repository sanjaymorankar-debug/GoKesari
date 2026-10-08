"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";

import { Badge, Button, EmptyState, Money, inputClass } from "@/components/ui";
import {
  DISPUTE_LEVEL_LABELS,
  DISPUTE_OUTCOMES,
  DISPUTE_OUTCOME_LABELS,
  DISPUTE_REASON_LABELS,
  DISPUTE_STATUSES,
  DISPUTE_STATUS_LABELS,
  DISPUTE_TRANSITIONS,
  isDisputeTerminal,
  outcomeRequiresRefund,
  type DisputeLevel,
  type DisputeOutcome,
  type DisputeReason,
  type DisputeStatus,
  type EscalationTrigger,
} from "@/lib/dispute-states";

export interface DisputeRow {
  id: string;
  caseNumber: string;
  orderNumber: string;
  status: DisputeStatus;
  level: DisputeLevel;
  reason: DisputeReason;
  disputedAmountPaise: number;
  paymentMethod: "WALLET" | "COD";
  escalationTrigger: EscalationTrigger | null;
  raisedByName: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<DisputeStatus, "neutral" | "info" | "warning" | "danger" | "success"> = {
  OPEN: "warning",
  TRIAGED: "info",
  INVESTIGATING: "info",
  RESOLUTION_PROPOSED: "info",
  ESCALATED: "danger",
  RESOLVED: "success",
  REJECTED: "neutral",
  WITHDRAWN: "neutral",
};

const COLUMN_COUNT = 7;

/** A random id per resolve, so a double click cannot refund twice. */
const newRequestId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, "").slice(0, 32);

function href(status: DisputeStatus | null, level: DisputeLevel | null): string {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (level) p.set("level", level);
  const q = p.toString();
  return q ? `/admin/disputes?${q}` : "/admin/disputes";
}

export function DisputeQueue({
  rows,
  activeStatus,
  activeLevel,
  filtered,
  isAdmin,
  canRefund,
}: {
  rows: DisputeRow[];
  activeStatus: DisputeStatus | null;
  activeLevel: DisputeLevel | null;
  filtered: boolean;
  isAdmin: boolean;
  canRefund: boolean;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/disputes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "Action failed.");
        return;
      }
      setOpenId(null);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const filters = (
    <nav aria-label="Filter disputes" className="mb-4 space-y-2 text-sm" data-testid="dispute-filters">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-16 text-xs font-medium text-ink-500">Status</span>
        <FilterLink href={href(null, activeLevel)} active={!activeStatus} text="live" />
        {DISPUTE_STATUSES.map((s) => (
          <FilterLink
            key={s}
            href={href(s, activeLevel)}
            active={s === activeStatus}
            text={DISPUTE_STATUS_LABELS[s].toLowerCase()}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-16 text-xs font-medium text-ink-500">Level</span>
        <FilterLink href={href(activeStatus, null)} active={!activeLevel} text="all" />
        <FilterLink href={href(activeStatus, "L1")} active={activeLevel === "L1"} text="operations" />
        <FilterLink href={href(activeStatus, "L2")} active={activeLevel === "L2"} text="escalated" />
      </div>
    </nav>
  );

  if (rows.length === 0) {
    return (
      <>
        {filters}
        <EmptyState
          title={filtered ? "No disputes match these filters." : "No open disputes."}
          action={filtered ? <Link className="text-kesari-600 hover:underline" href="/admin/disputes">Clear filters</Link> : undefined}
        />
      </>
    );
  }

  return (
    <>
      {filters}
      {error ? <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-100 text-left">
              <th className="px-4 py-3 font-semibold">Case</th>
              <th className="px-4 py-3 font-semibold">Order</th>
              <th className="px-4 py-3 font-semibold">Raised by</th>
              <th className="px-4 py-3 font-semibold">Reason</th>
              <th className="px-4 py-3 font-semibold">Disputed</th>
              <th className="px-4 py-3 font-semibold">State</th>
              <th className="px-4 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const open = openId === row.id;
              // An escalated case is an administrator's to take forward: that
              // is what escalation means, and the server enforces it too.
              const mayWork = !isDisputeTerminal(row.status) && (row.level === "L1" || isAdmin);
              return (
                <Fragment key={row.id}>
                  <tr className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs">
                      {/* Event layer: the case page carries the customer/shop conversation. */}
                      <Link href={`/disputes/${row.id}`} className="underline">
                        {row.caseNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">#{row.orderNumber}</td>
                    <td className="px-4 py-3 text-gray-700">{row.raisedByName ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-700">{DISPUTE_REASON_LABELS[row.reason]}</td>
                    <td className="px-4 py-3 font-medium">
                      <Money paise={row.disputedAmountPaise} />
                      <span className="ml-1 text-xs text-ink-500">{row.paymentMethod.toLowerCase()}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={STATUS_TONE[row.status]}>{DISPUTE_STATUS_LABELS[row.status]}</Badge>
                        {row.level === "L2" ? <Badge tone="danger">{DISPUTE_LEVEL_LABELS.L2}</Badge> : null}
                        {row.escalationTrigger && row.escalationTrigger !== "MANUAL" ? (
                          <span className="text-xs text-ink-500">auto: {row.escalationTrigger.toLowerCase()}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {mayWork ? (
                        <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpenId(open ? null : row.id)}>
                          {open ? "Close" : "Work case"}
                        </Button>
                      ) : (
                        <span className="text-xs text-ink-500">
                          {isDisputeTerminal(row.status) ? "closed" : "administrator only"}
                        </span>
                      )}
                    </td>
                  </tr>
                  {open && mayWork ? (
                    <tr className="border-b bg-gray-50">
                      <td colSpan={COLUMN_COUNT} className="px-4 py-4">
                        <CaseActions row={row} busy={busy} canRefund={canRefund} onAct={(body) => act(row.id, body)} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FilterLink({ href, active, text }: { href: string; active: boolean; text: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-lg border px-3 py-1 ${active ? "border-kesari-400 bg-kesari-50" : "border-cream-200"}`}
    >
      {text}
    </Link>
  );
}

function CaseActions({
  row,
  busy,
  canRefund,
  onAct,
}: {
  row: DisputeRow;
  busy: boolean;
  canRefund: boolean;
  onAct: (body: Record<string, unknown>) => void;
}) {
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<DisputeOutcome>("REFUND_FULL");
  const [refundRupees, setRefundRupees] = useState(String(row.disputedAmountPaise / 100));
  const [chargeTo, setChargeTo] = useState<"SHOP" | "PLATFORM">("PLATFORM");

  // Only moves the lifecycle allows, minus the two that have their own action.
  const nextStates = DISPUTE_TRANSITIONS[row.status].filter((s) => s !== "RESOLVED" && s !== "ESCALATED");
  const needsAmount = outcomeRequiresRefund(outcome);

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-medium text-ink-600" htmlFor={`note-${row.id}`}>
          Note — shown to the customer when proposing or rejecting
        </label>
        <textarea
          id={`note-${row.id}`}
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={`${inputClass} mt-1`}
          placeholder="What you found, or what you are offering"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {nextStates.map((s) => (
          <Button
            key={s}
            size="sm"
            variant="secondary"
            disabled={busy || (s === "RESOLUTION_PROPOSED" && note.trim().length === 0)}
            onClick={() =>
              onAct({ action: "advance", to: s, note: note.trim() || null, proposal: s === "RESOLUTION_PROPOSED" ? note.trim() : null })
            }
          >
            {DISPUTE_STATUS_LABELS[s]}
          </Button>
        ))}
        {row.level === "L1" ? (
          <Button size="sm" variant="secondary" disabled={busy || note.trim().length < 3} onClick={() => onAct({ action: "escalate", note: note.trim() })}>
            Escalate
          </Button>
        ) : null}
      </div>

      {DISPUTE_TRANSITIONS[row.status].includes("RESOLVED") ? (
        <div className="border-t border-cream-200 pt-3">
          <p className="mb-2 text-xs font-medium text-ink-600">Resolve</p>
          {canRefund ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-ink-500">
                Outcome
                <select
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value as DisputeOutcome)}
                  className="ml-1 rounded-lg border border-cream-200 px-2 py-1.5 text-sm"
                >
                  {DISPUTE_OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {DISPUTE_OUTCOME_LABELS[o]}
                    </option>
                  ))}
                </select>
              </label>
              {needsAmount ? (
                <>
                  <label className="text-xs text-ink-500">
                    Refund ₹
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={refundRupees}
                      onChange={(e) => setRefundRupees(e.target.value)}
                      className="ml-1 w-28 rounded-lg border border-cream-200 px-2 py-1.5 text-sm"
                    />
                  </label>
                  <label className="text-xs text-ink-500">
                    Borne by
                    <select
                      value={chargeTo}
                      onChange={(e) => setChargeTo(e.target.value as "SHOP" | "PLATFORM")}
                      className="ml-1 rounded-lg border border-cream-200 px-2 py-1.5 text-sm"
                    >
                      <option value="PLATFORM">Platform</option>
                      <option value="SHOP">Shop</option>
                    </select>
                  </label>
                </>
              ) : null}
              <Button
                size="sm"
                disabled={busy || note.trim().length < 3}
                onClick={() =>
                  onAct({
                    action: "resolve",
                    outcome,
                    notes: note.trim(),
                    ...(needsAmount
                      ? { refundPaise: Math.round(Number(refundRupees) * 100), chargeTo }
                      : {}),
                    requestId: newRequestId(),
                  })
                }
              >
                {busy ? "Resolving…" : "Resolve case"}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-600">
              Resolving a dispute decides a refund, which needs the refund permission.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
