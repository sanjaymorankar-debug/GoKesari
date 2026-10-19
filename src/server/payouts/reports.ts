/**
 * Monthly statutory reports from the payout maths (batch-2026-10 WS-E):
 *
 *   TCS (GSTR-8-style)  per supplier GSTIN: gross taxable supplies, returns,
 *                       net, and the IGST / CGST / SGST collected (s.52)
 *   TDS (s.194-O / s.393)  per shop: PAN (masked), gross base, TDS, exemptions
 *
 * Built from payout_cycle_lines by the supply's own date (occurred_on), as
 * CSV and JSON. Download only — GoKesari's CA files GSTR-8 and the TDS
 * return; the exact upload formats are theirs to confirm.
 */
import { createHash } from "node:crypto";

import { and, eq, gte, inArray, lt } from "drizzle-orm";

import { validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { payoutCycleLines, shops, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { shopPan } from "./cycle";

const r2 = (paise: number) => Math.round(paise) / 100;
const cell = (value: string | number | null | undefined) => {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function monthBounds(period: string): { from: string; to: string; fp: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw validationFailed("Choose a month (YYYY-MM).");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const to = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
  return { from: `${m[1]}-${m[2]}-01`, to, fp: `${m[2]}${m[1]}` };
}

export interface StatutoryReport {
  json: Record<string, unknown>;
  csv: string;
  rows: number;
  checksum: string;
}

export async function buildTcsReport(period: string): Promise<StatutoryReport> {
  const { from, to, fp } = monthBounds(period);
  const profile = await getRule("platformTaxProfile");
  const lines = await db
    .select()
    .from(payoutCycleLines)
    .where(and(eq(payoutCycleLines.lineType, "TCS"), gte(payoutCycleLines.occurredOn, from), lt(payoutCycleLines.occurredOn, to)));
  const shopIds = [...new Set(lines.map((l) => l.shopId))];
  const shopRows = shopIds.length ? await db.select({ id: shops.id, name: shops.name, legalName: shops.legalBusinessName, gstin: shops.gstin }).from(shops).where(inArray(shops.id, shopIds)) : [];
  const byShop = new Map<string, { stin: string | null; name: string; gross: number; returns: number; igst: number; cgst: number; sgst: number }>();
  for (const l of lines) {
    const shop = shopRows.find((s) => s.id === l.shopId);
    const b = byShop.get(l.shopId) ?? { stin: shop?.gstin ?? null, name: shop?.legalName ?? shop?.name ?? "", gross: 0, returns: 0, igst: 0, cgst: 0, sgst: 0 };
    const base = l.basePaise ?? 0;
    if (base >= 0) b.gross += base;
    else b.returns += -base;
    const m = l.meta as { igst?: number; cgst?: number; sgst?: number };
    b.igst += m.igst ?? 0;
    b.cgst += m.cgst ?? 0;
    b.sgst += m.sgst ?? 0;
    byShop.set(l.shopId, b);
  }
  const entries = [...byShop.values()];
  const json = {
    gstin: profile.gstin,
    fp,
    note: "GSTR-8-style summary of TCS collected under s.52 CGST Act. CA to confirm before filing.",
    tcs: entries.map((e) => ({ stin: e.stin, supplier: e.name, grossValue: r2(e.gross), returns: r2(e.returns), netValue: r2(e.gross - e.returns), igst: r2(e.igst), cgst: r2(e.cgst), sgst: r2(e.sgst) })),
  };
  const csv =
    [
      ["supplier_gstin", "supplier", "gross_taxable_inr", "returns_inr", "net_taxable_inr", "igst_tcs_inr", "cgst_tcs_inr", "sgst_tcs_inr"].join(","),
      ...entries.map((e) => [e.stin, e.name, r2(e.gross), r2(e.returns), r2(e.gross - e.returns), r2(e.igst), r2(e.cgst), r2(e.sgst)].map(cell).join(",")),
    ].join("\n") + "\n";
  return { json, csv, rows: entries.length, checksum: createHash("sha256").update(csv).digest("hex") };
}

export async function buildTdsReport(period: string): Promise<StatutoryReport> {
  const { from, to, fp } = monthBounds(period);
  const lines = await db
    .select()
    .from(payoutCycleLines)
    .where(and(eq(payoutCycleLines.lineType, "TDS"), gte(payoutCycleLines.occurredOn, from), lt(payoutCycleLines.occurredOn, to)));
  const shopIds = [...new Set(lines.map((l) => l.shopId))];
  const shopRows = shopIds.length ? await db.select().from(shops).where(inArray(shops.id, shopIds)) : [];
  const byShop = new Map<string, { pan: string; name: string; section: string; base: number; tds: number; exemptBase: number; noPan: boolean }>();
  for (const l of lines) {
    const shop = shopRows.find((s) => s.id === l.shopId);
    const pan = shop ? shopPan(shop) : null;
    const m = l.meta as { section?: string; exempt?: boolean; panAvailable?: boolean };
    const b = byShop.get(l.shopId) ?? {
      pan: pan ? `XXXXXX${pan.slice(6)}` : "PANNOTAVBL",
      name: shop?.legalBusinessName ?? shop?.name ?? "",
      section: m.section ?? "Sec 194-O",
      base: 0,
      tds: 0,
      exemptBase: 0,
      noPan: m.panAvailable === false,
    };
    if (m.exempt) b.exemptBase += l.basePaise ?? 0;
    else b.base += l.basePaise ?? 0;
    b.tds += -l.amountPaise;
    byShop.set(l.shopId, b);
  }
  const entries = [...byShop.values()];
  const json = {
    fp,
    note: "TDS on e-commerce participants (Sec 194-O / s.393 ITA 2025). PAN masked; the full PAN is on the shop's record. CA to confirm before filing.",
    tds: entries.map((e) => ({ pan: e.pan, deductee: e.name, section: e.section, grossBase: r2(e.base), exemptBase: r2(e.exemptBase), tds: r2(e.tds), higherRateNoPan: e.noPan })),
  };
  const csv =
    [
      ["deductee_pan_masked", "deductee", "section", "gross_base_inr", "exempt_base_inr", "tds_inr", "no_pan_higher_rate"].join(","),
      ...entries.map((e) => [e.pan, e.name, e.section, r2(e.base), r2(e.exemptBase), r2(e.tds), e.noPan ? "yes" : "no"].map(cell).join(",")),
    ].join("\n") + "\n";
  return { json, csv, rows: entries.length, checksum: createHash("sha256").update(csv).digest("hex") };
}

export async function exportStatutoryReport(
  type: "tcs" | "tds" | "gstr1",
  period: string,
  actor: { id: string; role: UserRole },
): Promise<StatutoryReport> {
  let report: StatutoryReport;
  if (type === "gstr1") {
    const { buildPlatformGstr1 } = await import("@/server/platform-invoices/service");
    const g = await buildPlatformGstr1(period);
    report = { json: g.json, csv: g.csv, rows: g.counts.invoices + g.counts.notes, checksum: g.checksum };
  } else {
    report = type === "tcs" ? await buildTcsReport(period) : await buildTdsReport(period);
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.STATUTORY_REPORT_EXPORTED,
    entityType: "statutory_report",
    entityId: null,
    newValue: { type, period, rows: report.rows, checksum: report.checksum },
  });
  return report;
}
