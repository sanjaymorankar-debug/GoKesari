/**
 * RBAC v2 Phase 4 — Support's bulk price list for one shop (brief §3.5): download the shop's template
 * (pre-filled with today's values), edit it, upload it. Every row is checked; a row with a problem is reported
 * in an error file and left out; the good rows become ONE change request with many line items for the shop
 * owner (brief §4.2) — never written straight to the shop.
 *
 * Columns (CSV or Excel): shop_product_id, product_name (ignored), barcode (ignored), online_price_inr,
 * offline_price_inr, mrp_inr (this shop's own MRP), available (yes / no). Blank cell = no change.
 * Selling price must not exceed MRP. Purchase cost is not part of this file (restricted, brief §3.5).
 */
import ExcelJS from "exceljs";
import { and, asc, eq, isNull } from "drizzle-orm";

import { validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { products, shopListingDetails, shopProducts, type UserRole } from "@/server/db/schema";
import { proposeShopChanges, type ChangeItemInput } from "./change-requests";

export const BULK_COLUMNS = ["shop_product_id", "product_name", "barcode", "online_price_inr", "offline_price_inr", "mrp_inr", "available"] as const;

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rupees = (p: number | null | undefined) => (p == null ? "" : (p / 100).toFixed(2));

export async function buildBulkTemplate(shopId: string): Promise<string> {
  const rows = await db
    .select({ sp: shopProducts, name: products.name, barcode: products.barcode, shopMrp: shopListingDetails.mrpPaise, masterMrp: products.mrpPaise })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)))
    .orderBy(asc(products.name))
    .limit(20_000);
  const lines = [BULK_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [r.sp.id, r.name, r.barcode ?? "", rupees(r.sp.onlinePricePaise), rupees(r.sp.offlinePricePaise), rupees(r.shopMrp ?? r.masterMrp), r.sp.isAvailable ? "yes" : "no"]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/** Minimal RFC 4180 CSV reader (quotes, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out.filter((r) => r.some((c) => c.trim() !== ""));
}

async function readSheet(file: Buffer, filename: string): Promise<string[][]> {
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    ws.eachRow((r) => {
      const values = (r.values as unknown[]).slice(1).map((v) => (v == null ? "" : typeof v === "object" && v && "text" in v ? String((v as { text: unknown }).text) : String(v)));
      rows.push(values);
    });
    return rows;
  }
  return parseCsv(file.toString("utf8").replace(/^﻿/, ""));
}

export interface BulkRowError {
  row: number;
  shopProductId: string;
  message: string;
}

const money = (v: string, what: string): number | null => {
  const t = v.trim().replace(/[₹,\s]/g, "");
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error(`${what}: a rupee amount like 120 or 120.50.`);
  const paise = Math.round(Number(t) * 100);
  if (paise <= 0) throw new Error(`${what}: more than 0.`);
  return paise;
};

/** Checks every row; returns the change items of the good rows and the errors of the rest. */
export async function checkBulkFile(shopId: string, file: Buffer, filename: string): Promise<{ items: ChangeItemInput[]; errors: BulkRowError[]; rows: number }> {
  const sheet = await readSheet(file, filename);
  if (sheet.length < 2) throw validationFailed("The file has no rows under the header.");
  const header = sheet[0].map((h) => h.trim().toLowerCase());
  const col = (name: (typeof BULK_COLUMNS)[number]) => header.indexOf(name);
  if (col("shop_product_id") < 0) throw validationFailed("The first row must be the template's header (shop_product_id, …).");
  if (sheet.length - 1 > 20_000) throw validationFailed("At most 20,000 rows in one file.");

  const live = await db
    .select({ sp: shopProducts, shopMrp: shopListingDetails.mrpPaise, masterMrp: products.mrpPaise })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));
  const byId = new Map(live.map((l) => [l.sp.id, l]));

  const items: ChangeItemInput[] = [];
  const errors: BulkRowError[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < sheet.length; i += 1) {
    const r = sheet[i];
    const get = (name: (typeof BULK_COLUMNS)[number]) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");
    const id = get("shop_product_id");
    try {
      const current = byId.get(id);
      if (!current) throw new Error("Not a product of this shop (keep the shop_product_id from the template).");
      if (seen.has(id)) throw new Error("This product appears twice in the file.");
      seen.add(id);
      const online = money(get("online_price_inr"), "Online price");
      const offline = money(get("offline_price_inr"), "In-shop price");
      const mrp = money(get("mrp_inr"), "MRP");
      const availableRaw = get("available").toLowerCase();
      if (availableRaw && !["yes", "no", "y", "n", "true", "false", "1", "0"].includes(availableRaw)) throw new Error("Available: yes or no.");
      const effectiveMrp = mrp ?? current.shopMrp ?? current.masterMrp ?? null;
      for (const [p, what] of [
        [online ?? current.sp.onlinePricePaise, "Online price"],
        [offline ?? current.sp.offlinePricePaise, "In-shop price"],
      ] as const) {
        if (effectiveMrp != null && p != null && p > effectiveMrp) throw new Error(`${what} ₹${rupees(p)} is above the MRP ₹${rupees(effectiveMrp)}.`);
      }
      if (online != null && online !== current.sp.onlinePricePaise) items.push({ target: "SHOP_PRODUCT", shopProductId: id, field: "onlinePricePaise", value: online });
      if (offline != null && offline !== current.sp.offlinePricePaise) items.push({ target: "SHOP_PRODUCT", shopProductId: id, field: "offlinePricePaise", value: offline });
      const currentMrp = current.shopMrp ?? current.masterMrp ?? null;
      if (mrp != null && mrp !== currentMrp) items.push({ target: "SHOP_PRODUCT", shopProductId: id, field: "shopMrpPaise", value: mrp });
      if (availableRaw) {
        const available = ["yes", "y", "true", "1"].includes(availableRaw);
        if (available !== current.sp.isAvailable) items.push({ target: "SHOP_PRODUCT", shopProductId: id, field: "isAvailable", value: available });
      }
    } catch (e) {
      errors.push({ row: i + 1, shopProductId: id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { items, errors, rows: sheet.length - 1 };
}

export function errorReportCsv(errors: BulkRowError[]): string {
  return ["row,shop_product_id,problem", ...errors.map((e) => [e.row, e.shopProductId, e.message].map(csvCell).join(","))].join("\n") + "\n";
}

export async function proposeBulkFile(
  input: { shopId: string; ticketId?: string | null; reason: string; file: Buffer; filename: string },
  actor: { id: string; role: UserRole },
) {
  if (input.file.length > 10_000_000) throw validationFailed("The file is larger than 10 MB.");
  if (!/\.(csv|xlsx)$/i.test(input.filename)) throw validationFailed("Upload the template as .csv or .xlsx.");
  const checked = await checkBulkFile(input.shopId, input.file, input.filename);
  if (checked.items.length === 0) {
    return { request: null, errors: checked.errors, rows: checked.rows, changes: 0 };
  }
  const request = await proposeShopChanges({ shopId: input.shopId, ticketId: input.ticketId, reason: input.reason, items: checked.items }, actor);
  return { request, errors: checked.errors, rows: checked.rows, changes: checked.items.length };
}
