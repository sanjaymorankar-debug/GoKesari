"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Money } from "@/components/ui";
import { MILLI_PER_UNIT, lineTotalPaise } from "@/lib/money";

/**
 * "Tomorrow's Milk" control (requirement §29).
 *
 * The single most-used screen in the product, so it is deliberately blunt:
 * −0.5 / current / +0.5, a manual entry box, Save, and Skip. A non-technical
 * customer changes tomorrow's quantity in one or two taps.
 *
 * Quantities are milli-units end to end, so half-litre steps stay exact and no
 * floating-point rounding can creep into what the customer is charged.
 */
export function DailyQuantityControl({
  subscriptionId,
  date,
  dateLabel,
  standingQuantityMilli,
  currentQuantityMilli,
  unit,
  unitPricePaise,
  isSkipped,
  isOverridden,
  locked,
  stepMilli = MILLI_PER_UNIT / 2,
  maxMilli,
}: {
  subscriptionId: string;
  date: string;
  dateLabel: string;
  standingQuantityMilli: number;
  currentQuantityMilli: number;
  unit: string;
  unitPricePaise: number | null;
  isSkipped: boolean;
  isOverridden: boolean;
  locked: boolean;
  /** TC-FLD-107: the product's step (src/lib/subscription-quantity.ts); 0.5 of a unit by default. */
  stepMilli?: number;
  /** The most one delivery may be; the server refuses more. */
  maxMilli?: number;
}) {
  const router = useRouter();
  const [quantityMilli, setQuantityMilli] = useState(currentQuantityMilli);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const STEP = stepMilli;
  const stepLabel = STEP / MILLI_PER_UNIT;
  const dirty = quantityMilli !== currentQuantityMilli;
  const cost =
    unitPricePaise && quantityMilli > 0
      ? lineTotalPaise(unitPricePaise, quantityMilli)
      : 0;

  function adjust(deltaMilli: number) {
    setSaved(false);
    setQuantityMilli((q) => Math.min(maxMilli ?? Number.MAX_SAFE_INTEGER, Math.max(STEP, q + deltaMilli)));
  }

  function onManualEntry(value: string) {
    setSaved(false);
    const units = Number(value);
    if (!Number.isFinite(units) || units <= 0) return;
    setQuantityMilli(Math.round(units * MILLI_PER_UNIT));
  }

  async function send(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    const response = await fetch(
      `/api/subscriptions/${subscriptionId}/${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save the change.");
      return false;
    }
    setSaved(true);
    router.refresh();
    return true;
  }

  const save = () => send("override", { date, quantityMilli });
  const skip = () => send("skip", { date });

  async function restore() {
    setBusy(true);
    setError(null);
    const response = await fetch(
      `/api/subscriptions/${subscriptionId}/override`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      },
    );
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not restore the standard quantity.");
      return;
    }
    setQuantityMilli(standingQuantityMilli);
    setSaved(true);
    router.refresh();
  }

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-ink-900">{dateLabel}</h2>
        <span className="text-xs text-ink-500">{date}</span>
      </div>

      <p className="mt-1 text-sm text-ink-500">
        Standard subscription: {standingQuantityMilli / MILLI_PER_UNIT} {unit}
      </p>

      {locked ? (
        <div className="mt-4">
          <Alert tone="info">
            This delivery has already been processed and can no longer be
            changed.
          </Alert>
        </div>
      ) : isSkipped ? (
        <div className="mt-4 space-y-3">
          <Alert tone="warning">
            This delivery is skipped. Nothing will be deducted.
          </Alert>
          <Button variant="secondary" disabled={busy} onClick={restore}>
            Undo skip
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-center gap-3">
            <Button
              variant="secondary"
              size="lg"
              disabled={busy || quantityMilli <= STEP}
              onClick={() => adjust(-STEP)}
              aria-label={`Decrease by ${stepLabel} ${unit}`}
            >
              −{stepLabel} {unit}
            </Button>

            <div className="min-w-24 text-center">
              <span className="block text-3xl font-bold tabular-nums text-ink-900">
                {quantityMilli / MILLI_PER_UNIT}
              </span>
              <span className="text-sm text-ink-500">{unit}</span>
            </div>

            <Button
              variant="secondary"
              size="lg"
              disabled={busy || (maxMilli !== undefined && quantityMilli >= maxMilli)}
              onClick={() => adjust(STEP)}
              aria-label={`Increase by ${stepLabel} ${unit}`}
            >
              +{stepLabel} {unit}
            </Button>
          </div>

          <div className="mt-3 flex items-center justify-center gap-2">
            <label htmlFor="manual-qty" className="text-xs text-ink-500">
              Or enter exactly
            </label>
            <input
              id="manual-qty"
              type="number"
              min={stepLabel}
              step={stepLabel}
              max={maxMilli !== undefined ? maxMilli / MILLI_PER_UNIT : undefined}
              defaultValue={quantityMilli / MILLI_PER_UNIT}
              onChange={(e) => onManualEntry(e.target.value)}
              className="w-20 rounded-lg border border-cream-200 px-2 py-1 text-sm tabular-nums focus:border-kesari-500 focus:outline-none"
            />
            <span className="text-xs text-ink-500">{unit}</span>
          </div>

          {cost > 0 ? (
            <p className="mt-3 text-center text-sm text-ink-600">
              This delivery will cost <Money paise={cost} className="font-semibold" />
            </p>
          ) : null}

          {error ? (
            <div className="mt-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}
          {saved && !dirty ? (
            <div className="mt-3">
              <Alert tone="success">Saved.</Alert>
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button disabled={busy || !dirty} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={skip}>
              Skip this day
            </Button>
          </div>

          {isOverridden && !dirty ? (
            <button
              type="button"
              onClick={restore}
              disabled={busy}
              className="mt-2 w-full text-center text-xs text-ink-500 underline hover:text-ink-700"
            >
              Restore standard quantity ({standingQuantityMilli / MILLI_PER_UNIT}{" "}
              {unit})
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}
