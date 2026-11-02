/**
 * The shop's other GST documents (billing v2, docs/billing §4.1), next to its
 * counter-sale invoices (sales.ts): each kind in its own series per financial
 * year, never changed after issue (trigger acc_documents_immutable).
 *
 *   CREDIT_NOTE       against a counter-sale invoice: price reduction or goods
 *                     returned (restock: the goods go back into stock); books:
 *                     Sales Return voucher (Dr sales + output GST, Cr the customer
 *                     or cash/bank).
 *   DEBIT_NOTE        against a counter-sale invoice: price increase; books: Dr
 *                     the customer or cash/bank, Cr sales + output GST.
 *   RECEIPT_VOUCHER   an advance received before supply (s.31(3)(d)); books:
 *                     Dr cash/bank, Cr advances from customers + output GST.
 *                     Goods advances carry no GST (Notification 66/2017-CT):
 *                     enter rate 0.
 *   REFUND_VOUCHER    an advance returned (s.31(3)(e)), against its receipt
 *                     voucher; books: the reverse.
 *   DELIVERY_CHALLAN  goods sent without a sale (Rule 55): no tax, no books.
 *   ESTIMATE          a quotation: no tax liability, no books.
 *
 * Cancelling marks the document and reverses its vouchers and stock; the
 * number stays used. Online orders keep their own invoices and credit notes
 * (services/invoices.ts, gst/credit-notes.ts).
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { gstState, isValidGstin, stateLabel } from "@/lib/gst-states";
import { financialYear, grossPaise, invoiceTotals, isInterState, stateOfGstin, taxOnTaxable } from "@/lib/accounts/gst-math";
import { formatPaise } from "@/lib/money";
import { PDF_LINE_WIDTH, textPdf, type PdfLine } from "@/lib/pdf";
import { db } from "@/server/db";
import {
  ACC_DOCUMENT_KINDS,
  accDocuments,
  accSalesInvoices,
  invStockLedger,
  shopProducts,
  shops,
  type AccDocument,
  type AccDocumentKind,
  type AccDocumentLine,
} from "@/server/db/schema";
import { uqcFor } from "@/server/integrations/canonical";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getSettings, logChange, nextNumber, postVoucher, reverseSource, todayIst } from "./books";
import { getParty } from "./parties";
import { postStock } from "./stock";

export const DOCUMENT_PREFIX: Record<AccDocumentKind, string> = {
  CREDIT_NOTE: "CN",
  DEBIT_NOTE: "DN",
  RECEIPT_VOUCHER: "RV",
  REFUND_VOUCHER: "RF",
  DELIVERY_CHALLAN: "DC",
  ESTIMATE: "ES",
};

export const DOCUMENT_TITLE: Record<AccDocumentKind, string> = {
  CREDIT_NOTE: "CREDIT NOTE",
  DEBIT_NOTE: "DEBIT NOTE",
  RECEIPT_VOUCHER: "RECEIPT VOUCHER",
  REFUND_VOUCHER: "REFUND VOUCHER",
  DELIVERY_CHALLAN: "DELIVERY CHALLAN",
  ESTIMATE: "ESTIMATE / QUOTATION",
};

/** "DN2627-000001" — kind, financial year (2026-27 → 2627), six digits: 13 characters. */
export function documentNumber(kind: AccDocumentKind, fy: string, sequence: number): string {
  return `${DOCUMENT_PREFIX[kind]}${fy.slice(2, 4)}${fy.slice(5, 7)}-${String(sequence).padStart(6, "0")}`;
}

const paise = z.number().int().min(0);

export const documentSchema = z.object({
  kind: z.enum(ACC_DOCUMENT_KINDS),
  partyId: z.string().uuid().nullable().optional(),
  buyerName: z.string().trim().max(160).nullable().optional(),
  buyerGstin: z.string().trim().toUpperCase().max(15).nullable().optional(),
  /** Two-digit state code; credit / debit notes take their invoice's. */
  placeOfSupply: z.string().regex(/^\d{2}$/).nullable().optional(),
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  againstSalesId: z.string().uuid().nullable().optional(),
  againstDocumentId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().max(300).nullable().optional(),
  restock: z.boolean().optional(),
  paymentMode: z.enum(["CASH", "BANK", "UPI", "CARD", "CREDIT"]).nullable().optional(),
  pricesIncludeTax: z.boolean().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  lines: z
    .array(
      z.object({
        shopProductId: z.string().uuid().nullable().optional(),
        description: z.string().trim().min(1).max(200),
        hsn: z.string().trim().max(8).nullable().optional(),
        qtyMilli: z.number().int().positive(),
        unit: z.string().trim().max(20).nullable().optional(),
        ratePaise: paise,
        gstRateBp: z.number().int().min(0).max(10_000),
      }),
    )
    .min(1)
    .max(200),
});
export type DocumentInput = z.infer<typeof documentSchema>;

const cashSide = (mode: string | null | undefined) => (mode === "CASH" ? "CASH" : mode === "CREDIT" ? "PARTY" : "BANK");

export async function createDocument(shopId: string, raw: DocumentInput, actor: { id: string }): Promise<AccDocument> {
  const input = documentSchema.parse(raw);
  const date = input.docDate ?? todayIst();
  if (date > todayIst()) throw validationFailed("The document date is in the future.");
  const buyerGstinRaw = input.buyerGstin?.replace(/\s+/g, "") || null;
  if (buyerGstinRaw && !isValidGstin(buyerGstinRaw)) throw validationFailed("Buyer GSTIN is not valid.");
  const kind = input.kind;
  const needsInvoice = kind === "CREDIT_NOTE" || kind === "DEBIT_NOTE";
  if (needsInvoice && !input.againstSalesId) throw validationFailed("Choose the invoice this note amends.");
  if (kind === "REFUND_VOUCHER" && !input.againstDocumentId) throw validationFailed("Choose the receipt voucher whose advance is refunded.");
  if (kind !== "CREDIT_NOTE" && input.restock) throw validationFailed("Only a credit note brings goods back into stock.");

  return db.transaction(async (tx) => {
    const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId));
    if (!shop) throw notFound("Shop");
    const sellerState = stateOfGstin(shop.gstin) ?? gstState(shop.state)?.code ?? null;
    if (!sellerState) throw validationFailed("Add your shop's GSTIN (or state) before issuing GST documents.");

    let partyId = input.partyId ?? null;
    let buyerName = input.buyerName ?? null;
    let buyerGstin = buyerGstinRaw;
    let pos = input.placeOfSupply ?? null;
    let paymentMode = input.paymentMode ?? null;
    let against: typeof accSalesInvoices.$inferSelect | null = null;
    if (needsInvoice) {
      [against] = await tx
        .select()
        .from(accSalesInvoices)
        .where(and(eq(accSalesInvoices.id, input.againstSalesId!), eq(accSalesInvoices.shopId, shopId)))
        .for("update");
      if (!against) throw notFound("Invoice");
      if (against.status !== "ISSUED") throw conflict("That invoice is cancelled.");
      partyId = partyId ?? against.partyId;
      buyerName = buyerName ?? against.buyerName;
      buyerGstin = buyerGstin ?? against.buyerGstin;
      pos = against.placeOfSupply;
      paymentMode = paymentMode ?? against.paymentMode;
    }
    let receipt: AccDocument | null = null;
    if (kind === "REFUND_VOUCHER") {
      [receipt] = await tx
        .select()
        .from(accDocuments)
        .where(and(eq(accDocuments.id, input.againstDocumentId!), eq(accDocuments.shopId, shopId), eq(accDocuments.kind, "RECEIPT_VOUCHER")))
        .for("update");
      if (!receipt) throw notFound("Receipt voucher");
      if (receipt.status !== "ISSUED") throw conflict("That receipt voucher is cancelled.");
      partyId = partyId ?? receipt.partyId;
      buyerName = buyerName ?? receipt.buyerName;
      buyerGstin = buyerGstin ?? receipt.buyerGstin;
      pos = receipt.placeOfSupply;
    }
    if (partyId) {
      const party = await getParty(shopId, partyId, tx);
      buyerName = buyerName ?? party.name;
      buyerGstin = buyerGstin ?? party.gstin;
    }
    pos = pos ?? stateOfGstin(buyerGstin) ?? sellerState;
    const inter = isInterState(sellerState, pos);
    if ((paymentMode === "CREDIT" || needsInvoice) && cashSide(paymentMode) === "PARTY" && !partyId) {
      throw validationFailed("A credit note or debit note on credit needs the customer (party).");
    }

    // Listings named on the lines must be this shop's.
    const listingIds = input.lines.map((l) => l.shopProductId).filter(Boolean) as string[];
    if (listingIds.length) {
      const own = await tx.select({ id: shopProducts.id }).from(shopProducts).where(and(eq(shopProducts.shopId, shopId), inArray(shopProducts.id, listingIds)));
      const mine = new Set(own.map((o) => o.id));
      if (listingIds.some((id) => !mine.has(id))) throw validationFailed("A product on this document is not in your shop.");
    }

    const lines: AccDocumentLine[] = input.lines.map((l) => {
      let taxable = grossPaise(l.qtyMilli, l.ratePaise);
      if (input.pricesIncludeTax) taxable = Math.round((taxable * 10_000) / (10_000 + l.gstRateBp));
      // A challan or estimate shows the tax a sale would carry, but charges none.
      const t = taxOnTaxable(taxable, l.gstRateBp, inter);
      return {
        shopProductId: l.shopProductId ?? null,
        description: l.description,
        hsn: l.hsn ?? null,
        qtyMilli: l.qtyMilli,
        unit: l.unit ?? null,
        uqc: uqcFor(l.unit ?? ""),
        ratePaise: input.pricesIncludeTax ? Math.round((l.ratePaise * 10_000) / (10_000 + l.gstRateBp)) : l.ratePaise,
        taxablePaise: t.taxablePaise,
        gstRateBp: l.gstRateBp,
        cgstPaise: t.cgstPaise,
        sgstPaise: t.sgstPaise,
        igstPaise: t.igstPaise,
        cessPaise: t.cessPaise,
        totalPaise: t.totalPaise,
      };
    });
    const totals = invoiceTotals(lines);

    // A credit note never takes back more than the invoice; a refund never more than the advance.
    if (kind === "CREDIT_NOTE") {
      const [{ credited }] = await tx
        .select({ credited: sql<number>`coalesce(sum(${accDocuments.totalPaise}), 0)::bigint` })
        .from(accDocuments)
        .where(and(eq(accDocuments.againstSalesId, against!.id), eq(accDocuments.kind, "CREDIT_NOTE"), eq(accDocuments.status, "ISSUED")));
      if (Number(credited) + totals.totalPaise > against!.totalPaise) {
        throw validationFailed(`Credit notes on ${against!.invoiceNo} would exceed the invoice (${formatPaise(against!.totalPaise)}; already credited ${formatPaise(Number(credited))}).`);
      }
    }
    if (kind === "REFUND_VOUCHER") {
      const [{ refunded }] = await tx
        .select({ refunded: sql<number>`coalesce(sum(${accDocuments.totalPaise}), 0)::bigint` })
        .from(accDocuments)
        .where(and(eq(accDocuments.againstDocumentId, receipt!.id), eq(accDocuments.kind, "REFUND_VOUCHER"), eq(accDocuments.status, "ISSUED")));
      if (Number(refunded) + totals.totalPaise > receipt!.totalPaise) throw validationFailed("The refund is more than what is left of the advance.");
    }

    const fy = financialYear(date);
    const sequence = await nextNumber(shopId, kind, fy, tx);
    const docNo = documentNumber(kind, fy, sequence);
    const [doc] = await tx
      .insert(accDocuments)
      .values({
        shopId,
        kind,
        docNo,
        fy,
        sequence,
        docDate: date,
        partyId,
        buyerName,
        buyerGstin,
        placeOfSupply: pos,
        sellerStateCode: sellerState,
        interState: inter,
        againstSalesId: against?.id ?? null,
        againstDocumentId: receipt?.id ?? null,
        reason: input.reason ?? null,
        restock: Boolean(input.restock),
        paymentMode,
        taxablePaise: totals.taxablePaise,
        cgstPaise: totals.cgstPaise,
        sgstPaise: totals.sgstPaise,
        igstPaise: totals.igstPaise,
        cessPaise: totals.cessPaise,
        totalPaise: totals.taxablePaise + totals.cgstPaise + totals.sgstPaise + totals.igstPaise + totals.cessPaise,
        lines,
        note: input.note ?? null,
        createdBy: actor.id,
      })
      .returning();

    const side = cashSide(paymentMode);
    const tax = [
      { account: "GST_OUTPUT_CGST" as const, amount: doc.cgstPaise },
      { account: "GST_OUTPUT_SGST" as const, amount: doc.sgstPaise },
      { account: "GST_OUTPUT_IGST" as const, amount: doc.igstPaise },
      { account: "GST_OUTPUT_CESS" as const, amount: doc.cessPaise },
    ];
    const base = { shopId, entryDate: date, sourceType: "SHOP_DOCUMENT" as const, sourceId: doc.id, docRef: docNo, createdBy: actor.id };
    if (kind === "CREDIT_NOTE") {
      await postVoucher(
        {
          ...base,
          voucherType: "SALES_RETURN",
          narration: `Credit note ${docNo} on ${against!.invoiceNo}${input.reason ? `: ${input.reason}` : ""}`,
          legs: [
            { account: "SALES", debitPaise: doc.taxablePaise },
            ...tax.map((t) => ({ account: t.account, debitPaise: t.amount })),
            { account: side, partyId: side === "PARTY" ? partyId : null, creditPaise: doc.totalPaise },
          ],
        },
        tx,
      );
      if (doc.restock) {
        const settings = await getSettings(shopId, tx);
        const postings = [];
        for (const l of lines) {
          if (!l.shopProductId) continue;
          // Back to the count the sale took it from.
          const [sold] = await tx
            .select({ channel: invStockLedger.channel })
            .from(invStockLedger)
            .where(and(eq(invStockLedger.sourceType, "SALES_INVOICE"), eq(invStockLedger.sourceId, against!.id), eq(invStockLedger.shopProductId, l.shopProductId)))
            .limit(1);
          postings.push({
            shopId,
            shopProductId: l.shopProductId,
            channel: sold?.channel ?? (settings.purchaseChannel === "ONLINE" ? ("OFFLINE" as const) : ("ONLINE" as const)),
            movementType: "SALE_RETURN" as const,
            qtyMilli: l.qtyMilli,
            unitPricePaise: l.ratePaise,
            sourceType: "SHOP_DOCUMENT" as const,
            sourceId: doc.id,
            docRef: docNo,
            entryDate: date,
            createdBy: actor.id,
          });
        }
        await postStock(postings, tx);
      }
    } else if (kind === "DEBIT_NOTE") {
      await postVoucher(
        {
          ...base,
          voucherType: "DEBIT_NOTE",
          narration: `Debit note ${docNo} on ${against!.invoiceNo}${input.reason ? `: ${input.reason}` : ""}`,
          legs: [
            { account: side, partyId: side === "PARTY" ? partyId : null, debitPaise: doc.totalPaise },
            { account: "SALES", creditPaise: doc.taxablePaise },
            ...tax.map((t) => ({ account: t.account, creditPaise: t.amount })),
          ],
        },
        tx,
      );
    } else if (kind === "RECEIPT_VOUCHER" || kind === "REFUND_VOUCHER") {
      const money = side === "PARTY" ? "BANK" : side;
      const sign = kind === "RECEIPT_VOUCHER" ? 1 : -1;
      await postVoucher(
        {
          ...base,
          voucherType: kind === "RECEIPT_VOUCHER" ? "RECEIPT" : "PAYMENT",
          narration: `${kind === "RECEIPT_VOUCHER" ? "Advance received" : "Advance refunded"} ${docNo}${buyerName ? ` (${buyerName})` : ""}`,
          legs: [
            { account: money, debitPaise: sign * doc.totalPaise },
            { account: "ADVANCES_RECEIVED", partyId, creditPaise: sign * doc.taxablePaise },
            ...tax.map((t) => ({ account: t.account, creditPaise: sign * t.amount })),
          ],
        },
        tx,
      );
    }
    await logChange({ shopId, entityType: "shop_document", entityId: doc.id, action: "ISSUE", snapshot: { kind, docNo, totalPaise: doc.totalPaise }, actorId: actor.id }, tx);
    await recordAudit({ actorId: actor.id, action: AUDIT_ACTIONS.SHOP_DOCUMENT_ISSUED, entityType: "acc_document", entityId: doc.id, newValue: { shopId, kind, docNo, totalPaise: doc.totalPaise } }, tx);
    return doc;
  });
}

export async function cancelDocument(shopId: string, documentId: string, reason: string, actor: { id: string }): Promise<AccDocument> {
  const why = reason.trim();
  if (!why) throw validationFailed("Say why the document is cancelled.");
  return db.transaction(async (tx) => {
    const [doc] = await tx.select().from(accDocuments).where(and(eq(accDocuments.id, documentId), eq(accDocuments.shopId, shopId))).for("update");
    if (!doc) throw notFound("Document");
    if (doc.status === "CANCELLED") throw conflict("This document is already cancelled.");
    if (doc.kind === "RECEIPT_VOUCHER") {
      const [refund] = await tx
        .select({ id: accDocuments.id })
        .from(accDocuments)
        .where(and(eq(accDocuments.againstDocumentId, doc.id), eq(accDocuments.status, "ISSUED")))
        .limit(1);
      if (refund) throw conflict("A refund voucher was issued against this advance: cancel the refund first.");
    }
    const stock = await tx.select().from(invStockLedger).where(and(eq(invStockLedger.sourceType, "SHOP_DOCUMENT"), eq(invStockLedger.sourceId, doc.id)));
    await postStock(
      stock
        .filter((r) => r.movementType !== "REVERSAL")
        .map((r) => ({ shopId, shopProductId: r.shopProductId, channel: r.channel, movementType: "REVERSAL" as const, qtyMilli: -r.qtyMilli, unitPricePaise: r.unitPricePaise, sourceType: "SHOP_DOCUMENT" as const, sourceId: doc.id, docRef: doc.docNo, reversesId: r.id, note: `Cancelled: ${why}`, createdBy: actor.id })),
      tx,
    );
    await reverseSource(shopId, "SHOP_DOCUMENT", doc.id, todayIst(), actor.id, `${doc.docNo} cancelled: ${why}`, tx);
    const [updated] = await tx.update(accDocuments).set({ status: "CANCELLED", cancelReason: why, cancelledAt: new Date() }).where(eq(accDocuments.id, doc.id)).returning();
    await logChange({ shopId, entityType: "shop_document", entityId: doc.id, action: "CANCEL", changes: [{ field: "status", old: "ISSUED", new: "CANCELLED" }], reason: why, actorId: actor.id }, tx);
    await recordAudit({ actorId: actor.id, action: AUDIT_ACTIONS.SHOP_DOCUMENT_CANCELLED, entityType: "acc_document", entityId: doc.id, newValue: { docNo: doc.docNo, reason: why } }, tx);
    return updated;
  });
}

export async function listDocuments(shopId: string, options: { kind?: AccDocumentKind; from?: string; to?: string } = {}): Promise<AccDocument[]> {
  const where = [eq(accDocuments.shopId, shopId)];
  if (options.kind) where.push(eq(accDocuments.kind, options.kind));
  if (options.from) where.push(gte(accDocuments.docDate, options.from));
  if (options.to) where.push(lt(accDocuments.docDate, options.to));
  return db.select().from(accDocuments).where(and(...where)).orderBy(desc(accDocuments.docDate), desc(accDocuments.createdAt)).limit(500);
}

export async function getDocument(shopId: string, documentId: string): Promise<AccDocument> {
  const [doc] = await db.select().from(accDocuments).where(and(eq(accDocuments.id, documentId), eq(accDocuments.shopId, shopId)));
  if (!doc) throw notFound("Document");
  return doc;
}

/* ------------------------------------------------------------------- PDF */

const money = (p: number) => formatPaise(p).replace("₹", "Rs. ");

export function documentTextLines(doc: AccDocument, shop: { name: string; legalName: string; address: string; gstin: string | null }, againstNo: string | null): PdfLine[] {
  const W = PDF_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (l: string, r: string) => add(l + r.padStart(Math.max(1, W - l.length)));
  add(`${DOCUMENT_TITLE[doc.kind]}${doc.status === "CANCELLED" ? " (CANCELLED)" : ""}`, true);
  pair(`No: ${doc.docNo}`, `Date: ${doc.docDate}`);
  if (againstNo) add(`Against: ${againstNo}`);
  add("-".repeat(W));
  add(shop.legalName, true);
  add(shop.address.slice(0, W));
  add(shop.gstin ? `GSTIN: ${shop.gstin}` : "Not GST-registered");
  add();
  add("TO", true);
  add(doc.buyerName ?? "-");
  if (doc.buyerGstin) add(`GSTIN: ${doc.buyerGstin}`);
  add(`Place of supply: ${stateLabel(doc.placeOfSupply) ?? doc.placeOfSupply}`);
  add("-".repeat(W));
  add(`${"#".padEnd(3)}${"Item".padEnd(34)}${"HSN".padEnd(9)}${"Qty".padEnd(12)}${"GST".padStart(6)}${"Taxable".padStart(13)}${"Total".padStart(13)}`.slice(0, W), true);
  doc.lines.forEach((l, i) => {
    const qty = `${l.qtyMilli / 1000}${l.uqc ? ` ${l.uqc}` : ""}`;
    add(`${String(i + 1).padEnd(3)}${l.description.slice(0, 33).padEnd(34)}${(l.hsn ?? "-").padEnd(9)}${qty.slice(0, 11).padEnd(12)}${`${l.gstRateBp / 100}%`.padStart(6)}${money(l.taxablePaise).padStart(13)}${money(l.totalPaise).padStart(13)}`.slice(0, W));
  });
  add("-".repeat(W));
  pair("Taxable value", money(doc.taxablePaise));
  if (doc.interState) pair("IGST", money(doc.igstPaise));
  else {
    pair("CGST", money(doc.cgstPaise));
    pair("SGST", money(doc.sgstPaise));
  }
  if (doc.cessPaise) pair("Cess", money(doc.cessPaise));
  pair("Total", money(doc.totalPaise));
  if (doc.kind === "DELIVERY_CHALLAN") add("Delivery challan (Rule 55): not a tax invoice; no tax is charged on this document.");
  if (doc.kind === "ESTIMATE") add("Estimate / quotation: not a tax invoice.");
  if (doc.reason) add(`Reason: ${doc.reason}`.slice(0, W));
  if (doc.status === "CANCELLED") add(`Cancelled: ${doc.cancelReason ?? ""}`.slice(0, W));
  add();
  add(`For ${shop.legalName}`);
  add("Authorised signatory");
  return out;
}

export async function documentPdf(shopId: string, documentId: string): Promise<{ bytes: Buffer; filename: string }> {
  const doc = await getDocument(shopId, documentId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  const againstNo = doc.againstSalesId
    ? ((await db.select({ no: accSalesInvoices.invoiceNo }).from(accSalesInvoices).where(eq(accSalesInvoices.id, doc.againstSalesId)))[0]?.no ?? null)
    : doc.againstDocumentId
      ? ((await db.select({ no: accDocuments.docNo }).from(accDocuments).where(eq(accDocuments.id, doc.againstDocumentId)))[0]?.no ?? null)
      : null;
  const lines = documentTextLines(
    doc,
    {
      name: shop.name,
      legalName: shop.legalBusinessName ?? shop.name,
      address: [shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.state, shop.pincode].filter(Boolean).join(", "),
      gstin: shop.gstin,
    },
    againstNo,
  );
  return { bytes: textPdf(lines, { title: `${DOCUMENT_TITLE[doc.kind]} ${doc.docNo}` }), filename: `${doc.docNo}.pdf` };
}
