"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Money, inputClass } from "@/components/ui";
import { MILLI_PER_UNIT, lineTotalPaise } from "@/lib/money";

/**
 * Subscription setup with the §35 cost preview.
 *
 * The preview is computed client-side purely for responsiveness; the server
 * recomputes everything on submit and on every daily generation, so a tampered
 * preview cannot affect what the customer is actually charged.
 */
export function SubscribeForm({
  shopProductId,
  productName,
  unit,
  unitSizeMilli,
  unitPricePaise,
  walletBalancePaise,
  defaultStartDate,
  minDate,
}: {
  shopProductId: string;
  productName: string;
  unit: string;
  unitSizeMilli: number;
  unitPricePaise: number;
  walletBalancePaise: number;
  defaultStartDate: string;
  minDate: string;
}) {
  const router = useRouter();
  const [quantityMilli, setQuantityMilli] = useState(unitSizeMilli);
  const [frequency, setFrequency] = useState<"DAILY" | "WEEKLY">("DAILY");
  const [weekdays, setWeekdays] = useState<number[]>([1, 4]);
  const [startDate, setStartDate] = useState(defaultStartDate);
  /** SM-004: optional term; renewal is asked for shortly before it ends. */
  const [endDate, setEndDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const STEP = MILLI_PER_UNIT / 2;
  const perDelivery = lineTotalPaise(unitPricePaise, quantityMilli);
  const deliveriesPerWeek = frequency === "DAILY" ? 7 : weekdays.length;
  const sevenDay = perDelivery * deliveriesPerWeek;
  const thirtyDay = perDelivery * Math.round((deliveriesPerWeek / 7) * 30);
  const insufficient = walletBalancePaise < thirtyDay;

  async function submit(draft = false) {
    setBusy(true);
    setError(null);

    const response = await fetch("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shopProductId,
        quantityMilli,
        frequency,
        weekdays: frequency === "WEEKLY" ? weekdays : [],
        startDate,
        endDate: endDate || null,
        draft,
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not create the subscription.");
      return;
    }
    router.push(`/subscriptions/${payload.id}`);
    router.refresh();
  }

  function toggleWeekday(day: number) {
    setWeekdays((current) =>
      current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day].sort(),
    );
  }

  return (
    <Card className="space-y-5 p-6">
      <div>
        <span className="mb-2 block text-sm font-medium text-ink-700">
          How much per delivery?
        </span>
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            size="lg"
            disabled={quantityMilli <= STEP}
            onClick={() => setQuantityMilli((q) => Math.max(STEP, q - STEP))}
            aria-label={`Decrease by 0.5 ${unit}`}
          >
            −0.5
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
            onClick={() => setQuantityMilli((q) => q + STEP)}
            aria-label={`Increase by 0.5 ${unit}`}
          >
            +0.5
          </Button>
        </div>
      </div>

      <div>
        <span className="mb-2 block text-sm font-medium text-ink-700">
          How often?
        </span>
        <div className="grid grid-cols-2 gap-2">
          {(["DAILY", "WEEKLY"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFrequency(f)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium ${
                frequency === f
                  ? "border-kesari-500 bg-kesari-50 text-kesari-700"
                  : "border-cream-200 bg-white text-ink-600"
              }`}
            >
              {f === "DAILY" ? "Every day" : "Selected weekdays"}
            </button>
          ))}
        </div>

        {frequency === "WEEKLY" ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
              (label, index) => {
                const day = index + 1; // ISO weekday
                const on = weekdays.includes(day);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleWeekday(day)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                      on
                        ? "border-kesari-500 bg-kesari-50 text-kesari-700"
                        : "border-cream-200 bg-white text-ink-600"
                    }`}
                  >
                    {label}
                  </button>
                );
              },
            )}
          </div>
        ) : null}
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          Start date
        </span>
        <input
          type="date"
          value={startDate}
          min={minDate}
          onChange={(e) => setStartDate(e.target.value)}
          className={inputClass}
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          End date <span className="font-normal text-ink-500">(optional)</span>
        </span>
        <input
          type="date"
          value={endDate}
          min={startDate}
          onChange={(e) => setEndDate(e.target.value)}
          className={inputClass}
        />
        <span className="mt-1 block text-xs text-ink-500">
          Leave empty to keep delivering until you cancel. With an end date we remind you to renew a few days before.
        </span>
      </label>

      <div className="rounded-lg bg-cream-50 p-4">
        <p className="text-sm font-medium text-ink-700">Estimated cost</p>
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-500">Per delivery</dt>
            <dd className="font-medium">
              <Money paise={perDelivery} />
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">7 days</dt>
            <dd className="font-medium">
              <Money paise={sevenDay} />
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">30 days</dt>
            <dd className="font-medium">
              <Money paise={thirtyDay} />
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-ink-500">
          Actual deductions may vary if the product price changes.
        </p>
      </div>

      {insufficient ? (
        <Alert tone="warning">
          Your wallet balance (<Money paise={walletBalancePaise} />) is below the
          estimated 30-day cost. You can still subscribe — top up any time before
          a delivery.
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Button
        className="w-full"
        size="lg"
        disabled={busy || (frequency === "WEEKLY" && weekdays.length === 0)}
        onClick={() => submit(false)}
      >
        {busy ? "Creating…" : `Subscribe to ${productName}`}
      </Button>
      <Button
        className="w-full"
        variant="secondary"
        disabled={busy || (frequency === "WEEKLY" && weekdays.length === 0)}
        onClick={() => submit(true)}
      >
        Save as draft — start later
      </Button>
    </Card>
  );
}
