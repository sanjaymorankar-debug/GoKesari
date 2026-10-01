"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ImageUploader, type UploadedImage } from "@/components/image-uploader";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import {
  RETURN_CONDITIONS,
  RETURN_CONDITION_LABELS,
  RETURN_REASON_LABELS,
  type ReturnCondition,
  type ReturnReason,
} from "@/lib/return-states";
import { formatQuantity } from "@/lib/money";
import type { ReturnableOrder } from "@/server/services/returns";

interface Selection {
  selected: boolean;
  /** Quantity in the line's display unit (e.g. 2 for "2 packs"); converted to milli-units on submit. */
  quantity: string;
  condition: ReturnCondition;
  comment: string;
  images: UploadedImage[];
}

/** Order → choose items and quantities → reason, condition, photos, comments → submit. */
export function ReturnRequestForm({ order }: { order: ReturnableOrder }) {
  const router = useRouter();
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, Selection>>(() =>
    Object.fromEntries(
      order.lines.map((l) => [
        l.orderItemId,
        { selected: false, quantity: String(l.availableMilli / 1000), condition: "UNOPENED" as ReturnCondition, comment: "", images: [] },
      ]),
    ),
  );

  const policy = order.reasons.find((r) => r.reason === reason);
  const chosen = order.lines.filter((l) => selection[l.orderItemId]?.selected);
  const imageCount = new Set(chosen.flatMap((l) => selection[l.orderItemId].images.map((i) => i.id))).size;

  function patch(id: string, change: Partial<Selection>) {
    setSelection((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));
  }

  async function submit() {
    setError(null);
    if (!reason) return setError("Choose a reason for the return.");
    if (chosen.length === 0) return setError("Select at least one item to return.");
    if (policy?.requiresImages && imageCount === 0) return setError("Please add a photo showing the problem.");

    const items = [];
    for (const line of chosen) {
      const sel = selection[line.orderItemId];
      const milli = Math.round(Number(sel.quantity) * 1000);
      if (!Number.isFinite(milli) || milli <= 0 || milli > line.availableMilli) {
        return setError(`Enter a quantity between 0 and ${line.availableMilli / 1000} for ${line.name}.`);
      }
      items.push({
        orderItemId: line.orderItemId,
        quantityMilli: milli,
        condition: sel.condition,
        comment: sel.comment || null,
        imageIds: sel.images.map((i) => i.id),
      });
    }

    setBusy(true);
    const res = await fetch(`/api/orders/${order.orderId}/returns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, comment: comment || null, items }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ?? "Could not submit the return.");
      return;
    }
    router.push(`/returns/${payload.id}`);
    router.refresh();
  }

  if (!order.eligible) {
    return <Alert tone="warning">{order.reason ?? "This order cannot be returned."}</Alert>;
  }

  return (
    <div className="space-y-5" data-testid="return-form">
      {order.windowEndsAt ? (
        <p className="text-sm text-ink-500">
          You can request a return until {new Date(order.windowEndsAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.
        </p>
      ) : null}

      <Card className="divide-y divide-cream-200">
        {order.lines.map((line) => {
          const sel = selection[line.orderItemId];
          const disabled = line.availableMilli === 0;
          return (
            <div key={line.orderItemId} className="space-y-3 p-4">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={disabled}
                  checked={sel.selected}
                  onChange={(e) => patch(line.orderItemId, { selected: e.target.checked })}
                />
                <span className="text-sm">
                  <span className="font-medium text-ink-900">{line.name}</span>{" "}
                  <span className="text-ink-500">
                    · {formatQuantity(line.totalMilli, line.unit)}
                    {disabled ? " — return already in progress" : ""}
                  </span>
                </span>
              </label>
              {sel.selected ? (
                <div className="grid gap-3 pl-7 sm:grid-cols-2">
                  <Field label={`Quantity to return (max ${line.availableMilli / 1000})`}>
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      value={sel.quantity}
                      onChange={(e) => patch(line.orderItemId, { quantity: e.target.value })}
                    />
                  </Field>
                  <Field label="Condition">
                    <select
                      className={inputClass}
                      value={sel.condition}
                      onChange={(e) => patch(line.orderItemId, { condition: e.target.value as ReturnCondition })}
                    >
                      {RETURN_CONDITIONS.map((c) => (
                        <option key={c} value={c}>
                          {RETURN_CONDITION_LABELS[c]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Comment on this item (optional)">
                      <input
                        className={inputClass}
                        value={sel.comment}
                        maxLength={500}
                        onChange={(e) => patch(line.orderItemId, { comment: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="mb-1 text-sm font-medium text-ink-700">Photos of this item</p>
                    <ImageUploader
                      purpose="RETURN_EVIDENCE"
                      value={sel.images}
                      max={order.maxImages}
                      onChange={(images) => patch(line.orderItemId, { images })}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </Card>

      <Field label="Reason for the return">
        <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)}>
          <option value="">Choose a reason…</option>
          {order.reasons.map((r) => (
            <option key={r.reason} value={r.reason}>
              {RETURN_REASON_LABELS[r.reason]}
            </option>
          ))}
        </select>
      </Field>
      {policy?.requiresImages ? (
        <p className="text-xs text-ink-500">For this reason, at least one photo is required.</p>
      ) : null}

      <Field label="Anything else the shop should know? (optional)">
        <textarea className={inputClass} rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>

      <p className="text-xs text-ink-500">
        {order.pickupByRider
          ? "If the return is approved, a rider will collect the goods from your delivery address."
          : "If the return is approved, please take the goods to the shop."}{" "}
        The refund goes to your wallet once the shop has checked the goods.
      </p>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button disabled={busy} onClick={submit}>
        {busy ? "Submitting…" : "Submit return request"}
      </Button>
    </div>
  );
}
