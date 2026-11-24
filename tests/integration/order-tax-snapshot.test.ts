/**
 * Tax snapshot at checkout (migration 0185): each order line records its HSN,
 * GST rate and the GST included in its price; the order records the total
 * included GST without changing what the customer pays. The invoice reads the
 * snapshot first, and the payout cycle's TCS base is the value without GST.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { orderItems, orders, payoutCycleLines, products, taxInvoices } from "@/server/db/schema";
import { closePayoutCycle } from "@/server/payouts/cycle";
import { setCommissionRate } from "@/server/services/finance";
import { issueInvoiceForOrder } from "@/server/services/invoices";
import { addDaysIso, deliveredOrder, GOKESARI_GSTIN, gstShop, IST_TODAY, resetBatchE, rules, verifiedBank } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

const today = IST_TODAY();
let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

describe("checkout records the included GST", () => {
  it("per line and per order; the total is unchanged and tax_paise stays 0", async () => {
    const s = await gstShop();
    // Milk 2 L at ₹105 (5%) and one ghee at ₹336 (12%).
    const { order } = await deliveredOrder(admin, [
      [s.milkSp.id, 2],
      [s.gheeSp.id, 1],
    ]);
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.subtotalPaise).toBe(21_000 + 33_600);
    expect(row.taxPaise).toBe(0);
    expect(row.totalPaise).toBe(row.subtotalPaise + row.deliveryFeePaise - row.discountPaise);
    // Milk ₹210 → ₹200 + ₹10; ghee ₹336 → ₹300 + ₹36.
    expect(row.taxIncludedPaise).toBe(1_000 + 3_600);

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const milk = items.find((i) => i.shopProductId === s.milkSp.id)!;
    const ghee = items.find((i) => i.shopProductId === s.gheeSp.id)!;
    expect(milk).toMatchObject({ hsnCode: "0401", gstRateBp: 500, cessBp: 0, taxablePaise: 20_000, taxPaise: 1_000 });
    expect(ghee).toMatchObject({ hsnCode: "0405", gstRateBp: 1_200, cessBp: 0, taxablePaise: 30_000, taxPaise: 3_600 });
    for (const i of items) expect(i.taxablePaise! + i.taxPaise!).toBe(i.lineTotalPaise);
  });

  it("a shop not registered for GST: no GST in the price", async () => {
    const s = await gstShop({ name: "Small Dairy", gstin: null });
    const { order } = await deliveredOrder(admin, [[s.milkSp.id, 1]]);
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.taxIncludedPaise).toBe(0);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(item).toMatchObject({ gstRateBp: 500, taxablePaise: 10_500, taxPaise: 0 });
  });

  it("a line with no rate anywhere: unknown, and the order's included GST is unknown", async () => {
    const s = await gstShop();
    const [sp] = await db.select({ productId: products.id }).from(products).where(eq(products.hsnCode, "0405"));
    await db.update(products).set({ gstRateBp: null, hsnCode: null }).where(eq(products.id, sp.productId));
    const { order } = await deliveredOrder(admin, [
      [s.milkSp.id, 1],
      [s.gheeSp.id, 1],
    ]);
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.taxIncludedPaise).toBeNull();
    const ghee = (await db.select().from(orderItems).where(eq(orderItems.orderId, order.id))).find((i) => i.shopProductId === s.gheeSp.id)!;
    expect(ghee).toMatchObject({ gstRateBp: null, taxablePaise: null, taxPaise: null });
  });
});

describe("the invoice reads the snapshot first", () => {
  it("a rate changed after the order does not change the order's invoice", async () => {
    const s = await gstShop();
    const { order } = await deliveredOrder(admin, [[s.milkSp.id, 2]]);
    const [milk] = await db.select({ id: products.id }).from(products).where(eq(products.hsnCode, "0401"));
    await db.update(products).set({ gstRateBp: 1_800 }).where(eq(products.id, milk.id));
    await rules(admin, { invoicing: { enabled: true } });
    const invoice = await issueInvoiceForOrder(order.id);
    expect(invoice).not.toBeNull();
    const [stored] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, order.id));
    expect(stored.taxablePaise).toBe(20_000);
  });
});

describe("TCS base without an invoice", () => {
  it("is the snapshot's taxable value, never the GST-inclusive goods value", async () => {
    await setCommissionRate({ scope: "DEFAULT", rateBp: 1000 }, admin);
    await rules(admin, {
      invoicing: { enabled: false },
      payouts: { enabled: true, anchorDate: addDaysIso(today, -10), cycleDays: 5, holdDays: 0, provider: "SANDBOX" },
      platformTaxProfile: { legalName: "GoKesari Technologies Pvt Ltd", tradeName: "GoKesari", gstin: GOKESARI_GSTIN, pan: "AABCG1234K", address: "1 MG Road, Bengaluru 560001", stateCode: "KA" },
    });
    const s = await gstShop();
    await verifiedBank(s.owner.id, s.shop.id);
    const { order, invoice } = await deliveredOrder(admin, [[s.gheeSp.id, 1]], { deliveredDaysAgo: 3 });
    expect(invoice).toBeNull();
    await closePayoutCycle({ today, actor: admin });
    const [tcs] = await db.select().from(payoutCycleLines).where(eq(payoutCycleLines.lineType, "TCS"));
    expect(tcs.sourceId).toBe(order.id);
    expect(tcs.basePaise).toBe(30_000); // ₹336 incl. 12% GST → ₹300
    expect(tcs.meta).toMatchObject({ taxableFrom: "ORDER_SNAPSHOT" });
    expect(-tcs.amountPaise).toBe(Math.round((30_000 * (tcs.rateBp ?? 0)) / 10_000));
  });
});
