/**
 * Inventory & Accounting (docs/inventory-accounting-2026-10) against real
 * PostgreSQL: the stock ledger and its triggers, purchase confirm and
 * correction, sales invoices, payments, the books, GST import,
 * reconciliation and liability, and shop isolation.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { accChangeLog, accLedgerEntries, gstItcRecords, inventoryMovements, invStockLedger, shopProducts, shops } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { checkout, cancelOrder } from "@/server/services/orders";
import { updateShopProduct } from "@/server/services/catalogue";
import { getSettings, updateSettings } from "@/server/accounts/books";
import { ledgerDrift, listingLedger, stockSummary, writeOffStock, adjustStockTo, expiringBatches, costOfGoods } from "@/server/accounts/stock";
import { cancelPurchase, confirmPurchase, correctPurchase, getPurchase, type PurchaseInput } from "@/server/accounts/purchases";
import { createSalesInvoice, cancelSalesInvoice, salesInvoicePdf } from "@/server/accounts/sales";
import { recordPayment, recordExpense, cashBook, dayBook, trialBalance } from "@/server/accounts/money";
import { ageing, listParties, partyLedger } from "@/server/accounts/parties";
import { gstLiability, importFromPortal, importPortalFile, reconciliationView, requestLinkOtp, runReconciliation, verifyLinkOtp, sendGstReminders } from "@/server/accounts/gst";
import { MOCK_GST_OTP, setGstReturnsProviderForTests, getGstReturnsProvider } from "@/server/accounts/gst-returns-provider";
import { profitAndLoss, reportTable, tableToPdf, tableToXlsx, tallyXml } from "@/server/accounts/reports";
import { createCategory, createProduct, createShop, createShopProduct, createUser, createUserWithWallet, deliveryAddressId, resetDatabase } from "../helpers/fixtures";
import { gstin } from "../helpers/gstin";

beforeEach(resetDatabase);

const SHOP_GSTIN = gstin("27", "AAACK1234A");
const LOCAL_SUPPLIER = gstin("27", "AABCS5678B");
const OTHER_STATE_SUPPLIER = gstin("29", "AABCT9012C");

const TODAY = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);

async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Ledger Dairy" });
  await db.update(shops).set({ gstin: SHOP_GSTIN, state: "Maharashtra" }).where(eq(shops.id, shop.id));
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Toned Milk 500 ml", unit: "L" });
  await db.execute(sql`UPDATE products SET unit_size_milli = 500, hsn_code = '0401', gst_rate_bp = 0 WHERE id = ${milk.id}`);
  const ghee = await createProduct(category.id, { name: "Cow Ghee 1 kg", unit: "kg" });
  await db.execute(sql`UPDATE products SET hsn_code = '0405', gst_rate_bp = 1200 WHERE id = ${ghee.id}`);
  const milkSp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 3000, onlineStock: 10 });
  const gheeSp = await createShopProduct(shop.id, ghee.id, { onlinePricePaise: 65_000, onlineStock: 0 });
  const actor = { id: owner.id, role: "SHOP_OWNER" as const };
  return { owner, shop, milkSp, gheeSp, actor };
}

function bill(gheeSp: string, overrides: Partial<PurchaseInput> = {}): PurchaseInput {
  return {
    supplier: { name: "Sahyadri Traders", gstin: LOCAL_SUPPLIER },
    invoiceNo: "ST/101",
    invoiceDate: TODAY,
    lines: [{ shopProductId: gheeSp, description: "COW GHEE 1KG JAR", hsn: "0405", qtyMilli: 10_000, unit: "pcs", ratePaise: 50_000, gstRateBp: 1200, batchNo: "B1", expiryDate: "2099-01-01" }],
    ...overrides,
  };
}

const stockOf = async (id: string) => (await db.select().from(shopProducts).where(eq(shopProducts.id, id)))[0];
const ledgerSum = async (id: string) => Number((await db.execute<{ s: number }>(sql`select coalesce(sum(qty_milli),0)::bigint s from inv_stock_ledger where shop_product_id = ${id}`))[0].s);

describe("stock ledger follows every stock change (triggers)", () => {
  it("records opening stock of a new listing and keeps ledger = listing count", async () => {
    const { shop, milkSp } = await setup();
    expect(await ledgerSum(milkSp.id)).toBe(10_000);
    expect(await ledgerDrift(shop.id)).toEqual([]);
  });

  it("an online order reduces the ledger in the same transaction, a cancellation puts it back", async () => {
    const { shop, milkSp } = await setup();
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    await addToCart(customer.id, milkSp.id, 3);
    const { orders } = await checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "inv-order-1" });
    expect((await stockOf(milkSp.id)).onlineStock).toBe(7);
    expect(await ledgerSum(milkSp.id)).toBe(7_000);
    const [sale] = await db.select().from(invStockLedger).where(and(eq(invStockLedger.shopProductId, milkSp.id), eq(invStockLedger.movementType, "SALE")));
    expect(sale.orderId).toBe(orders[0].id);
    expect(sale.qtyMilli).toBe(-3_000);
    expect(sale.sourceType).toBe("ORDER");

    await cancelOrder(orders[0].id, { id: customer.id, role: "CUSTOMER" }, "changed my mind");
    expect(await ledgerSum(milkSp.id)).toBe(10_000);
    expect(await ledgerDrift(shop.id)).toEqual([]);
    // The restock is the order's return, linked to it (found on test.gokesari.com: it was an ADJUSTMENT).
    const [back] = await db.select().from(invStockLedger).where(and(eq(invStockLedger.shopProductId, milkSp.id), eq(invStockLedger.movementType, "SALE_RETURN")));
    expect(back.orderId).toBe(orders[0].id);
    expect(back.qtyMilli).toBe(3_000);
    expect(back.sourceType).toBe("ORDER");
  });

  it("a manual stock edit on the catalogue screen is an adjustment", async () => {
    const { shop, milkSp, actor } = await setup();
    await updateShopProduct(milkSp.id, { onlineStock: 25 }, actor);
    expect(await ledgerSum(milkSp.id)).toBe(25_000);
    const rows = await listingLedger(shop.id, milkSp.id);
    expect(rows[0].movementType).toBe("ADJUSTMENT");
    expect(rows[0].note).toBe("Manual stock update");
  });
});

describe("purchase confirm → stock, books, ITC (one transaction)", () => {
  it("adds stock at cost, posts a balanced voucher and an ITC record", async () => {
    const { shop, gheeSp, actor } = await setup();
    const p = await confirmPurchase(shop.id, bill(gheeSp.id), actor);
    expect(p.taxablePaise).toBe(500_000);
    expect(p.cgstPaise).toBe(30_000);
    expect(p.sgstPaise).toBe(30_000);
    expect(p.igstPaise).toBe(0);
    expect(p.totalPaise).toBe(560_000);
    expect((await stockOf(gheeSp.id)).onlineStock).toBe(10);
    expect(await ledgerDrift(shop.id)).toEqual([]);

    const legs = await db.select().from(accLedgerEntries).where(eq(accLedgerEntries.sourceId, p.id));
    expect(legs.reduce((n, l) => n + l.debitPaise, 0)).toBe(legs.reduce((n, l) => n + l.creditPaise, 0));
    expect(legs.find((l) => l.account === "PARTY")!.creditPaise).toBe(560_000);
    const [itc] = await db.select().from(gstItcRecords).where(eq(gstItcRecords.purchaseInvoiceId, p.id));
    expect(itc.status).toBe("PENDING_RECON");

    const summary = await stockSummary(shop.id);
    const ghee = summary.rows.find((r) => r.shopProductId === gheeSp.id)!;
    expect(ghee.qtyMilli).toBe(10_000);
    expect(ghee.valuePaise).toBe(500_000);
    expect(ghee.unitCostPaise).toBe(50_000);
    expect(ghee.trackBatches).toBe(true);
    expect(ghee.nearestExpiry).toBe("2099-01-01");
  });

  it("charges IGST for a supplier in another state", async () => {
    const { shop, gheeSp, actor } = await setup();
    const p = await confirmPurchase(shop.id, bill(gheeSp.id, { supplier: { name: "Bengaluru Foods", gstin: OTHER_STATE_SUPPLIER } }), actor);
    expect(p.interState).toBe(true);
    expect(p.igstPaise).toBe(60_000);
    expect(p.cgstPaise).toBe(0);
  });

  it("refuses the same supplier + invoice number twice", async () => {
    const { shop, gheeSp, actor } = await setup();
    await confirmPurchase(shop.id, bill(gheeSp.id), actor);
    await expect(confirmPurchase(shop.id, bill(gheeSp.id, { invoiceNo: "st/101" }), actor)).rejects.toThrow(/already in your books/);
    expect((await stockOf(gheeSp.id)).onlineStock).toBe(10);
  });

  it("converts bill units: 6 L of a 500 ml listing is 12 packs; fractional kg stays exact in the ledger", async () => {
    const { shop, milkSp, gheeSp, actor } = await setup();
    await confirmPurchase(
      shop.id,
      bill(gheeSp.id, {
        lines: [
          { shopProductId: milkSp.id, description: "TONED MILK", qtyMilli: 6_000, unit: "LTR", ratePaise: 5000, gstRateBp: 0 },
          { shopProductId: gheeSp.id, description: "GHEE LOOSE", qtyMilli: 2_500, unit: "kg", ratePaise: 48_000, gstRateBp: 1200 },
        ],
      }),
      actor,
    );
    expect((await stockOf(milkSp.id)).onlineStock).toBe(22);
    expect(await ledgerSum(gheeSp.id)).toBe(2_500);
    expect((await stockOf(gheeSp.id)).onlineStock).toBe(2);
    expect(await ledgerDrift(shop.id)).toEqual([]);
  });

  it("creates a new product from a bill line", async () => {
    const { shop, gheeSp, actor } = await setup();
    const p = await confirmPurchase(
      shop.id,
      bill(gheeSp.id, { lines: [{ createNew: { name: "Kesar Shrikhand 250 g", unit: "piece", gstRateBp: 500, hsn: "0406" }, description: "SHRIKHAND KESAR 250G", qtyMilli: 24_000, unit: "nos", ratePaise: 6000, gstRateBp: 500 }] }),
      actor,
    );
    const { lines } = await getPurchase(shop.id, p.id);
    expect(lines[0].productName).toBe("Kesar Shrikhand 250 g");
    const sp = await stockOf(lines[0].shopProductId!);
    expect(sp.onlineStock).toBe(24);
    expect(sp.onlineSaleEnabled).toBe(false);
  });
});

describe("post-confirmation correction", () => {
  it("posts reversals and the corrected version, re-syncs stock, books and ITC, and logs old → new", async () => {
    const { shop, gheeSp, actor } = await setup();
    const p = await confirmPurchase(shop.id, bill(gheeSp.id), actor);
    const corrected = bill(gheeSp.id);
    corrected.lines[0].qtyMilli = 8_000;
    corrected.lines[0].ratePaise = 52_000;
    const v2 = await correctPurchase(shop.id, p.id, corrected, actor, "misread quantity");
    expect(v2.version).toBe(2);
    expect(v2.taxablePaise).toBe(416_000);
    expect((await stockOf(gheeSp.id)).onlineStock).toBe(8);
    expect(await ledgerSum(gheeSp.id)).toBe(8_000);

    const rows = await db.select().from(invStockLedger).where(eq(invStockLedger.sourceId, p.id));
    expect(rows.filter((r) => r.movementType === "REVERSAL")).toHaveLength(1);
    expect(rows.filter((r) => r.movementType === "PURCHASE")).toHaveLength(2);

    const legs = await db.select().from(accLedgerEntries).where(and(eq(accLedgerEntries.sourceId, p.id), eq(accLedgerEntries.account, "PARTY")));
    expect(legs.reduce((n, l) => n + l.creditPaise - l.debitPaise, 0)).toBe(v2.totalPaise);

    const itc = await db.select().from(gstItcRecords).where(eq(gstItcRecords.purchaseInvoiceId, p.id));
    expect(itc.filter((r) => r.supersededAt === null)).toHaveLength(1);
    expect(itc.find((r) => r.supersededAt === null)!.cgstPaise).toBe(v2.cgstPaise);

    const [log] = await db.select().from(accChangeLog).where(and(eq(accChangeLog.entityId, p.id), eq(accChangeLog.action, "CORRECT")));
    expect(log.actorId).toBe(actor.id);
    expect(log.reason).toBe("misread quantity");
    expect(log.changes).toEqual(expect.arrayContaining([{ field: "lines[1].qtyMilli", old: 10_000, new: 8_000 }, { field: "lines[1].ratePaise", old: 50_000, new: 52_000 }]));

    // Valuation forgets the reversed version entirely.
    const ghee = (await stockSummary(shop.id)).rows.find((r) => r.shopProductId === gheeSp.id)!;
    expect(ghee.valuePaise).toBe(416_000);
  });

  it("a cancelled bill takes its stock and books back out", async () => {
    const { shop, gheeSp, actor } = await setup();
    const p = await confirmPurchase(shop.id, bill(gheeSp.id), actor);
    await cancelPurchase(shop.id, p.id, actor, "wrong shop");
    expect((await stockOf(gheeSp.id)).onlineStock).toBe(0);
    const tb = await trialBalance(shop.id);
    for (const row of tb) expect(row.debitPaise).toBe(row.creditPaise);
  });

  it("a correction after some stock was sold never drives the count negative", async () => {
    const { shop, gheeSp, actor } = await setup();
    const p = await confirmPurchase(shop.id, bill(gheeSp.id), actor);
    await updateShopProduct(gheeSp.id, { onlineStock: 2 }, actor); // 8 sold off the books
    const corrected = bill(gheeSp.id);
    corrected.lines[0].qtyMilli = 1_000;
    await correctPurchase(shop.id, p.id, corrected, actor, null);
    expect((await stockOf(gheeSp.id)).onlineStock).toBeGreaterThanOrEqual(0);
    expect(await ledgerDrift(shop.id)).toEqual([]);
  });
});

describe("valuation, write-offs and P&L", () => {
  it("FIFO and weighted average value the same stock differently", async () => {
    const { shop, gheeSp, actor } = await setup();
    await confirmPurchase(shop.id, bill(gheeSp.id, { invoiceNo: "A1", lines: [{ shopProductId: gheeSp.id, description: "GHEE", qtyMilli: 10_000, unit: "pcs", ratePaise: 40_000, gstRateBp: 1200 }] }), actor);
    await confirmPurchase(shop.id, bill(gheeSp.id, { invoiceNo: "A2", lines: [{ shopProductId: gheeSp.id, description: "GHEE", qtyMilli: 10_000, unit: "pcs", ratePaise: 60_000, gstRateBp: 1200 }] }), actor);
    await updateShopProduct(gheeSp.id, { onlineStock: 10 }, actor); // 10 left the shelf
    const fifo = (await stockSummary(shop.id, { method: "FIFO" })).rows.find((r) => r.shopProductId === gheeSp.id)!;
    const wavg = (await stockSummary(shop.id, { method: "WAVG" })).rows.find((r) => r.shopProductId === gheeSp.id)!;
    expect(fifo.valuePaise).toBe(600_000);
    expect(wavg.valuePaise).toBe(500_000);
  });

  it("write-off and physical count adjust stock; P&L shows COGS, write-offs and expenses", async () => {
    const { shop, gheeSp, actor, owner } = await setup();
    await confirmPurchase(shop.id, bill(gheeSp.id), actor);
    await writeOffStock(shop.id, { shopProductId: gheeSp.id, qtyMilli: 1_000, kind: "DAMAGE", note: "jar broke" }, owner.id);
    expect((await stockOf(gheeSp.id)).onlineStock).toBe(9);
    await adjustStockTo(shop.id, gheeSp.id, 8_000, "count", owner.id);
    expect((await stockOf(gheeSp.id)).onlineStock).toBe(8);
    await createSalesInvoice(shop.id, { paymentMode: "CASH", lines: [{ shopProductId: gheeSp.id, description: "Cow Ghee", qtyMilli: 2_000, ratePaise: 60_000, gstRateBp: 1200 }] }, owner);
    await recordExpense(shop.id, { category: "ELECTRICITY", mode: "CASH", amountPaise: 118_000, gstPaise: 18_000 }, owner.id);
    const next = new Date(`${TODAY}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const p = await profitAndLoss(shop.id, `${MONTH}-01`, next.toISOString().slice(0, 10));
    expect(p.salesOwnPaise).toBe(120_000);
    expect(p.cogsPaise).toBe(100_000);
    expect(p.writeOffPaise).toBe(50_000);
    expect(p.expensesPaise).toBe(100_000);
    expect(p.netProfitPaise).toBe(120_000 - 100_000 - 50_000 - 100_000);
    const goods = await costOfGoods(shop.id, `${MONTH}-01`, next.toISOString().slice(0, 10));
    expect(goods.closingValuePaise).toBe(300_000);
  });

  it("lists batches that are about to expire", async () => {
    const { shop, gheeSp, actor } = await setup();
    const soon = new Date(`${TODAY}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + 10);
    await confirmPurchase(shop.id, bill(gheeSp.id, { lines: [{ shopProductId: gheeSp.id, description: "GHEE", qtyMilli: 5_000, unit: "pcs", ratePaise: 50_000, gstRateBp: 1200, batchNo: "SOON", expiryDate: soon.toISOString().slice(0, 10) }] }), actor);
    const list = await expiringBatches(shop.id);
    expect(list).toHaveLength(1);
    expect(list[0].qtyMilli).toBe(5_000);
  });
});

describe("sales invoices, payments, ledgers", () => {
  it("issues an inter-state invoice with IGST and a numbered series; cancelling reverses stock", async () => {
    const { shop, gheeSp, actor, owner } = await setup();
    await confirmPurchase(shop.id, bill(gheeSp.id), actor);
    const inv = await createSalesInvoice(shop.id, { paymentMode: "CREDIT", buyerName: "Hotel Blue", buyerGstin: OTHER_STATE_SUPPLIER, lines: [{ shopProductId: gheeSp.id, description: "Cow Ghee", qtyMilli: 3_000, ratePaise: 60_000, gstRateBp: 1200 }] }, owner);
    expect(inv.interState).toBe(true);
    expect(inv.igstPaise).toBe(21_600);
    expect(inv.invoiceNo).toMatch(/^S\d{4}-00001$/);
    expect((await stockOf(gheeSp.id)).onlineStock).toBe(7);
    const pdf = await salesInvoicePdf(shop.id, inv.id);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const receivables = await ageing(shop.id, "RECEIVABLE");
    expect(receivables[0].totalPaise).toBe(inv.totalPaise);
    await cancelSalesInvoice(shop.id, inv.id, "duplicate", owner);
    expect((await stockOf(gheeSp.id)).onlineStock).toBe(10);
  });

  it("supplier payment reduces the payable; cash book and day book show it", async () => {
    const { shop, gheeSp, actor, owner } = await setup();
    const p = await confirmPurchase(shop.id, bill(gheeSp.id), actor);
    const supplier = (await listParties(shop.id, "SUPPLIER"))[0];
    expect(supplier.balancePaise).toBe(560_000);
    await recordPayment(shop.id, { partyId: supplier.id, direction: "PAID", mode: "CASH", amountPaise: 200_000, purchaseInvoiceId: p.id }, owner.id);
    const ledger = await partyLedger(shop.id, supplier.id);
    expect(ledger.balancePaise).toBe(360_000);
    const payables = await ageing(shop.id, "PAYABLE");
    expect(payables[0].totalPaise).toBe(360_000);
    const next = new Date(`${TODAY}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const cash = await cashBook(shop.id, "CASH", TODAY, next.toISOString().slice(0, 10));
    expect(cash.outPaise).toBe(200_000);
    const day = await dayBook(shop.id, TODAY, next.toISOString().slice(0, 10));
    expect(day.length).toBeGreaterThanOrEqual(2);
    for (const v of day) expect(v.legs.reduce((n, l) => n + l.debitPaise - l.creditPaise, 0)).toBe(0);
  });
});

describe("GST portal: import, reconciliation, liability", () => {
  it("manual GSTR-2B JSON fallback reconciles bills: matched, mismatch, missing in books, missing on portal", async () => {
    const { shop, gheeSp, actor } = await setup();
    const a = await confirmPurchase(shop.id, bill(gheeSp.id, { invoiceNo: "INV-1" }), actor);
    const b = await confirmPurchase(shop.id, bill(gheeSp.id, { invoiceNo: "INV-2" }), actor);
    await confirmPurchase(shop.id, bill(gheeSp.id, { invoiceNo: "INV-3" }), actor);
    const dmy = `${TODAY.slice(8, 10)}-${TODAY.slice(5, 7)}-${TODAY.slice(0, 4)}`;
    const json = {
      data: {
        gstin: SHOP_GSTIN,
        rtnprd: `${MONTH.slice(5, 7)}${MONTH.slice(0, 4)}`,
        docdata: {
          b2b: [
            {
              ctin: LOCAL_SUPPLIER,
              trdnm: "Sahyadri Traders",
              inv: [
                { inum: "INV-1", typ: "R", dt: dmy, val: a.totalPaise / 100, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 12, txval: 5000, igst: 0, cgst: 300, sgst: 300, cess: 0 }] },
                { inum: "INV-2", typ: "R", dt: dmy, val: b.totalPaise / 100 + 100, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 12, txval: 5100, igst: 0, cgst: 306, sgst: 306, cess: 0 }] },
                { inum: "INV-9", typ: "R", dt: dmy, val: 1180, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 18, txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 }] },
              ],
            },
          ],
        },
      },
    };
    const result = await importPortalFile(shop.id, { bytes: Buffer.from(JSON.stringify(json)), fileName: "2b.json", contentType: "application/json", period: MONTH }, actor.id);
    expect(result.invoices).toBe(3);
    expect(result.recon!.counts).toEqual({ MATCHED: 1, AMOUNT_MISMATCH: 1, MISSING_IN_BOOKS: 1, MISSING_ON_PORTAL: 1 });
    const view = await reconciliationView(shop.id, MONTH);
    expect(view.items).toHaveLength(4);

    const liability = await gstLiability(shop.id, MONTH, "MONTHLY");
    expect(liability.months[0].eligibleItc.cgst).toBe(30_000); // only INV-1 is reconciled
    expect(liability.months[0].pendingItc.cgst).toBe(60_000);
    expect(liability.note).toMatch(/verify with your CA/);
  });

  it("API path through the mock GSP: consent + OTP link, then pull GSTR-2B", async () => {
    const { shop, gheeSp, actor } = await setup();
    const previous = getGstReturnsProvider();
    process.env.GST_RETURNS_PROVIDER = "mock";
    try {
      for (const n of ["A", "B", "C"]) await confirmPurchase(shop.id, bill(gheeSp.id, { invoiceNo: `M-${n}` }), actor);
      await expect(requestLinkOtp(shop.id, { gstin: SHOP_GSTIN, username: "ledgerdairy", consent: false }, actor.id)).rejects.toThrow(/consent/);
      await requestLinkOtp(shop.id, { gstin: SHOP_GSTIN, username: "ledgerdairy", consent: true }, actor.id);
      await expect(verifyLinkOtp(shop.id, "111111", actor.id)).rejects.toThrow(/Wrong OTP/);
      await verifyLinkOtp(shop.id, MOCK_GST_OTP, actor.id);
      const pulled = await importFromPortal(shop.id, "GSTR2B", MONTH, actor.id);
      expect(pulled.recon!.counts).toEqual({ MATCHED: 1, AMOUNT_MISMATCH: 1, MISSING_IN_BOOKS: 1, MISSING_ON_PORTAL: 1 });
      // Credentials are stored encrypted, never in plain text.
      const raw = await db.execute<{ c: string }>(sql`select credentials_encrypted c from gst_portal_links where shop_id = ${shop.id}`);
      expect(raw[0].c).toMatch(/^v1:/);
    } finally {
      delete process.env.GST_RETURNS_PROVIDER;
      setGstReturnsProviderForTests(null);
      void previous;
    }
  });

  it("net GST = output − reconciled ITC, per head", async () => {
    const { shop, gheeSp, actor, owner } = await setup();
    const p = await confirmPurchase(shop.id, bill(gheeSp.id), actor); // input 300 + 300
    await createSalesInvoice(shop.id, { paymentMode: "CASH", lines: [{ shopProductId: gheeSp.id, description: "Ghee", qtyMilli: 10_000, ratePaise: 70_000, gstRateBp: 1200 }] }, owner); // output 420 + 420
    await db.update(gstItcRecords).set({ status: "MATCHED" }).where(eq(gstItcRecords.purchaseInvoiceId, p.id));
    const view = await gstLiability(shop.id, MONTH, "MONTHLY");
    expect(view.total.output).toEqual({ cgst: 42_000, sgst: 42_000, igst: 0, cess: 0 });
    expect(view.total.eligibleItc).toEqual({ cgst: 30_000, sgst: 30_000, igst: 0, cess: 0 });
    expect(view.total.cash).toEqual({ cgst: 12_000, sgst: 12_000, igst: 0, cess: 0 });
    expect(view.dueDates.map((d) => d.returnType)).toEqual(["GSTR1", "GSTR3B"]);
    await runReconciliation(shop.id, MONTH);
  });

  it("due-date reminders are sent once", async () => {
    const { shop } = await setup();
    await getSettings(shop.id);
    await updateSettings(shop.id, { reminderDaysBefore: 30 }, (await db.select().from(shops).where(eq(shops.id, shop.id)))[0].ownerId);
    const first = await sendGstReminders(TODAY);
    const second = await sendGstReminders(TODAY);
    expect(first.sent).toBeGreaterThan(0);
    expect(second.sent).toBe(0);
  });
});

describe("reports and exports", () => {
  it("builds every report and exports Excel, PDF and Tally XML", async () => {
    const { shop, gheeSp, actor } = await setup();
    await confirmPurchase(shop.id, bill(gheeSp.id), actor);
    const next = new Date(`${TODAY}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const to = next.toISOString().slice(0, 10);
    for (const kind of ["pnl", "stock", "daybook", "purchases", "sales", "gst", "ledger"] as const) {
      const t = await reportTable(shop.id, kind, `${MONTH}-01`, to);
      expect(t.header.length).toBeGreaterThan(1);
      const xlsx = await tableToXlsx(t);
      expect(xlsx.subarray(0, 2).toString()).toBe("PK");
      expect(tableToPdf(t).subarray(0, 5).toString()).toBe("%PDF-");
    }
    const xml = await tallyXml(shop.id, `${MONTH}-01`, to);
    expect(xml).toContain("<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>");
    expect(xml).toContain("Sundry Creditors");
    expect(xml).toContain(`<PARTYGSTIN>${LOCAL_SUPPLIER}</PARTYGSTIN>`);
  });
});

describe("isolation between shops", () => {
  it("one shop cannot post to or read another shop's listings and bills", async () => {
    const a = await setup();
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    const other = await createShop(otherOwner.id, { name: "Other Shop" });
    await expect(confirmPurchase(other.id, bill(a.gheeSp.id), { id: otherOwner.id, role: "SHOP_OWNER" })).rejects.toThrow(/not in your shop/);
    const p = await confirmPurchase(a.shop.id, bill(a.gheeSp.id), a.actor);
    await expect(getPurchase(other.id, p.id)).rejects.toThrow(/not found/i);
    expect(await listParties(other.id)).toEqual([]);
    const movements = await db.select().from(inventoryMovements).where(eq(inventoryMovements.shopProductId, a.gheeSp.id));
    expect(movements.length).toBeGreaterThan(0);
  });
});
