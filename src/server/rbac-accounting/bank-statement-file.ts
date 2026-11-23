/**
 * RBAC v2 Phase 3 — reading a bank statement file (CSV or Excel) into lines. Pure: no database.
 *
 * Banks export different layouts, so the header row is found (it may sit under a few rows of account details)
 * and its columns are recognised by name:
 *   date         Date, Txn Date, Transaction Date, Tran Date, Posting Date
 *   value date   Value Date, Value Dt
 *   description  Description, Narration, Particulars, Transaction Remarks, Remarks, Details
 *   reference    Reference, Ref No, Chq./Ref.No., Ref No./Cheque No., UTR, Transaction ID
 *   amounts      Debit / Withdrawal (Amt.) and Credit / Deposit (Amt.), or one Amount column with Dr/Cr
 *   balance      Balance, Closing Balance, Running Balance
 * Dates: DD/MM/YYYY, DD-MM-YYYY, DD/MM/YY, DD-Mon-YYYY, DD Mon YYYY, YYYY-MM-DD (Excel date cells too).
 * A statement listed newest first is put in date order. A row with a problem refuses the whole file (a bank
 * statement with missing lines cannot be reconciled); the problems are returned with their row numbers.
 */
import ExcelJS from "exceljs";

import { parseCsv } from "@/server/rbac-support/bulk";

export interface ParsedBankLine {
  lineNo: number;
  /** Row number in the file (1-based, header counted), for messages. */
  row: number;
  txnDate: string;
  valueDate: string | null;
  description: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
}

export interface BankFileProblem {
  row: number;
  message: string;
}

export interface ParsedBankFile {
  lines: ParsedBankLine[];
  errors: BankFileProblem[];
  warnings: string[];
  periodFrom: string | null;
  periodTo: string | null;
  openingBalancePaise: number | null;
  closingBalancePaise: number | null;
  totalDebitPaise: number;
  totalCreditPaise: number;
}

export const MAX_STATEMENT_LINES = 50_000;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIASES = {
  date: ["date", "txndate", "transactiondate", "trandate", "postingdate", "postdate", "txndt", "trndate", "bookingdate"],
  valueDate: ["valuedate", "valuedt", "valdate"],
  description: ["description", "narration", "particulars", "transactionremarks", "remarks", "details", "transactiondetails", "transactiondescription"],
  reference: ["reference", "refno", "chqrefno", "chequerefno", "refnochequeno", "chqno", "chequeno", "utr", "utrno", "utrnumber", "referenceno", "referencenumber", "transactionid", "transactionreference"],
  debit: ["debit", "withdrawal", "withdrawals", "withdrawalamt", "withdrawalamount", "withdrawalamountinr", "debitamount", "debitamountinr", "dr", "debitinr"],
  credit: ["credit", "deposit", "deposits", "depositamt", "depositamount", "depositamountinr", "creditamount", "creditamountinr", "cr", "creditinr"],
  amount: ["amount", "transactionamount", "amountinr", "txnamount"],
  drcr: ["drcr", "crdr", "type", "debitcredit", "transactiontype", "drcrindicator"],
  balance: ["balance", "closingbalance", "balanceinr", "runningbalance", "availablebalance", "bal"],
} as const;
type Column = keyof typeof ALIASES;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function isoOf(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/** A statement date as YYYY-MM-DD, or null. Day comes first (Indian banks). */
export function parseStatementDate(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(t);
  if (m) return isoOf(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?: .*)?$/.exec(t);
  if (m) return isoOf(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[ /-]([A-Za-z]{3,4})[A-Za-z]*[ /,-]+(\d{2}|\d{4})(?: .*)?$/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return isoOf(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

/**
 * A rupee amount in paise. Accepts "1,23,456.78", "₹ 120", "INR 50.5", "(120.00)" and "120.00 Dr" (both negative)
 * or "120.00 Cr". Empty → null. Throws on anything else.
 */
export function parseStatementAmount(raw: string): number | null {
  let t = raw.trim().replace(/[₹,\s]/g, "").replace(/^INR/i, "").replace(/INR$/i, "");
  if (t === "" || t === "-" || t === "--") return null;
  let sign = 1;
  if (/dr\.?$/i.test(t)) {
    sign = -1;
    t = t.replace(/dr\.?$/i, "");
  } else if (/cr\.?$/i.test(t)) t = t.replace(/cr\.?$/i, "");
  if (/^\(.*\)$/.test(t)) {
    sign = -sign;
    t = t.slice(1, -1);
  }
  if (t.startsWith("-")) {
    sign = -sign;
    t = t.slice(1);
  } else if (t.startsWith("+")) t = t.slice(1);
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error(`"${raw.trim()}" is not an amount.`);
  return sign * Math.round(Number(t) * 100);
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return cellText(o.result);
    if ("text" in o) return String(o.text);
    if ("richText" in o && Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join("");
  }
  return String(v);
}

export async function readStatementSheet(file: Buffer, filename: string): Promise<string[][]> {
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (r) => {
      rows.push((r.values as unknown[]).slice(1).map(cellText));
    });
    return rows;
  }
  return parseCsv(file.toString("utf8").replace(/^﻿/, ""));
}

function findHeader(sheet: string[][]): { index: number; cols: Partial<Record<Column, number>> } | null {
  for (let i = 0; i < Math.min(sheet.length, 40); i += 1) {
    const cells = sheet[i].map((c) => norm(c ?? ""));
    const cols: Partial<Record<Column, number>> = {};
    for (const key of Object.keys(ALIASES) as Column[]) {
      const at = cells.findIndex((c) => (ALIASES[key] as readonly string[]).includes(c));
      if (at >= 0) cols[key] = at;
    }
    // "Value Date" alone must not be taken for the transaction date.
    if (cols.date === undefined && cols.valueDate !== undefined && cols.debit !== undefined) {
      cols.date = cols.valueDate;
      delete cols.valueDate;
    }
    if (cols.date !== undefined && ((cols.debit !== undefined && cols.credit !== undefined) || cols.amount !== undefined)) return { index: i, cols };
  }
  return null;
}

/** Reads the whole file; never throws for a bad row (see `errors`). Throws only when the file has no statement. */
export async function parseBankStatementFile(file: Buffer, filename: string): Promise<ParsedBankFile> {
  const sheet = await readStatementSheet(file, filename);
  const header = findHeader(sheet);
  if (!header) {
    throw new Error("No header row found. The file needs a date column and either Debit and Credit (Withdrawal / Deposit) columns or an Amount column.");
  }
  const { cols } = header;
  const get = (r: string[], c: Column) => (cols[c] === undefined ? "" : (r[cols[c]!] ?? "").trim());

  const errors: BankFileProblem[] = [];
  const warnings: string[] = [];
  let parsed: ParsedBankLine[] = [];
  let openingFromRow: number | null = null;

  for (let i = header.index + 1; i < sheet.length; i += 1) {
    const r = sheet[i] ?? [];
    const rowNo = i + 1;
    if (r.every((c) => (c ?? "").trim() === "")) continue;
    const rawDate = get(r, "date");
    const description = get(r, "description");
    try {
      let debit = 0;
      let credit = 0;
      if (cols.debit !== undefined && cols.credit !== undefined) {
        const d = parseStatementAmount(get(r, "debit"));
        const c = parseStatementAmount(get(r, "credit"));
        debit = Math.abs(d ?? 0);
        credit = Math.abs(c ?? 0);
      } else {
        const a = parseStatementAmount(get(r, "amount"));
        const flag = get(r, "drcr").toLowerCase();
        if (a != null && a !== 0) {
          if (flag.startsWith("d") || (!flag && a < 0)) debit = Math.abs(a);
          else if (flag.startsWith("c") || (!flag && a > 0)) credit = Math.abs(a);
          else throw new Error(`Debit or credit? The type column says "${get(r, "drcr")}".`);
        }
      }
      const balance = parseStatementAmount(get(r, "balance"));
      const txnDate = parseStatementDate(rawDate);
      if (!txnDate) {
        // Opening-balance and total rows carry no transaction date: take the opening balance, skip the rest.
        if (debit === 0 && credit === 0) {
          if (/opening/i.test(r.join(" ")) && balance != null) openingFromRow = balance;
          continue;
        }
        if (/total/i.test(r.join(" ")) && !rawDate) continue;
        throw new Error(rawDate ? `"${rawDate}" is not a date (use DD/MM/YYYY).` : "The date is missing.");
      }
      if (debit === 0 && credit === 0) throw new Error("No debit or credit amount.");
      if (debit > 0 && credit > 0) throw new Error("Both a debit and a credit on one row.");
      const rawValue = get(r, "valueDate");
      const valueDate = rawValue ? parseStatementDate(rawValue) : null;
      if (rawValue && !valueDate) throw new Error(`Value date "${rawValue}" is not a date.`);
      const reference = get(r, "reference").replace(/^'+/, "");
      parsed.push({
        lineNo: 0,
        row: rowNo,
        txnDate,
        valueDate,
        description: description.slice(0, 500),
        reference: reference && !/^0+$/.test(reference) ? reference.slice(0, 100) : null,
        debitPaise: debit,
        creditPaise: credit,
        balancePaise: balance,
      });
    } catch (e) {
      errors.push({ row: rowNo, message: e instanceof Error ? e.message : String(e) });
    }
    if (parsed.length + errors.length > MAX_STATEMENT_LINES) {
      errors.push({ row: rowNo, message: `More than ${MAX_STATEMENT_LINES.toLocaleString("en-IN")} lines: split the statement by month.` });
      break;
    }
  }

  if (parsed.length >= 2 && parsed[0].txnDate > parsed[parsed.length - 1].txnDate) {
    parsed = parsed.reverse();
    warnings.push("The statement was listed newest first; its lines were put in date order.");
  }
  parsed.forEach((l, i) => {
    l.lineNo = i + 1;
  });

  // Running balance: each balance should follow from the one before.
  let balanceGaps = 0;
  for (let i = 1; i < parsed.length; i += 1) {
    const prev = parsed[i - 1].balancePaise;
    const cur = parsed[i].balancePaise;
    if (prev == null || cur == null) continue;
    if (prev + parsed[i].creditPaise - parsed[i].debitPaise !== cur) {
      balanceGaps += 1;
      if (balanceGaps <= 20) warnings.push(`Row ${parsed[i].row}: the balance does not follow from the row before. Check that no line is missing.`);
    }
  }
  if (balanceGaps > 20) warnings.push(`… and ${balanceGaps - 20} more rows whose balance does not follow.`);

  const first = parsed[0];
  const last = parsed[parsed.length - 1];
  const opening =
    openingFromRow ?? (first && first.balancePaise != null ? first.balancePaise - first.creditPaise + first.debitPaise : null);
  return {
    lines: parsed,
    errors,
    warnings,
    periodFrom: first?.txnDate ?? null,
    periodTo: last?.txnDate ?? null,
    openingBalancePaise: opening,
    closingBalancePaise: last?.balancePaise ?? null,
    totalDebitPaise: parsed.reduce((s, l) => s + l.debitPaise, 0),
    totalCreditPaise: parsed.reduce((s, l) => s + l.creditPaise, 0),
  };
}

/** Possible bank references in a line: the reference cell and long tokens in the narration that carry a digit. */
export function referenceTokens(reference: string | null, description: string): string[] {
  const out = new Set<string>();
  const ref = (reference ?? "").trim().toUpperCase();
  if (ref.length >= 6) out.add(ref);
  for (const t of `${ref} ${description}`.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (t.length >= 8 && t.length <= 35 && /\d/.test(t)) out.add(t);
  }
  return [...out];
}
