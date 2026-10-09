/**
 * File adapters (Module 2): software without a confirmed public API —
 * myBillBook, Vyapar — and a generic one for any other software. The shop
 * uploads its item export (Excel or CSV); a column-mapping screen ties its
 * columns to GoKesari's fields (presets below are only first guesses); and the
 * shop downloads its GoKesari sales, credit notes and stock-out as files.
 *
 * The presets are NOT confirmed against real exports from myBillBook or
 * Vyapar yet (pending action P1, MODULE2 doc) — the mapping screen always
 * shows the guess for the shop to correct, and the shop's last mapping is
 * remembered. When either software publishes an API, its adapter becomes an
 * ApiAdapter with the same provider key; nothing else changes.
 */
import { z } from "zod";

import type { FileAdapter, FileItemField } from "../types";

const COMMON: Partial<Record<FileItemField, string[]>> = {
  name: ["item name", "product name", "name", "item", "product", "description"],
  sku: ["item code", "sku", "product code", "code"],
  barcode: ["barcode", "bar code", "ean", "gtin", "upc"],
  unit: ["unit", "uom", "primary unit", "base unit"],
  stock: ["stock", "current stock", "stock quantity", "quantity", "qty", "closing stock", "stock qty", "opening stock"],
  price: ["sale price", "selling price", "sales price", "price", "rate"],
  mrp: ["mrp", "m.r.p", "m.r.p."],
  hsn: ["hsn", "hsn code", "hsn/sac", "hsn / sac", "hsn_code"],
  gstRate: ["gst", "gst %", "gst rate", "gst rate (%)", "tax rate", "tax %", "tax"],
};

const empty = z.object({}) as unknown as z.ZodType<Record<string, unknown>>;

export const genericFileAdapter: FileAdapter = {
  provider: "GENERIC_FILE",
  transport: "FILE",
  label: "Other software (Excel / CSV)",
  description: "Any software that can export items to Excel or CSV. You match its columns once; GoKesari remembers.",
  configSchema: empty,
  credentialsSchema: empty,
  itemColumns: COMMON,
  presetConfirmed: false,
};

export const myBillBookAdapter: FileAdapter = {
  ...genericFileAdapter,
  provider: "MYBILLBOOK",
  label: "myBillBook",
  description: "Export your items from myBillBook to Excel and upload them here; download your GoKesari sales to import into myBillBook.",
  itemColumns: { ...COMMON, sku: ["item code", ...(COMMON.sku ?? [])], price: ["sales price", ...(COMMON.price ?? [])] },
};

export const vyaparAdapter: FileAdapter = {
  ...genericFileAdapter,
  provider: "VYAPAR",
  label: "Vyapar",
  description: "Export your items from Vyapar to Excel and upload them here; download your GoKesari sales to import into Vyapar.",
  itemColumns: { ...COMMON, sku: ["item code", ...(COMMON.sku ?? [])], price: ["sale price", ...(COMMON.price ?? [])] },
};
