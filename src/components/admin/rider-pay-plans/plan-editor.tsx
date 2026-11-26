"use client";

import { useMemo, useState } from "react";

import { Alert, Badge, Button, Card, Field, Money, inputClass } from "@/components/ui";
import { describePlan, planProblems, PUNE_PILOT_PLAN, slabProblems } from "@/lib/rider-pay-plan";

import {
  formatIstDateTime,
  formToBody,
  istInputToUtcIso,
  nextSlab,
  termsToForm,
  type PlanForm,
  type ScopeType,
  type SlabForm,
} from "./format";
import type { PlanRow, SimulationView, ZoneOption } from "./types";
import { useApi } from "./use-api";

const API = "/api/admin/rider-pay-plans";

const BLANK: PlanForm = {
  name: "",
  scopeType: "CITY",
  city: "",
  zoneId: "",
  baseFee: "",
  baseIncludedKm: "0",
  slabs: [{ fromKm: "0", toKm: "", ratePerKm: "" }],
  freeFirstMileKm: "0",
  firstMileRate: "0",
  firstMileCap: "0",
  freeWaitMin: "0",
  waitRate: "0",
  waitCap: "0",
  extraDropFee: "0",
  longDistanceKm: "",
  longDistanceBonus: "0",
  minGuarantee: "0",
  maxPerOrder: "",
  rerouteTolerancePct: "15",
  note: "",
};

const formOf = (plan: PlanRow | undefined): PlanForm =>
  plan ? termsToForm(plan, { name: plan.name, scopeType: plan.scopeType, city: plan.city, zoneId: plan.zoneId, note: plan.note }) : BLANK;

export const STATUS_TONE = { DRAFT: "info", SCHEDULED: "warning", ACTIVE: "success", RETIRED: "neutral" } as const;

export function scopeText(plan: Pick<PlanRow, "scopeType" | "city" | "zoneId">, zones: readonly ZoneOption[]): string {
  if (plan.scopeType === "DEFAULT") return "Default (everywhere else)";
  if (plan.scopeType === "CITY") return `City: ${plan.city ?? "—"}`;
  const zone = zones.find((z) => z.id === plan.zoneId);
  return `Zone: ${zone ? `${zone.city} — ${zone.name}` : "(removed zone)"}`;
}

/** Create or edit a draft (live check + plan in words), run the simulator, publish. Published versions open read-only. */
export function PlanEditor({
  plan,
  zones,
  onClose,
  onOpen,
}: {
  plan?: PlanRow;
  zones: readonly ZoneOption[];
  onClose: () => void;
  /** Called with a plan id to open after it is created. */
  onOpen: (id: string) => void;
}) {
  const api = useApi();
  const readOnly = plan != null && plan.status !== "DRAFT";
  const [form, setForm] = useState<PlanForm>(() => formOf(plan));
  const [saved, setSaved] = useState<string>(() => JSON.stringify(formOf(plan)));
  // The draft's updatedAt as this editor last saved it: a stale page prop cannot count as simulated.
  const [knownUpdatedAt, setKnownUpdatedAt] = useState<string | null>(plan?.updatedAt ?? null);
  const [localSim, setLocalSim] = useState<SimulationView | null>(null);
  const [publishing, setPublishing] = useState(false);

  const dirty = plan == null || JSON.stringify(form) !== saved;
  const { body, errors } = useMemo(() => formToBody(form), [form]);
  const problems = useMemo(() => (errors.length ? errors : planProblems(body)), [errors, body]);
  const slabIssues = useMemo(() => (errors.length ? [] : slabProblems(body.slabs, body.baseIncludedM)), [errors, body]);
  const words = useMemo(() => (errors.length ? [] : describePlan(body)), [errors, body]);

  const propSimCurrent = Boolean(plan?.simulationCurrent && plan.updatedAt === knownUpdatedAt);
  const simulation = localSim ?? (plan?.simulation && propSimCurrent ? plan.simulation : null);
  const canPublish = plan?.status === "DRAFT" && !dirty && problems.length === 0 && (localSim != null || propSimCurrent);

  const set = (key: keyof PlanForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [key]: e.target.value });
  const setSlab = (i: number, patch: Partial<SlabForm>) => setForm({ ...form, slabs: form.slabs.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  async function save() {
    if (problems.length) return;
    const res = plan
      ? await api.call<{ plan: PlanRow }>(`${API}/${plan.id}`, "PATCH", body)
      : await api.call<{ plan: PlanRow }>(API, "POST", body);
    if (!res) return;
    setSaved(JSON.stringify(form));
    setKnownUpdatedAt(res.plan.updatedAt);
    setLocalSim(null);
    if (!plan) onOpen(res.plan.id);
  }

  async function simulate(days: 7 | 30) {
    if (!plan) return;
    const res = await api.call<{ simulation: SimulationView }>(`${API}/${plan.id}/simulate`, "POST", { days });
    if (res) setLocalSim(res.simulation);
  }

  async function clone(asNewPlan: boolean) {
    if (!plan) return;
    const res = await api.call<{ plan: PlanRow }>(`${API}/${plan.id}/clone`, "POST", { asNewPlan });
    if (res) onOpen(res.plan.id);
  }

  const cities = [...new Set(zones.map((z) => z.city))].sort();

  return (
    <Card className="space-y-4 p-4" data-testid="pay-plan-editor">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-ink-900">
            {plan ? plan.label : "New pay plan"}{" "}
            {plan ? <Badge tone={STATUS_TONE[plan.status]}>{plan.status.toLowerCase()}</Badge> : null}{" "}
            {plan?.inForce ? <Badge tone="success">in force</Badge> : null}
          </h3>
          {plan && readOnly ? (
            <p className="text-xs text-ink-500">
              {scopeText(plan, zones)} · effective from {formatIstDateTime(plan.effectiveFrom)}
              {plan.note ? ` · note: ${plan.note}` : ""}
            </p>
          ) : null}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      {readOnly ? (
        <>
          <Alert tone="info">A published version cannot be changed. Make a new version from it, or copy it as a new plan for another city or zone.</Alert>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-700" data-testid="pay-plan-words">
            {(plan?.words ?? []).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Plan name">
              <input className={inputClass} value={form.name} onChange={set("name")} placeholder="Pune pilot" />
            </Field>
            <Field label="Applies to">
              <select className={inputClass} value={form.scopeType} onChange={(e) => setForm({ ...form, scopeType: e.target.value as ScopeType })}>
                <option value="DEFAULT">Default (everywhere else)</option>
                <option value="CITY">A city</option>
                <option value="ZONE">A delivery zone</option>
              </select>
            </Field>
            {form.scopeType === "CITY" ? (
              <Field label="City">
                <input className={inputClass} value={form.city} onChange={set("city")} list="pay-plan-cities" placeholder="Pune" />
                <datalist id="pay-plan-cities">
                  {cities.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
            ) : form.scopeType === "ZONE" ? (
              <Field label="Zone">
                <select className={inputClass} value={form.zoneId} onChange={set("zoneId")}>
                  <option value="">Choose a zone…</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.city} — {z.name}
                      {z.code ? ` (${z.code})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <span />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setForm({ ...termsToForm(PUNE_PILOT_PLAN), name: form.name, scopeType: form.scopeType, city: form.city, zoneId: form.zoneId, note: form.note })}
            >
              Start from Pune pilot numbers
            </Button>
            <span className="text-xs text-ink-500">Fills every amount below; name and scope stay as they are.</span>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-ink-800">Base and distance to the customer</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Base fee ₹">
                <input className={inputClass} value={form.baseFee} onChange={set("baseFee")} inputMode="decimal" />
              </Field>
              <Field label="Base fee covers the first (km)">
                <input className={inputClass} value={form.baseIncludedKm} onChange={set("baseIncludedKm")} inputMode="decimal" />
              </Field>
            </div>
            <div className="space-y-2" data-testid="pay-plan-slabs">
              <p className="text-sm text-ink-600">Distance slabs (shop → customer, beyond the base distance). The last slab has no end.</p>
              {form.slabs.map((s, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Field label={`From km`}>
                    <input className={`${inputClass} w-24`} value={s.fromKm} onChange={(e) => setSlab(i, { fromKm: e.target.value })} inputMode="decimal" aria-label={`Slab ${i + 1} from km`} />
                  </Field>
                  <Field label="To km">
                    <input
                      className={`${inputClass} w-28`}
                      value={s.toKm}
                      onChange={(e) => setSlab(i, { toKm: e.target.value })}
                      inputMode="decimal"
                      placeholder="and above"
                      aria-label={`Slab ${i + 1} to km (blank = and above)`}
                    />
                  </Field>
                  <Field label="₹ per km">
                    <input className={`${inputClass} w-24`} value={s.ratePerKm} onChange={(e) => setSlab(i, { ratePerKm: e.target.value })} inputMode="decimal" aria-label={`Slab ${i + 1} rupees per km`} />
                  </Field>
                  <Button size="sm" variant="ghost" disabled={form.slabs.length <= 1} onClick={() => setForm({ ...form, slabs: form.slabs.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="secondary" onClick={() => setForm({ ...form, slabs: [...form.slabs, nextSlab(form)] })}>
                Add slab
              </Button>
              {slabIssues.length ? (
                <ul className="text-xs text-red-700">
                  {slabIssues.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="mb-1 text-sm font-semibold text-ink-800">Ride to the shop, waiting, extra drops</legend>
            <Field label="Free first mile (km)">
              <input className={inputClass} value={form.freeFirstMileKm} onChange={set("freeFirstMileKm")} inputMode="decimal" />
            </Field>
            <Field label="First mile ₹ per km">
              <input className={inputClass} value={form.firstMileRate} onChange={set("firstMileRate")} inputMode="decimal" />
            </Field>
            <Field label="First mile at most ₹">
              <input className={inputClass} value={form.firstMileCap} onChange={set("firstMileCap")} inputMode="decimal" />
            </Field>
            <Field label="Free waiting (minutes)">
              <input className={inputClass} value={form.freeWaitMin} onChange={set("freeWaitMin")} inputMode="numeric" />
            </Field>
            <Field label="Waiting ₹ per minute">
              <input className={inputClass} value={form.waitRate} onChange={set("waitRate")} inputMode="decimal" />
            </Field>
            <Field label="Waiting at most ₹">
              <input className={inputClass} value={form.waitCap} onChange={set("waitCap")} inputMode="decimal" />
            </Field>
            <Field label="Each extra drop ₹">
              <input className={inputClass} value={form.extraDropFee} onChange={set("extraDropFee")} inputMode="decimal" />
            </Field>
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="mb-1 text-sm font-semibold text-ink-800">Bonus, minimum and cap</legend>
            <Field label="Long-distance from (km)" hint="Blank = no long-distance bonus.">
              <input className={inputClass} value={form.longDistanceKm} onChange={set("longDistanceKm")} inputMode="decimal" />
            </Field>
            <Field label="Long-distance bonus ₹">
              <input className={inputClass} value={form.longDistanceBonus} onChange={set("longDistanceBonus")} inputMode="decimal" />
            </Field>
            <span />
            <Field label="Minimum per order ₹">
              <input className={inputClass} value={form.minGuarantee} onChange={set("minGuarantee")} inputMode="decimal" />
            </Field>
            <Field label="Maximum per order ₹" hint="Blank = no cap.">
              <input className={inputClass} value={form.maxPerOrder} onChange={set("maxPerOrder")} inputMode="decimal" />
            </Field>
            <Field label="Reroute tolerance %" hint="Route grows more than this → rider gets the higher pay.">
              <input className={inputClass} value={form.rerouteTolerancePct} onChange={set("rerouteTolerancePct")} inputMode="numeric" />
            </Field>
          </fieldset>

          <Field label="Note (optional, why this plan)">
            <input className={inputClass} value={form.note} onChange={set("note")} maxLength={500} />
          </Field>

          <div className="rounded-lg border border-cream-200 bg-cream-50 p-3" data-testid="pay-plan-preview">
            <p className="mb-1 text-sm font-semibold text-ink-800">The plan in words</p>
            {words.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-700">
                {words.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-500">Fill in the amounts to see the plan in words.</p>
            )}
          </div>
          {problems.length ? (
            <Alert tone="warning" title="Fix these before saving">
              <ul className="list-disc pl-5">
                {problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={api.busy || problems.length > 0 || !dirty} onClick={save}>
              {plan ? "Save draft" : "Create draft"}
            </Button>
            {plan && dirty ? <span className="text-xs text-amber-700">Unsaved changes — save before running the simulator.</span> : null}
          </div>
        </>
      )}

      {api.error ? <Alert tone="danger">{api.error}</Alert> : null}

      {plan ? (
        <div className="space-y-3 border-t border-cream-200 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink-800">Simulator</span>
            <Button size="sm" variant="secondary" disabled={api.busy || dirty} onClick={() => simulate(7)}>
              Replay last 7 days
            </Button>
            <Button size="sm" variant="secondary" disabled={api.busy || dirty} onClick={() => simulate(30)}>
              Replay last 30 days
            </Button>
          </div>
          {simulation ? <SimulationTable sim={simulation} /> : readOnly ? null : <p className="text-sm text-ink-500">No simulator run on this draft as it is now. Publishing needs one.</p>}

          <div className="flex flex-wrap items-center gap-2">
            {plan.status === "DRAFT" ? (
              <Button disabled={!canPublish || api.busy} onClick={() => setPublishing(true)} title={canPublish ? undefined : "Save the draft and run the simulator first"}>
                Publish…
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" disabled={api.busy} onClick={() => clone(false)}>
              New version of this plan
            </Button>
            <Button size="sm" variant="secondary" disabled={api.busy} onClick={() => clone(true)}>
              Copy as new plan
            </Button>
          </div>
          {publishing && plan.status === "DRAFT" ? <PublishDialog plan={plan} onCancel={() => setPublishing(false)} onDone={onClose} /> : null}
        </div>
      ) : null}
    </Card>
  );
}

function pctText(pct: number | null) {
  if (pct == null) return "—";
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function Signed({ paise }: { paise: number }) {
  return (
    <span className={paise > 0 ? "text-red-700" : paise < 0 ? "text-leaf-700" : ""}>
      {paise > 0 ? "+" : paise < 0 ? "−" : ""}
      <Money paise={Math.abs(paise)} />
    </span>
  );
}

export function SimulationTable({ sim }: { sim: SimulationView }) {
  return (
    <div className="space-y-2 text-sm" data-testid="pay-plan-simulation">
      <p className="text-ink-600">
        Last {sim.days} days ({sim.from} to {sim.to}), run {formatIstDateTime(sim.ranAt)}: {sim.inScope} of {sim.orders} delivered orders are in this plan&apos;s scope.
      </p>
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="Rider cost — current" value={<Money paise={sim.currentTotalPaise} />} />
        <Stat label="Rider cost — this draft" value={<Money paise={sim.draftTotalPaise} />} />
        <Stat label="Average per order" value={<><Money paise={sim.currentAvgPaise} /> → <Money paise={sim.draftAvgPaise} /></>} />
        <Stat label="Change" value={<><Signed paise={sim.changePaise} /> ({pctText(sim.changePct)})</>} />
      </div>
      {sim.byArea.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-500">
              <tr>
                <th className="py-1 pr-3">Area</th>
                <th className="py-1 pr-3 text-right">Orders</th>
                <th className="py-1 pr-3 text-right">Current</th>
                <th className="py-1 pr-3 text-right">Draft</th>
                <th className="py-1 text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {sim.byArea.map((a) => (
                <tr key={a.area} className="border-t border-cream-100">
                  <td className="py-1 pr-3">{a.area}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{a.orders}</td>
                  <td className="py-1 pr-3 text-right"><Money paise={a.currentTotalPaise} /></td>
                  <td className="py-1 pr-3 text-right"><Money paise={a.draftTotalPaise} /></td>
                  <td className="py-1 text-right">{pctText(a.changePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="text-xs text-ink-500">Trip pay only (base, distance, first mile, surge, minimum). Incentives and wait pay are not part of the comparison.</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-cream-200 p-2">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="font-semibold text-ink-900">{value}</p>
    </div>
  );
}

function PublishDialog({ plan, onCancel, onDone }: { plan: PlanRow; onCancel: () => void; onDone: () => void }) {
  const api = useApi();
  const [note, setNote] = useState("");
  const [from, setFrom] = useState("");
  const effectiveFrom = from ? istInputToUtcIso(from) : null;

  async function publish() {
    const res = await api.call(`${API}/${plan.id}/publish`, "POST", { note: note.trim(), effectiveFrom });
    if (res) onDone();
  }

  return (
    <div role="dialog" aria-modal="false" aria-label={`Publish ${plan.label}`} className="space-y-3 rounded-lg border border-kesari-200 bg-kesari-50 p-3" data-testid="pay-plan-publish">
      <p className="text-sm font-semibold text-ink-900">Publish {plan.label}</p>
      <Alert tone="warning">
        This plan applies to <strong>new offers only</strong>. Quotes already locked and earnings already paid never change.
      </Alert>
      <Field label="Why is the pay changing? (required)">
        <textarea className={inputClass} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      <Field label="Effective from (IST, optional)" hint={effectiveFrom ? `Starts ${formatIstDateTime(effectiveFrom)}` : "Blank = straight away."}>
        <input className={inputClass} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      {api.error ? <Alert tone="danger">{api.error}</Alert> : null}
      <div className="flex gap-2">
        <Button disabled={api.busy || note.trim().length < 5} onClick={publish}>
          Publish
        </Button>
        <Button variant="secondary" disabled={api.busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
