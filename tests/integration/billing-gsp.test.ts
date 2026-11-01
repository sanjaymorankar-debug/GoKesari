/**
 * Billing v2 phase 6 (docs/billing §9; §13 scenarios 13, 14, 15): the shop's
 * returns on the GST portal through the GSP (mock) — prepare, save, compare,
 * file with EVC — GSTR-3B with the TCS credit, CMP-08, IMS, the cash ledger,
 * session expiry and reminders, GSP down → retries and the fallback, IRN
 * cancel within 24 hours and the 30-day rule, a credit note's IRN, and e-way
 * bill Part B / extend / cancel. Both layouts.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { einvoiceRecords, ewayBills, featureFlags, gspCallLog, gstFilings, gstPortalLinks, gstRules, imsActions, notifications, taxInvoices } from "@/server/db/schema";
import { requestLinkOtp, verifyLinkOtp } from "@/server/accounts/gst";
import { MOCK_GST_OTP } from "@/server/accounts/gst-returns-provider";
import { declareEinvoice } from "@/server/gst/config";
import { issueCreditNoteForRefund } from "@/server/gst/credit-notes";
import { generateEwayBill, requestEinvoice } from "@/server/gst/einvoice";
import { cancelEinvoice, cancelEwayBill, extendEwayBill, requestCreditNoteEinvoice, updateEwayPartB } from "@/server/gst/einvoice-extras";
import { resetMockGsp } from "@/server/gst/gsp/mock";
import { GspError } from "@/server/gst/gsp/types";
import { resetMockFiling, setGstFilingProviderForTests, type GstFilingProvider } from "@/server/gsp/filing-provider";
import { decideIms, fileWithEvc, imsInward, portalLedgers, prepareReturn, requestFilingOtp, saveToPortal, sendGstSessionReminders } from "@/server/gsp/returns";
import { deliveredOrder, gstin, GOKESARI_GSTIN, gstShop, IST_TODAY, resetBatchE, rules } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

const today = IST_TODAY();
const month = today.slice(0, 7);
let admin = { id: "", role: "ADMIN" as const };

async function linked(shopId: string, ownerId: string, gst: string) {
  await requestLinkOtp(shopId, { gstin: gst, username: "dairy", consent: true }, ownerId);
  await verifyLinkOtp(shopId, MOCK_GST_OTP, ownerId);
}

async function rule(key: string, value: unknown, from = "2017-07-01") {
  await db.insert(gstRules).values({ key, value, effectiveFrom: from, effectiveTo: null });
}

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  await db.delete(gstRules);
  resetMockGsp();
  resetMockFiling();
  setGstFilingProviderForTests(null);
  await db.execute(sql`DELETE FROM gsp_call_log`);
  for (const key of ["billing_v2", "einvoice", "ewaybill"] as const) await db.insert(featureFlags).values({ key, enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await rules(admin, {
    invoicing: { enabled: true },
    platformTaxProfile: { legalName: "GoKesari Technologies Pvt Ltd", tradeName: "GoKesari", gstin: GOKESARI_GSTIN, pan: "AABCG1234K", address: "1 MG Road, Bengaluru 560001", stateCode: "KA" },
  });
});

afterEach(() => setGstFilingProviderForTests(null));

describe("GSTR-1 on the portal (scenario 13)", () => {
  it("prepares from the books, saves, matches the portal's totals, files with EVC; a filed return is final", async () => {
    const s = await gstShop();
    await deliveredOrder(admin, [[s.milkSp.id, 4]]);
    await linked(s.shop.id, s.owner.id, s.shop.gstin!);
    const prepared = await prepareReturn(s.shop.id, "GSTR1", month);
    expect(prepared).toMatchObject({ status: "PREPARED" });
    const saved = await saveToPortal(s.shop.id, prepared.id, s.owner.id);
    expect(saved.status).toBe("SAVED");
    expect(saved.portalSummary).toEqual(saved.ourSummary);
    const { requestId } = await requestFilingOtp(s.shop.id, prepared.id, s.owner.id);
    await expect(fileWithEvc(s.shop.id, prepared.id, requestId, "111111", s.owner.id)).rejects.toThrow(/Wrong OTP/);
    const filed = await fileWithEvc(s.shop.id, prepared.id, requestId, MOCK_GST_OTP, s.owner.id);
    expect(filed).toMatchObject({ status: "FILED", arn: expect.stringMatching(/^AA27/) });
    await expect(prepareReturn(s.shop.id, "GSTR1", month)).rejects.toThrow(/already filed/);
    const calls = await db.select().from(gspCallLog).where(eq(gspCallLog.shopId, s.shop.id));
    expect(calls.map((c) => c.operation)).toEqual(expect.arrayContaining(["save:GSTR1", "summary:GSTR1", "evc-otp:GSTR1", "file:GSTR1"]));
  });

  it("GSTR-3B carries the outward tax and the TCS credit; IFF has only B2B", async () => {
    const s = await gstShop();
    await deliveredOrder(admin, [[s.milkSp.id, 4]]);
    const g3b = await prepareReturn(s.shop.id, "GSTR3B", month);
    expect((g3b.payload as { sup_details: { osup_det: { camt: number } } }).sup_details.osup_det.camt).toBeGreaterThan(0);
    expect(g3b.payload).toHaveProperty("tcs_credit");
    const iff = await prepareReturn(s.shop.id, "IFF", month);
    expect(Object.keys(iff.payload).sort()).toEqual(["b2b", "cdnr", "fp", "gstin", "note"]);
  });

  it("CMP-08: a composition shop's quarterly turnover at the composition rate", async () => {
    const s = await gstShop({ gstStatus: "COMPOSITION" });
    await deliveredOrder(admin, [[s.milkSp.id, 4]]); // ₹420
    const [y, m] = month.split("-").map(Number);
    const fy = m >= 4 ? y : y - 1;
    const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
    const cmp = await prepareReturn(s.shop.id, "CMP08", `${fy}-${String((fy + 1) % 100).padStart(2, "0")}-Q${q}`);
    expect((cmp.payload as { outward: { turnover: number; rate: number; camt: number; samt: number } }).outward).toEqual({ turnover: 420, rate: 1, camt: 2.1, samt: 2.1 });
    const regular = await gstShop({ name: "Regular" });
    await expect(prepareReturn(regular.shop.id, "CMP08", `${fy}-${String((fy + 1) % 100).padStart(2, "0")}-Q${q}`)).rejects.toThrow(/composition/);
  });
});

describe("session expiry and GSP down (scenario 15)", () => {
  it("an expired session asks the owner to link again; owners are reminded before it ends", async () => {
    const s = await gstShop();
    await linked(s.shop.id, s.owner.id, s.shop.gstin!);
    const prepared = await prepareReturn(s.shop.id, "GSTR1", month);
    await db.update(gstPortalLinks).set({ tokenExpiresAt: new Date(Date.now() + 3600_000) }).where(eq(gstPortalLinks.shopId, s.shop.id));
    expect((await sendGstSessionReminders(6)).sent).toBe(1);
    const reminder = await db.select().from(notifications).where(eq(notifications.userId, s.owner.id));
    expect(reminder.some((n) => /GST portal link/.test(n.title))).toBe(true);
    await db.update(gstPortalLinks).set({ tokenExpiresAt: new Date(Date.now() - 60_000) }).where(eq(gstPortalLinks.shopId, s.shop.id));
    await expect(saveToPortal(s.shop.id, prepared.id, s.owner.id)).rejects.toThrow(/expired/);
    const [link] = await db.select().from(gstPortalLinks).where(eq(gstPortalLinks.shopId, s.shop.id));
    expect(link.status).toBe("EXPIRED");
  });

  it("retries an unavailable GSP, logs every attempt, and points to the download", async () => {
    const s = await gstShop();
    await linked(s.shop.id, s.owner.id, s.shop.gstin!);
    let tries = 0;
    const down = { name: "down", saveReturn: async () => { tries += 1; throw new GspError("UNAVAILABLE", "GSP timed out."); } } as unknown as GstFilingProvider;
    setGstFilingProviderForTests(down);
    const prepared = await prepareReturn(s.shop.id, "GSTR1", month);
    await expect(saveToPortal(s.shop.id, prepared.id, s.owner.id)).rejects.toThrow(/download the return/);
    expect(tries).toBe(3);
    const [log] = await db.select().from(gspCallLog).where(and(eq(gspCallLog.shopId, s.shop.id), eq(gspCallLog.operation, "save:GSTR1")));
    expect(log).toMatchObject({ outcome: "ERROR", attempts: 3, errorCode: "UNAVAILABLE" });
    const [row] = await db.select().from(gstFilings).where(eq(gstFilings.id, prepared.id));
    expect(row.status).toBe("ERROR");
  });
});

describe("IMS and the cash ledger (scenarios 8, 13)", () => {
  it("lists inward invoices, records accept / reject (reason required) and sends them; shows the TCS credit", async () => {
    const s = await gstShop();
    await linked(s.shop.id, s.owner.id, s.shop.gstin!);
    const { confirmPurchase } = await import("@/server/accounts/purchases");
    await confirmPurchase(
      s.shop.id,
      { supplier: { name: "Wholesale Dairy", gstin: gstin("27", "AABCW1234D") }, invoiceNo: "WD-1", invoiceDate: today, lines: [{ shopProductId: s.milkSp.id, description: "Milk", qtyMilli: 10_000, ratePaise: 4_000, gstRateBp: 500 } as never] },
      { id: s.owner.id, role: "SHOP_OWNER" },
    );
    const rows = await imsInward(s.shop.id, month, s.owner.id);
    expect(rows.map((r) => r.docNumber)).toContain("WD-1");
    await expect(decideIms(s.shop.id, month, [{ supplierGstin: gstin("27", "AABCW1234D"), docType: "INV", docNumber: "WD-1", action: "REJECTED" }], s.owner.id)).rejects.toThrow(/Say why/);
    const r = await decideIms(s.shop.id, month, [{ supplierGstin: gstin("27", "AABCW1234D"), docType: "INV", docNumber: "WD-1", action: "ACCEPTED" }], s.owner.id);
    expect(r).toEqual({ saved: 1, sent: true });
    const [a] = await db.select().from(imsActions).where(eq(imsActions.shopId, s.shop.id));
    expect(a).toMatchObject({ action: "ACCEPTED", pushed: "SENT" });
    expect((await imsInward(s.shop.id, month, s.owner.id)).find((x) => x.docNumber === "WD-1")).toMatchObject({ portalAction: "ACCEPTED", decision: "ACCEPTED" });
    const ledger = await portalLedgers(s.shop.id, `${month}-01`, today, s.owner.id);
    expect(ledger.cash).toHaveProperty("entries");
  });
});

describe("e-invoice and e-way bill (scenario 14)", () => {
  async function eInvoiced(band: "5_TO_10_CR" | "10_TO_100_CR" = "5_TO_10_CR") {
    const s = await gstShop();
    await rule("einvoice", { enabled: true, turnoverThresholdPaise: 5_000_000_000, b2bOnly: true });
    await rule("einvoiceReportingWindow", { days: 30, appliesAbovePaise: 10_000_000_000 });
    await rule("ewayBill", { enabled: true, interStateThresholdPaise: 5_000_000, intraStateThresholdPaise: { DEFAULT: 5_000_000 } });
    // The IRP takes document numbers of at most 16 characters: e-invoicing needs GST16 numbering (BLOCKERS.md B4).
    await rule("documentNumbering", { format: "GST16" });
    await declareEinvoice(s.shop.id, { applicable: true, turnoverBand: band }, { id: s.owner.id, role: "SHOP_OWNER" });
    await db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, "billing_v2"));
    const buyer = gstin("27", "AAACH1234K");
    const { checkout, updateOrderStatus } = await import("@/server/services/orders");
    const { addToCart } = await import("@/server/services/cart");
    const { createUserWithWallet, deliveryAddressId } = await import("../helpers/fixtures");
    const { user } = await createUserWithWallet({ balancePaise: 50_000_000 });
    await addToCart(user.id, s.milkSp.id, 4);
    const { orders } = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId: `gsp-${Date.now()}`, buyerGstin: buyer });
    for (const st of ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const) await updateOrderStatus(orders[0].id, st, admin);
    const [invoice] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, orders[0].id));
    return { ...s, invoice, order: orders[0] };
  }

  it("cancels an IRN within 24 hours, not after; a credit note gets its own IRN", async () => {
    const { invoice, order, owner } = await eInvoiced();
    const record = await requestEinvoice(invoice.id);
    expect(record.status).toBe("GENERATED");
    const note = await issueCreditNoteForRefund({ orderId: order.id, sourceRef: "r-irn", amountPaise: 5_000, reason: "REFUND", restock: false });
    const crn = await requestCreditNoteEinvoice(note!.id, owner);
    expect(crn).toMatchObject({ status: "GENERATED", irn: expect.any(String) });
    await db.update(einvoiceRecords).set({ ackDate: new Date(Date.now() - 25 * 3600_000) }).where(eq(einvoiceRecords.id, record.id));
    await expect(cancelEinvoice(invoice.id, "2", "Data entry mistake", owner)).rejects.toThrow(/24 hours/);
    await db.update(einvoiceRecords).set({ ackDate: new Date() }).where(eq(einvoiceRecords.id, record.id));
    await cancelEinvoice(invoice.id, "2", "Data entry mistake", owner);
    const [after] = await db.select().from(einvoiceRecords).where(eq(einvoiceRecords.id, record.id));
    expect(after.status).toBe("CANCELLED");
  });

  it("refuses an IRN after 30 days for a ₹10 crore+ taxpayer", async () => {
    const { invoice } = await eInvoiced("10_TO_100_CR");
    // An invoice issued 31 days ago (the trigger allows only cancellation marks: re-insert a copy dated back).
    await db.execute(sql`ALTER TABLE tax_invoices DISABLE TRIGGER tax_invoices_immutable`);
    await db.update(taxInvoices).set({ issuedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(taxInvoices.id, invoice.id));
    await db.execute(sql`ALTER TABLE tax_invoices ENABLE TRIGGER tax_invoices_immutable`);
    await db.delete(einvoiceRecords).where(eq(einvoiceRecords.taxInvoiceId, invoice.id));
    await expect(requestEinvoice(invoice.id)).rejects.toThrow(/more than 30 days old/);
  });

  it("e-way bill: Part B, extension in the window only, cancel within 24 hours", async () => {
    const { invoice, owner } = await eInvoiced();
    await generateEwayBill(invoice.id, { distanceKm: 120 }, owner);
    const partB = await updateEwayPartB(invoice.id, "MH12 AB 1234", "1", "Vehicle assigned", owner);
    expect(partB).toMatchObject({ vehicleNo: "MH12AB1234", partBUpdatedAt: expect.any(Date) });
    await expect(extendEwayBill(invoice.id, 50, "1", "Breakdown", owner, new Date(Date.now()))).rejects.toThrow(/8 hours/);
    const [bill] = await db.select().from(ewayBills).where(eq(ewayBills.taxInvoiceId, invoice.id));
    const extended = await extendEwayBill(invoice.id, 50, "1", "Breakdown", owner, new Date(bill.validUpto!.getTime() - 3600_000));
    expect(extended.extensions).toBe(1);
    const cancelled = await cancelEwayBill(invoice.id, "2", "Order cancelled", owner);
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelReason: "Order cancelled" });
  });
});
