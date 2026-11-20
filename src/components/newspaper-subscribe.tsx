"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type { SubscribeAddress } from "@/components/subscribe-form";
import { Alert, Badge, Button, Card, Money, inputClass } from "@/components/ui";
import {
  MONTH_DAY_MAX,
  PUBLICATION_LABELS,
  WEEKDAY_SHORT,
  deliveriesIn30Days,
  scheduleLabel,
  scheduleProblem,
  type SubscriptionFrequency,
  type SubscriptionSchedule,
} from "@/lib/periodicals";
import type { NewspaperVendor, PeriodicalTitleView } from "@/server/services/newspaper-subscriptions";

type KindFilter = "ALL" | "NEWSPAPER" | "MAGAZINE";

interface ItemPlan extends SubscriptionSchedule {
  copies: number;
}

const MAX_COPIES = 10;

/** "Delivered every day." / "Delivered every Sun." / "Delivered on the 1st and 15th of the month." */
function deliveredWhen(plan: SubscriptionSchedule): string {
  const label = scheduleLabel(plan);
  if (plan.frequency === "DAILY") return "Delivered every day.";
  if (plan.frequency === "WEEKLY") return label === "Every day" ? "Delivered every day." : `Delivered every ${label}.`;
  return `Delivered on the ${label}.`;
}

/**
 * The newspaper subscription flow (docs/newspaper-subscriptions-2026-11):
 *   1. tick one or more titles,
 *   2. choose the delivery address and find the vendors near it,
 *   3. pick a vendor, check copies and schedule per title, submit once.
 *
 * Prices and the estimate are shown for convenience; the server re-checks
 * every title, the vendor's delivery area and the price on each delivery day.
 */
export function NewspaperSubscribe({
  titles,
  addresses,
  walletBalancePaise,
  defaultStartDate,
  minDate,
}: {
  titles: PeriodicalTitleView[];
  addresses: SubscribeAddress[];
  walletBalancePaise: number;
  defaultStartDate: string;
  minDate: string;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<KindFilter>("ALL");
  const [language, setLanguage] = useState("ALL");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [addressId, setAddressId] = useState(() => addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id ?? "");
  const [vendors, setVendors] = useState<NewspaperVendor[] | null>(null);
  const [vendorId, setVendorId] = useState<string>("");
  const [plans, setPlans] = useState<Record<string, ItemPlan>>({});
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleOf = useMemo(() => new Map(titles.map((t) => [t.productId, t])), [titles]);
  const languages = useMemo(() => [...new Set(titles.map((t) => t.language))].sort(), [titles]);
  const visible = titles.filter(
    (t) =>
      (kind === "ALL" || t.kind === kind) &&
      (language === "ALL" || t.language === language) &&
      (!query.trim() || `${t.name} ${t.publisher ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const vendor = vendors?.find((v) => v.shopId === vendorId) ?? null;

  function resetVendors() {
    setVendors(null);
    setVendorId("");
  }

  function toggleTitle(productId: string) {
    setSelected((current) => (current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId]));
    resetVendors();
  }

  async function findVendors() {
    setBusy(true);
    setError(null);
    const params = new URLSearchParams({ addressId, productIds: selected.join(",") });
    const response = await fetch(`/api/subscriptions/newspapers/vendors?${params.toString()}`);
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not look for vendors.");
      return;
    }
    const found = payload as NewspaperVendor[];
    setVendors(found);
    if (found.length > 0) chooseVendor(found[0]);
  }

  function chooseVendor(v: NewspaperVendor) {
    setVendorId(v.shopId);
    setPlans((current) => {
      const next: Record<string, ItemPlan> = {};
      for (const offer of v.offers) {
        const title = titleOf.get(offer.productId);
        next[offer.productId] = current[offer.productId] ?? {
          copies: 1,
          ...(title?.defaultSchedule ?? { frequency: "DAILY", weekdays: [], monthDays: [] }),
        };
      }
      return next;
    });
  }

  function updatePlan(productId: string, patch: Partial<ItemPlan>) {
    setPlans((current) => ({ ...current, [productId]: { ...current[productId], ...patch } }));
  }

  const lines = vendor
    ? vendor.offers.map((offer) => {
        const plan = plans[offer.productId] ?? { copies: 1, frequency: "DAILY" as const, weekdays: [], monthDays: [] };
        const monthly = offer.pricePaise * plan.copies * deliveriesIn30Days(plan);
        return { offer, plan, monthly, problem: scheduleProblem(plan) };
      })
    : [];
  const monthlyTotal = lines.reduce((sum, l) => sum + l.monthly, 0);
  const anyProblem = lines.find((l) => l.problem)?.problem ?? null;

  async function submit() {
    if (!vendor) return;
    setBusy(true);
    setError(null);
    const response = await fetch("/api/subscriptions/newspapers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shopId: vendor.shopId,
        addressId,
        startDate,
        endDate: endDate || null,
        items: lines.map(({ offer, plan }) => ({
          shopProductId: offer.shopProductId,
          copies: plan.copies,
          frequency: plan.frequency,
          weekdays: plan.frequency === "WEEKLY" ? plan.weekdays : [],
          monthDays: plan.frequency === "MONTHLY" ? plan.monthDays : [],
        })),
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not create the subscriptions.");
      return;
    }
    router.push("/subscriptions?added=newspapers");
    router.refresh();
  }

  const chip = (on: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${on ? "border-kesari-500 bg-kesari-50 text-kesari-700" : "border-cream-200 bg-white text-ink-600"}`;

  return (
    <div className="space-y-6">
      {/* 1. Titles */}
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink-900">1. Choose newspapers and magazines</h2>
          <span className="text-sm text-ink-600" data-testid="newspaper-selected-count">
            {selected.length} selected
          </span>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Type">
          {(["ALL", "NEWSPAPER", "MAGAZINE"] as const).map((k) => (
            <button key={k} type="button" className={chip(kind === k)} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "ALL" ? "All" : k === "NEWSPAPER" ? "Newspapers" : "Magazines"}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">Language</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputClass}>
              <option value="ALL">All languages</option>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">Search</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or publisher"
              className={inputClass}
            />
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="text-sm text-ink-600">No titles match. Clear the filters to see every title.</p>
        ) : (
          <ul className="grid max-h-[28rem] gap-2 overflow-y-auto sm:grid-cols-2" aria-label="Titles">
            {visible.map((t) => {
              const on = selected.includes(t.productId);
              return (
                <li key={t.productId}>
                  <label
                    className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 ${on ? "border-kesari-500 bg-kesari-50" : "border-cream-200 bg-white"}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 accent-kesari-600"
                      checked={on}
                      aria-label={t.name}
                      onChange={() => toggleTitle(t.productId)}
                    />
                    <span>
                      <span className="block font-medium text-ink-900">{t.name}</span>
                      <span className="block text-xs text-ink-600">
                        {t.language} · {PUBLICATION_LABELS[t.publication]} {t.kind === "MAGAZINE" ? "magazine" : "newspaper"}
                        {t.publisher ? ` · ${t.publisher}` : ""}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* 2. Address and vendors */}
      <Card className="space-y-4 p-5">
        <h2 className="text-lg font-semibold text-ink-900">2. Deliver to, and choose a vendor near you</h2>
        {addresses.length > 0 ? (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">Delivery address</span>
            <select
              value={addressId}
              onChange={(e) => {
                setAddressId(e.target.value);
                resetVendors();
              }}
              className={inputClass}
              data-testid="newspaper-address"
            >
              {addresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {[a.label, a.line1, a.area, a.city, a.pincode].filter(Boolean).join(", ")}
                  {a.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Alert tone="warning">
            You have no saved address yet.{" "}
            <a href="/profile/addresses" className="font-medium underline">
              Add a delivery address
            </a>{" "}
            so we can find vendors who deliver to you.
          </Alert>
        )}

        <Button disabled={busy || selected.length === 0 || !addressId} onClick={findVendors}>
          {busy && !vendors ? "Looking…" : `Find vendors for ${selected.length || "the"} title${selected.length === 1 ? "" : "s"}`}
        </Button>

        {vendors && vendors.length === 0 ? (
          <Alert tone="info" title="No vendor delivers these titles to this address yet">
            Try fewer titles, another address, or check again later — new vendors join GoKesari every week.
          </Alert>
        ) : null}

        {vendors && vendors.length > 0 ? (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium text-ink-700">Vendors who deliver to this address</legend>
            {vendors.map((v) => (
              <label
                key={v.shopId}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${vendorId === v.shopId ? "border-kesari-500 bg-kesari-50" : "border-cream-200 bg-white"}`}
              >
                <input
                  type="radio"
                  name="vendor"
                  className="mt-1 h-4 w-4 accent-kesari-600"
                  aria-label={v.name}
                  checked={vendorId === v.shopId}
                  onChange={() => chooseVendor(v)}
                />
                <span className="flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink-900">{v.name}</span>
                    <Badge tone={v.missingProductIds.length === 0 ? "success" : "neutral"}>
                      {v.offers.length} of {v.offers.length + v.missingProductIds.length} titles
                    </Badge>
                    {v.societyPartner ? <Badge tone="info">Your society&apos;s vendor</Badge> : null}
                    {v.distanceKm != null ? <span className="text-xs text-ink-600">{v.distanceKm} km away</span> : null}
                  </span>
                  <span className="mt-1 block text-xs text-ink-600">
                    {v.offers.map((o, i) => (
                      <span key={o.productId}>
                        {i > 0 ? " · " : ""}
                        {o.name} <Money paise={o.pricePaise} />
                      </span>
                    ))}
                  </span>
                  {v.missingProductIds.length > 0 ? (
                    <span className="mt-1 block text-xs text-ink-500">
                      Not sold here: {v.missingProductIds.map((id) => titleOf.get(id)?.name ?? "a title").join(", ")}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </Card>

      {/* 3. Copies, schedule, dates, submit */}
      {vendor ? (
        <Card className="space-y-5 p-5">
          <h2 className="text-lg font-semibold text-ink-900">3. Copies and delivery days — {vendor.name}</h2>

          {lines.map(({ offer, plan, monthly, problem }) => (
            <div key={offer.productId} className="space-y-3 rounded-lg border border-cream-200 p-4" data-testid="newspaper-line">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium text-ink-900">{offer.name}</p>
                <p className="text-sm text-ink-600">
                  <Money paise={offer.pricePaise} /> a copy · about <Money paise={monthly} /> a month
                </p>
              </div>

              <div className="flex items-center gap-3">
                <span className="text-sm text-ink-700">Copies</span>
                <Button
                  variant="secondary"
                  disabled={plan.copies <= 1}
                  onClick={() => updatePlan(offer.productId, { copies: plan.copies - 1 })}
                  aria-label={`Fewer copies of ${offer.name}`}
                >
                  −
                </Button>
                <span className="min-w-6 text-center font-semibold tabular-nums">{plan.copies}</span>
                <Button
                  variant="secondary"
                  disabled={plan.copies >= MAX_COPIES}
                  onClick={() => updatePlan(offer.productId, { copies: plan.copies + 1 })}
                  aria-label={`More copies of ${offer.name}`}
                >
                  +
                </Button>
              </div>

              <div className="flex flex-wrap gap-2" role="group" aria-label={`How often for ${offer.name}`}>
                {(["DAILY", "WEEKLY", "MONTHLY"] as SubscriptionFrequency[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={chip(plan.frequency === f)}
                    aria-pressed={plan.frequency === f}
                    onClick={() =>
                      updatePlan(offer.productId, {
                        frequency: f,
                        weekdays: f === "WEEKLY" && plan.weekdays.length === 0 ? [7] : plan.weekdays,
                        monthDays: f === "MONTHLY" && plan.monthDays.length === 0 ? [1] : plan.monthDays,
                      })
                    }
                  >
                    {f === "DAILY" ? "Every day" : f === "WEEKLY" ? "Days of the week" : "Days of the month"}
                  </button>
                ))}
              </div>

              {plan.frequency === "WEEKLY" ? (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Weekdays for ${offer.name}`}>
                  {WEEKDAY_SHORT.map((label, index) => {
                    const day = index + 1;
                    const on = plan.weekdays.includes(day);
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={on}
                        className={chip(on)}
                        onClick={() =>
                          updatePlan(offer.productId, {
                            weekdays: on ? plan.weekdays.filter((d) => d !== day) : [...plan.weekdays, day].sort((a, b) => a - b),
                          })
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {plan.frequency === "MONTHLY" ? (
                <div className="flex flex-wrap gap-1" role="group" aria-label={`Days of the month for ${offer.name}`}>
                  {Array.from({ length: MONTH_DAY_MAX }, (_, i) => i + 1).map((day) => {
                    const on = plan.monthDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        className={`min-h-9 min-w-9 rounded-md border text-xs font-medium ${on ? "border-kesari-500 bg-kesari-50 text-kesari-700" : "border-cream-200 bg-white text-ink-600"}`}
                        onClick={() =>
                          updatePlan(offer.productId, {
                            monthDays: on ? plan.monthDays.filter((d) => d !== day) : [...plan.monthDays, day].sort((a, b) => a - b),
                          })
                        }
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              <p className="text-xs text-ink-600">
                {problem ?? deliveredWhen(plan)}
              </p>
            </div>
          ))}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-700">Start date</span>
              <input type="date" value={startDate} min={minDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-700">
                End date <span className="font-normal text-ink-500">(optional)</span>
              </span>
              <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
            </label>
          </div>

          <div className="rounded-lg bg-cream-50 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-600">Estimated cost for 30 days</span>
              <span className="font-semibold" data-testid="newspaper-monthly-total">
                <Money paise={monthlyTotal} />
              </span>
            </div>
            <p className="mt-2 text-xs text-ink-500">
              Each copy is paid from your GoKesari wallet on its delivery day, at the vendor&apos;s price that day. Pause,
              skip or cancel any title from My Subscriptions.
            </p>
          </div>

          {walletBalancePaise < monthlyTotal ? (
            <Alert tone="warning">
              Your wallet balance (<Money paise={walletBalancePaise} />) is below the estimated 30-day cost. You can still
              subscribe — top up before the first delivery.
            </Alert>
          ) : null}

          <Button className="w-full" size="lg" disabled={busy || lines.length === 0 || Boolean(anyProblem)} onClick={submit}>
            {busy ? "Subscribing…" : `Subscribe to ${lines.length} title${lines.length === 1 ? "" : "s"} from ${vendor.name}`}
          </Button>
        </Card>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
