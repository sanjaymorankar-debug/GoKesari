/**
 * Local reading of a supplier bill's TEXT (docs/inventory-accounting-2026-10, Part 4):
 * a PDF's text layer or OCR output, when AI reading is off. Regular
 * expressions for the header (GSTIN, invoice number, date, totals) and a
 * "description … numbers" pattern for item rows. Deliberately modest
 * confidence: the review screen highlights everything for the owner to check.
 * Pure, so it is unit-tested on sample bills.
 */
import { isValidGstin } from "@/lib/gst-states";

export interface TextBillLine {
  description: string;
  hsn: string | null;
  qty: number | null;
  unit: string | null;
  rate: number | null;
  gstRatePercent: number | null;
  amount: number | null;
}

export interface TextBill {
  supplierName: string | null;
  supplierGstin: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  taxable: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  total: number | null;
  lines: TextBillLine[];
}

const GSTIN_RE = /\b\d{2}[A-Z0-9]{5}\d{4}[A-Z0-9][1-9A-Z][Z2][0-9A-Z]\b/g;
const NUM = String.raw`-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,3})?|-?\d+(?:\.\d{1,3})?`;

export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[₹,\s]|Rs\.?/gi, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** OCR reads O for 0 and I for 1 in the digit positions of a GSTIN. */
function repairGstin(raw: string): string {
  const s = raw.toUpperCase().split("");
  const digitAt = [0, 1, 7, 8, 9, 10];
  for (const i of digitAt) s[i] = s[i].replace("O", "0").replace("I", "1").replace("S", "5");
  for (const i of [2, 3, 4, 5, 6, 11]) s[i] = s[i].replace("0", "O").replace("1", "I").replace("5", "S");
  if (s[13] === "2") s[13] = "Z";
  return s.join("");
}

/** dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy, "05 Sep 2026", ISO → YYYY-MM-DD. */
export function parseBillDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const d = m[1].padStart(2, "0");
    const mo = m[2].padStart(2, "0");
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
    return `${y}-${mo}-${d}`;
  }
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = /^(\d{1,2})[\s\-/]*([A-Za-z]{3})[A-Za-z]*[\s\-/,]*(\d{2,4})$/.exec(s);
  if (m && months.includes(m[2].toLowerCase())) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${String(months.indexOf(m[2].toLowerCase()) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function lastNumberOnLine(line: string): number | null {
  const all = line.match(new RegExp(NUM, "g"));
  return all ? parseAmount(all[all.length - 1]) : null;
}

export function parseBillText(text: string, ownGstin?: string | null): TextBill {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const upper = text.toUpperCase();

  const gstins = [...new Set((upper.match(GSTIN_RE) ?? []).map(repairGstin))].filter(isValidGstin);
  const own = (ownGstin ?? "").toUpperCase();
  const supplierGstin = gstins.find((g) => g !== own) ?? null;

  // "Invoice No: X", "Bill No. X", "Inv # X", or "Invoice: X" — never the word after "TAX INVOICE".
  const flat = text.replace(/\n/g, " ");
  const invoiceMatch =
    /(?:invoice|inv|bill|voucher|memo)\s*(?:no\.?|number|num|#)\s*[:\-.]?\s*([A-Z0-9][A-Z0-9/\-]{0,19})/i.exec(flat) ??
    /(?:invoice|bill)\s*:\s*([A-Z0-9][A-Z0-9/\-]{0,19})/i.exec(flat);
  const invoiceNo = invoiceMatch && /\d/.test(invoiceMatch[1]) ? invoiceMatch[1] : null;
  const dateMatch = /(?:invoice\s*date|bill\s*date|date|dated|dt)\.?\s*[:\-]?\s*(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}[\s\-][A-Za-z]{3,9}[\s\-,]*\d{2,4})/i.exec(text) ?? /(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/.exec(text);
  const invoiceDate = parseBillDate(dateMatch?.[1]);

  const header = lines.slice(0, 6).find((l) => /[A-Za-z]{3}/.test(l) && !/tax invoice|invoice|bill of supply|gstin|original|duplicate|cash memo|estimate/i.test(l) && l.length <= 60) ?? null;

  const findTotal = (re: RegExp) => {
    for (const l of [...lines].reverse()) if (re.test(l)) return lastNumberOnLine(l);
    return null;
  };
  const total = findTotal(/grand\s*total|net\s*amount|total\s*amount|invoice\s*total|amount\s*payable|net\s*payable|bill\s*amount/i) ?? findTotal(/^total\b/i);
  const taxable = findTotal(/taxable\s*(value|amount|amt)|sub\s*total|assessable/i);
  const cgst = findTotal(/\bc\.?gst\b/i);
  const sgst = findTotal(/\bs\.?gst\b|\butgst\b/i);
  const igst = findTotal(/\bi\.?gst\b/i);

  const items: TextBillLine[] = [];
  const rowRe = new RegExp(String.raw`^(?:\d{1,3}[.)\s]+)?(.*?[A-Za-zऀ-ॿ].*?)\s+((?:(?:${NUM})%?\s*(?:[A-Za-z]{1,6}\s+)?){3,})$`);
  for (const l of lines) {
    if (/total|gstin|invoice|amount in words|rupees|bank|ifsc|signature|terms|tax\s*summary|cgst|sgst|igst|discount\s*total/i.test(l)) continue;
    const m = rowRe.exec(l);
    if (!m) continue;
    const description = m[1].replace(/\s+\d{4,8}$/, "").trim();
    if (description.length < 2) continue;
    const tail = m[2];
    const hsn = /\b(\d{4,8})\b/.exec(m[1])?.[1] ?? null;
    const unit = /\b(kg|kgs|g|gm|gms|ltr|l|ml|pcs|pc|nos|box|case|pkt|bag|dz|doz|btl)\b/i.exec(tail)?.[1] ?? null;
    const pct = /(\d{1,2}(?:\.\d)?)\s*%/.exec(tail);
    const nums = (tail.replace(/\d{1,2}(?:\.\d)?\s*%/, " ").match(new RegExp(NUM, "g")) ?? []).map((x) => parseAmount(x)).filter((x): x is number => x != null);
    if (nums.length < 2) continue;
    const amount = nums[nums.length - 1];
    const rate = nums[nums.length - 2];
    const qty = nums.length >= 3 ? nums[nums.length - 3] : amount && rate ? Math.round((amount / rate) * 1000) / 1000 : null;
    items.push({ description, hsn, qty, unit, rate, gstRatePercent: pct ? Number(pct[1]) : null, amount });
  }

  return { supplierName: header, supplierGstin, invoiceNo, invoiceDate, taxable, cgst, sgst, igst, total, lines: items };
}

/* ------------------------------------------------------------ spreadsheets */

export interface SheetBill {
  supplierName: string | null;
  supplierGstin: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  lines: TextBillLine[];
}

const COLS: [keyof TextBillLine | "taxable" | "total" | "skip", RegExp][] = [
  ["description", /^(item|items|description|product|particulars|name|item name|product name|goods)/i],
  ["hsn", /hsn|sac/i],
  ["qty", /^(qty|quantity|qnty|nos)/i],
  ["unit", /^(unit|uom|units)$/i],
  ["rate", /^(rate|price|unit price|mrp rate|rate\/unit)/i],
  ["gstRatePercent", /(gst|tax)\s*(%|rate)|^gst$/i],
  ["taxable", /taxable|assessable/i],
  ["amount", /^(amount|amt|value|total|line total|net amount)/i],
];

/**
 * A bill sent as a spreadsheet: finds the item table by its column titles
 * (first 30 rows), reads rows until a blank or "total" row, and picks the
 * supplier GSTIN, invoice number and date from cells above the table.
 */
export function parseBillSheet(rows: string[][], ownGstin?: string | null): SheetBill {
  let headerRow = -1;
  let map: Partial<Record<string, number>> = {};
  for (let r = 0; r < Math.min(rows.length, 30); r += 1) {
    const found: Partial<Record<string, number>> = {};
    rows[r].forEach((cell, c) => {
      const v = String(cell ?? "").trim();
      for (const [key, re] of COLS) if (re.test(v) && found[key] === undefined) {
        found[key] = c;
        break;
      }
    });
    if (found.description !== undefined && (found.qty !== undefined || found.amount !== undefined)) {
      headerRow = r;
      map = found;
      break;
    }
  }
  const above = rows.slice(0, headerRow < 0 ? 15 : headerRow).map((r) => r.join(" ")).join("\n");
  const head = parseBillText(above, ownGstin);
  const lines: TextBillLine[] = [];
  if (headerRow >= 0) {
    for (const row of rows.slice(headerRow + 1)) {
      const get = (k: string) => (map[k] !== undefined ? String(row[map[k]!] ?? "").trim() : "");
      const description = get("description");
      if (!description) {
        if (row.every((c) => !String(c ?? "").trim())) break;
        continue;
      }
      if (/^(sub\s*)?total|grand total/i.test(description)) break;
      const taxable = parseAmount(get("taxable"));
      lines.push({
        description,
        hsn: get("hsn") || null,
        qty: parseAmount(get("qty")),
        unit: get("unit") || null,
        rate: parseAmount(get("rate")),
        gstRatePercent: parseAmount(get("gstRatePercent").replace("%", "")),
        amount: taxable ?? parseAmount(get("amount")),
      });
    }
  }
  return { supplierName: head.supplierName, supplierGstin: head.supplierGstin, invoiceNo: head.invoiceNo, invoiceDate: head.invoiceDate, lines };
}
