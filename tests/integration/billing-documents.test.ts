/**
 * Billing v2 phase 2 (docs/billing §4, §5.2): checkout guard and B2B GSTIN,
 * the invoice's ECO / buyer fields, GSTR-1 Table 14 and cancelled invoices,
 * GoKesari's s.9(5) delivery-fee invoice, line-wise credit notes on returns,
 * the shop's own documents, and the receipt / JSON / UPI outputs. Runs on both
 * database layouts (shops, counter sales and shop documents are seller-side;
 * orders, invoices and delivery invoices customer-side).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  accDocuments,
  accLedgerEntries,
  addresses,
  featureFlags,
  invStockLedger,
  orderItems,
  orders,
  platformDeliveryInvoices,
  returnItems,
  returnRequests,
  shops,
  taxInvoices,
  type FeatureFlagKey,
} from "@/server/db/schema";
import { cancelDocument, createDocument, documentNumber, documentPdf } from "@/server/accounts/documents";
import { billingReport } from "@/server/accounts/billing-reports";
import { counterBillKind, createSalesInvoice, salesInvoicePdf } from "@/server/accounts/sales";
import { updateSettings } from "@/server/accounts/books";
import { issueCreditNoteForRefund, returnedLineWeights } from "@/server/gst/credit-notes";
import { buildGstr1 } from "@/server/gst/gstr1";
import { counterBillShareText, invoiceJson, invoiceShareText, renderInvoiceReceipt, salesReceiptPdf, upiPaymentUri, whatsappShareUrl } from "@/server/invoicing/outputs";
import { addToCart } from "@/server/services/cart";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { invoiceKindsForOrders, invoiceTextLines, orderInvoiceLabel, paidHow, type InvoiceSnapshot } from "@/server/services/invoices";
import { deliveryInvoiceNumber, platformInvoiceLabel, platformInvoicesForOrders, renderDeliveryFeeInvoicePdf } from "@/server/tax/delivery-invoice";
import { formatPaise } from "@/lib/money";
import { cancelTaxInvoice } from "@/server/tax/invoice-cancel";
import { deliveredOrder, gstin, gstShop, resetBatchE, rules } from "../helpers/batch-e";
import { createUser, createUserWithWallet, resetDatabase } from "../helpers/fixtures";

/** The database's own message (drizzle wraps it as the error's cause). */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  }
  return "did not fail";
}

async function flag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
}

let seq = 0;
/** Checks out (does not deliver) one line to an address in `state` / `pincode`. */
async function checkoutTo(spId: string, address: { state: string | null; pincode: string }, extra: { buyerGstin?: string } = {}) {
  const { user } = await createUserWithWallet({ balancePaise: 50_000_000 });
  const [addr] = await db.insert(addresses).values({ userId: user.id, line1: "1 Road", city: "City", pincode: address.pincode, state: address.state, isDefault: true, addressType: "HOME" }).returning();
  await addToCart(user.id, spId, 1);
  seq += 1;
  return checkout({ userId: user.id, addressId: addr.id, requestId: `bv2-${Date.now()}-${seq}`, ...extra });
}

const DELIVERED = ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const;

describe("billing v2 — documents", () => {
  let admin: { id: string; role: "ADMIN" };

  beforeEach(async () => {
    await resetDatabase();
    await resetBatchE();
    await db.execute(sql`DELETE FROM feature_flags WHERE key IN ('billing_v2', 'delivery_9_5')`);
    const a = await createUser({ role: "ADMIN" });
    admin = { id: a.id, role: "ADMIN" };
    await rules(admin, { invoicing: { enabled: true } });
  });

  describe("checkout guard (§3.3)", () => {
    it("blocks a composition shop delivering to another state, allows its own state", async () => {
      await flag("billing_v2", true);
      const { shop, milkSp } = await gstShop({ gstStatus: "COMPOSITION" });
      await expect(checkoutTo(milkSp.id, { state: "KA", pincode: "560001" })).rejects.toThrow(/only within its own state/);
      await expect(checkoutTo(milkSp.id, { state: "MH", pincode: "411001" })).resolves.toBeTruthy();
      expect(shop.id).toBeTruthy();
    });

    it("blocks an Enrolment-ID shop inter-state, and any shop whose GSTIN is cancelled on the portal", async () => {
      await flag("billing_v2", true);
      const { shop, milkSp } = await gstShop({ gstin: null });
      await db.update(shops).set({ gstRegistrationType: "ENROLMENT_ID", gstEnrolmentId: "271234567890EID", gstStateCode: "27" }).where(eq(shops.id, shop.id));
      await expect(checkoutTo(milkSp.id, { state: null, pincode: "560001" })).rejects.toThrow(/only within its own state/);
      const regular = await gstShop({ name: "Regular Dairy" });
      await db.update(shops).set({ gstPortalStatus: "CANCELLED" }).where(eq(shops.id, regular.shop.id));
      await expect(checkoutTo(regular.milkSp.id, { state: "MH", pincode: "411001" })).rejects.toThrow(/cannot take new orders/);
    });

    it("changes nothing while billing_v2 is off", async () => {
      const { milkSp } = await gstShop({ gstStatus: "COMPOSITION" });
      await expect(checkoutTo(milkSp.id, { state: "KA", pincode: "560001" })).resolves.toBeTruthy();
    });
  });

  describe("B2B GSTIN at checkout and the invoice (§4.3, §4.4, G11)", () => {
    it("stores a verified GSTIN, makes the invoice B2B with the ECO's GSTIN, and GSTR-1 reports it", async () => {
      await flag("billing_v2", true);
      const { shop, milkSp } = await gstShop();
      const buyer = gstin("27", "AAACH1234K");
      const { orders: [order] } = await checkoutTo(milkSp.id, { state: "MH", pincode: "411001" }, { buyerGstin: buyer.toLowerCase() });
      expect(order).toMatchObject({ buyerGstin: buyer, buyerGstinStatus: "VERIFIED" });
      expect(order.buyerLegalName).toMatch(/MOCK TRADERS/);
      for (const s of DELIVERED) await updateOrderStatus(order.id, s, admin);
      const [inv] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, order.id));
      const snap = inv.snapshot as unknown as InvoiceSnapshot;
      expect(snap.buyer).toMatchObject({ gstin: buyer, name: order.buyerLegalName });
      expect(snap.billingV2).toBe(true);
      expect(snap.eco?.gstin).toMatch(/^\d{2}[A-Z0-9]{13}$/);
      expect(snap.notes.join(" ")).toMatch(/electronic commerce operator/);
      const period = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
      const g = await buildGstr1(shop.id, period);
      expect((g.json.b2b as { ctin: string }[]).map((b) => b.ctin)).toEqual([buyer]);
      expect(g.json.supeco).toEqual({ clttx: [expect.objectContaining({ etin: snap.eco!.gstin, suppval: inv.taxablePaise / 100 })] });
    });

    it("refuses a malformed GSTIN, a cancelled one, and any GSTIN while billing_v2 is off", async () => {
      const { milkSp } = await gstShop();
      await expect(checkoutTo(milkSp.id, { state: "MH", pincode: "411001" }, { buyerGstin: gstin("27", "AAACH1234K") })).rejects.toThrow(/not available/);
      await flag("billing_v2", true);
      await expect(checkoutTo(milkSp.id, { state: "MH", pincode: "411001" }, { buyerGstin: "27AAACH1234K1Z1" })).rejects.toThrow(/not a valid GSTIN/);
      // The mock GST portal says entity "9999" is cancelled.
      await expect(checkoutTo(milkSp.id, { state: "MH", pincode: "411001" }, { buyerGstin: gstin("27", "AAACH9999K") })).rejects.toThrow(/cancelled/);
    });
  });

  describe("invoice cancellation and immutability (§4.2)", () => {
    it("marks the invoice cancelled, keeps its number, and GSTR-1 counts it as cancelled", async () => {
      await flag("billing_v2", true);
      const { shop, milkSp } = await gstShop();
      const { invoice } = await deliveredOrder(admin, [[milkSp.id, 2]]);
      expect(await failure(db.update(taxInvoices).set({ totalPaise: 1 }).where(eq(taxInvoices.id, invoice!.id)))).toMatch(/cannot be changed/);
      expect(await failure(db.delete(taxInvoices).where(eq(taxInvoices.id, invoice!.id)))).toMatch(/cannot be deleted/);
      const cancelled = await cancelTaxInvoice(invoice!.id, "Raised on the wrong order", admin);
      expect(cancelled).toMatchObject({ status: "CANCELLED", invoiceNumber: invoice!.invoiceNumber, cancelReason: "Raised on the wrong order" });
      expect(await failure(db.update(taxInvoices).set({ cancelReason: "changed" }).where(eq(taxInvoices.id, invoice!.id)))).toMatch(/cannot be changed/);
      const g = await buildGstr1(shop.id, new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7));
      expect(g.json.b2cs).toEqual([]);
      expect((g.json.doc_issue as { doc_det: { docs: { totnum: number; cancel: number; net_issue: number }[] }[] }).doc_det[0].docs[0]).toMatchObject({ totnum: 1, cancel: 1, net_issue: 0 });
    });

    it("refuses to cancel an invoice that already has a credit note; only an admin may cancel", async () => {
      const { milkSp } = await gstShop();
      const { order, invoice } = await deliveredOrder(admin, [[milkSp.id, 2]]);
      await expect(cancelTaxInvoice(invoice!.id, "wrong order", { id: admin.id, role: "OPERATOR" })).rejects.toThrow(/Only an admin/);
      await issueCreditNoteForRefund({ orderId: order.id, sourceRef: "r-1", amountPaise: 5_000, reason: "REFUND", restock: false });
      await expect(cancelTaxInvoice(invoice!.id, "wrong order", admin)).rejects.toThrow(/credit note/);
    });
  });

  describe("GoKesari's s.9(5) delivery-fee invoice (§5.2)", () => {
    it("is issued at delivery in GoKesari's GSTIN, numbered gaplessly, and cannot be changed", async () => {
      await flag("billing_v2", true);
      await flag("delivery_9_5", true);
      await rules(admin, { billing: { deliveryInvoicePrefix: "GKS" } });
      const { milkSp } = await gstShop();
      const issued = [];
      for (let i = 0; i < 2; i += 1) {
        const { orders: [order] } = await checkoutTo(milkSp.id, { state: "MH", pincode: "411001" });
        await db.update(orders).set({ deliveryFeePaise: 2_100 }).where(eq(orders.id, order.id));
        for (const s of DELIVERED) await updateOrderStatus(order.id, s, admin);
        const [inv] = await db.select().from(platformDeliveryInvoices).where(eq(platformDeliveryInvoices.orderId, order.id));
        issued.push(inv);
      }
      const fy = issued[0].financialYear;
      expect(issued.map((i) => i.invoiceNumber)).toEqual([deliveryInvoiceNumber("GKS", fy, 1), deliveryInvoiceNumber("GKS", fy, 2)]);
      expect(issued[0].invoiceNumber.length).toBeLessThanOrEqual(16);
      expect(issued[0]).toMatchObject({ rateBp: 500, feePaise: 2_100, taxablePaise: 2_000, cgstPaise: 50, sgstPaise: 50, supplyType: "INTRA", status: "ISSUED" });
      const pdf = renderDeliveryFeeInvoicePdf(issued[0]).toString("latin1");
      expect(pdf).toContain("9\\(5\\)");
      expect(pdf).toContain("Input tax credit has not been taken");
      expect(await failure(db.update(platformDeliveryInvoices).set({ feePaise: 1 }).where(eq(platformDeliveryInvoices.id, issued[0].id)))).toMatch(/cannot be changed/);
      // QA D-112: the customer's order pages list it.
      const listed = await platformInvoicesForOrders([issued[0].orderId]);
      expect(listed.get(issued[0].orderId)).toEqual([{ id: issued[0].id, kind: "DELIVERY", invoiceNumber: issued[0].invoiceNumber }]);
      expect(platformInvoiceLabel("DELIVERY")).toBe("Delivery fee invoice (GoKesari)");
    });

    it("is not issued for a pickup or when delivery_9_5 is off", async () => {
      await flag("billing_v2", true);
      const { milkSp } = await gstShop();
      const { orders: [order] } = await checkoutTo(milkSp.id, { state: "MH", pincode: "411001" });
      await db.update(orders).set({ deliveryFeePaise: 2_100 }).where(eq(orders.id, order.id));
      for (const s of DELIVERED) await updateOrderStatus(order.id, s, admin);
      expect(await db.select().from(platformDeliveryInvoices)).toEqual([]);
    });
  });

  describe("credit note on a return credits the returned lines only (§4.5)", () => {
    it("weights by quantity returned, per listing", () => {
      const lines = [
        { grossPaise: 21_000, shopProductId: "a", qty: 2 },
        { grossPaise: 33_600, shopProductId: "b", qty: 1 },
      ];
      expect(returnedLineWeights(lines, [{ shopProductId: "a", quantityMilli: 1000 }])).toEqual([10_500, 0]);
      expect(returnedLineWeights(lines, [{ shopProductId: "a", quantityMilli: 5000 }, { shopProductId: "b", quantityMilli: 1000 }])).toEqual([21_000, 33_600]);
      expect(returnedLineWeights(lines, [{ shopProductId: "zz", quantityMilli: 1000 }])).toBeNull();
    });

    it("issues a note for the returned milk only, capped at its value", async () => {
      await flag("billing_v2", true);
      const { shop, milkSp, gheeSp } = await gstShop();
      const { order, invoice, customer } = await deliveredOrder(admin, [[milkSp.id, 2], [gheeSp.id, 1]]);
      const [milkItem] = await db.select().from(orderItems).where(and(eq(orderItems.orderId, order.id), eq(orderItems.shopProductId, milkSp.id)));
      const [ret] = await db
        .insert(returnRequests)
        .values({ returnNumber: "R-1", orderId: order.id, userId: customer.id, shopId: shop.id, reason: "DAMAGED", refundAmountPaise: 10_500, chargeTo: "SHOP" } as typeof returnRequests.$inferInsert)
        .returning();
      await db.insert(returnItems).values({ returnId: ret.id, orderItemId: milkItem.id, quantityMilli: 1000, condition: "DAMAGED", refundPaise: 10_500 } as typeof returnItems.$inferInsert);
      // The refund asks for more than the milk was worth: only the milk's value is credited.
      const note = await issueCreditNoteForRefund({ orderId: order.id, sourceRef: "ret-1", amountPaise: 30_000, reason: "RETURN", restock: true, returnId: ret.id });
      const lines = (note!.snapshot as unknown as { lines: { shopProductId: string; grossPaise: number }[] }).lines;
      expect(lines.map((l) => l.shopProductId)).toEqual([milkSp.id]);
      expect(note!.totalPaise).toBe(10_500);
      expect(invoice).toBeTruthy();
    });
  });

  describe("the shop's own documents (§4.1)", () => {
    it("credit note with restock, debit note, receipt and refund vouchers, challan, estimate — numbered, posted, cancellable", async () => {
      await flag("billing_v2", true);
      const { owner, shop, milkSp } = await gstShop();
      const sale = await createSalesInvoice(shop.id, { paymentMode: "CASH", lines: [{ shopProductId: milkSp.id, description: "Cow Milk", hsn: "0401", qtyMilli: 4000, unit: "L", ratePaise: 5_000, gstRateBp: 500 }] }, owner);
      const before = await db.select({ q: sql<number>`coalesce(sum(qty_milli), 0)::int` }).from(invStockLedger).where(eq(invStockLedger.shopProductId, milkSp.id));

      const cn = await createDocument(shop.id, { kind: "CREDIT_NOTE", againstSalesId: sale.id, reason: "1 L returned", restock: true, lines: [{ shopProductId: milkSp.id, description: "Cow Milk", hsn: "0401", qtyMilli: 1000, unit: "L", ratePaise: 5_000, gstRateBp: 500 }] }, owner);
      expect(cn).toMatchObject({ docNo: documentNumber("CREDIT_NOTE", cn.fy, 1), taxablePaise: 5_000, cgstPaise: 125, sgstPaise: 125, totalPaise: 5_250, status: "ISSUED" });
      const after = await db.select({ q: sql<number>`coalesce(sum(qty_milli), 0)::int` }).from(invStockLedger).where(eq(invStockLedger.shopProductId, milkSp.id));
      expect(after[0].q - before[0].q).toBe(1000);
      const legs = await db.select().from(accLedgerEntries).where(eq(accLedgerEntries.sourceId, cn.id));
      expect(legs.reduce((s, l) => s + l.debitPaise - l.creditPaise, 0)).toBe(0);
      expect(legs.find((l) => l.account === "SALES")?.debitPaise).toBe(5_000);
      // Never more than the invoice.
      await expect(createDocument(shop.id, { kind: "CREDIT_NOTE", againstSalesId: sale.id, lines: [{ description: "Too much", qtyMilli: 1000, ratePaise: 50_000, gstRateBp: 0 }] }, owner)).rejects.toThrow(/exceed the invoice/);

      const dn = await createDocument(shop.id, { kind: "DEBIT_NOTE", againstSalesId: sale.id, reason: "Price revised", lines: [{ description: "Price difference", qtyMilli: 1000, ratePaise: 1_000, gstRateBp: 500 }] }, owner);
      expect(dn.docNo).toBe(documentNumber("DEBIT_NOTE", dn.fy, 1));

      const rv = await createDocument(shop.id, { kind: "RECEIPT_VOUCHER", buyerName: "Hotel Sunrise", paymentMode: "UPI", lines: [{ description: "Advance for catering", qtyMilli: 1000, ratePaise: 10_000, gstRateBp: 1800 }] }, owner);
      expect(rv.totalPaise).toBe(11_800);
      await expect(createDocument(shop.id, { kind: "REFUND_VOUCHER", againstDocumentId: rv.id, paymentMode: "UPI", lines: [{ description: "Refund", qtyMilli: 1000, ratePaise: 20_000, gstRateBp: 1800 }] }, owner)).rejects.toThrow(/more than what is left/);
      const rf = await createDocument(shop.id, { kind: "REFUND_VOUCHER", againstDocumentId: rv.id, paymentMode: "UPI", lines: [{ description: "Refund", qtyMilli: 1000, ratePaise: 10_000, gstRateBp: 1800 }] }, owner);
      await expect(cancelDocument(shop.id, rv.id, "mistake", owner)).rejects.toThrow(/cancel the refund first/);

      const dc = await createDocument(shop.id, { kind: "DELIVERY_CHALLAN", buyerName: "Branch", lines: [{ description: "Ghee crates", qtyMilli: 2000, ratePaise: 30_000, gstRateBp: 1200 }] }, owner);
      const es = await createDocument(shop.id, { kind: "ESTIMATE", buyerName: "Hotel Sunrise", lines: [{ description: "Milk 100 L", qtyMilli: 100_000, ratePaise: 5_000, gstRateBp: 500 }] }, owner);
      expect(await db.select().from(accLedgerEntries).where(eq(accLedgerEntries.sourceId, dc.id))).toEqual([]);
      expect(await db.select().from(accLedgerEntries).where(eq(accLedgerEntries.sourceId, es.id))).toEqual([]);
      expect((await documentPdf(shop.id, dc.id)).bytes.toString("latin1")).toContain("Rule 55");

      // Cancelling a credit note puts the stock and the books back; the number stays used.
      await cancelDocument(shop.id, cn.id, "entered twice", owner);
      const restored = await db.select({ q: sql<number>`coalesce(sum(qty_milli), 0)::int` }).from(invStockLedger).where(eq(invStockLedger.shopProductId, milkSp.id));
      expect(restored[0].q).toBe(before[0].q);
      const all = await db.select().from(accLedgerEntries).where(eq(accLedgerEntries.sourceId, cn.id));
      expect(all.filter((l) => l.account === "SALES").reduce((s, l) => s + l.debitPaise - l.creditPaise, 0)).toBe(0);
      const cn2 = await createDocument(shop.id, { kind: "CREDIT_NOTE", againstSalesId: sale.id, lines: [{ description: "Rate cut", qtyMilli: 1000, ratePaise: 1_000, gstRateBp: 500 }] }, owner);
      expect(cn2.docNo).toBe(documentNumber("CREDIT_NOTE", cn2.fy, 2));
      expect(await failure(db.update(accDocuments).set({ totalPaise: 1 }).where(eq(accDocuments.id, cn2.id)))).toMatch(/cannot be changed/);
      expect(rf.status).toBe("ISSUED");
    });
  });

  describe("outputs (§4.6)", () => {
    it("thermal receipt, JSON, UPI QR on a counter bill, WhatsApp link", async () => {
      await flag("billing_v2", true);
      const { owner, shop, milkSp } = await gstShop();
      const { invoice } = await deliveredOrder(admin, [[milkSp.id, 2]]);
      const receipt = (await renderInvoiceReceipt(invoice!)).toString("latin1");
      expect(receipt).toContain("/MediaBox [0 0 226.77");
      expect(receipt).toContain("/QR1 Do");
      const json = await invoiceJson(invoice!);
      expect(json).toMatchObject({ schema: "gokesari.invoice/1", number: invoice!.invoiceNumber, totals: expect.objectContaining({ totalPaise: invoice!.totalPaise }) });

      expect(upiPaymentUri({ vpa: "dairy@okhdfcbank", payeeName: "Dairy GST", amountPaise: 12_345, note: "Invoice S2627-1" })).toBe("upi://pay?pa=dairy%40okhdfcbank&pn=Dairy%20GST&am=123.45&cu=INR&tn=Invoice%20S2627-1");
      expect(whatsappShareUrl("Invoice https://gokesari.com/invoices/x")).toBe("https://wa.me/?text=Invoice%20https%3A%2F%2Fgokesari.com%2Finvoices%2Fx");

      await expect(updateSettings(shop.id, { upiVpa: "not a vpa" }, owner.id)).rejects.toThrow(/UPI id/);
      await updateSettings(shop.id, { upiVpa: "dairy@okhdfcbank" }, owner.id);
      const sale = await createSalesInvoice(shop.id, { paymentMode: "UPI", lines: [{ description: "Cow Milk", qtyMilli: 1000, ratePaise: 5_000, gstRateBp: 500 }] }, owner);
      const bill = (await salesReceiptPdf(shop.id, sale.id)).bytes.toString("latin1");
      expect(bill).toContain("/QR1 Do");
      expect(bill).toContain("dairy@okhdfcbank");
      expect(counterBillShareText({ kind: "TAX_INVOICE", invoiceNo: sale.invoiceNo, invoiceDate: sale.invoiceDate, shopName: "Dairy GST", totalPaise: sale.totalPaise, upiVpa: "dairy@okhdfcbank" })).toMatch(
        new RegExp(`^Tax invoice ${sale.invoiceNo} from Dairy GST, .*Pay by UPI to dairy@okhdfcbank\\.$`),
      );
    });

    it("a shop outside GST: bill of supply on the counter bill, its receipt, its PDF and the MTR; the order's bill has no s.52 or GST-inclusive note and names an online payment (QA D-113, D-116, D-117)", async () => {
      await flag("billing_v2", true);
      const { owner, shop, milkSp } = await gstShop({ gstin: null });
      const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
      expect(counterBillKind(row)).toBe("BILL_OF_SUPPLY");
      const sale = await createSalesInvoice(shop.id, { paymentMode: "CASH", lines: [{ description: "Bread", qtyMilli: 1000, ratePaise: 4_000, gstRateBp: 0 }] }, owner);
      expect((await salesReceiptPdf(shop.id, sale.id)).bytes.toString("latin1")).toContain("BILL OF SUPPLY");
      const a4 = (await salesInvoicePdf(shop.id, sale.id)).bytes.toString("latin1");
      expect(a4).toContain("BILL OF SUPPLY");
      expect(a4).not.toContain("TAX INVOICE");
      const day = sale.invoiceDate;
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const mtr = await billingReport(shop.id, "mtr", day, next, "");
      expect(mtr.rows.filter((r) => r[2] === sale.invoiceNo).map((r) => r[1])).toEqual(["Bill of supply"]);

      const { invoice } = await deliveredOrder(admin, [[milkSp.id, 2]]);
      const s = invoice!.snapshot as unknown as InvoiceSnapshot;
      expect(s.kind).toBe("BILL_OF_SUPPLY");
      expect(s.notes.join(" ")).not.toMatch(/section 52|inclusive of GST/);
      expect(invoiceShareText(s)).toBe(`Bill of supply ${s.invoiceNumber} from ${s.seller.name} for order ${s.orderNumber}: ${formatPaise(s.totals.totalPaise)}.`);
      expect([paidHow("ONLINE"), paidHow("COD"), paidHow("WALLET")]).toEqual(["online payment", "cash on delivery", "GoKesari wallet"]);
      expect(invoiceTextLines({ ...s, payment: { ...s.payment, method: "ONLINE" } }).map((l) => l.text).join("\n")).toContain("Paid by customer (online payment)");
      expect((await invoiceKindsForOrders([invoice!.orderId])).get(invoice!.orderId)).toBe("BILL_OF_SUPPLY");
      expect(orderInvoiceLabel("BILL_OF_SUPPLY")).toBe("Bill of supply");
    });
  });
});
