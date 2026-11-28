"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface PromotionItem {
  approvalId: string;
  dealerId: string;
  dealerName: string;
  contactName: string;
  source: string;
  agreementStart: string | null;
  agreementEnd: string | null;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
}

/**
 * Owner, 28-Nov-2026: a shop owner's promotion to dealer an admin approved waits here for a DIFFERENT admin or
 * operator. Confirm issues the dealer code and e-mails it; Reject (with a reason) leaves the application pending.
 * The server checks again who may decide (never the admin who approved it).
 */
export function PromotionConfirmations({ items, viewerId, canDecide, showDealerLink = true }: { items: PromotionItem[]; viewerId: string; canDecide: boolean; showDealerLink?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  if (!items.length) return null;

  async function decide(item: PromotionItem, decision: "APPROVE" | "REJECT") {
    const comment = (comments[item.approvalId] ?? "").trim();
    if (decision === "REJECT" && !comment) return setError("Say why you are not confirming it (sent to the admin who approved it).");
    setBusy(`${item.approvalId}:${decision}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/approvals/${item.approvalId}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, comment: comment || null }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      const data = payload?.data ?? payload;
      if (decision === "APPROVE" && data?.applyError) throw new Error(`Confirmed, but the approval could not be applied: ${data.applyError}`);
      setNotice(decision === "APPROVE" ? `${item.dealerName} is now a dealer: the code is issued and e-mailed.` : `Not confirmed. ${item.dealerName}'s application stays pending.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mb-4 space-y-3 p-4" data-testid="dealer-promotions-pending">
      <h2 className="text-base font-bold text-ink-900">Promotions waiting for a second admin or operator ({items.length})</h2>
      <p className="text-xs text-ink-600">A shop owner becoming a dealer or franchisee is approved by one admin and confirmed by a different admin or operator. Nobody confirms their own approval.</p>
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <ul className="space-y-2">
        {items.map((item) => {
          const own = item.requestedBy === viewerId;
          return (
            <li key={item.approvalId} className="rounded-xl border border-cream-200 p-3 text-sm" data-testid={`dealer-promotion-${item.dealerId}`}>
              <p className="flex flex-wrap items-center gap-2">
                {showDealerLink ? (
                  <Link className="font-semibold text-kesari-800 underline" href={`/admin/dealers/${item.dealerId}`}>
                    {item.dealerName}
                  </Link>
                ) : (
                  <span className="font-semibold text-ink-900">{item.dealerName}</span>
                )}
                <span className="text-ink-600">{item.contactName}</span>
                <Badge tone="info">{item.source === "SHOP_REQUEST" ? "free franchisee request" : "shop owner's application"}</Badge>
                <Badge tone="warning">waiting for confirmation</Badge>
              </p>
              <p className="text-ink-700">
                Approved by {own ? "you" : (item.requestedByName ?? "an admin")} on {new Date(item.requestedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST
                {item.agreementStart ? ` · agreement ${item.agreementStart} to ${item.agreementEnd}` : ""}
              </p>
              {own ? (
                <p className="text-xs text-ink-600">You approved this — a different admin or operator must confirm it.</p>
              ) : canDecide ? (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Button size="sm" disabled={busy !== null} onClick={() => decide(item, "APPROVE")}>
                    Confirm and issue the code
                  </Button>
                  <Field label="Reason if not confirming">
                    <input
                      className={`${inputClass} max-w-xs`}
                      value={comments[item.approvalId] ?? ""}
                      onChange={(e) => setComments((c) => ({ ...c, [item.approvalId]: e.target.value }))}
                      maxLength={1000}
                      aria-label={`Reason for not confirming ${item.dealerName}`}
                    />
                  </Field>
                  <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => decide(item, "REJECT")}>
                    Reject
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-ink-600">An admin or an operator confirms it.</p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
