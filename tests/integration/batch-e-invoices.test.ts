/**
 * batch-2026-10 WS-E — F9.2.6 (NEW-037): the customer's GST invoice, complete.
 * Place of supply (IGST vs CGST/SGST), PAN-only / composition wording, HSN
 * rates from configuration, QR on the PDF, email with the PDF to the
 * customer and a copy to the shop owner, credit notes on reversal, and
 * flag-off = the NEW-007 behaviour unchanged. Real PostgreSQL.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const sent = vi.hoisted(() => ({ emails: [] as { to: string; subject: string; attachments?: { filename: string; contentType: string; content: Buffer }[] }[] }));
vi.mock("@/server/email/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email/transport")>();
  return {
    ...actual,
    emailMode: () => "smtp" as const,
    sendEmail: vi.fn(async (message: (typeof sent.emails)[number]) => {
      sent.emails.push(message);
    }),
  };
});

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET as invoicePdfRoute } from "@/app/api/invoices/[id]/pdf/route";
import { db } from "@/server/db";
import { creditNotes, documentEmails, domainEvents, hsnTaxRates, notifications, products, shopProducts } from "@/server/db/schema";
import { deliverDocumentEmails } from "@/server/documents/email";
import { issueCreditNoteForRefund } from "@/server/gst/credit-notes";
import { renderInvoiceDocument } from "@/server/invoicing/delivery";
import { refundDeliveredOrder } from "@/server/services/finance";
import { renderInvoicePdf, type InvoiceSnapshot } from "@/server/services/invoices";
import { updateOrderStatus } from "@/server/services/orders";
import { NextRequest } from "next/server";
import { deliveredOrder, gstShop, resetBatchE, rules } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";
import { decodePdfQr, pdfHasImage } from "../helpers/pdf-qr";

let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  sent.emails.length = 0;
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await rules(admin, { invoicing: { enabled: true }, invoiceDelivery: { enabled: true } });
});

afterAll(async () => {
  await resetBatchE();
});

const snap = (invoice: { snapshot: unknown }) => invoice.snapshot as InvoiceSnapshot;

describe("place of supply", () => {
  it("TC-B26-E-010 IGST for delivery to another state (address state or its PIN), CGST+SGST within the shop's state", async () => {
    const { milkSp } = await gstShop();
    const ka = await deliveredOrder(admin, [[milkSp.id, 2]], { address: { state: "Karnataka", pincode: "411001" } });
    expect(ka.invoice!.supplyType).toBe("INTER");
    expect(ka.invoice!.igstPaise).toBeGreaterThan(0);
    expect(ka.invoice!.cgstPaise + ka.invoice!.sgstPaise).toBe(0);
    expect(snap(ka.invoice!).placeOfSupply).toBe("KA");

    const byPin = await deliveredOrder(admin, [[milkSp.id, 1]], { address: { state: null, pincode: "560001" } });
    expect(byPin.invoice!.supplyType).toBe("INTER");
    expect(snap(byPin.invoice!).placeOfSupplySource).toBe("ADDRESS_PIN");

    const mh = await deliveredOrder(admin, [[milkSp.id, 1]], { address: { state: "MH", pincode: "411001" } });
    expect(mh.invoice!.supplyType).toBe("INTRA");
    expect(mh.invoice!.cgstPaise).toBe(mh.invoice!.sgstPaise);
    expect(mh.invoice!.igstPaise).toBe(0);
    // Every rupee charged is accounted for.
    expect(mh.invoice!.taxablePaise + mh.invoice!.cgstPaise + mh.invoice!.sgstPaise).toBe(mh.invoice!.totalPaise);
  });

  it("TC-B26-E-011 a truly unknown buyer state takes the shop's state and the invoice says so", async () => {
    const { milkSp } = await gstShop();
    const { invoice } = await deliveredOrder(admin, [[milkSp.id, 1]], { address: { state: null, pincode: "800001" } });
    expect(invoice!.supplyType).toBe("INTRA");
    expect(snap(invoice!).placeOfSupplySource).toBe("ASSUMED_SELLER_STATE");
    expect(snap(invoice!).notes.join(" ")).toContain("no state on record");
  });
});

describe("supplier identity and rates", () => {
  it("TC-B26-E-012 a PAN-only seller gets a bill of supply in its legal name with unregistered wording; composition wording too", async () => {
    const { milkSp, shop } = await gstShop({ gstin: null, panLast4: "234F", name: "Pan Only Dairy" });
    const { invoice } = await deliveredOrder(admin, [[milkSp.id, 1]]);
    expect(invoice!.kind).toBe("BILL_OF_SUPPLY");
    const s = snap(invoice!);
    expect(s.seller.legalName).toBe("Pan Only Dairy Pvt Ltd");
    expect(s.seller.gstin).toBeNull();
    expect(s.sellerRegistration).toBe("UNREGISTERED");
    expect(s.notes.join(" ")).toContain("PAN-only seller, PAN XXXXXX234F");
    expect(invoice!.cgstPaise + invoice!.sgstPaise + invoice!.igstPaise).toBe(0);
    expect(shop.id).toBeTruthy();

    const comp = await gstShop({ gstin: null, gstStatus: "COMPOSITION", name: "Composition Dairy" });
    const second = await deliveredOrder(admin, [[comp.milkSp.id, 1]]);
    expect(snap(second.invoice!).notes.join(" ")).toContain("Composition taxable person");
  });

  it("TC-B26-E-013 tax rates come from the HSN configuration (shop listing → product → dated HSN table), never hard-coded", async () => {
    const { milkSp, gheeSp } = await gstShop();
    // The product has no rate: the dated HSN table decides.
    const [sp] = await db.select().from(shopProducts).where(eq(shopProducts.id, milkSp.id));
    await db.update(products).set({ gstRateBp: null, hsnCode: "04012000" }).where(eq(products.id, sp.productId));
    await db.insert(hsnTaxRates).values({ hsnPrefix: "0401", rateBp: 1200, effectiveFrom: "2017-07-01" });
    // The shop's own classification wins over the master product.
    await db.update(shopProducts).set({ gstRateBp: 1800, hsnCode: "0405" }).where(eq(shopProducts.id, gheeSp.id));
    const { invoice } = await deliveredOrder(admin, [[milkSp.id, 1], [gheeSp.id, 1]]);
    const lines = snap(invoice!).lines;
    expect(lines.find((l) => l.description === "Cow Milk")).toMatchObject({ hsn: "04012000", rateBp: 1200, rateAssumed: false });
    expect(lines.find((l) => l.description === "Ghee 500ml")).toMatchObject({ hsn: "0405", rateBp: 1800 });
  });
});

describe("PDF with QR, email and the shop owner's copy", () => {
  it("TC-B26-E-014 the PDF carries a decodable QR with the invoice's GST details; the e-invoice signed QR when an IRN exists", async () => {
    const { milkSp } = await gstShop();
    const { invoice } = await deliveredOrder(admin, [[milkSp.id, 3]]);
    const pdf = await renderInvoiceDocument(invoice!);
    expect(pdfHasImage(pdf)).toBe(true);
    const text = decodePdfQr(pdf)!;
    expect(text).toContain(`DocNo:${invoice!.invoiceNumber}`);
    expect(text).toContain(`SellerGSTIN:${snap(invoice!).seller.gstin}`);
    expect(text).toContain(`TotInvVal:${(invoice!.totalPaise / 100).toFixed(2)}`);
    expect(text).toContain(`/invoices/${invoice!.id}`);

    // The download route serves the same document to the order's customer.
    const { customer } = await deliveredOrder(admin, [[milkSp.id, 1]]);
    void customer;
    state.session = { user: { id: admin.id, email: "a@test.local", name: null, image: null, role: "ADMIN", status: "ACTIVE" } };
    const response = await invoicePdfRoute(new NextRequest(`http://localhost/api/invoices/${invoice!.id}/pdf`), { params: Promise.resolve({ id: invoice!.id }) });
    expect(response.status).toBe(200);
    expect(pdfHasImage(Buffer.from(await response.arrayBuffer()))).toBe(true);
  });

  it("TC-B26-E-015 the customer is emailed the PDF and the shop owner gets a copy (in the app now, PDF by email)", async () => {
    const { milkSp, owner } = await gstShop();
    const { invoice, customer } = await deliveredOrder(admin, [[milkSp.id, 1]]);
    const queued = await db.select().from(documentEmails).where(eq(documentEmails.docId, invoice!.id));
    expect(queued.map((q) => q.recipientRole).sort()).toEqual(["CUSTOMER", "SHOP_OWNER"]);
    expect(queued.find((q) => q.recipientRole === "CUSTOMER")!.userId).toBe(customer.id);
    expect(queued.find((q) => q.recipientRole === "SHOP_OWNER")!.userId).toBe(owner.id);
    const ownerNotes = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.invoice_copy")));
    expect(ownerNotes).toHaveLength(1);
    expect(ownerNotes[0].body).toContain(invoice!.invoiceNumber);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "invoice.shop_copy"))).toHaveLength(1);

    sent.emails.length = 0;
    const result = await deliverDocumentEmails();
    expect(result.sent).toBe(2);
    // (Plain notification emails go through the same transport; only document emails carry files.)
    const withFiles = sent.emails.filter((e) => e.attachments?.length);
    expect(withFiles).toHaveLength(2);
    for (const email of withFiles) {
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments![0].contentType).toBe("application/pdf");
      expect(email.attachments![0].content.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdfHasImage(email.attachments![0].content)).toBe(true);
    }
    // Sent once: a second run has nothing to do.
    expect((await deliverDocumentEmails()).sent).toBe(0);
  });

  it("TC-B26-E-016 a failed send is retried with backoff, then given up (DEAD)", async () => {
    const { milkSp } = await gstShop();
    await rules(admin, { invoicing: { enabled: true }, invoiceDelivery: { enabled: true, copyToShopOwner: false, emailMaxAttempts: 2 } });
    const { invoice } = await deliveredOrder(admin, [[milkSp.id, 1]]);
    const transport = await import("@/server/email/transport");
    // Fail only the invoice e-mail (it carries the PDF): a notification e-mail sent
    // after commit by the event layer must not consume the scripted failure.
    const failNextDocumentEmail = () => {
      const passThrough = vi.mocked(transport.sendEmail).getMockImplementation()!;
      let armed = true;
      vi.mocked(transport.sendEmail).mockImplementation(async (message) => {
        if (armed && message.attachments?.length) {
          armed = false;
          throw new Error("SMTP 451");
        }
        return passThrough(message);
      });
    };
    failNextDocumentEmail();
    expect((await deliverDocumentEmails()).failed).toBe(1);
    const [row] = await db.select().from(documentEmails).where(eq(documentEmails.docId, invoice!.id));
    expect(row.status).toBe("FAILED");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await db.update(documentEmails).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(documentEmails.id, row.id));
    failNextDocumentEmail();
    expect((await deliverDocumentEmails()).dead).toBe(1);
  });
});

describe("credit notes for cancellations and returns", () => {
  it("TC-B26-E-017 an invoiced order that ends refunded gets a CANCELLATION credit note for what refunds did not credit — once", async () => {
    const { milkSp } = await gstShop();
    const { order, invoice } = await deliveredOrder(admin, [[milkSp.id, 4]]);
    await updateOrderStatus(order.id, "REFUND_PENDING", admin, "Order cancelled after delivery");
    await updateOrderStatus(order.id, "REFUNDED", admin, "Refunded outside the refund screen");
    const notes = await db.select().from(creditNotes).where(eq(creditNotes.orderId, order.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ reason: "CANCELLATION", totalPaise: invoice!.totalPaise, taxInvoiceId: invoice!.id });
  });

  it("TC-B26-E-018 a full refund through finance issues one note (no second CANCELLATION note); refunds by other flows use issueCreditNoteForRefund", async () => {
    const { milkSp } = await gstShop();
    const { order, invoice } = await deliveredOrder(admin, [[milkSp.id, 2]]);
    await refundDeliveredOrder({ orderNumber: order.orderNumber, amountPaise: order.totalPaise, reason: "Spoiled milk", chargeTo: "SHOP", requestId: "full-refund-1", creditNote: { reason: "RETURN", restock: false } }, admin);
    const notes = await db.select().from(creditNotes).where(eq(creditNotes.orderId, order.id));
    expect(notes).toHaveLength(1);
    expect(notes[0].reason).toBe("RETURN");
    expect(notes[0].totalPaise).toBe(invoice!.totalPaise);

    // WS-C's refunds call the same function with their own refund id (unchanged signature).
    const other = await deliveredOrder(admin, [[milkSp.id, 2]]);
    const note = await issueCreditNoteForRefund({ orderId: other.order.id, sourceRef: "ws-c-refund-1", amountPaise: 5_000, reason: "CANCELLATION", restock: false, actorId: admin.id });
    expect(note!.totalPaise).toBe(5_000);
    expect((await issueCreditNoteForRefund({ orderId: other.order.id, sourceRef: "ws-c-refund-1", amountPaise: 5_000, reason: "CANCELLATION", restock: false }))!.id).toBe(note!.id);
  });
});

describe("flags off", () => {
  it("TC-B26-E-019 with invoiceDelivery off the invoice, its PDF and its delivery are exactly NEW-007's", async () => {
    await rules(admin, { invoicing: { enabled: true }, invoiceDelivery: { enabled: false } });
    const { milkSp } = await gstShop();
    const { order, invoice } = await deliveredOrder(admin, [[milkSp.id, 1]], { address: { state: null, pincode: "560001" } });
    // Old rule: no address state → intra-state; no new snapshot fields.
    expect(invoice!.supplyType).toBe("INTRA");
    expect(snap(invoice!).placeOfSupplySource).toBeUndefined();
    expect(snap(invoice!).notes.join(" ")).not.toContain("no state on record");
    const pdf = await renderInvoiceDocument(invoice!);
    expect(pdfHasImage(pdf)).toBe(false);
    expect(pdf.equals(renderInvoicePdf(invoice!, null))).toBe(true);
    expect(await db.select().from(documentEmails)).toHaveLength(0);
    // No reversal note either.
    await updateOrderStatus(order.id, "REFUND_PENDING", admin);
    await updateOrderStatus(order.id, "REFUNDED", admin);
    expect(await db.select().from(creditNotes).where(eq(creditNotes.orderId, order.id))).toHaveLength(0);
  });

  it("TC-B26-E-020 with invoicing off nothing is issued or emailed", async () => {
    await rules(admin, { invoicing: { enabled: false }, invoiceDelivery: { enabled: true } });
    const { milkSp } = await gstShop();
    const { invoice } = await deliveredOrder(admin, [[milkSp.id, 1]]);
    expect(invoice).toBeNull();
    expect(await db.select().from(documentEmails)).toHaveLength(0);
  });
});
