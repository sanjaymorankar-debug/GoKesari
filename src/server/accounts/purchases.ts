/**
 * The purchase register (docs/inventory-accounting-2026-10, Parts 2 and 6).
 *
 * confirmPurchase is the single transaction behind "Confirm" on the review
 * screen: supplier party, purchase + lines, stock in at cost (with batches),
 * last purchase rate, the books voucher (Dr purchases + input GST / Cr
 * supplier), the ITC record, the supplier-specific product mappings and the
 * change log — all or nothing. Nothing touches stock before it.
 *
 * correctPurchase (reopen → save) never overwrites: it posts REVERSAL rows
 * for the stock and a reversing voucher for the books, supersedes the ITC
 * record, then posts the corrected version as new rows, and records every
 * field that changed (old → new) with who and when.
 */
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, isUniqueViolation, notFound, validationFailed } from "@/lib/errors";
import { isValidGstin } from "@/lib/gst-states";
import { grossPaise, invoiceTotals, isInterState, stateOfGstin, taxOnTaxable, type LineTax } from "@/lib/accounts/gst-math";
import { itemKey, supplierKey as makeSupplierKey } from "@/lib/accounts/text-match";
import { normaliseUnit, toStockQtyMilli } from "@/lib/accounts/units";
import type { ExtractionEngine } from "@/lib/accounts/constants";
import { db, type DbClient } from "@/server/db";
import {
  accPurchaseInvoices,
  accPurchaseLines,
  gstItcRecords,
  invBatches,
  invBillCaptures,
  invProductSettings,
  invStockLedger,
  invSupplierItemMaps,
  invUnitConversions,
  products,
  shopProducts,
  shops,
  type AccPurchaseInvoice,
  type AccPurchaseLine,
  type UserRole,
} from "@/server/db/schema";
import { createProductForShop, createShopProduct } from "@/server/services/catalogue";
import { addCategoryToShop } from "@/server/services/product-categories";
import { getSettings, logChange, postVoucher, reverseSource, todayIst } from "./books";
import { findOrCreateSupplier } from "./parties";
import { postStock, type StockPosting } from "./stock";
import { upsertRow } from "@/server/db/split/upsert";

const paise = z.number().int().min(0);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const purchaseLineSchema = z.object({
  shopProductId: z.string().uuid().nullable().optional(),
  createNew: z
    .object({
      name: z.string().trim().min(2).max(160),
      unit: z.string().trim().min(1).max(20),
      unitSizeMilli: z.number().int().positive().max(1_000_000_000).optional(),
      hsn: z.string().trim().max(8).nullable().optional(),
      gstRateBp: z.number().int().min(0).max(10_000).nullable().optional(),
      mrpPaise: paise.nullable().optional(),
      sellingPricePaise: paise.nullable().optional(),
      barcode: z.string().trim().max(20).nullable().optional(),
    })
    .nullable()
    .optional(),
  description: z.string().trim().min(1).max(300),
  hsn: z.string().trim().max(8).nullable().optional(),
  supplierItemCode: z.string().trim().max(60).nullable().optional(),
  qtyMilli: z.number().int().positive(),
  unit: z.string().trim().max(20).nullable().optional(),
  /** Overrides the unit conversion: sellable units ×1000 this line adds. */
  stockQtyMilli: z.number().int().positive().nullable().optional(),
  /** Save "1 <unit> = n sellable units" for this product. */
  saveConversionMilliPerUnit: z.number().int().positive().nullable().optional(),
  ratePaise: paise,
  discountPaise: paise.optional(),
  /** The bill's own taxable value for the line (bills round per line). */
  taxablePaise: paise.nullable().optional(),
  gstRateBp: z.number().int().min(0).max(10_000),
  cessBp: z.number().int().min(0).max(100_000).optional(),
  batchNo: z.string().trim().max(40).nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  mfgDate: isoDate.nullable().optional(),
  mrpPaise: paise.nullable().optional(),
});

export const purchaseSchema = z.object({
  supplier: z.object({
    partyId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(2).max(160),
    gstin: z.string().trim().toUpperCase().max(15).nullable().optional(),
  }),
  invoiceNo: z.string().trim().min(1).max(40),
  invoiceDate: isoDate,
  dueDate: isoDate.nullable().optional(),
  placeOfSupply: z.string().regex(/^\d{2}$/).nullable().optional(),
  reverseCharge: z.boolean().optional(),
  irn: z.string().trim().max(64).nullable().optional(),
  itcEligible: z.boolean().optional(),
  otherChargesPaise: z.number().int().optional(),
  roundOffPaise: z.number().int().min(-10_000).max(10_000).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  lines: z.array(purchaseLineSchema).min(1).max(300),
});
export type PurchaseInput = z.infer<typeof purchaseSchema>;

export interface PurchaseMeta {
  captureId?: string | null;
  fileIds?: string[];
  engine?: ExtractionEngine;
}

export type PurchaseActor = { id: string; role: UserRole };

interface ResolvedLine {
  input: z.infer<typeof purchaseLineSchema>;
  shopProductId: string;
  stockQtyMilli: number;
  tax: LineTax;
}

/* ---------------------------------------------------------------- helpers */

async function shopState(shopId: string, client: DbClient): Promise<string | null> {
  const [shop] = await client.select({ gstin: shops.gstin, state: shops.state }).from(shops).where(eq(shops.id, shopId));
  return stateOfGstin(shop?.gstin) ?? null;
}

/** A new product from a bill line: the master product with this barcode if there is one, else the shop's own new product. */
async function createListingForLine(shopId: string, line: z.infer<typeof purchaseLineSchema>, actor: PurchaseActor, client: DbClient): Promise<string> {
  const spec = line.createNew!;
  const barcode = spec.barcode?.replace(/\D/g, "") || null;
  if (barcode) {
    const [master] = await client
      .select()
      .from(products)
      .where(and(isNull(products.deletedAt), sql`(${products.gtin} = ${barcode} OR ${products.barcode} = ${barcode})`))
      .limit(1);
    if (master) {
      const [already] = await client.select({ id: shopProducts.id }).from(shopProducts).where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, master.id)));
      if (already) return already.id;
      await addCategoryToShop(shopId, master.categoryId, actor, { reason: "purchase_bill", fillInventory: false }, client);
      const sp = await createShopProduct({ shopId, productId: master.id, onlineSaleEnabled: false, offlineSaleEnabled: false }, actor as { id: string; role: "SHOP_OWNER" }, client);
      return sp.id;
    }
  }
  const created = await createProductForShop(
    { shopId, name: spec.name, unit: spec.unit, unitSizeMilli: spec.unitSizeMilli ?? 1000, onlineSaleEnabled: false, offlineSaleEnabled: false, confirmDuplicate: true },
    actor,
    false,
    client,
  );
  // The shop's own tax classification of the item, from the bill.
  await client
    .update(shopProducts)
    .set({ hsnCode: spec.hsn ?? line.hsn ?? null, gstRateBp: spec.gstRateBp ?? line.gstRateBp, updatedAt: new Date() })
    .where(eq(shopProducts.id, created.shopProduct.id));
  if (!created.reusedExisting && (barcode || spec.mrpPaise != null)) {
    await client
      .update(products)
      .set({ barcode: barcode ?? undefined, mrpPaise: spec.mrpPaise ?? undefined, mrpSource: spec.mrpPaise != null ? "SELLER_SUBMITTED" : undefined, hsnCode: spec.hsn ?? line.hsn ?? undefined, gstRateBp: spec.gstRateBp ?? line.gstRateBp })
      .where(eq(products.id, created.product.id));
  }
  return created.shopProduct.id;
}

async function resolveLines(shopId: string, input: PurchaseInput, interState: boolean, actor: PurchaseActor, client: DbClient): Promise<ResolvedLine[]> {
  const out: ResolvedLine[] = [];
  for (const [i, line] of input.lines.entries()) {
    let shopProductId = line.shopProductId ?? null;
    if (!shopProductId) {
      if (!line.createNew) throw validationFailed(`Line ${i + 1}: choose the product, or create a new one.`);
      shopProductId = await createListingForLine(shopId, line, actor, client);
    }
    const [listing] = await client
      .select({ shopId: shopProducts.shopId, unit: products.unit, unitSizeMilli: products.unitSizeMilli })
      .from(shopProducts)
      .innerJoin(products, eq(shopProducts.productId, products.id))
      .where(eq(shopProducts.id, shopProductId));
    if (!listing || listing.shopId !== shopId) throw validationFailed(`Line ${i + 1}: that product is not in your shop.`);
    let stockQtyMilli = line.stockQtyMilli ?? null;
    if (stockQtyMilli == null) {
      const unit = normaliseUnit(line.unit);
      const saved = line.saveConversionMilliPerUnit ?? (unit ? await savedConversion(shopId, shopProductId, unit, client) : null);
      const conv = toStockQtyMilli(line.qtyMilli, line.unit, { unit: listing.unit, unitSizeMilli: listing.unitSizeMilli }, saved);
      if (!conv.ok) throw validationFailed(`Line ${i + 1}: ${conv.message}`);
      stockQtyMilli = conv.stockQtyMilli;
    }
    if (stockQtyMilli <= 0) throw validationFailed(`Line ${i + 1}: the quantity converts to no stock.`);
    if (line.saveConversionMilliPerUnit && line.unit) {
      const unit = normaliseUnit(line.unit)!;
      await client
        .insert(invUnitConversions)
        .values({ shopId, shopProductId, unit, milliPerUnit: line.saveConversionMilliPerUnit })
        .onConflictDoNothing();
      await client
        .update(invUnitConversions)
        .set({ milliPerUnit: line.saveConversionMilliPerUnit })
        .where(and(eq(invUnitConversions.shopId, shopId), eq(invUnitConversions.shopProductId, shopProductId), eq(invUnitConversions.unit, unit)));
    }
    const gross = grossPaise(line.qtyMilli, line.ratePaise);
    const discount = line.discountPaise ?? 0;
    const taxable = line.taxablePaise ?? gross - discount;
    if (taxable < 0) throw validationFailed(`Line ${i + 1}: the discount is more than the amount.`);
    const tax = taxOnTaxable(taxable, line.gstRateBp, interState, line.cessBp ?? 0, { gross, discount });
    out.push({ input: line, shopProductId, stockQtyMilli, tax });
  }
  return out;
}

async function savedConversion(shopId: string, shopProductId: string, unit: string, client: DbClient): Promise<number | null> {
  const rows = await client
    .select()
    .from(invUnitConversions)
    .where(and(eq(invUnitConversions.shopId, shopId), eq(invUnitConversions.unit, unit), sql`(${invUnitConversions.shopProductId} = ${shopProductId} OR ${invUnitConversions.shopProductId} IS NULL)`));
  return (rows.find((r) => r.shopProductId === shopProductId) ?? rows[0])?.milliPerUnit ?? null;
}

async function assertNotDuplicate(shopId: string, key: string, invoiceNo: string, exceptId: string | null, client: DbClient): Promise<void> {
  const [dup] = await client
    .select({ id: accPurchaseInvoices.id, invoiceDate: accPurchaseInvoices.invoiceDate })
    .from(accPurchaseInvoices)
    .where(
      and(
        eq(accPurchaseInvoices.shopId, shopId),
        eq(accPurchaseInvoices.supplierKey, key),
        sql`upper(${accPurchaseInvoices.invoiceNo}) = upper(${invoiceNo})`,
        eq(accPurchaseInvoices.status, "CONFIRMED"),
        exceptId ? ne(accPurchaseInvoices.id, exceptId) : undefined,
      ),
    );
  if (dup) throw conflict(`This bill is already in your books: invoice ${invoiceNo} from this supplier, dated ${dup.invoiceDate}.`, { duplicateOf: dup.id });
}

/** Is there already a confirmed bill with this supplier + number? (for the review screen). */
export async function findDuplicate(shopId: string, gstin: string | null, name: string | null, invoiceNo: string | null): Promise<{ id: string; invoiceDate: string } | null> {
  if (!invoiceNo) return null;
  const key = makeSupplierKey(gstin, name);
  const [dup] = await db
    .select({ id: accPurchaseInvoices.id, invoiceDate: accPurchaseInvoices.invoiceDate })
    .from(accPurchaseInvoices)
    .where(and(eq(accPurchaseInvoices.shopId, shopId), eq(accPurchaseInvoices.supplierKey, key), sql`upper(${accPurchaseInvoices.invoiceNo}) = upper(${invoiceNo})`, eq(accPurchaseInvoices.status, "CONFIRMED")));
  return dup ?? null;
}

/**
 * Posts a purchase version: header values already on `purchase`, lines given.
 * Writes lines, batches, stock, last rate, the voucher, the ITC record, mappings.
 */
async function postVersion(purchase: AccPurchaseInvoice, lines: ResolvedLine[], actor: PurchaseActor, client: DbClient): Promise<AccPurchaseLine[]> {
  const settings = await getSettings(purchase.shopId, client);
  const inserted = await client
    .insert(accPurchaseLines)
    .values(
      lines.map((l, i) => ({
        purchaseId: purchase.id,
        shopId: purchase.shopId,
        lineNo: i + 1,
        shopProductId: l.shopProductId,
        description: l.input.description,
        hsn: l.input.hsn ?? null,
        qtyMilli: l.input.qtyMilli,
        unit: l.input.unit ?? null,
        stockQtyMilli: l.stockQtyMilli,
        ratePaise: l.input.ratePaise,
        discountPaise: l.tax.discountPaise,
        taxablePaise: l.tax.taxablePaise,
        gstRateBp: l.input.gstRateBp,
        cgstPaise: l.tax.cgstPaise,
        sgstPaise: l.tax.sgstPaise,
        igstPaise: l.tax.igstPaise,
        cessPaise: l.tax.cessPaise,
        totalPaise: l.tax.totalPaise,
        batchNo: l.input.batchNo ?? null,
        expiryDate: l.input.expiryDate ?? null,
        mrpPaise: l.input.mrpPaise ?? null,
      })),
    )
    .returning();

  // Stock in, at cost. Tax the shop can claim back is not cost; tax it cannot claim is.
  const postings: StockPosting[] = [];
  const otherCharges = purchase.otherChargesPaise;
  const taxableSum = lines.reduce((n, l) => n + l.tax.taxablePaise, 0) || 1;
  for (const [i, l] of lines.entries()) {
    let batchId: string | null = null;
    if (l.input.batchNo) {
      const batch = await upsertRow(client, invBatches, {
        keys: [invBatches.shopProductId, invBatches.batchNo],
        values: { shopId: purchase.shopId, shopProductId: l.shopProductId, batchNo: l.input.batchNo, expiryDate: l.input.expiryDate ?? null, mfgDate: l.input.mfgDate ?? null, mrpPaise: l.input.mrpPaise ?? null },
        set: { expiryDate: sql`coalesce(${l.input.expiryDate ?? null}::date, ${invBatches.expiryDate})`, mrpPaise: sql`coalesce(${l.input.mrpPaise ?? null}::bigint, ${invBatches.mrpPaise})` },
      });
      batchId = batch.id;
      await upsertRow(client, invProductSettings, {
        keys: [invProductSettings.shopProductId],
        values: { shopProductId: l.shopProductId, shopId: purchase.shopId, trackBatches: true },
        set: { trackBatches: true },
      });
    }
    const share = Math.round((otherCharges * l.tax.taxablePaise) / taxableSum);
    const cost = l.tax.taxablePaise + share + (purchase.itcEligible ? 0 : l.tax.taxPaise);
    const unitCost = Math.round((cost * 1000) / l.stockQtyMilli);
    postings.push({
      shopId: purchase.shopId,
      shopProductId: l.shopProductId,
      channel: settings.purchaseChannel,
      movementType: "PURCHASE",
      qtyMilli: l.stockQtyMilli,
      unitCostPaise: unitCost,
      batchId,
      sourceType: "PURCHASE_INVOICE",
      sourceId: purchase.id,
      sourceLineId: inserted[i].id,
      docRef: `${purchase.invoiceNo} · ${purchase.supplierName}`.slice(0, 120),
      entryDate: purchase.invoiceDate,
      note: purchase.version > 1 ? `Corrected bill (version ${purchase.version})` : null,
      createdBy: actor.id,
    });
    await upsertRow(client, invProductSettings, {
      keys: [invProductSettings.shopProductId],
      values: { shopProductId: l.shopProductId, shopId: purchase.shopId, lastPurchaseRatePaise: unitCost, lastPurchaseAt: new Date(), lastSupplierId: purchase.partyId },
      set: { lastPurchaseRatePaise: unitCost, lastPurchaseAt: new Date(), lastSupplierId: purchase.partyId, updatedAt: new Date() },
    });
  }
  await postStock(postings, client);

  // Books: Dr purchases (+ input GST) / Cr supplier.
  const itc = purchase.itcEligible;
  const tax = purchase.cgstPaise + purchase.sgstPaise + purchase.igstPaise + purchase.cessPaise;
  await postVoucher(
    {
      shopId: purchase.shopId,
      voucherType: "PURCHASE",
      entryDate: purchase.invoiceDate,
      sourceType: "PURCHASE",
      sourceId: purchase.id,
      docRef: purchase.invoiceNo,
      narration: `Bill ${purchase.invoiceNo} from ${purchase.supplierName}${purchase.version > 1 ? ` (v${purchase.version})` : ""}`,
      createdBy: actor.id,
      legs: [
        { account: "PURCHASES", debitPaise: purchase.taxablePaise + purchase.otherChargesPaise + (itc ? 0 : tax) },
        ...(itc
          ? [
              { account: "GST_INPUT_CGST" as const, debitPaise: purchase.cgstPaise },
              { account: "GST_INPUT_SGST" as const, debitPaise: purchase.sgstPaise },
              { account: "GST_INPUT_IGST" as const, debitPaise: purchase.igstPaise },
              { account: "GST_INPUT_CESS" as const, debitPaise: purchase.cessPaise },
            ]
          : []),
        { account: "ROUND_OFF", debitPaise: purchase.roundOffPaise },
        { account: "PARTY", partyId: purchase.partyId, creditPaise: purchase.totalPaise },
      ],
    },
    client,
  );

  // ITC record: counts towards the GST liability once reconciled with the supplier's filing.
  if (purchase.supplierGstin && tax > 0) {
    await client.insert(gstItcRecords).values({
      shopId: purchase.shopId,
      purchaseInvoiceId: purchase.id,
      purchaseVersion: purchase.version,
      period: purchase.invoiceDate.slice(0, 7),
      supplierGstin: purchase.supplierGstin,
      invoiceNo: purchase.invoiceNo,
      invoiceDate: purchase.invoiceDate,
      taxablePaise: purchase.taxablePaise,
      cgstPaise: purchase.cgstPaise,
      sgstPaise: purchase.sgstPaise,
      igstPaise: purchase.igstPaise,
      cessPaise: purchase.cessPaise,
      status: itc && !purchase.reverseCharge ? "PENDING_RECON" : "INELIGIBLE",
    });
  }

  // Remember what the owner chose for this supplier's line text.
  for (const l of lines) {
    const key = itemKey(l.input.description, l.input.supplierItemCode);
    if (!key) continue;
    const unit = normaliseUnit(l.input.unit);
    await client
      .insert(invSupplierItemMaps)
      .values({ shopId: purchase.shopId, supplierKey: purchase.supplierKey, itemKey: key, shopProductId: l.shopProductId, unit, milliPerUnit: l.input.qtyMilli ? Math.round((l.stockQtyMilli * 1000) / l.input.qtyMilli) : null })
      .onConflictDoUpdate({
        target: [invSupplierItemMaps.shopId, invSupplierItemMaps.supplierKey, invSupplierItemMaps.itemKey],
        set: { shopProductId: l.shopProductId, unit, milliPerUnit: l.input.qtyMilli ? Math.round((l.stockQtyMilli * 1000) / l.input.qtyMilli) : null, timesUsed: sql`${invSupplierItemMaps.timesUsed} + 1`, lastUsedAt: new Date() },
      });
  }
  return inserted;
}

function headerValues(shopId: string, input: PurchaseInput, partyId: string, supplierName: string, shopStateCode: string | null, lines: ResolvedLine[]) {
  const gstin = input.supplier.gstin?.replace(/\s+/g, "").toUpperCase() || null;
  if (gstin && !isValidGstin(gstin)) throw validationFailed("Supplier GSTIN is not valid.");
  const pos = input.placeOfSupply ?? shopStateCode;
  const totals = invoiceTotals(lines.map((l) => l.tax), { otherChargesPaise: input.otherChargesPaise ?? 0, roundOffPaise: input.roundOffPaise ?? undefined });
  if (totals.totalPaise < 0) throw validationFailed("The bill total cannot be negative.");
  return {
    shopId,
    partyId,
    supplierKey: makeSupplierKey(gstin, supplierName),
    supplierGstin: gstin,
    supplierName,
    invoiceNo: input.invoiceNo.trim(),
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate ?? null,
    placeOfSupply: pos,
    interState: isInterState(stateOfGstin(gstin), pos),
    reverseCharge: input.reverseCharge ?? false,
    irn: input.irn ?? null,
    taxablePaise: totals.taxablePaise,
    cgstPaise: totals.cgstPaise,
    sgstPaise: totals.sgstPaise,
    igstPaise: totals.igstPaise,
    cessPaise: totals.cessPaise,
    otherChargesPaise: totals.otherChargesPaise,
    roundOffPaise: totals.roundOffPaise,
    totalPaise: totals.totalPaise,
    itcEligible: Boolean(gstin) && (input.itcEligible ?? true),
    note: input.note ?? null,
  };
}

/* -------------------------------------------------------------- confirm */

export async function confirmPurchase(shopId: string, raw: PurchaseInput, actor: PurchaseActor, meta: PurchaseMeta = {}): Promise<AccPurchaseInvoice> {
  const input = purchaseSchema.parse(raw);
  if (input.invoiceDate > todayIst()) throw validationFailed("The bill date is in the future.");
  try {
    return await db.transaction(async (tx) => {
      if (meta.captureId) {
        const [capture] = await tx.select().from(invBillCaptures).where(and(eq(invBillCaptures.id, meta.captureId), eq(invBillCaptures.shopId, shopId))).for("update");
        if (!capture) throw notFound("Bill");
        if (capture.status === "CONFIRMED") throw conflict("This bill was already confirmed.");
        if (capture.status !== "READY_FOR_REVIEW" && capture.status !== "FAILED") throw conflict("This bill is still being read.");
      }
      const party = await findOrCreateSupplier(shopId, { partyId: input.supplier.partyId, name: input.supplier.name, gstin: input.supplier.gstin ?? null }, actor.id, tx);
      const shopStateCode = await shopState(shopId, tx);
      const gstin = input.supplier.gstin?.replace(/\s+/g, "").toUpperCase() || party.gstin || null;
      const pos = input.placeOfSupply ?? shopStateCode;
      const interState = isInterState(stateOfGstin(gstin), pos);
      const key = makeSupplierKey(gstin, party.name);
      await assertNotDuplicate(shopId, key, input.invoiceNo, null, tx);
      const lines = await resolveLines(shopId, input, interState, actor, tx);
      const header = headerValues(shopId, { ...input, supplier: { ...input.supplier, gstin } }, party.id, party.name, shopStateCode, lines);
      const dueDate = header.dueDate ?? (party.creditDays ? addDays(header.invoiceDate, party.creditDays) : null);
      const [purchase] = await tx
        .insert(accPurchaseInvoices)
        .values({ ...header, dueDate, version: 1, captureId: meta.captureId ?? null, fileIds: meta.fileIds ?? [], engine: meta.engine ?? "MANUAL", createdBy: actor.id, updatedBy: actor.id })
        .returning();
      const inserted = await postVersion(purchase, lines, actor, tx);
      await logChange({ shopId, entityType: "purchase", entityId: purchase.id, action: "CONFIRM", snapshot: snapshotOf(purchase, inserted), actorId: actor.id }, tx);
      if (meta.captureId) {
        await tx
          .update(invBillCaptures)
          .set({ status: "CONFIRMED", purchaseInvoiceId: purchase.id, confirmedBy: actor.id, confirmedAt: new Date(), updatedAt: new Date() })
          .where(eq(invBillCaptures.id, meta.captureId));
      }
      return purchase;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`This bill is already in your books: invoice ${input.invoiceNo} from this supplier.`);
    throw error;
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function snapshotOf(p: AccPurchaseInvoice, lines: AccPurchaseLine[]): Record<string, unknown> {
  return {
    supplierName: p.supplierName,
    supplierGstin: p.supplierGstin,
    invoiceNo: p.invoiceNo,
    invoiceDate: p.invoiceDate,
    placeOfSupply: p.placeOfSupply,
    taxablePaise: p.taxablePaise,
    cgstPaise: p.cgstPaise,
    sgstPaise: p.sgstPaise,
    igstPaise: p.igstPaise,
    cessPaise: p.cessPaise,
    roundOffPaise: p.roundOffPaise,
    totalPaise: p.totalPaise,
    itcEligible: p.itcEligible,
    version: p.version,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      shopProductId: l.shopProductId,
      description: l.description,
      hsn: l.hsn,
      qtyMilli: l.qtyMilli,
      unit: l.unit,
      stockQtyMilli: l.stockQtyMilli,
      ratePaise: l.ratePaise,
      discountPaise: l.discountPaise,
      taxablePaise: l.taxablePaise,
      gstRateBp: l.gstRateBp,
      totalPaise: l.totalPaise,
      batchNo: l.batchNo,
      expiryDate: l.expiryDate,
    })),
  };
}

/** Field-by-field differences between two snapshots (lines compared by position). */
export function diffSnapshots(before: Record<string, unknown>, after: Record<string, unknown>): { field: string; old: unknown; new: unknown }[] {
  const out: { field: string; old: unknown; new: unknown }[] = [];
  for (const k of Object.keys(after)) {
    if (k === "lines" || k === "version") continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push({ field: k, old: before[k] ?? null, new: after[k] ?? null });
  }
  const a = (before.lines as Record<string, unknown>[]) ?? [];
  const b = (after.lines as Record<string, unknown>[]) ?? [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (!a[i]) {
      out.push({ field: `lines[${i + 1}]`, old: null, new: b[i].description });
      continue;
    }
    if (!b[i]) {
      out.push({ field: `lines[${i + 1}]`, old: a[i].description, new: null });
      continue;
    }
    for (const k of Object.keys(b[i])) {
      if (k === "lineNo") continue;
      if (JSON.stringify(a[i][k]) !== JSON.stringify(b[i][k])) out.push({ field: `lines[${i + 1}].${k}`, old: a[i][k] ?? null, new: b[i][k] ?? null });
    }
  }
  return out;
}

/** Undoes a purchase version in stock (REVERSAL rows), books (reversing voucher) and ITC. */
async function reverseVersion(purchase: AccPurchaseInvoice, actor: PurchaseActor, reason: string, client: DbClient): Promise<void> {
  const rows = await client
    .select()
    .from(invStockLedger)
    .where(and(eq(invStockLedger.shopId, purchase.shopId), eq(invStockLedger.sourceType, "PURCHASE_INVOICE"), eq(invStockLedger.sourceId, purchase.id)));
  const reversed = new Set(rows.map((r) => r.reversesId).filter(Boolean));
  const toReverse = rows.filter((r) => r.movementType === "PURCHASE" && !reversed.has(r.id));
  await postStock(
    toReverse.map((r) => ({
      shopId: r.shopId,
      shopProductId: r.shopProductId,
      channel: r.channel,
      movementType: "REVERSAL" as const,
      qtyMilli: -r.qtyMilli,
      unitCostPaise: r.unitCostPaise,
      batchId: r.batchId,
      sourceType: "PURCHASE_INVOICE" as const,
      sourceId: purchase.id,
      sourceLineId: r.sourceLineId,
      docRef: r.docRef,
      reversesId: r.id,
      entryDate: todayIst(),
      note: reason,
      createdBy: actor.id,
    })),
    client,
  );
  await reverseSource(purchase.shopId, "PURCHASE", purchase.id, todayIst(), actor.id, reason, client);
  await client
    .update(gstItcRecords)
    .set({ status: "REVERSED", supersededAt: new Date(), updatedAt: new Date() })
    .where(and(eq(gstItcRecords.purchaseInvoiceId, purchase.id), isNull(gstItcRecords.supersededAt)));
}

/* ----------------------------------------------------------- correction */

export async function correctPurchase(shopId: string, purchaseId: string, raw: PurchaseInput, actor: PurchaseActor, reason: string | null): Promise<AccPurchaseInvoice> {
  const input = purchaseSchema.parse(raw);
  if (input.invoiceDate > todayIst()) throw validationFailed("The bill date is in the future.");
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx.select().from(accPurchaseInvoices).where(and(eq(accPurchaseInvoices.id, purchaseId), eq(accPurchaseInvoices.shopId, shopId))).for("update");
      if (!current) throw notFound("Purchase");
      if (current.status !== "CONFIRMED") throw conflict("A cancelled bill cannot be changed.");
      const oldLines = await tx.select().from(accPurchaseLines).where(eq(accPurchaseLines.purchaseId, purchaseId)).orderBy(accPurchaseLines.lineNo);
      const before = snapshotOf(current, oldLines);

      const party = await findOrCreateSupplier(shopId, { partyId: input.supplier.partyId ?? (input.supplier.gstin === current.supplierGstin || !input.supplier.gstin ? current.partyId : null), name: input.supplier.name, gstin: input.supplier.gstin ?? null }, actor.id, tx);
      const shopStateCode = await shopState(shopId, tx);
      const gstin = input.supplier.gstin?.replace(/\s+/g, "").toUpperCase() || party.gstin || null;
      const pos = input.placeOfSupply ?? shopStateCode;
      const key = makeSupplierKey(gstin, party.name);
      await assertNotDuplicate(shopId, key, input.invoiceNo, purchaseId, tx);

      const why = `Correction of bill ${current.invoiceNo}${reason ? `: ${reason}` : ""}`.slice(0, 300);
      await reverseVersion(current, actor, why, tx);
      await tx.delete(accPurchaseLines).where(eq(accPurchaseLines.purchaseId, purchaseId));

      const lines = await resolveLines(shopId, input, isInterState(stateOfGstin(gstin), pos), actor, tx);
      const header = headerValues(shopId, { ...input, supplier: { ...input.supplier, gstin } }, party.id, party.name, shopStateCode, lines);
      const [updated] = await tx
        .update(accPurchaseInvoices)
        .set({ ...header, dueDate: header.dueDate ?? current.dueDate, version: current.version + 1, updatedBy: actor.id, updatedAt: new Date() })
        .where(eq(accPurchaseInvoices.id, purchaseId))
        .returning();
      const inserted = await postVersion(updated, lines, actor, tx);
      const after = snapshotOf(updated, inserted);
      await logChange({ shopId, entityType: "purchase", entityId: purchaseId, action: "CORRECT", changes: diffSnapshots(before, after), snapshot: { before, after }, reason, actorId: actor.id }, tx);
      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`Another bill ${input.invoiceNo} from this supplier is already in your books.`);
    throw error;
  }
}

export async function cancelPurchase(shopId: string, purchaseId: string, actor: PurchaseActor, reason: string): Promise<void> {
  if (!reason.trim()) throw validationFailed("Say why the bill is cancelled.");
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(accPurchaseInvoices).where(and(eq(accPurchaseInvoices.id, purchaseId), eq(accPurchaseInvoices.shopId, shopId))).for("update");
    if (!current) throw notFound("Purchase");
    if (current.status !== "CONFIRMED") throw conflict("This bill is already cancelled.");
    await reverseVersion(current, actor, `Bill ${current.invoiceNo} cancelled: ${reason}`.slice(0, 300), tx);
    await tx.update(accPurchaseInvoices).set({ status: "CANCELLED", updatedBy: actor.id, updatedAt: new Date() }).where(eq(accPurchaseInvoices.id, purchaseId));
    await logChange({ shopId, entityType: "purchase", entityId: purchaseId, action: "CANCEL", changes: [{ field: "status", old: "CONFIRMED", new: "CANCELLED" }], reason, actorId: actor.id }, tx);
  });
}

/* ---------------------------------------------------------------- reads */

export async function listPurchases(shopId: string, options: { from?: string; to?: string; partyId?: string; limit?: number } = {}) {
  return db
    .select()
    .from(accPurchaseInvoices)
    .where(
      and(
        eq(accPurchaseInvoices.shopId, shopId),
        options.from ? gte(accPurchaseInvoices.invoiceDate, options.from) : undefined,
        options.to ? lt(accPurchaseInvoices.invoiceDate, options.to) : undefined,
        options.partyId ? eq(accPurchaseInvoices.partyId, options.partyId) : undefined,
      ),
    )
    .orderBy(desc(accPurchaseInvoices.invoiceDate), desc(accPurchaseInvoices.createdAt))
    .limit(options.limit ?? 500);
}

export async function getPurchase(shopId: string, purchaseId: string) {
  const [purchase] = await db.select().from(accPurchaseInvoices).where(and(eq(accPurchaseInvoices.id, purchaseId), eq(accPurchaseInvoices.shopId, shopId)));
  if (!purchase) throw notFound("Purchase");
  const [lines, itc] = await Promise.all([
    db
      .select({ l: accPurchaseLines, productName: products.name })
      .from(accPurchaseLines)
      .leftJoin(shopProducts, eq(accPurchaseLines.shopProductId, shopProducts.id))
      .leftJoin(products, eq(shopProducts.productId, products.id))
      .where(eq(accPurchaseLines.purchaseId, purchaseId))
      .orderBy(accPurchaseLines.lineNo),
    db.select().from(gstItcRecords).where(eq(gstItcRecords.purchaseInvoiceId, purchaseId)).orderBy(desc(gstItcRecords.createdAt)),
  ]);
  return { purchase, lines: lines.map((r) => ({ ...r.l, productName: r.productName })), itc };
}

/** The purchase as purchase input, for the reopen (correction) screen. */
export async function purchaseAsInput(shopId: string, purchaseId: string): Promise<PurchaseInput> {
  const { purchase, lines } = await getPurchase(shopId, purchaseId);
  return {
    supplier: { partyId: purchase.partyId, name: purchase.supplierName, gstin: purchase.supplierGstin },
    invoiceNo: purchase.invoiceNo,
    invoiceDate: purchase.invoiceDate,
    dueDate: purchase.dueDate,
    placeOfSupply: purchase.placeOfSupply,
    reverseCharge: purchase.reverseCharge,
    irn: purchase.irn,
    itcEligible: purchase.itcEligible,
    otherChargesPaise: purchase.otherChargesPaise,
    roundOffPaise: purchase.roundOffPaise,
    note: purchase.note,
    lines: lines.map((l) => ({
      shopProductId: l.shopProductId,
      description: l.description,
      hsn: l.hsn,
      qtyMilli: l.qtyMilli,
      unit: l.unit,
      stockQtyMilli: l.stockQtyMilli,
      ratePaise: l.ratePaise,
      discountPaise: l.discountPaise,
      taxablePaise: l.taxablePaise,
      gstRateBp: l.gstRateBp,
      batchNo: l.batchNo,
      expiryDate: l.expiryDate,
      mrpPaise: l.mrpPaise,
    })),
  };
}

export async function purchaseIdsForShop(shopId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: accPurchaseInvoices.id }).from(accPurchaseInvoices).where(and(eq(accPurchaseInvoices.shopId, shopId), inArray(accPurchaseInvoices.id, ids)));
  return rows.map((r) => r.id);
}
