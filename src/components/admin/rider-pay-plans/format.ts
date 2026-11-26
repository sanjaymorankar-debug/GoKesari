/**
 * Pure helpers for the Rider pay plans admin screen (client-safe, unit-tested in
 * tests/unit/rider-pay-plans-admin-format.test.ts): IST dates, rupees ↔ paise, km ↔ metres, and
 * the edit form ↔ the plan terms the API takes (paise and metres).
 */
import type { PayPlanTerms, PaySlab } from "@/lib/rider-pay-plan";

const IST_OFFSET_MS = 330 * 60_000; // IST is UTC+05:30 all year (no daylight saving).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "26-Nov-2026 09.30 IST" — the owner's date/time format. Empty input → "—". */
export function formatIstDateTime(at: Date | string | null | undefined): string {
  if (!at) return "—";
  const d = new Date(typeof at === "string" ? at : at.getTime());
  if (Number.isNaN(d.getTime())) return "—";
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${pad(ist.getUTCDate())}-${MONTHS[ist.getUTCMonth()]}-${ist.getUTCFullYear()} ${pad(ist.getUTCHours())}.${pad(ist.getUTCMinutes())} IST`;
}

/** A `<input type="datetime-local">` value read as IST ("2026-11-26T09:30") → UTC ISO string; blank/bad → null. */
export function istInputToUtcIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

/** The IST `datetime-local` value for an instant (the inverse of istInputToUtcIso). */
export function utcToIstInput(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;
}

/** "12.5" / "₹12.50" → 1250 paise; blank or not a non-negative number → null. */
export function rupeesToPaiseOrNull(value: string): number | null {
  const v = value.replace(/[₹,\s]/g, "");
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** "2.5" km → 2500 m; blank or not a non-negative number → null. */
export function kmToMetresOrNull(value: string): number | null {
  const v = value.replace(/[,\s]/g, "");
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
}

export const paiseToRupeesText = (paise: number | null | undefined) => (paise == null ? "" : String(paise / 100));
export const metresToKmText = (m: number | null | undefined) => (m == null ? "" : String(m / 1000));

/** "1.3" → 13000 basis points; blank/bad → null. */
export function multiplierToBp(value: string): number | null {
  const v = value.trim().replace(/^×|^x/i, "");
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10000) : null;
}

/** "1.5, 2 3" → [1.5, 2, 3]; anything that is not a non-negative number is reported. */
export function parseKmList(value: string): { km: number[]; bad: string[] } {
  const parts = value.split(/[,\s]+/).filter(Boolean);
  const km: number[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isFinite(n) && n >= 0) km.push(n);
    else bad.push(p);
  }
  return { km, bad };
}

/* ------------------------------------------------------------------ form */

export type ScopeType = "DEFAULT" | "CITY" | "ZONE";

export interface SlabForm {
  fromKm: string;
  /** Blank = "and above". */
  toKm: string;
  ratePerKm: string;
}

/** The plan as the admin types it: rupees, km and minutes, all as text. */
export interface PlanForm {
  name: string;
  scopeType: ScopeType;
  city: string;
  zoneId: string;
  baseFee: string;
  baseIncludedKm: string;
  slabs: SlabForm[];
  freeFirstMileKm: string;
  firstMileRate: string;
  firstMileCap: string;
  freeWaitMin: string;
  waitRate: string;
  waitCap: string;
  extraDropFee: string;
  /** Blank = no long-distance bonus. */
  longDistanceKm: string;
  longDistanceBonus: string;
  minGuarantee: string;
  /** Blank = no cap. */
  maxPerOrder: string;
  rerouteTolerancePct: string;
  note: string;
}

/** The body POST/PATCH /api/admin/rider-pay-plans[/id] takes. */
export interface PlanBody extends Omit<PayPlanTerms, "id" | "version"> {
  name: string;
  scopeType: ScopeType;
  city: string | null;
  zoneId: string | null;
  note: string | null;
}

export function termsToForm(
  terms: Omit<PayPlanTerms, "id" | "version">,
  meta: { name?: string; scopeType?: ScopeType; city?: string | null; zoneId?: string | null; note?: string | null } = {},
): PlanForm {
  return {
    name: meta.name ?? "",
    scopeType: meta.scopeType ?? "DEFAULT",
    city: meta.city ?? "",
    zoneId: meta.zoneId ?? "",
    baseFee: paiseToRupeesText(terms.baseFeePaise),
    baseIncludedKm: metresToKmText(terms.baseIncludedM),
    slabs: terms.slabs.map((s) => ({ fromKm: metresToKmText(s.fromM), toKm: metresToKmText(s.toM), ratePerKm: paiseToRupeesText(s.ratePaise) })),
    freeFirstMileKm: metresToKmText(terms.freeFirstMileM),
    firstMileRate: paiseToRupeesText(terms.firstMileRatePaise),
    firstMileCap: paiseToRupeesText(terms.firstMileCapPaise),
    freeWaitMin: String(terms.freeWaitMin),
    waitRate: paiseToRupeesText(terms.waitRatePaise),
    waitCap: paiseToRupeesText(terms.waitCapPaise),
    extraDropFee: paiseToRupeesText(terms.extraDropFeePaise),
    longDistanceKm: metresToKmText(terms.longDistanceM),
    longDistanceBonus: paiseToRupeesText(terms.longDistanceBonusPaise),
    minGuarantee: paiseToRupeesText(terms.minGuaranteePaise),
    maxPerOrder: paiseToRupeesText(terms.maxPerOrderPaise),
    rerouteTolerancePct: String(terms.rerouteTolerancePct),
    note: meta.note ?? "",
  };
}

/**
 * The form as API numbers (paise, metres). `errors` lists fields that are not numbers; the plan
 * rules themselves (slab gaps, cap below minimum…) are checked with planProblems on `body`.
 */
export function formToBody(form: PlanForm): { body: PlanBody; errors: string[] } {
  const errors: string[] = [];
  const money = (label: string, value: string, required = true): number => {
    const p = rupeesToPaiseOrNull(value);
    if (p == null && (required || value.trim() !== "")) errors.push(`${label}: enter an amount in rupees.`);
    return p ?? 0;
  };
  const optionalMoney = (label: string, value: string): number | null => (value.trim() === "" ? null : money(label, value));
  const km = (label: string, value: string, required = true): number => {
    const m = kmToMetresOrNull(value);
    if (m == null && (required || value.trim() !== "")) errors.push(`${label}: enter a distance in km.`);
    return m ?? 0;
  };
  const optionalKm = (label: string, value: string): number | null => (value.trim() === "" ? null : km(label, value));
  const whole = (label: string, value: string): number => {
    const n = Number(value.trim());
    if (value.trim() === "" || !Number.isInteger(n) || n < 0) errors.push(`${label}: enter a whole number.`);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };

  const slabs: PaySlab[] = form.slabs.map((s, i) => ({
    fromM: km(`Slab ${i + 1} from`, s.fromKm),
    toM: optionalKm(`Slab ${i + 1} to`, s.toKm),
    ratePaise: money(`Slab ${i + 1} rate`, s.ratePerKm),
  }));

  const body: PlanBody = {
    name: form.name.trim(),
    scopeType: form.scopeType,
    city: form.scopeType === "CITY" ? form.city.trim() || null : null,
    zoneId: form.scopeType === "ZONE" ? form.zoneId || null : null,
    baseFeePaise: money("Base fee", form.baseFee),
    baseIncludedM: km("Base distance", form.baseIncludedKm),
    slabs,
    freeFirstMileM: km("Free first mile", form.freeFirstMileKm),
    firstMileRatePaise: money("First-mile rate", form.firstMileRate),
    firstMileCapPaise: money("First-mile cap", form.firstMileCap),
    freeWaitMin: whole("Free wait minutes", form.freeWaitMin),
    waitRatePaise: money("Wait rate", form.waitRate),
    waitCapPaise: money("Wait cap", form.waitCap),
    extraDropFeePaise: money("Extra-drop fee", form.extraDropFee),
    longDistanceM: optionalKm("Long-distance threshold", form.longDistanceKm),
    longDistanceBonusPaise: money("Long-distance bonus", form.longDistanceBonus, false),
    minGuaranteePaise: money("Minimum guarantee", form.minGuarantee),
    maxPerOrderPaise: optionalMoney("Per-order cap", form.maxPerOrder),
    rerouteTolerancePct: whole("Reroute tolerance", form.rerouteTolerancePct),
    note: form.note.trim() || null,
  };
  if (!body.name) errors.push("Give the plan a name.");
  if (body.scopeType === "CITY" && !body.city) errors.push("Type the city this plan is for.");
  if (body.scopeType === "ZONE" && !body.zoneId) errors.push("Choose the zone this plan is for.");
  return { body, errors };
}

/** A new slab row after the last one: starts where the last ends (or at the base distance). */
export function nextSlab(form: PlanForm): SlabForm {
  const last = form.slabs[form.slabs.length - 1];
  return { fromKm: last ? last.toKm : form.baseIncludedKm, toKm: "", ratePerKm: last?.ratePerKm ?? "" };
}

export type SurgeState = "live" | "scheduled" | "ended";

export function surgeState(s: { startsAt: string; endsAt: string; endedAt: string | null }, now: Date = new Date()): SurgeState {
  if (s.endedAt || new Date(s.endsAt) <= now) return "ended";
  return new Date(s.startsAt) > now ? "scheduled" : "live";
}
