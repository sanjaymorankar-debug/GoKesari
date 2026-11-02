/**
 * Dealer commission payout reports (gap report C6), CSV and XLSX:
 *
 *   summary   one row per payout of the month — payee, role, dealer, gross, TDS, net, status, UTR
 *   lines     every ledger entry of the month — type, level, shop, payee, status, amount
 *   pending   payees not paid for the month — held (what is missing), below the minimum, owed back
 *   failed    transfers that failed (rule dealerAutoPayout) — attempts, reason, needs review
 *
 * Filters: month (YYYY-MM), main dealer, role and status. Read-only; admins,
 * operators and (gap report D4) the CA see them. Mobiles and PANs are never
 * in a report (PAN as its last four characters only).
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { COMMISSION_ENTRY_TYPE_LABELS, NETWORK_ROLE_LABELS, type NetworkRole } from "@/lib/dealer-tiers";
import { validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { dealerCommissionLedger, dealerCommissionMonths, dealerPayoutBatches, dealerSalespeople, dealers, shops } from "@/server/db/schema";
import { toCsv, toXlsx } from "@/server/integrations/tabular";
import { monthBounds } from "./monthly-payout";

export const PAYOUT_REPORTS = ["summary", "lines", "pending", "failed"] as const;
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
        rows: shown.map((b) => [b.id, b.periodMonth, payeeName(b.dealerId, b.memberId), NETWORK_ROLE_LABELS[roleOf(b.memberId)], dealer.get(b.dealerId)?.name ?? "—", rs(b.totalPaise - b.tdsPaise), b.attempts, b.failureReason, b.needsReview ? "yes" : "no", day(b.nextRetryAt)]),
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
        rs(b.totalPaise - b.tdsPaise),
        b.status,
        b.paymentReference,
        day(b.paidAt),
      ]),
    };
  }

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
