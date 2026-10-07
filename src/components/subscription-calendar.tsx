"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";

import { DailyQuantityControl } from "@/components/daily-quantity-control";
import { Badge, Card, Money } from "@/components/ui";
import { formatShortDate } from "@/lib/dates";
import { MILLI_PER_UNIT } from "@/lib/money";

export interface CalendarDayView {
  date: string;
  delivers: boolean;
  quantityMilli: number;
  reason: string;
  isOverridden: boolean;
  estimatedCostPaise: number;
  generatedStatus: string | null;
}

/**
 * Upcoming delivery calendar (§36).
 * Selecting a date opens the same quantity control used for tomorrow, so there
 * is exactly one way to change a day's quantity.
 */
export function SubscriptionCalendar({
  subscriptionId,
  days,
  unit,
  standingQuantityMilli,
  unitPricePaise,
}: {
  subscriptionId: string;
  days: CalendarDayView[];
  unit: string;
  standingQuantityMilli: number;
  unitPricePaise: number | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);

  const selectedDay = days.find((d) => d.date === selected) ?? null;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink-900">
          Delivery calendar
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          Tap any date to change that day&apos;s quantity or skip it.
        </p>

        <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {days.map((day) => {
            const locked =
              day.generatedStatus !== null &&
              day.generatedStatus !== "WALLET_INSUFFICIENT";

            return (
              <li key={day.date}>
                <button
                  type="button"
                  onClick={() =>
                    setSelected((current) =>
                      current === day.date ? null : day.date,
                    )
                  }
                  className={clsx(
                    "w-full rounded-lg border p-2.5 text-left transition-colors",
                    selected === day.date
                      ? "border-kesari-500 bg-kesari-50"
                      : day.delivers
                        ? "border-cream-200 bg-white hover:bg-cream-50"
                        : "border-cream-200 bg-cream-100",
                  )}
                >
                  <span className="block text-xs font-medium text-ink-500">
                    {formatShortDate(day.date)}
                  </span>

                  {day.delivers ? (
                    <span className="mt-0.5 block text-sm font-semibold text-ink-900">
                      {day.quantityMilli / MILLI_PER_UNIT} {unit}
                    </span>
                  ) : (
                    <span className="mt-0.5 block text-sm font-medium text-ink-400">
                      {day.reason === "SKIPPED"
                        ? "Skipped"
                        : day.reason === "PAUSED"
                          ? "Paused"
                          : "—"}
                    </span>
                  )}

                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    {day.isOverridden && day.delivers ? (
                      <Badge tone="info">changed</Badge>
                    ) : null}
                    {day.generatedStatus === "WALLET_INSUFFICIENT" ? (
                      <Badge tone="danger">unpaid</Badge>
                    ) : locked ? (
                      <Badge tone="success">done</Badge>
                    ) : null}
                  </span>

                  {day.estimatedCostPaise > 0 ? (
                    <span className="mt-1 block text-xs text-ink-500">
                      <Money paise={day.estimatedCostPaise} />
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {selectedDay ? (
        <div>
          {selectedDay.generatedStatus === "WALLET_INSUFFICIENT" ? (
            <RetryCard
              subscriptionId={subscriptionId}
              date={selectedDay.date}
              onDone={() => router.refresh()}
            />
          ) : (
            <DailyQuantityControl
              subscriptionId={subscriptionId}
              date={selectedDay.date}
              dateLabel={formatShortDate(selectedDay.date)}
              standingQuantityMilli={standingQuantityMilli}
              currentQuantityMilli={
                selectedDay.quantityMilli || standingQuantityMilli
              }
              unit={unit}
              unitPricePaise={unitPricePaise}
              isSkipped={selectedDay.reason === "SKIPPED"}
              isOverridden={selectedDay.isOverridden}
              locked={
                selectedDay.generatedStatus !== null &&
                selectedDay.generatedStatus !== "WALLET_INSUFFICIENT"
              }
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Retry a day that failed for insufficient balance (§39). */
function RetryCard({
  subscriptionId,
  date,
  onDone,
}: {
  subscriptionId: string;
  date: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    const response = await fetch(
      `/api/subscriptions/${subscriptionId}/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      },
    );
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setError(payload?.error?.message ?? "Retry failed.");
      return;
    }
    if (payload?.outcome === "WALLET_INSUFFICIENT") {
      setError("Your wallet balance is still insufficient. Please top up first.");
      return;
    }
    onDone();
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink-900">
        Payment failed for {formatShortDate(date)}
      </h2>
      <p className="mt-1 text-sm text-ink-600">
        This delivery could not be processed because your wallet balance was
        insufficient. Top up your wallet, then retry.
      </p>
      {error ? (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={retry}
          disabled={busy}
          className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800 disabled:bg-kesari-300"
        >
          {busy ? "Retrying…" : "Retry payment"}
        </button>
        <a
          href="/wallet"
          className="rounded-lg border border-cream-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100"
        >
          Add money
        </a>
      </div>
    </Card>
  );
}
