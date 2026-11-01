/**
 * The canonical accounting model (billing v2, docs/billing §7.1, gap G12):
 * one internal picture of a shop's books that every connector maps to and
 * from — never tool to tool. Company, ledger groups, ledgers (book ledgers,
 * parties, sub-ledgers), stock groups, units (with GST unit codes), godowns,
 * stock items, batches, opening balances, and vouchers with their ledger,
 * inventory and tax lines.
 *
 * Built from the shop's books (acc_ledger_entries — which carry GoKesari's
 * orders, fees and payouts too, platform-posting.ts — and inv_stock_ledger).
 * Amounts are paise; a ledger line is + for debit, − for credit, so every
 * voucher's lines add up to zero. Every record has a stable key and a hash, so
 * the sync log can tell new, unchanged and changed records apart.
 */
import { createHash } from "node:crypto";

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";

import { ACCOUNT_GROUPS, BOOK_ACCOUNT_LABELS, type BookAccount } from "@/lib/accounts/constants";
import { gstState } from "@/lib/gst-states";
import { db } from "@/server/db";
import {
  accLedgerEntries,
  accParties,
  invBatches,
  invStockLedger,
  invUnitUqc,
  productCategories,
  products,
  shopProducts,
  shops,
} from "@/server/db/schema";

export interface CCompany {
  name: string;
  legalName: string;
  gstin: string | null;
  /** Two-digit GST state code. */
  stateCode: string | null;
  address: string;
  booksFrom: string;
}
export interface CLedgerGroup {
  name: string;
  nature: "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE" | "CAPITAL";
}
export interface CLedger {
  /** GoKesari's code: the book account, "PARTY:<id>", or "<account>:<sub-ledger>". */
  key: string;
  name: string;
  group: string;
  kind: "BOOK" | "PARTY" | "SUB";
  gstin?: string | null;
  stateCode?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Opening balance, + debit / − credit. */
  openingPaise: number;
}
export interface CStockGroup {
  name: string;
}
export interface CUnit {
  symbol: string;
  /** GST unit quantity code; null when the shop has not mapped it (export is blocked for GST). */
  uqc: string | null;
  decimals: number;
}
export interface CGodown {
  name: string;
  channel: "ONLINE" | "OFFLINE";
}
export interface CStockItem {
  key: string;
  name: string;
  group: string;
  unit: string;
  hsn: string | null;
  gstRateBp: number | null;
  cessBp: number;
  mrpPaise: number | null;
  salePricePaise: number | null;
  barcode: string | null;
  openingQtyMilli: number;
}
export interface CBatch {
  item: string;
  batchNo: string;
  mfgDate: string | null;
  expiryDate: string | null;
}
export interface CVoucherLine {
  ledger: string;
  /** + debit, − credit. */
  amountPaise: number;
}
export interface CInventoryLine {
  item: string;
  godown: string;
  /** + in, − out. */
  qtyMilli: number;
  ratePaise: number | null;
}
export interface CTaxLine {
  tax: "CGST" | "SGST" | "IGST" | "CESS";
  /** + input (claimable), − output (payable). */
  amountPaise: number;
}
export interface CVoucher {
  /** "<Tally type>|<date>|<number>" — Tally's own idempotency key. */
  key: string;
  type: string;
  tallyType: string;
  date: string;
  number: string;
  narration: string | null;
  party: string | null;
  ledgerLines: CVoucherLine[];
  inventoryLines: CInventoryLine[];
  taxLines: CTaxLine[];
}
export interface CanonicalBooks {
  company: CCompany;
  ledgerGroups: CLedgerGroup[];
  ledgers: CLedger[];
  stockGroups: CStockGroup[];
  units: CUnit[];
  godowns: CGodown[];
  stockItems: CStockItem[];
  batches: CBatch[];
  vouchers: CVoucher[];
}

export const GODOWNS: CGodown[] = [
  { name: "Online stock", channel: "ONLINE" },
  { name: "Shop counter", channel: "OFFLINE" },
];

export const TALLY_VOUCHER_TYPE: Record<string, string> = {
  SALE: "Sales",
  PURCHASE: "Purchase",
  PAYMENT: "Payment",
  RECEIPT: "Receipt",
  EXPENSE: "Payment",
  WRITE_OFF: "Journal",
  OPENING: "Journal",
  REVERSAL: "Journal",
  SALES_RETURN: "Credit Note",
  PURCHASE_RETURN: "Debit Note",
  DEBIT_NOTE: "Debit Note",
  CONTRA: "Contra",
  JOURNAL: "Journal",
  STOCK_JOURNAL: "Stock Journal",
};

const KNOWN_UQC: Record<string, string> = {
  l: "LTR", ltr: "LTR", litre: "LTR", liter: "LTR", litres: "LTR", ml: "MLT", mlt: "MLT", kg: "KGS", kgs: "KGS", kilogram: "KGS",
  g: "GMS", gm: "GMS", gms: "GMS", gram: "GMS", grams: "GMS", dozen: "DOZ", doz: "DOZ", dzn: "DOZ", pack: "PAC", pkt: "PAC", packet: "PAC",
  box: "BOX", bottle: "BTL", btl: "BTL", m: "MTR", mtr: "MTR", metre: "MTR", pc: "PCS", pcs: "PCS", piece: "PCS", pieces: "PCS", nos: "NOS", no: "NOS",
  unit: "UNT", units: "UNT", bag: "BAG", bags: "BAG", bundle: "BDL", can: "CAN", carton: "CTN", tablet: "TBS", tablets: "TBS", roll: "ROL", set: "SET", pair: "PRS", tin: "TIN", tube: "TUB", quintal: "QTL", ton: "TON", tonne: "TON",
};

/** The UQC for a unit: the shop's own mapping, else a known one; null when unknown (§2.3: no silent NOS). */
export function uqcOf(unit: string | null | undefined, shopMap: Map<string, string> = new Map()): string | null {
  const u = (unit ?? "").trim().toLowerCase();
  if (!u) return null;
  return shopMap.get(u) ?? KNOWN_UQC[u] ?? null;
}

export async function shopUnitMap(shopId: string): Promise<Map<string, string>> {
  const rows = await db.select().from(invUnitUqc).where(eq(invUnitUqc.shopId, shopId));
  return new Map(rows.map((r) => [r.unit, r.uqc]));
}

export function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const ledgerName = (account: BookAccount, sub: string | null | undefined) => (sub ? `${BOOK_ACCOUNT_LABELS[account]} - ${sub}` : BOOK_ACCOUNT_LABELS[account]);

/** The shop's books in canonical form; vouchers dated in [from, to). */
export async function buildCanonicalBooks(shopId: string, from: string, to: string): Promise<CanonicalBooks> {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw new Error("Shop not found");
  const unitMap = await shopUnitMap(shopId);
  const company: CCompany = {
    name: shop.name,
    legalName: shop.legalBusinessName ?? shop.name,
    gstin: shop.gstin,
    stateCode: gstState(shop.gstin ?? shop.state ?? null)?.code ?? null,
    address: [shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.state, shop.pincode].filter(Boolean).join(", "),
    booksFrom: from,
  };

  /* --------------------------------------------------------- ledgers */
  const parties = await db.select().from(accParties).where(eq(accParties.shopId, shopId));
  const partyName = new Map(parties.map((p) => [p.id, p.name]));
  const used = await db
    .selectDistinct({ account: accLedgerEntries.account, subAccount: accLedgerEntries.subAccount })
    .from(accLedgerEntries)
    .where(eq(accLedgerEntries.shopId, shopId));
  const ledgers: CLedger[] = [];
  for (const account of Object.keys(ACCOUNT_GROUPS) as BookAccount[]) {
    if (account === "PARTY") continue;
    ledgers.push({ key: account, name: BOOK_ACCOUNT_LABELS[account], group: ACCOUNT_GROUPS[account].group, kind: "BOOK", openingPaise: 0 });
  }
  for (const u of used) {
    if (!u.subAccount || u.account === "PARTY") continue;
    const account = u.account as BookAccount;
    ledgers.push({ key: `${account}:${u.subAccount}`, name: ledgerName(account, u.subAccount), group: ACCOUNT_GROUPS[account]?.group ?? "Indirect Expenses", kind: "SUB", openingPaise: 0 });
  }
  for (const p of parties) {
    ledgers.push({
      key: `PARTY:${p.id}`,
      name: p.name,
      group: p.kind === "SUPPLIER" ? "Sundry Creditors" : "Sundry Debtors",
      kind: "PARTY",
      gstin: p.gstin,
      stateCode: p.stateCode ?? gstState(p.gstin ?? null)?.code ?? null,
      address: p.address,
      phone: p.phone,
      email: p.email,
      openingPaise: 0,
    });
  }
  // Opening balances: each ledger's balance before the period (its opening vouchers included), so
  // an export starting mid-year carries the balances and the period's vouchers, never both.
  const before = await db
    .select({ account: accLedgerEntries.account, partyId: accLedgerEntries.partyId, subAccount: accLedgerEntries.subAccount, dr: accLedgerEntries.debitPaise, cr: accLedgerEntries.creditPaise })
    .from(accLedgerEntries)
    .where(and(eq(accLedgerEntries.shopId, shopId), lt(accLedgerEntries.entryDate, from)));
  const ledgerByKey = new Map(ledgers.map((l) => [l.key, l]));
  for (const b of before) {
    const key = b.account === "PARTY" ? `PARTY:${b.partyId}` : b.subAccount ? `${b.account}:${b.subAccount}` : b.account;
    const l = ledgerByKey.get(key);
    if (l) l.openingPaise += b.dr - b.cr;
  }
  const ledgerGroups = [...new Map(Object.values(ACCOUNT_GROUPS).map((g) => [g.group, { name: g.group, nature: g.nature }])).values(), { name: "Sundry Creditors", nature: "LIABILITY" as const }];

  /* ----------------------------------------------------------- stock */
  const items = await db
    .select({ sp: shopProducts, p: products, category: productCategories.name })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
    .where(eq(shopProducts.shopId, shopId));
  const openings = await db
    .select({ spId: invStockLedger.shopProductId, qty: invStockLedger.qtyMilli, date: invStockLedger.entryDate })
    .from(invStockLedger)
    .where(and(eq(invStockLedger.shopId, shopId), lt(invStockLedger.entryDate, from)));
  const openingBy = new Map<string, number>();
  for (const o of openings) openingBy.set(o.spId, (openingBy.get(o.spId) ?? 0) + o.qty);
  const itemName = (p: typeof products.$inferSelect) => p.name + (p.variant ? ` ${p.variant}` : "");
  const stockItems: CStockItem[] = items.map(({ sp, p, category }) => ({
    key: sp.id,
    name: itemName(p),
    group: category ?? "Primary",
    unit: p.unit,
    hsn: sp.hsnCode ?? p.hsnCode ?? null,
    gstRateBp: sp.gstRateBp ?? p.gstRateBp ?? null,
    cessBp: sp.cessBp ?? 0,
    mrpPaise: p.mrpPaise ?? null,
    salePricePaise: sp.onlinePricePaise ?? sp.offlinePricePaise ?? null,
    barcode: p.barcode ?? p.gtin ?? null,
    openingQtyMilli: openingBy.get(sp.id) ?? 0,
  }));
  const itemById = new Map(stockItems.map((i) => [i.key, i]));
  const stockGroups = [...new Set(stockItems.map((i) => i.group))].map((name) => ({ name }));
  const units = [...new Set(stockItems.map((i) => i.unit))].map((symbol) => ({ symbol, uqc: uqcOf(symbol, unitMap), decimals: ["kg", "l", "ltr", "g", "ml"].includes(symbol.toLowerCase()) ? 3 : 0 }));
  const batchRows = await db.select().from(invBatches).where(eq(invBatches.shopId, shopId));
  const batches = batchRows.map((b) => ({ item: itemById.get(b.shopProductId)?.name ?? b.shopProductId, batchNo: b.batchNo, mfgDate: b.mfgDate, expiryDate: b.expiryDate }));

  /* -------------------------------------------------------- vouchers */
  const entries = await db
    .select()
    .from(accLedgerEntries)
    .where(and(eq(accLedgerEntries.shopId, shopId), gte(accLedgerEntries.entryDate, from), lt(accLedgerEntries.entryDate, to)))
    .orderBy(asc(accLedgerEntries.entryDate), asc(accLedgerEntries.createdAt));
  const byVoucher = new Map<string, typeof entries>();
  for (const e of entries) byVoucher.set(e.voucherId, [...(byVoucher.get(e.voucherId) ?? []), e]);
  // Inventory lines: the stock rows of the same source document (counter sales, purchases, shop documents).
  const stockSource: Record<string, string> = { SALE: "SALES_INVOICE", PURCHASE: "PURCHASE_INVOICE", SHOP_DOCUMENT: "SHOP_DOCUMENT", JOURNAL: "MANUAL" };
  const sourceIds = [...new Set(entries.filter((e) => stockSource[e.sourceType]).map((e) => e.sourceId))];
  const stockRows = sourceIds.length ? await db.select().from(invStockLedger).where(and(eq(invStockLedger.shopId, shopId), inArray(invStockLedger.sourceId, sourceIds))) : [];
  const godownOf = (channel: string) => GODOWNS.find((g) => g.channel === channel)?.name ?? GODOWNS[0].name;

  const vouchers: CVoucher[] = [];
  for (const [voucherId, legs] of byVoucher) {
    const first = legs[0];
    const tallyType = TALLY_VOUCHER_TYPE[first.voucherType] ?? "Journal";
    const number = first.docRef ?? voucherId.slice(0, 8);
    const ledgerLines = legs.map((l) => ({
      ledger: l.account === "PARTY" ? (partyName.get(l.partyId ?? "") ?? "Party") : ledgerName(l.account as BookAccount, l.subAccount),
      amountPaise: l.debitPaise - l.creditPaise,
    }));
    const taxLines: CTaxLine[] = legs
      .filter((l) => l.account.startsWith("GST_"))
      .map((l) => ({ tax: l.account.split("_")[2] as CTaxLine["tax"], amountPaise: l.debitPaise - l.creditPaise }));
    const partyLeg = legs.find((l) => l.account === "PARTY");
    const inventoryLines = stockSource[first.sourceType]
      ? stockRows
          .filter((r) => r.sourceId === first.sourceId && r.movementType !== "REVERSAL")
          .map((r) => ({ item: itemById.get(r.shopProductId)?.name ?? r.shopProductId, godown: godownOf(r.channel), qtyMilli: r.qtyMilli, ratePaise: r.unitPricePaise ?? r.unitCostPaise ?? null }))
      : [];
    vouchers.push({
      key: `${tallyType}|${first.entryDate}|${number}`,
      type: first.voucherType,
      tallyType,
      date: first.entryDate,
      number,
      narration: first.narration,
      party: partyLeg ? (partyName.get(partyLeg.partyId ?? "") ?? null) : null,
      ledgerLines,
      inventoryLines,
      taxLines,
    });
  }
  return { company, ledgerGroups, ledgers, stockGroups, units, godowns: GODOWNS, stockItems, batches, vouchers };
}

export interface FixItem {
  entity: "STOCK_ITEM" | "UNIT" | "VOUCHER" | "LEDGER";
  key: string;
  problem: string;
}

/** §7.6: what must be fixed before a GST-ready export — the shop sees this list, nothing is guessed. */
export function validateBooks(books: CanonicalBooks): FixItem[] {
  const fixes: FixItem[] = [];
  for (const i of books.stockItems) {
    if (!i.hsn) fixes.push({ entity: "STOCK_ITEM", key: i.name, problem: "No HSN code." });
    if (i.gstRateBp == null) fixes.push({ entity: "STOCK_ITEM", key: i.name, problem: "No GST rate." });
  }
  for (const u of books.units) if (!u.uqc) fixes.push({ entity: "UNIT", key: u.symbol, problem: `Unit "${u.symbol}" has no GST unit code (UQC): map it under Settings → Units.` });
  for (const v of books.vouchers) {
    const sum = v.ledgerLines.reduce((n, l) => n + l.amountPaise, 0);
    if (sum !== 0) fixes.push({ entity: "VOUCHER", key: v.key, problem: `Voucher does not balance (difference ₹${(sum / 100).toFixed(2)}).` });
  }
  const names = new Set(books.ledgers.map((l) => l.name));
  for (const v of books.vouchers) for (const l of v.ledgerLines) if (!names.has(l.ledger)) fixes.push({ entity: "LEDGER", key: l.ledger, problem: `Ledger "${l.ledger}" used in ${v.number} is not in the chart of accounts.` });
  return fixes;
}

/* --------------------------------------------- fingerprints (§7.4, §7.5)
 * What counts as "the same record" across GoKesari and the other software:
 * only the fields both sides hold, normalised, so a record exported and read
 * back unchanged has the same fingerprint whichever way it travelled.
 */
const n = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

export function partyFingerprint(p: { name: string; gstin?: string | null; phone?: string | null; email?: string | null; address?: string | null }): string {
  return hashOf({ name: n(p.name), gstin: n(p.gstin), phone: n(p.phone).replace(/\D/g, ""), email: n(p.email), address: n(p.address) });
}

export function itemFingerprint(i: { hsn?: string | null; gstRateBp?: number | null; cessBp?: number | null; salePricePaise?: number | null }): string {
  return hashOf({ hsn: n(i.hsn), gst: i.gstRateBp ?? null, cess: i.cessBp ?? 0, price: i.salePricePaise ?? null });
}

export function voucherFingerprint(v: Pick<CVoucher, "date" | "number" | "ledgerLines">): string {
  const lines = v.ledgerLines.map((l) => `${n(l.ledger)}:${l.amountPaise}`).sort();
  return hashOf({ date: v.date, number: n(v.number), lines });
}
