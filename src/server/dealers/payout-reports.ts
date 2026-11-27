/**
 * Dealer commission payout reports (gap report C6), CSV and XLSX:
 *
 *   summary   one row per payout of the month — payee, role, dealer, gross, TDS, net, status, UTR
 *   lines     every ledger entry of the month — type, level, shop, payee, status, amount
 *   pending   payees not paid for the month — held (what is missing), below the minimum, owed back
 *   failed    transfers that failed (rule dealerAutoPayout) — attempts, reason, needs review
 *   notready  payees who cannot be paid today (no PAN, bank not verified, agreement) and what they are owed
 *   tdscatchup  dry run: each PAN's financial-year gross, the TDS deducted and the TDS the rows in force
 *             would deduct by now (rule dealerPayoutTds on or off) — the shortfall a first payout catches up
 *
 * Filters: month (YYYY-MM), main dealer, role and status. Read-only; admins,
 * operators and (gap report D4) the CA see them. Mobiles and PANs are never
 * in a report (PAN as its last four characters only).
 */
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";

import { COMMISSION_ENTRY_TYPE_LABELS, NETWORK_ROLE_LABELS, type NetworkRole } from "@/lib/dealer-tiers";
import { validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { dealerCommissionLedger, dealerCommissionMonths, dealerPayoutBatches, dealerSalespeople, dealers, shops } from "@/server/db/schema";
import { toCsv, toXlsx } from "@/server/integrations/tabular";
import { deduction, financialYear, payeeTypeFor, rateFor } from "@/server/tax/commission-tds";
import { payeeChecksApply, payeeStatus } from "./commission";
import { monthBounds } from "./monthly-payout";

export const PAYOUT_REPORTS = ["summary", "lines", "pending", "failed", "notready", "tdscatchup"] as const;
export type PayoutReport = (typeof PAYOUT_REPORTS)[number];

export interface ReportFilter {
  month?: string | null;
  dealerId?: string | null;
  role?: NetworkRole | null;
  status?: string | null;
}

export interface ReportTable {
  title: string;
  header: string[];
  rows: (string | number | null)[][];
}

const rs = (paise: number) => Math.round(paise) / 100;
const day = (d: Date | null) => (d ? new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10) : null);

async function people() {
  const [ds, ms] = await Promise.all([
    db.select({ id: dealers.id, name: dealers.legalName, panLast4: dealers.panLast4 }).from(dealers),
    db.select({ id: dealerSalespeople.id, name: dealerSalespeople.name, role: dealerSalespeople.teamRole, panLast4: dealerSalespeople.panLast4 }).from(dealerSalespeople),
  ]);
  return { dealer: new Map(ds.map((d) => [d.id, d])), member: new Map(ms.map((m) => [m.id, m])) };
}

export async function payoutReport(report: PayoutReport, filter: ReportFilter = {}): Promise<ReportTable> {
  if (filter.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) throw validationFailed("Give the month as YYYY-MM.");
  const { dealer, member } = await people();
  const roleOf = (memberId: string | null): NetworkRole => (memberId ? (member.get(memberId)?.role ?? "AGENT") : "MAIN_DEALER");
  const payeeName = (dealerId: string, memberId: string | null) => (memberId ? (member.get(memberId)?.name ?? "—") : (dealer.get(dealerId)?.name ?? "—"));
  const pan = (dealerId: string, memberId: string | null) => (memberId ? member.get(memberId)?.panLast4 : dealer.get(dealerId)?.panLast4) ?? null;
  const roleOk = (memberId: string | null) => !filter.role || roleOf(memberId) === filter.role;

  if (report === "summary" || report === "failed") {
    const rows = await db
      .select()
      .from(dealerPayoutBatches)
      .where(
        and(
          filter.month ? eq(dealerPayoutBatches.periodMonth, filter.month) : sql`true`,
          filter.dealerId ? eq(dealerPayoutBatches.dealerId, filter.dealerId) : sql`true`,
          report === "failed" ? eq(dealerPayoutBatches.status, "FAILED") : filter.status ? eq(dealerPayoutBatches.status, filter.status as never) : sql`true`,
        ),
      )
      .orderBy(desc(dealerPayoutBatches.createdAt))
      .limit(5000);
    const shown = rows.filter((b) => roleOk(b.memberId));
    if (report === "failed") {
      return {
        title: "Failed transfers",
        header: ["Payout", "Month", "Payee", "Role", "Main dealer", "Net (Rs)", "Attempts", "Reason", "Needs review", "Next retry"],
        rows: shown.map((b) => [b.id, b.periodMonth, payeeName(b.dealerId, b.memberId), NETWORK_ROLE_LABELS[roleOf(b.memberId)], dealer.get(b.dealerId)?.name ?? "—", rs(b.totalPaise + b.gstPaise - b.tdsPaise), b.attempts, b.failureReason, b.needsReview ? "yes" : "no", day(b.nextRetryAt)]),
      };
    }
    return {
      title: "Payout summary",
      header: ["Payout", "Month", "Payee", "Role", "PAN (last 4)", "Main dealer", "Gross (Rs)", "TDS (Rs)", "TDS rate %", "Net (Rs)", "Status", "UTR / bank reference", "Paid on"],
      rows: shown.map((b) => [
        b.id,
        b.periodMonth,
        payeeName(b.dealerId, b.memberId),
        NETWORK_ROLE_LABELS[roleOf(b.memberId)],
        pan(b.dealerId, b.memberId),
        dealer.get(b.dealerId)?.name ?? "—",
        rs(b.totalPaise),
        rs(b.tdsPaise),
        b.tdsRateBp / 100,
        rs(b.totalPaise + b.gstPaise - b.tdsPaise),
        b.status,
        b.paymentReference,
        day(b.paidAt),
      ]),
    };
  }

  if (report === "notready") return notReadyReport(filter, { payeeName, roleOf, roleOk, dealerName: (id) => dealer.get(id)?.name ?? "—" });
  if (report === "tdscatchup") return tdsCatchUpReport(filter, { payeeName, roleOf, pan });

  if (report === "lines") {
    const bounds = filter.month ? monthBounds(filter.month) : null;
    const rows = await db
      .select({ e: dealerCommissionLedger, shopName: shops.name })
      .from(dealerCommissionLedger)
      .leftJoin(shops, eq(shops.id, dealerCommissionLedger.shopId))
      .where(
        and(
          bounds ? and(gte(dealerCommissionLedger.createdAt, bounds.start), lt(dealerCommissionLedger.createdAt, bounds.end)) : sql`true`,
          filter.dealerId ? eq(dealerCommissionLedger.dealerId, filter.dealerId) : sql`true`,
          filter.status ? eq(dealerCommissionLedger.status, filter.status as never) : sql`true`,
        ),
      )
      .orderBy(desc(dealerCommissionLedger.createdAt))
      .limit(20_000);
    return {
      title: "Ledger lines",
      header: ["Date", "Main dealer", "Payee", "Role", "Level", "Type", "Shop", "Kind", "Status", "Fee (Rs)", "Amount (Rs)", "Payout", "Note"],
      rows: rows
        .filter((r) => roleOk(r.e.payeeMemberId))
        .map((r) => [
          day(r.e.createdAt),
          dealer.get(r.e.dealerId)?.name ?? "—",
          payeeName(r.e.dealerId, r.e.payeeMemberId),
          NETWORK_ROLE_LABELS[roleOf(r.e.payeeMemberId)],
          r.e.level,
          COMMISSION_ENTRY_TYPE_LABELS[r.e.entryType],
          r.shopName ?? (r.e.entryType === "BONUS" ? "Monthly target bonus" : "—"),
          r.e.kind,
          r.e.status,
          rs(r.e.feePaise),
          rs(r.e.amountPaise),
          r.e.payoutBatchId,
          r.e.note,
        ]),
    };
  }

  // pending: the closed months' carried payees (held, below the minimum, owed back).
  const months = await db
    .select()
    .from(dealerCommissionMonths)
    .where(filter.month ? eq(dealerCommissionMonths.periodMonth, filter.month) : sql`true`)
    .orderBy(desc(dealerCommissionMonths.periodMonth))
    .limit(filter.month ? 1 : 3);
  const out: (string | number | null)[][] = [];
  for (const m of months) {
    const carried = ((m.summary as { carried?: { dealerId: string; memberId?: string | null; netPaise: number; reason?: string }[] }).carried ?? []).filter(
      (c) => (!filter.dealerId || c.dealerId === filter.dealerId) && roleOk(c.memberId ?? null),
    );
    for (const c of carried) {
      out.push([m.periodMonth, payeeName(c.dealerId, c.memberId ?? null), NETWORK_ROLE_LABELS[roleOf(c.memberId ?? null)], dealer.get(c.dealerId)?.name ?? "—", rs(c.netPaise), c.reason ?? (c.netPaise < 0 ? "owed back" : "carried")]);
    }
  }
  return { title: "Pending payees", header: ["Month", "Payee", "Role", "Main dealer", "Amount (Rs)", "Why not paid"], rows: out };
}

interface Names {
  payeeName: (dealerId: string, memberId: string | null) => string;
  roleOf: (memberId: string | null) => NetworkRole;
}

/**
 * Payees who cannot be paid today — what is missing and what they are owed (commission not yet in a
 * payout, and open payouts). Read before the checks are switched on, and to chase payees after.
 */
async function notReadyReport(filter: ReportFilter, n: Names & { roleOk: (memberId: string | null) => boolean; dealerName: (id: string) => string }): Promise<ReportTable> {
  const unpaid = await db
    .select({ dealerId: dealerCommissionLedger.dealerId, memberId: dealerCommissionLedger.payeeMemberId, amount: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}), 0)::bigint` })
    .from(dealerCommissionLedger)
    .where(and(isNull(dealerCommissionLedger.payoutBatchId), inArray(dealerCommissionLedger.status, ["EARNED", "APPROVED", "ON_HOLD"]), filter.dealerId ? eq(dealerCommissionLedger.dealerId, filter.dealerId) : sql`true`))
    .groupBy(dealerCommissionLedger.dealerId, dealerCommissionLedger.payeeMemberId);
  const open = await db
    .select({ dealerId: dealerPayoutBatches.dealerId, memberId: dealerPayoutBatches.memberId, amount: sql<number>`coalesce(sum(${dealerPayoutBatches.totalPaise}), 0)::bigint` })
    .from(dealerPayoutBatches)
    .where(and(inArray(dealerPayoutBatches.status, ["DRAFT", "APPROVED", "FAILED"]), filter.dealerId ? eq(dealerPayoutBatches.dealerId, filter.dealerId) : sql`true`))
    .groupBy(dealerPayoutBatches.dealerId, dealerPayoutBatches.memberId);
  const owed = new Map<string, { dealerId: string; memberId: string | null; unpaid: number; open: number }>();
  const key = (d: string, m: string | null) => `${d}:${m ?? ""}`;
  for (const r of unpaid) owed.set(key(r.dealerId, r.memberId), { dealerId: r.dealerId, memberId: r.memberId, unpaid: Number(r.amount), open: 0 });
  for (const r of open) {
    const cur = owed.get(key(r.dealerId, r.memberId)) ?? { dealerId: r.dealerId, memberId: r.memberId, unpaid: 0, open: 0 };
    cur.open = Number(r.amount);
    owed.set(key(r.dealerId, r.memberId), cur);
  }
  const rows: (string | number | null)[][] = [];
  for (const o of [...owed.values()].sort((a, b) => b.unpaid + b.open - (a.unpaid + a.open))) {
    if (o.unpaid + o.open <= 0 || !n.roleOk(o.memberId)) continue;
    const status = await payeeStatus(db, o.dealerId, o.memberId);
    if (!status.missing.length) continue;
    rows.push([
      n.payeeName(o.dealerId, o.memberId),
      NETWORK_ROLE_LABELS[n.roleOf(o.memberId)],
      n.dealerName(o.dealerId),
      status.missing.join(", "),
      rs(o.unpaid),
      rs(o.open),
      rs(o.unpaid + o.open),
      (await payeeChecksApply(o.memberId)) ? "held" : "paid without the checks (rule off)",
    ]);
  }
  return { title: "Payees not ready to be paid", header: ["Payee", "Role", "Main dealer", "Missing", "Not yet in a payout (Rs)", "In open payouts (Rs)", "Owed (Rs)", "Today"], rows };
}

/**
 * Dry run, changes nothing: per PAN (a payee without one on their own), the financial year's gross in
 * payouts (not cancelled), the TDS deducted, and what the rows in force would have deducted by now — the
 * shortfall CATCH_UP takes at the first payout once rule dealerPayoutTds is on. A PAN's earlier PAN-less
 * payouts count towards it. Financial year: the one `month` falls in, else today's.
 */
async function tdsCatchUpReport(filter: ReportFilter, n: Names & { pan: (dealerId: string, memberId: string | null) => string | null }): Promise<ReportTable> {
  const at = filter.month ? new Date(`${filter.month}-15T00:00:00+05:30`) : new Date();
  const fy = financialYear(at);
  const today = new Date(Math.min(Date.now(), new Date(`${fy.to}T23:59:59+05:30`).getTime()));
  const batches = await db
    .select()
    .from(dealerPayoutBatches)
    .where(
      and(
        ne(dealerPayoutBatches.status, "CANCELLED"),
        filter.dealerId ? eq(dealerPayoutBatches.dealerId, filter.dealerId) : sql`true`,
        sql`coalesce(to_date(${dealerPayoutBatches.periodMonth}, 'YYYY-MM'), (${dealerPayoutBatches.createdAt} at time zone 'Asia/Kolkata')::date) between ${fy.from}::date and ${fy.to}::date`,
      ),
    );
  const [ds, ms] = await Promise.all([
    db.select({ id: dealers.id, pan: dealers.panHash, type: dealers.dealerType }).from(dealers),
    db.select({ id: dealerSalespeople.id, pan: dealerSalespeople.panHash }).from(dealerSalespeople),
  ]);
  const dealerOf = new Map(ds.map((d) => [d.id, d]));
  const memberPan = new Map(ms.map((m) => [m.id, m.pan]));
  const groups = new Map<string, { dealerId: string; memberId: string | null; pan: string | null; gross: number; tds: number; payouts: number }>();
  for (const b of batches) {
    // A PAN-less payout joins the PAN its payee has now.
    const pan = b.payeePanHash ?? (b.memberId ? memberPan.get(b.memberId) : dealerOf.get(b.dealerId)?.pan) ?? null;
    const k = pan ?? `none:${b.dealerId}:${b.memberId ?? ""}`;
    const g = groups.get(k) ?? { dealerId: b.dealerId, memberId: b.memberId, pan, gross: 0, tds: 0, payouts: 0 };
    g.gross += b.totalPaise;
    g.tds += b.tdsPaise;
    g.payouts += 1;
    groups.set(k, g);
  }
  const day = new Date(today.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const rows: (string | number | null)[][] = [];
  for (const g of [...groups.values()].sort((a, b) => b.gross - a.gross)) {
    const type = g.memberId ? "INDIVIDUAL" : payeeTypeFor(dealerOf.get(g.dealerId)?.type ?? null);
    const rate = await rateFor(type, g.pan ? "PAN_OK" : "NO_PAN", day);
    const due = rate ? deduction({ grossPaise: g.gross, yearGrossBeforePaise: 0, yearTdsBeforePaise: 0, rate }) : null;
    rows.push([
      n.payeeName(g.dealerId, g.memberId),
      NETWORK_ROLE_LABELS[n.roleOf(g.memberId)],
      g.pan ? (n.pan(g.dealerId, g.memberId) ?? "on file") : "no PAN",
      g.payouts,
      rs(g.gross),
      rs(g.tds),
      rate ? `${rate.rateBp / 100}% above Rs ${rate.thresholdPaise / 100} (${rate.mode})${rate.confirmedByCa ? "" : ", not confirmed by the CA"}` : "no row applies",
      due == null ? null : rs(due),
      due == null ? null : rs(Math.max(0, due - g.tds)),
    ]);
  }
  return {
    title: `TDS catch-up ${fy.label} (dry run)`,
    header: ["Payee", "Role", "PAN (last 4)", "Payouts", "FY gross (Rs)", "TDS deducted (Rs)", "Row in force", "TDS due by now (Rs)", "Shortfall (Rs)"],
    rows,
  };
}

export async function payoutReportFile(report: PayoutReport, filter: ReportFilter, format: "csv" | "xlsx"): Promise<{ body: Buffer; contentType: string; filename: string }> {
  const table = await payoutReport(report, filter);
  const base = `gokesari-dealer-${report}${filter.month ? `-${filter.month}` : ""}`;
  return format === "xlsx"
    ? { body: await toXlsx(table.title, table.header, table.rows), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `${base}.xlsx` }
    : { body: toCsv(table.header, table.rows), contentType: "text/csv; charset=utf-8", filename: `${base}.csv` };
}

/** The payees in a batch (for statements): every dealer / member whose entries it holds. */
export async function batchPayees(batchId: string): Promise<{ dealerId: string; memberId: string | null }[]> {
  const rows = await db
    .selectDistinct({ dealerId: dealerCommissionLedger.dealerId, memberId: dealerCommissionLedger.payeeMemberId })
    .from(dealerCommissionLedger)
    .where(inArray(dealerCommissionLedger.payoutBatchId, [batchId]));
  return rows;
}
