/**
 * GoKesari's own tax invoice to the customer for the delivery fee (billing v2,
 * docs/billing §5.2, gap G1). When an unregistered GoKesari delivery partner
 * delivered, the delivery service is supplied through GoKesari as an
 * electronic commerce operator and GoKesari pays its GST under s.9(5) — so
 * GoKesari, not the rider, invoices it, in GoKesari's GSTIN (rule
 * platformTaxProfile), at the rate for the time of supply recorded in
 * order_money_flows (18% to 31 Oct 2026, 5% without ITC from 1 Nov 2026).
 *
 * Issued in the delivery's transaction, right after the money-flow record.
 * One per order; numbered "GKS/2627/000001" (rule billing.deliveryInvoicePrefix)
 * from one gapless counter per financial year taken in the same transaction.
 *
 * The same series carries GoKesari's invoice for a restaurant's food (kind
 * RESTAURANT, docs/billing §5.3, G17): when the dated row GST_S95_RESTAURANT
 * covers the shop's type, GoKesari is the deemed supplier of the restaurant
 * service under s.9(5), invoices the food in its own GSTIN on the
 * restaurant's behalf and pays the GST.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { stateLabel } from "@/lib/gst-states";
import { formatPaise } from "@/lib/money";
import { PDF_LINE_WIDTH, textPdf, type PdfLine } from "@/lib/pdf";
import { db, type DbClient } from "@/server/db";
import {
  orders,
  platformDeliveryInvoiceCounters,
  platformDeliveryInvoices,
  users,
  type PlatformDeliveryInvoice,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { amountInWords, financialYearOf } from "@/server/services/invoices";
import { getRule } from "@/server/services/settings";

export interface DeliveryInvoiceSnapshot {
  /** Absent on invoices issued before 0135: DELIVERY. */
  kind?: "DELIVERY" | "RESTAURANT";
  invoiceNumber: string;
  financialYear: string;
  issuedAt: string;
  orderNumber: string;
  supplier: { legalName: string; tradeName: string; gstin: string; address: string; stateCode: string };
  recipient: { name: string; address: string };
  placeOfSupply: string | null;
  supplyType: "INTRA" | "INTER";
  sac: string;
  description: string;
  rateBp: number;
  withoutItc: boolean;
  feePaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** RESTAURANT: the dishes (each tax-inclusive) and the restaurant the food is supplied for. */
  lines?: FoodGstLine[];
  onBehalfOf?: { name: string; gstin: string | null };
  notes: string[];
}

export interface FoodGstLine {
  description: string;
  quantity: string;
  grossPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

/** SAC 996331: services provided by restaurants, cafes and similar eating facilities, incl. takeaway. */
export const RESTAURANT_SAC = "996331";

/** "GKS/2627/000001": prefix, financial year (2026-27 → 2627), six digits. */
export function deliveryInvoiceNumber(prefix: string, financialYear: string, sequence: number): string {
  return `${prefix}/${financialYear.slice(2, 4)}${financialYear.slice(5, 7)}/${String(sequence).padStart(6, "0")}`;
}

export interface DeliveryGstLine {
  rateBp: number;
  withoutItc: boolean;
  feePaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  supplyType: "INTRA" | "INTER";
  placeOfSupply: string | null;
}

const ofKind = (orderId: string, kind: "DELIVERY" | "RESTAURANT") => and(eq(platformDeliveryInvoices.orderId, orderId), eq(platformDeliveryInvoices.kind, kind));

/** Issues the order's delivery-fee invoice, or returns the one already issued. */
export async function issueDeliveryFeeInvoice(orderId: string, gst: DeliveryGstLine, client: DbClient, at: Date = new Date()): Promise<PlatformDeliveryInvoice> {
  return issueS95Invoice(orderId, "DELIVERY", gst, client, at);
}

export interface FoodGst {
  rateBp: number;
  withoutItc: boolean;
  supplyType: "INTRA" | "INTER";
  placeOfSupply: string | null;
  lines: FoodGstLine[];
  restaurant: { name: string; gstin: string | null };
}

/** Issues GoKesari's s.9(5) invoice for a restaurant order's food, or returns the one already issued. */
export async function issueRestaurantS95Invoice(orderId: string, food: FoodGst, client: DbClient, at: Date = new Date()): Promise<PlatformDeliveryInvoice> {
  const sum = (k: "grossPaise" | "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise") => food.lines.reduce((n, l) => n + l[k], 0);
  return issueS95Invoice(
    orderId,
    "RESTAURANT",
    { rateBp: food.rateBp, withoutItc: food.withoutItc, feePaise: sum("grossPaise"), taxablePaise: sum("taxablePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), igstPaise: sum("igstPaise"), supplyType: food.supplyType, placeOfSupply: food.placeOfSupply },
    client,
    at,
    { lines: food.lines, onBehalfOf: food.restaurant },
  );
}

async function issueS95Invoice(
  orderId: string,
  kind: "DELIVERY" | "RESTAURANT",
  gst: DeliveryGstLine,
  client: DbClient,
  at: Date,
  food?: { lines: FoodGstLine[]; onBehalfOf: { name: string; gstin: string | null } },
): Promise<PlatformDeliveryInvoice> {
  const [existing] = await client.select().from(platformDeliveryInvoices).where(ofKind(orderId, kind));
  if (existing) return existing;
  const profile = await getRule("platformTaxProfile");
  if (!profile.gstin) throw conflict(`GoKesari's GSTIN is not set (Admin → Rules, platformTaxProfile): the s.9(5) ${kind === "DELIVERY" ? "delivery" : "restaurant"} invoice cannot be issued.`);
  const rule = await getRule("billing");
  const [row] = await client
    .select({ orderNumber: orders.orderNumber, userId: orders.userId, snap: orders.deliveryAddressSnapshot, name: users.name })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId));
  if (!row) throw notFound("Order");

  const financialYear = financialYearOf(at);
  const [counter] = await client
    .insert(platformDeliveryInvoiceCounters)
    .values({ financialYear, lastNumber: 1 })
    .onConflictDoUpdate({ target: platformDeliveryInvoiceCounters.financialYear, set: { lastNumber: sql`${platformDeliveryInvoiceCounters.lastNumber} + 1` } })
    .returning();
  const invoiceNumber = deliveryInvoiceNumber(rule.deliveryInvoicePrefix, financialYear, counter.lastNumber);
  const snap = row.snap;
  const restaurant = kind === "RESTAURANT";
  const snapshot: DeliveryInvoiceSnapshot = {
    kind,
    invoiceNumber,
    financialYear,
    issuedAt: at.toISOString(),
    orderNumber: row.orderNumber,
    supplier: { legalName: profile.legalName, tradeName: profile.tradeName, gstin: profile.gstin, address: profile.address, stateCode: profile.stateCode },
    recipient: {
      name: row.name ?? "Customer",
      address: snap ? [snap.line1, snap.line2, snap.area, snap.city, snap.pincode].filter(Boolean).join(", ") : "-",
    },
    placeOfSupply: gst.placeOfSupply,
    supplyType: gst.supplyType,
    sac: restaurant ? RESTAURANT_SAC : profile.sacCodes.DELIVERY_CHARGE,
    description: restaurant ? `Restaurant service, order ${row.orderNumber}` : `Local delivery of order ${row.orderNumber}`,
    rateBp: gst.rateBp,
    withoutItc: gst.withoutItc,
    feePaise: gst.feePaise,
    taxablePaise: gst.taxablePaise,
    cgstPaise: gst.cgstPaise,
    sgstPaise: gst.sgstPaise,
    igstPaise: gst.igstPaise,
    ...(food ? { lines: food.lines, onBehalfOf: food.onBehalfOf } : {}),
    notes: [
      restaurant
        ? `Restaurant service supplied through the electronic commerce operator on behalf of ${food!.onBehalfOf.name}${food!.onBehalfOf.gstin ? ` (GSTIN ${food!.onBehalfOf.gstin})` : ""}; tax is paid by the operator under section 9(5) of the CGST Act.`
        : "Tax on this supply is paid by the electronic commerce operator under section 9(5) of the CGST Act; the delivery partner is not registered under GST.",
      ...(gst.withoutItc ? ["Input tax credit has not been taken on this service (rate notified without ITC)."] : []),
      "Reverse charge: No.",
    ],
  };
  const [invoice] = await client
    .insert(platformDeliveryInvoices)
    .values({
      orderId,
      customerId: row.userId,
      kind,
      invoiceNumber,
      financialYear,
      sequence: counter.lastNumber,
      supplyType: gst.supplyType,
      placeOfSupply: gst.placeOfSupply,
      rateBp: gst.rateBp,
      feePaise: gst.feePaise,
      taxablePaise: gst.taxablePaise,
      cgstPaise: gst.cgstPaise,
      sgstPaise: gst.sgstPaise,
      igstPaise: gst.igstPaise,
      snapshot: snapshot as unknown as Record<string, unknown>,
      issuedAt: at,
    })
    .returning();
  await recordAudit(
    {
      actorId: null,
      action: AUDIT_ACTIONS.INVOICE_ISSUED,
      entityType: "platform_delivery_invoice",
      entityId: invoice.id,
      newValue: { invoiceNumber, orderId, kind, feePaise: gst.feePaise, rateBp: gst.rateBp },
    },
    client,
  );
  return invoice;
}

export async function getDeliveryFeeInvoice(id: string): Promise<PlatformDeliveryInvoice> {
  const [row] = await db.select().from(platformDeliveryInvoices).where(eq(platformDeliveryInvoices.id, id));
  if (!row) throw notFound("Delivery invoice");
  return row;
}

export async function deliveryFeeInvoiceForOrder(orderId: string): Promise<PlatformDeliveryInvoice | null> {
  const [row] = await db.select().from(platformDeliveryInvoices).where(ofKind(orderId, "DELIVERY"));
  return row ?? null;
}

export async function restaurantS95InvoiceForOrder(orderId: string): Promise<PlatformDeliveryInvoice | null> {
  const [row] = await db.select().from(platformDeliveryInvoices).where(ofKind(orderId, "RESTAURANT"));
  return row ?? null;
}

/**
 * GoKesari's own invoices on these orders (s.9(5) delivery fee, restaurant food), issued and not
 * cancelled, for the customer's order pages (QA D-112: the customer could not reach them).
 */
export async function platformInvoicesForOrders(orderIds: string[]): Promise<Map<string, Pick<PlatformDeliveryInvoice, "id" | "kind" | "invoiceNumber">[]>> {
  const out = new Map<string, Pick<PlatformDeliveryInvoice, "id" | "kind" | "invoiceNumber">[]>();
  if (!orderIds.length) return out;
  const rows = await db
    .select({ id: platformDeliveryInvoices.id, orderId: platformDeliveryInvoices.orderId, kind: platformDeliveryInvoices.kind, invoiceNumber: platformDeliveryInvoices.invoiceNumber })
    .from(platformDeliveryInvoices)
    .where(and(inArray(platformDeliveryInvoices.orderId, orderIds), eq(platformDeliveryInvoices.status, "ISSUED")));
  for (const { orderId, ...row } of rows) out.set(orderId, [...(out.get(orderId) ?? []), row]);
  return out;
}

/** Link text for one of GoKesari's invoices on an order. */
export const platformInvoiceLabel = (kind: PlatformDeliveryInvoice["kind"]) => (kind === "DELIVERY" ? "Delivery fee invoice (GoKesari)" : "Food invoice (GoKesari)");

/** The customer, and operations, may see it. */
export function canViewDeliveryFeeInvoice(invoice: PlatformDeliveryInvoice, user: { id: string; role: UserRole }): boolean {
  return user.role === "ADMIN" || user.role === "OPERATOR" || invoice.customerId === user.id;
}

/** Admin only: marks the invoice cancelled (the number stays used). */
export async function cancelDeliveryFeeInvoice(id: string, reason: string, actor: { id: string; role: UserRole }): Promise<PlatformDeliveryInvoice> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can cancel an invoice.");
  const why = reason.trim();
  if (why.length < 5) throw validationFailed("Say why the invoice is cancelled.");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(platformDeliveryInvoices).where(eq(platformDeliveryInvoices.id, id)).for("update");
    if (!row) throw notFound("Delivery invoice");
    if (row.status === "CANCELLED") return row;
    const [updated] = await tx
      .update(platformDeliveryInvoices)
      .set({ status: "CANCELLED", cancelledAt: new Date(), cancelReason: why })
      .where(eq(platformDeliveryInvoices.id, id))
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.INVOICE_CANCELLED, entityType: "platform_delivery_invoice", entityId: id, newValue: { reason: why } }, tx);
    return updated;
  });
}

/* ------------------------------------------------------------------- PDF */

const money = (paise: number) => formatPaise(paise).replace("₹", "Rs. ");

export function deliveryInvoiceTextLines(s: DeliveryInvoiceSnapshot, status: "ISSUED" | "CANCELLED" = "ISSUED"): PdfLine[] {
  const W = PDF_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (l: string, r: string) => add(l + r.padStart(Math.max(1, W - l.length)));
  const wrap = (text: string) => {
    let rest = text;
    while (rest.length > W) {
      const cut = rest.lastIndexOf(" ", W);
      const at = cut > 0 ? cut : W;
      add(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    if (rest) add(rest);
  };
  const date = new Date(s.issuedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  add(status === "CANCELLED" ? "TAX INVOICE (CANCELLED)" : "TAX INVOICE", true);
  pair(`Invoice no: ${s.invoiceNumber}`, `Date: ${date}`);
  add(`Order no: ${s.orderNumber}`);
  add("-".repeat(W));
  add("SUPPLIER (electronic commerce operator, s.9(5))", true);
  add(`${s.supplier.legalName}${s.supplier.tradeName && s.supplier.tradeName !== s.supplier.legalName ? ` (${s.supplier.tradeName})` : ""}`);
  wrap(s.supplier.address);
  add(`GSTIN: ${s.supplier.gstin}   State: ${stateLabel(s.supplier.stateCode) ?? s.supplier.stateCode}`);
  add();
  add("RECIPIENT", true);
  add(s.recipient.name);
  wrap(s.recipient.address);
  add(`Place of supply: ${s.placeOfSupply ? (stateLabel(s.placeOfSupply) ?? s.placeOfSupply) : "-"}   Supply: ${s.supplyType === "INTRA" ? "Intra-state" : "Inter-state"}`);
  add("-".repeat(W));
  if (s.onBehalfOf) wrap(`On behalf of: ${s.onBehalfOf.name}${s.onBehalfOf.gstin ? `, GSTIN ${s.onBehalfOf.gstin}` : ""}`);
  pair(`${s.description}  (SAC ${s.sac})`, money(s.feePaise));
  for (const l of s.lines ?? []) pair(`  ${l.description} x ${l.quantity}`.slice(0, W - 14), money(l.grossPaise));
  pair(`Taxable value`, money(s.taxablePaise));
  const rate = `${(s.rateBp / 100).toFixed(s.rateBp % 100 ? 2 : 0)}%`;
  if (s.supplyType === "INTRA") {
    pair(`CGST ${(s.rateBp / 200).toFixed(2)}%`, money(s.cgstPaise));
    pair(`SGST ${(s.rateBp / 200).toFixed(2)}%`, money(s.sgstPaise));
  } else {
    pair(`IGST ${rate}`, money(s.igstPaise));
  }
  pair("Total (inclusive of tax)", money(s.feePaise));
  wrap(amountInWords(s.feePaise));
  add("-".repeat(W));
  for (const n of s.notes) wrap(`Note: ${n}`);
  add();
  add(`For ${s.supplier.legalName}`);
  add("Authorised signatory (electronically issued)");
  return out;
}

export function renderDeliveryFeeInvoicePdf(invoice: PlatformDeliveryInvoice): Buffer {
  const s = invoice.snapshot as unknown as DeliveryInvoiceSnapshot;
  return textPdf(deliveryInvoiceTextLines(s, invoice.status), { title: `Invoice ${s.invoiceNumber}` });
}
