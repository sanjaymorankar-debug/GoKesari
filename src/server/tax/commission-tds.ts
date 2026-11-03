/**
 * TDS on dealer and team-member commission (gap report Part D; rule
 * dealerPayoutTds, off until the CA confirms).
 *
 *   D1  dated rows (commission_tds_rates): payee type, PAN status, rate, annual
 *       threshold, mode, the section as free text, effective dates, CA confirmation
 *   D2  lower / nil certificates per payee (by PAN), with validity and a limit
 *   D3  per PAN per financial year (April–March, IST): CATCH_UP — once past the
 *       threshold the whole year is taxed, less TDS already deducted — or
 *       EXCESS_ONLY — only the part above it; the row, section and certificate
 *       are kept on the payout; an unconfirmed (or missing) row blocks paying
 *       until an admin overrides with a reason; a reversal crossing a financial
 *       year is flagged for the CA
 *   D5  challans per month, the quarterly 26Q data, Form 16A per payee and
 *       quarter (PDF, encrypted), and the exceptions list
 *   D6  the payee's own view: PAN status, rate, TDS this year, 16A downloads
 *
 * Only users with STATUTORY_MANAGE change rows (ADMIN and CA); only
 * COMMISSION_TDS_MANAGE keeps certificates, challans and Form 16A (ADMIN and
 * CA) — checked here. Every change is audited with the old and new value.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { decryptBytes, decryptSecret, encryptBytes } from "@/lib/pan-crypto";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  commissionTdsCertificates,
  commissionTdsChallans,
  commissionTdsForms16a,
  commissionTdsRates,
  dealerCommissionLedger,
  dealerPayoutBatches,
  dealerSalespeople,
  dealers,
  type CommissionTdsCertificate,
  type CommissionTdsRate,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";

interface Actor {
  id: string;
  role: UserRole;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

function requirePermission(actor: Actor, permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS], what: string) {
  if (!can(actor.role, permission)) throw forbidden(`Only an admin or the CA can ${what}.`);
}

/* ================================================================= years */

/**
 * The month a payout's TDS belongs to: its period month (month close), or for a payout an admin made
 * by hand (no period month) the IST month it was made in — so its TDS is in 26Q and Form 16A too.
 */
const batchMonthSql = sql<string>`coalesce(${dealerPayoutBatches.periodMonth}, to_char(${dealerPayoutBatches.createdAt} at time zone 'Asia/Kolkata', 'YYYY-MM'))`;
function batchMonth(b: { periodMonth: string | null; createdAt: Date }): string {
  return b.periodMonth ?? new Date(b.createdAt.getTime() + 330 * 60_000).toISOString().slice(0, 7);
}

/** The financial year (IST) an instant falls in, as "2026-27" with its first and last day. */
export function financialYear(at: Date): { label: string; from: string; to: string } {
  const d = istDay(at);
  const y = Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0);
  return { label: `${y}-${String((y + 1) % 100).padStart(2, "0")}`, from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

/** Quarter 1–4 of the financial year (Apr–Jun = 1). */
export function fyQuarter(month: string): number {
  const m = Number(month.slice(5, 7));
  return m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
}

/* ============================================================== D1 rows */

export type PayeeType = CommissionTdsRate["payeeType"];

/** The payee type a dealer's legal form maps to; a team member is an individual. */
export function payeeTypeFor(dealerType: string | null): PayeeType {
  if (dealerType === "PARTNERSHIP") return "FIRM";
  if (dealerType === "COMPANY") return "COMPANY";
  return "INDIVIDUAL";
}

export async function listCommissionTdsRates(): Promise<CommissionTdsRate[]> {
  return db.select().from(commissionTdsRates).orderBy(asc(commissionTdsRates.payeeType), asc(commissionTdsRates.panStatus), desc(commissionTdsRates.effectiveFrom));
}

/** The row in force for a payee type and PAN status on a day: the exact type first, then ANY. */
export async function rateFor(payeeType: PayeeType, panStatus: CommissionTdsRate["panStatus"], day: string, client: DbClient = db): Promise<CommissionTdsRate | null> {
  const rows = await client
    .select()
    .from(commissionTdsRates)
    .where(
      and(
        inArray(commissionTdsRates.payeeType, [payeeType, "ANY"]),
        eq(commissionTdsRates.panStatus, panStatus),
        lte(commissionTdsRates.effectiveFrom, day),
        or(isNull(commissionTdsRates.effectiveTo), gte(commissionTdsRates.effectiveTo, day)),
      ),
    );
  return rows.sort((a, b) => (a.payeeType === "ANY" ? 1 : 0) - (b.payeeType === "ANY" ? 1 : 0) || b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

export interface RateInput {
  payeeType: PayeeType;
  panStatus: CommissionTdsRate["panStatus"];
  rateBp: number;
  thresholdPaise: number;
  mode: CommissionTdsRate["mode"];
  section: string;
  effectiveFrom: string;
  note?: string | null;
}

/**
 * A new dated row (STATUTORY_MANAGE). The previous open row of the same payee
 * type and PAN status is closed the day before. Never confirmed on creation.
 */
export async function addCommissionTdsRate(input: RateInput, actor: Actor): Promise<CommissionTdsRate> {
  requirePermission(actor, PERMISSIONS.STATUTORY_MANAGE, "change TDS settings");
  if (!Number.isInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > 10_000) throw validationFailed("Rate: 0% to 100%.");
  if (!Number.isInteger(input.thresholdPaise) || input.thresholdPaise < 0) throw validationFailed("Threshold: whole paise, 0 or more.");
  if (!DATE.test(input.effectiveFrom)) throw validationFailed("Effective from: YYYY-MM-DD.");
  const section = input.section.trim();
  if (section.length < 3) throw validationFailed("Give the section (free text, as the CA gives it).");
  return db.transaction(async (tx) => {
    const [open] = await tx
      .select()
      .from(commissionTdsRates)
      .where(and(eq(commissionTdsRates.payeeType, input.payeeType), eq(commissionTdsRates.panStatus, input.panStatus), isNull(commissionTdsRates.effectiveTo)))
      .for("update");
    if (open && open.effectiveFrom >= input.effectiveFrom) throw conflict(`A row from ${open.effectiveFrom} is already open; start the new one after it.`);
    if (open) {
      const dayBefore = new Date(Date.parse(`${input.effectiveFrom}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      await tx.update(commissionTdsRates).set({ effectiveTo: dayBefore, updatedBy: actor.id, updatedAt: new Date() }).where(eq(commissionTdsRates.id, open.id));
    }
    const [row] = await tx
      .insert(commissionTdsRates)
      .values({ payeeType: input.payeeType, panStatus: input.panStatus, rateBp: input.rateBp, thresholdPaise: input.thresholdPaise, mode: input.mode, section, effectiveFrom: input.effectiveFrom, note: input.note?.trim() || null, updatedBy: actor.id })
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STATUTORY_RATE_CHANGED, entityType: "commission_tds_rate", entityId: row.id, previousValue: open ? { closedRowId: open.id } : null, newValue: { ...input, section } }, tx);
    return row;
  });
}

/**
 * The CA confirms a row (only the CA role — "CA-confirmed" means the CA said
 * so), or anyone with STATUTORY_MANAGE withdraws the confirmation.
 */
export async function setCommissionTdsConfirmation(rateId: string, confirmed: boolean, actor: Actor, note?: string | null): Promise<CommissionTdsRate> {
  requirePermission(actor, PERMISSIONS.STATUTORY_MANAGE, "confirm TDS settings");
  if (confirmed && actor.role !== "CA") throw forbidden("Only the CA confirms a TDS row.");
  const [before] = await db.select().from(commissionTdsRates).where(eq(commissionTdsRates.id, rateId));
  if (!before) throw notFound("TDS row");
  const [after] = await db
    .update(commissionTdsRates)
    .set({ confirmedByCa: confirmed, confirmedBy: confirmed ? actor.id : null, confirmedAt: confirmed ? new Date() : null, note: note?.trim() || before.note, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(commissionTdsRates.id, rateId))
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STATUTORY_RATE_CHANGED, entityType: "commission_tds_rate", entityId: rateId, previousValue: { confirmedByCa: before.confirmedByCa }, newValue: { confirmedByCa: confirmed, note } });
  return after;
}

/* ========================================================== D2 certificates */

export interface CertificateInput {
  panHash: string;
  payeeLabel: string;
  certificateNumber: string;
  rateBp: number;
  validFrom: string;
  validTo: string;
  limitPaise?: number | null;
  note?: string | null;
}

export async function addTdsCertificate(input: CertificateInput, actor: Actor): Promise<CommissionTdsCertificate> {
  requirePermission(actor, PERMISSIONS.COMMISSION_TDS_MANAGE, "record TDS certificates");
  if (!DATE.test(input.validFrom) || !DATE.test(input.validTo) || input.validTo < input.validFrom) throw validationFailed("Validity: YYYY-MM-DD, the end on or after the start.");
  if (!Number.isInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > 10_000) throw validationFailed("Rate: 0% (nil) to 100%.");
  if (!input.certificateNumber.trim()) throw validationFailed("Give the certificate number.");
  const [row] = await db
    .insert(commissionTdsCertificates)
    .values({
      panHash: input.panHash,
      payeeLabel: input.payeeLabel,
      certificateNumber: input.certificateNumber.trim(),
      rateBp: input.rateBp,
      validFrom: input.validFrom,
      validTo: input.validTo,
      limitPaise: input.limitPaise ?? null,
      note: input.note?.trim() || null,
      createdBy: actor.id,
    })
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STATUTORY_RATE_CHANGED, entityType: "commission_tds_certificate", entityId: row.id, newValue: { ...input, panHash: undefined } });
  return row;
}

export async function withdrawTdsCertificate(certificateId: string, reason: string, actor: Actor): Promise<void> {
  requirePermission(actor, PERMISSIONS.COMMISSION_TDS_MANAGE, "withdraw TDS certificates");
  if (reason.trim().length < 5) throw validationFailed("Give the reason.");
  const [row] = await db.update(commissionTdsCertificates).set({ status: "WITHDRAWN" }).where(eq(commissionTdsCertificates.id, certificateId)).returning();
  if (!row) throw notFound("Certificate");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STATUTORY_RATE_CHANGED, entityType: "commission_tds_certificate", entityId: certificateId, previousValue: { status: "ACTIVE" }, newValue: { status: "WITHDRAWN", reason } });
}

export async function listTdsCertificates(): Promise<CommissionTdsCertificate[]> {
  return db.select().from(commissionTdsCertificates).orderBy(desc(commissionTdsCertificates.validFrom)).limit(1000);
}

/* ============================================================ D3 compute */

export interface CommissionTds {
  tdsPaise: number;
  rateBp: number;
  rateId: string | null;
  section: string | null;
  certificateId: string | null;
  /** UNCONFIRMED_RATE or NO_RATE: paying is blocked until an admin overrides. */
  flag: "UNCONFIRMED_RATE" | "NO_RATE" | null;
}

/** Pure: the deduction on one payout under a row (and certificate), given the year so far. */
export function deduction(input: {
  grossPaise: number;
  yearGrossBeforePaise: number;
  yearTdsBeforePaise: number;
  rate: Pick<CommissionTdsRate, "rateBp" | "thresholdPaise" | "mode">;
  certificate?: Pick<CommissionTdsCertificate, "rateBp" | "limitPaise"> | null;
}): number {
  const { grossPaise, yearGrossBeforePaise: before, yearTdsBeforePaise: tdsBefore, rate } = input;
  if (grossPaise <= 0) return 0;
  const cert = input.certificate;
  if (cert) {
    // A certificate's rate up to its limit; the normal rate above it (no catch-up on certified money).
    const room = cert.limitPaise == null ? grossPaise : Math.max(0, cert.limitPaise - before);
    const within = Math.min(grossPaise, room);
    return Math.min(grossPaise, Math.round((within * cert.rateBp) / 10_000) + Math.round(((grossPaise - within) * rate.rateBp) / 10_000));
  }
  const year = before + grossPaise;
  if (year <= rate.thresholdPaise) return 0;
  const due = rate.mode === "EXCESS_ONLY" ? Math.round(((year - rate.thresholdPaise) * rate.rateBp) / 10_000) - tdsBefore : Math.round((year * rate.rateBp) / 10_000) - tdsBefore;
  return Math.max(0, Math.min(grossPaise, due));
}

/**
 * The TDS on a payout of `grossPaise` to a PAN (or a payee without one) at
 * `at`: the year so far is summed over every payout to the same PAN.
 */
export async function computeCommissionTds(
  client: DbClient,
  input: { panHash: string | null; payeeType: PayeeType; grossPaise: number; at: Date; dealerId: string; memberId: string | null },
): Promise<CommissionTds> {
  const none: CommissionTds = { tdsPaise: 0, rateBp: 0, rateId: null, section: null, certificateId: null, flag: null };
  if (!(await getRule("dealerPayoutTds")).enabled || input.grossPaise <= 0) return none;
  const day = istDay(input.at);
  const rate = await rateFor(input.payeeType, input.panHash ? "PAN_OK" : "NO_PAN", day, client);
  if (!rate) return { ...none, flag: "NO_RATE" };
  const fy = financialYear(input.at);
  const [year] = await client
    .select({ gross: sql<number>`coalesce(sum(${dealerPayoutBatches.totalPaise}), 0)::bigint`, tds: sql<number>`coalesce(sum(${dealerPayoutBatches.tdsPaise}), 0)::bigint` })
    .from(dealerPayoutBatches)
    .where(
      and(
        input.panHash
          ? eq(dealerPayoutBatches.payeePanHash, input.panHash)
          : and(eq(dealerPayoutBatches.dealerId, input.dealerId), input.memberId ? eq(dealerPayoutBatches.memberId, input.memberId) : isNull(dealerPayoutBatches.memberId)),
        inArray(dealerPayoutBatches.status, ["DRAFT", "APPROVED", "PROCESSING", "FAILED", "PAID"]),
        sql`coalesce(to_date(${dealerPayoutBatches.periodMonth}, 'YYYY-MM'), (${dealerPayoutBatches.createdAt} at time zone 'Asia/Kolkata')::date) between ${fy.from}::date and ${fy.to}::date`,
      ),
    );
  const [certificate] = input.panHash
    ? await client
        .select()
        .from(commissionTdsCertificates)
        .where(and(eq(commissionTdsCertificates.panHash, input.panHash), eq(commissionTdsCertificates.status, "ACTIVE"), lte(commissionTdsCertificates.validFrom, day), gte(commissionTdsCertificates.validTo, day)))
        .orderBy(desc(commissionTdsCertificates.validFrom))
        .limit(1)
    : [];
  const tdsPaise = deduction({ grossPaise: input.grossPaise, yearGrossBeforePaise: Number(year?.gross ?? 0), yearTdsBeforePaise: Number(year?.tds ?? 0), rate, certificate: certificate ?? null });
  return {
    tdsPaise,
    rateBp: certificate ? certificate.rateBp : rate.rateBp,
    rateId: rate.id,
    section: rate.section,
    certificateId: certificate?.id ?? null,
    flag: rate.confirmedByCa ? null : "UNCONFIRMED_RATE",
  };
}

/** Why a payout cannot be approved or paid for its TDS (an unconfirmed or missing row, not overridden), or null. */
export function tdsBlock(b: { tdsFlag: string | null; tdsOverrideReason: string | null }): string | null {
  if ((b.tdsFlag === "UNCONFIRMED_RATE" || b.tdsFlag === "NO_RATE") && !b.tdsOverrideReason) {
    return b.tdsFlag === "NO_RATE" ? "No TDS row applies to this payee (Admin → TDS on commission)." : "Its TDS row is not confirmed by the CA.";
  }
  return null;
}

/** ADMIN: pays a payout whose TDS row is unconfirmed anyway — the reason is kept on the payout and audited. */
export async function overrideTdsBlock(batchId: string, reason: string, actor: Actor): Promise<void> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can override the TDS block.");
  const why = reason.trim();
  if (why.length < 10) throw validationFailed("Give the reason (it is kept on the payout for the CA).");
  const [b] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batchId));
  if (!b) throw notFound("Payout");
  if (!tdsBlock(b)) throw conflict("This payout is not blocked for TDS.");
  await db.update(dealerPayoutBatches).set({ tdsOverrideReason: why.slice(0, 500), tdsOverrideBy: actor.id }).where(eq(dealerPayoutBatches.id, batchId));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: batchId, newValue: { tdsOverride: true, flag: b.tdsFlag, reason: why } });
}

/* ========================================================= D5 challans etc. */

export interface ChallanInput {
  periodMonth: string;
  section: string;
  amountPaise: number;
  bsrCode: string;
  challanSerial: string;
  depositedOn: string;
  note?: string | null;
}

export async function addTdsChallan(input: ChallanInput, actor: Actor) {
  requirePermission(actor, PERMISSIONS.COMMISSION_TDS_MANAGE, "record TDS challans");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.periodMonth) || !DATE.test(input.depositedOn)) throw validationFailed("Month YYYY-MM and deposit date YYYY-MM-DD.");
  if (!/^\d{7}$/.test(input.bsrCode)) throw validationFailed("The BSR code is 7 digits.");
  if (!input.challanSerial.trim() || !Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw validationFailed("Give the challan serial and amount.");
  const [row] = await db
    .insert(commissionTdsChallans)
    .values({ periodMonth: input.periodMonth, section: input.section, amountPaise: input.amountPaise, bsrCode: input.bsrCode, challanSerial: input.challanSerial.trim(), depositedOn: input.depositedOn, note: input.note?.trim() || null, createdBy: actor.id })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict("That challan is already recorded.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STATUTORY_RATE_CHANGED, entityType: "commission_tds_challan", entityId: row.id, newValue: { ...input } });
  return row;
}

export async function listTdsChallans() {
  return db.select().from(commissionTdsChallans).orderBy(desc(commissionTdsChallans.periodMonth)).limit(500);
}

export interface DeductionRow {
  batchId: string;
  periodMonth: string;
  payeeName: string;
  panMasked: string;
  /** Full PAN only for the 26Q export (admin / CA, audited). */
  pan: string | null;
  section: string;
  grossPaise: number;
  tdsPaise: number;
  rateBp: number;
  paidOn: string | null;
  status: string;
  certificate: string | null;
  challan: string | null;
  flag: string | null;
}

/**
 * Monthly TDS per payee, and the quarterly 26Q data (with the challan of the
 * month and section). `withPan` decrypts PANs for the return (audited).
 */
export async function tdsDeductions(filter: { month?: string; financialYear?: string; quarter?: number }, actor: Actor, withPan = false): Promise<DeductionRow[]> {
  requirePermission(actor, PERMISSIONS.COMMISSION_TDS_MANAGE, "see TDS deductions");
  const months = filter.month
    ? [filter.month]
    : filter.financialYear && filter.quarter
      ? (() => {
          const y = Number(filter.financialYear.slice(0, 4));
          const first = [4, 7, 10, 1][filter.quarter - 1];
          const year = filter.quarter === 4 ? y + 1 : y;
          return [0, 1, 2].map((i) => `${year}-${String(first + i).padStart(2, "0")}`);
        })()
      : [];
  if (months.length === 0) throw validationFailed("Give a month, or a financial year and quarter.");
  const rows = await db.select().from(dealerPayoutBatches).where(and(inArray(batchMonthSql, months), sql`${dealerPayoutBatches.tdsPaise} > 0`, sql`${dealerPayoutBatches.status} <> 'CANCELLED'`));
  const [ds, ms, challans, certs] = await Promise.all([
    db.select({ id: dealers.id, name: dealers.legalName, panEnc: dealers.panEnc, panLast4: dealers.panLast4 }).from(dealers),
    db.select({ id: dealerSalespeople.id, name: dealerSalespeople.name, panEnc: dealerSalespeople.panEnc, panLast4: dealerSalespeople.panLast4 }).from(dealerSalespeople),
    db.select().from(commissionTdsChallans).where(inArray(commissionTdsChallans.periodMonth, months)),
    db.select({ id: commissionTdsCertificates.id, no: commissionTdsCertificates.certificateNumber }).from(commissionTdsCertificates),
  ]);
  const dealerOf = new Map(ds.map((d) => [d.id, d]));
  const memberOf = new Map(ms.map((m) => [m.id, m]));
  if (withPan) await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_PAN_REVEALED, entityType: "commission_tds", newValue: { months, rows: rows.length, reason: "26Q return data" } });
  return rows.map((b) => {
    const who = b.memberId ? memberOf.get(b.memberId) : dealerOf.get(b.dealerId);
    const challan = challans.find((c) => c.periodMonth === batchMonth(b) && c.section === b.tdsSection);
    return {
      batchId: b.id,
      periodMonth: batchMonth(b),
      payeeName: who?.name ?? "—",
      panMasked: who?.panLast4 ? `••••••${who.panLast4}` : "no PAN",
      pan: withPan && who?.panEnc ? decryptSecret(who.panEnc) : null,
      section: b.tdsSection ?? "",
      grossPaise: b.totalPaise,
      tdsPaise: b.tdsPaise,
      rateBp: b.tdsRateBp,
      paidOn: b.paidAt ? istDay(b.paidAt) : null,
      status: b.status,
      certificate: b.tdsCertificateId ? (certs.find((c) => c.id === b.tdsCertificateId)?.no ?? null) : null,
      challan: challan ? `${challan.bsrCode}/${challan.challanSerial}/${challan.depositedOn}` : null,
      flag: b.tdsFlag,
    };
  });
}

/** Payees with TDS in a quarter, and whether their Form 16A is uploaded (the tracker). */
export async function form16aTracker(financialYearLabel: string, quarter: number, actor: Actor) {
  const rows = await tdsDeductions({ financialYear: financialYearLabel, quarter }, actor);
  const batches = rows.length ? await db.select({ id: dealerPayoutBatches.id, pan: dealerPayoutBatches.payeePanHash }).from(dealerPayoutBatches).where(inArray(dealerPayoutBatches.id, rows.map((r) => r.batchId))) : [];
  const forms = await db.select({ pan: commissionTdsForms16a.panHash, no: commissionTdsForms16a.certificateNumber, id: commissionTdsForms16a.id }).from(commissionTdsForms16a).where(and(eq(commissionTdsForms16a.financialYear, financialYearLabel), eq(commissionTdsForms16a.quarter, quarter)));
  const byPan = new Map<string, { payeeName: string; panMasked: string; tdsPaise: number }>();
  for (const r of rows) {
    const pan = batches.find((b) => b.id === r.batchId)?.pan;
    if (!pan) continue;
    const cur = byPan.get(pan) ?? { payeeName: r.payeeName, panMasked: r.panMasked, tdsPaise: 0 };
    cur.tdsPaise += r.tdsPaise;
    byPan.set(pan, cur);
  }
  return [...byPan.entries()].map(([panHash, v]) => ({ panHash, ...v, form16a: forms.find((f) => f.pan === panHash) ?? null }));
}

/** The CA uploads a payee's Form 16A (PDF) for a quarter; a second upload replaces it. */
export async function uploadForm16a(input: { panHash: string; payeeLabel: string; financialYear: string; quarter: number; certificateNumber: string; fileName: string; bytes: Buffer }, actor: Actor) {
  requirePermission(actor, PERMISSIONS.COMMISSION_TDS_MANAGE, "upload Form 16A");
  if (!/^\d{4}-\d{2}$/.test(input.financialYear) || input.quarter < 1 || input.quarter > 4) throw validationFailed("Financial year like 2026-27 and quarter 1–4.");
  if (input.bytes.length === 0 || input.bytes.length > 5_000_000 || input.bytes.subarray(0, 4).toString("latin1") !== "%PDF") throw validationFailed("Upload the Form 16A as a PDF (up to 5 MB).");
  await db.delete(commissionTdsForms16a).where(and(eq(commissionTdsForms16a.panHash, input.panHash), eq(commissionTdsForms16a.financialYear, input.financialYear), eq(commissionTdsForms16a.quarter, input.quarter)));
  const [row] = await db
    .insert(commissionTdsForms16a)
    .values({ panHash: input.panHash, payeeLabel: input.payeeLabel, financialYear: input.financialYear, quarter: input.quarter, certificateNumber: input.certificateNumber.trim(), fileName: input.fileName.slice(0, 120), dataEncrypted: encryptBytes(input.bytes), uploadedBy: actor.id })
    .returning({ id: commissionTdsForms16a.id });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STATUTORY_RATE_CHANGED, entityType: "commission_tds_form16a", entityId: row.id, newValue: { financialYear: input.financialYear, quarter: input.quarter, certificateNumber: input.certificateNumber } });
  return row;
}

/** A Form 16A file — for the CA / admin, or the payee whose PAN it is. */
export async function form16aFile(formId: string, viewer: { actor: Actor; panHash: string | null }): Promise<{ fileName: string; bytes: Buffer }> {
  const [row] = await db.select().from(commissionTdsForms16a).where(eq(commissionTdsForms16a.id, formId));
  if (!row) throw notFound("Form 16A");
  if (!can(viewer.actor.role, PERMISSIONS.COMMISSION_TDS_MANAGE) && viewer.panHash !== row.panHash) throw forbidden("This Form 16A is not yours.");
  return { fileName: row.fileName, bytes: decryptBytes(row.dataEncrypted) };
}

/**
 * The exceptions the CA reviews: payouts with an unconfirmed or missing row
 * (and whether they were overridden), reversals crossing a financial year,
 * and payees held without a PAN.
 */
export async function tdsExceptions(actor: Actor) {
  requirePermission(actor, PERMISSIONS.COMMISSION_TDS_MANAGE, "see TDS exceptions");
  const flagged = await db.select().from(dealerPayoutBatches).where(sql`${dealerPayoutBatches.tdsFlag} IS NOT NULL`).orderBy(desc(dealerPayoutBatches.createdAt)).limit(500);
  const noPan = await db
    .select({ dealerId: dealerCommissionLedger.dealerId, memberId: dealerCommissionLedger.payeeMemberId, amount: sql<number>`sum(${dealerCommissionLedger.amountPaise})::int` })
    .from(dealerCommissionLedger)
    .where(and(isNull(dealerCommissionLedger.payoutBatchId), inArray(dealerCommissionLedger.status, ["EARNED", "APPROVED"])))
    .groupBy(dealerCommissionLedger.dealerId, dealerCommissionLedger.payeeMemberId);
  const held: { dealerId: string; memberId: string | null; amountPaise: number }[] = [];
  for (const r of noPan) {
    const [who] = r.memberId
      ? await db.select({ pan: dealerSalespeople.panHash }).from(dealerSalespeople).where(eq(dealerSalespeople.id, r.memberId))
      : await db.select({ pan: dealers.panHash }).from(dealers).where(eq(dealers.id, r.dealerId));
    if (!who?.pan && r.amount > 0) held.push({ dealerId: r.dealerId, memberId: r.memberId, amountPaise: r.amount });
  }
  return {
    flagged: flagged.map((b) => ({ batchId: b.id, month: batchMonth(b), flag: b.tdsFlag, overridden: Boolean(b.tdsOverrideReason), overrideReason: b.tdsOverrideReason, grossPaise: b.totalPaise, tdsPaise: b.tdsPaise, status: b.status })),
    heldWithoutPan: held,
  };
}

/* ================================================================== D6 */

/** The payee's own TDS view: PAN on file, the rate that applies now, TDS this year, their Form 16A list. */
export async function payeeTdsView(input: { panHash: string | null; dealerType: string | null; isMember: boolean }) {
  const now = new Date();
  const fy = financialYear(now);
  const rate = await rateFor(input.isMember ? "INDIVIDUAL" : payeeTypeFor(input.dealerType), input.panHash ? "PAN_OK" : "NO_PAN", istDay(now));
  const [year] = input.panHash
    ? await db
        .select({ gross: sql<number>`coalesce(sum(${dealerPayoutBatches.totalPaise}), 0)::bigint`, tds: sql<number>`coalesce(sum(${dealerPayoutBatches.tdsPaise}), 0)::bigint` })
        .from(dealerPayoutBatches)
        .where(and(eq(dealerPayoutBatches.payeePanHash, input.panHash), eq(dealerPayoutBatches.status, "PAID"), sql`to_date(${batchMonthSql}, 'YYYY-MM') between ${fy.from}::date and ${fy.to}::date`))
    : [];
  const forms = input.panHash
    ? await db.select({ id: commissionTdsForms16a.id, financialYear: commissionTdsForms16a.financialYear, quarter: commissionTdsForms16a.quarter, certificateNumber: commissionTdsForms16a.certificateNumber }).from(commissionTdsForms16a).where(eq(commissionTdsForms16a.panHash, input.panHash)).orderBy(desc(commissionTdsForms16a.financialYear), desc(commissionTdsForms16a.quarter))
    : [];
  return {
    tdsOn: (await getRule("dealerPayoutTds")).enabled,
    panOnFile: Boolean(input.panHash),
    rateBp: rate?.rateBp ?? null,
    thresholdPaise: rate?.thresholdPaise ?? null,
    section: rate?.section ?? null,
    financialYear: fy.label,
    grossThisYearPaise: Number(year?.gross ?? 0),
    tdsThisYearPaise: Number(year?.tds ?? 0),
    forms16a: forms,
  };
}
