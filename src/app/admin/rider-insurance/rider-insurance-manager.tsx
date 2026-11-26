"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Field, inputClass } from "@/components/ui";

interface HospitalView {
  name: string;
  city: string;
  address: string;
  phone: string;
}

export interface PolicyView {
  id: string;
  insurer: string;
  policyNumber: string;
  healthCoverRupees: number;
  accidentCoverRupees: number;
  opdCoverRupees: number;
  minDeliveries: number;
  lookbackDays: number;
  validFrom: string;
  validTo: string;
  hospitalsUrl: string;
  hospitals: HospitalView[];
  claimHelp: string;
  isActive: boolean;
  updatedAt: string;
}

type Draft = Omit<PolicyView, "id" | "updatedAt">;

const EMPTY: Draft = {
  insurer: "",
  policyNumber: "",
  healthCoverRupees: 0,
  accidentCoverRupees: 0,
  opdCoverRupees: 0,
  minDeliveries: 1,
  lookbackDays: 30,
  validFrom: "",
  validTo: "",
  hospitalsUrl: "",
  hospitals: [],
  claimHelp: "",
  isActive: false,
};

const rupees = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

export function RiderInsuranceManager({ policies }: { policies: PolicyView[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function send(url: string, method: string, body: unknown) {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setFieldErrors(payload?.error?.details?.fields ?? {});
        throw new Error(payload?.error?.message ?? "Could not save the policy.");
      }
      setEditing(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the policy.");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!editing) return;
    const d = editing.draft;
    const body = {
      ...d,
      hospitalsUrl: d.hospitalsUrl.trim() || null,
      claimHelp: d.claimHelp.trim() || null,
      hospitals: d.hospitals
        .filter((h) => h.name.trim() || h.city.trim())
        .map((h) => ({ name: h.name, city: h.city, ...(h.address.trim() ? { address: h.address } : {}), ...(h.phone.trim() ? { phone: h.phone } : {}) })),
    };
    void send(editing.id ? `/api/admin/rider-insurance/${editing.id}` : "/api/admin/rider-insurance", editing.id ? "PUT" : "POST", body);
  }

  if (editing) {
    const d = editing.draft;
    const set = (patch: Partial<Draft>) => setEditing({ ...editing, draft: { ...d, ...patch } });
    const setHospital = (i: number, patch: Partial<HospitalView>) => set({ hospitals: d.hospitals.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
    const num = (value: string) => (value === "" ? 0 : Number(value));
    return (
      <Card className="space-y-4 p-5" data-testid="rider-insurance-form">
        <h2 className="text-lg font-semibold text-ink-900">{editing.id ? "Edit policy" : "New policy"}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Insurer" error={fieldErrors.insurer}>
            <input className={inputClass} value={d.insurer} onChange={(e) => set({ insurer: e.target.value })} />
          </Field>
          <Field label="Policy number" error={fieldErrors.policyNumber}>
            <input className={inputClass} value={d.policyNumber} onChange={(e) => set({ policyNumber: e.target.value })} />
          </Field>
          <Field label="Health cover (₹)" error={fieldErrors.healthCoverPaise}>
            <input type="number" min={0} className={inputClass} value={d.healthCoverRupees} onChange={(e) => set({ healthCoverRupees: num(e.target.value) })} />
          </Field>
          <Field label="Accidental death cover (₹)" error={fieldErrors.accidentCoverPaise}>
            <input type="number" min={0} className={inputClass} value={d.accidentCoverRupees} onChange={(e) => set({ accidentCoverRupees: num(e.target.value) })} />
          </Field>
          <Field label="OPD cover (₹)" error={fieldErrors.opdCoverPaise}>
            <input type="number" min={0} className={inputClass} value={d.opdCoverRupees} onChange={(e) => set({ opdCoverRupees: num(e.target.value) })} />
          </Field>
          <div />
          <Field label="Eligible with at least … deliveries" error={fieldErrors.minDeliveries}>
            <input type="number" min={0} className={inputClass} value={d.minDeliveries} onChange={(e) => set({ minDeliveries: Math.trunc(num(e.target.value)) })} />
          </Field>
          <Field label="… in the last … days" error={fieldErrors.lookbackDays}>
            <input type="number" min={1} max={366} className={inputClass} value={d.lookbackDays} onChange={(e) => set({ lookbackDays: Math.trunc(num(e.target.value)) })} />
          </Field>
          <Field label="Valid from" error={fieldErrors.validFrom}>
            <input type="date" className={inputClass} value={d.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
          </Field>
          <Field label="Valid to" error={fieldErrors.validTo}>
            <input type="date" className={inputClass} value={d.validTo} onChange={(e) => set({ validTo: e.target.value })} />
          </Field>
        </div>
        <Field label="Network hospitals link (optional, https://…)" error={fieldErrors.hospitalsUrl}>
          <input className={inputClass} value={d.hospitalsUrl} onChange={(e) => set({ hospitalsUrl: e.target.value })} />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-700">Network hospitals</legend>
          {fieldErrors.hospitals ? <p className="text-xs text-red-600">{fieldErrors.hospitals}</p> : null}
          {d.hospitals.map((h, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-cream-200 p-2 sm:grid-cols-[1fr_1fr_2fr_1fr_auto]">
              <input className={inputClass} placeholder="Name" value={h.name} onChange={(e) => setHospital(i, { name: e.target.value })} />
              <input className={inputClass} placeholder="City" value={h.city} onChange={(e) => setHospital(i, { city: e.target.value })} />
              <input className={inputClass} placeholder="Address" value={h.address} onChange={(e) => setHospital(i, { address: e.target.value })} />
              <input className={inputClass} placeholder="Phone" value={h.phone} onChange={(e) => setHospital(i, { phone: e.target.value })} />
              <Button size="sm" variant="ghost" onClick={() => set({ hospitals: d.hospitals.filter((_, j) => j !== i) })}>
                Remove
              </Button>
              {fieldErrors[`hospitals.${i}`] ? <p className="text-xs text-red-600 sm:col-span-5">{fieldErrors[`hospitals.${i}`]}</p> : null}
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => set({ hospitals: [...d.hospitals, { name: "", city: "", address: "", phone: "" }] })}>
            Add hospital
          </Button>
        </fieldset>
        <Field label="How to claim (shown to riders)">
          <textarea className={inputClass} rows={4} value={d.claimHelp} onChange={(e) => set({ claimHelp: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-800">
          <input type="checkbox" checked={d.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          Active (switches every other policy off and tells eligible riders)
        </label>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save policy"}
          </Button>
          <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Button onClick={() => setEditing({ id: null, draft: EMPTY })}>New policy</Button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {policies.length === 0 ? (
        <EmptyState title="No policy yet" description="Until a policy is active, riders see “Coming soon”." />
      ) : (
        policies.map((p) => (
          <Card key={p.id} className="space-y-2 p-4 text-sm" data-testid="rider-insurance-policy">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-ink-900">
                {p.insurer} · {p.policyNumber}
              </p>
              <Badge tone={p.isActive ? "success" : "neutral"}>{p.isActive ? "active" : "inactive"}</Badge>
            </div>
            <p className="text-ink-700">
              Health {rupees(p.healthCoverRupees)} · Accidental death {rupees(p.accidentCoverRupees)} · OPD {rupees(p.opdCoverRupees)}
            </p>
            <p className="text-ink-600">
              Eligible: {p.minDeliveries} deliveries in {p.lookbackDays} days · valid {p.validFrom} to {p.validTo} · {p.hospitals.length} hospitals
              {p.hospitalsUrl ? " + link" : ""} · updated {p.updatedAt}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing({ id: p.id, draft: { ...p } })}>
                Edit
              </Button>
              <Button size="sm" variant={p.isActive ? "secondary" : "primary"} disabled={busy} onClick={() => send(`/api/admin/rider-insurance/${p.id}`, "PATCH", { isActive: !p.isActive })}>
                {p.isActive ? "Deactivate" : "Activate"}
              </Button>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
