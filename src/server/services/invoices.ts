/**
 * NEW-007 tax invoice per order (rule invoicing).
 *
 * The shop is the supplier, so the invoice is the shop's: a TAX_INVOICE when
 * the shop has a GSTIN on record that is registered or verified, otherwise a
 * BILL_OF_SUPPLY (no tax charged — composition dealers and unregistered
 * shops). It is issued when the order is delivered (the point of supply),
 * inside the delivery's transaction under a savepoint, and also on first
 * request for an order delivered before invoicing was switched on.
 *
 * Prices on GoKesari are tax-inclusive, so tax is worked out of each line:
 * taxable = round(line × 10000 / (10000 + rate)); tax = line − taxable —
 * the parts always add up to exactly what was charged. Intra-state supplies
 * split tax into CGST + SGST; a delivery to another state (known from the
 * address's state) is IGST. A product with no GST rate on record uses
 * invoicing.defaultGstRateBp and the line says "rate not set". The delivery
 * fee is GoKesari's charge, not the shop's (the platform keeps it and pays
 * the rider — see the shop finance page), so it is not on the shop's invoice;
 * it is shown under the totals with the payment. A coupon is paid by
 * GoKesari (F7), so it does not reduce the shop's invoice value either.
 *
 * Numbering: "<shop registration no.>/<FY>/<000001>", one sequence per shop
 * per financial year (April–March, IST), incremented under a row lock in the
 * issuing transaction — a rolled-back issue gives its number back, so there
 * are no gaps and never two invoices for one order.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { formatPaise, formatQuantity } from "@/lib/money";
import { PDF_LINE_WIDTH, textPdf, type PdfLine } from "@/lib/pdf";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  invoiceCounters,
  orderItems,
  orders,
  products,
  sellerVerifications,
  shopProducts,
  shops,
  taxInvoices,
  users,
  type TaxInvoice,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { toStateCode } from "./seller-verification-checks";
import { getRule } from "./settings";

export interface InvoiceLine {
  description: string;
  hsn: string | null;
  quantity: string;
  rateBp: number;
  rateAssumed: boolean;
  grossPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

export interface InvoiceSnapshot {
  invoiceNumber: string;
  kind: "TAX_INVOICE" | "BILL_OF_SUPPLY";
  issuedAt: string;
  financialYear: string;
  supplyType: "INTRA" | "INTER";
  orderNumber: string;
  orderDate: string;
  seller: {
    name: string;
    legalName: string;
    address: string;
    gstin: string | null;
    panMasked: string | null;
    fssai: string | null;
    stateCode: string | null;
    registrationNumber: string;
  };
  buyer: { name: string; address: string; gstin: string | null };
  placeOfSupply: string;
  lines: InvoiceLine[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number };
  payment: {
    method: string;
    /** GoKesari's delivery fee — not part of the shop's supply. */
    deliveryFeePaise: number;
    couponPaise: number;
    couponCode: string | null;
    paidByCustomerPaise: number;
  };
  notes: string[];
}

/** Financial year (April–March) of a moment, in IST: "2026-27". */
export function financialYearOf(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Tax out of a tax-inclusive amount. */
export function splitInclusive(grossPaise: number, rateBp: number, supply: "INTRA" | "INTER") {
  const taxable = rateBp > 0 ? Math.round((grossPaise * 10_000) / (10_000 + rateBp)) : grossPaise;
  const tax = grossPaise - taxable;
  if (supply === "INTER") return { taxablePaise: taxable, cgstPaise: 0, sgstPaise: 0, igstPaise: tax };
  const cgst = Math.floor(tax / 2);
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: tax - cgst, igstPaise: 0 };
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ""}`;
  return [h ? `${ONES[h]} Hundred` : "", rest].filter(Boolean).join(" ");
}
/** Indian-system words for a rupee amount: 125050 paise → "Rupees One Thousand Two Hundred Fifty and Fifty Paise Only". */
export function amountInWords(paise: number): string {
  let rupees = Math.floor(paise / 100);
  const p = paise % 100;
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000);
  rupees %= 100_000;
  const thousand = Math.floor(rupees / 1000);
  rupees %= 1000;
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`);
  if (rupees) parts.push(belowThousand(rupees));
  const words = parts.join(" ") || "Zero";
  return `Rupees ${words}${p ? ` and ${belowThousand(p)} Paise` : ""} Only`;
}

/** The shop's GSTIN when it counts as GST-registered for invoicing; null → bill of supply. */
async function registeredGstin(shop: typeof shops.$inferSelect, client: DbClient): Promise<string | null> {
  if (!shop.gstin || !/^\d{2}[A-Z0-9]{13}$/.test(shop.gstin) || shop.gstStatus === "COMPOSITION") return null;
  if (shop.gstStatus === "REGISTERED") return shop.gstin;
  const [verified] = await client
    .select({ id: sellerVerifications.id })
    .from(sellerVerifications)
    .where(
      and(
        eq(sellerVerifications.shopId, shop.id),
        eq(sellerVerifications.docType, "GSTIN"),
        eq(sellerVerifications.status, "VERIFIED"),
        sql`${sellerVerifications.numberMasked} IS NOT NULL`,
      ),
    )
    .limit(1);
  return verified ? shop.gstin : null;
}

async function buildSnapshot(orderId: string, client: DbClient, issuedAt: Date) {
  const rule = await getRule("invoicing");
  const [row] = await client
    .select({ order: orders, shop: shops, customer: users })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId));
  if (!row) throw notFound("Order");
  const { order, shop, customer } = row;
  if (order.status !== "DELIVERED") throw conflict("An invoice is issued once the order is delivered.");

  const gstin = await registeredGstin(shop, client);
  const kind: InvoiceSnapshot["kind"] = gstin ? "TAX_INVOICE" : "BILL_OF_SUPPLY";
  const sellerState = gstin ? toStateCode(gstin.slice(0, 2)) : toStateCode(shop.state);
  const address = order.addressId
    ? await client.query.addresses.findFirst({ where: eq(addresses.id, order.addressId) })
    : undefined;
  const buyerState = toStateCode(address?.state ?? null);
  const supplyType: InvoiceSnapshot["supplyType"] =
    sellerState && buyerState && sellerState !== buyerState ? "INTER" : "INTRA";

  const items = await client
    .select({ item: orderItems, hsn: products.hsnCode, gstRateBp: products.gstRateBp })
    .from(orderItems)
    .leftJoin(shopProducts, eq(shopProducts.id, orderItems.shopProductId))
    .leftJoin(products, eq(products.id, shopProducts.productId))
    .where(eq(orderItems.orderId, orderId));

  const lines: InvoiceLine[] = [];
  for (const { item, hsn, gstRateBp } of items) {
    if (item.fulfilmentStatus === "REMOVED") continue;
    const substituted = item.fulfilmentStatus === "SUBSTITUTED" && item.substituteLineTotalPaise != null;
    const gross = substituted ? item.substituteLineTotalPaise! : item.lineTotalPaise;
    const name = substituted ? (item.substituteNameSnapshot ?? item.productNameSnapshot) : item.productNameSnapshot;
    const qty = substituted
      ? formatQuantity(item.substituteQuantityMilli ?? item.quantityMilli, item.substituteUnitSnapshot ?? item.unitSnapshot)
      : formatQuantity(item.quantityMilli, item.unitSnapshot);
    const rateAssumed = gstRateBp == null;
    const rate = kind === "TAX_INVOICE" ? (gstRateBp ?? rule.defaultGstRateBp) : 0;
    lines.push({
      description: name,
      hsn: hsn ?? null,
      quantity: qty,
      rateBp: rate,
      rateAssumed: kind === "TAX_INVOICE" && rateAssumed,
      grossPaise: gross,
      ...splitInclusive(gross, rate, supplyType),
    });
  }
  const sum = (k: keyof Pick<InvoiceLine, "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "grossPaise">) =>
    lines.reduce((s, l) => s + l[k], 0);
  const buyerShop = order.buyerShopId ? await client.query.shops.findFirst({ where: eq(shops.id, order.buyerShopId) }) : undefined;
  const snap = order.deliveryAddressSnapshot;
  const notes: string[] = [];
  if (kind === "BILL_OF_SUPPLY") notes.push("Supplier not registered under GST (or under the composition scheme): no tax is charged on this bill of supply.");
  if (lines.some((l) => l.rateAssumed)) notes.push("Lines marked * have no GST rate on record for the product; the default rate was applied.");
  notes.push("Prices are inclusive of GST. Tax is shown as included in each line.");

  const snapshot: Omit<InvoiceSnapshot, "invoiceNumber" | "financialYear"> = {
    kind,
    issuedAt: issuedAt.toISOString(),
    supplyType,
    orderNumber: order.orderNumber,
    orderDate: order.createdAt.toISOString(),
    seller: {
      name: shop.name,
      legalName: shop.legalBusinessName ?? shop.name,
      address: [shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.state, shop.pincode].filter(Boolean).join(", "),
      gstin,
      panMasked: shop.panLast4 ? `XXXXXX${shop.panLast4}` : null,
      fssai: shop.fssaiLicenseNumber,
      stateCode: sellerState,
      registrationNumber: shop.registrationNumber,
    },
    buyer: {
      name: buyerShop?.legalBusinessName ?? buyerShop?.name ?? customer.name ?? "Customer",
      address: snap ? [snap.line1, snap.line2, snap.area, snap.city, snap.pincode].filter(Boolean).join(", ") : "Collected from the shop",
      gstin: buyerShop?.gstin ?? null,
    },
    placeOfSupply: buyerState ?? sellerState ?? "Local",
    lines,
    totals: {
      taxablePaise: sum("taxablePaise"),
      cgstPaise: sum("cgstPaise"),
      sgstPaise: sum("sgstPaise"),
      igstPaise: sum("igstPaise"),
      totalPaise: sum("grossPaise"),
    },
    payment: {
      method: order.paymentMethod,
      deliveryFeePaise: order.deliveryFeePaise,
      couponPaise: order.discountPaise,
      couponCode: order.couponCode,
      paidByCustomerPaise: order.totalPaise,
    },
    notes,
  };
  return { order, shop, snapshot };
}

const isUniqueViolation = (error: unknown) =>
  ((error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code) === "23505";

/**
 * Issues the order's invoice, or returns the one already issued. Null while
 * the rule is off. `client` lets the DELIVERED transition issue it in its own
 * transaction.
 */
export async function issueInvoiceForOrder(orderId: string, client: DbClient = db): Promise<TaxInvoice | null> {
  const existing = await client.query.taxInvoices.findFirst({ where: eq(taxInvoices.orderId, orderId) });
  if (existing) return existing;
  if (!(await getRule("invoicing")).enabled) return null;

  const issuedAt = new Date();
  const run = async (tx: DbClient) => {
    const { order, shop, snapshot } = await buildSnapshot(orderId, tx, issuedAt);
    const financialYear = financialYearOf(issuedAt);
    const [counter] = await tx
      .insert(invoiceCounters)
      .values({ shopId: shop.id, financialYear, lastNumber: 1 })
      .onConflictDoUpdate({
        target: [invoiceCounters.shopId, invoiceCounters.financialYear],
        set: { lastNumber: sql`${invoiceCounters.lastNumber} + 1` },
      })
      .returning();
    const invoiceNumber = `${shop.registrationNumber}/${financialYear}/${String(counter.lastNumber).padStart(6, "0")}`;
    const full: InvoiceSnapshot = { ...snapshot, invoiceNumber, financialYear };
    const [invoice] = await tx
      .insert(taxInvoices)
      .values({
        orderId,
        shopId: shop.id,
        invoiceNumber,
        financialYear,
        sequence: counter.lastNumber,
        kind: full.kind,
        supplyType: full.supplyType,
        taxablePaise: full.totals.taxablePaise,
        cgstPaise: full.totals.cgstPaise,
        sgstPaise: full.totals.sgstPaise,
        igstPaise: full.totals.igstPaise,
        totalPaise: full.totals.totalPaise,
        snapshot: full as unknown as Record<string, unknown>,
        issuedAt,
      })
      .returning();
    await recordAudit(
      {
        actorId: null,
        action: AUDIT_ACTIONS.INVOICE_ISSUED,
        entityType: "order",
        entityId: orderId,
        newValue: { invoiceNumber, kind: full.kind, totalPaise: full.totals.totalPaise },
      },
      tx,
    );
    await notify(
      {
        userId: order.userId,
        type: NOTIFICATION_TYPES.ORDER_INVOICE_READY,
        title: "Your invoice is ready",
        body: `Invoice ${invoiceNumber} for order ${order.orderNumber} can be downloaded from your orders.`,
        actionUrl: `/invoices/${invoice.id}`,
        dedupeKey: `invoice:${orderId}`,
      },
      tx,
    );
    return invoice;
  };
  try {
    // A savepoint when called inside the delivery's transaction.
    return await client.transaction(run);
  } catch (error) {
    // Issued concurrently (another request or the delivery itself): use that one.
    if (isUniqueViolation(error)) return (await db.query.taxInvoices.findFirst({ where: eq(taxInvoices.orderId, orderId) })) ?? null;
    throw error;
  }
}

export async function getInvoice(id: string): Promise<TaxInvoice> {
  const invoice = await db.query.taxInvoices.findFirst({ where: eq(taxInvoices.id, id) });
  if (!invoice) throw notFound("Invoice");
  return invoice;
}

/** Invoice ids of these orders (for order lists). */
export async function invoicesForOrders(orderIds: string[]): Promise<Map<string, string>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({ id: taxInvoices.id, orderId: taxInvoices.orderId })
    .from(taxInvoices)
    .where(sql`${taxInvoices.orderId} IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})`);
  return new Map(rows.map((r) => [r.orderId, r.id]));
}

export async function listInvoicesForShop(shopId: string, limit = 100): Promise<TaxInvoice[]> {
  return db.select().from(taxInvoices).where(eq(taxInvoices.shopId, shopId)).orderBy(desc(taxInvoices.issuedAt)).limit(limit);
}

/** The order's customer, its shop's owner, and operations may see an invoice. */
export async function canViewInvoice(invoice: TaxInvoice, user: { id: string; role: UserRole }): Promise<boolean> {
  if (user.role === "ADMIN" || user.role === "OPERATOR") return true;
  const [row] = await db
    .select({ customerId: orders.userId, ownerId: shops.ownerId })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, invoice.orderId));
  return Boolean(row && (row.customerId === user.id || row.ownerId === user.id));
}

/* ------------------------------------------------------------------- PDF */

const money = (paise: number) => formatPaise(paise).replace("₹", "Rs. ");
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** The invoice as fixed-width lines (PDF and plain-text use). */
export function invoiceTextLines(s: InvoiceSnapshot): PdfLine[] {
  const W = PDF_LINE_WIDTH;
  const rule = "-".repeat(W);
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (left: string, right: string) => add(left + right.padStart(Math.max(1, W - left.length)));
  const wrap = (text: string, indent = "") => {
    let rest = text;
    while (rest.length > W - indent.length) {
      const cut = rest.lastIndexOf(" ", W - indent.length);
      const at = cut > 0 ? cut : W - indent.length;
      add(indent + rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    add(indent + rest);
  };

  add(s.kind === "TAX_INVOICE" ? "TAX INVOICE" : "BILL OF SUPPLY", true);
  pair(`Invoice no: ${s.invoiceNumber}`, `Date: ${fmtDate(s.issuedAt)}`);
  pair(`Order no: ${s.orderNumber}`, `Order date: ${fmtDate(s.orderDate)}`);
  add(rule);
  add("SOLD BY", true);
  wrap(`${s.seller.legalName}${s.seller.legalName !== s.seller.name ? ` (${s.seller.name})` : ""}`);
  wrap(s.seller.address);
  add(
    [s.seller.gstin ? `GSTIN: ${s.seller.gstin}` : "Not GST-registered", s.seller.panMasked ? `PAN: ${s.seller.panMasked}` : null, s.seller.fssai ? `FSSAI: ${s.seller.fssai}` : null]
      .filter(Boolean)
      .join("   "),
  );
  add(`GoKesari shop no: ${s.seller.registrationNumber}`);
  add();
  add("BILL TO / SHIP TO", true);
  wrap(s.buyer.name);
  wrap(s.buyer.address);
  if (s.buyer.gstin) add(`GSTIN: ${s.buyer.gstin}`);
  add(`Place of supply: ${s.placeOfSupply}   Supply: ${s.supplyType === "INTRA" ? "Intra-state (CGST + SGST)" : "Inter-state (IGST)"}`);
  add(rule);

  const intra = s.supplyType === "INTRA";
  const head = `${"#".padEnd(3)}${"Item".padEnd(30)}${"HSN".padEnd(8)}${"Qty".padEnd(10)}${"GST".padStart(6)}${"Taxable".padStart(13)}${(intra ? "CGST+SGST" : "IGST").padStart(12)}${"Amount".padStart(12)}`;
  add(head.slice(0, W), true);
  s.lines.forEach((l, i) => {
    const tax = l.cgstPaise + l.sgstPaise + l.igstPaise;
    const name = `${l.description}${l.rateAssumed ? " *" : ""}`;
    const row =
      `${String(i + 1).padEnd(3)}${name.slice(0, 29).padEnd(30)}${(l.hsn ?? "-").slice(0, 7).padEnd(8)}${l.quantity.slice(0, 9).padEnd(10)}` +
      `${pct(l.rateBp).padStart(6)}${money(l.taxablePaise).padStart(13)}${money(tax).padStart(12)}${money(l.grossPaise).padStart(12)}`;
    add(row.slice(0, W));
    if (name.length > 29) add(`   ${name.slice(29, 29 + W - 3)}`);
  });
  add(rule);
  pair("Taxable value", money(s.totals.taxablePaise));
  if (intra) {
    pair("CGST", money(s.totals.cgstPaise));
    pair("SGST", money(s.totals.sgstPaise));
  } else {
    pair("IGST", money(s.totals.igstPaise));
  }
  pair("Invoice total (inclusive of tax)", money(s.totals.totalPaise));
  wrap(amountInWords(s.totals.totalPaise));
  add(rule);
  add("PAYMENT", true);
  if (s.payment.deliveryFeePaise > 0) {
    pair("Delivery fee (charged by GoKesari, not part of this invoice)", money(s.payment.deliveryFeePaise));
  }
  if (s.payment.couponPaise > 0) {
    pair(`Coupon ${s.payment.couponCode ?? ""} (paid by GoKesari)`, money(s.payment.couponPaise));
  }
  pair(`Paid by customer (${s.payment.method === "COD" ? "cash on delivery" : "GoKesari wallet"})`, money(s.payment.paidByCustomerPaise));
  add();
  for (const note of s.notes) wrap(`Note: ${note}`);
  add("This is a computer-generated document issued through GoKesari on behalf of the seller.");
  return out;
}

export function renderInvoicePdf(invoice: TaxInvoice): Buffer {
  const s = invoice.snapshot as unknown as InvoiceSnapshot;
  return textPdf(invoiceTextLines(s), { title: `Invoice ${s.invoiceNumber}` });
}
