"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button } from "@/components/ui";

export interface EscalationTableRow {
  id: string;
  kind: "SHOP_REVIEW" | "FEE_PAY_LATER" | "NO_PRODUCTS_OR_SALES";
  kindLabel: string;
  level: "FRANCHISEE" | "OPERATOR" | "ADMIN";
  levelLabel: string;
  shopId: string | null;
  shopName: string | null;
  registrationNumber: string | null;
  shopStatus: string | null;
  owner: string;
  ownerContact: string;
  franchisee: string | null;
  reason: string | null;
  openedAt: string;
  nextStepAt: string | null;
  resolution: string | null;
  resolutionNote: string | null;
  /** Hand-overs, oldest first, already formatted. */
  history: string[];
  /** Approve / reject (held shop, pay later) or close (no-sales task) allowed for the viewer. */
  canDecide: boolean;
  canClose: boolean;
}

export interface ReviewFlagRow {
  id: string;
  shopId: string;
  shopName: string | null;
  registrationNumber: string | null;
  label: string;
  createdAt: string;
}

const LEVEL_TONE: Record<EscalationTableRow["level"], "info" | "warning" | "danger"> = { FRANCHISEE: "info", OPERATOR: "warning", ADMIN: "danger" };

/**
 * 0232 (owner, 28-Nov-2026): support escalations — a held v2 / v3 shop (duplicate GSTIN / PAN of another owner),
 * a pay-later request, a shop not selling 10 days after go-live. Staff (`apiPath` /api/admin/support-escalations)
 * and the franchisee (/api/dealer/support-escalations) act on the same rows.
 */
export function SupportEscalationsTable({ rows, apiPath, shopLinks = true }: { rows: EscalationTableRow[]; apiPath: string; shopLinks?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);

  async function act(row: EscalationTableRow, action: "APPROVE" | "REJECT" | "CLOSE") {
    const note = (notes[row.id] ?? "").trim();
    if ((action === "REJECT" || action === "CLOSE") && !note) {
      setMessage({ tone: "danger", text: action === "REJECT" ? "Write a reason for the shop owner before rejecting." : "Write why this item is closed." });
      return;
    }
    setBusy(row.id);
    setMessage(null);
    const response = await fetch(apiPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ escalationId: row.id, action, note: note || null }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(null);
    if (!response?.ok) {
      setMessage({ tone: "danger", text: payload?.error?.message ?? "Could not save. Please try again." });
      return;
    }
    const who = row.shopName ?? row.owner;
    setMessage({ tone: action === "APPROVE" ? "success" : "info", text: action === "APPROVE" ? `Approved: ${who}.` : action === "REJECT" ? `Rejected: ${who} has been told why.` : `Closed: ${who}.` });
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="support-escalations-table">
          <thead>
            <tr className="border-b border-ink-200 text-left text-ink-500">
              <th className="px-2 py-2">Item</th>
              <th className="px-2 py-2">Shop / owner</th>
              <th className="px-2 py-2">With</th>
              <th className="px-2 py-2">Opened (IST)</th>
              <th className="px-2 py-2">History</th>
              <th className="px-2 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-ink-100 align-top" data-testid="support-escalation-row">
                <td className="px-2 py-2">
                  <div className="font-medium text-ink-900">{r.kindLabel}</div>
                  {r.reason ? <div className="text-xs text-ink-600">{r.reason}</div> : null}
                  {r.resolution ? (
                    <div className="mt-1 text-xs text-ink-700">
                      Closed: {r.resolution.toLowerCase()}
                      {r.resolutionNote ? ` — ${r.resolutionNote}` : ""}
                    </div>
                  ) : null}
                </td>
                <td className="px-2 py-2">
                  <div className="font-medium text-ink-900">
                    {r.shopId && shopLinks ? (
                      <a className="underline" href={`/admin/shops/${r.shopId}`}>
                        {r.shopName}
                      </a>
                    ) : (
                      <span>{r.shopName ?? "Registration in progress"}</span>
                    )}
                    {r.registrationNumber ? <span className="ml-1 text-ink-500">({r.registrationNumber})</span> : null}
                  </div>
                  <div className="text-ink-600">{r.owner}</div>
                  <div className="text-xs text-ink-500">{r.ownerContact}</div>
                  {r.shopStatus ? <div className="text-xs text-ink-500">Shop: {r.shopStatus.toLowerCase().replace("_", " ")}</div> : null}
                </td>
                <td className="px-2 py-2">
                  <Badge tone={LEVEL_TONE[r.level]}>{r.levelLabel}</Badge>
                  {r.franchisee ? <div className="mt-1 text-xs text-ink-600">Franchisee: {r.franchisee}</div> : <div className="mt-1 text-xs text-ink-500">No franchisee</div>}
                  {r.nextStepAt ? <div className="mt-1 text-xs text-ink-500">Moves up {r.nextStepAt}</div> : null}
                </td>
                <td className="px-2 py-2 whitespace-nowrap">{r.openedAt}</td>
                <td className="px-2 py-2 text-xs text-ink-600">
                  <ul className="space-y-1">
                    {r.history.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                </td>
                <td className="px-2 py-2">
                  {r.canDecide || r.canClose ? (
                    <div className="flex min-w-48 flex-col gap-2">
                      <input
                        className="rounded-md border border-ink-300 px-2 py-1 text-sm"
                        placeholder={r.canDecide ? "Note (needed to reject)" : "Why it is closed"}
                        maxLength={500}
                        value={notes[r.id] ?? ""}
                        onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                        aria-label="Note"
                      />
                      <div className="flex gap-2">
                        {r.canDecide ? (
                          <>
                            <Button size="sm" disabled={busy !== null} onClick={() => void act(r, "APPROVE")} data-testid="support-escalation-approve">
                              {busy === r.id ? "Saving…" : "Approve"}
                            </Button>
                            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act(r, "REJECT")} data-testid="support-escalation-reject">
                              Reject
                            </Button>
                          </>
                        ) : null}
                        {r.canClose ? (
                          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act(r, "CLOSE")} data-testid="support-escalation-close">
                            Close
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : r.resolution ? null : (
                    <span className="text-xs text-ink-500">{r.kind === "NO_PRODUCTS_OR_SALES" ? "Contact the owner — closes by itself once products and a first sale exist" : "Waiting for the franchisee"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Review flags after go-live (weak name match, PAN not inside the GSTIN): admin / operator mark them checked. */
export function ReviewFlagsTable({ rows }: { rows: ReviewFlagRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function clear(row: ReviewFlagRow) {
    const note = (notes[row.id] ?? "").trim();
    if (!note) {
      setMessage({ tone: "danger", text: "Write what was checked." });
      return;
    }
    setBusy(row.id);
    const response = await fetch("/api/admin/support-escalations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flagId: row.id, action: "CLEAR_FLAG", note }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(null);
    if (!response?.ok) {
      setMessage({ tone: "danger", text: payload?.error?.message ?? "Could not save. Please try again." });
      return;
    }
    setMessage({ tone: "success", text: `Checked: ${row.shopName ?? "shop"}.` });
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="shop-review-flags-table">
          <thead>
            <tr className="border-b border-ink-200 text-left text-ink-500">
              <th className="px-2 py-2">Shop</th>
              <th className="px-2 py-2">To check</th>
              <th className="px-2 py-2">Raised (IST)</th>
              <th className="px-2 py-2">Checked</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-ink-100 align-top">
                <td className="px-2 py-2">
                  <a className="underline" href={`/admin/shops/${r.shopId}`}>
                    {r.shopName ?? r.shopId}
                  </a>
                  {r.registrationNumber ? <span className="ml-1 text-ink-500">({r.registrationNumber})</span> : null}
                </td>
                <td className="px-2 py-2">{r.label}</td>
                <td className="px-2 py-2 whitespace-nowrap">{r.createdAt}</td>
                <td className="px-2 py-2">
                  <div className="flex min-w-48 gap-2">
                    <input
                      className="rounded-md border border-ink-300 px-2 py-1 text-sm"
                      placeholder="What was checked"
                      maxLength={500}
                      value={notes[r.id] ?? ""}
                      onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                      aria-label="What was checked"
                    />
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void clear(r)}>
                      {busy === r.id ? "Saving…" : "Mark checked"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
