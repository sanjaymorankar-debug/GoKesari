"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button } from "@/components/ui";

export interface PayLaterTableRow {
  id: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED" | "SETTLED";
  amount: string;
  recovered: string;
  due: string | null;
  ownerNote: string | null;
  decisionNote: string | null;
  requestedAt: string;
  decidedAt: string | null;
  owner: string;
  ownerContact: string;
  shopId: string | null;
  shopName: string | null;
  shopStatus: string | null;
  registrationNumber: string | null;
}

const TONE: Record<PayLaterTableRow["status"], "warning" | "success" | "danger" | "neutral" | "info"> = {
  REQUESTED: "warning",
  APPROVED: "info",
  REJECTED: "danger",
  CANCELLED: "neutral",
  SETTLED: "success",
};

/** docs/fee-pay-later-2026-11 (0229): Admin → Shops → Pay-later requests — approve or reject each request. */
export function FeePayLaterTable({ rows }: { rows: PayLaterTableRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);

  async function decide(row: PayLaterTableRow, decision: "APPROVE" | "REJECT") {
    const note = (notes[row.id] ?? "").trim();
    if (decision === "REJECT" && !note) {
      setMessage({ tone: "danger", text: "Write a reason for the shop owner before rejecting." });
      return;
    }
    setBusy(row.id);
    setMessage(null);
    const response = await fetch("/api/admin/fee-pay-later", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: row.id, decision, note: note || null }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(null);
    if (!response?.ok) {
      setMessage({ tone: "danger", text: payload?.error?.message ?? "Could not save the decision. Please try again." });
      return;
    }
    const who = row.shopName ?? row.owner;
    setMessage(
      decision === "REJECT"
        ? { tone: "info", text: `Rejected: ${who} has been told to pay the fee.` }
        : payload?.live
          ? { tone: "success", text: `Approved: ${who} is live. The fee will be taken from its payouts.` }
          : { tone: "info", text: `Approved. ${who} is not live yet — waiting for ${payload?.waitingFor ?? "its other checks"}.` },
    );
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="fee-pay-later-table">
          <thead>
            <tr className="border-b border-ink-200 text-left text-ink-500">
              <th className="px-2 py-2">Shop / owner</th>
              <th className="px-2 py-2">Fee</th>
              <th className="px-2 py-2">Recovered</th>
              <th className="px-2 py-2">Still owed</th>
              <th className="px-2 py-2">Asked (IST)</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-ink-100 align-top">
                <td className="px-2 py-2">
                  <div className="font-medium text-ink-900">
                    {r.shopId ? (
                      <a className="underline" href={`/admin/shops/${r.shopId}`}>
                        {r.shopName}
                      </a>
                    ) : (
                      <span>Registration in progress</span>
                    )}
                    {r.registrationNumber ? <span className="ml-1 text-ink-500">({r.registrationNumber})</span> : null}
                  </div>
                  <div className="text-ink-600">{r.owner}</div>
                  <div className="text-xs text-ink-500">{r.ownerContact}</div>
                  {r.shopStatus ? <div className="text-xs text-ink-500">Shop: {r.shopStatus.toLowerCase().replace("_", " ")}</div> : null}
                  {r.ownerNote ? <div className="mt-1 text-xs italic text-ink-600">“{r.ownerNote}”</div> : null}
                </td>
                <td className="px-2 py-2">{r.amount}</td>
                <td className="px-2 py-2">{r.recovered}</td>
                <td className="px-2 py-2">{r.due ?? "—"}</td>
                <td className="px-2 py-2 whitespace-nowrap">{r.requestedAt}</td>
                <td className="px-2 py-2">
                  <Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>
                  {r.decidedAt ? <div className="mt-1 text-xs text-ink-500">{r.decidedAt}</div> : null}
                  {r.decisionNote ? <div className="mt-1 text-xs text-ink-600">{r.decisionNote}</div> : null}
                </td>
                <td className="px-2 py-2">
                  {r.status === "REQUESTED" ? (
                    <div className="flex min-w-48 flex-col gap-2">
                      <input
                        className="rounded-md border border-ink-300 px-2 py-1 text-sm"
                        placeholder="Note to the owner (needed to reject)"
                        maxLength={500}
                        value={notes[r.id] ?? ""}
                        onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                        aria-label="Note to the owner"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={busy !== null} onClick={() => void decide(r, "APPROVE")} data-testid="fee-pay-later-approve">
                          {busy === r.id ? "Saving…" : "Approve"}
                        </Button>
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void decide(r, "REJECT")} data-testid="fee-pay-later-reject">
                          Reject
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
