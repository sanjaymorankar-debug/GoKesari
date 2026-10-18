/**
 * batch-2026-10 WS-E — F10.2.5 GoKesari's own fee invoices to shops (series,
 * IGST vs CGST/SGST, recipient GSTIN, QR, per cycle, credit / debit notes,
 * GSTR-1-ready export) and the dated statutory settings (TCS / TDS / s.9(5))
 * with their reports. Real PostgreSQL.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.mock("@/server/email/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email/transport")>();
  return { ...actual, emailMode: () => "smtp" as const, sendEmail: vi.fn(async () => {}) };
});
const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as notesRoute } from "@/app/api/admin/platform-invoices/notes/route";
import { PATCH as statutoryPatchRoute } from "@/app/api/admin/statutory/[id]/route";
import { GET as reportsRoute } from "@/app/api/admin/statutory/reports/route";
import { db } from "@/server/db";
import { documentEmails, payoutCycleLines, platformInvoices, statutoryRates } from "@/server/db/schema";
import { closePayoutCycle } from "@/server/payouts/cycle";
import { buildTcsReport, buildTdsReport } from "@/server/payouts/reports";
import {
  buildPlatformGstr1,
  issuePlatformNoteByAdmin,
  renderPlatformInvoicePdf,
  type PlatformInvoiceSnapshot,
} from "@/server/platform-invoices/service";
import { setCommissionRate } from "@/server/services/finance";
import { financialYearOf } from "@/server/services/invoices";
import { addStatutoryRate, listStatutoryRates, statutoryRateOn, updateStatutoryRate } from "@/server/statutory/rates";
import { call } from "../helpers/http";
import { addDaysIso, deliveredOrder, gstin, gstShop, GOKESARI_GSTIN, IST_TODAY, resetBatchE, rules, verifiedBank } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";
import { decodePdfQr } from "../helpers/pdf-qr";

let admin = { id: "", role: "ADMIN" as const };
const today = IST_TODAY();
const fy = financialYearOf(new Date());
const fy4 = `${fy.slice(2, 4)}${fy.slice(5, 7)}`;
const period = today.slice(0, 7);

const PROFILE = {
  legalName: "GoKesari Technologies Pvt Ltd",
  tradeName: "GoKesari",
  gstin: GOKESARI_GSTIN,
  pan: "AABCG1234K",
  address: "1 MG Road, Bengaluru 560001",
  stateCode: "KA",
};

function sessionFor(user: { id: string; role: UserRole }) {
  state.session = { user: { id: user.id, email: `${user.id}@test.local`, name: null, image: null, role: user.role, status: "ACTIVE" } };
}

async function enable(profile: Record<string, unknown> = PROFILE, payouts: Record<string, unknown> = {}) {
  await rules(admin, {
    invoicing: { enabled: true },
    payouts: { enabled: true, anchorDate: addDaysIso(today, -10), cycleDays: 5, holdDays: 0, provider: "SANDBOX", ...payouts },
    platformInvoicing: { enabled: true },
    platformTaxProfile: profile,
  });
}

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  state.session = null;
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setCommissionRate({ scope: "DEFAULT", rateBp: 1000 }, admin);
  await enable();
});

afterAll(async () => {
  await resetBatchE();
});

async function sellingShop(options: Parameters<typeof gstShop>[0] = {}, qty = 4, daysAgo = 3) {
  const s = await gstShop(options);
  await verifiedBank(s.owner.id, s.shop.id);
  const sale = await deliveredOrder(admin, [[s.milkSp.id, qty]], { deliveredDaysAgo: daysAgo });
  return { ...s, ...sale };
}

describe("GoKesari's invoice per cycle", () => {
  it("TC-B26-E-040 one invoice per shop per cycle: 16-character unique series, IGST across states, CGST+SGST within, recipient GSTIN, QR; GST deducted from the payout", async () => {
    const mh = await sellingShop({ name: "Pune Dairy" }); // MH shop, GoKesari in KA → IGST
    const ka = await sellingShop({ name: "Bengaluru Dairy", gstin: gstin("29", "PQRST5678K"), state: "KA" });
    const result = await closePayoutCycle({ today, actor: admin });
    const invoices = await db.select().from(platformInvoices).orderBy(platformInvoices.sequence);
    expect(invoices).toHaveLength(2);
    expect(invoices.map((i) => i.invoiceNumber)).toEqual([`GKP/${fy4}/000001`, `GKP/${fy4}/000002`]);
    for (const inv of invoices) expect(inv.invoiceNumber.length).toBeLessThanOrEqual(16);
    const mhInv = invoices.find((i) => i.shopId === mh.shop.id)!;
    const kaInv = invoices.find((i) => i.shopId === ka.shop.id)!;
    // Commission ₹42 at 18%.
    expect(mhInv).toMatchObject({ supplyType: "INTER", taxablePaise: 4_200, igstPaise: 756, cgstPaise: 0, sgstPaise: 0, totalPaise: 4_956, recipientGstin: mh.shop.gstin, placeOfSupply: "MH" });
    expect(kaInv).toMatchObject({ supplyType: "INTRA", cgstPaise: 378, sgstPaise: 378, igstPaise: 0, recipientGstin: ka.shop.gstin });
    const s = mhInv.snapshot as unknown as PlatformInvoiceSnapshot;
    expect(s.supplier).toMatchObject({ gstin: GOKESARI_GSTIN, legalName: "GoKesari Technologies Pvt Ltd", stateCode: "KA" });
    expect(s.lines[0]).toMatchObject({ feeType: "COMMISSION", sac: "998599", rateBp: 1800 });
    const qr = decodePdfQr(renderPlatformInvoicePdf(mhInv))!;
    expect(qr).toContain(`DocNo:GKP/${fy4}/000001`);
    expect(qr).toContain(`BuyerGSTIN:${mh.shop.gstin}`);
    // The payout carries the GST on fees; the shop owner gets the invoice by email.
    const feeGst = await db.select().from(payoutCycleLines).where(and(eq(payoutCycleLines.lineType, "FEE_GST"), eq(payoutCycleLines.shopId, mh.shop.id)));
    expect(feeGst.map((l) => l.amountPaise)).toEqual([-756]);
    expect(result!.items.find((i) => i.shopId === mh.shop.id)!.breakdown.FEE_GST).toBe(-756);
    expect(await db.select().from(documentEmails).where(and(eq(documentEmails.docType, "PLATFORM_INVOICE"), eq(documentEmails.docId, mhInv.id)))).toHaveLength(1);
    // Re-running the cycle never issues a second invoice.
    await closePayoutCycle({ today, actor: admin });
    expect(await db.select().from(platformInvoices)).toHaveLength(2);
  });

  it("TC-B26-E-041 switched on without GoKesari's GSTIN / legal details: no invoice, no GST on fees, and the cycle says why; off: nothing at all", async () => {
    await enable({ ...PROFILE, gstin: "", legalName: "" });
    const { shop } = await sellingShop();
    const result = await closePayoutCycle({ today, actor: admin });
    expect(await db.select().from(platformInvoices)).toHaveLength(0);
    expect(result!.cycle.warnings.join(" ")).toContain("legal name, GSTIN");
    expect(result!.items[0].breakdown.FEE_GST).toBeUndefined();
    await rules(admin, { invoicing: { enabled: true }, payouts: { enabled: true, anchorDate: addDaysIso(today, -10), holdDays: 0 }, platformInvoicing: { enabled: false }, platformTaxProfile: PROFILE });
    await sellingShop({ name: "Later" }, 1, 1);
    await closePayoutCycle({ today: addDaysIso(today, 5), actor: admin });
    expect(await db.select().from(platformInvoices)).toHaveLength(0);
    expect(shop.id).toBeTruthy();
  });

  it("TC-B26-E-042 credit and debit notes: own series, never below zero, settled through the next payout; finance only", async () => {
    const { shop, owner } = await sellingShop();
    await closePayoutCycle({ today, actor: admin });
    const [invoice] = await db.select().from(platformInvoices);
    const credit = await issuePlatformNoteByAdmin({ invoiceId: invoice.id, kind: "CREDIT", reason: "Commission over-charged", feeType: "COMMISSION", taxablePaise: 1_000, requestId: "note-req-1" }, admin);
    expect(credit).toMatchObject({ kind: "CREDIT", noteNumber: `GKC/${fy4}/000001`, taxablePaise: 1_000, igstPaise: 180, totalPaise: 1_180 });
    // The same request again returns the same note.
    expect((await issuePlatformNoteByAdmin({ invoiceId: invoice.id, kind: "CREDIT", reason: "Commission over-charged", feeType: "COMMISSION", taxablePaise: 1_000, requestId: "note-req-1" }, admin)).id).toBe(credit.id);
    await expect(issuePlatformNoteByAdmin({ invoiceId: invoice.id, kind: "CREDIT", reason: "Too much", feeType: "COMMISSION", taxablePaise: 4_000, requestId: "note-req-2" }, admin)).rejects.toMatchObject({ code: "CONFLICT" });
    const debit = await issuePlatformNoteByAdmin({ invoiceId: invoice.id, kind: "DEBIT", reason: "Delivery charge not billed", feeType: "DELIVERY_CHARGE", taxablePaise: 500, requestId: "note-req-3" }, admin);
    expect(debit.noteNumber).toBe(`GKD/${fy4}/000001`);
    sessionFor(owner);
    expect((await call(notesRoute, "/api/admin/platform-invoices/notes", { method: "POST", body: { invoiceId: invoice.id, kind: "CREDIT", feeType: "COMMISSION", taxablePaise: 100, reason: "Please", requestId: "owner-attempt-1" } })).status).toBe(403);

    await sellingShop({ name: "Keeps the cycle going" }, 1, 1);
    const next = await closePayoutCycle({ today: addDaysIso(today, 5), actor: admin });
    const noteLines = await db.select().from(payoutCycleLines).where(and(eq(payoutCycleLines.lineType, "PLATFORM_NOTE"), eq(payoutCycleLines.cycleId, next!.cycle.id)));
    expect(noteLines.map((l) => l.amountPaise).sort((a, b) => a - b)).toEqual([-590, 1_180]);
    expect(noteLines.every((l) => l.shopId === shop.id)).toBe(true);
  });

  it("TC-B26-E-043 commission given back on a refund gets an automatic credit note and its GST back in the payout", async () => {
    const { order, shop } = await sellingShop();
    const { refundDeliveredOrder } = await import("@/server/services/finance");
    await refundDeliveredOrder({ orderNumber: order.orderNumber, amountPaise: 10_500, reason: "Spoiled", chargeTo: "SHOP", requestId: "auto-cn-1" }, admin);
    const { financialAdjustments } = await import("@/server/db/schema");
    const { sql } = await import("drizzle-orm");
    await db.update(financialAdjustments).set({ createdAt: sql`now() - interval '2 days'` });
    await closePayoutCycle({ today, actor: admin });
    const notes = await db.query.platformCreditDebitNotes.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "CREDIT", taxablePaise: 1_050, igstPaise: 189, shopId: shop.id });
    const back = await db.select().from(payoutCycleLines).where(and(eq(payoutCycleLines.lineType, "FEE_GST"), eq(payoutCycleLines.sourceType, "platform_credit_debit_notes")));
    expect(back.map((l) => l.amountPaise)).toEqual([189]);
  });

  it("TC-B26-E-044 monthly GSTR-1-ready export of GoKesari's supplies: B2B, B2CS, CDNR, SAC summary, documents; CSV and JSON", async () => {
    const registered = await sellingShop({ name: "Registered" });
    await sellingShop({ name: "Unregistered", gstin: null });
    await closePayoutCycle({ today, actor: admin });
    const regInvoice = (await db.select().from(platformInvoices).where(eq(platformInvoices.shopId, registered.shop.id)))[0];
    await issuePlatformNoteByAdmin({ invoiceId: regInvoice.id, kind: "CREDIT", reason: "Goodwill", feeType: "COMMISSION", taxablePaise: 200, requestId: "gstr-note-1" }, admin);
    const g = await buildPlatformGstr1(period);
    expect(g.counts).toMatchObject({ b2b: 1, b2cs: 1, cdnr: 1, invoices: 2, notes: 1 });
    const json = g.json as { gstin: string; fp: string; b2b: { ctin: string; inv: { inum: string; pos: string }[] }[]; b2cs: { pos: string; rt: number; txval: number }[]; cdnr: { ctin: string; nt: { ntty: string }[] }[]; hsn: { data: { hsn_sc: string; txval: number }[] }; doc_issue: { doc_det: unknown[] } };
    expect(json.gstin).toBe(GOKESARI_GSTIN);
    expect(json.fp).toBe(`${period.slice(5, 7)}${period.slice(0, 4)}`);
    expect(json.b2b[0]).toMatchObject({ ctin: registered.shop.gstin });
    expect(json.b2b[0].inv[0]).toMatchObject({ inum: regInvoice.invoiceNumber, pos: "27" });
    expect(json.b2cs[0]).toMatchObject({ pos: "27", rt: 18, txval: 42 });
    expect(json.cdnr[0].nt[0].ntty).toBe("C");
    expect(json.hsn.data[0]).toMatchObject({ hsn_sc: "998599", txval: 84 - 2 });
    expect(json.doc_issue.doc_det).toHaveLength(2);
    expect(g.csv.split("\n")[0]).toBe("section,recipient_gstin,number,date,note_type,place_of_supply,supply_type,rate_pct,taxable,igst,cgst,sgst,total");
    expect(g.csv).toMatch(/^B2B,/m);
    expect(g.csv).toMatch(/^B2CS,,/m);
    expect(g.csv).toMatch(/^CDNR,/m);

    sessionFor(admin);
    const csv = await call(reportsRoute, `/api/admin/statutory/reports?type=gstr1&period=${period}&format=json`);
    expect(csv.status).toBe(200);
    expect(csv.body).toMatchObject({ gstin: GOKESARI_GSTIN });
    sessionFor(registered.owner);
    expect((await call(reportsRoute, `/api/admin/statutory/reports?type=gstr1&period=${period}`)).status).toBe(403);
  });
});

describe("statutory settings with effective dates", () => {
  it("TC-B26-E-045 seeded rows: TCS 0.5% (Notification 15/2024), TDS 0.1% (s.194-O / s.393), s.9(5) disabled — all awaiting CA confirmation", async () => {
    const tcs = await statutoryRateOn("GST_TCS_SEC52", today);
    expect(tcs).toMatchObject({ rateBp: 50, enabled: true, confirmedByCa: false, effectiveFrom: "2024-07-10" });
    expect(tcs!.sourceUrl).toContain("central-tax-15-2024");
    expect((await statutoryRateOn("GST_TCS_SEC52", "2024-07-09"))!.rateBp).toBe(100);
    const tds = await statutoryRateOn("IT_TDS_194O", today);
    expect(tds).toMatchObject({ rateBp: 10, confirmedByCa: false });
    expect(tds!.params).toMatchObject({ noPanRateBp: 500, exemptIndividualHufUpToPaise: 50_000_000, sectionLabel: "Sec 194-O / s.393 ITA 2025" });
    expect((await statutoryRateOn("IT_TDS_194O", "2024-09-30"))!.rateBp).toBe(100);
    expect((await statutoryRateOn("GST_S95_RESTAURANT", today))!.enabled).toBe(false);
    expect((await statutoryRateOn("GST_S95_LOCAL_DELIVERY", today))).toMatchObject({ enabled: false, rateBp: 1800, effectiveFrom: "2025-09-22" });
    expect((await listStatutoryRates()).every((r) => r.confirmedByCa === false)).toBe(true);
  });

  it("TC-B26-E-046 a rate change in the middle of a cycle applies from its day: earlier supplies keep the old rate", async () => {
    const changeDay = addDaysIso(today, -2);
    const { owner, milkSp, shop } = await sellingShop({}, 4, 4); // delivered before the change
    await deliveredOrder(admin, [[milkSp.id, 4]], { deliveredDaysAgo: 1 }); // after it
    await addStatutoryRate({ key: "GST_TCS_SEC52", label: "TCS (test change)", enabled: true, rateBp: 100, params: {}, effectiveFrom: changeDay }, admin);
    const old = (await db.select().from(statutoryRates).where(and(eq(statutoryRates.key, "GST_TCS_SEC52"), eq(statutoryRates.effectiveFrom, "2024-07-10"))))[0];
    expect(old.effectiveTo).toBe(addDaysIso(changeDay, -1));
    await closePayoutCycle({ today, actor: admin });
    const tcs = await db.select().from(payoutCycleLines).where(and(eq(payoutCycleLines.lineType, "TCS"), eq(payoutCycleLines.shopId, shop.id)));
    expect(tcs.map((l) => l.rateBp).sort()).toEqual([100, 50]);
    expect(tcs.map((l) => -l.amountPaise).sort((a, b) => a - b)).toEqual([200, 400]);
    expect(owner.id).toBeTruthy();
  });

  it("TC-B26-E-047 TDS at 5% without PAN, exempt for an individual within the yearly limit; TCS only for GST-registered sellers; s.9(5) shops have no TCS", async () => {
    const noPan = await sellingShop({ name: "No Pan", gstin: null, panLast4: null });
    const individual = await sellingShop({ name: "Individual", gstin: null, pan: "ABCPE1234F" });
    const company = await sellingShop({ name: "Company" });
    await closePayoutCycle({ today, actor: admin });
    const lines = await db.select().from(payoutCycleLines);
    const of = (shopId: string, type: string) => lines.filter((l) => l.shopId === shopId && l.lineType === type);
    expect(of(noPan.shop.id, "TDS")[0]).toMatchObject({ rateBp: 500, amountPaise: -2_100 }); // 5% of ₹420 (no invoice tax: bill of supply)
    expect(of(noPan.shop.id, "TCS")).toHaveLength(0); // unregistered
    expect(of(individual.shop.id, "TDS")[0]).toMatchObject({ rateBp: 0, amountPaise: 0 });
    expect(of(individual.shop.id, "TDS")[0].meta).toMatchObject({ exempt: true });
    expect(of(company.shop.id, "TDS")[0]).toMatchObject({ rateBp: 10, amountPaise: -40 });
    expect(of(company.shop.id, "TCS")[0]).toMatchObject({ rateBp: 50, amountPaise: -200 });

    // s.9(5): restaurant-type shops — the ECO pays the GST, so no TCS on their supplies.
    const row = (await statutoryRateOn("GST_S95_RESTAURANT", today))!;
    await updateStatutoryRate(row.id, { enabled: true, params: { appliesToShopTypes: ["DAIRY"] } }, admin);
    await sellingShop({ name: "Cafe" }, 2, 1);
    const next = await closePayoutCycle({ today: addDaysIso(today, 5), actor: admin });
    const cafe = (await db.select().from(payoutCycleLines).where(eq(payoutCycleLines.cycleId, next!.cycle.id)));
    expect(cafe.filter((l) => l.lineType === "TCS")).toHaveLength(0);
    expect(cafe.find((l) => l.lineType === "SEC95_GST")!.meta).toMatchObject({ liabilityPaise: 1_000 });
  });

  it("TC-B26-E-048 monthly TCS (GSTR-8-style) and TDS reports from the payout lines", async () => {
    const company = await sellingShop({ name: "Company" });
    await sellingShop({ name: "No Pan", gstin: null, panLast4: null });
    await closePayoutCycle({ today, actor: admin });
    const deliveredMonth = addDaysIso(today, -3).slice(0, 7);
    const tcs = await buildTcsReport(deliveredMonth);
    expect(tcs.rows).toBe(1);
    expect(tcs.json).toMatchObject({ tcs: [{ stin: company.shop.gstin, grossValue: 400, returns: 0, netValue: 400, cgst: 1, sgst: 1, igst: 0 }] });
    expect(tcs.csv.split("\n")[0]).toBe("supplier_gstin,supplier,gross_taxable_inr,returns_inr,net_taxable_inr,igst_tcs_inr,cgst_tcs_inr,sgst_tcs_inr");
    const tds = await buildTdsReport(deliveredMonth);
    expect(tds.rows).toBe(2);
    const entries = (tds.json as { tds: { pan: string; tds: number; higherRateNoPan: boolean }[] }).tds;
    expect(entries.find((e) => e.higherRateNoPan)).toMatchObject({ pan: "PANNOTAVBL", tds: 21 });
    expect(entries.find((e) => !e.higherRateNoPan)).toMatchObject({ pan: "XXXXXX234F", tds: 0.4 });
  });

  it("TC-B26-E-049 admins add dated rows and record the CA's confirmation; a changed value needs confirming again; others cannot", async () => {
    const row = (await statutoryRateOn("IT_TDS_194O", today))!;
    const confirmed = await updateStatutoryRate(row.id, { confirmedByCa: true }, admin);
    expect(confirmed).toMatchObject({ confirmedByCa: true, confirmedBy: admin.id });
    const changed = await updateStatutoryRate(row.id, { rateBp: 20 }, admin);
    expect(changed).toMatchObject({ rateBp: 20, confirmedByCa: false, confirmedBy: null });
    await expect(addStatutoryRate({ key: "IT_TDS_194O", label: "dup", enabled: true, rateBp: 10, params: {}, effectiveFrom: row.effectiveFrom }, admin)).rejects.toMatchObject({ code: "CONFLICT" });
    const operator = await createUser({ role: "OPERATOR" });
    sessionFor({ id: operator.id, role: "OPERATOR" });
    expect((await call(statutoryPatchRoute, `/api/admin/statutory/${row.id}`, { method: "PATCH", body: { confirmedByCa: true }, params: { id: row.id } })).status).toBe(403);
    sessionFor(admin);
    expect((await call(statutoryPatchRoute, `/api/admin/statutory/${row.id}`, { method: "PATCH", body: { confirmedByCa: true }, params: { id: row.id } })).body).toMatchObject({ confirmedByCa: true });
  });
});
