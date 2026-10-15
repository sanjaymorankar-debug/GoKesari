/**
 * Finds a sheet's heading rows by what they contain, never by fixed row
 * numbers, and describes every column (docs/product-import-2026-10).
 *
 * Amazon Seller Central inventory templates (any product type — PUZZLES,
 * TOYS, GROCERY…) have, above the data:
 *   - a settings row (`settings=…`), ignored;
 *   - section headers ("Listing Identity", "Offer"…) — each applies to every
 *     column to its right until the next one;
 *   - a row of human labels (SKU, Item Name, Quantity (IN)…);
 *   - a row of attribute keys (contribution_sku#1.value,
 *     item_name[marketplace_id=…][language_tag=en_IN]#1.value…);
 *   - Amazon's example row (ABC123) and a notice row — skipped by the parser.
 * The GoKesari simple template and plain CSVs have one heading row.
 *
 * A column is identified by its attribute key when it has one (canonical:
 * marketplace and language qualifiers stripped, `#n` occurrence numbers
 * removed and kept as `occurrence`, the audience qualifier kept so the ALL and
 * B2B offers stay apart), otherwise by its label.
 */
import type { CellValue, GridRow } from "./grid";
import { HEADER_SCAN_ROWS } from "./grid";

export interface ColumnDef {
  /** 0-based column index. */
  index: number;
  label: string;
  /** The attribute key as written, or null for a label-only column. */
  key: string | null;
  /** Section header in force for the column, if the template has them. */
  group: string | null;
  /** Lower-case identity used by the field rules: `item_name.value`, `purchasable_offer[audience=all].our_price.schedule.value_with_tax`, or `label:quantity`. */
  canonical: string;
  /** The first `#n` of the key (bullet_point#3 → 3); null without one. */
  occurrence: number | null;
  /** Unique within the sheet: the key, else the label (a repeated label gets " #2"…). Used in raw_json and the report. */
  id: string;
}

export interface HeaderLayout {
  columns: ColumnDef[];
  /** Index (into the grid's rows) of the first row after the headings. */
  dataStart: number;
  labelRow: number;
  keyRow: number | null;
  groupRow: number | null;
  /** Amazon-style template (labels + attribute keys), as opposed to a one-heading sheet. */
  hasAttributeKeys: boolean;
}

/** Labels that mark a heading row. */
const KNOWN_LABELS = new Set(
  [
    "sku", "seller sku", "item sku", "product type", "listing action", "action", "item name", "product name", "title", "name",
    "brand", "brand name", "manufacturer", "barcode", "barcode type", "product id", "product id type", "quantity",
    "quantity (in)", "qty", "stock", "mrp", "price", "selling price", "your price inr (sell on amazon, in)",
    "maximum retail price (sell on amazon, in)", "category", "hsn code", "main image url", "description",
    "product description", "item condition", "unit",
  ].map((s) => s.toLowerCase()),
);

/** An Amazon attribute key: snake_case, optional [qualifier=…] blocks, #n and dotted sub-fields; or ::record_action. */
const ATTRIBUTE_KEY = /^(?:::)?[a-z][a-z0-9_]*(?:\[[^\]]+\])*(?:#\d+)?(?:\.[a-z0-9_]+(?:\[[^\]]+\])*(?:#\d+)?)*$/;

const cellText = (c: CellValue): string => (c == null ? "" : String(c).trim());

export function normaliseLabel(label: string): string {
  return label.replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Strips marketplace/language qualifiers and occurrence numbers; keeps audience. */
export function canonicalKey(key: string): { canonical: string; occurrence: number | null } {
  let occurrence: number | null = null;
  const withoutQualifiers = key
    .trim()
    .replace(/\[(?:marketplace_id|language_tag)=[^\]]*\]/gi, "")
    .replace(/\[audience=([^\]]*)\]/gi, (_, a: string) => `[audience=${a.toLowerCase()}]`);
  const canonical = withoutQualifiers.replace(/#(\d+)/g, (_, n: string) => {
    if (occurrence == null) occurrence = Number(n);
    return "";
  });
  return { canonical: canonical.toLowerCase(), occurrence };
}

function labelScore(row: GridRow): number {
  let score = 0;
  for (const c of row.cells) {
    const t = normaliseLabel(cellText(c));
    if (t && KNOWN_LABELS.has(t)) score += 1;
  }
  return score;
}

function keyShare(row: GridRow | undefined): number {
  if (!row) return 0;
  const texts = row.cells.map(cellText).filter(Boolean);
  if (texts.length === 0) return 0;
  const keys = texts.filter((t) => ATTRIBUTE_KEY.test(t) && (t.includes("#") || t.includes(".") || t.startsWith("::") || t.includes("_")));
  return keys.length / texts.length;
}

/**
 * Locates the heading rows. Returns null when no row in the first 15 looks
 * like a heading (the file is then read with its first non-empty row as the
 * heading, and the caller warns).
 */
export function detectHeader(rows: GridRow[]): HeaderLayout | null {
  const scan = rows.slice(0, HEADER_SCAN_ROWS);
  let labelIdx = -1;
  for (let i = 0; i < scan.length; i += 1) {
    const score = labelScore(scan[i]);
    // The first row that clearly is a heading wins (two known labels, or SKU / a name heading on its own).
    if (score >= 2 || (score === 1 && scan[i].cells.some((c) => /^(sku|item name|product name)$/i.test(cellText(c))))) {
      labelIdx = i;
      break;
    }
  }
  if (labelIdx < 0) {
    // A key row with no label row above it still identifies the columns.
    const keyOnly = scan.findIndex((r) => keyShare(r) >= 0.6 && r.cells.filter((c) => cellText(c)).length >= 3);
    if (keyOnly < 0) return null;
    labelIdx = keyOnly;
  }

  let keyIdx: number | null = null;
  if (keyShare(rows[labelIdx + 1]) >= 0.6) keyIdx = labelIdx + 1;
  else if (keyShare(rows[labelIdx]) >= 0.6) keyIdx = labelIdx; // the "label" row is itself the keys

  let groupIdx: number | null = null;
  if (keyIdx != null && labelIdx > 0) {
    const above = rows[labelIdx - 1];
    const filled = above?.cells.filter((c) => cellText(c)).length ?? 0;
    const labels = rows[labelIdx].cells.filter((c) => cellText(c)).length;
    // Section headers are sparse (one per section) and are not the settings row.
    if (above && filled > 0 && filled < labels && !above.cells.some((c) => /^settings=/i.test(cellText(c)))) {
      groupIdx = labelIdx - 1;
    }
  }

  const labelRow = rows[labelIdx];
  const keyRow = keyIdx != null ? rows[keyIdx] : null;
  const groupRow = groupIdx != null ? rows[groupIdx] : null;
  const width = Math.max(labelRow.cells.length, keyRow?.cells.length ?? 0, groupRow?.cells.length ?? 0);

  const columns: ColumnDef[] = [];
  const used = new Map<string, number>();
  let group: string | null = null;
  for (let index = 0; index < width; index += 1) {
    const groupText = groupRow ? cellText(groupRow.cells[index] ?? null) : "";
    if (groupText) group = groupText;
    const rawKey = keyRow ? cellText(keyRow.cells[index] ?? null) : "";
    const key = rawKey && ATTRIBUTE_KEY.test(rawKey) ? rawKey : null;
    const label = keyIdx === labelIdx ? rawKey : cellText(labelRow.cells[index] ?? null);
    if (!label && !key) continue;
    const { canonical, occurrence } = key ? canonicalKey(key) : { canonical: `label:${normaliseLabel(label)}`, occurrence: null };
    const baseId = key ?? label;
    const seen = (used.get(baseId) ?? 0) + 1;
    used.set(baseId, seen);
    columns.push({
      index,
      label: label || key || `Column ${index + 1}`,
      key,
      group,
      canonical,
      occurrence,
      id: seen > 1 ? `${baseId} #${seen}` : baseId,
    });
  }

  const dataStart = Math.max(labelIdx, keyIdx ?? labelIdx) + 1;
  return { columns, dataStart, labelRow: labelIdx, keyRow: keyIdx, groupRow: groupIdx, hasAttributeKeys: keyIdx != null };
}

/** A heading-less sheet: its first non-empty row names the columns. */
export function firstRowHeader(rows: GridRow[]): HeaderLayout | null {
  const idx = rows.findIndex((r) => r.cells.some((c) => cellText(c)));
  if (idx < 0) return null;
  const used = new Map<string, number>();
  const columns: ColumnDef[] = [];
  rows[idx].cells.forEach((c, index) => {
    const label = cellText(c);
    if (!label) return;
    const seen = (used.get(label) ?? 0) + 1;
    used.set(label, seen);
    columns.push({
      index,
      label,
      key: null,
      group: null,
      canonical: `label:${normaliseLabel(label)}`,
      occurrence: null,
      id: seen > 1 ? `${label} #${seen}` : label,
    });
  });
  return { columns, dataStart: idx + 1, labelRow: idx, keyRow: null, groupRow: null, hasAttributeKeys: false };
}
