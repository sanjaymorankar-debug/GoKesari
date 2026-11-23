"use client";

/**
 * docs/dealer-platform phase 4: Admin → Dealers → Schemes → a scheme. Edit a draft's terms section by section
 * (charges and GST, commission components, geography and exclusivity, duration and renewal, eligibility, benefits,
 * payment conditions), preview them as applicants see them, simulate the economics with the live calculator's
 * maths, then publish now or schedule a launch. Published versions are read-only: "New version" starts a draft.
 */
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { SchemeTermsPanel } from "@/components/dealer/scheme-terms";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { FORMULA_FUNCTIONS, DEALER_FORMULA_VARIABLES, compileFormula, DEALER_FORMULA_VARIABLE_NAMES } from "@/lib/dealer-formula";
import { simulateScheme, type SimulationInput } from "@/lib/dealer-scheme-math";
import {
  CALCULATION_LABELS,
  CHARGE_KINDS,
  COMPONENT_BASES,
  COMPONENT_FREQUENCIES,
  COMPONENT_KIND_LABELS,
  COMPONENT_KINDS,
  EXCLUSIVITY,
  GEOGRAPHY_SCOPES,
  SHOP_SCOPES,
  BASIS_LABELS,
  CUSTOM_FIELD_TYPES,
  schemeTermsSchema,
  type CustomField,
  type SchemeComponent,
  type SchemeTerms,
} from "@/lib/dealer-schemes";

export interface BuilderVersion {
  id: string;
  version: number;
  status: string;
  label: string | null;
  terms: SchemeTerms;
  termsHash: string;
  changeReason: string | null;
  publishedAt: string | null;
  activeDealers: number;
}

export interface BuilderScheme {
  id: string;
  code: string;
  name: string;
  category: "DEALERSHIP" | "FRANCHISE";
  status: string;
  versions: BuilderVersion[];
}

const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString("en-IN")}`;
const toPaise = (rupeesText: string) => Math.round(Number(rupeesText || "0") * 100);
const toBp = (percentText: string) => Math.round(Number(percentText || "0") * 100);
const lines = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);

export function SchemeBuilder({ scheme, canEdit }: { scheme: BuilderScheme; canEdit: boolean }) {
  const router = useRouter();
  const draft = scheme.versions.find((v) => v.status === "DRAFT") ?? null;
  const current = scheme.versions.find((v) => v.status === "PUBLISHED") ?? null;
  const base = draft ?? current ?? scheme.versions[0];
  // Terms stored before phase 5 have no custom fields / rules: start them empty.
  const [terms, setTerms] = useState<SchemeTerms>(() => {
    const t = structuredClone(base.terms);
    return { ...t, customFields: t.customFields ?? [], eligibilityRules: t.eligibilityRules ?? [] };
  });
  const [label, setLabel] = useState(draft?.label ?? "");
  const [reason, setReason] = useState("");
  const [launchAt, setLaunchAt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ a: string; b: string }>({ a: scheme.versions[1]?.id ?? scheme.versions[0].id, b: scheme.versions[0].id });
  const [diff, setDiff] = useState<{ path: string; from: unknown; to: unknown }[] | null>(null);
  const editing = canEdit && scheme.status !== "ARCHIVED";
  const validation = useMemo(() => schemeTermsSchema.safeParse(terms), [terms]);

  async function post(body: Record<string, unknown>, tag: string, done: string) {
    setBusy(tag);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/dealer-schemes/${scheme.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(done);
      router.refresh();
      return payload;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const set = <K extends keyof SchemeTerms>(k: K, v: SchemeTerms[K]) => setTerms((t) => ({ ...t, [k]: v }));
  const setComp = (i: number, patch: Partial<SchemeComponent>) => setTerms((t) => ({ ...t, components: t.components.map((c, j) => (j === i ? ({ ...c, ...patch } as SchemeComponent) : c)) }));

  return (
    <div className="space-y-4" data-testid="scheme-builder">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-ink-900">Versions</h2>
          <Badge tone={scheme.status === "PUBLISHED" ? "success" : scheme.status === "SUSPENDED" ? "warning" : "neutral"}>{scheme.status.toLowerCase()}</Badge>
        </div>
        <ul className="space-y-1 text-sm">
          {scheme.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">v{v.version}</span>
              <Badge tone={v.status === "PUBLISHED" ? "success" : v.status === "DRAFT" ? "info" : "neutral"}>{v.status.toLowerCase()}</Badge>
              <span className="text-ink-600">{v.label}</span>
              <span className="text-ink-600">· {v.activeDealers} dealers</span>
            </li>
          ))}
        </ul>
        {scheme.versions.length > 1 ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Compare">
              <select className={inputClass} value={compare.a} onChange={(e) => setCompare((c) => ({ ...c, a: e.target.value }))}>
                {scheme.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="with">
              <select className={inputClass} value={compare.b} onChange={(e) => setCompare((c) => ({ ...c, b: e.target.value }))}>
                {scheme.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </Field>
            <Button variant="secondary" disabled={busy !== null} onClick={async () => setDiff((await post({ action: "compare", a: compare.a, b: compare.b }, "compare", "Compared."))?.differences ?? null)}>
              Compare versions
            </Button>
          </div>
        ) : null}
        {diff ? (
          diff.length ? (
            <table className="w-full text-left text-xs" data-testid="scheme-diff">
              <thead>
                <tr>
                  <th className="p-1">Field</th>
                  <th className="p-1">Before</th>
                  <th className="p-1">After</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((d) => (
                  <tr key={d.path} className="border-t border-cream-200 align-top">
                    <td className="break-all p-1 font-mono">{d.path}</td>
                    <td className="break-all p-1">{JSON.stringify(d.from)}</td>
                    <td className="break-all p-1">{JSON.stringify(d.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-ink-600">The two versions have the same terms.</p>
          )
        ) : null}
      </Card>

      {editing ? (
        <Card className="space-y-4 p-4" data-testid="scheme-editor">
          <h2 className="text-lg font-semibold text-ink-900">{draft ? `Edit draft v${draft.version}` : `New version (from v${base.version})`}</h2>

          <section className="space-y-2">
            <h3 className="font-semibold">1–2. Basic information</h3>
            <Field label="Version label">
              <input className={inputClass} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Diwali 2026 offer" />
            </Field>
            <Field label="Summary shown to applicants">
              <textarea className={inputClass} rows={3} maxLength={1000} value={terms.summary} onChange={(e) => set("summary", e.target.value)} />
            </Field>
            <Field label="Calculated by">
              <select className={inputClass} value={terms.calculation} onChange={(e) => set("calculation", e.target.value as SchemeTerms["calculation"])}>
                {Object.entries(CALCULATION_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          </section>

          <section className="grid gap-2 sm:grid-cols-2">
            <h3 className="font-semibold sm:col-span-2">3–4. Joining charge and GST</h3>
            <Field label="Charge">
              <select className={inputClass} value={terms.charge.kind} onChange={(e) => set("charge", { ...terms.charge, kind: e.target.value as SchemeTerms["charge"]["kind"], ...(e.target.value === "FREE" ? { amountPaise: 0, gstRateBp: 0 } : {}) })}>
                {CHARGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.toLowerCase().replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount (₹)">
              <input className={inputClass} inputMode="decimal" disabled={terms.charge.kind === "FREE"} value={terms.charge.amountPaise / 100} onChange={(e) => set("charge", { ...terms.charge, amountPaise: toPaise(e.target.value) })} />
            </Field>
            <Field label="GST %">
              <input className={inputClass} inputMode="decimal" value={terms.charge.gstRateBp / 100} onChange={(e) => set("charge", { ...terms.charge, gstRateBp: toBp(e.target.value) })} />
            </Field>
            <Field label="GST">
              <select className={inputClass} value={terms.charge.gstMode} onChange={(e) => set("charge", { ...terms.charge, gstMode: e.target.value as "EXCLUSIVE" | "INCLUSIVE" })}>
                <option value="EXCLUSIVE">added on top</option>
                <option value="INCLUSIVE">included in the amount</option>
              </select>
            </Field>
            {terms.charge.kind === "INSTALMENTS" ? (
              <>
                <Field label="Instalments">
                  <input className={inputClass} inputMode="numeric" value={terms.charge.instalments?.count ?? 2} onChange={(e) => set("charge", { ...terms.charge, instalments: { count: Number(e.target.value) || 2, intervalMonths: terms.charge.instalments?.intervalMonths ?? 1 } })} />
                </Field>
                <Field label="Months between instalments">
                  <input className={inputClass} inputMode="numeric" value={terms.charge.instalments?.intervalMonths ?? 1} onChange={(e) => set("charge", { ...terms.charge, instalments: { count: terms.charge.instalments?.count ?? 2, intervalMonths: Number(e.target.value) || 1 } })} />
                </Field>
              </>
            ) : null}
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={terms.charge.refundable} onChange={(e) => set("charge", { ...terms.charge, refundable: e.target.checked })} /> Refundable
            </label>
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold">5–9. Commission (one-time, recurring, team, referral, incentives)</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={terms.teamBuilding} onChange={(e) => set("teamBuilding", e.target.checked)} /> Team building allowed
              </label>
              <Field label="Commission budget per shop (% of fee, empty = none)">
                <input className={inputClass} inputMode="decimal" value={terms.commissionBudgetBp === null ? "" : terms.commissionBudgetBp / 100} onChange={(e) => set("commissionBudgetBp", e.target.value === "" ? null : toBp(e.target.value))} />
              </Field>
            </div>
            {terms.components.map((c, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-cream-200 p-3 sm:grid-cols-3" data-testid={`component-${i}`}>
                <Field label="Name">
                  <input className={inputClass} value={c.label} maxLength={160} onChange={(e) => setComp(i, { label: e.target.value })} />
                </Field>
                <Field label="Id">
                  <input className={inputClass} value={c.id} maxLength={40} onChange={(e) => setComp(i, { id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
                </Field>
                <Field label="Type">
                  <select className={inputClass} value={c.kind} onChange={(e) => setComp(i, { kind: e.target.value as SchemeComponent["kind"], frequency: e.target.value === "ONE_TIME" || e.target.value === "TEAM_OVERRIDE" ? "ONCE" : c.frequency === "ONCE" ? "MONTHLY" : c.frequency })}>
                    {COMPONENT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {COMPONENT_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Based on">
                  <select className={inputClass} value={c.basis} onChange={(e) => setComp(i, { basis: e.target.value as SchemeComponent["basis"] })}>
                    {COMPONENT_BASES.map((b) => (
                      <option key={b} value={b}>
                        {BASIS_LABELS[b]}
                      </option>
                    ))}
                  </select>
                </Field>
                {c.basis === "FIXED_PER_SHOP" ? (
                  <Field label="Amount per shop (₹)">
                    <input className={inputClass} inputMode="decimal" value={(c.fixedPaise ?? 0) / 100} onChange={(e) => setComp(i, { fixedPaise: toPaise(e.target.value) })} />
                  </Field>
                ) : c.basis === "FORMULA" ? (
                  <Field label="Formula (result in paise)">
                    <input className={`${inputClass} font-mono`} value={c.formula ?? ""} maxLength={1000} onChange={(e) => setComp(i, { formula: e.target.value })} />
                  </Field>
                ) : c.basis !== "LEGACY" ? (
                  <Field label="Rate %">
                    <input className={inputClass} inputMode="decimal" value={(c.rateBp ?? 0) / 100} onChange={(e) => setComp(i, { rateBp: toBp(e.target.value) })} />
                  </Field>
                ) : null}
                <Field label="Paid">
                  <select className={inputClass} value={c.frequency} onChange={(e) => setComp(i, { frequency: e.target.value as SchemeComponent["frequency"] })}>
                    {COMPONENT_FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {f.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Shops">
                  <select className={inputClass} value={c.shopScope} onChange={(e) => setComp(i, { shopScope: e.target.value as SchemeComponent["shopScope"] })}>
                    {SHOP_SCOPES.map((s) => (
                      <option key={s} value={s}>
                        {s.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </Field>
                {c.kind === "TEAM_OVERRIDE" ? (
                  <Field label="Team level (1 = one level up)">
                    <input className={inputClass} inputMode="numeric" value={c.level ?? 1} onChange={(e) => setComp(i, { level: Number(e.target.value) || 1 })} />
                  </Field>
                ) : null}
                <Field label="For how many months (empty = while on the scheme)">
                  <input className={inputClass} inputMode="numeric" value={c.durationMonths ?? ""} onChange={(e) => setComp(i, { durationMonths: e.target.value === "" ? null : Number(e.target.value) })} />
                </Field>
                {c.kind === "TARGET_BONUS" ? (
                  <Field label="Target: shops per month">
                    <input className={inputClass} inputMode="numeric" value={c.target?.minShops ?? 50} onChange={(e) => setComp(i, { target: { minShops: Number(e.target.value) || 1, period: "MONTH" } })} />
                  </Field>
                ) : null}
                <div className="sm:col-span-3">
                  <Button variant="secondary" onClick={() => setTerms((t) => ({ ...t, components: t.components.filter((_, j) => j !== i) }))}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="secondary"
              disabled={terms.components.length >= 30}
              onClick={() => setTerms((t) => ({ ...t, components: [...t.components, { id: `c${t.components.length + 1}`, label: "New commission", kind: "RECURRING", basis: "PLATFORM_COMMISSION", rateBp: 500, frequency: "MONTHLY", shopScope: "OWN", durationMonths: 12 }] }))}
            >
              Add a commission
            </Button>
            <details className="text-xs text-ink-600">
              <summary className="min-h-11 cursor-pointer">Formula help</summary>
              <p>Variables: {DEALER_FORMULA_VARIABLES.map((v) => `${v.name} (${v.description})`).join("; ")}.</p>
              <p>Functions: {FORMULA_FUNCTIONS.map((f) => f.signature).join(", ")}. Operators + − × ÷, comparisons, and / or / not.</p>
              {terms.components
                .filter((c) => c.basis === "FORMULA")
                .map((c) => {
                  const r = compileFormula(c.formula ?? "", DEALER_FORMULA_VARIABLE_NAMES);
                  return (
                    <p key={c.id} className={r.ok ? "text-leaf-700" : "text-red-700"}>
                      {c.label}: {r.ok ? "formula is valid" : r.error}
                    </p>
                  );
                })}
            </details>
          </section>

          <section className="grid gap-2 sm:grid-cols-2">
            <h3 className="font-semibold sm:col-span-2">10–12. Geography, exclusivity and territory</h3>
            <Field label="Where">
              <select className={inputClass} value={terms.geography.scope} onChange={(e) => set("geography", { ...terms.geography, scope: e.target.value as SchemeTerms["geography"]["scope"] })}>
                {GEOGRAPHY_SCOPES.map((g) => (
                  <option key={g} value={g}>
                    {g.toLowerCase().replace("_", " ")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Area codes (comma separated, e.g. MH, MH-PUN)">
              <input className={inputClass} value={terms.geography.codes.join(", ")} onChange={(e) => set("geography", { ...terms.geography, codes: e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) })} />
            </Field>
            <Field label="Exclusivity">
              <select className={inputClass} value={terms.exclusivity} onChange={(e) => set("exclusivity", e.target.value as SchemeTerms["exclusivity"])}>
                {EXCLUSIVITY.map((x) => (
                  <option key={x} value={x}>
                    {x.toLowerCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Dealers per territory (empty = no limit)">
              <input className={inputClass} inputMode="numeric" value={terms.maxDealersPerTerritory ?? ""} onChange={(e) => set("maxDealersPerTerritory", e.target.value === "" ? null : Number(e.target.value))} />
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={terms.territoryBooking} onChange={(e) => set("territoryBooking", e.target.checked)} /> Territory booked on the franchise zone map
            </label>
          </section>

          <section className="grid gap-2 sm:grid-cols-3">
            <h3 className="font-semibold sm:col-span-3">13–14. Duration and renewal</h3>
            <Field label="Valid for (months, empty = no end)">
              <input className={inputClass} inputMode="numeric" value={terms.validityMonths ?? ""} onChange={(e) => set("validityMonths", e.target.value === "" ? null : Number(e.target.value))} />
            </Field>
            <Field label="Renewal charge (₹, empty = current charge)">
              <input className={inputClass} inputMode="decimal" value={terms.renewal.chargePaise === null ? "" : terms.renewal.chargePaise / 100} onChange={(e) => set("renewal", { ...terms.renewal, chargePaise: e.target.value === "" ? null : toPaise(e.target.value) })} />
            </Field>
            <Field label="Renewal window (days before expiry)">
              <input className={inputClass} inputMode="numeric" value={terms.renewal.windowDays} onChange={(e) => set("renewal", { ...terms.renewal, windowDays: Number(e.target.value) || 0 })} />
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={terms.renewal.allowed} onChange={(e) => set("renewal", { ...terms.renewal, allowed: e.target.checked })} /> Renewable
            </label>
          </section>

          <section className="grid gap-2 sm:grid-cols-3">
            <h3 className="font-semibold sm:col-span-3">15, 17–19. Eligibility, benefits, payment conditions</h3>
            <Field label="Eligibility (one per line)">
              <textarea className={inputClass} rows={4} value={terms.eligibility.join("\n")} onChange={(e) => set("eligibility", lines(e.target.value))} />
            </Field>
            <Field label="Benefits (one per line)">
              <textarea className={inputClass} rows={4} value={terms.benefits.join("\n")} onChange={(e) => set("benefits", lines(e.target.value))} />
            </Field>
            <Field label="Payment conditions (one per line)">
              <textarea className={inputClass} rows={4} value={terms.paymentConditions.join("\n")} onChange={(e) => set("paymentConditions", lines(e.target.value))} />
            </Field>
          </section>

          <section className="space-y-2" data-testid="scheme-custom-fields">
            <h3 className="font-semibold">16. Custom fields and eligibility rules</h3>
            <p className="text-xs text-ink-600">Fields are asked on the application when “application” is ticked. Number, amount, %, yes/no, checkbox and formula fields can be used in formulas as cf_key (amounts in paise, % in basis points, yes = 1).</p>
            {terms.customFields.map((f, i) => {
              const setF = (patch: Partial<CustomField>) => set("customFields", terms.customFields.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <div key={i} className="grid gap-2 rounded-lg border border-cream-200 p-3 sm:grid-cols-3">
                  <Field label="Question / label">
                    <input className={inputClass} value={f.label} maxLength={120} onChange={(e) => setF({ label: e.target.value })} />
                  </Field>
                  <Field label="Key (cf_key in formulas)">
                    <input className={inputClass} value={f.key} maxLength={30} onChange={(e) => setF({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
                  </Field>
                  <Field label="Type">
                    <select className={inputClass} value={f.type} onChange={(e) => setF({ type: e.target.value as CustomField["type"] })}>
                      {CUSTOM_FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t.toLowerCase().replace("_", " ")}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {f.type === "DROPDOWN" || f.type === "MULTI_SELECT" ? (
                    <Field label="Choices (comma separated)">
                      <input className={inputClass} value={(f.options ?? []).join(", ")} onChange={(e) => setF({ options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
                    </Field>
                  ) : null}
                  {f.type === "FORMULA" ? (
                    <Field label="Formula">
                      <input className={`${inputClass} font-mono`} value={f.formula ?? ""} maxLength={1000} onChange={(e) => setF({ formula: e.target.value })} />
                    </Field>
                  ) : null}
                  <Field label="Show only when field (key) equals">
                    <div className="flex gap-1">
                      <input className={inputClass} placeholder="key" value={f.showWhen?.field ?? ""} onChange={(e) => setF({ showWhen: e.target.value ? { field: e.target.value, equals: f.showWhen?.equals ?? "" } : undefined })} />
                      <input className={inputClass} placeholder="value" value={String(f.showWhen?.equals ?? "")} onChange={(e) => f.showWhen && setF({ showWhen: { field: f.showWhen.field, equals: e.target.value } })} />
                    </div>
                  </Field>
                  <Field label="Help text">
                    <input className={inputClass} value={f.help ?? ""} maxLength={300} onChange={(e) => setF({ help: e.target.value || undefined })} />
                  </Field>
                  <div className="flex flex-wrap items-center gap-3 text-sm sm:col-span-3">
                    <label className="flex min-h-11 items-center gap-1"><input type="checkbox" checked={f.required} onChange={(e) => setF({ required: e.target.checked })} /> required</label>
                    {(["registration", "eligibility", "calculation", "reports"] as const).map((k) => (
                      <label key={k} className="flex min-h-11 items-center gap-1">
                        <input type="checkbox" checked={f.useIn[k]} onChange={(e) => setF({ useIn: { ...f.useIn, [k]: e.target.checked } })} /> {k === "registration" ? "application" : k}
                      </label>
                    ))}
                    <Button variant="secondary" onClick={() => set("customFields", terms.customFields.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                </div>
              );
            })}
            <Button
              variant="secondary"
              disabled={terms.customFields.length >= 40}
              onClick={() => set("customFields", [...terms.customFields, { key: `field_${terms.customFields.length + 1}`, label: "New question", type: "TEXT", required: false, useIn: { registration: true, eligibility: false, calculation: false, reports: true } }])}
            >
              Add a field
            </Button>
            <h4 className="pt-2 font-semibold">Eligibility rules (checked on submit)</h4>
            {terms.eligibilityRules.map((r, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[2fr_2fr_auto]">
                <input className={`${inputClass} font-mono`} aria-label="Rule formula" value={r.formula} placeholder="cf_years_in_business >= 2" onChange={(e) => set("eligibilityRules", terms.eligibilityRules.map((x, j) => (j === i ? { ...x, formula: e.target.value } : x)))} />
                <input className={inputClass} aria-label="Message when not met" value={r.message} placeholder="At least 2 years in business." onChange={(e) => set("eligibilityRules", terms.eligibilityRules.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))} />
                <Button variant="secondary" onClick={() => set("eligibilityRules", terms.eligibilityRules.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="secondary" disabled={terms.eligibilityRules.length >= 20} onClick={() => set("eligibilityRules", [...terms.eligibilityRules, { formula: "1", message: "Describe the condition." }])}>
              Add a rule
            </Button>
          </section>

          {!validation.success ? (
            <Alert tone="warning" title="Not complete yet">
              <ul className="ml-4 list-disc">
                {validation.error.issues.slice(0, 8).map((i, n) => (
                  <li key={n}>
                    {i.path.join(".") || "terms"}: {i.message}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <section className="space-y-2">
            <h3 className="font-semibold">20. Save and publish</h3>
            <Field label="Reason for this change (kept in the audit log)">
              <input className={inputClass} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy !== null || !validation.success || reason.trim().length < 5} onClick={() => post({ action: "saveDraft", versionId: draft?.id ?? null, terms, label: label || null, reason }, "save", draft ? "Draft saved." : "New draft version saved.")}>
                {busy === "save" ? "Saving…" : draft ? "Save draft" : "Save as new version"}
              </Button>
              {draft ? (
                <>
                  <Button variant="secondary" disabled={busy !== null || reason.trim().length < 5} onClick={() => post({ action: "publish", versionId: draft.id, reason }, "publish", "Published. New applicants get this version; dealers on earlier versions keep theirs.")}>
                    Publish now
                  </Button>
                  <input type="datetime-local" className={`${inputClass} w-auto`} aria-label="Launch at" value={launchAt} onChange={(e) => setLaunchAt(e.target.value)} />
                  <Button variant="secondary" disabled={busy !== null || !launchAt || reason.trim().length < 5} onClick={() => post({ action: "publish", versionId: draft.id, effectiveFrom: new Date(launchAt).toISOString(), reason }, "schedule", "Launch scheduled.")}>
                    Schedule launch
                  </Button>
                  <Button variant="secondary" disabled={busy !== null || reason.trim().length < 5} onClick={() => post({ action: "deleteDraft", versionId: draft.id, reason }, "delete", "Draft deleted.")}>
                    Delete draft
                  </Button>
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 border-t border-cream-200 pt-2">
              {(["SUSPENDED", "PUBLISHED", "EXPIRED", "ARCHIVED"] as const).map((to) => (
                <Button key={to} variant="secondary" disabled={busy !== null || reason.trim().length < 5 || scheme.status === to} onClick={() => post({ action: "status", to, reason }, `status-${to}`, `Scheme ${to.toLowerCase()}.`)}>
                  {to === "SUSPENDED" ? "Suspend (no new dealers)" : to === "PUBLISHED" ? "Reopen" : to === "EXPIRED" ? "Expire" : "Archive"}
                </Button>
              ))}
            </div>
          </section>
        </Card>
      ) : null}

      <Card className="space-y-2 p-4" data-testid="scheme-preview">
        <h2 className="text-lg font-semibold text-ink-900">Preview (as applicants see it)</h2>
        {validation.success ? <SchemeTermsPanel terms={validation.data} /> : <p className="text-sm text-ink-600">Complete the terms to see the preview.</p>}
      </Card>

      {validation.success ? <Simulator terms={validation.data} /> : null}
    </div>
  );
}

function Simulator({ terms }: { terms: SchemeTerms }) {
  const [input, setInput] = useState<SimulationInput>({ dealers: 10, shopsPerDealerPerMonth: 5, activationBp: 8000, avgRegistrationFeePaise: 100_000, monthlySalesPerShopPaise: 5_000_000, platformCommissionBp: 200, months: 12 });
  const result = useMemo(() => simulateScheme(terms, input), [terms, input]);
  const num = (k: keyof SimulationInput, scale = 1) => ({
    value: input[k] / scale,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setInput((x) => ({ ...x, [k]: Math.max(0, Math.round(Number(e.target.value || "0") * scale)) })),
  });
  const rows: [string, number][] = [
    ["Dealers' joining charges (before GST)", result.totals.joiningFeesPaise],
    ["Shop registration fees", result.totals.registrationFeesPaise],
    ["Sales through GoKesari (GMV)", result.totals.gmvPaise],
    ["GoKesari commission on sales", result.totals.platformCommissionPaise],
    ["Platform revenue (charges + fees + commission)", result.totals.platformRevenuePaise],
    ["Dealer one-time commission", result.totals.oneTimePayoutPaise],
    ["Dealer monthly commission", result.totals.recurringPayoutPaise],
    ["Total dealer payout (liability)", result.totals.dealerPayoutPaise],
    ["GoKesari net revenue before other costs", result.totals.netRevenuePaise],
  ];
  return (
    <Card className="space-y-3 p-4" data-testid="scheme-simulator">
      <h2 className="text-lg font-semibold text-ink-900">Simulator</h2>
      <p className="text-xs text-ink-600">Uses the same calculation as the live commission. GMV is sales, not GoKesari revenue; GST is left out. Shops are assumed signed by the dealer himself.</p>
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Dealers">
          <input className={inputClass} inputMode="numeric" {...num("dealers")} />
        </Field>
        <Field label="Shops per dealer per month">
          <input className={inputClass} inputMode="decimal" {...num("shopsPerDealerPerMonth")} />
        </Field>
        <Field label="Shops activated %">
          <input className={inputClass} inputMode="decimal" {...num("activationBp", 100)} />
        </Field>
        <Field label="Shop registration fee (₹)">
          <input className={inputClass} inputMode="decimal" {...num("avgRegistrationFeePaise", 100)} />
        </Field>
        <Field label="Sales per shop per month (₹)">
          <input className={inputClass} inputMode="decimal" {...num("monthlySalesPerShopPaise", 100)} />
        </Field>
        <Field label="GoKesari commission on sales %">
          <input className={inputClass} inputMode="decimal" {...num("platformCommissionBp", 100)} />
        </Field>
        <Field label="Months">
          <input className={inputClass} inputMode="numeric" {...num("months")} />
        </Field>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-cream-200">
              <td className="py-1">{k}</td>
              <td className="py-1 text-right font-semibold">{rupees(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm text-ink-700">
        First 12 months: revenue {rupees(result.firstYear.platformRevenuePaise)}, dealer payout {rupees(result.firstYear.dealerPayoutPaise)}, net {rupees(result.firstYear.netRevenuePaise)}. Last month: {result.months.at(-1)?.activeShops ?? 0} active shops,
        net {rupees(result.months.at(-1)?.netRevenuePaise ?? 0)} a month.
      </p>
    </Card>
  );
}
