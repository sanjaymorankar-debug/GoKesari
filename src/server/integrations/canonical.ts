/**
 * The common internal format every accounting adapter speaks (Module 2,
 * docs/three-modules-2026-10/MODULE2_ACCOUNTING_INTEGRATION.md).
 *
 * Money is integer paise and tax rates are basis points (500 = 5%), as in the
 * rest of GoKesari. Quantities are decimals in the item's unit (accounting
 * software counts 2.5 kg, not 2500 milli-units). Adapters convert to and from
 * their software's own shapes; nothing else knows those shapes.
 */
import { z } from "zod";

const paise = z.number().int();
const rateBp = z.number().int().min(0).max(10_000);

/** An item as the shop's software describes it (PULL). */
export const canonicalItem = z.object({
  /** The software's own id for the item (Tally: name/GUID, Odoo: product.product id, Zoho: item_id). */
  externalId: z.string().min(1).max(300),
  name: z.string().min(1).max(300),
  sku: z.string().max(100).nullish(),
  barcode: z.string().max(100).nullish(),
  unit: z.string().max(40).nullish(),
  /** Stock on hand in the software, in `unit`. */
  stock: z.number().nullish(),
  /** Selling price incl. GST, per `unit`. */
  pricePaise: paise.nullish(),
  mrpPaise: paise.nullish(),
  hsn: z.string().max(10).nullish(),
  gstRateBp: rateBp.nullish(),
  cessBp: z.number().int().min(0).max(100_000).nullish(),
  /** Change counter where the software has one (Tally ALTERID), for "changed since". */
  version: z.string().max(40).nullish(),
});
export type CanonicalItem = z.infer<typeof canonicalItem>;

export const canonicalParty = z.object({
  name: z.string(),
  gstin: z.string().nullish(),
  /** Two-digit GST state code. */
  stateCode: z.string().nullish(),
  address: z.string().nullish(),
  phone: z.string().nullish(),
});
export type CanonicalParty = z.infer<typeof canonicalParty>;

export const canonicalLine = z.object({
  lineNo: z.number().int().min(1),
  /** GoKesari shop listing; the mapping gives the software's item. */
  shopProductId: z.string().nullish(),
  /** The software's item id when the listing is mapped; null = not mapped (adapter decides). */
  externalItemId: z.string().nullish(),
  name: z.string(),
  hsn: z.string().nullish(),
  /** Decimal quantity in `unit`. */
  quantity: z.number().positive(),
  unit: z.string(),
  /** GST unit code for returns (NOS, KGS, LTR…). */
  uqc: z.string(),
  /** Price per unit excluding GST. */
  ratePaise: paise,
  taxablePaise: paise,
  gstRateBp: rateBp,
  cgstPaise: paise,
  sgstPaise: paise,
  igstPaise: paise,
  cessPaise: paise.default(0),
  /** Line total including GST. */
  totalPaise: paise,
});
export type CanonicalLine = z.infer<typeof canonicalLine>;

const documentBase = {
  /** GoKesari's id — the idempotency key in the shop's software. */
  id: z.string(),
  number: z.string(),
  /** ISO date (YYYY-MM-DD, IST). */
  date: z.string(),
  seller: canonicalParty,
  buyer: canonicalParty,
  /** Two-digit GST state code of the place of supply. */
  placeOfSupply: z.string().nullish(),
  supplyType: z.enum(["INTRA", "INTER"]),
  /** TAX_INVOICE or BILL_OF_SUPPLY (no tax: unregistered or composition shop). */
  kind: z.enum(["TAX_INVOICE", "BILL_OF_SUPPLY"]),
  reverseCharge: z.boolean().default(false),
  lines: z.array(canonicalLine).min(1),
  totals: z.object({
    taxablePaise: paise,
    cgstPaise: paise,
    sgstPaise: paise,
    igstPaise: paise,
    cessPaise: paise.default(0),
    roundOffPaise: paise.default(0),
    totalPaise: paise,
  }),
  /** Order reference shown in the shop's software. */
  orderNumber: z.string(),
};

export const canonicalInvoice = z.object(documentBase);
export type CanonicalInvoice = z.infer<typeof canonicalInvoice>;

export const canonicalCreditNote = z.object({
  ...documentBase,
  reason: z.enum(["REFUND", "RETURN", "CANCELLATION"]),
  /** Goods came back: the software's stock goes up. */
  restock: z.boolean(),
  againstInvoice: z.object({ id: z.string(), number: z.string(), date: z.string() }),
});
export type CanonicalCreditNote = z.infer<typeof canonicalCreditNote>;

/** A stock change to apply in the software (Odoo, where an invoice does not move stock). */
export const canonicalStockAdjustment = z.object({
  reference: z.string(),
  lines: z.array(z.object({ externalItemId: z.string(), name: z.string(), quantityDelta: z.number() })),
});
export type CanonicalStockAdjustment = z.infer<typeof canonicalStockAdjustment>;

/** GoKesari unit → GST unit quantity code (UQC) for returns and e-invoices. */
export function uqcFor(unit: string | null | undefined): string {
  const u = (unit ?? "").trim().toUpperCase();
  if (["L", "LTR", "LITRE", "LITER", "LITRES"].includes(u)) return "LTR";
  if (["ML", "MLT"].includes(u)) return "MLT";
  if (["KG", "KGS", "KILOGRAM"].includes(u)) return "KGS";
  if (["G", "GM", "GMS", "GRAM", "GRAMS"].includes(u)) return "GMS";
  if (["DOZEN", "DOZ", "DZN"].includes(u)) return "DOZ";
  if (["PACK", "PKT", "PACKET"].includes(u)) return "PAC";
  if (["BOX"].includes(u)) return "BOX";
  if (["BOTTLE", "BTL"].includes(u)) return "BTL";
  if (["M", "MTR", "METRE"].includes(u)) return "MTR";
  return "NOS";
}
