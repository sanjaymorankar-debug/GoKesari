/**
 * GST rules as dated data (Module 2): gst_rules rows, the one in force on a
 * document's date applies. Thresholds and switches live there, not in code;
 * admins edit them at /admin/gst-config. A missing rule means "not set" — the
 * caller decides what that means (e-invoicing off, LEGACY numbering, …).
 */
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { gstRules, hsnTaxRates } from "@/server/db/schema";

/** A moment as an IST calendar date, "YYYY-MM-DD". */
export function istDate(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export async function getGstRule<T>(key: string, at: Date = new Date(), client: DbClient = db): Promise<T | null> {
  const day = istDate(at);
  const [row] = await client
    .select({ value: gstRules.value })
    .from(gstRules)
    .where(and(eq(gstRules.key, key), lte(gstRules.effectiveFrom, day), or(isNull(gstRules.effectiveTo), gte(gstRules.effectiveTo, day))))
    .orderBy(desc(gstRules.effectiveFrom))
    .limit(1);
  return (row?.value as T | undefined) ?? null;
}

export interface DocumentNumbering {
  format: "LEGACY" | "GST16";
}

export async function documentNumbering(at: Date, client: DbClient = db): Promise<DocumentNumbering["format"]> {
  const rule = await getGstRule<DocumentNumbering>("documentNumbering", at, client);
  return rule?.format === "GST16" ? "GST16" : "LEGACY";
}

/**
 * Document number. GST16: "GK2627-000001" / "CN2627-000001" (13 characters;
 * GST Rule 46 and the e-invoice schema allow 16), unique per shop per FY.
 * LEGACY: "<shop no>/<FY>/000001" for invoices (as before), "<shop no>/CN/<FY>/000001" for credit notes.
 */
export function formatDocumentNumber(
  format: DocumentNumbering["format"],
  kind: "INVOICE" | "CREDIT_NOTE",
  shopRegistrationNumber: string,
  financialYear: string,
  sequence: number,
): string {
  if (format === "GST16") {
    const fy = `${financialYear.slice(2, 4)}${financialYear.slice(5, 7)}`;
    return `${kind === "INVOICE" ? "GK" : "CN"}${fy}-${String(sequence).padStart(6, "0")}`;
  }
  const seq = String(sequence).padStart(6, "0");
  return kind === "INVOICE" ? `${shopRegistrationNumber}/${financialYear}/${seq}` : `${shopRegistrationNumber}/CN/${financialYear}/${seq}`;
}

/** Fallback GST rate for an HSN code on a date: the longest matching prefix in hsn_tax_rates. */
export async function hsnFallbackRate(hsn: string | null | undefined, at: Date, client: DbClient = db): Promise<{ rateBp: number; cessBp: number } | null> {
  if (!hsn || !/^\d{2,8}$/.test(hsn)) return null;
  const day = istDate(at);
  const [row] = await client
    .select({ rateBp: hsnTaxRates.rateBp, cessBp: hsnTaxRates.cessBp })
    .from(hsnTaxRates)
    .where(
      and(
        sql`${hsn} LIKE ${hsnTaxRates.hsnPrefix} || '%'`,
        lte(hsnTaxRates.effectiveFrom, day),
        or(isNull(hsnTaxRates.effectiveTo), gte(hsnTaxRates.effectiveTo, day)),
      ),
    )
    .orderBy(desc(sql`length(${hsnTaxRates.hsnPrefix})`), desc(hsnTaxRates.effectiveFrom))
    .limit(1);
  return row ?? null;
}
