"use client";

import { useState } from "react";

import { Alert, Button, Card, Field, Money, inputClass } from "@/components/ui";
import { fmtKm } from "@/lib/rider-pay-plan";

import { istInputToUtcIso, parseKmList } from "./format";
import type { CalculatorResult, PlanRow, ZoneOption } from "./types";
import { useApi } from "./use-api";

const num = (v: string) => {
  const n = Number(v.trim());
  return v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
};

/** Any numbers → the full breakdown exactly as the rider would see it. Nothing is saved. */
export function PayCalculator({ plans, zones }: { plans: PlanRow[]; zones: ZoneOption[] }) {
  const api = useApi();
  const [f, setF] = useState({ planId: "", city: "", zoneId: "", p: "1.5", d: "4", wait: "0", extra: "", at: "" });
  const [result, setResult] = useState<CalculatorResult | null>(null);
  const set = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [key]: e.target.value });

  const extra = parseKmList(f.extra);
  const p = num(f.p);
  const d = num(f.d);
  const wait = num(f.wait);
  const at = f.at ? istInputToUtcIso(f.at) : null;
  const invalid = p == null || d == null || wait == null || extra.bad.length > 0 || (f.at !== "" && !at);

  async function run() {
    if (invalid) return;
    const res = await api.call<CalculatorResult>(
      "/api/admin/rider-pay-plans/calculate",
      "POST",
      {
        planId: f.planId || null,
        city: f.city.trim() || null,
        zoneId: f.zoneId || null,
        firstMileKm: p,
        legKm: d,
        waitMin: wait,
        extraLegsKm: extra.km,
        at,
      },
      { refresh: false },
    );
    setResult(res);
  }

  const q = result?.quote;
  const lines: [string, number, string?][] = q
    ? [
        ["Base fee", q.basePaise],
        [`Distance to the customer (${fmtKm(q.legM)} km)`, q.lastMilePaise],
        [`Ride to the shop (${fmtKm(q.firstMileM)} km)`, q.firstMilePaise],
        ["Extra drops", q.extraDropPaise],
        ["Long-distance bonus", q.longDistancePaise],
        ["Subtotal", q.subtotalPaise, "font-medium"],
        [
          `Surge${q.surgeLabels.length ? ` — ${q.surgeLabels.join(", ")}` : ""} (×${(q.surgeMultiplierBp / 10000).toFixed(2)}${q.surgeFlatPaise ? ` + flat` : ""})`,
          q.surgePaise,
        ],
        ["Minimum top-up", q.minTopUpPaise],
        ["Per-order cap", -q.capCutPaise],
        ["Rounded up to ₹1", q.roundingPaise],
        ["Quote (locked when the rider accepts)", q.quotePaise, "font-semibold"],
      ]
    : [];

  return (
    <section className="space-y-3" aria-labelledby="calculator-heading">
      <h2 id="calculator-heading" className="text-lg font-semibold text-ink-900">
        Pay calculator
      </h2>
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Plan">
            <select className={inputClass} value={f.planId} onChange={set("planId")}>
              <option value="">The plan that would apply</option>
              {plans.map((pl) => (
                <option key={pl.id} value={pl.id}>
                  {pl.label} ({pl.status.toLowerCase()})
                </option>
              ))}
            </select>
          </Field>
          <Field label="City">
            <input className={inputClass} value={f.city} onChange={set("city")} placeholder="Pune" />
          </Field>
          <Field label="Zone (optional)">
            <select className={inputClass} value={f.zoneId} onChange={set("zoneId")}>
              <option value="">No zone</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.city} — {z.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="P: rider → shop (km)">
            <input className={inputClass} value={f.p} onChange={set("p")} inputMode="decimal" />
          </Field>
          <Field label="D: shop → customer (km)">
            <input className={inputClass} value={f.d} onChange={set("d")} inputMode="decimal" />
          </Field>
          <Field label="Wait at the shop (minutes)">
            <input className={inputClass} value={f.wait} onChange={set("wait")} inputMode="numeric" />
          </Field>
          <Field label="Extra drops (km of each leg)" hint="e.g. 1.5, 2">
            <input className={inputClass} value={f.extra} onChange={set("extra")} />
          </Field>
          <Field label="When (IST)" hint="Blank = now (decides peak slot and live surges).">
            <input className={inputClass} type="datetime-local" value={f.at} onChange={set("at")} />
          </Field>
        </div>
        {extra.bad.length ? <p className="text-xs text-red-700">Not a distance: {extra.bad.join(", ")}</p> : null}
        <Button disabled={api.busy || invalid} onClick={run}>
          Calculate
        </Button>
        {api.error ? <Alert tone="danger">{api.error}</Alert> : null}
        {result && q ? (
          <div className="space-y-1 text-sm" data-testid="pay-calculator-result">
            <p className="text-ink-600">
              Plan: <strong>{result.plan.label}</strong> ({result.plan.status.toLowerCase()})
            </p>
            <ul className="divide-y divide-cream-100">
              {lines.map(([label, paise, cls], i) => (
                <li key={i} className={`flex justify-between gap-4 py-0.5 ${cls ?? ""}`}>
                  <span>{label}</span>
                  <span className={paise < 0 ? "text-red-700" : ""}>
                    {paise < 0 ? "−" : ""}
                    <Money paise={Math.abs(paise)} />
                  </span>
                </li>
              ))}
              <li className="flex justify-between gap-4 py-0.5">
                <span>Wait pay ({f.wait || 0} min)</span>
                <Money paise={result.waitPaise} />
              </li>
              <li className="flex justify-between gap-4 py-0.5 font-semibold text-ink-900">
                <span>Total (before incentives)</span>
                <Money paise={result.totalPaise} />
              </li>
            </ul>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
