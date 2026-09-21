/**
 * Streaming .xlsx reader for supplier catalogues.
 *
 * Manufacturers send Excel, not CSV. The file is streamed (never loaded whole), one worksheet
 * is chosen (by name, by position, or the first visible one), a header row is located, and every
 * data row becomes {header -> text}, the same shape the CSV reader yields, so one mapping
 * describes both. Legacy .xls is not supported: ask the supplier to save as .xlsx or .csv.
 */
import ExcelJS from "exceljs";

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

/** Streams the file: memory stays flat however large the catalogue is. */
async function* viaStream(path: string, opts: XlsxOptions, started: { rows: number }): AsyncGenerator<TabularRow> {
  const headerRow = opts.headerRow ?? 1;
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    worksheets: "emit", sharedStrings: "cache", hyperlinks: "cache", styles: "cache", entries: "ignore",
  });
  const seen: string[] = [];
  let position = 0;
  for await (const ws of reader) {
    position++;
    const info: SheetInfo = {
      name: String((ws as unknown as { name?: string }).name ?? `Sheet${position}`),
      state: (ws as unknown as { state?: string }).state ?? "visible",
      position,
    };
    seen.push(label(info));
    if (!isWanted(info, opts)) continue;
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
 * Yields the data rows of the chosen sheet. Streams by default; if ExcelJS's streaming reader fails on
 * the file's internal layout before producing a row (it assumes the workbook part precedes the sheets),
 * the workbook is read in memory instead - slower and heavier, but the catalogue still loads.
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
