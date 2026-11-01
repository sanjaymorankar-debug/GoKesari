/**
 * Reports of the shop's books (docs/inventory-accounting-2026-10, Part 2):
 * profit & loss, stock summary, day book, purchase and sales registers, GST
 * summary — each as data for the screen and as Excel, PDF or (for vouchers)
 * Tally-compatible XML that TallyPrime imports (Gateway of Tally → Import →
 * Transactions / Masters).
 *
 * Profit & loss uses perpetual stock: cost of goods sold is the valuation
 * (FIFO / weighted average) of what left the shelf as sales in the period,
 * written-off stock is its own line, and expenses are net of claimable GST.
 * Sales include the shop's own invoices and its GoKesari order invoices
 * (net of credit notes), at taxable value.
 */
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import ExcelJS from "exceljs";

import { BOOK_ACCOUNT_LABELS, CA_NOTE, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/lib/accounts/constants";
import { formatMilli } from "@/lib/accounts/units";
import { textPdf, type PdfLine } from "@/lib/pdf";
import { db } from "@/server/db";
import { accExpenses, accLedgerEntries, accParties, accPurchaseInvoices, accSalesInvoices, creditNotes, shops, taxInvoices } from "@/server/db/schema";
import { safeCell } from "@/server/integrations/tabular";
import { xmlEscape } from "@/server/integrations/adapters/tally";
import { dayBook } from "./money";
import { gstLiability } from "./gst";
import { costOfGoods, stockSummary } from "./stock";

const rupees = (p: number) => Math.round(p) / 100;
const rs = (p: number) => `Rs. ${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface ProfitAndLoss {
  from: string;
  to: string;
  salesOwnPaise: number;
  salesOnlinePaise: number;
  salesPaise: number;
  cogsPaise: number;
  grossProfitPaise: number;
  writeOffPaise: number;
  expenses: { category: ExpenseCategory; label: string; amountPaise: number }[];
  expensesPaise: number;
  netProfitPaise: number;
  purchasesPaise: number;
  openingStockPaise: number;
  closingStockPaise: number;
  note: string;
}

export async function profitAndLoss(shopId: string, from: string, to: string): Promise<ProfitAndLoss> {
  const istDate = (col: typeof taxInvoices.issuedAt | typeof creditNotes.issuedAt) => sql`(${col} + interval '330 minutes')::date`;
  const [[own], [online], [cn], expenseRows, [purchases], goods] = await Promise.all([
    db
      .select({ v: sql<number>`coalesce(sum(${accSalesInvoices.taxablePaise}),0)::bigint` })
      .from(accSalesInvoices)
      .where(and(eq(accSalesInvoices.shopId, shopId), eq(accSalesInvoices.status, "ISSUED"), gte(accSalesInvoices.invoiceDate, from), lt(accSalesInvoices.invoiceDate, to))),
    db
      .select({ v: sql<number>`coalesce(sum(${taxInvoices.taxablePaise}),0)::bigint` })
      .from(taxInvoices)
      .where(and(eq(taxInvoices.shopId, shopId), sql`${istDate(taxInvoices.issuedAt)} >= ${from}::date`, sql`${istDate(taxInvoices.issuedAt)} < ${to}::date`)),
    db
      .select({ v: sql<number>`coalesce(sum(${creditNotes.taxablePaise}),0)::bigint` })
      .from(creditNotes)
      .where(and(eq(creditNotes.shopId, shopId), sql`${istDate(creditNotes.issuedAt)} >= ${from}::date`, sql`${istDate(creditNotes.issuedAt)} < ${to}::date`)),
    db
      .select({ category: accExpenses.category, v: sql<number>`coalesce(sum(${accExpenses.amountPaise} - ${accExpenses.gstPaise}),0)::bigint` })
      .from(accExpenses)
      .where(and(eq(accExpenses.shopId, shopId), eq(accExpenses.status, "ACTIVE"), gte(accExpenses.expenseDate, from), lt(accExpenses.expenseDate, to)))
      .groupBy(accExpenses.category),
    db
      .select({ v: sql<number>`coalesce(sum(${accPurchaseInvoices.taxablePaise} + ${accPurchaseInvoices.otherChargesPaise}),0)::bigint` })
      .from(accPurchaseInvoices)
      .where(and(eq(accPurchaseInvoices.shopId, shopId), eq(accPurchaseInvoices.status, "CONFIRMED"), gte(accPurchaseInvoices.invoiceDate, from), lt(accPurchaseInvoices.invoiceDate, to))),
    costOfGoods(shopId, from, to),
  ]);
  const salesOwn = Number(own.v);
  const salesOnline = Number(online.v) - Number(cn.v);
  const sales = salesOwn + salesOnline;
  const expenses = expenseRows.map((r) => ({ category: r.category, label: EXPENSE_CATEGORY_LABELS[r.category], amountPaise: Number(r.v) })).sort((a, b) => b.amountPaise - a.amountPaise);
  const expensesTotal = expenses.reduce((n, e) => n + e.amountPaise, 0);
  const gross = sales - goods.cogsPaise;
  return {
    from,
    to,
    salesOwnPaise: salesOwn,
    salesOnlinePaise: salesOnline,
    salesPaise: sales,
    cogsPaise: goods.cogsPaise,
    grossProfitPaise: gross,
    writeOffPaise: goods.writeOffPaise,
    expenses,
    expensesPaise: expensesTotal,
    netProfitPaise: gross - goods.writeOffPaise - expensesTotal,
    purchasesPaise: Number(purchases.v),
    openingStockPaise: goods.openingValuePaise,
    closingStockPaise: goods.closingValuePaise,
    note: "Estimate from your books. Stock is valued at cost; GoKesari order sales are at taxable value net of credit notes.",
  };
}

/* ---------------------------------------------------------------- tables */

export type ReportKind = "pnl" | "stock" | "daybook" | "purchases" | "sales" | "gst" | "ledger" | BillingReportKind;

/** Billing v2 (docs/billing §6.1, §6.2, §8 G10): reports added on top of the module's own. */
export const BILLING_REPORT_KINDS = ["trial", "balance", "coa", "stockmove", "stockage", "taxcredit", "mtr"] as const;
export type BillingReportKind = (typeof BILLING_REPORT_KINDS)[number];

export interface ReportTable {
  title: string;
  subtitle: string;
  header: string[];
  rows: (string | number | null)[][];
  /** Lines under the table (totals, notes). */
  footer: string[];
}

export async function reportTable(shopId: string, kind: ReportKind, from: string, to: string): Promise<ReportTable> {
  const [shop] = await db.select({ name: shops.name, gstin: shops.gstin }).from(shops).where(eq(shops.id, shopId));
  const subtitle = `${shop?.name ?? ""}${shop?.gstin ? ` · GSTIN ${shop.gstin}` : ""} · ${from} to ${prevDay(to)}`;
  if ((BILLING_REPORT_KINDS as readonly string[]).includes(kind)) {
    const { billingReport } = await import("./billing-reports");
    return billingReport(shopId, kind as BillingReportKind, from, to, subtitle);
  }
  switch (kind as Exclude<ReportKind, BillingReportKind>) {
    case "pnl": {
      const p = await profitAndLoss(shopId, from, to);
      return {
        title: "Profit & loss",
        subtitle,
        header: ["Item", "Amount (₹)"],
        rows: [
          ["Sales — own invoices", rupees(p.salesOwnPaise)],
          ["Sales — GoKesari orders (net of credit notes)", rupees(p.salesOnlinePaise)],
          ["Total sales", rupees(p.salesPaise)],
          ["Cost of goods sold", -rupees(p.cogsPaise)],
          ["Gross profit", rupees(p.grossProfitPaise)],
          ["Stock written off (damaged / expired)", -rupees(p.writeOffPaise)],
          ...p.expenses.map((e) => [`Expense — ${e.label}`, -rupees(e.amountPaise)] as (string | number)[]),
          ["Net profit", rupees(p.netProfitPaise)],
          ["", null],
          ["Purchases in the period (for reference)", rupees(p.purchasesPaise)],
          ["Opening stock at cost", rupees(p.openingStockPaise)],
          ["Closing stock at cost", rupees(p.closingStockPaise)],
        ],
        footer: [p.note],
      };
    }
    case "stock": {
      const s = await stockSummary(shopId, { asOf: prevDay(to) });
      return {
        title: `Stock summary (${s.method === "FIFO" ? "FIFO" : "weighted average"})`,
        subtitle: `${shop?.name ?? ""} · as on ${s.asOf}`,
        header: ["Product", "Unit", "Quantity", "Cost per unit (₹)", "Value (₹)", "Status"],
        rows: s.rows.map((r) => [r.name, r.sellableUnit, Number(formatMilli(r.qtyMilli)), rupees(r.unitCostPaise), rupees(r.valuePaise), r.status.replace(/_/g, " ").toLowerCase()]),
        footer: [`Total stock value: ${rs(s.totalValuePaise)}`],
      };
    }
    case "daybook": {
      const vouchers = await dayBook(shopId, from, to);
      return {
        title: "Day book",
        subtitle,
        header: ["Date", "Voucher", "Ref", "Account", "Party", "Debit (₹)", "Credit (₹)", "Narration"],
        rows: vouchers.flatMap((v) => v.legs.map((l) => [v.entryDate, v.voucherType, v.docRef, BOOK_ACCOUNT_LABELS[l.account], l.partyName, l.debitPaise ? rupees(l.debitPaise) : null, l.creditPaise ? rupees(l.creditPaise) : null, v.narration])),
        footer: [`${vouchers.length} voucher(s)`],
      };
    }
    case "purchases": {
      const rows = await db
        .select()
        .from(accPurchaseInvoices)
        .where(and(eq(accPurchaseInvoices.shopId, shopId), gte(accPurchaseInvoices.invoiceDate, from), lt(accPurchaseInvoices.invoiceDate, to)))
        .orderBy(asc(accPurchaseInvoices.invoiceDate));
      const live = rows.filter((r) => r.status === "CONFIRMED");
      return {
        title: "Purchase register",
        subtitle,
        header: ["Date", "Invoice", "Supplier", "GSTIN", "Taxable (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)", "Cess (₹)", "Total (₹)", "Status", "Version"],
        rows: rows.map((r) => [r.invoiceDate, r.invoiceNo, r.supplierName, r.supplierGstin, rupees(r.taxablePaise), rupees(r.cgstPaise), rupees(r.sgstPaise), rupees(r.igstPaise), rupees(r.cessPaise), rupees(r.totalPaise), r.status, r.version]),
        footer: [`Confirmed: ${live.length} bill(s), ${rs(live.reduce((n, r) => n + r.totalPaise, 0))}`],
      };
    }
    case "sales": {
      const rows = await db
        .select()
        .from(accSalesInvoices)
        .where(and(eq(accSalesInvoices.shopId, shopId), gte(accSalesInvoices.invoiceDate, from), lt(accSalesInvoices.invoiceDate, to)))
        .orderBy(asc(accSalesInvoices.invoiceDate));
      const online = await db
        .select()
        .from(taxInvoices)
        .where(and(eq(taxInvoices.shopId, shopId), sql`(${taxInvoices.issuedAt} + interval '330 minutes')::date >= ${from}::date`, sql`(${taxInvoices.issuedAt} + interval '330 minutes')::date < ${to}::date`))
        .orderBy(asc(taxInvoices.issuedAt));
      return {
        title: "Sales register",
        subtitle,
        header: ["Date", "Invoice", "Source", "Buyer", "GSTIN", "Place of supply", "Taxable (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)", "Total (₹)", "Status"],
        rows: [
          ...rows.map((r) => [r.invoiceDate, r.invoiceNo, "Own invoice", r.buyerName, r.buyerGstin, r.placeOfSupply, rupees(r.taxablePaise), rupees(r.cgstPaise), rupees(r.sgstPaise), rupees(r.igstPaise), rupees(r.totalPaise), r.status]),
          ...online.map((r) => [new Date(r.issuedAt.getTime() + 330 * 60_000).toISOString().slice(0, 10), r.invoiceNumber, "GoKesari order", null, ((r.snapshot as { buyer?: { gstin?: string } }).buyer?.gstin ?? null) as string | null, null, rupees(r.taxablePaise), rupees(r.cgstPaise), rupees(r.sgstPaise), rupees(r.igstPaise), rupees(r.totalPaise), r.kind]),
        ],
        footer: [`Own invoices: ${rows.filter((r) => r.status === "ISSUED").length} · GoKesari orders: ${online.length}`],
      };
    }
    case "gst": {
      const months = monthsIn(from, to);
      const views = await Promise.all(months.map((m) => gstLiability(shopId, m, "MONTHLY")));
      return {
        title: "GST summary (estimate)",
        subtitle,
        header: ["Month", "Output CGST", "Output SGST", "Output IGST", "ITC CGST (reconciled)", "ITC SGST", "ITC IGST", "ITC pending reconciliation", "Cash payable CGST", "SGST", "IGST", "Total payable (₹)"],
        rows: views.map((v) => {
          const m = v.months[0];
          const pending = m.pendingItc.cgst + m.pendingItc.sgst + m.pendingItc.igst + m.pendingItc.cess;
          return [m.period, rupees(m.output.cgst), rupees(m.output.sgst), rupees(m.output.igst), rupees(m.eligibleItc.cgst), rupees(m.eligibleItc.sgst), rupees(m.eligibleItc.igst), rupees(pending), rupees(m.setOff.cash.cgst), rupees(m.setOff.cash.sgst), rupees(m.setOff.cash.igst), rupees(m.setOff.totalCash)];
        }),
        footer: [CA_NOTE],
      };
    }
    case "ledger": {
      const rows = await db
        .select({ e: accLedgerEntries, partyName: accParties.name })
        .from(accLedgerEntries)
        .leftJoin(accParties, eq(accLedgerEntries.partyId, accParties.id))
        .where(and(eq(accLedgerEntries.shopId, shopId), gte(accLedgerEntries.entryDate, from), lt(accLedgerEntries.entryDate, to)))
        .orderBy(asc(accLedgerEntries.entryDate), asc(accLedgerEntries.createdAt));
      return {
        title: "All entries",
        subtitle,
        header: ["Date", "Voucher", "Ref", "Account", "Party", "Debit (₹)", "Credit (₹)"],
        rows: rows.map(({ e, partyName }) => [e.entryDate, e.voucherType, e.docRef, BOOK_ACCOUNT_LABELS[e.account] + (e.subAccount ? ` · ${e.subAccount}` : ""), partyName, e.debitPaise ? rupees(e.debitPaise) : null, e.creditPaise ? rupees(e.creditPaise) : null]),
        footer: [],
      };
    }
  }
}

function prevDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function monthsIn(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  while (`${y}-${String(m).padStart(2, "0")}-01` < to && out.length < 36) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/* --------------------------------------------------------------- exports */

export async function tableToXlsx(t: ReportTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  const ws = wb.addWorksheet(t.title.slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
  ws.addRow([t.title]).font = { bold: true, size: 14 };
  ws.addRow([t.subtitle]);
  ws.addRow([]);
  ws.addRow(t.header).font = { bold: true };
  for (const r of t.rows) ws.addRow(r.map((v) => (typeof v === "number" ? v : safeCell(v))));
  ws.addRow([]);
  for (const f of t.footer) ws.addRow([f]);
  ws.columns.forEach((col, i) => {
    col.width = Math.min(45, Math.max(10, (t.header[i] ?? "").length + 2, ...t.rows.slice(0, 200).map((r) => String(r[i] ?? "").length + 1)));
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function tableToPdf(t: ReportTable): Buffer {
  const widths = t.header.map((h, i) => Math.min(28, Math.max(h.length, ...t.rows.slice(0, 500).map((r) => String(r[i] ?? "").length))) + 1);
  const fmt = (cells: (string | number | null)[]) => cells.map((c, i) => String(c ?? "").slice(0, widths[i] - 1).padEnd(widths[i])).join("");
  const lines: PdfLine[] = [{ text: t.title, bold: true }, { text: t.subtitle }, { text: "" }, { text: fmt(t.header), bold: true }, ...t.rows.map((r) => ({ text: fmt(r) })), { text: "" }, ...t.footer.map((f) => ({ text: f }))];
  return textPdf(lines, { title: t.title });
}

/* ------------------------------------------------------------- Tally XML */

const TALLY_LEDGER: Record<string, string> = {
  CASH: "Cash",
  BANK: "Bank Account",
  PURCHASES: "Purchase Accounts",
  SALES: "Sales Accounts",
  GST_INPUT_CGST: "Input CGST",
  GST_INPUT_SGST: "Input SGST",
  GST_INPUT_IGST: "Input IGST",
  GST_INPUT_CESS: "Input Cess",
  GST_OUTPUT_CGST: "Output CGST",
  GST_OUTPUT_SGST: "Output SGST",
  GST_OUTPUT_IGST: "Output IGST",
  GST_OUTPUT_CESS: "Output Cess",
  EXPENSE: "Indirect Expenses",
  STOCK_WRITE_OFF: "Stock Written Off",
  ROUND_OFF: "Round Off",
  CAPITAL: "Capital Account",
  ADVANCES_RECEIVED: "Advance from Customers",
  TCS_RECEIVABLE: "TCS Receivable",
  TDS_RECEIVABLE: "TDS Receivable",
  COMMISSION_EXPENSE: "GoKesari Commission",
  DELIVERY_EXPENSE: "Delivery Charges",
  GOKESARI_ACCOUNT: "GoKesari Account",
};

const TALLY_VOUCHER: Record<string, string> = {
  PURCHASE: "Purchase",
  SALE: "Sales",
  PAYMENT: "Payment",
  RECEIPT: "Receipt",
  EXPENSE: "Payment",
  OPENING: "Journal",
  REVERSAL: "Journal",
  WRITE_OFF: "Journal",
  SALES_RETURN: "Credit Note",
  PURCHASE_RETURN: "Debit Note",
  DEBIT_NOTE: "Debit Note",
  CONTRA: "Contra",
  JOURNAL: "Journal",
  STOCK_JOURNAL: "Stock Journal",
};

const tallyDate = (d: string) => d.replace(/-/g, "");
const amt = (paise: number) => (paise / 100).toFixed(2);

/**
 * Every voucher of the period as a Tally import file: party ledgers as
 * masters (Sundry Creditors / Debtors with GSTIN), then the vouchers. In
 * Tally a debit is a negative AMOUNT with ISDEEMEDPOSITIVE Yes.
 */
export async function tallyXml(shopId: string, from: string, to: string, company?: string): Promise<string> {
  const [shop] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, shopId));
  const rows = await db
    .select({ e: accLedgerEntries, party: accParties })
    .from(accLedgerEntries)
    .leftJoin(accParties, eq(accLedgerEntries.partyId, accParties.id))
    .where(and(eq(accLedgerEntries.shopId, shopId), gte(accLedgerEntries.entryDate, from), lt(accLedgerEntries.entryDate, to)))
    .orderBy(asc(accLedgerEntries.entryDate), asc(accLedgerEntries.createdAt));
  const parties = new Map<string, NonNullable<(typeof rows)[number]["party"]>>();
  const vouchers = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.party) parties.set(r.party.id, r.party);
    vouchers.set(r.e.voucherId, [...(vouchers.get(r.e.voucherId) ?? []), r]);
  }
  const ledgerName = (r: (typeof rows)[number]) =>
    r.e.account === "PARTY" ? (r.party?.name ?? "Party") : r.e.account === "EXPENSE" && r.e.subAccount ? EXPENSE_CATEGORY_LABELS[r.e.subAccount as ExpenseCategory] ?? "Indirect Expenses" : TALLY_LEDGER[r.e.account];
  const masters = [...parties.values()]
    .map(
      (p) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xmlEscape(p.name)}" ACTION="Create"><NAME.LIST><NAME>${xmlEscape(p.name)}</NAME></NAME.LIST><PARENT>${p.kind === "CUSTOMER" ? "Sundry Debtors" : "Sundry Creditors"}</PARENT>${p.gstin ? `<PARTYGSTIN>${xmlEscape(p.gstin)}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : "<GSTREGISTRATIONTYPE>Unregistered</GSTREGISTRATIONTYPE>"}${p.address ? `<ADDRESS.LIST><ADDRESS>${xmlEscape(p.address)}</ADDRESS></ADDRESS.LIST>` : ""}</LEDGER></TALLYMESSAGE>`,
    )
    .join("\n");
  const body = [...vouchers.entries()]
    .map(([id, legs]) => {
      const v = legs[0].e;
      const type = TALLY_VOUCHER[v.voucherType] ?? "Journal";
      const party = legs.find((l) => l.e.account === "PARTY")?.party?.name;
      const entries = legs
        .map((l) => {
          const debit = l.e.debitPaise > 0;
          const amount = debit ? -l.e.debitPaise : l.e.creditPaise;
          return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(ledgerName(l))}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${amt(amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
        })
        .join("");
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="gokesari-${id}" VCHTYPE="${type}" ACTION="Create"><DATE>${tallyDate(v.entryDate)}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>${v.docRef ? `<VOUCHERNUMBER>${xmlEscape(v.docRef)}</VOUCHERNUMBER><REFERENCE>${xmlEscape(v.docRef)}</REFERENCE>` : ""}${party ? `<PARTYLEDGERNAME>${xmlEscape(party)}</PARTYLEDGERNAME>` : ""}<NARRATION>${xmlEscape(v.narration ?? "")}</NARRATION>${entries}</VOUCHER></TALLYMESSAGE>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY>
<IMPORTDATA>
<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(company ?? shop?.name ?? "")}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA>
${masters}
</REQUESTDATA>
</IMPORTDATA>
<IMPORTDATA>
<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(company ?? shop?.name ?? "")}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA>
${body}
</REQUESTDATA>
</IMPORTDATA>
</BODY>
</ENVELOPE>
`;
}

