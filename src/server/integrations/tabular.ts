/**
 * Reading and writing the spreadsheets file adapters exchange with the shop
 * (Module 2): Excel (.xlsx) or CSV in, Excel or CSV out. Files are small
 * (an item list, a month of invoices), so they are handled in memory.
 */
import ExcelJS from "exceljs";

import { AppError, validationFailed } from "@/lib/errors";
import { parseDelimited } from "@/server/pmd/sources/delimited";
import { cellText } from "@/server/pmd/sources/xlsx";

export type SheetType = "CSV" | "XLSX";

export function sheetTypeOf(name: string, bytes: Buffer): SheetType {
  // .xlsx is a ZIP ("PK\x03\x04"); the old binary .xls is refused.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "XLSX";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw validationFailed("This is an old Excel file (.xls). Save it as .xlsx or CSV and upload it again.");
  }
  if (/\.xlsx$/i.test(name)) throw validationFailed("The file is not a valid Excel file.");
  return "CSV";
}

/** All rows (first row = headings), trimmed, blank rows dropped. */
export async function readSheet(bytes: Buffer, type: SheetType, maxRows: number): Promise<string[][]> {
  const rows: string[][] = [];
  if (type === "CSV") {
    let text = bytes;
    if (text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf) text = text.subarray(3); // BOM
    const sample = text.subarray(0, 4096).toString("utf8");
    const firstLine = sample.split(/\r?\n/)[0] ?? "";
    const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
    try {
      async function* once() {
        yield text;
      }
      for await (const cells of parseDelimited(once(), { delimiter, maxFieldLength: 10_000 })) {
        const row = cells.map((c) => c.trim());
        if (row.every((c) => c === "")) continue;
        rows.push(row);
        if (rows.length > maxRows + 1) throw validationFailed(`The file can have at most ${maxRows} rows.`);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw validationFailed("The CSV file could not be read. Save it as CSV (comma separated) and upload it again.");
    }
    return rows;
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw validationFailed("The Excel file could not be read. Open it in Excel, save it again as .xlsx and upload it.");
  }
  const sheet = workbook.worksheets.find((s) => s.state !== "hidden" && s.actualRowCount > 0) ?? workbook.worksheets[0];
  if (!sheet) return rows;
  let width = 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length > maxRows + 1) return;
    const values: string[] = [];
    const count = Math.max(row.cellCount, width);
    for (let c = 1; c <= count; c++) values.push(cellText(row.getCell(c).value));
    if (values.every((v) => v === "")) return;
    if (rows.length === 0) width = values.length;
    rows.push(values);
  });
  if (rows.length > maxRows + 1) throw validationFailed(`The file can have at most ${maxRows} rows.`);
  return rows;
}

/** A cell as text a spreadsheet will not run as a formula. */
export function safeCell(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  return /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
}

export function toCsv(header: string[], rows: (string | number | null)[][]): Buffer {
  const esc = (v: string | number | null) => {
    const s = typeof v === "number" ? String(v) : safeCell(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  // BOM so Excel opens ₹ and Indian-language names correctly.
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body + "\r\n", "utf8")]);
}

export async function toXlsx(sheetName: string, header: string[], rows: (string | number | null)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "GoKesari";
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.addRow(header).font = { bold: true };
  for (const r of rows) sheet.addRow(r.map((v) => (typeof v === "number" ? v : safeCell(v))));
  sheet.columns.forEach((col, i) => {
    col.width = Math.min(40, Math.max(10, header[i]?.length ?? 10));
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
