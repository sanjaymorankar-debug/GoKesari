/**
 * Tax register (docs/tax-register/README.md): change requests and the register of tax settings.
 *
 * The Accountant (or an admin) proposes; the CA approves (never their own proposal) and the change
 * is applied at once through the setting's own service — statutory rows, TDS on commission, GST
 * rules, HSN rates, product GST, the tax fields of the admin settings, franchise GST — or sends it
 * back with a note. Every step is audited. Dated settings keep their own effective dates; settings
 * held in the admin settings apply when approved.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { RULES, type RuleKey } from "@/server/config/rules";
import { db } from "@/server/db";
import { commissionTdsRates, gstRules, hsnTaxRates, statutoryRates, taxChangeRequests, taxParamApprovals, type TaxChangeKind, type TaxChangeRequest, type UserRole } from "@/server/db/schema";
import { franchiseConfig, saveFranchiseConfig } from "@/server/franchise/config";
import { GST_RULE_KEYS, GST_RULE_SCHEMAS, hsnRateSchema, setGstRule, setHsnRate, type GstRuleKey } from "@/server/gst/config";
import { productGstSchema, setProductGst } from "@/server/gst/product-rates";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule, setRule } from "@/server/services/settings";
import { addStatutoryRate, istDay, STATUTORY_KEYS, statutoryRateInput, updateStatutoryRate } from "@/server/statutory/rates";
import { addCommissionTdsRate, setCommissionTdsConfirmation } from "@/server/tax/commission-tds";
import { decisionRefusal, isTaxRuleField, ruleParamKey, sameValue, TAX_RULE_FIELDS, TAX_RULE_KEYS, type TaxRuleKey } from "./rules";

export interface Actor {
  id: string;
  role: UserRole;
}

/** Flag tax_register: tax settings change only through the register. */
export async function taxRegisterOn(): Promise<boolean> {
  return isFeatureEnabled("tax_register");
}

/** For the admin screens: refuse a direct edit of a tax setting while the register is on. */
export async function refuseDirectTaxEdit(what: string): Promise<void> {
  if (await taxRegisterOn()) throw forbidden(`${what} is changed through the tax register: the Accountant proposes it at /staff/tax and the CA approves.`);
}

/* ------------------------------------------------------------------ payloads */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date: YYYY-MM-DD");
const commissionTdsRowSchema = z.object({
  payeeType: z.enum(["INDIVIDUAL", "FIRM", "COMPANY", "ANY"]),
  panStatus: z.enum(["PAN_OK", "NO_PAN"]),
  rateBp: z.number().int().min(0).max(10_000),
  thresholdPaise: z.number().int().min(0),
  mode: z.enum(["CATCH_UP", "EXCESS_ONLY"]),
  section: z.string().trim().min(3).max(300),
  effectiveFrom: day,
  note: z.string().max(500).nullish(),
});
const productGstRowSchema = productGstSchema.omit({ reason: true }).extend({ productId: z.string().uuid() });

export const PAYLOAD_SCHEMAS = {
  STATUTORY_ROW: statutoryRateInput,
  STATUTORY_CONFIRM: z.object({ rowId: z.string().uuid() }),
  COMMISSION_TDS_ROW: commissionTdsRowSchema,
  COMMISSION_TDS_CONFIRM: z.object({ rowId: z.string().uuid() }),
  GST_RULE: z.object({ key: z.enum(GST_RULE_KEYS as [GstRuleKey, ...GstRuleKey[]]), value: z.unknown(), effectiveFrom: day, note: z.string().trim().max(1000).optional() }),
  HSN_RATES: z.object({ rows: z.array(hsnRateSchema).min(1).max(5_000) }),
  PRODUCT_GST: z.object({ rows: z.array(productGstRowSchema).min(1).max(5_000) }),
  RULE_FIELDS: z.object({ ruleKey: z.enum(TAX_RULE_KEYS as [TaxRuleKey, ...TaxRuleKey[]]), values: z.record(z.string(), z.unknown()) }),
  FRANCHISE_GST: z.object({ gstRateBp: z.number().int().min(0).max(2800) }),
  APPROVE_CURRENT: z.object({ paramKeys: z.array(z.string().min(3).max(200)).min(1).max(200) }),
} satisfies Record<TaxChangeKind, z.ZodTypeAny>;

export const proposeSchema = z.object({
  kind: z.enum(Object.keys(PAYLOAD_SCHEMAS) as [TaxChangeKind, ...TaxChangeKind[]]),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(5).max(2000),
  legalReference: z.string().trim().max(1000).nullish(),
});
export type ProposeInput = z.infer<typeof proposeSchema>;

const pct = (bp: number | null | undefined) => (bp == null ? "—" : `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`);

/** Checks a payload in full, and works out its title, register keys and what the setting holds now. */
async function describe(kind: TaxChangeKind, raw: Record<string, unknown>): Promise<{ payload: Record<string, unknown>; title: string; targetKeys: string[]; currentValue: unknown }> {
  const parsed = PAYLOAD_SCHEMAS[kind].safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues.map((i) => `${i.path.join(".") || kind}: ${i.message}`).join("; "));
  const p = parsed.data as Record<string, unknown>;
  const today = istDay(new Date());
  switch (kind) {
    case "STATUTORY_ROW": {
      const v = p as z.infer<typeof statutoryRateInput>;
      const [current] = await db.select().from(statutoryRates).where(and(eq(statutoryRates.key, v.key), lte(statutoryRates.effectiveFrom, v.effectiveFrom), or(isNull(statutoryRates.effectiveTo), gte(statutoryRates.effectiveTo, v.effectiveFrom))));
      return { payload: p, title: `${v.label}: ${pct(v.rateBp)} from ${v.effectiveFrom}`, targetKeys: [`statutory:${v.key}`], currentValue: current ? { rateBp: current.rateBp, enabled: current.enabled, params: current.params, effectiveFrom: current.effectiveFrom } : null };
    }
    case "STATUTORY_CONFIRM": {
      const [row] = await db.select().from(statutoryRates).where(eq(statutoryRates.id, String(p.rowId)));
      if (!row) throw notFound("Statutory setting");
      if (row.confirmedByCa) throw conflict("That row is already confirmed by the CA.");
      return { payload: p, title: `Confirm ${row.label} (${pct(row.rateBp)} from ${row.effectiveFrom})`, targetKeys: [`statutory:${row.key}`], currentValue: { rateBp: row.rateBp, enabled: row.enabled, params: row.params, effectiveFrom: row.effectiveFrom } };
    }
    case "COMMISSION_TDS_ROW": {
      const v = p as z.infer<typeof commissionTdsRowSchema>;
      return { payload: p, title: `TDS on commission ${v.payeeType} / ${v.panStatus}: ${pct(v.rateBp)} from ${v.effectiveFrom}`, targetKeys: [`commissionTds:${v.payeeType}/${v.panStatus}`], currentValue: null };
    }
    case "COMMISSION_TDS_CONFIRM": {
      const [row] = await db.select().from(commissionTdsRates).where(eq(commissionTdsRates.id, String(p.rowId)));
      if (!row) throw notFound("TDS row");
      if (row.confirmedByCa) throw conflict("That row is already confirmed by the CA.");
      return { payload: p, title: `Confirm TDS on commission ${row.payeeType} / ${row.panStatus} (${pct(row.rateBp)} from ${row.effectiveFrom})`, targetKeys: [`commissionTds:${row.payeeType}/${row.panStatus}`], currentValue: { rateBp: row.rateBp, thresholdPaise: row.thresholdPaise, mode: row.mode, section: row.section } };
    }
    case "GST_RULE": {
      const key = p.key as GstRuleKey;
      const ok = GST_RULE_SCHEMAS[key].safeParse(p.value);
      if (!ok.success) throw validationFailed(ok.error.issues.map((i) => `${i.path.join(".") || key}: ${i.message}`).join("; "));
      const [current] = await db.select().from(gstRules).where(and(eq(gstRules.key, key), lte(gstRules.effectiveFrom, today), or(isNull(gstRules.effectiveTo), gte(gstRules.effectiveTo, today))));
      return { payload: { ...p, value: ok.data }, title: `GST rule ${key} from ${String(p.effectiveFrom)}`, targetKeys: [`gstRule:${key}`], currentValue: current?.value ?? null };
    }
    case "HSN_RATES": {
      const rows = p.rows as z.infer<typeof hsnRateSchema>[];
      return { payload: p, title: rows.length === 1 ? `HSN ${rows[0].hsnPrefix}: ${rows[0].ratePercent}% from ${rows[0].effectiveFrom}` : `${rows.length} HSN rates`, targetKeys: [...new Set(rows.map((r) => `hsn:${r.hsnPrefix}`))].slice(0, 200), currentValue: null };
    }
    case "PRODUCT_GST": {
      const rows = p.rows as z.infer<typeof productGstRowSchema>[];
      return { payload: p, title: rows.length === 1 ? `Product GST: ${rows[0].hsnCode ?? "no HSN"} at ${rows[0].gstRatePercent ?? "—"}%` : `GST of ${rows.length} products`, targetKeys: ["productGst"], currentValue: null };
    }
    case "RULE_FIELDS": {
      const ruleKey = p.ruleKey as TaxRuleKey;
      const values = p.values as Record<string, unknown>;
      const fields = Object.keys(values);
      if (!fields.length) throw validationFailed("Give at least one value.");
      const bad = fields.filter((f) => !isTaxRuleField(ruleKey, f));
      if (bad.length) throw validationFailed(`Not a tax field of ${ruleKey}: ${bad.join(", ")}.`);
      const current = (await getRule(ruleKey as RuleKey)) as Record<string, unknown>;
      const merged = RULES[ruleKey as RuleKey].schema.safeParse({ ...current, ...values });
      if (!merged.success) throw validationFailed(merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return {
        payload: p,
        title: `${ruleKey}: ${fields.map((f) => `${f} → ${JSON.stringify(values[f])}`).join(", ")}`.slice(0, 300),
        targetKeys: fields.map((f) => ruleParamKey(ruleKey, f)),
        currentValue: Object.fromEntries(fields.map((f) => [f, current[f]])),
      };
    }
    case "FRANCHISE_GST": {
      const { config } = await franchiseConfig();
      return { payload: p, title: `Franchise fee GST: ${pct(Number(p.gstRateBp))}`, targetKeys: ["franchise:gstRateBp"], currentValue: config.gstRateBp };
    }
    case "APPROVE_CURRENT": {
      const keys = [...new Set(p.paramKeys as string[])];
      const params = await listTaxParameters();
      const byKey = new Map(params.map((x) => [x.key, x]));
      const unknown = keys.filter((k) => !byKey.has(k));
      if (unknown.length) throw validationFailed(`Unknown settings: ${unknown.slice(0, 5).join(", ")}.`);
      return { payload: { paramKeys: keys }, title: keys.length === 1 ? `Approve current value of ${byKey.get(keys[0])!.label}` : `Approve current values of ${keys.length} settings`, targetKeys: keys, currentValue: Object.fromEntries(keys.map((k) => [k, byKey.get(k)!.value])) };
    }
  }
}

/* ------------------------------------------------------------- the register */

export interface TaxParameter {
  key: string;
  group: string;
  label: string;
  value: unknown;
  /** Dated rows: in force from. */
  effectiveFrom: string | null;
  approved: boolean;
  approvedAt: Date | null;
  /** Row id for statutory / TDS rows (the "confirm" proposals use it). */
  rowId: string | null;
}

const RULE_GROUPS: Record<TaxRuleKey, string> = {
  invoicing: "GST invoicing",
  riderPayouts: "Rider TDS (194C)",
  billing: "Billing and composition",
  platformTaxProfile: "GoKesari tax profile",
  health: "Health plans",
  dealerPayoutTds: "Dealer TDS",
};

async function latestApprovals(keys: string[]): Promise<Map<string, { value: unknown; approvedAt: Date }>> {
  const out = new Map<string, { value: unknown; approvedAt: Date }>();
  if (!keys.length) return out;
  const rows = await db.select().from(taxParamApprovals).where(inArray(taxParamApprovals.paramKey, keys)).orderBy(desc(taxParamApprovals.approvedAt));
  for (const r of rows) if (!out.has(r.paramKey)) out.set(r.paramKey, { value: r.value, approvedAt: r.approvedAt });
  return out;
}

/** Every tax setting, its value in force today and whether the CA has approved that value. */
export async function listTaxParameters(): Promise<TaxParameter[]> {
  const today = istDay(new Date());
  const out: TaxParameter[] = [];
  const inForce = <T extends { effectiveFrom: string; effectiveTo: string | null }>(r: T) => r.effectiveFrom <= today && (!r.effectiveTo || r.effectiveTo >= today);

  for (const r of (await db.select().from(statutoryRates)).filter(inForce)) {
    out.push({ key: `statutory:${r.key}`, group: "Statutory (TCS / TDS / s.9(5) / fee GST)", label: r.label, value: { rateBp: r.rateBp, enabled: r.enabled, params: r.params }, effectiveFrom: r.effectiveFrom, approved: r.confirmedByCa, approvedAt: r.confirmedAt, rowId: r.id });
  }
  for (const k of STATUTORY_KEYS) if (!out.some((p) => p.key === `statutory:${k}`)) out.push({ key: `statutory:${k}`, group: "Statutory (TCS / TDS / s.9(5) / fee GST)", label: k, value: null, effectiveFrom: null, approved: false, approvedAt: null, rowId: null });

  for (const r of (await db.select().from(commissionTdsRates)).filter(inForce)) {
    out.push({ key: `commissionTds:${r.payeeType}/${r.panStatus}`, group: "TDS on commission", label: `${r.section} — ${r.payeeType}, ${r.panStatus === "PAN_OK" ? "with PAN" : "no PAN"}`, value: { rateBp: r.rateBp, thresholdPaise: r.thresholdPaise, mode: r.mode }, effectiveFrom: r.effectiveFrom, approved: r.confirmedByCa, approvedAt: r.confirmedAt, rowId: r.id });
  }

  const ruleKeys: string[] = [];
  const ruleValues: { key: string; group: string; label: string; value: unknown }[] = [];
  for (const ruleKey of TAX_RULE_KEYS) {
    const v = (await getRule(ruleKey as RuleKey)) as Record<string, unknown>;
    for (const f of TAX_RULE_FIELDS[ruleKey]) {
      const key = ruleParamKey(ruleKey, f);
      ruleKeys.push(key);
      ruleValues.push({ key, group: RULE_GROUPS[ruleKey], label: `${ruleKey}.${f}`, value: v[f] });
    }
  }
  const { config } = await franchiseConfig();
  ruleKeys.push("franchise:gstRateBp");
  ruleValues.push({ key: "franchise:gstRateBp", group: "Franchise", label: "Franchise fee GST (gstRateBp)", value: config.gstRateBp });

  const gstRows = (await db.select().from(gstRules)).filter(inForce);
  for (const r of gstRows) {
    ruleKeys.push(`gstRule:${r.key}`);
    ruleValues.push({ key: `gstRule:${r.key}`, group: "GST rules", label: r.key, value: { value: r.value, effectiveFrom: r.effectiveFrom } });
  }
  const hsnRows = (await db.select().from(hsnTaxRates)).filter(inForce);
  for (const r of hsnRows) {
    ruleKeys.push(`hsn:${r.hsnPrefix}`);
    ruleValues.push({ key: `hsn:${r.hsnPrefix}`, group: "HSN fallback rates", label: `HSN ${r.hsnPrefix}${r.description ? ` — ${r.description}` : ""}`, value: { rateBp: r.rateBp, cessBp: r.cessBp, effectiveFrom: r.effectiveFrom } });
  }

  const approvals = await latestApprovals(ruleKeys);
  for (const p of ruleValues) {
    const a = approvals.get(p.key);
    const eff = typeof p.value === "object" && p.value && "effectiveFrom" in p.value ? String((p.value as { effectiveFrom: string }).effectiveFrom) : null;
    out.push({ key: p.key, group: p.group, label: p.label, value: p.value, effectiveFrom: eff, approved: !!a && sameValue(a.value, p.value), approvedAt: a?.approvedAt ?? null, rowId: null });
  }
  return out;
}

/* ------------------------------------------------------------ the workflow */

function requireProposer(actor: Actor) {
  if (!can(actor.role, PERMISSIONS.TAX_PARAM_PROPOSE)) throw forbidden("Only the Accountant or an admin proposes tax-setting changes.");
}

export async function proposeTaxChange(input: ProposeInput, actor: Actor): Promise<TaxChangeRequest> {
  requireProposer(actor);
  const body = proposeSchema.parse(input);
  const d = await describe(body.kind, body.payload);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(taxChangeRequests)
      .values({ kind: body.kind, targetKeys: d.targetKeys, title: d.title, payload: d.payload, currentValue: d.currentValue ?? null, reason: body.reason, legalReference: body.legalReference ?? null, proposedBy: actor.id, proposedRole: actor.role })
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.TAX_CHANGE, entityType: "tax_change_request", entityId: row.id, newValue: { event: "PROPOSED", kind: row.kind, title: row.title, payload: row.payload } }, tx);
    return row;
  });
}

/** The proposer edits a sent-back request and submits it again. */
export async function resubmitTaxChange(id: string, input: ProposeInput, actor: Actor): Promise<TaxChangeRequest> {
  requireProposer(actor);
  const [current] = await db.select().from(taxChangeRequests).where(eq(taxChangeRequests.id, id));
  if (!current) throw notFound("Change request");
  if (current.proposedBy !== actor.id) throw forbidden("Only the person who proposed it can change it.");
  if (current.status !== "SENT_BACK") throw conflict("Only a request the CA sent back can be changed and submitted again.");
  const body = proposeSchema.parse(input);
  if (body.kind !== current.kind) throw validationFailed("The kind of change cannot be changed; withdraw it and propose a new one.");
  const d = await describe(body.kind, body.payload);
  const [row] = await db
    .update(taxChangeRequests)
    .set({ targetKeys: d.targetKeys, title: d.title, payload: d.payload, currentValue: d.currentValue ?? null, reason: body.reason, legalReference: body.legalReference ?? null, status: "SUBMITTED", updatedAt: new Date() })
    .where(and(eq(taxChangeRequests.id, id), eq(taxChangeRequests.status, "SENT_BACK")))
    .returning();
  if (!row) throw conflict("It changed meanwhile; reload and try again.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.TAX_CHANGE, entityType: "tax_change_request", entityId: id, newValue: { event: "RESUBMITTED", payload: row.payload } });
  return row;
}

export async function withdrawTaxChange(id: string, actor: Actor): Promise<TaxChangeRequest> {
  const [current] = await db.select().from(taxChangeRequests).where(eq(taxChangeRequests.id, id));
  if (!current) throw notFound("Change request");
  if (current.proposedBy !== actor.id && actor.role !== "ADMIN") throw forbidden("Only the person who proposed it (or an admin) can withdraw it.");
  const [row] = await db
    .update(taxChangeRequests)
    .set({ status: "WITHDRAWN", updatedAt: new Date() })
    .where(and(eq(taxChangeRequests.id, id), inArray(taxChangeRequests.status, ["SUBMITTED", "SENT_BACK", "APPLY_FAILED"])))
    .returning();
  if (!row) throw conflict("Only a request not yet applied can be withdrawn.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.TAX_CHANGE, entityType: "tax_change_request", entityId: id, newValue: { event: "WITHDRAWN" } });
  return row;
}

export async function sendBackTaxChange(id: string, note: string, actor: Actor): Promise<TaxChangeRequest> {
  const [current] = await db.select().from(taxChangeRequests).where(eq(taxChangeRequests.id, id));
  if (!current) throw notFound("Change request");
  const refusal = decisionRefusal(actor, current.proposedBy);
  if (refusal) throw forbidden(refusal);
  const text = note.trim();
  if (text.length < 3) throw validationFailed("Say what needs to change.");
  const [row] = await db
    .update(taxChangeRequests)
    .set({ status: "SENT_BACK", decidedBy: actor.id, decidedAt: new Date(), decisionNote: text, updatedAt: new Date() })
    .where(and(eq(taxChangeRequests.id, id), inArray(taxChangeRequests.status, ["SUBMITTED", "APPLY_FAILED"])))
    .returning();
  if (!row) throw conflict("Only a submitted request can be sent back.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.TAX_CHANGE, entityType: "tax_change_request", entityId: id, newValue: { event: "SENT_BACK", note: text } });
  return row;
}

/**
 * The CA approves: the change is applied through the setting's own service, as the CA, and the
 * new values are recorded as CA-approved. A failure leaves the request APPLY_FAILED with the reason
 * (nothing half-applied is marked approved); the CA can approve it again or send it back.
 */
export async function approveTaxChange(id: string, actor: Actor, note?: string | null): Promise<TaxChangeRequest> {
  const [current] = await db.select().from(taxChangeRequests).where(eq(taxChangeRequests.id, id));
  if (!current) throw notFound("Change request");
  const refusal = decisionRefusal(actor, current.proposedBy);
  if (refusal) throw forbidden(refusal);
  if (current.status !== "SUBMITTED" && current.status !== "APPLY_FAILED") throw conflict("Only a submitted request can be approved.");
  // Claim it first, so two clicks cannot apply it twice.
  const [claimed] = await db
    .update(taxChangeRequests)
    .set({ decidedBy: actor.id, decidedAt: new Date(), decisionNote: note?.trim() || null, applyError: null, updatedAt: new Date() })
    .where(and(eq(taxChangeRequests.id, id), eq(taxChangeRequests.status, current.status), eq(taxChangeRequests.updatedAt, current.updatedAt)))
    .returning();
  if (!claimed) throw conflict("It changed meanwhile; reload and try again.");
  try {
    await applyChange(claimed, actor);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [failed] = await db.update(taxChangeRequests).set({ status: "APPLY_FAILED", applyError: message.slice(0, 1000), updatedAt: new Date() }).where(eq(taxChangeRequests.id, id)).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.TAX_CHANGE, entityType: "tax_change_request", entityId: id, newValue: { event: "APPLY_FAILED", error: message.slice(0, 500) } });
    return failed;
  }
  const [done] = await db.update(taxChangeRequests).set({ status: "APPLIED", appliedAt: new Date(), updatedAt: new Date() }).where(eq(taxChangeRequests.id, id)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.TAX_CHANGE, entityType: "tax_change_request", entityId: id, newValue: { event: "APPROVED_APPLIED", kind: done.kind, title: done.title } });
  return done;
}

async function recordApproval(paramKey: string, value: unknown, actor: Actor, changeRequestId: string) {
  await db.insert(taxParamApprovals).values({ paramKey, value: value ?? null, approvedBy: actor.id, changeRequestId });
}

async function applyChange(req: TaxChangeRequest, actor: Actor): Promise<void> {
  const p = PAYLOAD_SCHEMAS[req.kind].parse(req.payload) as Record<string, unknown>;
  switch (req.kind) {
    case "STATUTORY_ROW": {
      const row = await addStatutoryRate(p as z.infer<typeof statutoryRateInput>, actor);
      await updateStatutoryRate(row.id, { confirmedByCa: true }, actor);
      return;
    }
    case "STATUTORY_CONFIRM":
      await updateStatutoryRate(String(p.rowId), { confirmedByCa: true }, actor);
      return;
    case "COMMISSION_TDS_ROW": {
      const row = await addCommissionTdsRate(p as z.infer<typeof commissionTdsRowSchema>, actor);
      await setCommissionTdsConfirmation(row.id, true, actor, `Tax register ${req.id}`);
      return;
    }
    case "COMMISSION_TDS_CONFIRM":
      await setCommissionTdsConfirmation(String(p.rowId), true, actor, `Tax register ${req.id}`);
      return;
    case "GST_RULE": {
      const row = await setGstRule({ key: p.key as GstRuleKey, value: p.value, effectiveFrom: String(p.effectiveFrom), note: p.note as string | undefined }, actor);
      if (row.effectiveFrom <= istDay(new Date())) await recordApproval(`gstRule:${row.key}`, { value: row.value, effectiveFrom: row.effectiveFrom }, actor, req.id);
      return;
    }
    case "HSN_RATES":
      for (const r of p.rows as z.infer<typeof hsnRateSchema>[]) {
        const row = await setHsnRate(r, actor);
        await recordApproval(`hsn:${row.hsnPrefix}`, { rateBp: row.rateBp, cessBp: row.cessBp, effectiveFrom: row.effectiveFrom }, actor, req.id);
      }
      return;
    case "PRODUCT_GST":
      for (const r of p.rows as z.infer<typeof productGstRowSchema>[]) await setProductGst(r.productId, { hsnCode: r.hsnCode, gstRatePercent: r.gstRatePercent, reason: `Tax register ${req.id}: ${req.reason}`.slice(0, 300) }, actor);
      return;
    case "RULE_FIELDS": {
      const ruleKey = p.ruleKey as TaxRuleKey;
      const current = (await getRule(ruleKey as RuleKey)) as Record<string, unknown>;
      const saved = (await setRule(ruleKey as RuleKey, { ...current, ...(p.values as Record<string, unknown>) }, actor)) as Record<string, unknown>;
      for (const f of Object.keys(p.values as object)) await recordApproval(ruleParamKey(ruleKey, f), saved[f], actor, req.id);
      return;
    }
    case "FRANCHISE_GST": {
      const v = await saveFranchiseConfig({ gstRateBp: Number(p.gstRateBp) }, { reason: `Tax register ${req.id}: ${req.reason}`.slice(0, 500), viaTaxRegister: true }, actor);
      await recordApproval("franchise:gstRateBp", v.config.gstRateBp, actor, req.id);
      return;
    }
    case "APPROVE_CURRENT": {
      const params = new Map((await listTaxParameters()).map((x) => [x.key, x]));
      const proposed = (req.currentValue ?? {}) as Record<string, unknown>;
      for (const key of p.paramKeys as string[]) {
        const now = params.get(key);
        if (!now) throw validationFailed(`Unknown setting ${key}.`);
        // The CA approves what the Accountant put in front of them, not a value changed since.
        if (key in proposed && !sameValue(proposed[key], now.value)) throw conflict(`${now.label} changed after it was proposed; send it back for a fresh proposal.`);
        if (key.startsWith("statutory:")) {
          if (!now.rowId) throw validationFailed(`${now.label} has no row in force.`);
          if (!now.approved) await updateStatutoryRate(now.rowId, { confirmedByCa: true }, actor);
        } else if (key.startsWith("commissionTds:")) {
          if (!now.approved && now.rowId) await setCommissionTdsConfirmation(now.rowId, true, actor, `Tax register ${req.id}`);
        } else await recordApproval(key, now.value, actor, req.id);
      }
      return;
    }
  }
}

export async function listTaxChanges(filter: { status?: string } = {}): Promise<TaxChangeRequest[]> {
  const q = db.select().from(taxChangeRequests);
  const rows = filter.status ? await q.where(eq(taxChangeRequests.status, filter.status as TaxChangeRequest["status"])).orderBy(desc(taxChangeRequests.createdAt)).limit(300) : await q.orderBy(desc(taxChangeRequests.createdAt)).limit(300);
  return rows;
}

/**
 * A product GST CSV for a PRODUCT_GST proposal: product id, HSN (4/6/8 digits or empty), GST %
 * (or empty). A header row is allowed. Every row is checked; nothing is proposed if one is wrong.
 */
export function parseProductGstCsv(csv: string): z.infer<typeof productGstRowSchema>[] {
  const rows: z.infer<typeof productGstRowSchema>[] = [];
  const errors: string[] = [];
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 5_001) throw validationFailed("At most 5,000 rows at a time.");
  lines.forEach((line, i) => {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, "").replace(/%$/, ""));
    if (i === 0 && !/^[0-9a-f]{8}-/i.test(cells[0])) return; // header
    const parsed = productGstRowSchema.safeParse({ productId: cells[0], hsnCode: cells[1] || null, gstRatePercent: cells[2] ? Number(cells[2]) : null });
    if (parsed.success) rows.push(parsed.data);
    else errors.push(`Row ${i + 1}: ${parsed.error.issues[0]?.message ?? "not valid"}`);
  });
  if (errors.length) throw validationFailed(`Nothing proposed. ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? ` (and ${errors.length - 5} more)` : ""}`);
  if (!rows.length) throw validationFailed("The file has no rows.");
  return rows;
}
