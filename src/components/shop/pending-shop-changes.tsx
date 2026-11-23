"use client";

/**
 * RBAC v2 Phase 5 (brief §4.4): the shop owner's "Pending changes for approval". Old and proposed values side by
 * side, who proposed them and why; approve or reject each item (a rejection needs a comment), or all at once.
 * Shown in the website and, through the app's WebView, on Android and iOS.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";

export interface ChangeItemView {
  id: string;
  label: string;
  productName: string | null;
  previous: string;
  proposed: string;
  status: string;
  rejectionComment: string | null;
  stale: boolean;
}
export interface ChangeRequestView {
  id: string;
  title: string;
  reason: string;
  proposedBy: string;
  requestedAtIst: string;
  expiresAtIst: string | null;
  status: string;
  items: ChangeItemView[];
}

export function PendingShopChanges({ requests, readOnly = false }: { requests: ChangeRequestView[]; readOnly?: boolean }) {
  const router = useRouter();
  const [choice, setChoice] = useState<Record<string, "APPROVE" | "REJECT">>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, { tone: "success" | "danger"; text: string }>>({});

  async function decide(req: ChangeRequestView, all?: "APPROVE" | "REJECT") {
    setBusy(req.id);
    try {
      const pending = req.items.filter((i) => i.status === "PENDING");
      const items = pending.map((i) => ({ itemId: i.id, decision: all ?? choice[i.id] ?? "APPROVE", comment: comments[i.id] || comments[req.id] || null }));
      const missing = items.find((i) => i.decision === "REJECT" && !i.comment);
      if (missing) throw new Error("Write why you reject (a comment is required for every rejected item).");
      const res = await fetch(`/api/approvals/${req.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: all === "REJECT" ? "REJECT" : "APPROVE", comment: comments[req.id] || null, items }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setMsg((m) => ({ ...m, [req.id]: { tone: "success", text: payload?.applyError ? `Saved, but applying failed: ${payload.applyError}` : "Saved. Approved items are live now." } }));
      router.refresh();
    } catch (e) {
      setMsg((m) => ({ ...m, [req.id]: { tone: "danger", text: e instanceof Error ? e.message : "That did not work." } }));
    } finally {
      setBusy(null);
    }
  }

  if (requests.length === 0) return <EmptyState title="Nothing waiting" description="Changes GoKesari support proposes for your shop appear here. Nothing changes until you approve." />;

  return (
    <div className="grid gap-3" data-testid="pending-shop-changes">
      {requests.map((req) => (
        <Card key={req.id}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-ink-900">{req.title}</p>
              <p className="text-sm text-ink-600">
                Proposed by {req.proposedBy} · {req.requestedAtIst} IST{req.expiresAtIst ? ` · decide by ${req.expiresAtIst} IST` : ""}
              </p>
              <p className="mt-1 text-sm text-ink-700">Reason: {req.reason}</p>
            </div>
            {req.status !== "PENDING" ? <Badge tone={req.status === "APPROVED" ? "success" : req.status === "REJECTED" ? "danger" : "neutral"}>{req.status.replace("_", " ")}</Badge> : null}
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-600">
                  <th className="py-1 pr-2">What</th>
                  <th className="py-1 pr-2">Now</th>
                  <th className="py-1 pr-2">Proposed</th>
                  <th className="py-1">{req.status === "PENDING" ? "Your decision" : "Result"}</th>
                </tr>
              </thead>
              <tbody>
                {req.items.map((i) => (
                  <tr key={i.id} className="border-t border-cream-200 align-top">
                    <td className="py-1 pr-2">
                      {i.productName ? <span className="font-medium">{i.productName}: </span> : null}
                      {i.label}
                      {i.stale ? <p className="text-xs text-amber-700">You changed this since it was proposed.</p> : null}
                    </td>
                    <td className="py-1 pr-2 text-ink-600">{i.previous}</td>
                    <td className="py-1 pr-2 font-semibold">{i.proposed}</td>
                    <td className="py-1">
                      {i.status === "PENDING" && readOnly ? (
                        <Badge tone="warning">Waiting for the owner</Badge>
                      ) : i.status === "PENDING" ? (
                        <div className="grid gap-1">
                          <select
                            className={inputClass}
                            value={choice[i.id] ?? "APPROVE"}
                            onChange={(e) => setChoice((c) => ({ ...c, [i.id]: e.target.value as "APPROVE" | "REJECT" }))}
                            aria-label={`Decision for ${i.label}`}
                          >
                            <option value="APPROVE">Approve</option>
                            <option value="REJECT">Reject</option>
                          </select>
                          {choice[i.id] === "REJECT" ? (
                            <input className={inputClass} placeholder="Why? (required)" value={comments[i.id] ?? ""} onChange={(e) => setComments((c) => ({ ...c, [i.id]: e.target.value }))} aria-label={`Rejection comment for ${i.label}`} />
                          ) : null}
                        </div>
                      ) : (
                        <span>
                          <Badge tone={i.status === "APPROVED" ? "success" : i.status === "REJECTED" ? "danger" : "neutral"}>{i.status}</Badge>
                          {i.rejectionComment ? <span className="block text-xs text-ink-600">{i.rejectionComment}</span> : null}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {req.status === "PENDING" && !readOnly ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input className={inputClass} placeholder="Comment (required to reject all)" value={comments[req.id] ?? ""} onChange={(e) => setComments((c) => ({ ...c, [req.id]: e.target.value }))} aria-label="Comment" />
              <Button size="sm" disabled={busy === req.id} onClick={() => decide(req)}>
                Save my decisions
              </Button>
              <Button size="sm" variant="secondary" disabled={busy === req.id} onClick={() => decide(req, "APPROVE")}>
                Approve all
              </Button>
              <Button size="sm" variant="ghost" disabled={busy === req.id || !comments[req.id]} onClick={() => decide(req, "REJECT")}>
                Reject all
              </Button>
            </div>
          ) : null}
          {msg[req.id] ? (
            <div className="mt-2">
              <Alert tone={msg[req.id].tone}>{msg[req.id].text}</Alert>
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
