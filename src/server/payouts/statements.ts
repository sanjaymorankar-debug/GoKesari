/**
 * Settlement statements for automated payouts (batch-2026-10 WS-E): one per
 * payout item (shop × cycle), as PDF and CSV — every line of the payout
 * maths, the totals by kind, the net, the status and the bank reference
 * (UTR). Emailed to the shop owner when the payout is paid and listed under
 * /shop/finance → Statements.
 */
import { asc, desc, eq } from "drizzle-orm";

import { formatPaise } from "@/lib/money";
import { PDF_LINE_WIDTH, textPdf, type PdfLine } from "@/lib/pdf";
import { db } from "@/server/db";
import { payoutCycleLines, payoutCycles, payoutItems, shops, type PayoutCycleLine, type PayoutItem, type UserRole } from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { periodLabel } from "./cycle";

export const LINE_LABELS: Record<string, string> = {
  GOODS: "Delivered orders",
  COMMISSION: "Commission",
  DELIVERY_CHARGE: "Delivery charges",
  FEE_GST: "GST on GoKesari fees",
  PLATFORM_FEE: "Billing / inventory management",
  TCS: "GST TCS (s.52)",
  TDS: "Income-tax TDS",
  REFUND: "Refunds",
  ADJUSTMENT: "Adjustments",
  PLATFORM_NOTE: "Credit / debit notes",
  REGISTRATION_FEE: "Registration fees (already paid)",
  WALLET_TOPUP: "Shop wallet top-up",
  CARRY_FORWARD: "Carried from earlier cycles",
  SEC95_GST: "s.9(5) GST paid by GoKesari",
};

export const ITEM_STATUS_LABELS: Record<string, string> = {
  PENDING: "Waiting for approval / transfer",
  ON_HOLD: "On hold",
  PROCESSING: "Being paid",
  PAID: "Paid",
  FAILED: "Transfer failed",
  REVERSED: "Returned by the bank",
  CARRIED_FORWARD: "Moved to a later cycle",
};

export interface StatementData {
  item: PayoutItem;
  shop: { id: string; name: string; legalName: string; registrationNumber: string; ownerId: string };
  period: string;
  lines: PayoutCycleLine[];
}

export async function loadStatement(itemId: string): Promise<StatementData | null> {
  const [row] = await db
    .select({ item: payoutItems, cycle: payoutCycles, shop: shops })
    .from(payoutItems)
    .innerJoin(payoutCycles, eq(payoutCycles.id, payoutItems.cycleId))
    .innerJoin(shops, eq(shops.id, payoutItems.shopId))
    .where(eq(payoutItems.id, itemId));
  if (!row) return null;
  const all = await db.select().from(payoutCycleLines).where(eq(payoutCycleLines.cycleId, row.item.cycleId)).orderBy(asc(payoutCycleLines.occurredOn), asc(payoutCycleLines.createdAt));
  return {
    item: row.item,
    shop: { id: row.shop.id, name: row.shop.name, legalName: row.shop.legalBusinessName ?? row.shop.name, registrationNumber: row.shop.registrationNumber, ownerId: row.shop.ownerId },
    period: periodLabel(row.cycle),
    lines: all.filter((l) => l.shopId === row.item.shopId),
  };
}

const rs = (paise: number) => (paise / 100).toFixed(2);
const money = (paise: number) => formatPaise(paise).replace("₹", "Rs. ");
const cell = (value: string | number | null) => {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function statementCsv(d: StatementData): string {
  const rows: (string | number | null)[][] = [
    ["shop", d.shop.legalName],
    ["shop_no", d.shop.registrationNumber],
    ["period", d.period],
    ["status", d.item.status],
    ["utr", d.item.utr],
    ["net_payout_inr", rs(d.item.amountPaise)],
    [],
    ["date", "type", "description", "source", "base_inr", "rate_pct", "amount_inr"],
    ...d.lines.map((l) => [l.occurredOn, l.lineType, l.description, `${l.sourceType}:${l.sourceId}`, l.basePaise == null ? null : rs(l.basePaise), l.rateBp == null ? null : (l.rateBp / 100).toFixed(2), rs(l.amountPaise)]),
    [],
    ["total_by_type", "type", "", "", "", "", "amount_inr"],
    ...Object.entries(d.item.breakdown).map(([type, amount]) => ["", type, LINE_LABELS[type] ?? type, "", "", "", rs(amount)]),
  ];
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

export function statementLines(d: StatementData): PdfLine[] {
  const W = PDF_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (l: string, r: string) => add(l + r.padStart(Math.max(1, W - l.length)));
  const rule = "-".repeat(W);
  add("GOKESARI PAYOUT STATEMENT", true);
  pair(`${d.shop.legalName}`.slice(0, 60), `Shop no ${d.shop.registrationNumber}`);
  pair(`Period: ${d.period}`, `Statement ${d.item.id.slice(0, 8).toUpperCase()}`);
  pair(`Status: ${ITEM_STATUS_LABELS[d.item.status] ?? d.item.status}${d.item.holdReason ? ` (${d.item.holdReason})` : ""}`, d.item.utr ? `UTR ${d.item.utr}` : "");
  if (d.item.paidAt) add(`Paid on ${d.item.paidAt.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}`);
  add(rule);
  add(`${"Date".padEnd(11)}${"Description".padEnd(70)}${"Amount".padStart(14)}`.slice(0, W), true);
  for (const l of d.lines) {
    const amount = l.amountPaise === 0 ? "-" : money(l.amountPaise);
    add(`${l.occurredOn.padEnd(11)}${l.description.slice(0, 69).padEnd(70)}${amount.padStart(14)}`.slice(0, W));
  }
  add(rule);
  add("TOTALS", true);
  for (const [type, amount] of Object.entries(d.item.breakdown)) {
    if (amount !== 0) pair(LINE_LABELS[type] ?? type, money(amount));
  }
  add(rule);
  pair("Net payout", money(d.item.amountPaise));
  add();
  add("TCS and TDS deducted here are deposited by GoKesari against your GSTIN / PAN and appear in your");
  add("GST portal (GSTR-2X / TCS credit) and Form 26AS. Amounts with '-' were collected from your shop wallet.");
  add("This is a computer-generated statement.");
  return out;
}

export async function renderPayoutStatement(itemId: string): Promise<{ basename: string; pdf: Buffer; csv: string; shopId: string; ownerId: string } | null> {
  const d = await loadStatement(itemId);
  if (!d) return null;
  const basename = `gokesari-statement-${d.period.slice(0, 10)}-${d.shop.registrationNumber}`.replace(/[^A-Za-z0-9-]+/g, "_");
  return { basename, pdf: textPdf(statementLines(d), { title: `Payout statement ${d.period}` }), csv: statementCsv(d), shopId: d.shop.id, ownerId: d.shop.ownerId };
}

/** The shop's owner, or finance (PAYOUT_VIEW), may read a statement. */
export async function canViewStatement(itemId: string, user: { id: string; role: UserRole }): Promise<boolean> {
  if (can(user.role, PERMISSIONS.PAYOUT_VIEW)) return true;
  const [row] = await db.select({ ownerId: shops.ownerId }).from(payoutItems).innerJoin(shops, eq(shops.id, payoutItems.shopId)).where(eq(payoutItems.id, itemId));
  return row?.ownerId === user.id;
}

export async function listStatementsForShop(shopId: string, limit = 30) {
  return db
    .select({ item: payoutItems, cycleStart: payoutCycles.cycleStart, cycleEnd: payoutCycles.cycleEnd })
    .from(payoutItems)
    .innerJoin(payoutCycles, eq(payoutCycles.id, payoutItems.cycleId))
    .where(eq(payoutItems.shopId, shopId))
    .orderBy(desc(payoutCycles.cycleStart))
    .limit(limit);
}
