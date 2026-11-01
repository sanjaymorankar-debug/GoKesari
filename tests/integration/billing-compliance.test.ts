/**
 * Billing v2 phase 3 (docs/billing §5.4–5.7; §13 scenarios 3, 6, 7, 8): TCS and
 * TDS following the money-flow record, the TDS exemption counted per PAN,
 * GSTR-8 (with Enrolment-ID suppliers), GoKesari's own GSTR-1 / 3B with the
 * s.9(5) delivery invoices, the quarterly TDS statement, the filing record,
 * the compliance calendar and reminders, and the shop's monthly statements.
 * Runs on both database layouts.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { panBlindIndex } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { featureFlags, notifications, orderMoneyFlows, orders, payoutCycleLines, shops, type FeatureFlagKey } from "@/server/db/schema";
import { importHsnRates, listHsnRates } from "@/server/gst/config";
import { hsnFallbackRate } from "@/server/gst/rules";
import { closePayoutCycle } from "@/server/payouts/cycle";
import { setCommissionRate } from "@/server/services/finance";
import { addStatutoryRate } from "@/server/statutory/rates";
import {
  buildGokesariGstr1,
  buildGokesariGstr3b,
  buildGstr8,
  buildTdsStatement,
  complianceCalendar,
  dueDateOf,
  generateFiling,
  gstr8Schema,
  markFiled,
  quarterBounds,
  quarterOf,
  sendComplianceReminders,
  shopTaxStatement,
} from "@/server/tax/compliance";
import { shopStatementFiles, shopWalletStatement } from "@/server/tax/statements";
import { addDaysIso, deliveredOrder, GOKESARI_GSTIN, gstShop, IST_TODAY, resetBatchE, rules, verifiedBank } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

const today = IST_TODAY();
const soldOn = addDaysIso(today, -3);
const period = soldOn.slice(0, 7);
let admin = { id: "", role: "ADMIN" as const };

async function flag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
}

async function sellingShop(options: Parameters<typeof gstShop>[0] = {}, qty = 4) {
  const s = await gstShop(options);
  await verifiedBank(s.owner.id, s.shop.id);
  const sale = await deliveredOrder(admin, [[s.milkSp.id, qty]], { deliveredDaysAgo: 3 });
  return { ...s, ...sale };
}

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  await db.execute(sql`DELETE FROM feature_flags WHERE key IN ('billing_v2', 'tcs_engine', 'tds_engine', 'delivery_9_5')`);
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setCommissionRate({ scope: "DEFAULT", rateBp: 1000 }, admin);
  await rules(admin, {
    invoicing: { enabled: true },
    payouts: { enabled: true, anchorDate: addDaysIso(today, -10), cycleDays: 5, holdDays: 0, provider: "SANDBOX" },
    platformTaxProfile: { legalName: "GoKesari Technologies Pvt Ltd", tradeName: "GoKesari", gstin: GOKESARI_GSTIN, pan: "AABCG1234K", address: "1 MG Road, Bengaluru 560001", stateCode: "KA" },
  });
  await flag("billing_v2", true);
});

describe("dates", () => {
  it("due dates, quarters", () => {
    expect(dueDateOf("GSTR8", "2026-10")).toBe("2026-11-10");
    expect(dueDateOf("GSTR1", "2026-12")).toBe("2027-01-11");
    expect(dueDateOf("GSTR3B", "2026-10")).toBe("2026-11-20");
    expect(quarterOf("2026-11")).toBe("2026-27-Q3");
    expect(quarterOf("2027-02")).toBe("2026-27-Q4");
    expect(quarterBounds("2026-27-Q3")).toEqual({ from: "2026-10-01", to: "2027-01-01", dueDate: "2027-01-31" });
    expect(quarterBounds("2026-27-Q4")).toEqual({ from: "2027-01-01", to: "2027-04-01", dueDate: "2027-05-31" });
  });
});

describe("TCS follows the money-flow record (§5.4, scenario 6)", () => {
  it("tcs_engine on: no TCS on an order whose flow says not applicable; off: as before", async () => {
    const a = await sellingShop({ name: "Prepaid Dairy" });
    const b = await sellingShop({ name: "Cash Dairy" });
    await db.update(orderMoneyFlows).set({ tcsApplicable: false }).where(eq(orderMoneyFlows.orderId, b.order.id));
    await flag("tcs_engine", true);
    await closePayoutCycle({ today, actor: admin });
    const tcs = await db.select().from(payoutCycleLines).where(eq(payoutCycleLines.lineType, "TCS"));
    expect(tcs.map((l) => l.shopId)).toEqual([a.shop.id]);
    expect(tcs[0].meta).toMatchObject({ b2b: false, placeOfSupply: expect.any(String) });
    // 0.5% of the net taxable value.
    expect(-tcs[0].amountPaise).toBe(Math.round(((tcs[0].basePaise ?? 0) * 50) / 10_000));
  });

  it("tcs_engine off: the flow is not consulted", async () => {
    await sellingShop({ name: "Prepaid Dairy" });
    const b = await sellingShop({ name: "Cash Dairy" });
    await db.update(orderMoneyFlows).set({ tcsApplicable: false }).where(eq(orderMoneyFlows.orderId, b.order.id));
    await closePayoutCycle({ today, actor: admin });
    expect(await db.select().from(payoutCycleLines).where(eq(payoutCycleLines.lineType, "TCS"))).toHaveLength(2);
  });
});

describe("TDS exemption per PAN (§5.5, scenario 7)", () => {
  it("tds_engine on: two shops of one individual share the yearly limit", async () => {
    await addStatutoryRate(
      { key: "IT_TDS_194O", label: "TDS (test limit)", enabled: true, rateBp: 10, params: { noPanRateBp: 500, exemptIndividualHufUpToPaise: 50_000, baseExcludesGst: true, sectionLabel: "s.393(1)" }, effectiveFrom: addDaysIso(today, -30) },
      admin,
    );
    const pan = "ABCPE1234F";
    const one = await gstShop({ name: "Shop One", gstin: null, pan, panLast4: "234F" });
    const two = await gstShop({ name: "Shop Two", gstin: null, pan, panLast4: "234F" });
    for (const s of [one, two]) {
      await db.update(shops).set({ panHash: panBlindIndex(pan) }).where(eq(shops.id, s.shop.id));
      await verifiedBank(s.owner.id, s.shop.id);
      await deliveredOrder(admin, [[s.milkSp.id, 4]], { deliveredDaysAgo: 3 }); // ₹420 each
    }
    await flag("tds_engine", true);
    await closePayoutCycle({ today, actor: admin });
    const tds = await db.select().from(payoutCycleLines).where(eq(payoutCycleLines.lineType, "TDS"));
    const exempt = tds.filter((l) => (l.meta as { exempt?: boolean }).exempt);
    // The first ₹420 is within ₹500; the second takes the person over it.
    expect(exempt).toHaveLength(1);
    expect(tds.find((l) => !(l.meta as { exempt?: boolean }).exempt)?.rateBp).toBe(10);
    const statement = await buildTdsStatement(quarterOf(period));
    expect(statement.csv).toContain(pan);
    expect((statement.json.deductees as { pan: string }[]).map((d) => d.pan)).toEqual([pan]);
  });
});

describe("GSTR-8 (§5.4, scenarios 3 and 6)", () => {
  it("supplier-wise rows, net of returns, Enrolment-ID suppliers with no TCS; validates; filed once", async () => {
    const reg = await sellingShop({ name: "GST Dairy" });
    const enr = await gstShop({ name: "Village Dairy", gstin: null });
    await db.update(shops).set({ gstRegistrationType: "ENROLMENT_ID", gstEnrolmentId: "271234567890EID", gstStateCode: "27" }).where(eq(shops.id, enr.shop.id));
    await verifiedBank(enr.owner.id, enr.shop.id);
    await deliveredOrder(admin, [[enr.milkSp.id, 2]], { deliveredDaysAgo: 3 });
    await flag("tcs_engine", true);
    await closePayoutCycle({ today, actor: admin });

    const { json } = await buildGstr8(period);
    expect(gstr8Schema.safeParse(json).success).toBe(true);
    const regRow = json.tcs.find((t) => t.stin === reg.shop.gstin);
    expect(regRow).toMatchObject({ supplierType: "REGISTERED", supply: "B2C", pos: "27" });
    expect(regRow!.camt + regRow!.samt + regRow!.iamt).toBeGreaterThan(0);
    const enrRow = json.tcs.find((t) => t.stin === "271234567890EID");
    expect(enrRow).toMatchObject({ supplierType: "ENROLMENT_ID", grsval: 210, iamt: 0, camt: 0, samt: 0 });

    const filing = await generateFiling("GSTR8", period, admin);
    expect(filing).toMatchObject({ returnType: "GSTR8", period, registration: GOKESARI_GSTIN, status: "GENERATED", dueDate: dueDateOf("GSTR8", period) });
    const again = await generateFiling("GSTR8", period, admin);
    expect(again.id).toBe(filing.id);
    await expect(markFiled(filing.id, "AA", admin)).rejects.toThrow(/ARN/);
    const filed = await markFiled(filing.id, "AA2711260012345", admin);
    expect(filed).toMatchObject({ status: "FILED", acknowledgement: "AA2711260012345" });
    await expect(generateFiling("GSTR8", period, admin)).rejects.toThrow(/already filed/);
  });
});

describe("GoKesari's GSTR-1 / GSTR-3B with s.9(5) supplies (§5.7)", () => {
  it("reports the delivery-fee invoices in Table 15 and 3.1.1(i)", async () => {
    await flag("delivery_9_5", true);
    const s = await gstShop();
    const { order } = await deliveredOrder(admin, [[s.milkSp.id, 2]]);
    // The fee is set after delivery here, so the invoice is issued by the catch-up sweep, as in production.
    await db.update(orders).set({ deliveryFeePaise: 2_100 }).where(eq(orders.id, order.id));
    await db.update(orderMoneyFlows).set({ deliveryGstLiable: "GOKESARI_S95", deliveryGstRateBp: 500, deliveryGstPaise: 100 }).where(eq(orderMoneyFlows.orderId, order.id));
    const { issueMissingDeliveryFeeInvoices } = await import("@/server/tax/money-flow");
    expect(await issueMissingDeliveryFeeInvoices()).toEqual({ issued: 1, failed: 0 });
    const month = today.slice(0, 7);
    const g1 = await buildGokesariGstr1(month);
    expect(g1.json.ecom).toEqual({ urp2c: [expect.objectContaining({ rt: 5, txval: 20, camt: 0, samt: 0, iamt: 1 })] });
    const g3 = await buildGokesariGstr3b(month);
    expect(g3.json.eco_dtls).toEqual({ eco_sup: { txval: 20, iamt: 1, camt: 0, samt: 0, csamt: 0 } });
  });
});

describe("calendar and reminders (§5.7)", () => {
  it("lists what is due with its status and reminds admins once per return", async () => {
    const items = await complianceCalendar("2026-11-09");
    const gstr8 = items.find((i) => i.returnType === "GSTR8" && i.period === "2026-10");
    expect(gstr8).toMatchObject({ dueDate: "2026-11-10", daysLeft: 1, status: "NOT_GENERATED" });
    const first = await sendComplianceReminders("2026-11-09");
    expect(first.sent).toBeGreaterThan(0);
    await sendComplianceReminders("2026-11-09");
    const rows = await db.select().from(notifications).where(and(eq(notifications.userId, admin.id), eq(notifications.type, "compliance.due_reminder")));
    expect(rows.length).toBe(first.sent);
  });
});

describe("the shop's statements (§5.4–5.6, scenario 8)", () => {
  it("TCS/TDS, wallet and settlement for the month", async () => {
    const s = await sellingShop();
    await flag("tcs_engine", true);
    await closePayoutCycle({ today, actor: admin });
    const st = await shopTaxStatement(s.shop.id, period);
    const tcsLines = await db.select().from(payoutCycleLines).where(and(eq(payoutCycleLines.shopId, s.shop.id), eq(payoutCycleLines.lineType, "TCS")));
    expect(st.tcs.cgstPaise + st.tcs.sgstPaise + st.tcs.igstPaise).toBe(tcsLines.reduce((n, l) => n - l.amountPaise, 0));
    expect(st.orders).toBe(1);
    const wallet = await shopWalletStatement(s.shop.id, period);
    expect(wallet.closingPaise).toBe(wallet.openingPaise + wallet.topUpsPaise - wallet.deductionsPaise);
    for (const [kind, format] of [["tax", "pdf"], ["wallet", "pdf"], ["wallet", "csv"], ["settlement", "csv"]] as const) {
      const f = await shopStatementFiles(s.shop.id, kind, period, format);
      expect(f.bytes.length).toBeGreaterThan(20);
      if (format === "pdf") expect(f.bytes.toString("latin1").startsWith("%PDF")).toBe(true);
    }
    const settlement = (await shopStatementFiles(s.shop.id, "settlement", period, "csv")).bytes.toString();
    expect(settlement.split("\n")[0]).toContain("net_payable_inr");
    expect(settlement).toContain(s.order.orderNumber);
  });
});

describe("HSN master, many rates at once (§2.1)", () => {
  it("checks every row first, then saves them dated; a later list closes the earlier rate", async () => {
    await expect(importHsnRates("hsn,rate,cess,description,effective_from\n0401,5,0,Milk,2025-09-22\nABC,5,,Bad,2025-09-22", admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await listHsnRates("0401")).toHaveLength(0);
    expect(await importHsnRates("hsn,rate,cess,description,effective_from\n0401,5%,0,Milk,2025-09-22\n2202,40,,Aerated drinks,2025-09-22", admin)).toEqual({ saved: 2 });
    expect(await importHsnRates("0401,0,,Milk (exempt),2026-04-01", admin)).toEqual({ saved: 1 });
    expect((await hsnFallbackRate("04011000", new Date("2025-12-01T06:00:00Z")))?.rateBp).toBe(500);
    expect((await hsnFallbackRate("04011000", new Date("2026-05-01T06:00:00Z")))?.rateBp).toBe(0);
  });
});
