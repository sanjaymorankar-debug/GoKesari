"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, Money, inputClass } from "@/components/ui";
import {
  RETURN_CONDITION_LABELS,
  RETURN_REASON_LABELS,
  RETURN_STATUS_LABELS,
  type ReturnCondition,
  type ReturnReason,
  type ReturnStatus,
} from "@/lib/return-states";
import { formatQuantity } from "@/lib/money";
import type { ReturnDetail } from "@/server/services/returns";

const TONE: Partial<Record<ReturnStatus, "success" | "danger" | "warning" | "info" | "neutral">> = {
  REJECTED: "danger",
  RETURN_CANCELLED: "neutral",
  REFUND_COMPLETED: "success",
  APPROVED: "info",
  UNDER_REVIEW: "warning",
};

/**
 * One return: status, items with photos, timeline, and the actions the
 * workflow allows this viewer right now (`detail.actions` comes from the
 * server — the UI never decides on its own what is permitted).
 */
export function ReturnCase({ detail }: { detail: ReturnDetail }) {
  const router = useRouter();
  const { ret } = detail;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [refund, setRefund] = useState("");
  const [when, setWhen] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/returns/${ret.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ?? "That did not work.");
      return;
    }
    setOpen(null);
    setNote("");
    router.refresh();
  }

  const can = (action: string) => detail.actions.includes(action);
  const status = ret.status as ReturnStatus;

  return (
    <Card className="space-y-4 p-5" data-testid="return-case">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={TONE[status] ?? "info"}>{RETURN_STATUS_LABELS[status]}</Badge>
          <span className="text-sm font-medium text-ink-900">{ret.returnNumber}</span>
          <span className="text-sm text-ink-500">
            order {detail.orderNumber} · {detail.shopName}
          </span>
        </div>
        <span className="font-semibold text-ink-900">
          <Money paise={ret.refundedPaise ?? ret.refundAmountPaise} />
        </span>
      </div>

      <p className="text-sm text-ink-600">
        Reason: {RETURN_REASON_LABELS[ret.reason as ReturnReason]}
        {ret.comment ? ` — “${ret.comment}”` : ""}
        {detail.customerName ? ` · customer ${detail.customerName}` : ""}
      </p>

      <ul className="divide-y divide-cream-100 text-sm">
        {detail.items.map((item) => (
          <li key={item.id} className="py-2">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="text-ink-800">
                {item.productName} · {formatQuantity(item.quantityMilli, item.unit)}{" "}
                <span className="text-ink-500">({RETURN_CONDITION_LABELS[item.condition as ReturnCondition]})</span>
              </span>
              <Money paise={item.refundPaise} />
            </div>
            {item.comment ? <p className="text-xs text-ink-500">“{item.comment}”</p> : null}
            {item.imageIds.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-2">
                {item.imageIds.map((id) => (
                  <a key={id} href={`/api/images/${id}`} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/images/${id}`} alt="Evidence" className="h-14 w-14 rounded-lg border border-cream-200 object-cover" />
                  </a>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {ret.decisionNote ? <Alert tone={status === "REJECTED" ? "danger" : "info"}>{ret.decisionNote}</Alert> : null}
      {ret.inspectionNote ? <p className="text-sm text-ink-600">Inspection: {ret.inspectionNote}</p> : null}

      {detail.pickup && ["PENDING", "OFFERED", "ACCEPTED", "EN_ROUTE"].includes(detail.pickup.status) ? (
        <div className="rounded-lg bg-cream-100 px-3 py-2 text-sm text-ink-700" data-testid="return-pickup">
          <p>
            Pickup:{" "}
            {detail.pickup.status === "PENDING" || detail.pickup.status === "OFFERED"
              ? "finding a rider"
              : detail.pickup.status === "ACCEPTED"
                ? "rider assigned"
                : "rider on the way"}
            {detail.pickup.scheduledFor
              ? ` · ready from ${new Date(detail.pickup.scheduledFor).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`
              : ""}
          </p>
          {detail.pickup.handoverCode ? (
            <p className="mt-1" data-testid="handover-code">
              Handover code:{" "}
              <span className="font-mono text-lg font-bold tracking-widest">{detail.pickup.handoverCode}</span> — give it to the
              rider only when they collect the goods.
            </p>
          ) : null}
        </div>
      ) : null}

      <ol className="space-y-1 border-l-2 border-cream-200 pl-3 text-xs text-ink-500" aria-label="Timeline">
        {detail.history.map((h) => (
          <li key={h.id}>
            <span className="font-medium text-ink-700">{RETURN_STATUS_LABELS[h.toStatus as ReturnStatus]}</span>{" "}
            {new Date(h.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
            {h.note ? ` — ${h.note}` : ""}
          </li>
        ))}
      </ol>

      {detail.actions.length > 0 ? (
        <div className="space-y-3 border-t border-cream-100 pt-3">
          <div className="flex flex-wrap gap-2">
            {can("approve") ? (
              <Button size="sm" disabled={busy} onClick={() => act({ action: "approve" })}>
                Approve return
              </Button>
            ) : null}
            {can("reject") ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(open === "reject" ? null : "reject")}>
                Reject
              </Button>
            ) : null}
            {can("receive") ? (
              <Button size="sm" disabled={busy} onClick={() => act({ action: "receive" })}>
                {status === "APPROVED" ? "Customer handed goods over" : "Goods received"}
              </Button>
            ) : null}
            {can("inspect") ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(open === "inspect" ? null : "inspect")}>
                Inspect goods
              </Button>
            ) : null}
            {can("issue_refund") ? (
              <Button size="sm" disabled={busy} onClick={() => act({ action: "issue_refund" })}>
                {status === "REFUND_INITIATED" ? "Retry refund" : "Issue refund"}
              </Button>
            ) : null}
            {can("retry_pickup") ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act({ action: "retry_pickup" })}>
                Find a rider again
              </Button>
            ) : null}
            {can("complete_pickup") ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(open === "complete_pickup" ? null : "complete_pickup")}>
                Complete pickup manually
              </Button>
            ) : null}
            {can("schedule") ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(open === "schedule" ? null : "schedule")}>
                Choose pickup time
              </Button>
            ) : null}
            {can("cancel") ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "cancel" })}>
                Cancel return
              </Button>
            ) : null}
          </div>

          {open === "reject" || open === "complete_pickup" ? (
            <div className="flex flex-wrap gap-2">
              <input
                className={`${inputClass} min-w-0 flex-1`}
                placeholder={open === "reject" ? "Reason shown to the customer" : "How was the pickup confirmed?"}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button
                size="sm"
                variant="danger"
                disabled={busy || note.trim().length < 3}
                onClick={() => act({ action: open, note })}
              >
                Confirm
              </Button>
            </div>
          ) : null}

          {open === "inspect" ? (
            <div className="space-y-2">
              <Field label="What did you find?">
                <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <Field label={`Refund ₹ (leave blank for the full ₹${(ret.refundAmountPaise / 100).toFixed(2)})`}>
                <input className={inputClass} inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || note.trim().length < 3}
                  onClick={() =>
                    act({
                      action: "inspect",
                      outcome: "ACCEPT",
                      note,
                      ...(refund ? { refundPaise: Math.round(Number(refund) * 100) } : {}),
                    })
                  }
                >
                  Accept — refund the customer
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || note.trim().length < 3}
                  onClick={() => act({ action: "inspect", outcome: "REJECT", note })}
                >
                  Reject — no refund
                </Button>
              </div>
            </div>
          ) : null}

          {open === "schedule" ? (
            <div className="flex flex-wrap gap-2">
              <input className={inputClass} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              <Button
                size="sm"
                disabled={busy || !when}
                onClick={() => act({ action: "schedule", scheduledFor: new Date(when).toISOString() })}
              >
                Save time
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}
