/**
 * File layouts of the accounting tools (billing v2, docs/billing §8): one
 * table per tool naming, in the tool's own words, the columns of three sheets
 * — parties / ledgers, stock items, and voucher lines — over the same logical
 * fields of the canonical model (model.ts). One exporter and one importer
 * serve every tool; a tool is only its headings, date format and file type.
 *
 * The headings follow each tool's published import templates as of Nov 2026
 * (TallyPrime "Import from Excel", Busy "Import Masters / Vouchers from
 * Excel", Marg (Busy-compatible), Vyapar and myBillBook Excel imports, Zoho
 * Books CSV import, Odoo CSV import). The tools change their templates between
 * versions: the help page for each tool says to check the column mapping on
 * the shop's own version (docs/billing/connectors), and the importer accepts
 * any of the known spellings.
 */
import { gstState } from "@/lib/gst-states";
import type { SyncSystem } from "@/server/db/schema";
import type { CanonicalBooks, CLedger, CStockItem, CVoucher } from "./model";

export type FileTool = SyncSystem;

type PartyField = "name" | "group" | "gstin" | "state" | "address" | "phone" | "email" | "opening";
type ItemField = "name" | "code" | "group" | "unit" | "uqc" | "hsn" | "gst" | "cess" | "mrp" | "price" | "opening";
type LineField = "date" | "type" | "number" | "party" | "ledger" | "amount" | "item" | "godown" | "qty" | "rate" | "narration";

export interface ToolLayout {
  tool: FileTool;
  label: string;
  file: "XLSX" | "CSV";
  /** Date format the tool imports. */
  date: "DMY" | "ISO";
  sheets: { parties: string; items: string; lines: string };
  parties: Partial<Record<PartyField, string>>;
  items: Partial<Record<ItemField, string>>;
  lines: Partial<Record<LineField, string>>;
}

export const LAYOUTS: Record<FileTool, ToolLayout> = {
  TALLY: {
    tool: "TALLY",
    label: "TallyPrime (Excel)",
    file: "XLSX",
    date: "DMY",
    sheets: { parties: "Ledgers", items: "Stock Items", lines: "Vouchers" },
    parties: { name: "Name", group: "Under", gstin: "GSTIN/UIN", state: "State", address: "Address", phone: "Mobile No.", email: "E-mail", opening: "Opening Balance (Dr+/Cr-)" },
    items: { name: "Name", code: "Part No.", group: "Under", unit: "Units", uqc: "UQC", hsn: "HSN/SAC", gst: "GST Rate (%)", cess: "Cess Rate (%)", mrp: "MRP", price: "Standard Selling Price", opening: "Opening Quantity" },
    lines: { date: "Date", type: "Voucher Type", number: "Voucher Number", party: "Party A/c Name", ledger: "Ledger Name", amount: "Amount (Dr+/Cr-)", item: "Stock Item", godown: "Godown", qty: "Quantity", rate: "Rate", narration: "Narration" },
  },
  BUSY: {
    tool: "BUSY",
    label: "Busy",
    file: "XLSX",
    date: "DMY",
    sheets: { parties: "Account Master", items: "Item Master", lines: "Vouchers" },
    parties: { name: "Name", group: "Group", gstin: "GSTIN", state: "State", address: "Address 1", phone: "Mobile", email: "Email", opening: "Op. Bal. (Dr+/Cr-)" },
    items: { name: "Name", code: "Alias", group: "Group", unit: "Main Unit", uqc: "UQC", hsn: "HSN Code", gst: "Tax Rate (%)", cess: "Cess (%)", mrp: "MRP", price: "Sale Price", opening: "Op. Stock (Qty)" },
    lines: { date: "Date", type: "Vch Type", number: "Vch/Bill No", party: "Party Name", ledger: "Account", amount: "Amount (Dr+/Cr-)", item: "Item Name", godown: "Material Centre", qty: "Qty", rate: "Price", narration: "Narration" },
  },
  MARG: {
    tool: "MARG",
    label: "Marg ERP (Busy-compatible Excel)",
    file: "XLSX",
    date: "DMY",
    sheets: { parties: "Ledger", items: "Product", lines: "Bills" },
    parties: { name: "Ledger Name", group: "Group", gstin: "GST No", state: "State", address: "Address", phone: "Mobile", email: "Email", opening: "Opening (Dr+/Cr-)" },
    items: { name: "Product Name", code: "Code", group: "Company / Group", unit: "Unit", uqc: "UQC", hsn: "HSN", gst: "GST %", cess: "Cess %", mrp: "MRP", price: "Rate", opening: "Opening Stock" },
    lines: { date: "Bill Date", type: "Type", number: "Bill No", party: "Party", ledger: "Ledger", amount: "Amount (Dr+/Cr-)", item: "Product", godown: "Store", qty: "Qty", rate: "Rate", narration: "Remarks" },
  },
  VYAPAR: {
    tool: "VYAPAR",
    label: "Vyapar",
    file: "XLSX",
    date: "DMY",
    sheets: { parties: "Parties", items: "Items", lines: "Transactions" },
    parties: { name: "Party Name", group: "Party Group", gstin: "GSTIN", state: "State", address: "Billing Address", phone: "Phone Number", email: "Email", opening: "Opening Balance (receivable+/payable-)" },
    items: { name: "Item Name", code: "Item Code", group: "Category", unit: "Unit", uqc: "UQC", hsn: "HSN", gst: "Tax Rate (%)", cess: "Cess (%)", mrp: "MRP", price: "Sale Price", opening: "Opening Stock Quantity" },
    lines: { date: "Date", type: "Transaction Type", number: "Invoice No", party: "Party Name", ledger: "Account", amount: "Amount (Dr+/Cr-)", item: "Item Name", godown: "Godown", qty: "Quantity", rate: "Price/Unit", narration: "Description" },
  },
  MYBILLBOOK: {
    tool: "MYBILLBOOK",
    label: "myBillBook",
    file: "XLSX",
    date: "DMY",
    sheets: { parties: "Parties", items: "Items", lines: "Invoices" },
    parties: { name: "Party Name", group: "Party Type", gstin: "GSTIN", state: "State", address: "Billing Address", phone: "Mobile Number", email: "Email", opening: "Opening Balance (to collect+/to pay-)" },
    items: { name: "Item Name", code: "Item Code", group: "Category", unit: "Unit", uqc: "UQC", hsn: "HSN Code", gst: "GST %", cess: "Cess %", mrp: "MRP", price: "Sales Price", opening: "Opening Stock" },
    lines: { date: "Invoice Date", type: "Voucher Type", number: "Invoice Number", party: "Party Name", ledger: "Ledger", amount: "Amount (Dr+/Cr-)", item: "Item Name", godown: "Godown", qty: "Quantity", rate: "Price", narration: "Notes" },
  },
  ZOHO: {
    tool: "ZOHO",
    label: "Zoho Books (CSV)",
    file: "CSV",
    date: "ISO",
    sheets: { parties: "contacts", items: "items", lines: "transactions" },
    parties: { name: "Display Name", group: "Contact Type", gstin: "GST Identification Number (GSTIN)", state: "Place of Contact", address: "Billing Address", phone: "Phone", email: "EmailID", opening: "Opening Balance (Dr+/Cr-)" },
    items: { name: "Item Name", code: "SKU", group: "Category", unit: "Usage unit", uqc: "UQC", hsn: "HSN/SAC", gst: "Intra State Tax Rate", cess: "Cess Rate", mrp: "MRP", price: "Rate", opening: "Opening Stock" },
    lines: { date: "Date", type: "Transaction Type", number: "Transaction Number", party: "Contact Name", ledger: "Account", amount: "Amount (Dr+/Cr-)", item: "Item Name", godown: "Warehouse Name", qty: "Quantity", rate: "Item Price", narration: "Notes" },
  },
  ODOO: {
    tool: "ODOO",
    label: "Odoo (CSV)",
    file: "CSV",
    date: "ISO",
    sheets: { parties: "res.partner", items: "product.template", lines: "account.move" },
    parties: { name: "name", group: "category_id", gstin: "vat", state: "state_id", address: "street", phone: "phone", email: "email", opening: "opening_balance" },
    items: { name: "name", code: "default_code", group: "categ_id", unit: "uom_id", uqc: "l10n_in_uqc", hsn: "l10n_in_hsn_code", gst: "taxes_id", cess: "cess", mrp: "mrp", price: "list_price", opening: "qty_available" },
    lines: { date: "date", type: "journal_id", number: "name", party: "partner_id", ledger: "line_ids/account_id", amount: "line_ids/balance", item: "line_ids/product_id", godown: "warehouse", qty: "line_ids/quantity", rate: "line_ids/price_unit", narration: "ref" },
  },
  GENERIC: {
    tool: "GENERIC",
    label: "GoKesari standard (any software)",
    file: "XLSX",
    date: "ISO",
    sheets: { parties: "Parties", items: "Items", lines: "Voucher lines" },
    parties: { name: "Name", group: "Group", gstin: "GSTIN", state: "State code", address: "Address", phone: "Phone", email: "Email", opening: "Opening (Dr+/Cr-)" },
    items: { name: "Name", code: "Code / barcode", group: "Group", unit: "Unit", uqc: "UQC", hsn: "HSN/SAC", gst: "GST %", cess: "Cess %", mrp: "MRP", price: "Sale price", opening: "Opening qty" },
    lines: { date: "Date", type: "Voucher type", number: "Number", party: "Party", ledger: "Ledger", amount: "Amount (Dr+/Cr-)", item: "Item", godown: "Godown", qty: "Qty", rate: "Rate", narration: "Narration" },
  },
};

export interface Sheet {
  name: string;
  header: string[];
  rows: (string | number | null)[][];
}

const rupees = (p: number | null | undefined) => (p == null ? null : Math.round(p) / 100);
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

function sheetOf<F extends string>(name: string, columns: Partial<Record<F, string>>, rows: Partial<Record<F, string | number | null>>[]): Sheet {
  const fields = Object.keys(columns) as F[];
  return { name, header: fields.map((f) => columns[f]!), rows: rows.map((r) => fields.map((f) => r[f] ?? null)) };
}

/** The canonical books as the tool's three sheets. */
export function toToolSheets(tool: FileTool, books: CanonicalBooks): Sheet[] {
  const L = LAYOUTS[tool];
  const date = (iso: string) => (L.date === "DMY" ? dmy(iso) : iso);
  const parties = books.ledgers
    .filter((l) => l.kind === "PARTY" || tool === "TALLY" || tool === "BUSY" || tool === "GENERIC")
    .map((l) => ({
      name: l.name,
      group: l.group,
      gstin: l.gstin ?? null,
      state: l.stateCode ? (tool === "GENERIC" ? l.stateCode : (gstState(l.stateCode)?.name ?? l.stateCode)) : null,
      address: l.address ?? null,
      phone: l.phone ?? null,
      email: l.email ?? null,
      opening: rupees(l.openingPaise),
    }));
  const unitUqc = new Map(books.units.map((u) => [u.symbol, u.uqc]));
  const items = books.stockItems.map((i) => ({
    name: i.name,
    code: i.barcode,
    group: i.group,
    unit: i.unit,
    uqc: unitUqc.get(i.unit) ?? null,
    hsn: i.hsn,
    gst: i.gstRateBp == null ? null : i.gstRateBp / 100,
    cess: i.cessBp / 100,
    mrp: rupees(i.mrpPaise),
    price: rupees(i.salePricePaise),
    opening: i.openingQtyMilli / 1000,
  }));
  const lines: Partial<Record<LineField, string | number | null>>[] = [];
  for (const v of books.vouchers) {
    const head = { date: date(v.date), type: v.tallyType, number: v.number, party: v.party, narration: v.narration };
    for (const l of v.ledgerLines) lines.push({ ...head, ledger: l.ledger, amount: rupees(l.amountPaise) });
    for (const i of v.inventoryLines) lines.push({ ...head, item: i.item, godown: i.godown, qty: i.qtyMilli / 1000, rate: rupees(i.ratePaise) });
  }
  return [sheetOf(L.sheets.parties, L.parties, parties), sheetOf(L.sheets.items, L.items, items), sheetOf(L.sheets.lines, L.lines, lines)];
}

/** Empty sheets (headings only) — the template pack. */
export function templateSheets(tool: FileTool): Sheet[] {
  const L = LAYOUTS[tool];
  return [
    { name: L.sheets.parties, header: Object.values(L.parties), rows: [] },
    { name: L.sheets.items, header: Object.values(L.items), rows: [] },
    { name: L.sheets.lines, header: Object.values(L.lines), rows: [] },
  ];
}

/* ------------------------------------------------------------- import */

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which sheet a header row belongs to, and the column of each field — by any tool's spelling. */
function columnsFor<F extends string>(header: string[], pick: (l: ToolLayout) => Partial<Record<F, string>>): Map<F, number> {
  const out = new Map<F, number>();
  const idx = new Map(header.map((h, i) => [norm(h), i]));
  for (const layout of Object.values(LAYOUTS)) {
    for (const [field, label] of Object.entries(pick(layout)) as [F, string][]) {
      const i = idx.get(norm(label));
      if (i != null && !out.has(field)) out.set(field, i);
    }
  }
  return out;
}

const num = (v: string | undefined) => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const toIso = (v: string | undefined) => {
  const s = (v ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{8})$/.exec(s);
  if (m) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
};

export type SheetKind = "parties" | "items" | "lines";

/** Recognises a sheet by its headings (a party sheet has a GSTIN / opening column, an item sheet HSN / unit, a voucher sheet a voucher number). */
export function sheetKindOf(header: string[]): SheetKind | null {
  const lines = columnsFor<LineField>(header, (l) => l.lines);
  if (lines.has("number") && (lines.has("ledger") || lines.has("item"))) return "lines";
  const items = columnsFor<ItemField>(header, (l) => l.items);
  if (items.has("name") && (items.has("hsn") || items.has("unit") || items.has("gst"))) return "items";
  const parties = columnsFor<PartyField>(header, (l) => l.parties);
  if (parties.has("name")) return "parties";
  return null;
}

export function parseParties(header: string[], rows: string[][]): CLedger[] {
  const c = columnsFor<PartyField>(header, (l) => l.parties);
  const get = (r: string[], f: PartyField) => (c.has(f) ? (r[c.get(f)!] ?? "").trim() : "");
  return rows
    .filter((r) => get(r, "name"))
    .map((r) => {
      const gstin = get(r, "gstin").toUpperCase() || null;
      const group = get(r, "group");
      return {
        key: `IMPORT:${get(r, "name")}`,
        name: get(r, "name"),
        group,
        kind: /creditor|supplier|vendor|sundry|debtor|customer|^$/i.test(group) ? ("PARTY" as const) : ("BOOK" as const),
        gstin,
        stateCode: gstState(get(r, "state") || gstin)?.code ?? null,
        address: get(r, "address") || null,
        phone: get(r, "phone") || null,
        email: get(r, "email") || null,
        openingPaise: Math.round((num(get(r, "opening")) ?? 0) * 100),
      };
    });
}

export function parseItems(header: string[], rows: string[][]): CStockItem[] {
  const c = columnsFor<ItemField>(header, (l) => l.items);
  const get = (r: string[], f: ItemField) => (c.has(f) ? (r[c.get(f)!] ?? "").trim() : "");
  return rows
    .filter((r) => get(r, "name"))
    .map((r) => {
      const gst = num(get(r, "gst").replace(/GST|IGST|%/gi, ""));
      return {
        key: `IMPORT:${get(r, "name")}`,
        name: get(r, "name"),
        group: get(r, "group") || "Primary",
        unit: get(r, "unit") || "Nos",
        hsn: get(r, "hsn").replace(/\D/g, "") || null,
        gstRateBp: gst == null ? null : Math.round(gst * 100),
        cessBp: Math.round((num(get(r, "cess")) ?? 0) * 100),
        mrpPaise: num(get(r, "mrp")) == null ? null : Math.round(num(get(r, "mrp"))! * 100),
        salePricePaise: num(get(r, "price")) == null ? null : Math.round(num(get(r, "price"))! * 100),
        barcode: get(r, "code") || null,
        openingQtyMilli: Math.round((num(get(r, "opening")) ?? 0) * 1000),
      };
    });
}

/** Voucher lines grouped back into vouchers by type + date + number. */
export function parseVoucherLines(header: string[], rows: string[][]): CVoucher[] {
  const c = columnsFor<LineField>(header, (l) => l.lines);
  const get = (r: string[], f: LineField) => (c.has(f) ? (r[c.get(f)!] ?? "").trim() : "");
  const out = new Map<string, CVoucher>();
  for (const r of rows) {
    const number = get(r, "number");
    if (!number) continue;
    const type = get(r, "type") || "Journal";
    const date = toIso(get(r, "date"));
    const key = `${type}|${date}|${number}`;
    const v = out.get(key) ?? { key, type, tallyType: type, date, number, narration: get(r, "narration") || null, party: get(r, "party") || null, ledgerLines: [], inventoryLines: [], taxLines: [] };
    if (get(r, "ledger")) v.ledgerLines.push({ ledger: get(r, "ledger"), amountPaise: Math.round((num(get(r, "amount")) ?? 0) * 100) });
    if (get(r, "item")) {
      const rate = num(get(r, "rate"));
      v.inventoryLines.push({ item: get(r, "item"), godown: get(r, "godown"), qtyMilli: Math.round((num(get(r, "qty")) ?? 0) * 1000), ratePaise: rate == null ? null : Math.round(rate * 100) });
    }
    out.set(key, v);
  }
  return [...out.values()];
}
