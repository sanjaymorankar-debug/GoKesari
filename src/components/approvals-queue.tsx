"use client";

/**
 * RBAC v2 approval queue (docs/rbac). Approve or reject requests raised by someone else; cancel
 * one's own. The server decides who may act — this only hides what would be refused.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";

export interface ApprovalRow {
  id: string;
  type: string;
  title: string;
  reason: string;
  status: string;
  checker: string;
  stage: number;
  requestedBy: string;
  requestedByName: string;
  requestedAtIst: string;
  confirmByIst: string | null;
  overdue: boolean;
  mine: boolean;
}

export function ApprovalsQueue({ rows, canSingleAdmin }: { rows: ApprovalRow[]; canSingleAdmin: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, { tone: "ok" | "error"; text: string }>>({});

  async function act(row: ApprovalRow, action: "APPROVE" | "REJECT" | "CANCEL") {
    setBusy(row.id);
    try {
      const url = action === "CANCEL" ? `/api/approvals/${row.id}/cancel` : `/api/approvals/${row.id}/decide`;
      const body = action === "CANCEL" ? { comment: comments[row.id] ?? null } : { decision: action, comment: comments[row.id] ?? null };
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      const text =
        action === "CANCEL"
          ? "Request cancelled."
          : payload?.applyError
            ? `Approved, but applying it failed: ${payload.applyError}`
            : action === "APPROVE"
              ? payload?.singleAdmin
                ? "Approved as a single-admin approval (recorded and e-mailed to the Super Admin)."
                : "Approved and applied."
              : "Rejected.";
      setMessages((m) => ({ ...m, [row.id]: { tone: payload?.applyError ? "error" : "ok", text } }));
      router.refresh();
    } catch (error) {
      setMessages((m) => ({ ...m, [row.id]: { tone: "error", text: error instanceof Error ? error.message : "That did not work." } }));
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) return <EmptyState title="Nothing waiting" description="No approval requests are pending." />;

  return (
    <div className="grid gap-3" data-testid="approvals-queue">
      {rows.map((row) => (
        <Card key={row.id}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-ink-900">{row.title}</p>
              <p className="text-sm text-ink-600">
                {row.requestedByName} · {row.requestedAtIst} IST · {row.type}
              </p>
              <p className="mt-1 text-sm text-ink-700">Reason: {row.reason}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {row.overdue ? <Badge tone="danger">Confirmation overdue</Badge> : null}
              {row.confirmByIst && !row.overdue ? <Badge tone="warning">Confirm by {row.confirmByIst} IST</Badge> : null}
              {row.mine ? <Badge tone="neutral">Your request</Badge> : null}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              className={inputClass}
              placeholder="Comment (required to reject)"
              value={comments[row.id] ?? ""}
              onChange={(e) => setComments((c) => ({ ...c, [row.id]: e.target.value }))}
              aria-label={`Comment on ${row.title}`}
            />
            {row.mine ? (
              <>
                {canSingleAdmin ? (
                  <Button size="sm" disabled={busy === row.id} onClick={() => act(row, "APPROVE")}>
                    Approve (single admin)
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" disabled={busy === row.id} onClick={() => act(row, "CANCEL")}>
                  Cancel request
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" disabled={busy === row.id} onClick={() => act(row, "APPROVE")}>
                  {row.type === "USER_SUSPEND_CONFIRM" ? "Confirm" : "Approve"}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy === row.id} onClick={() => act(row, "REJECT")}>
                  {row.type === "USER_SUSPEND_CONFIRM" ? "Reject (lift suspension)" : "Reject"}
                </Button>
              </>
            )}
          </div>
          {messages[row.id] ? (
            <div className="mt-2">
              <Alert tone={messages[row.id].tone === "ok" ? "success" : "danger"}>{messages[row.id].text}</Alert>
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
