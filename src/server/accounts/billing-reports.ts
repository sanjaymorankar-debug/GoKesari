/**
 * Billing v2 reports of the shop's books (docs/billing §6.1, §6.2, §8 G10),
 * in the module's table form (screen, Excel, PDF — reports.ts):
 *
 *   trial      trial balance by ledger, with its Tally group
 *   balance    balance sheet as at the end date (closing stock at cost)
 *   coa        chart of accounts: groups, ledgers (parties and sub-ledgers), balances
 *   stockmove  stock movement per item: opening, in, out, closing
 *   stockage   stock ageing: days since each batch / the last purchase
 *   taxcredit  GST TCS and income-tax TDS GoKesari collected / deducted
 *   mtr        marketplace tax report (MTR-style), B2B and B2C, line by line:
 *              GoKesari orders, counter sales, credit / debit notes — GSTIN,
 *              number, date, HSN, taxable value, rate, CGST/SGST/IGST/cess,
 *              place of supply, B2B/B2C, e-commerce operator GSTIN
 */
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { ACCOUNT_GROUPS, BOOK_ACCOUNT_LABELS, type BookAccount } from "@/lib/accounts/constants";
import { gstState } from "@/lib/gst-states";
import { db } from "@/server/db";
import {
  accDocuments,
  accLedgerEntries,
  accParties,
  accSalesInvoices,
  accSalesLines,
  creditNotes,
  invBatches,
  invProductSettings,
  invStockLedger,
  products,
  shopProducts,
  taxInvoices,
} from "@/server/db/schema";
import type { InvoiceSnapshot } from "@/server/services/invoices";
import type { CreditNoteSnapshot } from "@/server/gst/credit-notes";
import type { BillingReportKind, ReportTable } from "./reports";
import { stockSummary } from "./stock";

const r2 = (p: number) => Math.round(p) / 100;
const IST = (iso: string) => new Date(`${iso}T00:00:00+05:30`);
const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

async function balances(shopId: string, until: string) {
  const rows = await db
    .select({
      account: accLedgerEntries.account,
      partyId: accLedgerEntries.partyId,
      subAccount: accLedgerEntries.subAccount,
      dr: sql<number>`coalesce(sum(${accLedgerEntries.debitPaise}), 0)::bigint`,
      cr: sql<number>`coalesce(sum(${accLedgerEntries.creditPaise}), 0)::bigint`,
    })
    .from(accLedgerEntries)
    .where(and(eq(accLedgerEntries.shopId, shopId), lt(accLedgerEntries.entryDate, until)))
    .groupBy(accLedgerEntries.account, accLedgerEntries.partyId, accLedgerEntries.subAccount);
  return rows.map((r) => ({ account: r.account as BookAccount, partyId: r.partyId, subAccount: r.subAccount, net: Number(r.dr) - Number(r.cr), dr: Number(r.dr), cr: Number(r.cr) }));
}

export async function billingReport(shopId: string, kind: BillingReportKind, from: string, to: string, subtitle: string): Promise<ReportTable> {
  switch (kind) {
    case "trial": {
      const rows = await balances(shopId, to);
      const byAccount = new Map<BookAccount, { dr: number; cr: number }>();
      for (const r of rows) {
        const a = byAccount.get(r.account) ?? { dr: 0, cr: 0 };
        a.dr += r.dr;
        a.cr += r.cr;
        byAccount.set(r.account, a);
      }
      const list = [...byAccount.entries()].map(([account, a]) => ({ account, net: a.dr - a.cr })).filter((a) => a.net !== 0);
      const dr = list.filter((a) => a.net > 0).reduce((n, a) => n + a.net, 0);
      const cr = list.filter((a) => a.net < 0).reduce((n, a) => n - a.net, 0);
      return {
        title: "Trial balance",
        subtitle: subtitle.replace(/ · .* to /, " · as at "),
        header: ["Ledger", "Group", "Debit (₹)", "Credit (₹)"],
        rows: list.map((a) => [BOOK_ACCOUNT_LABELS[a.account] ?? a.account, ACCOUNT_GROUPS[a.account]?.group ?? "", a.net > 0 ? r2(a.net) : null, a.net < 0 ? r2(-a.net) : null]),
        footer: [`Totals: debit ₹${r2(dr).toFixed(2)}, credit ₹${r2(cr).toFixed(2)}${dr === cr ? " — balanced" : " — NOT balanced"}`],
      };
    }
    case "balance": {
      const rows = await balances(shopId, to);
      const stock = await stockSummary(shopId, { asOf: dayBefore(to) });
      const closingStock = stock.totalValuePaise;
      let assets = 0;
      let liabilities = 0;
      let capital = 0;
      let profit = closingStock;
      const lines: (string | number | null)[][] = [];
      const add = (side: string, label: string, paise: number) => {
        if (paise !== 0) lines.push([side, label, r2(paise)]);
      };
      const byAccount = new Map<BookAccount, number>();
      for (const r of rows) {
        if (r.account === "PARTY") {
          // A party with a debit balance owes the shop (debtor); a credit balance is owed (creditor).
          if (r.net > 0) assets += r.net;
          else liabilities += -r.net;
          continue;
        }
        byAccount.set(r.account, (byAccount.get(r.account) ?? 0) + r.net);
      }
      const debtors = rows.filter((r) => r.account === "PARTY" && r.net > 0).reduce((n, r) => n + r.net, 0);
      const creditors = rows.filter((r) => r.account === "PARTY" && r.net < 0).reduce((n, r) => n - r.net, 0);
      // GST: input and output ledgers net into one "Duties & Taxes" balance.
      let gstNet = 0;
      for (const [account, net] of byAccount) {
        const nature = ACCOUNT_GROUPS[account]?.nature;
        if (account.startsWith("GST_")) gstNet += net;
        else if (nature === "INCOME" || nature === "EXPENSE") profit -= net;
        else if (nature === "CAPITAL") capital -= net;
        else if (net >= 0) {
          assets += net;
          add("Assets", BOOK_ACCOUNT_LABELS[account], net);
        } else {
          liabilities += -net;
          add("Liabilities", BOOK_ACCOUNT_LABELS[account], -net);
        }
      }
      if (gstNet > 0) {
        assets += gstNet;
        add("Assets", "GST input credit (net)", gstNet);
      } else if (gstNet < 0) {
        liabilities += -gstNet;
        add("Liabilities", "GST payable (net)", -gstNet);
      }
      add("Assets", "Sundry debtors (parties)", debtors);
      add("Liabilities", "Sundry creditors (parties)", creditors);
      assets += closingStock;
      add("Assets", "Closing stock (at cost)", closingStock);
      add("Capital", "Capital account", capital);
      add("Capital", "Profit / loss to date", profit);
      lines.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      return {
        title: "Balance sheet",
        subtitle: subtitle.replace(/ · .* to /, " · as at "),
        header: ["Side", "Item", "Amount (₹)"],
        rows: lines,
        footer: [
          `Assets ₹${r2(assets).toFixed(2)} = liabilities ₹${r2(liabilities).toFixed(2)} + capital ₹${r2(capital).toFixed(2)} + profit ₹${r2(profit).toFixed(2)}${assets === liabilities + capital + profit ? " — balanced" : " — check the books"}`,
          "Purchases are expensed and closing stock is added back at cost (FIFO / weighted average as set). Estimate from your books; your CA finalises it.",
        ],
      };
    }
    case "coa": {
      const rows = await balances(shopId, to);
      const parties = await db.select({ id: accParties.id, name: accParties.name }).from(accParties).where(eq(accParties.shopId, shopId));
      const name = new Map(parties.map((p) => [p.id, p.name]));
      const out: (string | number | null)[][] = [];
      for (const account of Object.keys(ACCOUNT_GROUPS) as BookAccount[]) {
        const mine = rows.filter((r) => r.account === account);
        const total = mine.reduce((n, r) => n + r.net, 0);
        out.push([ACCOUNT_GROUPS[account].group, BOOK_ACCOUNT_LABELS[account], null, r2(total)]);
        for (const r of mine.filter((x) => x.partyId || x.subAccount)) {
          out.push([ACCOUNT_GROUPS[account].group, BOOK_ACCOUNT_LABELS[account], r.partyId ? (name.get(r.partyId) ?? "Party") : r.subAccount, r2(r.net)]);
        }
      }
      out.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      return { title: "Chart of accounts", subtitle, header: ["Group", "Ledger", "Sub-ledger / party", "Balance Dr(+) / Cr(−) (₹)"], rows: out, footer: ["Groups follow TallyPrime's defaults, so the ledgers map one to one when exported."] };
    }
    case "stockmove": {
      const entries = await db
        .select({ spId: invStockLedger.shopProductId, date: invStockLedger.entryDate, qty: invStockLedger.qtyMilli, type: invStockLedger.movementType })
        .from(invStockLedger)
        .where(and(eq(invStockLedger.shopId, shopId), lt(invStockLedger.entryDate, to)));
      const names = await db.select({ id: shopProducts.id, name: products.name }).from(shopProducts).innerJoin(products, eq(products.id, shopProducts.productId)).where(eq(shopProducts.shopId, shopId));
      const byItem = new Map<string, { opening: number; inward: number; outward: number }>();
      for (const e of entries) {
        if (e.type === "TRANSFER") continue; // moves between the shop's two counts, not in or out
        const b = byItem.get(e.spId) ?? { opening: 0, inward: 0, outward: 0 };
        if (e.date < from) b.opening += e.qty;
        else if (e.qty > 0) b.inward += e.qty;
        else b.outward += -e.qty;
        byItem.set(e.spId, b);
      }
      const nameOf = new Map(names.map((n) => [n.id, n.name]));
      const rows = [...byItem.entries()]
        .filter(([, b]) => b.opening || b.inward || b.outward)
        .map(([id, b]) => [nameOf.get(id) ?? id, b.opening / 1000, b.inward / 1000, b.outward / 1000, (b.opening + b.inward - b.outward) / 1000])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      return { title: "Stock movement", subtitle, header: ["Item", "Opening", "In", "Out", "Closing"], rows, footer: ["Quantities in the item's unit. Transfers between the online and in-shop counts are left out (they do not change the total)."] };
    }
    case "stockage": {
      const today = to;
      const ageOf = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000)) : null);
      const bucket = (days: number | null) => (days == null ? "unknown" : days <= 30 ? "0–30" : days <= 60 ? "31–60" : days <= 90 ? "61–90" : "90+");
      const stock = await stockSummary(shopId, { asOf: dayBefore(to) });
      const batches = await db.select().from(invBatches).where(eq(invBatches.shopId, shopId));
      const settings = await db.select().from(invProductSettings).where(eq(invProductSettings.shopId, shopId));
      const rows: (string | number | null)[][] = [];
      for (const item of stock.rows) {
        if (!item.qtyMilli || item.qtyMilli <= 0) continue;
        const mine = batches.filter((b) => b.shopProductId === item.shopProductId);
        const last = settings.find((s) => s.shopProductId === item.shopProductId)?.lastPurchaseAt ?? null;
        const received = mine.length ? istDay(mine.map((b) => b.createdAt).sort((a, b) => a.getTime() - b.getTime())[0]) : last ? istDay(last) : null;
        const days = ageOf(received);
        rows.push([item.name, item.qtyMilli / 1000, r2(item.valuePaise ?? 0), received, days, bucket(days)]);
      }
      rows.sort((a, b) => Number(b[4] ?? -1) - Number(a[4] ?? -1));
      return { title: "Stock ageing", subtitle: subtitle.replace(/ · .* to /, " · as at "), header: ["Item", "Quantity", "Value (₹)", "Oldest received", "Days", "Bucket"], rows, footer: ["Age from the oldest batch received, else the last purchase. Items never purchased through the books show 'unknown'."] };
    }
    case "taxcredit": {
      const entries = await db
        .select()
        .from(accLedgerEntries)
        .where(and(eq(accLedgerEntries.shopId, shopId), inArray(accLedgerEntries.account, ["TCS_RECEIVABLE", "TDS_RECEIVABLE"]), gte(accLedgerEntries.entryDate, from), lt(accLedgerEntries.entryDate, to)))
        .orderBy(asc(accLedgerEntries.entryDate));
      const tcs = entries.filter((e) => e.account === "TCS_RECEIVABLE").reduce((n, e) => n + e.debitPaise - e.creditPaise, 0);
      const tds = entries.filter((e) => e.account === "TDS_RECEIVABLE").reduce((n, e) => n + e.debitPaise - e.creditPaise, 0);
      return {
        title: "TCS / TDS credit",
        subtitle,
        header: ["Date", "Tax", "Reference", "Amount (₹)", "Details"],
        rows: entries.map((e) => [e.entryDate, e.account === "TCS_RECEIVABLE" ? "GST TCS" : "Income-tax TDS", e.docRef, r2(e.debitPaise - e.creditPaise), e.narration]),
        footer: [`GST TCS ₹${r2(tcs).toFixed(2)} — claim in GSTR-3B / electronic cash ledger after GoKesari files GSTR-8.`, `Income-tax TDS ₹${r2(tds).toFixed(2)} — claim in your income-tax return (Form 26AS / AIS).`],
      };
    }
    case "mtr":
      return marketplaceTaxReport(shopId, from, to, subtitle);
  }
}

/** MTR-style B2B and B2C tax report, line by line (§8 G10). */
async function marketplaceTaxReport(shopId: string, from: string, to: string, subtitle: string): Promise<ReportTable> {
  const header = ["Type", "Document", "Number", "Date", "Buyer GSTIN", "B2B/B2C", "Place of supply", "HSN", "Description", "Qty", "UQC", "Taxable (₹)", "GST %", "CGST (₹)", "SGST (₹)", "IGST (₹)", "Cess (₹)", "Total (₹)", "E-commerce operator GSTIN", "Channel"];
  const rows: (string | number | null)[][] = [];
  const pos = (code: string | null | undefined) => (code ? (gstState(code)?.code ?? code) : "");
  const invoices = await db
    .select()
    .from(taxInvoices)
    .where(and(eq(taxInvoices.shopId, shopId), eq(taxInvoices.status, "ISSUED"), gte(taxInvoices.issuedAt, IST(from)), lt(taxInvoices.issuedAt, IST(to))))
    .orderBy(asc(taxInvoices.issuedAt));
  for (const inv of invoices) {
    const s = inv.snapshot as unknown as InvoiceSnapshot;
    const b2b = s.buyer.gstin ? "B2B" : "B2C";
    for (const l of s.lines) {
      rows.push(["Sale", s.kind === "TAX_INVOICE" ? "Tax invoice" : "Bill of supply", inv.invoiceNumber, istDay(inv.issuedAt), s.buyer.gstin, b2b, pos(s.placeOfSupply), l.hsn, l.description, l.qty ?? null, l.uqc ?? null, r2(l.taxablePaise), l.rateBp / 100, r2(l.cgstPaise), r2(l.sgstPaise), r2(l.igstPaise), r2(l.cessPaise ?? 0), r2(l.grossPaise), s.eco?.gstin ?? null, "GoKesari"]);
    }
  }
  const notes = await db
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.shopId, shopId), gte(creditNotes.issuedAt, IST(from)), lt(creditNotes.issuedAt, IST(to))))
    .orderBy(asc(creditNotes.issuedAt));
  for (const n of notes) {
    const s = n.snapshot as unknown as CreditNoteSnapshot;
    const b2b = s.buyer.gstin ? "B2B" : "B2C";
    for (const l of s.lines) {
      rows.push(["Return", "Credit note", n.creditNoteNumber, istDay(n.issuedAt), s.buyer.gstin, b2b, pos(s.placeOfSupply), l.hsn, l.description, l.qty != null ? -l.qty : null, l.uqc ?? null, -r2(l.taxablePaise), l.rateBp / 100, -r2(l.cgstPaise), -r2(l.sgstPaise), -r2(l.igstPaise), -r2(l.cessPaise ?? 0), -r2(l.grossPaise), null, "GoKesari"]);
    }
  }
  const sales = await db
    .select({ inv: accSalesInvoices, line: accSalesLines })
    .from(accSalesInvoices)
    .innerJoin(accSalesLines, eq(accSalesLines.salesId, accSalesInvoices.id))
    .where(and(eq(accSalesInvoices.shopId, shopId), eq(accSalesInvoices.status, "ISSUED"), gte(accSalesInvoices.invoiceDate, from), lt(accSalesInvoices.invoiceDate, to)))
    .orderBy(asc(accSalesInvoices.invoiceDate), asc(accSalesLines.lineNo));
  for (const { inv, line } of sales) {
    rows.push(["Sale", "Tax invoice", inv.invoiceNo, inv.invoiceDate, inv.buyerGstin, inv.buyerGstin ? "B2B" : "B2C", inv.placeOfSupply, line.hsn, line.description, line.qtyMilli / 1000, line.unit, r2(line.taxablePaise), line.gstRateBp / 100, r2(line.cgstPaise), r2(line.sgstPaise), r2(line.igstPaise), r2(line.cessPaise), r2(line.totalPaise), null, "Counter"]);
  }
  const docs = await db
    .select()
    .from(accDocuments)
    .where(and(eq(accDocuments.shopId, shopId), eq(accDocuments.status, "ISSUED"), inArray(accDocuments.kind, ["CREDIT_NOTE", "DEBIT_NOTE"]), gte(accDocuments.docDate, from), lt(accDocuments.docDate, to)));
  for (const d of docs) {
    const sign = d.kind === "CREDIT_NOTE" ? -1 : 1;
    for (const l of d.lines) {
      rows.push([d.kind === "CREDIT_NOTE" ? "Return" : "Sale", d.kind === "CREDIT_NOTE" ? "Credit note" : "Debit note", d.docNo, d.docDate, d.buyerGstin, d.buyerGstin ? "B2B" : "B2C", d.placeOfSupply, l.hsn ?? null, l.description, (sign * l.qtyMilli) / 1000, l.uqc ?? null, sign * r2(l.taxablePaise), l.gstRateBp / 100, sign * r2(l.cgstPaise), sign * r2(l.sgstPaise), sign * r2(l.igstPaise), sign * r2(l.cessPaise), sign * r2(l.totalPaise), null, "Counter"]);
    }
  }
  const total = (i: number) => rows.reduce((n, r) => n + Number(r[i] ?? 0), 0);
  return {
    title: "Marketplace tax report (B2B / B2C)",
    subtitle,
    header,
    rows,
    footer: [`Taxable ₹${total(11).toFixed(2)} · CGST ₹${total(13).toFixed(2)} · SGST ₹${total(14).toFixed(2)} · IGST ₹${total(15).toFixed(2)} · Cess ₹${total(16).toFixed(2)}`],
  };
}
