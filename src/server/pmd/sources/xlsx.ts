/**
 * Streaming .xlsx reader for supplier catalogues.
 *
 * Manufacturers send Excel, not CSV. The file is streamed (never loaded whole), one worksheet
 * is chosen (by name, by position, or the first visible one), a header row is located, and every
 * data row becomes {header -> text}, the same shape the CSV reader yields, so one mapping
 * describes both. Legacy .xls is not supported: ask the supplier to save as .xlsx or .csv.
 */
import fs, { type ReadStream } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";

import ExcelJS from "exceljs";
import unzipper from "unzipper";

export interface XlsxOptions {
  /** Sheet name (case-insensitive) or 1-based position. Default: the first visible sheet. */
  sheet?: string | number;
  /** 1-based row holding the column headings. Default 1. */
  headerRow?: number;
}

export interface TabularRow {
  row: Record<string, string>;
  /** The row's number in the sheet (header rows count), for error messages. */
  rowNumber: number;
}

export class XlsxReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxReadError";
  }
}

/** Turns any cell value into the plain text the mapping layer works with. Blank -> "". */
export function cellText(v: ExcelJS.CellValue | undefined): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  const o = v as unknown as Record<string, unknown>;
  if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text ?? "").join("").trim();
  if ("error" in o) return "";
  if ("formula" in o || "sharedFormula" in o) return cellText(o.result as ExcelJS.CellValue);
  if ("hyperlink" in o) return cellText((o.text as ExcelJS.CellValue) || (o.hyperlink as string));
  return "";
}

interface SheetInfo {
  name: string;
  state: string;
  position: number;
}

function isWanted(sheet: SheetInfo, opts: XlsxOptions): boolean {
  if (typeof opts.sheet === "number") return sheet.position === opts.sheet;
  if (typeof opts.sheet === "string") return sheet.name.toLowerCase() === opts.sheet.toLowerCase();
  return sheet.state === "visible";
}

/** Turns one sheet's rows (in order) into {heading -> text}, applying the header-row rules. */
class RowShaper {
  private headers: string[] | null = null;
  constructor(private readonly sheetName: string, private readonly headerRow: number) {}

  /** null = not a data row (before/at the headings, or fully blank). */
  shape(number: number, cells: ExcelJS.CellValue[]): TabularRow | null {
    if (number < this.headerRow) return null;
    if (!this.headers) {
      // 1-based cell array: index i is column i. Duplicate headings get a "#2" suffix so none is lost.
      const headers: string[] = [];
      const used = new Map<string, number>();
      for (let c = 1; c < cells.length; c++) {
        const h = cellText(cells[c]);
        const n = (used.get(h) ?? 0) + 1;
        used.set(h, n);
        headers[c] = h ? (n > 1 ? `${h}#${n}` : h) : "";
      }
      if (!headers.some(Boolean)) throw new XlsxReadError(`Row ${this.headerRow} of sheet "${this.sheetName}" has no column headings.`);
      this.headers = headers;
      return null;
    }
    const out: Record<string, string> = {};
    let any = false;
    for (let c = 1; c < this.headers.length; c++) {
      if (!this.headers[c]) continue;
      const t = cellText(cells[c]);
      out[this.headers[c]] = t;
      if (t) any = true;
    }
    return any ? { row: out, rowNumber: number } : null; // fully blank rows are padding, not records
  }

  finish(): void {
    if (!this.headers) throw new XlsxReadError(`Sheet "${this.sheetName}" has no row ${this.headerRow} to use as headings.`);
  }
}

const notFound = (opts: XlsxOptions, seen: string[]) =>
  new XlsxReadError(
    `Could not find ${opts.sheet == null ? "a visible sheet" : `sheet ${JSON.stringify(opts.sheet)}`}. Sheets in the file: ${seen.join(", ") || "(none)"}.`,
  );
const label = (s: SheetInfo) => `${s.name}${s.state === "visible" ? "" : ` (${s.state})`}`;

/** The part parsers inside ExcelJS's WorkbookReader (exceljs 4.4), which viaStream feeds one part at a time. */
interface WorkbookPartParsers {
  workbookRels?: { Id: string; Target: string }[];
  model?: { sheets?: { name: string; state?: string; rId: string }[] };
  _parseRels(part: Readable): Promise<void>;
  _parseWorkbook(part: Readable): Promise<void>;
  _parseSharedStrings(part: Readable): AsyncIterable<unknown>;
  _parseStyles(part: Readable): Promise<void>;
  _parseWorksheet(part: Readable, sheetNo: string): Iterable<{ value: ExcelJS.stream.xlsx.WorksheetReader }>;
}

/**
 * Streams the file: memory stays flat however large the catalogue is.
 *
 * ExcelJS's WorkbookReader is not left to walk the zip itself. It reads it front to back with unzipper's
 * Parse, which emits "end" as soon as it has parsed the last byte, while entries may still be queued behind
 * a part ExcelJS is busy with; ExcelJS stops there and silently drops them. Which parts went missing
 * depended on timing: ExcelJS writes workbook.xml last (a TypeError, so the read fell back to memory), and
 * Excel writes the sheets before the styles and shared strings ("no column headings", "could not find
 * sheet"). Instead the zip is opened by its central directory, and ExcelJS's own part parsers get the parts
 * in the order they depend on each other: workbook, shared strings, styles, then only the wanted sheet,
 * streamed straight out of the zip. No temp copies are made, and skipped sheets are never opened.
 */
async function* viaStream(path: string, opts: XlsxOptions, started: { rows: number }): AsyncGenerator<TabularRow> {
  const headerRow = opts.headerRow ?? 1;
  const opened: ReadStream[] = [];
  try {
    const zip = await unzipper.Open.custom({
      stream: (offset: number, length?: number) => {
        const s = fs.createReadStream(path, { start: offset, end: length ? offset + length - 1 : undefined });
        opened.push(s);
        return s;
      },
      size: async () => (await fs.promises.stat(path)).size,
    });
    const files = new Map(zip.files.map((f) => [f.path, f]));
    const part = (name: string): Readable | undefined => files.get(name)?.stream();
    const book = new ExcelJS.stream.xlsx.WorkbookReader(path, {
      worksheets: "emit", sharedStrings: "cache", hyperlinks: "cache", styles: "cache", entries: "ignore",
    }) as unknown as WorkbookPartParsers;
    const rels = part("xl/_rels/workbook.xml.rels");
    if (rels) await book._parseRels(rels);
    const workbook = part("xl/workbook.xml");
    if (workbook) await book._parseWorkbook(workbook);
    const strings = part("xl/sharedStrings.xml");
    if (strings) for await (const s of book._parseSharedStrings(strings)) void s; // "cache": fills the reader's table
    const styles = part("xl/styles.xml");
    if (styles) await book._parseStyles(styles);

    const seen: string[] = [];
    let position = 0;
    for (const sheet of book.model?.sheets ?? []) {
      position++;
      const info: SheetInfo = { name: sheet.name, state: sheet.state ?? "visible", position };
      seen.push(label(info));
      if (!isWanted(info, opts)) continue;
      const target = book.workbookRels?.find((r) => r.Id === sheet.rId)?.Target ?? "";
      const data = part(target.startsWith("/") ? target.slice(1) : posix.join("xl", target));
      if (!data) throw new XlsxReadError(`Sheet "${info.name}" is listed in the workbook, but its rows are missing from the file.`);
      const [{ value: ws }] = book._parseWorksheet(data, String(position));
      const shaper = new RowShaper(info.name, headerRow);
      for await (const row of ws) {
        const r = shaper.shape(row.number, (row.values as ExcelJS.CellValue[]) ?? []);
        if (r) {
          started.rows++;
          yield r;
        }
      }
      shaper.finish();
      return; // one sheet per feed
    }
    throw notFound(opts, seen);
  } finally {
    // A part left half read (a bad heading row, or the caller stopping early) still holds its file stream.
    await Promise.all(
      opened.map((s) => new Promise<void>((resolve) => {
        if (s.closed) return resolve();
        s.once("close", () => resolve());
        s.destroy();
      })),
    );
  }
}

/** Loads the whole workbook. Only used when the streaming reader cannot cope with the file's layout. */
async function* viaMemory(path: string, opts: XlsxOptions): AsyncGenerator<TabularRow> {
  const headerRow = opts.headerRow ?? 1;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const seen: string[] = [];
  let position = 0;
  for (const ws of wb.worksheets) {
    position++;
    const info: SheetInfo = { name: ws.name, state: ws.state ?? "visible", position };
    seen.push(label(info));
    if (!isWanted(info, opts)) continue;
    const shaper = new RowShaper(info.name, headerRow);
    for (let n = 1; n <= ws.rowCount; n++) {
      const row = ws.getRow(n);
      const r = shaper.shape(n, (row.values as ExcelJS.CellValue[]) ?? []);
      if (r) yield r;
    }
    shaper.finish();
    return;
  }
  throw notFound(opts, seen);
}

/**
 * Yields the data rows of the chosen sheet. Streams by default; if the streaming read fails inside ExcelJS
 * before producing a row (a TypeError: a part it cannot parse, or an ExcelJS release that renamed the part
 * parsers viaStream calls), the workbook is read in memory instead - slower and heavier, but the catalogue
 * still loads.
 */
export async function* parseXlsxWithHeader(
  path: string,
  opts: XlsxOptions = {},
  /** "auto" (default): stream, falling back to memory. "stream" / "memory" force one path (diagnostics and tests). */
  mode: "auto" | "stream" | "memory" = "auto",
): AsyncGenerator<TabularRow> {
  if (mode === "memory") return yield* viaMemory(path, opts);
  if (mode === "stream") return yield* viaStream(path, opts, { rows: 0 });
  const started = { rows: 0 };
  try {
    yield* viaStream(path, opts, started);
  } catch (e) {
    if (e instanceof XlsxReadError || started.rows > 0 || !(e instanceof TypeError)) throw e;
    yield* viaMemory(path, opts);
  }
}
