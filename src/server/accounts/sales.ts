/**
 * The shop's own GST sales invoices (docs/inventory-accounting-2026-10, Part 2):
 * counter and B2B sales made outside GoKesari orders. GoKesari orders keep
 * their own tax invoices (NEW-007) and are not re-invoiced here; the sales
 * register and GST summary read both.
 *
 * Place of supply decides the tax: the shop's state → CGST + SGST; another
 * state → IGST. Stock leaves at once (SALE rows in the stock ledger), and the
 * books get Dr cash/bank/customer, Cr sales + output GST.
 */
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { gstState, isValidGstin } from "@/lib/gst-states";
import { financialYear, invoiceTotals, isInterState, stateOfGstin, taxOnTaxable, grossPaise } from "@/lib/accounts/gst-math";
import { textPdf, type PdfLine } from "@/lib/pdf";
import { formatPaise } from "@/lib/money";
import { db } from "@/server/db";
import { accParties, accSalesInvoices, accSalesLines, invStockLedger, shopProducts, shops, type AccSalesInvoice, type AccSalesLine } from "@/server/db/schema";
import { getSettings, logChange, nextNumber, postVoucher, reverseSource, todayIst } from "./books";
import { createParty, getParty } from "./parties";
import { postStock } from "./stock";

const paise = z.number().int().min(0);

export const salesSchema = z.object({
  partyId: z.string().uuid().nullable().optional(),
  buyerName: z.string().trim().max(160).nullable().optional(),
  buyerGstin: z.string().trim().toUpperCase().max(15).nullable().optional(),
  /** Two-digit state code; defaults to the buyer GSTIN's state, else the shop's. */
  placeOfSupply: z.string().regex(/^\d{2}$/).nullable().optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentMode: z.enum(["CASH", "BANK", "UPI", "CARD", "CREDIT"]),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** Prices include GST (MRP-style counter sale): the taxable value is backed out of them. */
  pricesIncludeTax: z.boolean().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  /** Billing v2 (§4.7): the POS device's id of an offline bill — the same id returns the same invoice. */
  clientRef: z.string().trim().min(8).max(64).nullable().optional(),
  lines: z
    .array(
      z.object({
        shopProductId: z.string().uuid().nullable().optional(),
        description: z.string().trim().min(1).max(200),
        hsn: z.string().trim().max(8).nullable().optional(),
        qtyMilli: z.number().int().positive(),
        unit: z.string().trim().max(20).nullable().optional(),
        ratePaise: paise,
        discountPaise: paise.optional(),
        gstRateBp: z.number().int().min(0).max(10_000),
      }),
    )
    .min(1)
    .max(200),
});
export type SalesInput = z.infer<typeof salesSchema>;

export async function createSalesInvoice(shopId: string, raw: SalesInput, actor: { id: string }): Promise<AccSalesInvoice> {
  return (await createSalesInvoiceOnce(shopId, raw, actor)).invoice;
}

/** createSalesInvoice that also says whether this call issued it (false: the bill's clientRef was issued before). */
export async function createSalesInvoiceOnce(shopId: string, raw: SalesInput, actor: { id: string }): Promise<{ invoice: AccSalesInvoice; created: boolean }> {
  const input = salesSchema.parse(raw);
  const date = input.invoiceDate ?? todayIst();
  if (date > todayIst()) throw validationFailed("The invoice date is in the future.");
  if (input.paymentMode === "CREDIT" && !input.partyId && !input.buyerName) throw validationFailed("A credit sale needs the customer's name.");
  const buyerGstin = input.buyerGstin?.replace(/\s+/g, "") || null;
  if (buyerGstin && !isValidGstin(buyerGstin)) throw validationFailed("Buyer GSTIN is not valid.");

  const byClientRef = async () =>
    input.clientRef ? (await db.select().from(accSalesInvoices).where(and(eq(accSalesInvoices.shopId, shopId), eq(accSalesInvoices.clientRef, input.clientRef))))[0] ?? null : null;
  const already = await byClientRef();
  if (already) return { invoice: already, created: false };
  try {
    return { invoice: await issueSalesInvoice(shopId, input, date, buyerGstin, actor), created: true };
  } catch (error) {
    // Two syncs of one offline bill at once: the one that lost the race returns the winner's invoice.
    const winner = await byClientRef().catch(() => null);
    if (winner) return { invoice: winner, created: false };
    throw error;
  }
}

async function issueSalesInvoice(shopId: string, input: SalesInput, date: string, buyerGstin: string | null, actor: { id: string }): Promise<AccSalesInvoice> {
  return db.transaction(async (tx) => {
    const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId));
    if (!shop) throw notFound("Shop");
    const sellerState = stateOfGstin(shop.gstin) ?? gstState(shop.state)?.code ?? null;
    if (!sellerState) throw validationFailed("Add your shop's GSTIN (or state) before issuing GST invoices.");
    const settings = await getSettings(shopId, tx);

    let partyId = input.partyId ?? null;
    let buyerName = input.buyerName ?? null;
    let gstin = buyerGstin;
    if (partyId) {
      const party = await getParty(shopId, partyId, tx);
      buyerName = buyerName ?? party.name;
      gstin = gstin ?? party.gstin;
    } else if (input.paymentMode === "CREDIT" || gstin) {
      const party = await createParty(shopId, { kind: "CUSTOMER", name: buyerName ?? "Customer", gstin }, actor.id, tx).catch(async (e) => {
        if (e instanceof Error && /already has this GSTIN/.test(e.message)) {
          const [p] = await tx.select().from(accParties).where(and(eq(accParties.shopId, shopId), eq(accParties.gstin, gstin!)));
          return p;
        }
        throw e;
      });
      partyId = party.id;
    }
    const pos = input.placeOfSupply ?? stateOfGstin(gstin) ?? sellerState;
    const inter = isInterState(sellerState, pos);

    const lines = input.lines.map((l) => {
      const gross = grossPaise(l.qtyMilli, l.ratePaise);
      const discount = l.discountPaise ?? 0;
      let taxable = gross - discount;
      if (taxable < 0) throw validationFailed(`"${l.description}": the discount is more than the amount.`);
      if (input.pricesIncludeTax) taxable = Math.round((taxable * 10_000) / (10_000 + l.gstRateBp));
      const t = taxOnTaxable(taxable, l.gstRateBp, inter);
      return { l, t, rate: input.pricesIncludeTax ? Math.round((l.ratePaise * 10_000) / (10_000 + l.gstRateBp)) : l.ratePaise };
    });
    const totals = invoiceTotals(lines.map((x) => x.t));

    // Lines that name a listing must be this shop's.
    const listingIds = lines.map((x) => x.l.shopProductId).filter(Boolean) as string[];
    if (listingIds.length) {
      const own = await tx.select({ id: shopProducts.id }).from(shopProducts).where(and(eq(shopProducts.shopId, shopId), inArray(shopProducts.id, listingIds)));
      const mine = new Set(own.map((o) => o.id));
      if (listingIds.some((id) => !mine.has(id))) throw validationFailed("A product on this invoice is not in your shop.");
    }

    const fy = financialYear(date);
    const seq = await nextNumber(shopId, "SALES_INVOICE", fy, tx);
    const invoiceNo = `${settings.salesInvoicePrefix}${fy.replace("-", "").slice(2)}-${String(seq).padStart(5, "0")}`.slice(0, 16);
    const [invoice] = await tx
      .insert(accSalesInvoices)
      .values({
        shopId,
        partyId,
        invoiceNo,
        invoiceDate: date,
        dueDate: input.dueDate ?? null,
        buyerName,
        buyerGstin: gstin,
        placeOfSupply: pos,
        sellerStateCode: sellerState,
        interState: inter,
        paymentMode: input.paymentMode,
        taxablePaise: totals.taxablePaise,
        cgstPaise: totals.cgstPaise,
        sgstPaise: totals.sgstPaise,
        igstPaise: totals.igstPaise,
        cessPaise: totals.cessPaise,
        roundOffPaise: totals.roundOffPaise,
        totalPaise: totals.totalPaise,
        note: input.note ?? null,
        clientRef: input.clientRef ?? null,
        createdBy: actor.id,
      })
      .returning();
    const inserted = await tx
      .insert(accSalesLines)
      .values(
        lines.map(({ l, t, rate }, i) => ({
          salesId: invoice.id,
          shopId,
          lineNo: i + 1,
          shopProductId: l.shopProductId ?? null,
          description: l.description,
          hsn: l.hsn ?? null,
          qtyMilli: l.qtyMilli,
          unit: l.unit ?? null,
          ratePaise: rate,
          discountPaise: t.discountPaise,
          taxablePaise: t.taxablePaise,
          gstRateBp: l.gstRateBp,
          cgstPaise: t.cgstPaise,
          sgstPaise: t.sgstPaise,
          igstPaise: t.igstPaise,
          cessPaise: t.cessPaise,
          totalPaise: t.totalPaise,
        })),
      )
      .returning();

    // Stock out (counter sales come from the in-shop count first).
    const channel = settings.purchaseChannel === "ONLINE" ? "OFFLINE" : "ONLINE";
    const postings = [];
    for (const [i, { l }] of lines.entries()) {
      if (!l.shopProductId) continue;
      const [sp] = await tx.select({ offlineStock: shopProducts.offlineStock, onlineStock: shopProducts.onlineStock }).from(shopProducts).where(eq(shopProducts.id, l.shopProductId));
      const fromChannel = (channel === "OFFLINE" ? sp.offlineStock : sp.onlineStock) * 1000 >= l.qtyMilli ? channel : settings.purchaseChannel;
      postings.push({
        shopId,
        shopProductId: l.shopProductId,
        channel: fromChannel,
        movementType: "SALE" as const,
        qtyMilli: -l.qtyMilli,
        unitPricePaise: inserted[i].ratePaise,
        sourceType: "SALES_INVOICE" as const,
        sourceId: invoice.id,
        sourceLineId: inserted[i].id,
        docRef: invoiceNo,
        entryDate: date,
        createdBy: actor.id,
      });
    }
    await postStock(postings, tx);

    const debitAccount = input.paymentMode === "CASH" ? "CASH" : input.paymentMode === "CREDIT" ? "PARTY" : "BANK";
    await postVoucher(
      {
        shopId,
        voucherType: "SALE",
        entryDate: date,
        sourceType: "SALE",
        sourceId: invoice.id,
        docRef: invoiceNo,
        narration: `Invoice ${invoiceNo}${buyerName ? ` to ${buyerName}` : ""}`,
        createdBy: actor.id,
        legs: [
          { account: debitAccount, partyId: debitAccount === "PARTY" ? partyId : null, debitPaise: totals.totalPaise },
          { account: "SALES", creditPaise: totals.taxablePaise },
          { account: "GST_OUTPUT_CGST", creditPaise: totals.cgstPaise },
          { account: "GST_OUTPUT_SGST", creditPaise: totals.sgstPaise },
          { account: "GST_OUTPUT_IGST", creditPaise: totals.igstPaise },
          { account: "GST_OUTPUT_CESS", creditPaise: totals.cessPaise },
          { account: "ROUND_OFF", creditPaise: totals.roundOffPaise },
        ],
      },
      tx,
    );
    await logChange({ shopId, entityType: "sales_invoice", entityId: invoice.id, action: "ISSUE", snapshot: { invoiceNo, totalPaise: invoice.totalPaise, lines: inserted.length }, actorId: actor.id }, tx);
    return invoice;
  });
}

export async function cancelSalesInvoice(shopId: string, salesId: string, reason: string, actor: { id: string }): Promise<void> {
  if (!reason.trim()) throw validationFailed("Say why the invoice is cancelled.");
  await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(accSalesInvoices).where(and(eq(accSalesInvoices.id, salesId), eq(accSalesInvoices.shopId, shopId))).for("update");
    if (!inv) throw notFound("Invoice");
    if (inv.status === "CANCELLED") throw conflict("This invoice is already cancelled.");
    const rows = await tx.select().from(invStockLedger).where(and(eq(invStockLedger.sourceType, "SALES_INVOICE"), eq(invStockLedger.sourceId, salesId), eq(invStockLedger.movementType, "SALE")));
    await postStock(
      rows.map((r) => ({ shopId, shopProductId: r.shopProductId, channel: r.channel, movementType: "REVERSAL" as const, qtyMilli: -r.qtyMilli, unitPricePaise: r.unitPricePaise, sourceType: "SALES_INVOICE" as const, sourceId: salesId, docRef: inv.invoiceNo, reversesId: r.id, note: `Invoice cancelled: ${reason}`, createdBy: actor.id })),
      tx,
    );
    await reverseSource(shopId, "SALE", salesId, todayIst(), actor.id, `Invoice ${inv.invoiceNo} cancelled: ${reason}`, tx);
    await tx.update(accSalesInvoices).set({ status: "CANCELLED", cancelReason: reason, updatedAt: new Date() }).where(eq(accSalesInvoices.id, salesId));
    await logChange({ shopId, entityType: "sales_invoice", entityId: salesId, action: "CANCEL", changes: [{ field: "status", old: "ISSUED", new: "CANCELLED" }], reason, actorId: actor.id }, tx);
  });
}

export async function listSalesInvoices(shopId: string, options: { from?: string; to?: string } = {}) {
  return db
    .select()
    .from(accSalesInvoices)
    .where(and(eq(accSalesInvoices.shopId, shopId), options.from ? gte(accSalesInvoices.invoiceDate, options.from) : undefined, options.to ? lt(accSalesInvoices.invoiceDate, options.to) : undefined))
    .orderBy(desc(accSalesInvoices.invoiceDate), desc(accSalesInvoices.createdAt))
    .limit(1000);
}

export async function getSalesInvoice(shopId: string, salesId: string): Promise<{ invoice: AccSalesInvoice; lines: AccSalesLine[] }> {
  const [invoice] = await db.select().from(accSalesInvoices).where(and(eq(accSalesInvoices.id, salesId), eq(accSalesInvoices.shopId, shopId)));
  if (!invoice) throw notFound("Invoice");
  const lines = await db.select().from(accSalesLines).where(eq(accSalesLines.salesId, salesId)).orderBy(asc(accSalesLines.lineNo));
  return { invoice, lines };
}

/** The printable tax invoice (Rule 46 fields), as a plain-text PDF. */
export async function salesInvoicePdf(shopId: string, salesId: string): Promise<{ bytes: Buffer; filename: string }> {
  const { invoice, lines } = await getSalesInvoice(shopId, salesId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  const rs = (p: number) => formatPaise(p).replace("₹", "Rs. ");
  const out: PdfLine[] = [
    { text: invoice.status === "CANCELLED" ? "TAX INVOICE  (CANCELLED)" : "TAX INVOICE", bold: true },
    { text: shop.legalBusinessName ?? shop.name, bold: true },
    { text: `${[shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.pincode].filter(Boolean).join(", ")}` },
    { text: `GSTIN: ${shop.gstin ?? "-"}   State: ${gstState(invoice.sellerStateCode)?.name ?? invoice.sellerStateCode} (${invoice.sellerStateCode})` },
    { text: "" },
    { text: `Invoice no: ${invoice.invoiceNo}     Date: ${invoice.invoiceDate}` },
    { text: `Bill to: ${invoice.buyerName ?? "Cash customer"}${invoice.buyerGstin ? `   GSTIN: ${invoice.buyerGstin}` : ""}` },
    { text: `Place of supply: ${gstState(invoice.placeOfSupply)?.name ?? invoice.placeOfSupply} (${invoice.placeOfSupply})   ${invoice.interState ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}` },
    { text: "" },
    { text: "#  Item                         HSN       Qty     Rate      Taxable   GST%   Tax       Total", bold: true },
  ];
  for (const l of lines) {
    const tax = l.cgstPaise + l.sgstPaise + l.igstPaise + l.cessPaise;
    out.push({
      text: `${String(l.lineNo).padEnd(3)}${l.description.slice(0, 28).padEnd(29)}${(l.hsn ?? "").padEnd(10)}${String(l.qtyMilli / 1000).padEnd(8)}${String((l.ratePaise / 100).toFixed(2)).padEnd(10)}${String((l.taxablePaise / 100).toFixed(2)).padEnd(10)}${String(l.gstRateBp / 100).padEnd(7)}${String((tax / 100).toFixed(2)).padEnd(10)}${(l.totalPaise / 100).toFixed(2)}`,
    });
  }
  out.push({ text: "" });
  out.push({ text: `Taxable value: ${rs(invoice.taxablePaise)}` });
  if (invoice.interState) out.push({ text: `IGST: ${rs(invoice.igstPaise)}` });
  else out.push({ text: `CGST: ${rs(invoice.cgstPaise)}   SGST: ${rs(invoice.sgstPaise)}` });
  if (invoice.roundOffPaise) out.push({ text: `Round off: ${rs(invoice.roundOffPaise)}` });
  out.push({ text: `TOTAL: ${rs(invoice.totalPaise)}`, bold: true });
  out.push({ text: `Payment: ${invoice.paymentMode}` });
  out.push({ text: "" });
  out.push({ text: "This is a computer-generated invoice." });
  return { bytes: textPdf(out, { title: `Invoice ${invoice.invoiceNo}` }), filename: `${invoice.invoiceNo.replace(/[^A-Za-z0-9-]/g, "_")}.pdf` };
}
