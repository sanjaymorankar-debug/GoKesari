"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, Money, inputClass } from "@/components/ui";

interface Preview {
  shopName: string;
  orders: { orderId: string; orderNumber: string; status: string; totalPaise: number; plannedAction: string }[];
  counts: { cancelRefund: number; continue: number; review: number; leftAlone: number };
  refundPaise: number;
  subscriptionsActive: number;
}

const ACTION_LABEL: Record<string, string> = {
  CANCEL_REFUND: "Cancel & refund",
  CONTINUE: "Shop finishes it",
  REVIEW: "Hold for operations",
  LEFT_ALONE: "Left as is",
};

/** Suspend (with a look at the impact first) or reinstate a shop. */
export function ShopSuspensionControls({ shopId, shopName, status }: { shopId: string; shopName: string; status: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const [expected, setExpected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function begin() {
    setOpen(true);
    setError(null);
    setPreview(null);
    const res = await fetch(`/api/shops/${shopId}/suspend`);
    const payload = await res.json().catch(() => null);
    if (!res.ok) setError(payload?.error?.message ?? "Could not load the impact.");
    else setPreview(payload);
  }

  async function submit(url: string, body: Record<string, unknown>, message: (p: Record<string, unknown>) => string) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ?? "That did not work.");
      return;
    }
    setDone(message(payload));
    router.refresh();
  }

  if (done) return <span className="text-xs text-leaf-700">{done}</span>;

  if (status === "SUSPENDED") {
    return (
      <div className="space-y-2">
        {open ? (
          <div className="flex flex-wrap gap-2">
            <input className={`${inputClass} w-56`} placeholder="Why is it being reinstated?" value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button size="sm" disabled={busy || reason.trim().length < 3} onClick={() => submit(`/api/shops/${shopId}/reactivate`, { note: reason }, () => "Reinstated.")}>
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Reinstate
          </Button>
        )}
        {error ? <p className="text-xs text-red-700">{error}</p> : null}
      </div>
    );
  }
  if (status !== "APPROVED") return null;

  return (
    <div className="space-y-2">
      {!open ? (
        <Button size="sm" variant="danger" onClick={begin}>
          Suspend…
        </Button>
      ) : (
        <div className="w-[26rem] max-w-full space-y-3 rounded-lg border border-cream-200 bg-white p-3 text-left" data-testid="suspend-panel">
          <p className="text-sm font-semibold text-ink-900">Suspend {shopName}</p>
          {preview ? (
            <div className="text-xs text-ink-600" data-testid="suspend-impact">
              <p className="font-medium text-ink-800">Impact on open orders</p>
              <ul className="mt-1 list-disc pl-4">
                <li>{preview.counts.cancelRefund} cancelled and refunded (<Money paise={preview.refundPaise} />)</li>
                <li>{preview.counts.continue} will be completed by the shop</li>
                <li>{preview.counts.review} held for an operations decision</li>
                {preview.counts.leftAlone ? <li>{preview.counts.leftAlone} left as they are</li> : null}
                <li>{preview.subscriptionsActive} active subscription{preview.subscriptionsActive === 1 ? "" : "s"} with this shop (unaffected — subscribers are told daily it is unavailable)</li>
              </ul>
              {preview.orders.length > 0 ? (
                <ul className="mt-2 max-h-28 overflow-auto rounded bg-cream-50 p-2">
                  {preview.orders.map((o) => (
                    <li key={o.orderId}>
                      {o.orderNumber} · {o.status.replace(/_/g, " ").toLowerCase()} · {ACTION_LABEL[o.plannedAction]}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : !error ? (
            <p className="text-xs text-ink-500">Checking open orders…</p>
          ) : null}
          <Field label="Reason (shown to the owner)">
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="What the owner must do (optional)">
            <input className={inputClass} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="Defaults to the standard instruction" />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={busy || !preview || reason.trim().length < 3}
              onClick={() =>
                submit(`/api/shops/${shopId}/suspend`, { reason, expectedAction: expected || null }, (p) => {
                  const i = p.impact as { cancelled: number; continuing: number; awaitingReview: number; failed: number };
                  return `Suspended — ${i.cancelled} cancelled, ${i.continuing} continuing, ${i.awaitingReview} under review${i.failed ? `, ${i.failed} need attention` : ""}.`;
                })
              }
            >
              {busy ? "Suspending…" : "Suspend shop"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
