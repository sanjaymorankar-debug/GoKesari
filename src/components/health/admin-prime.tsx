"use client";

/**
 * GoKesari Health Prime, admin (health:manage): plans (prices per term, features, quotas, city /
 * specialty scope, on / off), coupons, subscriptions, revenue by month / plan / city. Self-contained:
 * drop <AdminPrime /> into /admin/health. Data: /api/admin/health/prime. Prices are entered in rupees and
 * apply to the next purchase; plans already paid keep their price.
 */
import { useCallback, useEffect, useState } from "react";

import { PRIME_AUDIENCES, PRIME_FEATURE_LABELS, PRIME_TERMS, PRIME_TIER_LABELS, PRIME_TIERS, type PrimeAudience, type PrimeTerm, type PrimeTier } from "@/lib/health/constants";
import type { AdminSubscriptionRow, PrimePlanView, RevenueRow } from "@/server/health/prime";
import { Alert, Button, Field, inputClass } from "@/components/ui";
import { amount, api, Chip, ist, Panel } from "./api";

type Tab = "plans" | "coupons" | "subscriptions" | "revenue";
const AUDIENCE_LABELS: Record<PrimeAudience, string> = { DOCTOR: "Doctors / clinics", CARE_PROVIDER: "Home-care providers", EQUIPMENT_STORE: "Equipment stores" };
const QUOTA_KEYS = ["messagesPerMonth", "clinics", "staffLogins"] as const;

interface Coupon {
  code: string;
  percentOff: number;
  maxUses: number | null;
  used: number;
  validUntil: string | null;
  status: string;
}

interface PlanForm {
  id: string | null;
  code: string;
  name: string;
  audience: PrimeAudience;
  tier: PrimeTier;
  description: string;
  city: string;
  specialty: string;
  status: "ACTIVE" | "INACTIVE";
  sortOrder: number;
  prices: Record<PrimeTerm, string>;
  features: Record<string, boolean>;
  quotas: Record<string, string>;
}

const blankPlan = (): PlanForm => ({
  id: null,
  code: "",
  name: "",
  audience: "DOCTOR",
  tier: "PRIME",
  description: "",
  city: "",
  specialty: "",
  status: "ACTIVE",
  sortOrder: 100,
  prices: { MONTHLY: "", QUARTERLY: "", YEARLY: "" },
  features: {},
  quotas: {},
});

const formOf = (p: PrimePlanView): PlanForm => ({
  id: p.id,
  code: p.code,
  name: p.name,
  audience: p.audience,
  tier: p.tier,
  description: p.description ?? "",
  city: p.city ?? "",
  specialty: p.specialty ?? "",
  status: p.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
  sortOrder: p.sortOrder,
  prices: Object.fromEntries(PRIME_TERMS.map((t) => [t, typeof p.prices[t] === "number" ? String((p.prices[t] as number) / 100) : ""])) as Record<PrimeTerm, string>,
  features: { ...p.features },
  quotas: Object.fromEntries(Object.entries(p.quotas).map(([k, v]) => [k, String(v)])),
});

export function AdminPrime() {
  const [tab, setTab] = useState<Tab>("plans");
  return (
    <div className="flex flex-col gap-4" data-testid="health-admin-prime">
      <div className="flex flex-wrap gap-1.5">
        {(["plans", "coupons", "subscriptions", "revenue"] as Tab[]).map((t) => (
          <Chip key={t} active={tab === t} onClick={() => setTab(t)} testId={`health-admin-prime-${t}`}>
            {t === "plans" ? "Plans" : t === "coupons" ? "Coupons" : t === "subscriptions" ? "Subscriptions" : "Revenue"}
          </Chip>
        ))}
      </div>
      {tab === "plans" ? <Plans /> : tab === "coupons" ? <Coupons /> : tab === "subscriptions" ? <Subscriptions /> : <Revenue />}
    </div>
  );
}

function Plans() {
  const [plans, setPlans] = useState<PrimePlanView[]>([]);
  const [form, setForm] = useState<PlanForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ plans: PrimePlanView[] }>("/api/admin/health/prime?view=plans").then((r) => setPlans(r.plans)).catch((e) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    try {
      await api("/api/admin/health/prime", {
        json: {
          action: "plan",
          plan: {
            id: form.id,
            code: form.code,
            name: form.name,
            audience: form.audience,
            tier: form.tier,
            description: form.description || null,
            city: form.city || null,
            specialty: form.specialty || null,
            status: form.status,
            sortOrder: Number(form.sortOrder) || 100,
            pricesRupees: { MONTHLY: num(form.prices.MONTHLY), QUARTERLY: num(form.prices.QUARTERLY), YEARLY: num(form.prices.YEARLY) },
            features: form.features,
            quotas: Object.fromEntries(Object.entries(form.quotas).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v)])),
          },
        },
      });
      setForm(null);
      setNote("Saved. New prices apply to the next purchase.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (p: PrimePlanView) => {
    try {
      await api("/api/admin/health/prime", { json: { action: "plan-status", planId: p.id, status: p.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change it.");
    }
  };

  return (
    <Panel title="Prime plans" action={<Button size="sm" onClick={() => setForm(blankPlan())}>Add plan</Button>}>
      {note ? <Alert tone="success">{note}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="health-admin-prime-plans">
          <thead>
            <tr className="text-left text-xs uppercase text-ink-600">
              <th className="py-1">Plan</th>
              <th>For</th>
              <th>Scope</th>
              <th className="text-right">Month</th>
              <th className="text-right">Quarter</th>
              <th className="text-right">Year</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} className="border-t border-cream-200">
                <td className="py-2">
                  <strong>{p.name}</strong> <span className="text-xs text-ink-500">{p.code}</span>
                  <br />
                  <span className="text-xs text-ink-600">{PRIME_TIER_LABELS[p.tier]}</span>
                </td>
                <td>{AUDIENCE_LABELS[p.audience]}</td>
                <td className="text-xs">{[p.city, p.specialty].filter(Boolean).join(" · ") || "Everywhere"}</td>
                {PRIME_TERMS.map((t) => (
                  <td key={t} className="text-right tabular-nums">
                    {p.termPrices[t] == null ? "—" : amount(p.termPrices[t])}
                    {typeof p.prices[t] !== "number" && p.termPrices[t] != null ? <span className="block text-[10px] text-ink-500">from monthly</span> : null}
                  </td>
                ))}
                <td>{p.status === "ACTIVE" ? "On" : "Off"}</td>
                <td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setForm(formOf(p))}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle(p)}>
                    {p.status === "ACTIVE" ? "Turn off" : "Turn on"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-600">Quarterly / yearly left empty = monthly × months less the term discount in the Health rule. GST (rule) is added at purchase. A city or specialty plan replaces the general plan of the same tier for shops there.</p>
      {form ? (
        <div className="mt-4 flex flex-col gap-3 rounded-2xl border-2 border-kesari-300 bg-kesari-50 p-3" data-testid="health-admin-prime-plan-form">
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Code">
              <input className={inputClass} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="DOCTOR_PRIME_PUNE" />
            </Field>
            <Field label="Name">
              <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Order">
              <input className={inputClass} inputMode="numeric" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
            </Field>
            <Field label="For">
              <select className={inputClass} value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as PrimeAudience })}>
                {PRIME_AUDIENCES.map((a) => (
                  <option key={a} value={a}>
                    {AUDIENCE_LABELS[a]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tier">
              <select className={inputClass} value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value as PrimeTier })}>
                {PRIME_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {PRIME_TIER_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "ACTIVE" | "INACTIVE" })}>
                <option value="ACTIVE">On</option>
                <option value="INACTIVE">Off</option>
              </select>
            </Field>
            <Field label="City (empty = everywhere)">
              <input className={inputClass} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </Field>
            <Field label="Specialty (category slug or name; empty = all)">
              <input className={inputClass} value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} />
            </Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {PRIME_TERMS.map((t) => (
              <Field key={t} label={`${t === "MONTHLY" ? "Monthly" : t === "QUARTERLY" ? "Quarterly" : "Yearly"} price (₹, before GST)`}>
                <input className={inputClass} inputMode="decimal" value={form.prices[t]} onChange={(e) => setForm({ ...form, prices: { ...form.prices, [t]: e.target.value.replace(/[^\d.]/g, "") } })} />
              </Field>
            ))}
          </div>
          <Field label="Description">
            <textarea className={inputClass} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <fieldset>
            <legend className="mb-1 text-sm font-bold text-ink-800">Features</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {Object.entries(PRIME_FEATURE_LABELS).map(([k, label]) => (
                <label key={k} className="flex min-h-10 items-center gap-2 text-sm">
                  <input type="checkbox" className="h-5 w-5" checked={Boolean(form.features[k])} onChange={(e) => setForm({ ...form, features: { ...form.features, [k]: e.target.checked } })} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-2 sm:grid-cols-3">
            {QUOTA_KEYS.map((k) => (
              <Field key={k} label={k === "messagesPerMonth" ? "Messages / month" : k === "clinics" ? "Clinics" : "Staff logins"}>
                <input className={inputClass} inputMode="numeric" value={form.quotas[k] ?? ""} onChange={(e) => setForm({ ...form, quotas: { ...form.quotas, [k]: e.target.value.replace(/\D/g, "") } })} />
              </Field>
            ))}
          </div>
          <div className="flex gap-2">
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save plan"}
            </Button>
            <Button variant="secondary" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function Coupons() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [form, setForm] = useState({ code: "", percentOff: "10", maxUses: "", validUntil: "", status: "ACTIVE" });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ coupons: Coupon[] }>("/api/admin/health/prime?view=coupons").then((r) => setCoupons(r.coupons)).catch((e) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (over: Partial<typeof form> = {}) => {
    const f = { ...form, ...over };
    setError(null);
    try {
      await api("/api/admin/health/prime", {
        json: {
          action: "coupon",
          coupon: { code: f.code, percentOff: Number(f.percentOff), maxUses: f.maxUses ? Number(f.maxUses) : null, validUntil: f.validUntil ? new Date(`${f.validUntil}T23:59:59+05:30`).toISOString() : null, status: f.status },
        },
      });
      setForm({ code: "", percentOff: "10", maxUses: "", validUntil: "", status: "ACTIVE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  };
  return (
    <Panel title="Coupons">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="grid gap-2 sm:grid-cols-5">
        <Field label="Code">
          <input className={inputClass} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="% off">
          <input className={inputClass} inputMode="numeric" value={form.percentOff} onChange={(e) => setForm({ ...form, percentOff: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field label="Max uses (empty = no limit)">
          <input className={inputClass} inputMode="numeric" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field label="Valid until (IST)">
          <input className={inputClass} type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
        </Field>
        <div className="flex items-end">
          <Button onClick={() => save()} disabled={!form.code}>
            Save coupon
          </Button>
        </div>
      </div>
      <table className="mt-3 w-full text-sm" data-testid="health-admin-prime-coupons">
        <thead>
          <tr className="text-left text-xs uppercase text-ink-600">
            <th className="py-1">Code</th>
            <th>% off</th>
            <th>Used</th>
            <th>Valid until</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {coupons.map((c) => (
            <tr key={c.code} className="border-t border-cream-200">
              <td className="py-2 font-bold">{c.code}</td>
              <td>{c.percentOff}%</td>
              <td>
                {c.used}
                {c.maxUses != null ? ` / ${c.maxUses}` : ""}
              </td>
              <td>{c.validUntil ? ist(c.validUntil, false) : "—"}</td>
              <td>{c.status === "ACTIVE" ? "On" : "Off"}</td>
              <td className="text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => save({ code: c.code, percentOff: String(c.percentOff), maxUses: c.maxUses ? String(c.maxUses) : "", validUntil: c.validUntil ? c.validUntil.slice(0, 10) : "", status: c.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" })}
                >
                  {c.status === "ACTIVE" ? "Turn off" : "Turn on"}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Subscriptions() {
  const [rows, setRows] = useState<AdminSubscriptionRow[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ subscriptions: AdminSubscriptionRow[] }>(`/api/admin/health/prime?view=subscriptions${status ? `&status=${status}` : ""}`)
      .then((r) => setRows(r.subscriptions))
      .catch((e) => setError(e.message));
  }, [status]);
  return (
    <Panel title="Subscriptions">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {["", "ACTIVE", "GRACE", "PENDING_PAYMENT", "EXPIRED", "CANCELLED"].map((s) => (
          <Chip key={s || "all"} active={status === s} onClick={() => setStatus(s)}>
            {s ? s.replace(/_/g, " ").toLowerCase() : "all"}
          </Chip>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="health-admin-prime-subscriptions">
          <thead>
            <tr className="text-left text-xs uppercase text-ink-600">
              <th className="py-1">Shop</th>
              <th>Plan</th>
              <th>Period</th>
              <th>Status</th>
              <th className="text-right">Total</th>
              <th>Invoice</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-cream-200">
                <td className="py-2">
                  {s.shopName} <span className="text-xs text-ink-500">{s.city}</span>
                </td>
                <td>
                  {s.planName} · {s.term.toLowerCase()}
                  {s.couponCode ? <span className="block text-xs text-ink-500">coupon {s.couponCode}</span> : null}
                </td>
                <td>{s.startsAt ? `${ist(s.startsAt, false)} – ${ist(s.endsAt, false)}` : "—"}</td>
                <td>{s.status.replace(/_/g, " ").toLowerCase()}</td>
                <td className="text-right tabular-nums">{amount(s.totalPaise)}</td>
                <td>
                  {s.invoiceNumber ? (
                    <a href={`/api/health/prime/invoices/${s.id}`} target="_blank" rel="noreferrer" className="font-bold text-kesari-800 underline">
                      {s.invoiceNumber}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Revenue() {
  const [range, setRange] = useState({ from: "", to: "" });
  const [data, setData] = useState<{ rows: RevenueRow[]; totals: { count: number; taxablePaise: number; gstPaise: number; totalPaise: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams({ view: "revenue" });
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    api<NonNullable<typeof data>>(`/api/admin/health/prime?${p.toString()}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [range]);
  return (
    <Panel title="Prime revenue (paid plans, by month of payment, IST)">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="mb-3 flex flex-wrap gap-2">
        <Field label="From">
          <input className={inputClass} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </Field>
        <Field label="To">
          <input className={inputClass} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </Field>
      </div>
      {data ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="health-admin-prime-revenue">
            <thead>
              <tr className="text-left text-xs uppercase text-ink-600">
                <th className="py-1">Month</th>
                <th>Plan</th>
                <th>City</th>
                <th className="text-right">Plans</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">GST</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.month}-${r.planCode}-${r.city}`} className="border-t border-cream-200">
                  <td className="py-2">{r.month}</td>
                  <td>{r.planName}</td>
                  <td>{r.city}</td>
                  <td className="text-right tabular-nums">{r.count}</td>
                  <td className="text-right tabular-nums">{amount(r.taxablePaise)}</td>
                  <td className="text-right tabular-nums">{amount(r.gstPaise)}</td>
                  <td className="text-right tabular-nums">{amount(r.totalPaise)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-ink-300 font-extrabold">
                <td className="py-2" colSpan={3}>
                  Total
                </td>
                <td className="text-right tabular-nums">{data.totals.count}</td>
                <td className="text-right tabular-nums">{amount(data.totals.taxablePaise)}</td>
                <td className="text-right tabular-nums">{amount(data.totals.gstPaise)}</td>
                <td className="text-right tabular-nums">{amount(data.totals.totalPaise)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
