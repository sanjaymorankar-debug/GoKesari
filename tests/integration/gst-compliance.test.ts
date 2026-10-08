/**
 * Module 2 — GST compliance (docs/three-modules-2026-10): document numbering
 * from dated rules, credit notes on refunds, GSTIN validation through the
 * GSP (mock), e-invoice (IRN) and the GSTR-1-ready export. Real PostgreSQL.
 */
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as gstr1Route } from "@/app/api/shops/[id]/gst/gstr1/route";
import { isValidGstin } from "@/lib/gst-states";
import { db } from "@/server/db";
import {
  creditNotes,
  einvoiceRecords,
  gstinLookups,
  gstReturnExports,
  gstRules,
  platformSettings,
  products,
  shops,
  taxInvoices,
  type TaxInvoice,
} from "@/server/db/schema";
import { declareEinvoice, setGstRule } from "@/server/gst/config";
import { allocate, issueCreditNoteForRefund, renderCreditNotePdf } from "@/server/gst/credit-notes";
import { einvoiceApplies, processEinvoice, queueEinvoice, requestEinvoice } from "@/server/gst/einvoice";
import { resetMockGsp } from "@/server/gst/gsp/mock";
import { checkGstin } from "@/server/gst/gstin";
import { buildGstr1 } from "@/server/gst/gstr1";
import { formatDocumentNumber, istDate } from "@/server/gst/rules";
import { addToCart } from "@/server/services/cart";
import { einvoiceFor, financialYearOf, renderInvoicePdf, type InvoiceSnapshot } from "@/server/services/invoices";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };

/** A GSTIN with a correct check digit. */
function gstin(state: string, pan: string, entity = "1"): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const body = `${state}${pan}${entity}Z`;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const p = chars.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return body + chars[(36 - (sum % 36)) % 36];
}

const SELLER = gstin("27", "ABCDE1234F");
const BUYER = gstin("27", "PQRST5678K");

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["invoicing"]));
  await db.delete(gstRules);
  clearRuleCache();
  resetMockGsp();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setRule("invoicing", { enabled: true }, admin);
  state.session = null;
});

async function rule(key: string, value: unknown, from = "2017-07-01", to: string | null = null) {
  await db.insert(gstRules).values({ key, value, effectiveFrom: from, effectiveTo: to });
}

async function gstShop() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  await db.update(products).set({ gstRateBp: 500, hsnCode: "0401" }).where(eq(products.id, milk.id));
  const ghee = await createProduct(cat.id, { name: "Ghee 500ml", unit: "pc" });
  await db.update(products).set({ gstRateBp: 1200, hsnCode: "0405" }).where(eq(products.id, ghee.id));
  const shop = await createShop(owner.id, { name: "Dairy GST" });
  await db.update(shops).set({ gstin: SELLER, gstStatus: "REGISTERED" }).where(eq(shops.id, shop.id));
  const milkSp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 10_500, onlineStock: 500 });
  const gheeSp = await createShopProduct(shop.id, ghee.id, { onlinePricePaise: 33_600, onlineStock: 500 });
  return { owner, shop, milkSp, gheeSp };
}

async function delivered(lines: [string, number][], requestId: string) {
  const { user } = await createUserWithWallet({ balancePaise: 20_000_000 });
  for (const [sp, qty] of lines) await addToCart(user.id, sp, qty);
  const { orders } = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId });
  for (const s of ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const) await updateOrderStatus(orders[0].id, s, admin);
  const [invoice] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, orders[0].id));
  return { order: orders[0], invoice };
}

/** Simulates a B2B sale (buyer GSTIN on the invoice) — GoKesari's B2B orders carry it the same way. */
async function makeB2b(invoice: TaxInvoice, buyerGstin = BUYER): Promise<TaxInvoice> {
  const snap = invoice.snapshot as unknown as InvoiceSnapshot;
  const [row] = await db
    .update(taxInvoices)
    .set({ snapshot: { ...snap, buyer: { ...snap.buyer, gstin: buyerGstin, name: "Hotel Sunrise" } } as unknown as Record<string, unknown> })
    .where(eq(taxInvoices.id, invoice.id))
    .returning();
  return row;
}

/* ============================================================== numbering */

describe("document numbering", () => {
  it("formats GST16 within 16 characters, and LEGACY as before", () => {
    expect(formatDocumentNumber("GST16", "INVOICE", "GK-SHOP-000012", "2026-27", 1)).toBe("GK2627-000001");
    expect(formatDocumentNumber("GST16", "CREDIT_NOTE", "GK-SHOP-000012", "2026-27", 42)).toBe("CN2627-000042");
    expect(formatDocumentNumber("GST16", "INVOICE", "X", "2026-27", 999_999).length).toBeLessThanOrEqual(16);
    expect(formatDocumentNumber("LEGACY", "INVOICE", "GK-SHOP-000012", "2026-27", 7)).toBe("GK-SHOP-000012/2026-27/000007");
    expect(formatDocumentNumber("LEGACY", "CREDIT_NOTE", "GK-SHOP-000012", "2026-27", 7)).toBe("GK-SHOP-000012/CN/2026-27/000007");
  });

  it("uses the rule in force on the invoice date", async () => {
    const { milkSp, shop } = await gstShop();
    const today = istDate(new Date());
    await rule("documentNumbering", { format: "LEGACY" }, "2017-07-01", "2020-12-31");
    await rule("documentNumbering", { format: "GST16" }, "2021-01-01");
    const { invoice } = await delivered([[milkSp.id, 1]], "num-1");
    const fy = financialYearOf(new Date());
    expect(invoice.invoiceNumber).toBe(`GK${fy.slice(2, 4)}${fy.slice(5, 7)}-000001`);
    expect(today >= "2021-01-01").toBe(true);
    expect(shop.id).toBeTruthy();
  });
});

/* =========================================================== credit notes */

describe("credit notes", () => {
  it("allocate() splits an amount in proportion and adds up exactly", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(5_001, [10_500, 33_600]).reduce((s, p) => s + p, 0)).toBe(5_001);
    expect(allocate(10, [0, 0])).toEqual([0, 0]);
  });

  it("credits across lines with each line's rate, never more than the invoice, once per refund", async () => {
    const { milkSp, gheeSp } = await gstShop();
    const { order, invoice } = await delivered([[milkSp.id, 1], [gheeSp.id, 1]], "cn-1");
    expect(invoice.totalPaise).toBe(44_100);

    const note = await issueCreditNoteForRefund({ orderId: order.id, sourceRef: "adj-1", amountPaise: 22_050, reason: "REFUND", restock: false });
    expect(note).not.toBeNull();
    expect(note!.totalPaise).toBe(22_050);
    expect(note!.taxablePaise + note!.cgstPaise + note!.sgstPaise + note!.igstPaise).toBe(22_050);
    const lines = (note!.snapshot as { lines: { rateBp: number; grossPaise: number }[] }).lines;
    expect(lines.map((l) => l.rateBp).sort()).toEqual([1200, 500]);
    expect(lines.reduce((s, l) => s + l.grossPaise, 0)).toBe(22_050);

    // The same refund again → the same note.
    expect((await issueCreditNoteForRefund({ orderId: order.id, sourceRef: "adj-1", amountPaise: 22_050, reason: "REFUND", restock: false }))!.id).toBe(note!.id);
    // A second refund larger than what is left is capped at the invoice.
    const second = await issueCreditNoteForRefund({ orderId: order.id, sourceRef: "adj-2", amountPaise: 50_000, reason: "RETURN", restock: true });
    expect(second!.totalPaise).toBe(22_050);
    expect(await issueCreditNoteForRefund({ orderId: order.id, sourceRef: "adj-3", amountPaise: 100, reason: "REFUND", restock: false })).toBeNull();
    const numbers = (await db.select().from(creditNotes)).map((n) => n.sequence).sort();
    expect(numbers).toEqual([1, 2]);

    const pdf = renderCreditNotePdf(second!).toString("latin1");
    expect(pdf).toContain("CREDIT NOTE");
    expect(pdf).toContain(invoice.invoiceNumber);
  });

  it("is not issued for an order without an invoice (cancelled before delivery)", async () => {
    const { milkSp } = await gstShop();
    const { user } = await createUserWithWallet({ balancePaise: 100_000 });
    await addToCart(user.id, milkSp.id, 1);
    const { orders } = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId: "no-inv" });
    expect(await issueCreditNoteForRefund({ orderId: orders[0].id, sourceRef: "x", amountPaise: 100, reason: "REFUND", restock: false })).toBeNull();
  });
});

/* ================================================================== GSTIN */

describe("GSTIN validation through the GSP", () => {
  it("checks format first, then the GST record; answers are cached", async () => {
    const user = await createUser({ role: "SHOP_OWNER" });
    expect(isValidGstin(SELLER)).toBe(true);
    const bad = await checkGstin(SELLER.slice(0, 14) + (SELLER[14] === "A" ? "B" : "A"), user);
    expect(bad).toMatchObject({ ok: false, reason: "FORMAT" });
    expect(await db.select().from(gstinLookups)).toHaveLength(0);

    const good = await checkGstin(SELLER.toLowerCase(), user);
    expect(good).toMatchObject({ ok: true, found: true, active: true, stateCode: "27", stateName: "Maharashtra" });
    await checkGstin(SELLER, user);
    expect(await db.select().from(gstinLookups)).toHaveLength(1);

    const cancelled = await checkGstin(gstin("29", "ABCDE9999F"), user);
    expect(cancelled).toMatchObject({ ok: true, found: true, active: false, status: "Cancelled" });
  });
});

/* ============================================================== e-invoice */

describe("e-invoice (IRN)", () => {
  it("applies only when switched on, declared by the shop, and B2B", async () => {
    const { milkSp, shop, owner } = await gstShop();
    await rule("documentNumbering", { format: "GST16" });
    const { invoice } = await delivered([[milkSp.id, 2]], "irn-1");
    expect((await einvoiceApplies(invoice)).applies).toBe(false); // rule missing = off
    await rule("einvoice", { enabled: true, turnoverThresholdPaise: 5_000_000_000, b2bOnly: true }, "2023-08-01");
    expect((await einvoiceApplies(invoice)).reason).toMatch(/B2B/);
    const b2b = await makeB2b(invoice);
    expect((await einvoiceApplies(b2b)).reason).toMatch(/declared/);
    await declareEinvoice(shop.id, { applicable: true, turnoverBand: "5_TO_10_CR" }, { id: owner.id, role: "SHOP_OWNER" });
    await expect(declareEinvoice(shop.id, { applicable: true, turnoverBand: "BELOW_5_CR" }, { id: owner.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await einvoiceApplies(b2b)).applies).toBe(true);

    const recordId = await queueEinvoice(b2b);
    expect(recordId).toBeTruthy();
    expect(await queueEinvoice(b2b)).toBeNull(); // one record per invoice
    const done = await processEinvoice(recordId!);
    expect(done).toMatchObject({ status: "GENERATED" });
    expect(done!.irn).toMatch(/^[0-9a-f]{64}$/);
    // Asking again returns the same IRN (the GSP answers DUPLICATE; we fetch the existing one).
    await db.update(einvoiceRecords).set({ status: "FAILED" }).where(eq(einvoiceRecords.id, recordId!));
    const again = await requestEinvoice(b2b.id);
    expect(again.irn).toBe(done!.irn);

    const irn = await einvoiceFor(b2b.id);
    const pdf = renderInvoicePdf(b2b, irn).toString("latin1");
    expect(pdf).toContain(done!.irn!.slice(0, 20));
  });

  it("fails clearly (and can be retried) when the invoice number is longer than 16 characters", async () => {
    const { milkSp, shop, owner } = await gstShop();
    await rule("einvoice", { enabled: true, turnoverThresholdPaise: 5_000_000_000, b2bOnly: true }, "2023-08-01");
    await declareEinvoice(shop.id, { applicable: true, turnoverBand: "ABOVE_100_CR" }, { id: owner.id, role: "SHOP_OWNER" });
    const { invoice } = await delivered([[milkSp.id, 1]], "irn-legacy");
    const b2b = await makeB2b(invoice);
    const record = await requestEinvoice(b2b.id);
    expect(record).toMatchObject({ status: "FAILED", errorCode: "INVALID" });
    expect(record.errorMessage).toMatch(/16/);
  });
});

/* ================================================================ GSTR-1 */

describe("GSTR-1-ready export", () => {
  it("sorts sales into B2B, B2C large and B2C small, nets credit notes, and adds up", async () => {
    const { milkSp, gheeSp, shop, owner } = await gstShop();
    await rule("b2clThreshold", { invoiceValuePaise: 10_000_000 }, "2024-08-01");
    const a = await delivered([[milkSp.id, 2]], "g-1"); // B2C small, intra
    const b = await delivered([[gheeSp.id, 1], [milkSp.id, 1]], "g-2"); // → B2B
    const c = await delivered([[gheeSp.id, 300]], "g-3"); // → B2C large, inter-state (₹1,00,800)
    await makeB2b(b.invoice);
    const cSnap = c.invoice.snapshot as unknown as InvoiceSnapshot;
    const inter = { ...cSnap, supplyType: "INTER" as const, placeOfSupply: "KA", lines: cSnap.lines.map((l) => ({ ...l, igstPaise: l.cgstPaise + l.sgstPaise, cgstPaise: 0, sgstPaise: 0 })), totals: { ...cSnap.totals, igstPaise: cSnap.totals.cgstPaise + cSnap.totals.sgstPaise, cgstPaise: 0, sgstPaise: 0 } };
    await db.update(taxInvoices).set({ snapshot: inter as unknown as Record<string, unknown>, supplyType: "INTER", igstPaise: inter.totals.igstPaise, cgstPaise: 0, sgstPaise: 0 }).where(eq(taxInvoices.id, c.invoice.id));
    // A refund against the B2C small invoice.
    await issueCreditNoteForRefund({ orderId: a.order.id, sourceRef: "r-a", amountPaise: 10_500, reason: "REFUND", restock: false });

    const period = istDate(new Date()).slice(0, 7);
    const result = await buildGstr1(shop.id, period);
    const json = result.json as {
      b2b: { ctin: string; inv: { inum: string; itms: { itm_det: { txval: number; rt: number } }[] }[] }[];
      b2cl: { pos: string; inv: { val: number }[] }[];
      b2cs: { sply_ty: string; rt: number; txval: number }[];
      hsn: { hsn_b2b: unknown[]; hsn_b2c: { hsn_sc: string; qty: number; txval: number }[] };
      doc_issue: { doc_det: { doc_num: number; docs: { totnum: number }[] }[] };
      fp: string;
    };
    expect(json.fp).toBe(`${period.slice(5, 7)}${period.slice(0, 4)}`);
    expect(json.b2b).toHaveLength(1);
    expect(json.b2b[0].ctin).toBe(BUYER);
    expect(json.b2b[0].inv[0].itms.map((i) => i.itm_det.rt).sort()).toEqual([12, 5]);
    expect(json.b2cl).toHaveLength(1);
    expect(json.b2cl[0].pos).toBe("29");
    // B2C small at 5%: invoice a (₹210 incl.) less the ₹105 credit note → ₹100 taxable.
    const small = json.b2cs.find((r) => r.rt === 5 && r.sply_ty === "INTRA");
    expect(small?.txval).toBe(100);
    // HSN (B2C) is net of the credit note too: 2 − 1 litres of milk.
    const milkHsn = json.hsn.hsn_b2c.find((h) => h.hsn_sc === "0401");
    expect(milkHsn).toMatchObject({ txval: 100 });
    expect(json.doc_issue.doc_det.find((d) => d.doc_num === 1)!.docs[0].totnum).toBe(3);
    expect(json.doc_issue.doc_det.find((d) => d.doc_num === 5)!.docs[0].totnum).toBe(1);

    const txval = (n: number) => Math.round(n * 100);
    const sumB2b = json.b2b.flatMap((x) => x.inv.flatMap((i) => i.itms.map((t) => txval(t.itm_det.txval)))).reduce((s, v) => s + v, 0);
    const sumB2cs = json.b2cs.reduce((s, r) => s + txval(r.txval), 0);
    const inv3 = await db.select().from(taxInvoices).where(eq(taxInvoices.id, c.invoice.id));
    expect(sumB2b + sumB2cs + inv3[0].taxablePaise).toBe(result.totals.taxablePaise);
    expect(result.warnings.join(" ")).toMatch(/E-commerce operator GSTIN/);

    // Download through the route: the owner gets the file and it is recorded; another owner is refused.
    state.session = { user: { id: owner.id, email: owner.email, name: null, image: null, role: "SHOP_OWNER", status: "ACTIVE" } };
    const res = await call(gstr1Route as never, `/api/shops/${shop.id}/gst/gstr1?period=${period}&format=xlsx`, { params: { id: shop.id } });
    expect(res.status).toBe(200);
    expect(await db.select().from(gstReturnExports).where(eq(gstReturnExports.shopId, shop.id))).toHaveLength(1);
    const stranger = await createUser({ role: "SHOP_OWNER" });
    state.session = { user: { id: stranger.id, email: stranger.email, name: null, image: null, role: "SHOP_OWNER", status: "ACTIVE" } };
    expect((await call(gstr1Route as never, `/api/shops/${shop.id}/gst/gstr1?period=${period}`, { params: { id: shop.id } })).status).toBe(403);
  });

  it("refuses a shop without a GSTIN", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    await expect(buildGstr1(shop.id, "2026-09")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

/* ============================================================ GST config */

describe("GST settings", () => {
  it("a change applies from its date and closes the previous rule; the past cannot be rewritten", async () => {
    await rule("b2clThreshold", { invoiceValuePaise: 10_000_000 }, "2024-08-01");
    const tomorrow = new Date(Date.now() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
    await setGstRule({ key: "b2clThreshold", value: { invoiceValuePaise: 20_000_000 }, effectiveFrom: tomorrow }, admin);
    const rows = await db.select().from(gstRules).where(eq(gstRules.key, "b2clThreshold")).orderBy(gstRules.effectiveFrom);
    expect(rows).toHaveLength(2);
    expect(rows[0].effectiveTo).toBe(istDate(new Date(Date.now() + 330 * 60_000 * 0)));
    expect(rows[1]).toMatchObject({ effectiveFrom: tomorrow, effectiveTo: null });
    await expect(setGstRule({ key: "b2clThreshold", value: { invoiceValuePaise: 1 }, effectiveFrom: "2020-01-01" }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(setGstRule({ key: "einvoice", value: { enabled: "yes" }, effectiveFrom: tomorrow }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
