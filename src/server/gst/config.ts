/**
 * GST settings an administrator edits (/admin/gst-config, Module 2): the dated
 * rules in gst_rules and the fallback HSN rates. A change takes effect from a
 * date — the row in force before it is closed the day before — so documents
 * already issued keep the rule of their own date. Every change is audited.
 * Shops declare e-invoice applicability here too (their turnover is not
 * visible to GoKesari).
 */
import { and, asc, desc, eq, gte, isNull, lt, ne, or } from "drizzle-orm";
import { z } from "zod";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { gstRules, hsnTaxRates, shops, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { istDate } from "./rules";

const paise = z.number().int().min(0);

export const GST_RULE_SCHEMAS = {
  documentNumbering: z.object({ format: z.enum(["LEGACY", "GST16"]) }),
  einvoice: z.object({ enabled: z.boolean(), turnoverThresholdPaise: paise, b2bOnly: z.boolean().default(true) }),
  einvoiceReportingWindow: z.object({ days: z.number().int().min(1).max(365), appliesAbovePaise: paise }),
  b2clThreshold: z.object({ invoiceValuePaise: paise }),
  ewayBill: z.object({
    enabled: z.boolean(),
    interStateThresholdPaise: paise,
    intraStateThresholdPaise: z.record(z.string().regex(/^([A-Z]{2}|DEFAULT)$/), paise).refine((v) => "DEFAULT" in v, "Set a DEFAULT intra-state limit."),
  }),
  gsp: z.object({ provider: z.string().min(1).max(40) }),
} as const;
export type GstRuleKey = keyof typeof GST_RULE_SCHEMAS;
export const GST_RULE_KEYS = Object.keys(GST_RULE_SCHEMAS) as GstRuleKey[];

export const GST_RULE_HELP: Record<GstRuleKey, string> = {
  documentNumbering: "Invoice / credit note numbers. GST16 (GK2627-000001) fits the 16-character limit of Rule 46 and e-invoicing; switch at the start of a financial year.",
  einvoice: "E-invoicing (IRN) for B2B invoices of shops that declared turnover above the threshold.",
  einvoiceReportingWindow: "Days allowed to obtain an IRN after the invoice date, for large taxpayers.",
  b2clThreshold: "GSTR-1 B2C large: inter-state invoices to unregistered buyers above this value.",
  ewayBill: "E-way bill limits by consignment value; intra-state limits by state code (two letters) with a DEFAULT.",
  gsp: "Which GSP adapter is in use (must agree with the server's GSP_PROVIDER).",
};

export async function listGstRules() {
  return db.select().from(gstRules).orderBy(asc(gstRules.key), desc(gstRules.effectiveFrom));
}

export const setRuleSchema = z.object({
  key: z.enum(GST_RULE_KEYS as [GstRuleKey, ...GstRuleKey[]]),
  value: z.unknown(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(1000).optional(),
});

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function setGstRule(input: z.infer<typeof setRuleSchema>, actor: { id: string; role: UserRole }) {
  const parsed = GST_RULE_SCHEMAS[input.key].safeParse(input.value);
  if (!parsed.success) throw validationFailed(parsed.error.issues.map((i) => `${i.path.join(".") || input.key}: ${i.message}`).join("; "));
  const today = istDate(new Date());
  const [anyRow] = await db.select({ id: gstRules.id }).from(gstRules).where(eq(gstRules.key, input.key)).limit(1);
  if (anyRow && input.effectiveFrom < today) {
    throw validationFailed("A change can start today or later: documents already issued keep the rule of their date.");
  }
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(gstRules)
      .where(and(eq(gstRules.key, input.key), lt(gstRules.effectiveFrom, input.effectiveFrom), or(isNull(gstRules.effectiveTo), gte(gstRules.effectiveTo, input.effectiveFrom))))
      .orderBy(desc(gstRules.effectiveFrom))
      .limit(1);
    if (before) await tx.update(gstRules).set({ effectiveTo: dayBefore(input.effectiveFrom), updatedAt: new Date() }).where(eq(gstRules.id, before.id));
    // A later row already scheduled limits this one.
    const [after] = await tx
      .select({ effectiveFrom: gstRules.effectiveFrom })
      .from(gstRules)
      .where(and(eq(gstRules.key, input.key), gte(gstRules.effectiveFrom, input.effectiveFrom), ne(gstRules.effectiveFrom, input.effectiveFrom)))
      .orderBy(asc(gstRules.effectiveFrom))
      .limit(1);
    const values = {
      key: input.key,
      value: parsed.data,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: after ? dayBefore(after.effectiveFrom) : null,
      note: input.note ?? null,
      updatedBy: actor.id,
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(gstRules)
      .values(values)
      .onConflictDoUpdate({ target: [gstRules.key, gstRules.effectiveFrom], set: { value: values.value, note: values.note, updatedBy: actor.id, updatedAt: values.updatedAt } })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.GST_CONFIG_CHANGED,
        entityType: "gst_rule",
        entityId: row.id,
        previousValue: before ? { value: before.value, effectiveFrom: before.effectiveFrom } : null,
        newValue: { key: input.key, value: parsed.data, effectiveFrom: input.effectiveFrom },
      },
      tx,
    );
    return row;
  });
}

/* --------------------------------------------------------- HSN fallbacks */

export async function listHsnRates(q?: string) {
  const rows = await db.select().from(hsnTaxRates).orderBy(asc(hsnTaxRates.hsnPrefix), desc(hsnTaxRates.effectiveFrom));
  return q ? rows.filter((r) => r.hsnPrefix.startsWith(q.replace(/\D/g, "")) || (r.description ?? "").toLowerCase().includes(q.toLowerCase())) : rows;
}

export const hsnRateSchema = z.object({
  hsnPrefix: z.string().regex(/^\d{2,8}$/, "HSN: 2 to 8 digits"),
  ratePercent: z.number().min(0).max(100),
  cessPercent: z.number().min(0).max(1000).default(0),
  description: z.string().trim().max(200).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function setHsnRate(input: z.infer<typeof hsnRateSchema>, actor: { id: string; role: UserRole }) {
  const rateBp = Math.round(input.ratePercent * 100);
  const cessBp = Math.round(input.cessPercent * 100);
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(hsnTaxRates)
      .where(and(eq(hsnTaxRates.hsnPrefix, input.hsnPrefix), lt(hsnTaxRates.effectiveFrom, input.effectiveFrom), isNull(hsnTaxRates.effectiveTo)))
      .limit(1);
    if (before) await tx.update(hsnTaxRates).set({ effectiveTo: dayBefore(input.effectiveFrom), updatedAt: new Date() }).where(eq(hsnTaxRates.id, before.id));
    const [row] = await tx
      .insert(hsnTaxRates)
      .values({ hsnPrefix: input.hsnPrefix, rateBp, cessBp, description: input.description ?? null, effectiveFrom: input.effectiveFrom, updatedBy: actor.id })
      .onConflictDoUpdate({
        target: [hsnTaxRates.hsnPrefix, hsnTaxRates.effectiveFrom],
        set: { rateBp, cessBp, description: input.description ?? null, updatedBy: actor.id, updatedAt: new Date() },
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.GST_CONFIG_CHANGED,
        entityType: "hsn_tax_rate",
        entityId: row.id,
        previousValue: before ? { rateBp: before.rateBp, effectiveFrom: before.effectiveFrom } : null,
        newValue: { hsnPrefix: input.hsnPrefix, rateBp, cessBp, effectiveFrom: input.effectiveFrom },
      },
      tx,
    );
    return row;
  });
}

export async function endHsnRate(id: string, effectiveTo: string, actor: { id: string; role: UserRole }) {
  const [row] = await db.select().from(hsnTaxRates).where(eq(hsnTaxRates.id, id));
  if (!row) throw notFound("HSN rate");
  if (effectiveTo < row.effectiveFrom) throw conflict("The end date is before the start date.");
  await db.update(hsnTaxRates).set({ effectiveTo, updatedBy: actor.id, updatedAt: new Date() }).where(eq(hsnTaxRates.id, id));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.GST_CONFIG_CHANGED, entityType: "hsn_tax_rate", entityId: id, newValue: { effectiveTo } });
}

/* ------------------------------------------- shop: e-invoice declaration */

export const einvoiceDeclarationSchema = z.object({
  applicable: z.boolean(),
  turnoverBand: z.enum(["BELOW_5_CR", "5_TO_10_CR", "10_TO_100_CR", "ABOVE_100_CR"]),
});

export async function declareEinvoice(shopId: string, input: z.infer<typeof einvoiceDeclarationSchema>, actor: { id: string; role: UserRole }) {
  const [shop] = await db.select({ applicable: shops.einvoiceApplicable, band: shops.declaredTurnoverBand }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  if (input.applicable !== (input.turnoverBand !== "BELOW_5_CR")) {
    throw validationFailed("E-invoicing applies when the aggregate turnover is above ₹5 crore — the answers do not agree.");
  }
  await db
    .update(shops)
    .set({ einvoiceApplicable: input.applicable, declaredTurnoverBand: input.turnoverBand, turnoverDeclaredAt: new Date(), turnoverDeclaredBy: actor.id })
    .where(eq(shops.id, shopId));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_EINVOICE_DECLARED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { applicable: shop.applicable, band: shop.band },
    newValue: input,
  });
}
