"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Money } from "@/components/ui";

export interface PendingApprovalRow {
  id: string;
  productName: string;
  productCode: string;
  unit: string;
  priceType: "ONLINE" | "OFFLINE";
  previousPricePaise: number | null;
  proposedPricePaise: number;
  source: "SHOP_OWNER" | "OPERATOR" | "ADMIN";
  shopName?: string;
  createdAt: string;
}

/**
 * "Pending Updates from Operator" (§2.4).
 *
 * The owner's veto. Rows are selectable so a decision can be made per item or
 * over the whole queue; rejecting leaves the live price untouched (§25.9),
 * which the copy states explicitly so the consequence is never ambiguous.
 */
export function PendingPriceApprovals({
  rows,
  showShop = false,
  canOverride = false,
}: {
  rows: PendingApprovalRow[];
  /** Set on the admin queue, where rows span multiple shops. */
  showShop?: boolean;
  canOverride?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No price updates awaiting your approval"
        description="When an operator proposes a price change, it appears here before it goes live."
      />
    );
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function decide(
    decision: "APPROVED" | "REJECTED",
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) {
      setError("Select at least one update first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/price-requests/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestIds: ids,
          decision,
          rejectionReason: decision === "REJECTED" ? reason || null : null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "That did not work.");
      }
      setNotice(
        decision === "APPROVED"
          ? `${payload.approved} price update(s) are now live.`
          : `${payload.rejected} update(s) rejected. Live prices are unchanged.`,
      );
      setSelected(new Set());
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger" title="Could not save">{error}</Alert> : null}
      {notice ? <Alert tone="success" title="Done">{notice}</Alert> : null}

      <Card className="divide-y divide-cream-200">
        {rows.map((row) => {
          const delta =
            row.previousPricePaise == null
              ? null
              : row.proposedPricePaise - row.previousPricePaise;

          return (
            <div key={row.id} className="flex flex-wrap items-center gap-3 p-4">
              <input
                type="checkbox"
                checked={selected.has(row.id)}
                onChange={() => toggle(row.id)}
                aria-label={`Select ${row.productName}`}
                className="h-4 w-4 shrink-0 accent-kesari-600"
              />

              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink-900">
                  {row.productName}{" "}
                  <span className="text-xs text-ink-500">
                    ({row.productCode} · {row.unit})
                  </span>
                </p>
                <p className="text-xs text-ink-500">
                  {showShop && row.shopName ? `${row.shopName} · ` : ""}
                  Proposed by {row.source === "OPERATOR" ? "Operator" : row.source === "ADMIN" ? "Admin" : "Shop owner"}
                  {" · "}
                  {new Date(row.createdAt).toLocaleDateString("en-IN")}
                </p>
              </div>

              <div className="flex items-center gap-2 text-sm">
                <Badge>{row.priceType === "ONLINE" ? "Online" : "Offline"}</Badge>
                {row.previousPricePaise != null ? (
                  <span className="text-ink-500 line-through">
                    <Money paise={row.previousPricePaise} />
                  </span>
                ) : (
                  <span className="text-xs text-ink-500">not priced</span>
                )}
                <span aria-hidden>→</span>
                <span className="font-semibold text-ink-900">
                  <Money paise={row.proposedPricePaise} />
                </span>
                {delta != null && delta !== 0 ? (
                  <span
                    className={
                      delta > 0 ? "text-xs text-kesari-600" : "text-xs text-green-700"
                    }
                  >
                    {delta > 0 ? "+" : ""}
                    <Money paise={delta} />
                  </span>
                ) : null}
              </div>

              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => decide("APPROVED", [row.id])}
                >
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => decide("REJECTED", [row.id])}
                >
                  Reject
                </Button>
              </div>
            </div>
          );
        })}
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => decide("APPROVED", rows.map((r) => r.id))}
        >
          Approve all ({rows.length})
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => decide("APPROVED", Array.from(selected))}
        >
          Approve selected ({selected.size})
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => decide("REJECTED", Array.from(selected))}
        >
          Reject selected
        </Button>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejection (optional)"
          className="min-w-0 flex-1 rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm placeholder:text-ink-600 focus:border-kesari-500 focus:outline-none"
        />
      </div>

      <p className="text-xs text-ink-500">
        Rejecting an update leaves the current live price exactly as it is.
        {canOverride
          ? " As an administrator you may also force an update live from the admin console."
          : ""}
      </p>
    </div>
  );
}
