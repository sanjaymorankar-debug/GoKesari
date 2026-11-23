/**
 * Dealership & Franchise Platform (owner brief 23-Nov-2026; docs/dealer-platform/): what a scheme's terms look like.
 *
 * A scheme (Free Dealership, Business Partner, Growth Partner, Territory Franchise, or one the admin adds) has
 * versions; each version's terms are one JSON document validated here and stored in dealer_scheme_versions.terms.
 * Amounts are in paise, rates in basis points (2000 = 20%). A published version never changes (database trigger);
 * a change is a new version. Each dealer's assignment keeps a copy of the terms he is on.
 *
 * Phase 1 records terms only. `calculation` says who computes the commission: LEGACY_DEALER / LEGACY_FRANCHISE —
 * the existing code (Dealer commission, Franchise settings); SCHEME — the scheme calculator (phase 3).
 */
import { z } from "zod";

import { compileFormula, DEALER_FORMULA_VARIABLE_NAMES } from "@/lib/dealer-formula";

export const SCHEME_CATEGORIES = ["DEALERSHIP", "FRANCHISE"] as const;
export const SCHEME_STATUSES = ["DRAFT", "SCHEDULED", "PUBLISHED", "SUSPENDED", "EXPIRED", "ARCHIVED"] as const;
export const SCHEME_VERSION_STATUSES = ["DRAFT", "PUBLISHED", "SUPERSEDED", "WITHDRAWN"] as const;
export const SCHEME_ASSIGNMENT_STATUSES = ["ACTIVE", "SUPERSEDED", "ENDED"] as const;
export const SCHEME_ASSIGNMENT_SOURCES = ["MIGRATION", "AUTO", "REGISTRATION", "FRANCHISE_BOOKING", "FRANCHISE_ENDED", "UPGRADE", "DOWNGRADE", "ADMIN"] as const;

export const CALCULATION_MODES = ["LEGACY_DEALER", "LEGACY_FRANCHISE", "SCHEME"] as const;
export const CHARGE_KINDS = ["FREE", "ONE_TIME", "MONTHLY", "QUARTERLY", "ANNUAL", "INSTALMENTS", "REFUNDABLE_DEPOSIT", "CUSTOM"] as const;
export const GST_MODES = ["EXCLUSIVE", "INCLUSIVE"] as const;
export const GEOGRAPHY_SCOPES = ["ALL_INDIA", "STATE", "DISTRICT", "CITY", "ZONE", "CUSTOM"] as const;
export const EXCLUSIVITY = ["NONE", "SHARED", "EXCLUSIVE"] as const;
export const COMPONENT_KINDS = ["ONE_TIME", "RECURRING", "TEAM_OVERRIDE", "REFERRAL", "TARGET_BONUS", "RENEWAL", "DEVELOPMENT", "PERFORMANCE_BONUS"] as const;
export const COMPONENT_BASES = [
  "SHOP_REGISTRATION_FEE",
  "SHOP_ACTIVATION_FEE",
  "PLATFORM_COMMISSION",
  "TRANSACTION_VALUE",
  "NET_TRANSACTION_VALUE",
  "FIXED_PER_SHOP",
  "FORMULA",
  "LEGACY",
] as const;
export const COMPONENT_FREQUENCIES = ["ONCE", "MONTHLY", "QUARTERLY", "ANNUAL"] as const;
export const SHOP_SCOPES = ["OWN", "TEAM", "ALL"] as const;

/** Phase 5: custom fields an admin adds to a scheme (shown on the application, used in rules and formulas). */
export const CUSTOM_FIELD_TYPES = ["TEXT", "NUMBER", "CURRENCY", "PERCENT", "DATE", "DROPDOWN", "MULTI_SELECT", "CHECKBOX", "YES_NO", "FORMULA", "FILE"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
/** Types whose value is a number in formulas (CURRENCY in paise, PERCENT in basis points, CHECKBOX / YES_NO 1 or 0). */
export const NUMERIC_FIELD_TYPES: readonly CustomFieldType[] = ["NUMBER", "CURRENCY", "PERCENT", "CHECKBOX", "YES_NO", "FORMULA"];
/** A custom field's name in formulas: cf_<key>. */
export const fieldVariable = (key: string) => `cf_${key}`;

export type SchemeCategory = (typeof SCHEME_CATEGORIES)[number];
export type SchemeStatus = (typeof SCHEME_STATUSES)[number];
export type SchemeVersionStatus = (typeof SCHEME_VERSION_STATUSES)[number];
export type SchemeAssignmentStatus = (typeof SCHEME_ASSIGNMENT_STATUSES)[number];
export type SchemeAssignmentSource = (typeof SCHEME_ASSIGNMENT_SOURCES)[number];

const bp = z.number().int().min(0).max(10_000);
const paise = z.number().int().min(0).max(1_000_000_000);
const text = (max: number) => z.string().trim().max(max);

export const schemeChargeSchema = z
  .object({
    kind: z.enum(CHARGE_KINDS),
    amountPaise: paise,
    gstRateBp: z.number().int().min(0).max(2800),
    gstMode: z.enum(GST_MODES),
    refundable: z.boolean(),
    instalments: z.object({ count: z.number().int().min(2).max(24), intervalMonths: z.number().int().min(1).max(12) }).optional(),
    note: text(300).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.kind === "FREE" && c.amountPaise !== 0) ctx.addIssue({ code: "custom", path: ["amountPaise"], message: "A free scheme has no charge." });
    if (c.kind !== "FREE" && c.amountPaise === 0) ctx.addIssue({ code: "custom", path: ["amountPaise"], message: "Enter the charge, or choose Free." });
    if (c.kind === "INSTALMENTS" && !c.instalments) ctx.addIssue({ code: "custom", path: ["instalments"], message: "Give the number of instalments and the gap between them." });
  });

export const schemeComponentSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Lower-case letters, digits and dashes."),
    label: text(160).min(2),
    kind: z.enum(COMPONENT_KINDS),
    basis: z.enum(COMPONENT_BASES),
    rateBp: bp.optional(),
    fixedPaise: paise.optional(),
    formula: text(1000).optional(),
    frequency: z.enum(COMPONENT_FREQUENCIES),
    shopScope: z.enum(SHOP_SCOPES),
    /** TEAM_OVERRIDE: 1 = one level down, 2 = two levels down. */
    level: z.number().int().min(1).max(5).optional(),
    /** How long it is paid, from the shop's activation; null = while the dealer is on the scheme. */
    durationMonths: z.number().int().min(1).max(120).nullable(),
    target: z.object({ minShops: z.number().int().min(1).max(100_000), period: z.enum(["MONTH", "QUARTER", "YEAR"]) }).optional(),
  })
  .superRefine((c, ctx) => {
    const percent = c.basis !== "FIXED_PER_SHOP" && c.basis !== "FORMULA" && c.basis !== "LEGACY";
    if (percent && c.rateBp === undefined) ctx.addIssue({ code: "custom", path: ["rateBp"], message: "Enter the percentage." });
    if (c.basis === "FIXED_PER_SHOP" && c.fixedPaise === undefined) ctx.addIssue({ code: "custom", path: ["fixedPaise"], message: "Enter the amount per shop." });
    if (c.basis === "FORMULA" && !c.formula) ctx.addIssue({ code: "custom", path: ["formula"], message: "Enter the formula." });
    if (c.kind === "TEAM_OVERRIDE" && !c.level) ctx.addIssue({ code: "custom", path: ["level"], message: "Which team level does this pay on?" });
    if (c.kind === "ONE_TIME" && c.frequency !== "ONCE") ctx.addIssue({ code: "custom", path: ["frequency"], message: "A one-time commission is paid once." });
    if (c.kind === "RECURRING" && c.frequency === "ONCE") ctx.addIssue({ code: "custom", path: ["frequency"], message: "A recurring commission needs a period." });
    if (c.kind === "TARGET_BONUS" && !c.target) ctx.addIssue({ code: "custom", path: ["target"], message: "Give the target." });
  });

export const customFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, "Lower-case letters, digits and _, starting with a letter."),
  label: text(120).min(2),
  type: z.enum(CUSTOM_FIELD_TYPES),
  required: z.boolean(),
  help: text(300).optional(),
  options: z.array(text(80).min(1)).max(50).optional(),
  /** FORMULA fields: computed from other fields (and dealer variables), never typed in. */
  formula: text(1000).optional(),
  /** Shown only when another (earlier) field has this value. */
  showWhen: z.object({ field: z.string(), equals: z.union([z.string(), z.number(), z.boolean()]) }).optional(),
  /** Where the field is used; registration = asked on the application. */
  useIn: z.object({ registration: z.boolean(), eligibility: z.boolean(), calculation: z.boolean(), reports: z.boolean() }),
});
export type CustomField = z.infer<typeof customFieldSchema>;

export const eligibilityRuleSchema = z.object({
  /** True (non-zero) = eligible. Uses custom fields as cf_<key>. */
  formula: text(1000).min(1),
  message: text(300).min(3),
});
export type EligibilityRule = z.infer<typeof eligibilityRuleSchema>;

/** Variables a formula in these terms may use: the dealer variables plus numeric custom fields. */
export function formulaVariablesFor(fields: readonly CustomField[]): string[] {
  return [...DEALER_FORMULA_VARIABLE_NAMES, ...fields.filter((f) => NUMERIC_FIELD_TYPES.includes(f.type)).map((f) => fieldVariable(f.key))];
}

export const schemeTermsSchema = z
  .object({
    summary: text(1000).min(10),
    calculation: z.enum(CALCULATION_MODES),
    charge: schemeChargeSchema,
    /** Months from approval; null = no end date. */
    validityMonths: z.number().int().min(1).max(120).nullable(),
    renewal: z.object({ allowed: z.boolean(), chargePaise: paise.nullable(), windowDays: z.number().int().min(0).max(365) }),
    geography: z.object({ scope: z.enum(GEOGRAPHY_SCOPES), codes: z.array(text(40)).max(500) }),
    exclusivity: z.enum(EXCLUSIVITY),
    maxDealersPerTerritory: z.number().int().min(1).max(1000).nullable(),
    territoryBooking: z.boolean(),
    teamBuilding: z.boolean(),
    /** Most that all components together may pay on one shop's registration fee; null = no limit. */
    commissionBudgetBp: bp.nullable(),
    components: z.array(schemeComponentSchema).max(30),
    benefits: z.array(text(200)).max(20),
    eligibility: z.array(text(300)).max(20),
    paymentConditions: z.array(text(300)).max(20),
    customFields: z.array(customFieldSchema).max(40).default([]),
    eligibilityRules: z.array(eligibilityRuleSchema).max(20).default([]),
  })
  .superRefine((t, ctx) => {
    const keys = new Set<string>();
    const vars = formulaVariablesFor(t.customFields);
    t.customFields.forEach((f, i) => {
      if (keys.has(f.key)) ctx.addIssue({ code: "custom", path: ["customFields", i, "key"], message: "Each field needs its own key." });
      if ((f.type === "DROPDOWN" || f.type === "MULTI_SELECT") && !(f.options?.length)) ctx.addIssue({ code: "custom", path: ["customFields", i, "options"], message: "Give the choices." });
      if (f.type === "FORMULA") {
        const r = compileFormula(f.formula ?? "", vars.filter((v) => v !== fieldVariable(f.key)));
        if (!r.ok) ctx.addIssue({ code: "custom", path: ["customFields", i, "formula"], message: r.error });
      }
      if (f.showWhen && !keys.has(f.showWhen.field)) ctx.addIssue({ code: "custom", path: ["customFields", i, "showWhen"], message: "It can only depend on a field above it." });
      keys.add(f.key);
    });
    t.eligibilityRules.forEach((r, i) => {
      const c = compileFormula(r.formula, vars);
      if (!c.ok) ctx.addIssue({ code: "custom", path: ["eligibilityRules", i, "formula"], message: c.error });
    });
    t.components.forEach((c, i) => {
      if (c.basis !== "FORMULA" || !c.formula) return;
      const r = compileFormula(c.formula, vars);
      if (!r.ok) ctx.addIssue({ code: "custom", path: ["components", i, "formula"], message: r.error });
    });
    const ids = new Set<string>();
    t.components.forEach((c, i) => {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", path: ["components", i, "id"], message: "Each component needs its own id." });
      ids.add(c.id);
      if (c.kind === "TEAM_OVERRIDE" && !t.teamBuilding) ctx.addIssue({ code: "custom", path: ["components", i, "kind"], message: "Team commission needs team building switched on." });
    });
    if (t.geography.scope !== "ALL_INDIA" && t.geography.scope !== "ZONE" && !t.geography.codes.length) {
      ctx.addIssue({ code: "custom", path: ["geography", "codes"], message: "Choose the areas this scheme covers." });
    }
    if (t.exclusivity !== "NONE" && t.geography.scope === "ALL_INDIA") ctx.addIssue({ code: "custom", path: ["exclusivity"], message: "An all-India scheme cannot be exclusive." });
    if (t.territoryBooking && t.geography.scope !== "ZONE") ctx.addIssue({ code: "custom", path: ["territoryBooking"], message: "Zone booking needs the Zone geography." });
    const feeShare = t.components.filter((c) => c.basis === "SHOP_REGISTRATION_FEE" && c.frequency === "ONCE").reduce((sum, c) => sum + (c.rateBp ?? 0), 0);
    if (feeShare > 10_000) ctx.addIssue({ code: "custom", path: ["components"], message: "One-time commissions on the registration fee add up to more than 100%." });
    if (t.commissionBudgetBp !== null && feeShare > t.commissionBudgetBp) ctx.addIssue({ code: "custom", path: ["commissionBudgetBp"], message: "The components pay more than the commission budget." });
  });

export type SchemeTerms = z.infer<typeof schemeTermsSchema>;
/** Terms as stored or typed (custom fields and eligibility rules may be missing; parsing fills them). */
export type SchemeTermsInput = z.input<typeof schemeTermsSchema>;
export type SchemeComponent = z.infer<typeof schemeComponentSchema>;
export type SchemeCharge = z.infer<typeof schemeChargeSchema>;

/** Joining charge with GST: what the dealer pays. GST is added on top (EXCLUSIVE) or already inside (INCLUSIVE). */
export function chargeTotals(c: SchemeCharge): { basePaise: number; gstPaise: number; totalPaise: number } {
  if (c.kind === "FREE" || c.amountPaise === 0) return { basePaise: 0, gstPaise: 0, totalPaise: 0 };
  if (c.gstMode === "INCLUSIVE") {
    const base = Math.round((c.amountPaise * 10_000) / (10_000 + c.gstRateBp));
    return { basePaise: base, gstPaise: c.amountPaise - base, totalPaise: c.amountPaise };
  }
  const gst = Math.round((c.amountPaise * c.gstRateBp) / 10_000);
  return { basePaise: c.amountPaise, gstPaise: gst, totalPaise: c.amountPaise + gst };
}

export const COMPONENT_KIND_LABELS: Record<(typeof COMPONENT_KINDS)[number], string> = {
  ONE_TIME: "One-time",
  RECURRING: "Recurring",
  TEAM_OVERRIDE: "Team commission",
  REFERRAL: "Referral",
  TARGET_BONUS: "Target bonus",
  RENEWAL: "Renewal",
  DEVELOPMENT: "Team development",
  PERFORMANCE_BONUS: "Performance bonus",
};

export const BASIS_LABELS: Record<(typeof COMPONENT_BASES)[number], string> = {
  SHOP_REGISTRATION_FEE: "shop registration fee",
  SHOP_ACTIVATION_FEE: "shop activation fee",
  PLATFORM_COMMISSION: "GoKesari's commission",
  TRANSACTION_VALUE: "completed sales",
  NET_TRANSACTION_VALUE: "net eligible sales",
  FIXED_PER_SHOP: "per shop",
  FORMULA: "formula",
  LEGACY: "rate set in Dealer commission",
};

export const CALCULATION_LABELS: Record<(typeof CALCULATION_MODES)[number], string> = {
  LEGACY_DEALER: "Calculated by Dealer commission (existing)",
  LEGACY_FRANCHISE: "Calculated by Franchise settings (existing)",
  SCHEME: "Calculated from these terms",
};

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const percent = (b: number) => `${(b / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;

/** One line per component, e.g. "Recurring: 5% of GoKesari's commission, monthly, 12 months". */
export function describeComponent(c: SchemeComponent): string {
  const upTo = c.kind === "PERFORMANCE_BONUS" || c.kind === "TARGET_BONUS" ? "up to " : "";
  const amount = c.basis === "FIXED_PER_SHOP" ? `${upTo}${rupees(c.fixedPaise ?? 0)} per shop` : c.basis === "FORMULA" ? "by formula" : c.basis === "LEGACY" ? BASIS_LABELS.LEGACY : `${upTo}${percent(c.rateBp ?? 0)} of ${BASIS_LABELS[c.basis]}`;
  const when = c.frequency === "ONCE" ? "" : `, ${c.frequency.toLowerCase()}`;
  const howLong = c.durationMonths ? `, ${c.durationMonths} months` : "";
  const level = c.kind === "TEAM_OVERRIDE" && c.level ? ` (level ${c.level})` : "";
  return `${COMPONENT_KIND_LABELS[c.kind]}${level}: ${amount}${when}${howLong}`;
}

/** "Free" or "₹11,000 + 18% GST = ₹12,980". */
export function describeCharge(c: SchemeCharge): string {
  if (c.kind === "FREE") return "Free";
  const t = chargeTotals(c);
  const period = c.kind === "ONE_TIME" ? "" : ` (${c.kind.toLowerCase().replace(/_/g, " ")})`;
  if (!c.gstRateBp) return `${rupees(t.totalPaise)}${period}`;
  return c.gstMode === "EXCLUSIVE" ? `${rupees(t.basePaise)} + ${percent(c.gstRateBp)} GST = ${rupees(t.totalPaise)}${period}` : `${rupees(t.totalPaise)} incl. ${percent(c.gstRateBp)} GST${period}`;
}

/* ============================================================ custom field values */

export type CustomValue = string | number | boolean | string[] | null;
export type CustomValues = Record<string, CustomValue>;

/** Is the field shown, given the values entered so far? */
export function fieldVisible(f: CustomField, values: CustomValues): boolean {
  if (!f.showWhen) return true;
  const v = values[f.showWhen.field];
  return Array.isArray(v) ? v.includes(String(f.showWhen.equals)) : v === f.showWhen.equals || String(v) === String(f.showWhen.equals);
}

/**
 * Checks and normalises an applicant's values for the scheme's fields asked on the application (visible ones
 * only; FILE and FORMULA fields are not typed in). `complete`: required fields must be filled (on submit).
 */
export function checkCustomValues(fields: readonly CustomField[], raw: Record<string, unknown>, complete: boolean): { values: CustomValues; errors: Record<string, string> } {
  const values: CustomValues = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!f.useIn.registration || f.type === "FORMULA" || f.type === "FILE") continue;
    if (!fieldVisible(f, values)) continue;
    const v = raw[f.key];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (complete && f.required && f.type !== "CHECKBOX") errors[f.key] = `${f.label} is required.`;
      values[f.key] = f.type === "CHECKBOX" ? false : null;
      continue;
    }
    switch (f.type) {
      case "TEXT":
        values[f.key] = String(v).trim().slice(0, 500);
        break;
      case "NUMBER":
      case "CURRENCY":
      case "PERCENT": {
        const n = Number(v);
        if (!Number.isFinite(n)) errors[f.key] = `${f.label}: enter a number.`;
        else values[f.key] = f.type === "NUMBER" ? n : Math.round(n);
        break;
      }
      case "DATE":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errors[f.key] = `${f.label}: enter a date.`;
        else values[f.key] = String(v);
        break;
      case "DROPDOWN":
        if (!f.options?.includes(String(v))) errors[f.key] = `${f.label}: choose one of the options.`;
        else values[f.key] = String(v);
        break;
      case "MULTI_SELECT": {
        const list = (Array.isArray(v) ? v : [v]).map(String);
        if (list.some((x) => !f.options?.includes(x))) errors[f.key] = `${f.label}: choose from the options.`;
        else values[f.key] = list;
        break;
      }
      case "CHECKBOX":
      case "YES_NO":
        values[f.key] = v === true || v === "true" || v === "yes" || v === 1;
        break;
    }
  }
  return { values, errors };
}

/** Numeric custom values as formula variables (cf_<key>), FORMULA fields computed in field order. */
export function customVariables(fields: readonly CustomField[], values: CustomValues, base: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fields) {
    if (!NUMERIC_FIELD_TYPES.includes(f.type)) continue;
    if (f.type === "FORMULA") {
      const r = compileFormula(f.formula ?? "", [...Object.keys(base), ...Object.keys(out)]);
      out[fieldVariable(f.key)] = r.ok ? safeEval(() => r.evaluate({ ...base, ...out })) : 0;
      continue;
    }
    const v = values[f.key];
    out[fieldVariable(f.key)] = typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : 0;
  }
  return out;
}

function safeEval(run: () => number): number {
  try {
    return run();
  } catch {
    return 0;
  }
}

/** The eligibility rules a dealer fails (their messages). A rule that cannot be evaluated counts as failed. */
export function failedEligibility(rules: readonly EligibilityRule[], variables: Record<string, number>): string[] {
  const failed: string[] = [];
  for (const r of rules) {
    const c = compileFormula(r.formula, Object.keys(variables));
    if (!c.ok || !safeEval(() => c.evaluate(variables))) failed.push(r.message);
  }
  return failed;
}
