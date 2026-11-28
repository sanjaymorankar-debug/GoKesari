"use client";

/**
 * The turnover fee slabs' On/Off button (owner, 28-Nov-2026) — always four-eye. An admin or operator asks to switch
 * the slabs on or off; nothing changes until a DIFFERENT admin or operator approves. The server
 * (services/turnover-fee-switch.ts, the approvals engine) decides who may act; this only hides what would be refused.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import { formatPaise } from "@/lib/money";

export interface TurnoverSwitchView {
  enabled: boolean;
  flatFeePaise: number | null;
  pending: {
    approvalId: string;
    enabled: boolean;
    reason: string;
    requestedBy: string;
    requestedByName: string | null;
    requestedByRole: string;
    requestedAt: string;
  } | null;
}

const onOff = (enabled: boolean) => (enabled ? "On" : "Off");

export function TurnoverFeeSwitch({ state, viewerId, gstLabel }: { state: TurnoverSwitchView; viewerId: string; gstLabel: string | null }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const gst = gstLabel ? `+ GST at ${gstLabel}` : "+ GST";
  const flat = state.flatFeePaise === null ? "no flat fee configured" : `flat ${formatPaise(state.flatFeePaise)} ${gst}`;
  const summary = state.enabled ? `On — fee by declared annual turnover (slabs below) ${gst}` : `Off — ${flat}`;
  const pending = state.pending;
  const mine = pending?.requestedBy === viewerId;

  async function send(url: string, body: unknown, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setMessage({ tone: payload?.applyError ? "danger" : "success", text: payload?.applyError ? `Approved, but applying it failed: ${payload.applyError}` : (payload?.message ?? done) });
      setReason("");
      setComment("");
      router.refresh();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "That did not work." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="turnover-fee-switch">
      <p className="text-sm font-semibold text-ink-900" data-testid="turnover-switch-state">
        Turnover slabs: {summary}
      </p>
      <p className="text-xs text-ink-500">
        Off: every new shop pays the flat registration fee. On: the owner declares their annual turnover and pays its
        slab&apos;s fee. Switching needs two people: an admin or operator asks, a different admin or operator approves.
        Shops already registered keep the fee they registered with.
      </p>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}

      {pending ? (
        <div className="space-y-2 rounded-xl border border-[var(--gk-line)] p-3" data-testid="turnover-switch-pending">
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-800">
            <Badge tone="warning">Waiting for approval</Badge>
            Switch {onOff(pending.enabled)}, asked by {pending.requestedByName ?? "a colleague"} ({pending.requestedByRole.toLowerCase()}) on{" "}
            {new Date(pending.requestedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST.
          </p>
          <p className="text-xs text-ink-500">Reason: {pending.reason}</p>
          <label className="block">
            <span className="text-xs text-ink-500">{mine ? "Comment (optional)" : "Comment (required to reject)"}</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} className={inputClass} maxLength={1000} aria-label="Comment" />
          </label>
          {mine ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => send(`/api/approvals/${pending.approvalId}/cancel`, { comment: comment || null }, "Request cancelled.")}>
                Cancel my request
              </Button>
              <p className="text-xs text-ink-500">You asked for this: a different admin or operator must approve it.</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => send(`/api/approvals/${pending.approvalId}/decide`, { decision: "APPROVE", comment: comment || null }, `Approved: turnover slabs ${onOff(pending.enabled)}.`)}>
                Approve: switch {onOff(pending.enabled)}
              </Button>
              <Button variant="secondary" disabled={busy || !comment.trim()} onClick={() => send(`/api/approvals/${pending.approvalId}/decide`, { decision: "REJECT", comment }, "Rejected. Nothing changed.")}>
                Reject
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs text-ink-500">Reason (optional)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} maxLength={500} aria-label="Reason" />
          </label>
          <Button disabled={busy} onClick={() => send("/api/admin/turnover-fee-switch", { enabled: !state.enabled, reason: reason || null }, "Sent for approval.")} data-testid="turnover-switch-request">
            Ask to switch turnover slabs {onOff(!state.enabled)}
          </Button>
        </div>
      )}
    </Card>
  );
}
