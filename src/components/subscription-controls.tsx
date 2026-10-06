"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";
import { MILLI_PER_UNIT } from "@/lib/money";

/** Permanent subscription changes: quantity, pause window, cancel (§31, §32). */
export function SubscriptionControls({
  subscriptionId,
  status,
  standingQuantityMilli,
  unit,
  pauseFrom,
  pauseUntil,
  endDate = null,
  renewalReason = null,
  renewalDueDate = null,
}: {
  subscriptionId: string;
  status: string;
  standingQuantityMilli: number;
  unit: string;
  pauseFrom: string | null;
  pauseUntil: string | null;
  /** SM-004 */
  endDate?: string | null;
  renewalReason?: "TERM_END" | "PAYMENT_DUE" | null;
  renewalDueDate?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(
    String(standingQuantityMilli / MILLI_PER_UNIT),
  );
  const [from, setFrom] = useState(pauseFrom ?? "");
  const [until, setUntil] = useState(pauseUntil ?? "");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [renewUntil, setRenewUntil] = useState("");

  const isPaused = Boolean(pauseFrom && pauseUntil);
  const cancelled = status === "CANCELLED";

  async function call(
    path: string,
    body: unknown,
    method: "POST" | "PATCH" | "DELETE" = "POST",
    successMessage = "Saved.",
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);

    const url = path
      ? `/api/subscriptions/${subscriptionId}/${path}`
      : `/api/subscriptions/${subscriptionId}`;

    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save the change.");
      return;
    }
    setNotice(successMessage);
    router.refresh();
  }

  if (cancelled) {
    return (
      <Card className="p-5">
        <Alert tone="info">This subscription has been cancelled.</Alert>
      </Card>
    );
  }
  if (status === "COMPLETED") {
    return (
      <Card className="p-5">
        <Alert tone="info">This subscription ended{endDate ? ` on ${endDate}` : ""}. No further deliveries.</Alert>
      </Card>
    );
  }
  const isDraft = status === "DRAFT";

  return (
    <Card className="space-y-5 p-5">
      {isDraft ? (
        <div data-testid="subscription-draft">
          <h2 className="text-base font-semibold text-ink-900">Draft — not started</h2>
          <p className="mt-1 text-sm text-ink-500">
            Nothing is delivered or charged until you activate it. Deliveries start on the start date (today if that has passed).
          </p>
          <Button className="mt-3" disabled={busy} onClick={() => call("activate", {}, "POST", "Subscription activated.")}>
            Activate subscription
          </Button>
        </div>
      ) : null}

      {status === "RENEWAL_PENDING" ? (
        <div data-testid="subscription-renewal" className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <h2 className="text-base font-semibold text-ink-900">Renewal due</h2>
          {renewalReason === "PAYMENT_DUE" ? (
            <>
              <p className="mt-1 text-sm text-ink-700">
                Your wallet does not cover the delivery{renewalDueDate ? ` on ${renewalDueDate}` : ""}. Add money to keep
                deliveries coming — renewal clears as soon as the balance covers it.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href="/wallet" className="rounded-lg bg-kesari-600 px-3 py-2 text-sm font-medium text-white hover:bg-kesari-700">
                  Add money
                </Link>
                <Button variant="secondary" disabled={busy} onClick={() => call("renew", {}, "POST", "Renewed.")}>
                  I&apos;ve topped up — renew
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-ink-700">
                Deliveries stop after {renewalDueDate ?? endDate}. Renew to keep them coming.
              </p>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="text-xs text-ink-500">
                  New end date
                  <input
                    type="date"
                    value={renewUntil}
                    min={endDate ?? undefined}
                    onChange={(e) => setRenewUntil(e.target.value)}
                    className={inputClass}
                  />
                </label>
                <Button
                  disabled={busy}
                  onClick={() => call("renew", renewUntil ? { endDate: renewUntil } : {}, "POST", "Renewed.")}
                >
                  {renewUntil ? "Renew until this date" : "Renew for another term"}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => call("renew", { endDate: null }, "POST", "Renewed with no end date.")}>
                  Keep going, no end date
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      <div>
        <h2 className="text-base font-semibold text-ink-900">
          Change permanently
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          Applies to every future delivery, not just one day.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-label={`Standing quantity in ${unit}`}
            className={inputClass}
          />
          <Button
            disabled={busy}
            onClick={() =>
              call(
                "",
                {
                  quantityMilli: Math.round(Number(quantity) * MILLI_PER_UNIT),
                },
                "PATCH",
                "Standing quantity updated.",
              )
            }
          >
            Update
          </Button>
        </div>
      </div>

      {isDraft ? null : (
      <div className="border-t border-cream-200 pt-4">
        <h2 className="text-base font-semibold text-ink-900">
          {isPaused ? "Paused" : "Pause deliveries"}
        </h2>
        {isPaused ? (
          <>
            <p className="mt-1 text-sm text-ink-600">
              No deliveries or deductions from {pauseFrom} to {pauseUntil}.
            </p>
            <Button
              variant="secondary"
              className="mt-3"
              disabled={busy}
              onClick={() => call("resume", {}, "POST", "Deliveries resumed.")}
            >
              Resume now
            </Button>
          </>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-xs text-ink-500">
                From
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="text-xs text-ink-500">
                Until
                <input
                  type="date"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                  className={inputClass}
                />
              </label>
            </div>
            <Button
              variant="secondary"
              className="mt-3"
              disabled={busy || !from || !until}
              onClick={() =>
                call("pause", { from, until }, "POST", "Subscription paused.")
              }
            >
              Pause
            </Button>
          </>
        )}
      </div>
      )}

      {/* Two-step confirmation rather than window.confirm: a native dialog
          blocks the event loop and is awkward to drive in automated tests. */}
      <div className="border-t border-cream-200 pt-4">
        {confirmingCancel ? (
          <div className="space-y-2">
            <p className="text-sm text-ink-700">
              {isDraft ? "Discard this draft?" : "Cancel this subscription? Future deliveries will stop."}
            </p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  call(
                    "",
                    { reason: "Cancelled by customer" },
                    "DELETE",
                    "Cancelled.",
                  )
                }
              >
                {isDraft ? "Yes, discard it" : "Yes, cancel it"}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirmingCancel(false)}
              >
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => setConfirmingCancel(true)}
          >
            {isDraft ? "Discard draft" : "Cancel subscription"}
          </Button>
        )}
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
    </Card>
  );
}
