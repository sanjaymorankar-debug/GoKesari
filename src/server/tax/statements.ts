/**
 * The shop's monthly statements from GoKesari (billing v2, docs/billing §5.4,
 * §5.5, §5.6): the prepaid-wallet statement (opening balance, top-ups,
 * deductions with their order / invoice references, closing balance), the
 * TCS / TDS statement (what GoKesari collected or deducted, to claim in the
 * shop's GST and income-tax returns), and the order-level settlement report —
 * as PDF and CSV. GoKesari's own fee invoices of the month are listed on the
 * wallet statement so the shop can match them in its GSTR-2B / IMS.
 */
import { and, asc, eq, gte, lt } from "drizzle-orm";

import { formatPaise } from "@/lib/money";
import { PDF_LINE_WIDTH, textPdf, type PdfLine } from "@/lib/pdf";
import { db } from "@/server/db";
import { platformInvoices, shops, shopWalletTransactions } from "@/server/db/schema";
import { notFound } from "@/lib/errors";
import { monthBounds, orderSettlementReport, shopTaxStatement, type ShopTaxStatement } from "./compliance";

const IST = (iso: string) => new Date(`${iso}T00:00:00+05:30`);
const money = (p: number) => formatPaise(p).replace("₹", "Rs. ");
const cell = (v: string | number | null | undefined) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export interface WalletStatement {
  shopId: string;
  shopName: string;
  period: string;
  openingPaise: number;
  closingPaise: number;
  topUpsPaise: number;
  deductionsPaise: number;
  entries: { at: string; type: string; direction: "CREDIT" | "DEBIT"; amountPaise: number; balanceAfterPaise: number; reason: string; orderId: string | null }[];
  feeInvoices: { number: string; issuedAt: string; totalPaise: number }[];
}

export async function shopWalletStatement(shopId: string, period: string): Promise<WalletStatement> {
  const { from, to } = monthBounds(period);
  const [shop] = await db.select({ name: shops.name, legal: shops.legalBusinessName }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  const [before] = await db
    .select({ balance: shopWalletTransactions.balanceAfterPaise })
    .from(shopWalletTransactions)
    .where(and(eq(shopWalletTransactions.shopId, shopId), lt(shopWalletTransactions.createdAt, IST(from))))
    .orderBy(asc(shopWalletTransactions.seq))
    .then((rows) => rows.slice(-1));
  const rows = await db
    .select()
    .from(shopWalletTransactions)
    .where(and(eq(shopWalletTransactions.shopId, shopId), gte(shopWalletTransactions.createdAt, IST(from)), lt(shopWalletTransactions.createdAt, IST(to))))
    .orderBy(asc(shopWalletTransactions.seq));
  const opening = before?.balance ?? (rows[0]?.balanceBeforePaise ?? 0);
  const closing = rows.length ? rows[rows.length - 1].balanceAfterPaise : opening;
  const invoices = await db
    .select({ number: platformInvoices.invoiceNumber, issuedAt: platformInvoices.issuedAt, totalPaise: platformInvoices.totalPaise })
    .from(platformInvoices)
    .where(and(eq(platformInvoices.shopId, shopId), gte(platformInvoices.issuedAt, IST(from)), lt(platformInvoices.issuedAt, IST(to))))
    .orderBy(asc(platformInvoices.issuedAt));
  return {
    shopId,
    shopName: shop.legal ?? shop.name,
    period,
    openingPaise: opening,
    closingPaise: closing,
    topUpsPaise: rows.filter((r) => r.direction === "CREDIT").reduce((s, r) => s + r.amountPaise, 0),
    deductionsPaise: rows.filter((r) => r.direction === "DEBIT").reduce((s, r) => s + r.amountPaise, 0),
    entries: rows.map((r) => ({ at: r.createdAt.toISOString(), type: r.type, direction: r.direction, amountPaise: r.amountPaise, balanceAfterPaise: r.balanceAfterPaise, reason: r.reason, orderId: r.orderId })),
    feeInvoices: invoices.map((i) => ({ number: i.number, issuedAt: i.issuedAt.toISOString(), totalPaise: i.totalPaise })),
  };
}

const istDate = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

export function walletStatementPdf(s: WalletStatement): Buffer {
  const W = PDF_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (l: string, r: string) => add(l.slice(0, W - r.length - 1) + r.padStart(Math.max(1, W - Math.min(l.length, W - r.length - 1))));
  add("GOKESARI SHOP WALLET STATEMENT", true);
  add(`${s.shopName} — ${s.period}`);
  add("-".repeat(W));
  pair("Opening balance", money(s.openingPaise));
  pair("Top-ups and credits", money(s.topUpsPaise));
  pair("Deductions", money(s.deductionsPaise));
  pair("Closing balance", money(s.closingPaise));
  add("-".repeat(W));
  add(`${"Date".padEnd(12)}${"Entry".padEnd(20)}${"Amount".padStart(14)}${"Balance".padStart(14)}  Details`, true);
  for (const e of s.entries) {
    add(`${istDate(e.at).padEnd(12)}${e.type.padEnd(20)}${`${e.direction === "DEBIT" ? "-" : "+"}${money(e.amountPaise)}`.padStart(14)}${money(e.balanceAfterPaise).padStart(14)}  ${e.reason}`.slice(0, W));
  }
  if (s.feeInvoices.length) {
    add();
    add("GOKESARI TAX INVOICES FOR ITS FEES THIS MONTH (claim the GST in your GSTR-2B / IMS)", true);
    for (const i of s.feeInvoices) pair(`${i.number}   ${istDate(i.issuedAt)}`, money(i.totalPaise));
  }
  return textPdf(out, { title: `Wallet statement ${s.period}` });
}

export function walletStatementCsv(s: WalletStatement): string {
  return (
    [
      ["date", "type", "direction", "amount_inr", "balance_after_inr", "details", "order_id"].join(","),
      ...s.entries.map((e) => [istDate(e.at), e.type, e.direction, e.amountPaise / 100, e.balanceAfterPaise / 100, e.reason, e.orderId].map(cell).join(",")),
    ].join("\n") + "\n"
  );
}

export function taxStatementPdf(s: ShopTaxStatement, shopName: string): Buffer {
  const W = PDF_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (l: string, r: string) => add(l + r.padStart(Math.max(1, W - l.length)));
  add("TCS AND TDS STATEMENT FROM GOKESARI", true);
  add(`${shopName} — ${s.period}   GSTIN ${s.gstin ?? "-"}   PAN ${s.panMasked ?? "-"}`.slice(0, W));
  add("-".repeat(W));
  add("GST TCS collected by GoKesari under section 52 (appears in your GSTR-2B as TCS credit)", true);
  pair("Taxable supplies through GoKesari", money(s.tcs.grossPaise));
  pair("Less returns", money(s.tcs.returnsPaise));
  pair("Net taxable value", money(s.tcs.netPaise));
  pair("TCS - IGST", money(s.tcs.igstPaise));
  pair("TCS - CGST", money(s.tcs.cgstPaise));
  pair("TCS - SGST", money(s.tcs.sgstPaise));
  add();
  add(`Income-tax TDS deducted by GoKesari (${s.tds.section ?? "s.393(1)"})`, true);
  pair("Amount on which TDS was deducted", money(s.tds.basePaise));
  pair("Amount within the exemption (individual / HUF)", money(s.tds.exemptBasePaise));
  pair("TDS deducted", money(s.tds.tdsPaise));
  add();
  add(`Orders settled: ${s.orders}. Figures are from your payout statements; the TCS credit shows in your electronic`);
  add("cash ledger once GoKesari files GSTR-8 (due the 10th of the next month).");
  return textPdf(out, { title: `TCS/TDS statement ${s.period}` });
}

export async function shopStatementFiles(shopId: string, kind: "wallet" | "tax" | "settlement", period: string, format: "pdf" | "csv"): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
  if (kind === "wallet") {
    const s = await shopWalletStatement(shopId, period);
    return format === "csv"
      ? { bytes: Buffer.from(walletStatementCsv(s)), contentType: "text/csv", filename: `wallet-${period}.csv` }
      : { bytes: walletStatementPdf(s), contentType: "application/pdf", filename: `wallet-${period}.pdf` };
  }
  if (kind === "tax") {
    const s = await shopTaxStatement(shopId, period);
    const [shop] = await db.select({ name: shops.name, legal: shops.legalBusinessName }).from(shops).where(eq(shops.id, shopId));
    if (format === "csv") {
      const csv =
        ["period,gstin,net_taxable_inr,tcs_igst_inr,tcs_cgst_inr,tcs_sgst_inr,tds_base_inr,tds_exempt_base_inr,tds_inr",
          [s.period, s.gstin, s.tcs.netPaise / 100, s.tcs.igstPaise / 100, s.tcs.cgstPaise / 100, s.tcs.sgstPaise / 100, s.tds.basePaise / 100, s.tds.exemptBasePaise / 100, s.tds.tdsPaise / 100].map(cell).join(",")].join("\n") + "\n";
      return { bytes: Buffer.from(csv), contentType: "text/csv", filename: `tcs-tds-${period}.csv` };
    }
    return { bytes: taxStatementPdf(s, shop?.legal ?? shop?.name ?? ""), contentType: "application/pdf", filename: `tcs-tds-${period}.pdf` };
  }
  const report = await orderSettlementReport(shopId, period);
  const csv = [report.header.join(","), ...report.rows.map((r) => r.map(cell).join(","))].join("\n") + "\n";
  return { bytes: Buffer.from(csv), contentType: "text/csv", filename: `settlement-${period}.csv` };
}
