"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SubscribeAddress } from "@/components/subscribe-form";
import { Alert, Button, Card, Money, inputClass } from "@/components/ui";
import { MILLI_PER_UNIT, lineTotalPaise } from "@/lib/money";
import {
  MONTH_DAY_MAX,
  WEEKDAY_SHORT,
  deliveriesIn30Days,
  scheduleLabel,
  type SubscriptionFrequency,
} from "@/lib/periodicals";
import { defaultPlanSchedule, fitScheduleToPlan, serviceDaysLabel, termEndDate } from "@/lib/subscription-plans";
import { subscriptionQuantityMax, subscriptionQuantityStep } from "@/lib/subscription-quantity";
import type { PublicPlan } from "@/server/services/subscription-plans";

const FREQUENCY_LABELS: Record<SubscriptionFrequency, string> = {
  DAILY: "Every delivery day",
  WEEKLY: "Days of the week",
  MONTHLY: "Days of the month",
};

/**
 * Taking a shop's plan (docs/subscription-plans-2026-11): only what the plan
 * allows is offered — its serving days, frequencies and terms — with the
 * plan's price and a 30-day estimate. The server checks all of it again.
 */
export function PlanSubscribeForm({
  plan,
  addresses,
  walletBalancePaise,
  earliestStart,
}: {
  plan: PublicPlan;
  addresses: SubscribeAddress[];
  walletBalancePaise: number;
  earliestStart: string;
}) {
  const router = useRouter();
  const STEP = subscriptionQuantityStep(plan.unit, plan.unitSizeMilli);
  const MAX = subscriptionQuantityMax(plan.unit, plan.unitSizeMilli);
  const initial = defaultPlanSchedule(plan);
  const [quantityMilli, setQuantityMilli] = useState(STEP);
  const [frequency, setFrequency] = useState<SubscriptionFrequency>(
    plan.allowedFrequencies.includes("DAILY") ? "DAILY" : initial.frequency,
  );
  const [weekdays, setWeekdays] = useState<number[]>(initial.weekdays.length ? initial.weekdays : plan.serviceDays);
  const [monthDays, setMonthDays] = useState<number[]>(initial.monthDays.length ? initial.monthDays : [1]);
  const [termDays, setTermDays] = useState<number | null>(plan.termDays[0] ?? null);
  const [startDate, setStartDate] = useState(earliestStart);
  const [endDate, setEndDate] = useState("");
  const [addressId, setAddressId] = useState(() => addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fitted = fitScheduleToPlan({ frequency, weekdays, monthDays }, plan);
  const problem = "problem" in fitted ? fitted.problem : null;
  const schedule = "schedule" in fitted ? fitted.schedule : null;
  const perDelivery = lineTotalPaise(plan.pricePaise, quantityMilli);
  const thirtyDay = schedule ? perDelivery * deliveriesIn30Days(schedule) : 0;
  const units = quantityMilli / MILLI_PER_UNIT;
  const unitWord = plan.isPeriodical ? (units === 1 ? "copy" : "copies") : plan.unit;
  const finalEnd = termDays ? termEndDate(startDate, termDays) : endDate || null;

  function toggle(list: number[], day: number) {
    return list.includes(day) ? list.filter((d) => d !== day) : [...list, day].sort((a, b) => a - b);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/subscription-plans/${plan.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantityMilli,
        frequency,
        weekdays: frequency === "WEEKLY" ? weekdays : [],
        monthDays: frequency === "MONTHLY" ? monthDays : [],
        startDate,
        termDays,
        endDate: termDays ? null : endDate || null,
        addressId,
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not subscribe to this plan.");
      return;
    }
    router.push(`/subscriptions/${payload.id}`);
    router.refresh();
  }

  const chip = (on: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${on ? "border-kesari-500 bg-kesari-50 text-kesari-700" : "border-cream-200 bg-white text-ink-600"}`;

  return (
    <Card className="space-y-5 p-5">
      <div>
        <span className="mb-2 block text-sm font-medium text-ink-700">How many per delivery?</span>
        <div className="flex items-center gap-3">
          <Button variant="secondary" disabled={quantityMilli <= STEP} onClick={() => setQuantityMilli((q) => Math.max(STEP, q - STEP))} aria-label="Fewer">
            −
          </Button>
          <span className="min-w-16 text-center text-2xl font-bold tabular-nums" data-testid="plan-quantity">
            {units} <span className="text-sm font-normal text-ink-500">{unitWord}</span>
          </span>
          <Button variant="secondary" disabled={quantityMilli >= MAX} onClick={() => setQuantityMilli((q) => Math.min(MAX, q + STEP))} aria-label="More">
            +
          </Button>
        </div>
      </div>

      <div>
        <span className="mb-2 block text-sm font-medium text-ink-700">How often?</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label="How often">
          {plan.allowedFrequencies.map((f) => (
            <button key={f} type="button" className={chip(frequency === f)} aria-pressed={frequency === f} onClick={() => setFrequency(f)}>
              {FREQUENCY_LABELS[f]}
            </button>
          ))}
        </div>
        {frequency === "DAILY" ? (
          <p className="mt-2 text-xs text-ink-600">The shop delivers this plan {serviceDaysLabel(plan.serviceDays).toLowerCase() === "every day" ? "every day" : `on ${serviceDaysLabel(plan.serviceDays)}`}.</p>
        ) : null}
        {frequency === "WEEKLY" ? (
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Delivery days of the week">
            {WEEKDAY_SHORT.map((label, i) => {
              const day = i + 1;
              const serving = plan.serviceDays.includes(day);
              return (
                <button
                  key={label}
                  type="button"
                  disabled={!serving}
                  aria-pressed={weekdays.includes(day)}
                  className={`${chip(weekdays.includes(day))} disabled:cursor-not-allowed disabled:opacity-40`}
                  onClick={() => setWeekdays((w) => toggle(w, day))}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
        {frequency === "MONTHLY" ? (
          <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label="Delivery days of the month">
            {Array.from({ length: MONTH_DAY_MAX }, (_, i) => i + 1).map((day) => (
              <button
                key={day}
                type="button"
                aria-pressed={monthDays.includes(day)}
                className={`min-h-9 min-w-9 rounded-md border text-xs font-medium ${monthDays.includes(day) ? "border-kesari-500 bg-kesari-50 text-kesari-700" : "border-cream-200 bg-white text-ink-600"}`}
                onClick={() => setMonthDays((m) => toggle(m, day))}
              >
                {day}
              </button>
            ))}
          </div>
        ) : null}
        <p className="mt-2 text-sm text-ink-700" data-testid="plan-schedule">
          {problem ?? `Delivered: ${scheduleLabel(schedule!)}.`}
        </p>
      </div>

      {plan.termDays.length > 0 ? (
        <div>
          <span className="mb-2 block text-sm font-medium text-ink-700">Plan length</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Plan length">
            {plan.termDays.map((d) => (
              <button key={d} type="button" className={chip(termDays === d)} aria-pressed={termDays === d} onClick={() => setTermDays(d)}>
                {d} days
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Start date</span>
          <input type="date" value={startDate} min={earliestStart} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
        </label>
        {plan.termDays.length === 0 ? (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">
              End date <span className="font-normal text-ink-500">(optional)</span>
            </span>
            <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
          </label>
        ) : (
          <p className="self-end text-sm text-ink-600">Last delivery day: {finalEnd}</p>
        )}
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Deliver to</span>
        {addresses.length > 0 ? (
          <select value={addressId} onChange={(e) => setAddressId(e.target.value)} className={inputClass} data-testid="plan-address">
            {addresses.map((a) => (
              <option key={a.id} value={a.id}>
                {[a.label, a.line1, a.area, a.city, a.pincode].filter(Boolean).join(", ")}
                {a.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="block text-sm text-ink-600">
            You have no saved address yet.{" "}
            <a href="/profile/addresses" className="font-medium text-kesari-700 underline">
              Add a delivery address
            </a>
            .
          </span>
        )}
      </label>

      <div className="rounded-lg bg-cream-50 p-4 text-sm">
        <div className="flex justify-between">
          <span className="text-ink-600">Per delivery</span>
          <span className="font-medium">
            <Money paise={perDelivery} />
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-600">Estimated for 30 days</span>
          <span className="font-semibold" data-testid="plan-thirty-day">
            <Money paise={thirtyDay} />
          </span>
        </div>
        <p className="mt-2 text-xs text-ink-500">Paid from your GoKesari wallet on each delivery day. Pause, skip or cancel any time from My Subscriptions.</p>
      </div>

      {walletBalancePaise < thirtyDay ? (
        <Alert tone="warning">
          Your wallet balance (<Money paise={walletBalancePaise} />) is below the 30-day estimate. You can still subscribe — top up before the first delivery.
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Button className="w-full" size="lg" disabled={busy || Boolean(problem) || !addressId} onClick={submit}>
        {busy ? "Subscribing…" : `Subscribe to ${plan.name}`}
      </Button>
    </Card>
  );
}
