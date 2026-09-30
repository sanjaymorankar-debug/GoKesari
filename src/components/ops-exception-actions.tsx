"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { RefundDeliveredForm } from "@/components/finance-actions";
import { Alert, Button, Field, inputClass } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import type { OpsExceptionCategory } from "@/server/services/ops-exceptions";

export interface OpsExceptionActionOrder {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  category: OpsExceptionCategory;
  deliveryStatus: string | null;
  isCod: boolean;
  isPaid: boolean;
  totalPaise: number;
  shopHasLocation: boolean;
  /** The signed-in operator placed this order, so the status route treats a cancel as a customer self-cancel. */
  isOwnOrder: boolean;
}

type Panel = "cancel" | "reassign" | "confirm" | "returned" | "close" | "refund" | "delivered";

const CANCELLABLE_STATUSES = new Set([
  "CONFIRMED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "FAILED",
  "RETURNED",
]);
const PRE_PICKUP_STATUSES = new Set(["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED"]);
const LIVE_DELIVERY_STATUSES = new Set(["OFFERED", "ACCEPTED", "PICKED_UP"]);
const HAND_OVER_CATEGORIES: ReadonlySet<OpsExceptionCategory> = new Set<OpsExceptionCategory>([
  "SELF_DELIVERY_OVERDUE",
  "STUCK_AFTER_PICKUP",
  "LATE",
]);

const CANCEL_REASON = { min: 5, max: 300 };
const REASSIGN_REASON = { min: 3, max: 500 };
const PROOF_NOTE = { min: 5, max: 500 };
const STATUS_NOTE = { min: 5, max: 300 };

function LengthHint({ value, min, max }: { value: string; min: number; max: number }) {
  const length = value.trim().length;
  return (
    <span className={length > 0 && length < min ? "text-red-600" : undefined}>
      {length < min ? `At least ${min} characters` : `${length}/${max}`}
    </span>
  );
}

export function OpsExceptionActions({
  order,
  canUpdateStatus,
  canManageDelivery,
  canRefund,
}: {
  order: OpsExceptionActionOrder;
  canUpdateStatus: boolean;
  canManageDelivery: boolean;
  canRefund: boolean;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [note, setNote] = useState("");
  const [cashCollected, setCashCollected] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const category = order.category;
  const riderHasGoods = order.deliveryStatus === "PICKED_UP";
  const hasLiveDelivery = order.deliveryStatus != null && LIVE_DELIVERY_STATUSES.has(order.deliveryStatus);
  const refundDue = order.isPaid && order.totalPaise > 0;
  const amount = formatPaise(order.totalPaise);

  const showAccept = canUpdateStatus && category === "SHOP_NOT_ACCEPTING" && order.orderStatus === "CONFIRMED";
  const findRiderApplies = category === "NO_RIDER" && order.orderStatus === "READY" && !hasLiveDelivery;
  const showFindRider = canManageDelivery && order.shopHasLocation && findRiderApplies;
  const reassignLabel =
    category === "NO_RIDER" && order.deliveryStatus === "OFFERED" && order.orderStatus === "READY"
      ? "Re-send offer"
      : category === "RIDER_NOT_PICKED_UP" && order.deliveryStatus === "ACCEPTED" && order.orderStatus === "ASSIGNED"
        ? "Reassign rider"
        : null;
  const showReassign = canManageDelivery && order.shopHasLocation && reassignLabel != null;
  const showLocationNote =
    canManageDelivery && !order.shopHasLocation && (findRiderApplies || reassignLabel != null);
  const showConfirm =
    canManageDelivery &&
    (category === "STUCK_AFTER_PICKUP" || category === "OTP_LOCKED") &&
    riderHasGoods &&
    (order.orderStatus === "PICKED_UP" || order.orderStatus === "OUT_FOR_DELIVERY");
  const showReturned = canUpdateStatus && category === "FAILED_DELIVERY" && order.orderStatus === "FAILED";
  const showClose = canUpdateStatus && category === "DISPUTED" && order.orderStatus === "DISPUTED";
  const showRefund = canRefund && category === "DISPUTED" && order.orderStatus === "DISPUTED" && order.totalPaise > 0;
  const showDelivered =
    canUpdateStatus &&
    HAND_OVER_CATEGORIES.has(category) &&
    (order.orderStatus === "READY" || order.orderStatus === "OUT_FOR_DELIVERY") &&
    !hasLiveDelivery;
  const cancelApplies =
    canUpdateStatus &&
    category !== "DISPUTED" &&
    CANCELLABLE_STATUSES.has(order.orderStatus) &&
    (category !== "LATE" || PRE_PICKUP_STATUSES.has(order.orderStatus));
  const showCancel = cancelApplies && !order.isOwnOrder;
  const showOwnOrderNote = cancelApplies && order.isOwnOrder;

  const hasButtons =
    showAccept ||
    showFindRider ||
    showReassign ||
    showConfirm ||
    showReturned ||
    showClose ||
    showRefund ||
    showDelivered ||
    showCancel;
  if (!hasButtons && !showLocationNote && !showOwnOrderNote) return null;

  // An open panel is shown only while its button still applies to the row's current state.
  const panelAllowed: Record<Panel, boolean> = {
    cancel: showCancel,
    reassign: showReassign,
    confirm: showConfirm,
    returned: showReturned,
    close: showClose,
    refund: showRefund,
    delivered: showDelivered,
  };
  const activePanel = panel !== null && panelAllowed[panel] ? panel : null;

  function reset() {
    setPanel(null);
    setNote("");
    setCashCollected(false);
    setConfirming(false);
  }

  function open(next: Panel) {
    setPanel(activePanel === next ? null : next);
    setNote("");
    setCashCollected(false);
    setConfirming(false);
    setError(null);
  }

  function close() {
    reset();
    setError(null);
  }

  // refreshOnError: a rider assignment change is not atomic, so a failed call can still have altered the order.
  async function send(url: string, method: "POST" | "PATCH", body: unknown, refreshOnError = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error?.message ?? "That did not work. Refresh the page and try again.";
        setError(refreshOnError ? `${message} The order may have changed, so the list has been refreshed.` : message);
        if (refreshOnError) router.refresh();
        return;
      }
      reset();
      router.refresh();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
      if (refreshOnError) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/orders/${order.orderId}`;
  const trimmed = note.trim();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {showAccept ? (
          <Button size="sm" disabled={busy} onClick={() => send(`${base}/fulfilment`, "POST", { action: "accept" })}>
            {busy && activePanel === null ? "Accepting…" : "Accept for shop"}
          </Button>
        ) : null}
        {showFindRider ? (
          <Button size="sm" disabled={busy} onClick={() => send(`${base}/assign`, "POST", {}, true)}>
            {busy && activePanel === null ? "Finding a rider…" : "Find rider"}
          </Button>
        ) : null}
        {showReassign ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => open("reassign")}>
            {reassignLabel}
          </Button>
        ) : null}
        {showConfirm ? (
          <Button size="sm" disabled={busy} onClick={() => open("confirm")}>
            Confirm delivered
          </Button>
        ) : null}
        {showReturned ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => open("returned")}>
            Mark returned
          </Button>
        ) : null}
        {showClose ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => open("close")}>
            Close — no refund
          </Button>
        ) : null}
        {showRefund ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => open("refund")}>
            Refund
          </Button>
        ) : null}
        {showDelivered ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => open("delivered")}>
            Mark delivered
          </Button>
        ) : null}
        {showCancel ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => open("cancel")}>
            {refundDue ? "Cancel & refund" : "Cancel order"}
          </Button>
        ) : null}
      </div>

      {showLocationNote ? (
        <p className="text-xs text-ink-500">
          Riders cannot be matched until the shop has a location on file. Add the shop&apos;s location first.
        </p>
      ) : null}
      {showOwnOrderNote ? (
        <p className="text-xs text-ink-500">
          You placed this order, so cancelling it from here would count as a customer cancel and is refused or limited
          once the shop has started on it. Ask another operator to cancel it.
        </p>
      ) : null}

      {activePanel === "reassign" ? (
        <div className="space-y-2 rounded-lg border border-cream-200 bg-cream-50 p-3">
          <p className="text-xs text-ink-600">
            {order.deliveryStatus === "OFFERED"
              ? "Cancels the current offer first, then runs rider matching again. If no rider is free the offer stays cancelled and the dispatch sweep retries about every minute."
              : "Takes the order off the current rider first, so they can no longer collect it, then runs rider matching again. If no other rider is free the order goes back to Ready with no rider and the dispatch sweep retries about every minute."}{" "}
            The current rider is not excluded and can be matched again if they are still the nearest free rider.
          </p>
          <Field label="Reason (recorded on the delivery and in the audit log)">
            <input
              className={inputClass}
              maxLength={REASSIGN_REASON.max}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <p className="text-xs text-ink-500">
            <LengthHint value={note} {...REASSIGN_REASON} />
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || trimmed.length < REASSIGN_REASON.min}
              onClick={() => send(`${base}/assign`, "POST", { reassign: true, reason: trimmed }, true)}
            >
              {busy ? "Working…" : reassignLabel}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {activePanel === "confirm" ? (
        <div className="space-y-2 rounded-lg border border-cream-200 bg-cream-50 p-3">
          <Field label="How was the hand-over confirmed?">
            <textarea
              className={inputClass}
              rows={2}
              maxLength={PROOF_NOTE.max}
              placeholder="For example: spoke to the customer, who confirmed they received the order"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <p className="text-xs text-ink-500">
            <LengthHint value={note} {...PROOF_NOTE} />
          </p>
          {order.isCod ? (
            <label className="flex items-start gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={cashCollected}
                onChange={(e) => setCashCollected(e.target.checked)}
              />
              <span>I have confirmed the rider collected {amount} in cash.</span>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || trimmed.length < PROOF_NOTE.min || (order.isCod && !cashCollected)}
              onClick={() =>
                send(`${base}/confirm-delivery`, "POST", {
                  proofNote: trimmed,
                  ...(order.isCod ? { cashCollected: true } : {}),
                })
              }
            >
              {busy ? "Confirming…" : "Mark delivered"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {activePanel === "returned" ? (
        <div className="space-y-2 rounded-lg border border-cream-200 bg-cream-50 p-3">
          <p className="text-xs text-ink-600">Only do this once the shop confirms it has the goods back.</p>
          <Field label="Note (optional)">
            <input
              className={inputClass}
              maxLength={STATUS_NOTE.max}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                send(`${base}/status`, "PATCH", { status: "RETURNED", ...(trimmed ? { note: trimmed } : {}) })
              }
            >
              {busy ? "Saving…" : "Goods are back at the shop"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {activePanel === "close" ? (
        <div className="space-y-2 rounded-lg border border-cream-200 bg-cream-50 p-3">
          <p className="text-xs text-ink-600">
            Marks the order delivered again with no money returned. The shop is then paid for it as normal.
          </p>
          <Field label="Why no refund is due">
            <textarea
              className={inputClass}
              rows={2}
              maxLength={STATUS_NOTE.max}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <p className="text-xs text-ink-500">
            <LengthHint value={note} {...STATUS_NOTE} />
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || trimmed.length < STATUS_NOTE.min}
              onClick={() => send(`${base}/status`, "PATCH", { status: "DELIVERED", note: trimmed })}
            >
              {busy ? "Closing…" : "Close dispute"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {activePanel === "refund" ? (
        <div className="space-y-2 rounded-lg border border-cream-200 bg-cream-50 p-3">
          <p className="text-xs text-ink-600">
            Up to {amount} can be refunded to the customer&apos;s wallet. A full refund closes the dispute; a partial
            refund leaves it open.
          </p>
          <RefundDeliveredForm initialOrderNumber={order.orderNumber} lockOrderNumber />
          <Button size="sm" variant="ghost" onClick={close}>
            Back
          </Button>
        </div>
      ) : null}

      {activePanel === "delivered" ? (
        <div className="space-y-2 rounded-lg border border-cream-200 bg-cream-50 p-3">
          <p className="text-xs text-ink-600">
            Marks the order delivered in the app. No rider is working on it, so only do this once the shop or the
            customer confirms the hand-over.
            {order.isCod ? ` This records the ${amount} cash payment as collected by the shop.` : ""}
          </p>
          <Field label="How was the hand-over confirmed?">
            <textarea
              className={inputClass}
              rows={2}
              maxLength={STATUS_NOTE.max}
              placeholder="For example: the shop confirmed the customer collected it"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <p className="text-xs text-ink-500">
            <LengthHint value={note} {...STATUS_NOTE} />
          </p>
          {order.isCod ? (
            <label className="flex items-start gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={cashCollected}
                onChange={(e) => setCashCollected(e.target.checked)}
              />
              <span>I have confirmed {amount} in cash was collected.</span>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || trimmed.length < STATUS_NOTE.min || (order.isCod && !cashCollected)}
              onClick={() => send(`${base}/status`, "PATCH", { status: "DELIVERED", note: trimmed })}
            >
              {busy ? "Saving…" : "Yes, mark delivered"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {activePanel === "cancel" ? (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
          {!confirming ? (
            <>
              <Field label="Reason for cancelling (sent to the customer)">
                <textarea
                  className={inputClass}
                  rows={2}
                  maxLength={CANCEL_REASON.max}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
              <p className="text-xs text-ink-500">
                <LengthHint value={note} {...CANCEL_REASON} />
              </p>
              {riderHasGoods ? (
                <Alert tone="warning">The rider already has the goods and is still paid for this trip.</Alert>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || trimmed.length < CANCEL_REASON.min}
                  onClick={() => setConfirming(true)}
                >
                  Continue
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
                  Back
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-red-900">
                Order #{order.orderNumber} will be cancelled and its stock put back.
                {hasLiveDelivery ? " The open rider assignment is cancelled too." : ""}
                {refundDue
                  ? ` ${amount} goes back to the customer's wallet.`
                  : order.isPaid
                    ? " Nothing is left to refund on it."
                    : " Nothing was charged, so no refund is issued."}
                {riderHasGoods ? " The rider is still paid for the trip." : ""} This cannot be undone.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => send(`${base}/status`, "PATCH", { status: "CANCELLED", note: trimmed })}
                >
                  {busy ? "Cancelling…" : refundDue ? `Yes, cancel and refund ${amount}` : "Yes, cancel the order"}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                  Change reason
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
