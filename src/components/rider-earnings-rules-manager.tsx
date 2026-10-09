"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, Money, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

export interface SlotRow {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
  baseFeePaise: number | null;
  perKmFeePaise: number | null;
  minEarningPaise: number | null;
  orderFeePaise: number;
  orderPercentBp: number;
  peakBonusPaise: number;
  isPeak: boolean;
  priority: number;
  isActive: boolean;
}

export interface IncentiveRow {
  id: string;
  name: string;
  description: string | null;
  type: string;
  thresholdValue: number;
  rewardPaise: number;
  period: string;
  startTime: string | null;
  endTime: string | null;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TYPE_HELP: Record<string, string> = {
  ORDER_COUNT: "Extra per delivery once the rider has completed more than N in the period",
  DAILY_TARGET: "One-off reward when the rider reaches N deliveries in a day",
  WEEKLY_TARGET: "One-off reward when the rider reaches N deliveries in a week",
  DISTANCE: "Reward on a delivery whose leg is at least N metres",
  PEAK_HOUR: "Reward on a delivery inside the time window below",
  CAMPAIGN: "Reward on every delivery while the campaign dates/time window are live",
};

const rupees = (value: string): number | null => {
  const v = value.trim();
  if (v === "") return null;
  const n = Number(v.replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? rupeesToPaise(n) : null;
};

function useCall() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function call(url: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
        setError(fields ? Object.values(fields).join(" ") : (payload?.error?.message ?? "That did not work."));
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, call };
}

function DayPicker({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Days of the week">
      {DAYS.map((label, day) => {
        const on = value.includes(day);
        return (
          <button
            key={label}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((d) => d !== day) : [...value, day])}
            className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-kesari-600 bg-kesari-50 text-kesari-700" : "border-cream-200 text-ink-500"}`}
          >
            {label}
          </button>
        );
      })}
      <span className="text-xs text-ink-500">{value.length === 0 ? "every day" : ""}</span>
    </div>
  );
}

export function RiderEarningsRulesManager({ slots, incentives }: { slots: SlotRow[]; incentives: IncentiveRow[] }) {
  return (
    <div className="space-y-8">
      <SlotsSection slots={slots} />
      <IncentivesSection incentives={incentives} />
      <PreviewSection />
    </div>
  );
}

function SlotsSection({ slots }: { slots: SlotRow[] }) {
  const { busy, error, call } = useCall();
  const [f, setF] = useState({
    name: "",
    startTime: "06:00",
    endTime: "11:00",
    base: "",
    perKm: "",
    min: "",
    orderFee: "",
    orderPct: "",
    peak: "",
    isPeak: false,
    priority: "0",
    days: [] as number[],
  });
  const set = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [key]: e.target.value });

  async function add() {
    const ok = await call("/api/admin/rider-earnings/slots", "POST", {
      name: f.name,
      startTime: f.startTime,
      endTime: f.endTime,
      daysOfWeek: f.days,
      baseFeePaise: rupees(f.base),
      perKmFeePaise: rupees(f.perKm),
      minEarningPaise: rupees(f.min),
      orderFeePaise: rupees(f.orderFee) ?? 0,
      orderPercentBp: Math.round(Number(f.orderPct || 0) * 100),
      peakBonusPaise: rupees(f.peak) ?? 0,
      isPeak: f.isPeak,
      priority: Number(f.priority || 0),
    });
    if (ok) setF({ ...f, name: "" });
  }

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-ink-900">Earning slots</h2>
      <p className="mb-3 text-sm text-ink-500">
        A slot is a time window (local time) with its own rates. A delivery uses the highest-priority slot containing its
        completion time; blank rates fall back to the default rate above. With no slots, the default rate applies.
      </p>
      <div className="space-y-2">
        {slots.length === 0 ? <p className="text-sm text-ink-500">No slots yet.</p> : null}
        {slots.map((s) => (
          <Card key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" data-testid="slot-row">
            <div>
              <p className="font-medium text-ink-900">
                {s.name} <span className="text-ink-500">{s.startTime}–{s.endTime}</span>{" "}
                {s.daysOfWeek.length ? <span className="text-xs text-ink-500">({s.daysOfWeek.map((d) => DAYS[d]).join(", ")})</span> : null}
              </p>
              <p className="text-xs text-ink-500">
                base {s.baseFeePaise != null ? <Money paise={s.baseFeePaise} /> : "default"} · per km{" "}
                {s.perKmFeePaise != null ? <Money paise={s.perKmFeePaise} /> : "default"} · min{" "}
                {s.minEarningPaise != null ? <Money paise={s.minEarningPaise} /> : "—"} · order fee <Money paise={s.orderFeePaise} /> +{" "}
                {(s.orderPercentBp / 100).toFixed(2)}% · peak bonus <Money paise={s.peakBonusPaise} /> · priority {s.priority}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {s.isPeak ? <Badge tone="warning">peak</Badge> : null}
              <Badge tone={s.isActive ? "success" : "neutral"}>{s.isActive ? "active" : "off"}</Badge>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  call(`/api/admin/rider-earnings/slots/${s.id}`, "PATCH", {
                    name: s.name,
                    startTime: s.startTime,
                    endTime: s.endTime,
                    daysOfWeek: s.daysOfWeek,
                    baseFeePaise: s.baseFeePaise,
                    perKmFeePaise: s.perKmFeePaise,
                    minEarningPaise: s.minEarningPaise,
                    orderFeePaise: s.orderFeePaise,
                    orderPercentBp: s.orderPercentBp,
                    peakBonusPaise: s.peakBonusPaise,
                    isPeak: s.isPeak,
                    priority: s.priority,
                    isActive: !s.isActive,
                  })
                }
              >
                {s.isActive ? "Switch off" : "Switch on"}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-3 space-y-3 p-4">
        <p className="text-sm font-medium text-ink-700">Add a slot</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name (Morning, Evening…)">
            <input className={inputClass} value={f.name} onChange={set("name")} />
          </Field>
          <Field label="From (HH:MM)">
            <input className={inputClass} value={f.startTime} onChange={set("startTime")} />
          </Field>
          <Field label="To (HH:MM)">
            <input className={inputClass} value={f.endTime} onChange={set("endTime")} />
          </Field>
          <Field label="Base fee ₹ (blank = default)">
            <input className={inputClass} value={f.base} onChange={set("base")} inputMode="decimal" />
          </Field>
          <Field label="Per km ₹ (blank = default)">
            <input className={inputClass} value={f.perKm} onChange={set("perKm")} inputMode="decimal" />
          </Field>
          <Field label="Minimum earning ₹">
            <input className={inputClass} value={f.min} onChange={set("min")} inputMode="decimal" />
          </Field>
          <Field label="Order fee ₹ (flat)">
            <input className={inputClass} value={f.orderFee} onChange={set("orderFee")} inputMode="decimal" />
          </Field>
          <Field label="Share of order value %">
            <input className={inputClass} value={f.orderPct} onChange={set("orderPct")} inputMode="decimal" />
          </Field>
          <Field label="Peak bonus ₹">
            <input className={inputClass} value={f.peak} onChange={set("peak")} inputMode="decimal" />
          </Field>
          <Field label="Priority (higher wins)">
            <input className={inputClass} value={f.priority} onChange={set("priority")} inputMode="numeric" />
          </Field>
        </div>
        <DayPicker value={f.days} onChange={(days) => setF({ ...f, days })} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.isPeak} onChange={(e) => setF({ ...f, isPeak: e.target.checked })} /> This is a peak period
        </label>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button disabled={busy || !f.name.trim()} onClick={add}>
          Add slot
        </Button>
      </Card>
    </section>
  );
}

function IncentivesSection({ incentives }: { incentives: IncentiveRow[] }) {
  const { busy, error, call } = useCall();
  const [f, setF] = useState({
    name: "",
    type: "DAILY_TARGET",
    threshold: "",
    reward: "",
    period: "DAY",
    startTime: "",
    endTime: "",
    validFrom: "",
    validTo: "",
    days: [] as number[],
  });
  const set = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [key]: e.target.value });

  async function add() {
    const reward = rupees(f.reward);
    const ok = await call("/api/admin/rider-earnings/incentives", "POST", {
      name: f.name,
      type: f.type,
      thresholdValue: Number(f.threshold || 0),
      rewardPaise: reward ?? 0,
      period: f.period,
      startTime: f.startTime || null,
      endTime: f.endTime || null,
      validFrom: f.validFrom || null,
      validTo: f.validTo || null,
      daysOfWeek: f.days,
    });
    if (ok) setF({ ...f, name: "", threshold: "", reward: "" });
  }

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-ink-900">Incentives</h2>
      <div className="space-y-2">
        {incentives.length === 0 ? <p className="text-sm text-ink-500">No incentives yet.</p> : null}
        {incentives.map((i) => (
          <Card key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" data-testid="incentive-row">
            <div>
              <p className="font-medium text-ink-900">
                {i.name} <span className="text-xs text-ink-500">{i.type.replace(/_/g, " ").toLowerCase()}</span>
              </p>
              <p className="text-xs text-ink-500">
                {TYPE_HELP[i.type]} · threshold {i.thresholdValue} · reward <Money paise={i.rewardPaise} />
                {i.validFrom || i.validTo ? ` · ${i.validFrom ?? "…"} → ${i.validTo ?? "…"}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={i.isActive ? "success" : "neutral"}>{i.isActive ? "active" : "off"}</Badge>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  call(`/api/admin/rider-earnings/incentives/${i.id}`, "PATCH", {
                    name: i.name,
                    description: i.description,
                    type: i.type,
                    thresholdValue: i.thresholdValue,
                    rewardPaise: i.rewardPaise,
                    period: i.period,
                    startTime: i.startTime,
                    endTime: i.endTime,
                    validFrom: i.validFrom,
                    validTo: i.validTo,
                    isActive: !i.isActive,
                  })
                }
              >
                {i.isActive ? "Switch off" : "Switch on"}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-3 space-y-3 p-4">
        <p className="text-sm font-medium text-ink-700">Add an incentive</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <input className={inputClass} value={f.name} onChange={set("name")} />
          </Field>
          <Field label="Kind">
            <select className={inputClass} value={f.type} onChange={set("type")}>
              {Object.keys(TYPE_HELP).map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ").toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reward ₹">
            <input className={inputClass} value={f.reward} onChange={set("reward")} inputMode="decimal" />
          </Field>
          <Field label="Threshold (orders, or metres for distance)">
            <input className={inputClass} value={f.threshold} onChange={set("threshold")} inputMode="numeric" />
          </Field>
          <Field label="Counts per (order count only)">
            <select className={inputClass} value={f.period} onChange={set("period")}>
              <option value="DAY">day</option>
              <option value="WEEK">week</option>
            </select>
          </Field>
          <span />
          <Field label="Window from (HH:MM, optional)">
            <input className={inputClass} value={f.startTime} onChange={set("startTime")} />
          </Field>
          <Field label="Window to (HH:MM)">
            <input className={inputClass} value={f.endTime} onChange={set("endTime")} />
          </Field>
          <span />
          <Field label="Valid from (YYYY-MM-DD)">
            <input className={inputClass} value={f.validFrom} onChange={set("validFrom")} />
          </Field>
          <Field label="Valid to (YYYY-MM-DD)">
            <input className={inputClass} value={f.validTo} onChange={set("validTo")} />
          </Field>
        </div>
        <p className="text-xs text-ink-500">{TYPE_HELP[f.type]}</p>
        <DayPicker value={f.days} onChange={(days) => setF({ ...f, days })} />
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button disabled={busy || !f.name.trim()} onClick={add}>
          Add incentive
        </Button>
      </Card>
    </section>
  );
}

interface PreviewResult {
  totalPaise: number;
  slotName: string | null;
  lines: { component: string; amountPaise: number; description: string }[];
}

function PreviewSection() {
  const [km, setKm] = useState("3");
  const [subtotal, setSubtotal] = useState("300");
  const [at, setAt] = useState("");
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    const res = await fetch("/api/admin/rider-earnings/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        distanceKm: Number(km),
        orderSubtotalPaise: rupeesToPaise(Number(subtotal || 0)),
        ...(at ? { at: new Date(at).toISOString() } : {}),
      }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      setError(payload?.error?.message ?? "Could not calculate.");
      setResult(null);
      return;
    }
    setResult(payload);
  }

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-ink-900">Try a delivery</h2>
      <p className="mb-3 text-sm text-ink-500">See what a single delivery would earn under the current rules. Nothing is saved.</p>
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Distance (km)">
            <input className={inputClass} value={km} onChange={(e) => setKm(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Order value ₹">
            <input className={inputClass} value={subtotal} onChange={(e) => setSubtotal(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="When (blank = now)">
            <input className={inputClass} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
        </div>
        <Button onClick={run}>Calculate</Button>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {result ? (
          <div data-testid="earning-preview">
            <p className="text-sm text-ink-600">
              Slot: {result.slotName ?? "none (default rate)"} — net <strong><Money paise={result.totalPaise} /></strong>
            </p>
            <ul className="mt-1 text-sm text-ink-600">
              {result.lines.map((l, i) => (
                <li key={i} className="flex justify-between gap-4">
                  <span>{l.description}</span>
                  <span className={l.amountPaise < 0 ? "text-red-700" : ""}>
                    {l.amountPaise < 0 ? "−" : ""}
                    <Money paise={Math.abs(l.amountPaise)} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
