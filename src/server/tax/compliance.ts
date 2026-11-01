/**
 * GoKesari's own statutory returns (billing v2, docs/billing §5.4, §5.5, §5.7):
 *
 *   GSTR8          TCS collected under s.52, supplier-wise and B2B / B2C by
 *                  place of supply, from the payout cycle's TCS lines (net of
 *                  returns); Enrolment-ID suppliers appear with no TCS. Due the
 *                  10th of the next month.
 *   GSTR1          GoKesari's fee invoices (platform-invoices) plus its s.9(5)
 *                  delivery-fee invoices to customers (Table 15). Due the 11th.
 *   GSTR3B         summary: outward taxable supplies (3.1(a)) and supplies on
 *                  which GoKesari pays tax under s.9(5) (3.1.1(i)). Due the 20th.
 *   TDS_STATEMENT  quarterly statement of TDS under s.393(1) (Form 140 data):
 *                  deductee-wise, full PAN for filing. Due 31 Jul / 31 Oct /
 *                  31 Jan / 31 May.
 *
 * Each generation is stored in statutory_filings with its payload and
 * checksum; a FILED period is never regenerated. The JSON layouts follow the
 * GST portal's offline-tool fields as far as they are public; GoKesari's CA /
 * GSP confirms them before filing (BLOCKERS.md B1, B2).
 */
import { createHash } from "node:crypto";

import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { gstState } from "@/lib/gst-states";
import { decryptSecret } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import {
  financialAdjustments,
  orderFinancials,
  payoutCycleLines,
  platformDeliveryInvoices,
  shops,
  statutoryFilings,
  users,
  type StatutoryFiling,
  type StatutoryReturnType,
  type UserRole,
} from "@/server/db/schema";
import { buildPlatformGstr1 } from "@/server/platform-invoices/service";
import { shopPan } from "@/server/payouts/cycle";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { effectiveRegistrationType } from "./engine";

const r2 = (paise: number) => Math.round(paise) / 100;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/* ------------------------------------------------------------- periods */

export function monthBounds(period: string): { from: string; to: string; fp: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw validationFailed("Choose a month (YYYY-MM).");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const to = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
  return { from: `${m[1]}-${m[2]}-01`, to, fp: `${m[2]}${m[1]}` };
}

/** "2026-27-Q3" → its months and the statement's due date. */
export function quarterBounds(quarter: string): { from: string; to: string; dueDate: string } {
  const m = /^(\d{4})-(\d{2})-Q([1-4])$/.exec(quarter);
  if (!m) throw validationFailed("Choose a quarter (e.g. 2026-27-Q3).");
  const fy = Number(m[1]);
  const q = Number(m[3]);
  const startMonth = [4, 7, 10, 1][q - 1];
  const year = q === 4 ? fy + 1 : fy;
  const from = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(year, startMonth - 1 + 3, 1)).toISOString().slice(0, 10);
  const dueDate = [`${fy}-07-31`, `${fy}-10-31`, `${fy + 1}-01-31`, `${fy + 1}-05-31`][q - 1];
  return { from, to: end, dueDate };
}

/** The quarter ("2026-27-Q3") a month ("2026-11") falls in. */
export function quarterOf(month: string): string {
  const [y, mo] = month.split("-").map(Number);
  const fy = mo >= 4 ? y : y - 1;
  const q = mo >= 4 && mo <= 6 ? 1 : mo >= 7 && mo <= 9 ? 2 : mo >= 10 ? 3 : 4;
  return `${fy}-${String((fy + 1) % 100).padStart(2, "0")}-Q${q}`;
}

const nextMonthDay = (period: string, day: number) => {
  const { to } = monthBounds(period);
  return `${to.slice(0, 8)}${String(day).padStart(2, "0")}`;
};

export function dueDateOf(type: StatutoryReturnType, period: string): string {
  if (type === "TDS_STATEMENT") return quarterBounds(period).dueDate;
  return nextMonthDay(period, type === "GSTR8" ? 10 : type === "GSTR1" ? 11 : 20);
}

/* -------------------------------------------------------------- GSTR-8 */

export const gstr8Schema = z.object({
  gstin: z.string().regex(/^\d{2}[A-Z0-9]{13}$/, "GoKesari's GSTIN is missing or malformed (Admin → Rules, platformTaxProfile)."),
  fp: z.string().regex(/^(0[1-9]|1[0-2])\d{4}$/),
  tcs: z.array(
    z.object({
      stin: z.string().min(15).max(15),
      supplierType: z.enum(["REGISTERED", "ENROLMENT_ID"]),
      supply: z.enum(["B2B", "B2C"]),
      pos: z.string().regex(/^\d{2}$/),
      grsval: z.number(),
      retsup: z.number().min(0),
      netval: z.number(),
      iamt: z.number(),
      camt: z.number(),
      samt: z.number(),
      flag: z.literal("N"),
    }),
  ),
  tcsa: z.array(z.unknown()),
  summary: z.object({ suppliers: z.number().int(), grsval: z.number(), retsup: z.number(), netval: z.number(), iamt: z.number(), camt: z.number(), samt: z.number() }),
});
export type Gstr8 = z.infer<typeof gstr8Schema>;

export async function buildGstr8(period: string): Promise<{ json: Gstr8; warnings: string[] }> {
  const { from, to, fp } = monthBounds(period);
  const profile = await getRule("platformTaxProfile");
  const warnings: string[] = [];
  const lines = await db
    .select()
    .from(payoutCycleLines)
    .where(and(eq(payoutCycleLines.lineType, "TCS"), gte(payoutCycleLines.occurredOn, from), lt(payoutCycleLines.occurredOn, to)));
  const shopIds = [...new Set(lines.map((l) => l.shopId))];

  // Enrolment-ID suppliers: no TCS, but their supplies through GoKesari are reported (§13 scenario 3).
  const enrolled = await db
    .select({ id: shops.id, gstEnrolmentId: shops.gstEnrolmentId, gstRegistrationType: shops.gstRegistrationType, gstStatus: shops.gstStatus, gstin: shops.gstin, state: shops.state, gstStateCode: shops.gstStateCode })
    .from(shops)
    .where(eq(shops.gstRegistrationType, "ENROLMENT_ID"));
  const shopRows = shopIds.length
    ? await db
        .select({ id: shops.id, gstin: shops.gstin, gstEnrolmentId: shops.gstEnrolmentId, gstRegistrationType: shops.gstRegistrationType, gstStatus: shops.gstStatus, state: shops.state, gstStateCode: shops.gstStateCode })
        .from(shops)
        .where(inArray(shops.id, shopIds))
    : [];
  const shopById = new Map([...shopRows, ...enrolled].map((s) => [s.id, s]));

  type Row = Gstr8["tcs"][number];
  const rows = new Map<string, Row>();
  const bucket = (stin: string, supplierType: Row["supplierType"], supply: Row["supply"], pos: string) => {
    const key = `${stin}|${supply}|${pos}`;
    const row = rows.get(key) ?? { stin, supplierType, supply, pos, grsval: 0, retsup: 0, netval: 0, iamt: 0, camt: 0, samt: 0, flag: "N" as const };
    rows.set(key, row);
    return row;
  };
  for (const l of lines) {
    const shop = shopById.get(l.shopId);
    const stin = shop?.gstin ?? null;
    if (!stin) {
      warnings.push(`TCS was collected from a shop without a GSTIN (${l.shopId}); left out — check its registration.`);
      continue;
    }
    const meta = l.meta as { b2b?: boolean; placeOfSupply?: string | null; igst?: number; cgst?: number; sgst?: number; supply?: string };
    const pos = gstState(meta.placeOfSupply ?? stin)?.code ?? stin.slice(0, 2);
    const row = bucket(stin, "REGISTERED", meta.b2b ? "B2B" : "B2C", pos);
    const base = l.basePaise ?? 0;
    if (base >= 0) row.grsval += base;
    else row.retsup += -base;
    row.iamt += meta.igst ?? 0;
    row.camt += meta.cgst ?? 0;
    row.samt += meta.sgst ?? 0;
  }
  if (enrolled.length) {
    const ids = enrolled.map((e) => e.id);
    const sales = await db
      .select({ shopId: orderFinancials.shopId, goods: sql<number>`coalesce(sum(${orderFinancials.goodsPaise}), 0)::bigint` })
      .from(orderFinancials)
      .where(and(inArray(orderFinancials.shopId, ids), gte(orderFinancials.deliveredAt, new Date(`${from}T00:00:00+05:30`)), lt(orderFinancials.deliveredAt, new Date(`${to}T00:00:00+05:30`))))
      .groupBy(orderFinancials.shopId);
    const refunds = await db
      .select({ shopId: financialAdjustments.shopId, amount: sql<number>`coalesce(sum(${financialAdjustments.customerRefundPaise}), 0)::bigint` })
      .from(financialAdjustments)
      .where(and(inArray(financialAdjustments.shopId, ids), eq(financialAdjustments.type, "REFUND_SHOP"), gte(financialAdjustments.createdAt, new Date(`${from}T00:00:00+05:30`)), lt(financialAdjustments.createdAt, new Date(`${to}T00:00:00+05:30`))))
      .groupBy(financialAdjustments.shopId);
    for (const e of enrolled) {
      if (effectiveRegistrationType(e) !== "ENROLMENT_ID") continue;
      const gross = Number(sales.find((s) => s.shopId === e.id)?.goods ?? 0);
      const ret = Number(refunds.find((r) => r.shopId === e.id)?.amount ?? 0);
      if (gross === 0 && ret === 0) continue;
      if (!e.gstEnrolmentId) {
        warnings.push(`An Enrolment-ID shop (${e.id}) has no enrolment id on record; left out.`);
        continue;
      }
      const pos = gstState(e.gstStateCode ?? e.state)?.code ?? "27";
      const row = bucket(e.gstEnrolmentId, "ENROLMENT_ID", "B2C", pos);
      row.grsval += gross;
      row.retsup += ret;
    }
  }
  const tcs = [...rows.values()].map((r) => ({ ...r, netval: r2(r.grsval - r.retsup), grsval: r2(r.grsval), retsup: r2(r.retsup), iamt: r2(r.iamt), camt: r2(r.camt), samt: r2(r.samt) }));
  const sum = (k: "grsval" | "retsup" | "netval" | "iamt" | "camt" | "samt") => Math.round(tcs.reduce((s, r) => s + r[k], 0) * 100) / 100;
  const json: Gstr8 = {
    gstin: profile.gstin,
    fp,
    tcs,
    tcsa: [],
    summary: { suppliers: new Set(tcs.map((t) => t.stin)).size, grsval: sum("grsval"), retsup: sum("retsup"), netval: sum("netval"), iamt: sum("iamt"), camt: sum("camt"), samt: sum("samt") },
  };
  const parsed = gstr8Schema.safeParse(json);
  if (!parsed.success) throw validationFailed(`GSTR-8 does not validate: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { json: parsed.data, warnings };
}

/* --------------------------------------- GoKesari's GSTR-1 (fees + s.9(5)) */

export async function buildGokesariGstr1(period: string): Promise<{ json: Record<string, unknown>; rows: number }> {
  const { from, to } = monthBounds(period);
  const base = await buildPlatformGstr1(period);
  const delivery = await db
    .select()
    .from(platformDeliveryInvoices)
    .where(and(eq(platformDeliveryInvoices.status, "ISSUED"), gte(platformDeliveryInvoices.issuedAt, new Date(`${from}T00:00:00+05:30`)), lt(platformDeliveryInvoices.issuedAt, new Date(`${to}T00:00:00+05:30`))))
    .orderBy(asc(platformDeliveryInvoices.financialYear), asc(platformDeliveryInvoices.sequence));
  // Table 15: supplies on which the ECO pays tax under s.9(5) — an unregistered rider's delivery
  // (unregistered supplier → unregistered customer, urp2c) and a restaurant's food (§5.3): a
  // registered restaurant's under its GSTIN (b2c, stin), an unregistered one's in urp2c.
  type Row = { stin?: string; pos: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number };
  const urp2c = new Map<string, Row>();
  const b2c = new Map<string, Row>();
  for (const d of delivery) {
    const pos = gstState(d.placeOfSupply ?? null)?.code ?? "";
    const stin = d.kind === "RESTAURANT" ? ((d.snapshot as { onBehalfOf?: { gstin: string | null } }).onBehalfOf?.gstin ?? undefined) : undefined;
    const into = stin ? b2c : urp2c;
    const key = `${stin ?? ""}|${pos}|${d.rateBp}`;
    const row = into.get(key) ?? { ...(stin ? { stin } : {}), pos, rt: d.rateBp / 100, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    row.txval += d.taxablePaise;
    row.iamt += d.igstPaise;
    row.camt += d.cgstPaise;
    row.samt += d.sgstPaise;
    into.set(key, row);
  }
  const rupees = (rows: Map<string, Row>) => [...rows.values()].map((r) => ({ ...r, txval: r2(r.txval), iamt: r2(r.iamt), camt: r2(r.camt), samt: r2(r.samt) }));
  const json = {
    ...base.json,
    ...(delivery.length
      ? {
          ecom: { ...(urp2c.size ? { urp2c: rupees(urp2c) } : {}), ...(b2c.size ? { b2c: rupees(b2c) } : {}) },
          s95_doc_issue: { from: delivery[0].invoiceNumber, to: delivery[delivery.length - 1].invoiceNumber, totnum: delivery.length },
        }
      : {}),
  };
  return { json, rows: base.counts.invoices + base.counts.notes + delivery.length };
}

/* ------------------------------------------------------------- GSTR-3B */

export async function buildGokesariGstr3b(period: string): Promise<{ json: Record<string, unknown>; rows: number }> {
  const g1 = await buildGokesariGstr1(period);
  type Amounts = { txval: number; iamt: number; camt: number; samt: number };
  const j = g1.json as { b2b?: { inv: { itms: { itm_det: { txval: number; iamt?: number; camt?: number; samt?: number } }[] }[] }[]; b2cs?: Amounts[]; ecom?: { urp2c?: Amounts[]; b2c?: Amounts[] } };
  const own = { txval: 0, iamt: 0, camt: 0, samt: 0 };
  for (const party of j.b2b ?? []) for (const inv of party.inv) for (const it of inv.itms) {
    own.txval += it.itm_det.txval;
    own.iamt += it.itm_det.iamt ?? 0;
    own.camt += it.itm_det.camt ?? 0;
    own.samt += it.itm_det.samt ?? 0;
  }
  for (const b of j.b2cs ?? []) {
    own.txval += b.txval;
    own.iamt += b.iamt;
    own.camt += b.camt;
    own.samt += b.samt;
  }
  const s95 = { txval: 0, iamt: 0, camt: 0, samt: 0 };
  for (const r of [...(j.ecom?.urp2c ?? []), ...(j.ecom?.b2c ?? [])]) {
    s95.txval += r.txval;
    s95.iamt += r.iamt;
    s95.camt += r.camt;
    s95.samt += r.samt;
  }
  const round = (o: typeof own) => ({ txval: Math.round(o.txval * 100) / 100, iamt: Math.round(o.iamt * 100) / 100, camt: Math.round(o.camt * 100) / 100, samt: Math.round(o.samt * 100) / 100, csamt: 0 });
  const profile = await getRule("platformTaxProfile");
  return {
    json: {
      gstin: profile.gstin,
      ret_period: monthBounds(period).fp,
      sup_details: { osup_det: round({ txval: own.txval + s95.txval, iamt: own.iamt + s95.iamt, camt: own.camt + s95.camt, samt: own.samt + s95.samt }) },
      eco_dtls: { eco_sup: round(s95) },
      note: "Output tax only. Input tax credit, interest and late fee are entered by GoKesari's CA on the portal.",
    },
    rows: g1.rows,
  };
}

/* ------------------------------------------------- TDS statement (Form 140) */

export async function buildTdsStatement(quarter: string): Promise<{ json: Record<string, unknown>; csv: string; rows: number }> {
  const { from, to } = quarterBounds(quarter);
  const lines = await db
    .select()
    .from(payoutCycleLines)
    .where(and(eq(payoutCycleLines.lineType, "TDS"), gte(payoutCycleLines.occurredOn, from), lt(payoutCycleLines.occurredOn, to)));
  const shopIds = [...new Set(lines.map((l) => l.shopId))];
  const shopRows = shopIds.length ? await db.select().from(shops).where(inArray(shops.id, shopIds)) : [];
  type Deductee = { pan: string; name: string; section: string; amountPaid: number; tds: number; exemptBase: number; noPan: boolean; rateBp: number; lastDate: string };
  const byPan = new Map<string, Deductee>();
  for (const l of lines) {
    const shop = shopRows.find((s) => s.id === l.shopId);
    const pan = shop ? shopPan(shop) : null;
    const key = pan ?? `NOPAN:${l.shopId}`;
    const m = l.meta as { section?: string; exempt?: boolean; panAvailable?: boolean };
    const d = byPan.get(key) ?? { pan: pan ?? "PANNOTAVBL", name: shop?.legalBusinessName ?? shop?.name ?? "", section: m.section ?? "s.393(1)", amountPaid: 0, tds: 0, exemptBase: 0, noPan: !pan, rateBp: l.rateBp ?? 0, lastDate: l.occurredOn };
    if (m.exempt) d.exemptBase += l.basePaise ?? 0;
    else d.amountPaid += l.basePaise ?? 0;
    d.tds += -l.amountPaise;
    if (l.occurredOn > d.lastDate) d.lastDate = l.occurredOn;
    if ((l.rateBp ?? 0) > 0) d.rateBp = l.rateBp!;
    byPan.set(key, d);
  }
  const deductees = [...byPan.values()];
  const header = ["deductee_pan", "deductee_name", "section", "amount_paid_or_credited_inr", "exempt_amount_inr", "rate_percent", "tds_inr", "last_credit_date", "higher_rate_no_pan"];
  const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [header.join(","), ...deductees.map((d) => [d.pan, d.name, d.section, r2(d.amountPaid), r2(d.exemptBase), d.rateBp / 100, r2(d.tds), d.lastDate, d.noPan ? "Y" : "N"].map(cell).join(","))].join("\n") + "\n";
  return {
    json: {
      quarter,
      note: "Quarterly statement of TDS on e-commerce participants (s.393(1) Income-tax Act 2025, ex-194O) — Form 140 data. Full PANs: handle as confidential.",
      deductees: deductees.map((d) => ({ ...d, amountPaid: r2(d.amountPaid), exemptBase: r2(d.exemptBase), tds: r2(d.tds) })),
      totals: { deductees: deductees.length, amountPaid: r2(deductees.reduce((s, d) => s + d.amountPaid, 0)), tds: r2(deductees.reduce((s, d) => s + d.tds, 0)) },
    },
    csv,
    rows: deductees.length,
  };
}

/* ------------------------------------------------------- filing records */

export async function generateFiling(type: StatutoryReturnType, period: string, actor: { id: string; role: UserRole }): Promise<StatutoryFiling> {
  const profile = await getRule("platformTaxProfile");
  const registration = type === "TDS_STATEMENT" ? (profile.pan || "GOKESARI") : profile.gstin;
  if (!registration) throw conflict("GoKesari's GSTIN is not set (Admin → Rules, platformTaxProfile).");
  let payload: Record<string, unknown>;
  let rows: number;
  if (type === "GSTR8") {
    const g = await buildGstr8(period);
    payload = { ...g.json, warnings: g.warnings };
    rows = g.json.tcs.length;
  } else if (type === "GSTR1") {
    ({ json: payload, rows } = await buildGokesariGstr1(period));
  } else if (type === "GSTR3B") {
    ({ json: payload, rows } = await buildGokesariGstr3b(period));
  } else {
    const t = await buildTdsStatement(period);
    payload = t.json;
    rows = t.rows;
  }
  const checksum = sha(payload);
  const dueDate = dueDateOf(type, period);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(statutoryFilings)
      .where(and(eq(statutoryFilings.returnType, type), eq(statutoryFilings.period, period), eq(statutoryFilings.registration, registration)))
      .for("update");
    if (existing?.status === "FILED") throw conflict(`${type} for ${period} is already filed (${existing.acknowledgement ?? "no acknowledgement"}): correct it by amendment in the next return.`);
    const values = { payload, checksum, rows, dueDate, generatedAt: new Date(), generatedBy: actor.id, status: "GENERATED" as const };
    const [row] = existing
      ? await tx.update(statutoryFilings).set(values).where(eq(statutoryFilings.id, existing.id)).returning()
      : await tx.insert(statutoryFilings).values({ returnType: type, period, registration, ...values }).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STATUTORY_REPORT_EXPORTED, entityType: "statutory_filing", entityId: row.id, newValue: { type, period, rows, checksum } }, tx);
    return row;
  });
}

export async function markFiled(id: string, acknowledgement: string, actor: { id: string; role: UserRole }): Promise<StatutoryFiling> {
  const ack = acknowledgement.trim();
  if (ack.length < 5) throw validationFailed("Enter the ARN / acknowledgement number from the portal.");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(statutoryFilings).where(eq(statutoryFilings.id, id)).for("update");
    if (!row) throw notFound("Filing");
    if (row.status === "FILED") return row;
    const [updated] = await tx.update(statutoryFilings).set({ status: "FILED", filedAt: new Date(), filedBy: actor.id, acknowledgement: ack }).where(eq(statutoryFilings.id, id)).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STATUTORY_RETURN_FILED, entityType: "statutory_filing", entityId: id, newValue: { type: row.returnType, period: row.period, acknowledgement: ack } }, tx);
    return updated;
  });
}

export async function getFiling(id: string): Promise<StatutoryFiling> {
  const [row] = await db.select().from(statutoryFilings).where(eq(statutoryFilings.id, id));
  if (!row) throw notFound("Filing");
  return row;
}

/** The statement CSV with full PANs, for the TDS filing utility. Admin only; audited. */
export async function tdsStatementCsv(quarter: string, actor: { id: string; role: UserRole }): Promise<string> {
  const t = await buildTdsStatement(quarter);
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SHOP_PAN_REVEALED, entityType: "tds_statement", entityId: quarter, newValue: { quarter, deductees: t.rows } });
  return t.csv;
}

/* ------------------------------------------------------ compliance calendar */

export interface ComplianceItem {
  returnType: StatutoryReturnType;
  period: string;
  label: string;
  dueDate: string;
  status: "NOT_GENERATED" | "GENERATED" | "SUBMITTED" | "FILED";
  daysLeft: number;
  filingId: string | null;
}

const LABEL: Record<StatutoryReturnType, string> = {
  GSTR8: "GSTR-8 (TCS collected)",
  GSTR1: "GSTR-1 (GoKesari's supplies)",
  GSTR3B: "GSTR-3B (GoKesari)",
  TDS_STATEMENT: "TDS statement (Form 140)",
};

const addMonths = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/** Returns due from last month to two months ahead, with their status. */
export async function complianceCalendar(today: string): Promise<ComplianceItem[]> {
  const thisMonth = today.slice(0, 7);
  const months = [-2, -1, 0, 1].map((n) => addMonths(thisMonth, n));
  const wanted: { returnType: StatutoryReturnType; period: string }[] = [];
  for (const m of months) for (const t of ["GSTR8", "GSTR1", "GSTR3B"] as const) wanted.push({ returnType: t, period: m });
  for (const q of new Set(months.map(quarterOf))) wanted.push({ returnType: "TDS_STATEMENT", period: q });
  const filings = await db.select().from(statutoryFilings).where(inArray(statutoryFilings.period, [...new Set(wanted.map((w) => w.period))]));
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  return wanted
    .map(({ returnType, period }) => {
      const dueDate = dueDateOf(returnType, period);
      const f = filings.find((x) => x.returnType === returnType && x.period === period);
      return { returnType, period, label: `${LABEL[returnType]} — ${period}`, dueDate, status: f?.status ?? ("NOT_GENERATED" as const), daysLeft: Math.round((day(dueDate) - day(today)) / 86_400_000), filingId: f?.id ?? null };
    })
    // A period is due once it has ended; show what is due within ~45 days, and anything overdue not filed.
    .filter((i) => i.dueDate >= addMonths(thisMonth, -1) + "-01" && i.dueDate <= addMonths(thisMonth, 2) + "-01" && (i.status !== "FILED" || i.daysLeft >= -31))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.returnType.localeCompare(b.returnType));
}

/** Daily: tells every admin about returns due within `days` (or overdue) that are not filed. One message per return and period. */
export async function sendComplianceReminders(today: string, days = 3): Promise<{ sent: number }> {
  const due = (await complianceCalendar(today)).filter((i) => i.status !== "FILED" && i.daysLeft <= days);
  if (!due.length) return { sent: 0 };
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "ADMIN"));
  let sent = 0;
  for (const item of due) {
    for (const admin of admins) {
      await notify({
        userId: admin.id,
        type: NOTIFICATION_TYPES.ADMIN_COMPLIANCE_DUE,
        title: item.daysLeft < 0 ? `Overdue: ${item.label}` : `${item.label} is due on ${item.dueDate}`,
        body: `${item.label} is ${item.daysLeft < 0 ? `overdue by ${-item.daysLeft} day(s)` : item.daysLeft === 0 ? "due today" : `due in ${item.daysLeft} day(s)`} (${item.status === "NOT_GENERATED" ? "not generated yet" : item.status.toLowerCase()}).`,
        actionUrl: "/admin/compliance",
        dedupeKey: `compliance-due:${item.returnType}:${item.period}:${item.daysLeft < 0 ? "overdue" : "due"}`,
      });
      sent += 1;
    }
  }
  return { sent };
}

/* ------------------------------------------ per-shop TCS / TDS statements */

export interface ShopTaxStatement {
  shopId: string;
  period: string;
  gstin: string | null;
  panMasked: string | null;
  tcs: { grossPaise: number; returnsPaise: number; netPaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; ratePercent: number | null };
  tds: { basePaise: number; exemptBasePaise: number; tdsPaise: number; section: string | null };
  orders: number;
}

/** The shop's TCS (monthly, matches its GSTR-2B "TCS credit") and TDS for a month, from the payout lines. */
export async function shopTaxStatement(shopId: string, period: string): Promise<ShopTaxStatement> {
  const { from, to } = monthBounds(period);
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  const lines = await db
    .select()
    .from(payoutCycleLines)
    .where(and(eq(payoutCycleLines.shopId, shopId), inArray(payoutCycleLines.lineType, ["TCS", "TDS", "GOODS"]), gte(payoutCycleLines.occurredOn, from), lt(payoutCycleLines.occurredOn, to)));
  const out: ShopTaxStatement = {
    shopId,
    period,
    gstin: shop.gstin,
    panMasked: (() => {
      const pan = shopPan(shop);
      return pan ? `XXXXXX${pan.slice(6)}` : null;
    })(),
    tcs: { grossPaise: 0, returnsPaise: 0, netPaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, ratePercent: null },
    tds: { basePaise: 0, exemptBasePaise: 0, tdsPaise: 0, section: null },
    orders: 0,
  };
  for (const l of lines) {
    if (l.lineType === "GOODS") out.orders += 1;
    if (l.lineType === "TCS") {
      const m = l.meta as { igst?: number; cgst?: number; sgst?: number };
      const base = l.basePaise ?? 0;
      if (base >= 0) out.tcs.grossPaise += base;
      else out.tcs.returnsPaise += -base;
      out.tcs.igstPaise += m.igst ?? 0;
      out.tcs.cgstPaise += m.cgst ?? 0;
      out.tcs.sgstPaise += m.sgst ?? 0;
      if (l.rateBp) out.tcs.ratePercent = l.rateBp / 100;
    }
    if (l.lineType === "TDS") {
      const m = l.meta as { exempt?: boolean; section?: string };
      if (m.exempt) out.tds.exemptBasePaise += l.basePaise ?? 0;
      else out.tds.basePaise += l.basePaise ?? 0;
      out.tds.tdsPaise += -l.amountPaise;
      out.tds.section = m.section ?? out.tds.section;
    }
  }
  out.tcs.netPaise = out.tcs.grossPaise - out.tcs.returnsPaise;
  return out;
}

/* ------------------------------------------------ order-level settlement */

/** One row per order (and per refund / fee) of the shop's payout lines in a month — the settlement report (§5.6, G10). */
export async function orderSettlementReport(shopId: string, period: string): Promise<{ rows: (string | number)[][]; header: string[] }> {
  const { from, to } = monthBounds(period);
  const lines = await db
    .select()
    .from(payoutCycleLines)
    .where(and(eq(payoutCycleLines.shopId, shopId), gte(payoutCycleLines.occurredOn, from), lt(payoutCycleLines.occurredOn, to)))
    .orderBy(asc(payoutCycleLines.occurredOn));
  const header = ["date", "reference", "goods_inr", "commission_inr", "delivery_charge_inr", "fee_gst_inr", "tcs_inr", "tds_inr", "refunds_inr", "other_inr", "net_payable_inr"];
  const byRef = new Map<string, { date: string; ref: string; cols: Record<string, number> }>();
  for (const l of lines) {
    const meta = l.meta as { orderNumber?: string; orderId?: string };
    const ref = meta.orderNumber ?? (l.sourceType === "order_financials" ? l.sourceId : `${l.lineType} ${l.description}`);
    const row = byRef.get(ref) ?? { date: l.occurredOn, ref, cols: {} };
    const col =
      l.lineType === "GOODS" ? "goods" : l.lineType === "COMMISSION" ? "commission" : l.lineType === "DELIVERY_CHARGE" ? "delivery" : l.lineType === "FEE_GST" ? "feeGst" : l.lineType === "TCS" ? "tcs" : l.lineType === "TDS" ? "tds" : l.lineType === "REFUND" ? "refunds" : "other";
    row.cols[col] = (row.cols[col] ?? 0) + (col === "delivery" ? -((l.meta as { chargePaise?: number }).chargePaise ?? 0) : l.amountPaise);
    byRef.set(ref, row);
  }
  const rows = [...byRef.values()].map((r) => {
    const c = (k: string) => r.cols[k] ?? 0;
    const net = c("goods") + c("commission") + c("feeGst") + c("tcs") + c("tds") + c("refunds") + c("other");
    return [r.date, r.ref, r2(c("goods")), r2(c("commission")), r2(c("delivery")), r2(c("feeGst")), r2(c("tcs")), r2(c("tds")), r2(c("refunds")), r2(c("other")), r2(net)];
  });
  return { header, rows };
}

/** Decrypts nothing but tells callers whether a full PAN exists (for the UI). */
export function hasPan(shop: { gstin: string | null; panNumberEncrypted: string | null }): boolean {
  if (shop.gstin) return true;
  if (!shop.panNumberEncrypted) return false;
  try {
    return /^[A-Z]{5}\d{4}[A-Z]$/.test(decryptSecret(shop.panNumberEncrypted).trim().toUpperCase());
  } catch {
    return false;
  }
}

