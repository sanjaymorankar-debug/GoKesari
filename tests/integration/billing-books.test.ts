/**
 * Billing v2 phase 4 (docs/billing §6.1, §6.2, §8 G10): GoKesari's activity
 * posted into the shop's books, journals / contra / stock journal, and the
 * trial balance, balance sheet, chart of accounts, stock movement / ageing,
 * TCS-TDS credit and marketplace tax reports. Runs on both database layouts.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { accLedgerEntries, featureFlags, notifications, shopProducts, type FeatureFlagKey } from "@/server/db/schema";
import { contraSchema, recordContra, recordJournal, recordStockJournal, reverseJournal } from "@/server/accounts/journals";
import { postGokesariActivity } from "@/server/accounts/platform-posting";
import { reportTable } from "@/server/accounts/reports";
import { createSalesInvoice } from "@/server/accounts/sales";
import { stockSummary } from "@/server/accounts/stock";
import { issueCreditNoteForRefund } from "@/server/gst/credit-notes";
import { closePayoutCycle } from "@/server/payouts/cycle";
import { setCommissionRate } from "@/server/services/finance";
import { cancelTaxInvoice } from "@/server/tax/invoice-cancel";
import { sendMonthlyShopStatements } from "@/server/tax/statements";
import { addDaysIso, deliveredOrder, gstin, GOKESARI_GSTIN, gstShop, IST_TODAY, resetBatchE, rules, verifiedBank } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

const today = IST_TODAY();
let admin = { id: "", role: "ADMIN" as const };

async function flag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
}

const balanceOf = async (shopId: string) => {
  const [r] = await db
    .select({ dr: sql<number>`coalesce(sum(${accLedgerEntries.debitPaise}), 0)::bigint`, cr: sql<number>`coalesce(sum(${accLedgerEntries.creditPaise}), 0)::bigint` })
    .from(accLedgerEntries)
    .where(eq(accLedgerEntries.shopId, shopId));
  return { dr: Number(r.dr), cr: Number(r.cr) };
};
const accountNet = async (shopId: string, account: string) => {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${accLedgerEntries.debitPaise} - ${accLedgerEntries.creditPaise}), 0)::bigint` })
    .from(accLedgerEntries)
    .where(and(eq(accLedgerEntries.shopId, shopId), sql`${accLedgerEntries.account} = ${account}`));
  return Number(r.n);
};

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  await db.execute(sql`DELETE FROM feature_flags WHERE key IN ('billing_v2', 'tcs_engine', 'tds_engine')`);
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setCommissionRate({ scope: "DEFAULT", rateBp: 1000 }, admin);
  await rules(admin, {
    invoicing: { enabled: true },
    payouts: { enabled: true, anchorDate: addDaysIso(today, -10), cycleDays: 5, holdDays: 0, provider: "SANDBOX" },
    platformInvoicing: { enabled: true },
    platformTaxProfile: { legalName: "GoKesari Technologies Pvt Ltd", tradeName: "GoKesari", gstin: GOKESARI_GSTIN, pan: "AABCG1234K", address: "1 MG Road, Bengaluru 560001", stateCode: "KA" },
  });
  await flag("billing_v2", true);
});

describe("GoKesari's activity in the shop's books (§6.1)", () => {
  it("posts the online sale, its credit note, the payout's fees and taxes once, and the books balance", async () => {
    const s = await gstShop();
    await verifiedBank(s.owner.id, s.shop.id);
    const { order, invoice } = await deliveredOrder(admin, [[s.milkSp.id, 4]], { deliveredDaysAgo: 3 });
    await flag("tcs_engine", true);
    await closePayoutCycle({ today, actor: admin });
    await issueCreditNoteForRefund({ orderId: order.id, sourceRef: "r-books", amountPaise: 10_500, reason: "REFUND", restock: false });

    const first = await postGokesariActivity(s.shop.id);
    expect(first.posted).toBeGreaterThanOrEqual(4); // sale, credit note, commission, TCS (+ fee GST, TDS)
    expect((await postGokesariActivity(s.shop.id)).posted).toBe(0);

    const sale = await db.select().from(accLedgerEntries).where(and(eq(accLedgerEntries.sourceType, "ORDER"), eq(accLedgerEntries.sourceId, invoice!.id)));
    expect(sale.find((l) => l.account === "GOKESARI_ACCOUNT")?.debitPaise).toBe(invoice!.totalPaise);
    expect(sale.find((l) => l.account === "SALES")?.creditPaise).toBe(invoice!.taxablePaise);
    expect(await accountNet(s.shop.id, "TCS_RECEIVABLE")).toBeGreaterThan(0);
    expect(await accountNet(s.shop.id, "COMMISSION_EXPENSE")).toBeGreaterThan(0);
    const { dr, cr } = await balanceOf(s.shop.id);
    expect(dr).toBe(cr);

    const tb = await reportTable(s.shop.id, "trial", today, addDaysIso(today, 1));
    expect(tb.footer[0]).toMatch(/balanced/);
    expect(tb.footer[0]).not.toMatch(/NOT/);
    const bs = await reportTable(s.shop.id, "balance", today, addDaysIso(today, 1));
    expect(bs.footer[0]).toMatch(/— balanced/);
    const coa = await reportTable(s.shop.id, "coa", today, addDaysIso(today, 1));
    expect(coa.rows.map((r) => r[0])).toContain("Duties & Taxes");
    const credit = await reportTable(s.shop.id, "taxcredit", addDaysIso(today, -30), addDaysIso(today, 1));
    expect(credit.rows.some((r) => r[1] === "GST TCS")).toBe(true);
  });

  it("reverses the sale when the invoice is cancelled", async () => {
    const s = await gstShop();
    const { invoice } = await deliveredOrder(admin, [[s.milkSp.id, 2]]);
    await postGokesariActivity(s.shop.id);
    expect(await accountNet(s.shop.id, "SALES")).toBe(-invoice!.taxablePaise);
    await cancelTaxInvoice(invoice!.id, "issued on the wrong order", admin);
    expect((await postGokesariActivity(s.shop.id)).reversed).toBeGreaterThan(0);
    expect(await accountNet(s.shop.id, "SALES")).toBe(0);
    expect((await postGokesariActivity(s.shop.id)).reversed).toBe(0);
  });

  it("does nothing while billing_v2 is off", async () => {
    await flag("billing_v2", false);
    const s = await gstShop();
    await deliveredOrder(admin, [[s.milkSp.id, 2]]);
    expect(await postGokesariActivity(s.shop.id)).toEqual({ posted: 0, reversed: 0 });
  });
});

describe("journals, contra and stock journal (§6.1, §6.2)", () => {
  it("posts a balanced journal, refuses an unbalanced one, posts and reverses a contra", async () => {
    const s = await gstShop();
    await expect(recordJournal(s.shop.id, { narration: "Bad", legs: [{ account: "EXPENSE", debitPaise: 100 }, { account: "CASH", creditPaise: 90 }] }, s.owner)).rejects.toThrow(/must be equal/);
    await recordJournal(s.shop.id, { narration: "TDS claimed in return", legs: [{ account: "CAPITAL", debitPaise: 500 }, { account: "TDS_RECEIVABLE", creditPaise: 500 }] }, s.owner);
    const contra = await recordContra(s.shop.id, contraSchema.parse({ from: "CASH", amountPaise: 10_000 }), s.owner);
    expect(await accountNet(s.shop.id, "BANK")).toBe(10_000);
    await reverseJournal(s.shop.id, contra.sourceId, "wrong amount", s.owner);
    expect(await accountNet(s.shop.id, "BANK")).toBe(0);
    const { dr, cr } = await balanceOf(s.shop.id);
    expect(dr).toBe(cr);
  });

  it("moves stock between the online and in-shop counts without changing the total or its value", async () => {
    const s = await gstShop();
    const before = await stockSummary(s.shop.id);
    const milkBefore = before.rows.find((r) => r.shopProductId === s.milkSp.id)!;
    await recordStockJournal(s.shop.id, { shopProductId: s.milkSp.id, from: "ONLINE", qtyMilli: 10_000 }, s.owner);
    const [sp] = await db.select().from(shopProducts).where(eq(shopProducts.id, s.milkSp.id));
    expect(sp.offlineStock).toBe(10);
    const after = await stockSummary(s.shop.id);
    const milkAfter = after.rows.find((r) => r.shopProductId === s.milkSp.id)!;
    expect(milkAfter.qtyMilli).toBe(milkBefore.qtyMilli);
    expect(milkAfter.valuePaise).toBe(milkBefore.valuePaise);
    await expect(recordStockJournal(s.shop.id, { shopProductId: s.milkSp.id, from: "OFFLINE", qtyMilli: 999_000 }, s.owner)).rejects.toThrow(/Only/);
    const move = await reportTable(s.shop.id, "stockmove", addDaysIso(today, -30), addDaysIso(today, 1));
    expect(move.header).toEqual(["Item", "Opening", "In", "Out", "Closing"]);
    const age = await reportTable(s.shop.id, "stockage", today, addDaysIso(today, 1));
    expect(age.header).toContain("Bucket");
  });
});

describe("marketplace tax report (§8 G10)", () => {
  it("lists GoKesari sales with the ECO GSTIN and counter sales, B2B / B2C", async () => {
    const s = await gstShop();
    await deliveredOrder(admin, [[s.milkSp.id, 2]]);
    await createSalesInvoice(s.shop.id, { paymentMode: "CASH", buyerGstin: gstin("27", "AAACH1234K"), buyerName: "Hotel Sunrise", lines: [{ description: "Ghee", hsn: "0405", qtyMilli: 1000, ratePaise: 30_000, gstRateBp: 1200 }] }, s.owner);
    const mtr = await reportTable(s.shop.id, "mtr", today, addDaysIso(today, 1));
    const online = mtr.rows.find((r) => r[19] === "GoKesari");
    const counter = mtr.rows.find((r) => r[19] === "Counter");
    expect(online).toBeTruthy();
    expect(online![5]).toBe("B2C");
    expect(counter![5]).toBe("B2B");
    expect(counter![4]).toBe(gstin("27", "AAACH1234K"));
    expect(mtr.footer[0]).toMatch(/Taxable/);
  });
});

describe("monthly statement notice (§8)", () => {
  it("tells each active shop's owner once per month, from the 2nd", async () => {
    const s = await gstShop();
    await verifiedBank(s.owner.id, s.shop.id);
    await deliveredOrder(admin, [[s.milkSp.id, 4]], { deliveredDaysAgo: 3 });
    await closePayoutCycle({ today, actor: admin });
    const soldMonth = addDaysIso(today, -3).slice(0, 7);
    const [y, m] = soldMonth.split("-").map(Number);
    const nextMonth2nd = new Date(Date.UTC(y, m, 2)).toISOString().slice(0, 10);
    expect((await sendMonthlyShopStatements(`${nextMonth2nd.slice(0, 8)}01`)).sent).toBe(0);
    expect((await sendMonthlyShopStatements(nextMonth2nd)).sent).toBe(1);
    await sendMonthlyShopStatements(nextMonth2nd);
    const rows = await db.select().from(notifications).where(and(eq(notifications.userId, s.owner.id), eq(notifications.type, "shop.tax_statement_ready")));
    expect(rows).toHaveLength(1);
  });
});
