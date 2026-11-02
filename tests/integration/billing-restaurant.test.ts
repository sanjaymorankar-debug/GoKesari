/**
 * Billing v2 (docs/billing §5.3, gap G17; §5.1): restaurant services under
 * s.9(5). With the dated row GST_S95_RESTAURANT covering the shop's type and
 * billing_v2 on, GoKesari invoices the food in its own GSTIN and pays the
 * GST; the restaurant's document is a bill of supply without it, reported in
 * its GSTR-1 Table 14(b); GoKesari reports it in Table 15 and GSTR-3B; no TCS;
 * the payout withholds the GST; the books balance. The money-flow record turns
 * SETTLED when the payout is paid, and the admin summary counts it. Both layouts.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { accLedgerEntries, featureFlags, orderMoneyFlows, payoutCycleLines, platformDeliveryInvoices, shops, statutoryRates, taxInvoices, type StatutoryRate } from "@/server/db/schema";
import { postGokesariActivity } from "@/server/accounts/platform-posting";
import { buildGstr1 } from "@/server/gst/gstr1";
import { approvePayoutBatch, markPayoutItemPaid } from "@/server/payouts/batches";
import { closePayoutCycle } from "@/server/payouts/cycle";
import { setCommissionRate } from "@/server/services/finance";
import { statutoryRateOn, updateStatutoryRate } from "@/server/statutory/rates";
import { buildGokesariGstr1, buildGokesariGstr3b } from "@/server/tax/compliance";
import { renderDeliveryFeeInvoicePdf } from "@/server/tax/delivery-invoice";
import { moneyFlowSummary, syncMoneyFlowSettlement } from "@/server/tax/money-flow";
import { addDaysIso, deliveredOrder, GOKESARI_GSTIN, gstShop, IST_TODAY, resetBatchE, rules, verifiedBank } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

const today = IST_TODAY();
const period = today.slice(0, 7);
let admin = { id: "", role: "ADMIN" as const };
let checker = { id: "", role: "ADMIN" as const };

async function billingV2(enabled: boolean) {
  await db.insert(featureFlags).values({ key: "billing_v2", enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
}

async function restaurant() {
  const s = await gstShop({ name: "Spice Kitchen" });
  await db.update(shops).set({ shopType: "RESTAURANT" }).where(eq(shops.id, s.shop.id));
  await verifiedBank(s.owner.id, s.shop.id);
  return s;
}

// The statutory row is shared by every test file: put it back as it was.
let seeded: StatutoryRate | undefined;
beforeAll(async () => {
  [seeded] = await db.select().from(statutoryRates).where(eq(statutoryRates.key, "GST_S95_RESTAURANT"));
});
afterAll(async () => {
  if (seeded) await db.update(statutoryRates).set({ enabled: seeded.enabled, params: seeded.params, updatedBy: seeded.updatedBy, updatedAt: seeded.updatedAt }).where(eq(statutoryRates.id, seeded.id));
});

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  await db.execute(sql`DELETE FROM feature_flags WHERE key IN ('billing_v2', 'tcs_engine', 'tds_engine', 'delivery_9_5')`);
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  checker = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setCommissionRate({ scope: "DEFAULT", rateBp: 1000 }, admin);
  await rules(admin, {
    invoicing: { enabled: true },
    payouts: { enabled: true, anchorDate: addDaysIso(today, -10), cycleDays: 5, holdDays: 0, provider: "BANK_FILE", minPayoutPaise: 100 },
    platformTaxProfile: { legalName: "GoKesari Technologies Pvt Ltd", tradeName: "GoKesari", gstin: GOKESARI_GSTIN, pan: "AABCG1234K", address: "1 MG Road, Bengaluru 560001", stateCode: "KA" },
  });
  const row = (await statutoryRateOn("GST_S95_RESTAURANT", today))!;
  await updateStatutoryRate(row.id, { enabled: true, params: { appliesToShopTypes: ["RESTAURANT", "CAFE"] } }, admin);
});

describe("restaurant s.9(5) (§5.3)", () => {
  it("GoKesari invoices the food and pays the GST; the restaurant's bill of supply, returns, payout, books and settlement follow", async () => {
    await billingV2(true);
    const s = await restaurant();
    // Two plates at ₹105 each (tax-inclusive) to a Maharashtra address; GoKesari is in Karnataka.
    const { order, invoice } = await deliveredOrder(admin, [[s.milkSp.id, 2]], { deliveredDaysAgo: 3 });

    const [flow] = await db.select().from(orderMoneyFlows).where(eq(orderMoneyFlows.orderId, order.id));
    expect(flow).toMatchObject({ foodGstLiable: "GOKESARI_S95", foodGstRateBp: 500, foodGstPaise: 1_000, tcsApplicable: false });

    const [eco] = await db.select().from(platformDeliveryInvoices).where(and(eq(platformDeliveryInvoices.orderId, order.id), eq(platformDeliveryInvoices.kind, "RESTAURANT")));
    expect(eco).toMatchObject({ feePaise: 21_000, taxablePaise: 20_000, igstPaise: 1_000, cgstPaise: 0, supplyType: "INTER", rateBp: 500 });
    expect(eco.invoiceNumber).toMatch(/^GKS\/\d{4}\/000001$/);
    expect((eco.snapshot as { onBehalfOf: { gstin: string } }).onBehalfOf.gstin).toBe(s.shop.gstin);
    expect(renderDeliveryFeeInvoicePdf(eco).subarray(0, 4).toString()).toBe("%PDF");

    expect(invoice).toMatchObject({ kind: "BILL_OF_SUPPLY", taxablePaise: 20_000, totalPaise: 20_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
    const snap = invoice!.snapshot as { sec95?: { rateBp: number; gstPaise: number }; notes: string[]; seller: { gstin: string } };
    expect(snap.sec95).toEqual({ rateBp: 500, gstPaise: 1_000 });
    expect(snap.seller.gstin).toBe(s.shop.gstin);
    expect(snap.notes.join(" ")).toMatch(/section 9\(5\)/);

    // The restaurant's GSTR-1: Table 14(b), nothing taxable of its own.
    const g1 = (await buildGstr1(s.shop.id, period)).json as { b2cs: unknown[]; supeco?: { paytx?: unknown[]; clttx?: unknown[] } };
    expect(g1.supeco?.paytx).toEqual([{ etin: GOKESARI_GSTIN, suppval: 200, igst: 0, cgst: 0, sgst: 0, cess: 0 }]);
    expect(g1.supeco?.clttx).toBeUndefined();
    expect(g1.b2cs).toEqual([]);
    // GoKesari's GSTR-1 Table 15 under the restaurant's GSTIN, and GSTR-3B 3.1.1(i).
    const gk = (await buildGokesariGstr1(period)).json as { ecom?: { b2c?: { stin: string; pos: string; rt: number; txval: number; iamt: number }[] } };
    expect(gk.ecom?.b2c).toEqual([expect.objectContaining({ stin: s.shop.gstin, pos: "27", rt: 5, txval: 200, iamt: 10 })]);
    const g3b = (await buildGokesariGstr3b(period)).json as { eco_dtls: { eco_sup: { txval: number; iamt: number } } };
    expect(g3b.eco_dtls.eco_sup).toMatchObject({ txval: 200, iamt: 10 });

    // Payout: the GST is withheld, no TCS.
    const closed = await closePayoutCycle({ today, actor: admin });
    const lines = await db.select().from(payoutCycleLines).where(and(eq(payoutCycleLines.cycleId, closed!.cycle.id), eq(payoutCycleLines.shopId, s.shop.id)));
    expect(lines.find((l) => l.lineType === "SEC95_GST")).toMatchObject({ amountPaise: -1_000, meta: expect.objectContaining({ withheld: true, liabilityPaise: 1_000 }) });
    expect(lines.filter((l) => l.lineType === "TCS")).toHaveLength(0);
    const item = closed!.items.find((i) => i.shopId === s.shop.id)!;
    expect(item.amountPaise).toBe(lines.reduce((n, l) => n + l.amountPaise, 0));

    // The restaurant's books balance: the sale is booked without the GST GoKesari pays.
    await postGokesariActivity(s.shop.id);
    const sale = await db.select().from(accLedgerEntries).where(and(eq(accLedgerEntries.sourceType, "ORDER"), eq(accLedgerEntries.sourceId, invoice!.id)));
    expect(sale.find((l) => l.account === "SALES")?.creditPaise).toBe(20_000);
    const [totals] = await db
      .select({ dr: sql<number>`coalesce(sum(${accLedgerEntries.debitPaise}), 0)::bigint`, cr: sql<number>`coalesce(sum(${accLedgerEntries.creditPaise}), 0)::bigint` })
      .from(accLedgerEntries)
      .where(eq(accLedgerEntries.shopId, s.shop.id));
    expect(Number(totals.dr)).toBe(Number(totals.cr));

    // Settlement: UNSETTLED until the payout is paid.
    expect(await syncMoneyFlowSettlement()).toEqual({ settled: 0 });
    await approvePayoutBatch(closed!.batch!.id, checker);
    await markPayoutItemPaid(item.id, "HDFCN5202611011234", admin);
    expect(await syncMoneyFlowSettlement()).toEqual({ settled: 1 });
    expect((await db.select().from(orderMoneyFlows).where(eq(orderMoneyFlows.orderId, order.id)))[0].settlementStatus).toBe("SETTLED");

    const summary = await moneyFlowSummary(new Date(`${period}-01T00:00:00+05:30`), new Date(Date.now() + 86_400_000));
    expect(summary).toEqual([expect.objectContaining({ mode: "WALLET_PREPAID", collectedBy: "PLATFORM", orders: 1, tcsApplicable: 0, foodGstPaise: 1_000, settled: 1 })]);
  });

  it("changes nothing while billing_v2 is off, and a shop type not listed is billed as before", async () => {
    const s = await restaurant();
    const off = await deliveredOrder(admin, [[s.milkSp.id, 1]]);
    expect(off.invoice).toMatchObject({ kind: "TAX_INVOICE" });
    expect(await db.select().from(platformDeliveryInvoices).where(eq(platformDeliveryInvoices.orderId, off.order.id))).toEqual([]);

    await billingV2(true);
    const dairy = await gstShop({ name: "Dairy" });
    const { order, invoice } = await deliveredOrder(admin, [[dairy.milkSp.id, 1]]);
    expect(invoice).toMatchObject({ kind: "TAX_INVOICE" });
    expect((await db.select().from(orderMoneyFlows).where(eq(orderMoneyFlows.orderId, order.id)))[0]).toMatchObject({ foodGstLiable: "SHOP", foodGstPaise: 0 });
    expect(await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, order.id))).toHaveLength(1);
  });
});
