/**
 * The shop's GST returns on the portal (billing v2, docs/billing §9): prepare
 * from the books, save through the GSP, compare GoKesari's totals with the
 * portal's, file with the owner's EVC; read the portal ledgers (with the TCS
 * GoKesari credited); act on IMS; fetch suppliers' e-invoices as draft bills;
 * and remind owners before their portal session expires.
 *
 *   GSTR1   gst/gstr1.ts (B2B, B2CL, B2CS, notes, HSN, documents, Table 14)
 *   IFF     the B2B part of GSTR-1 for months 1–2 of a QRMP quarter
 *   GSTR3B  outward tax and input credit from the books (accounts/gst.ts
 *           gstLiability), with the TCS credit shown for the cash ledger
 *   CMP08   composition: quarterly turnover × the composition rate
 *   GSTR4   composition: the year's four CMP-08s
 *
 * Every portal call goes through callGsp (logged, retried, rate-limited). A
 * filed return is never prepared again; the next period carries corrections.
 */
import { createHash } from "node:crypto";

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { accSalesInvoices, gstFilings, gstPortalLinks, imsActions, shops, taxInvoices, type GstFiling, type GstFilingType } from "@/server/db/schema";
import { upsertRow } from "@/server/db/split/upsert";
import { decryptCredentials } from "@/server/integrations/credentials";
import { buildGstr1 } from "@/server/gst/gstr1";
import { GspError } from "@/server/gst/gsp/types";
import { gstLiability } from "@/server/accounts/gst";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { shopTaxStatement } from "@/server/tax/compliance";
import type { PortalSession } from "@/server/accounts/gst-returns-provider";
import { callGsp } from "./calls";
import { getGstFilingProvider, totalsOf, type GstFilingProvider, type ImsDocument, type ReturnTotals } from "./filing-provider";

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const r2 = (p: number) => Math.round(p) / 100;

/* ---------------------------------------------------------------- periods */

function monthsOfQuarter(quarter: string): string[] {
  const m = /^(\d{4})-\d{2}-Q([1-4])$/.exec(quarter);
  if (!m) throw validationFailed("Choose a quarter (e.g. 2026-27-Q3).");
  const fy = Number(m[1]);
  const q = Number(m[2]);
  const start = [4, 7, 10, 1][q - 1];
  const year = q === 4 ? fy + 1 : fy;
  return [0, 1, 2].map((i) => `${year}-${String(start + i).padStart(2, "0")}`);
}

function checkPeriod(type: GstFilingType, period: string): void {
  const ok =
    type === "CMP08" ? /^\d{4}-\d{2}-Q[1-4]$/.test(period) : type === "GSTR4" ? /^\d{4}-\d{2}$/.test(period) && Number(period.slice(5, 7)) === (Number(period.slice(2, 4)) + 1) % 100 : /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  if (!ok) throw validationFailed(type === "CMP08" ? "Choose a quarter (e.g. 2026-27-Q3)." : type === "GSTR4" ? "Choose a financial year (e.g. 2026-27)." : "Choose a month (YYYY-MM).");
}

/* --------------------------------------------------------------- session */

async function sessionFor(shopId: string): Promise<{ session: PortalSession; gstin: string; provider: GstFilingProvider }> {
  const provider = getGstFilingProvider();
  if (!provider) throw conflict("The GST portal connection is not switched on. Download the return and file it on gst.gov.in.");
  const [link] = await db.select().from(gstPortalLinks).where(eq(gstPortalLinks.shopId, shopId));
  if (!link || link.status === "REVOKED" || link.status === "OTP_SENT") throw validationFailed("Link your GSTIN to the GST portal first (an OTP from the portal).");
  if (link.status === "EXPIRED" || (link.tokenExpiresAt && link.tokenExpiresAt < new Date())) {
    if (link.status !== "EXPIRED") await db.update(gstPortalLinks).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(gstPortalLinks.shopId, shopId));
    throw validationFailed("Your GST portal session has expired. Link again with a new OTP.", { reason: "GST_SESSION_EXPIRED" });
  }
  return { session: decryptCredentials(link.credentialsEncrypted) as unknown as PortalSession, gstin: link.gstin, provider };
}

const op = (provider: GstFilingProvider, operation: string, shopId: string, actorId: string | null) => ({ operation, provider: provider.name, shopId, actorId });

/* --------------------------------------------------------------- prepare */

async function buildPayload(shopId: string, type: GstFilingType, period: string): Promise<{ payload: Record<string, unknown>; summary: ReturnTotals }> {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  if (type === "GSTR1" || type === "IFF") {
    const g = await buildGstr1(shopId, period);
    const payload = type === "GSTR1" ? g.json : { gstin: g.json.gstin, fp: g.json.fp, b2b: g.json.b2b, cdnr: g.json.cdnr, note: "IFF: B2B invoices and notes of the first two months of the quarter (QRMP)." };
    return { payload, summary: totalsOf(payload) };
  }
  if (type === "GSTR3B") {
    const l = await gstLiability(shopId, period);
    const tcs = await shopTaxStatement(shopId, period);
    const out = l.total.output;
    const itc = l.total.eligibleItc;
    const payload = {
      gstin: shop.gstin,
      ret_period: `${period.slice(5, 7)}${period.slice(0, 4)}`,
      sup_details: { osup_det: { txval: r2(l.months.reduce((n, m) => n + m.taxablePaise, 0)), iamt: r2(out.igst), camt: r2(out.cgst), samt: r2(out.sgst), csamt: r2(out.cess) } },
      itc_elg: { itc_avl: [{ ty: "OTH", iamt: r2(itc.igst), camt: r2(itc.cgst), samt: r2(itc.sgst), csamt: r2(itc.cess) }] },
      tax_payable_cash: { iamt: r2(l.total.cash.igst), camt: r2(l.total.cash.cgst), samt: r2(l.total.cash.sgst), csamt: r2(l.total.cash.cess) },
      tcs_credit: { iamt: r2(tcs.tcs.igstPaise), camt: r2(tcs.tcs.cgstPaise), samt: r2(tcs.tcs.sgstPaise), note: "TCS collected by GoKesari (GSTR-8); claim it in the electronic cash ledger." },
      note: l.note,
    };
    return { payload, summary: { taxable: payload.sup_details.osup_det.txval, igst: r2(out.igst), cgst: r2(out.cgst), sgst: r2(out.sgst), cess: r2(out.cess), documents: 0 } };
  }
  if (type === "CMP08") {
    if (shop.gstStatus !== "COMPOSITION" && shop.gstRegistrationType !== "COMPOSITION") throw validationFailed("CMP-08 is for shops in the composition scheme.");
    const months = monthsOfQuarter(period);
    const from = `${months[0]}-01`;
    const [y, m] = months[2].split("-").map(Number);
    const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const [online] = await db
      .select({ v: sql<number>`coalesce(sum(${taxInvoices.totalPaise}), 0)::bigint` })
      .from(taxInvoices)
      .where(and(eq(taxInvoices.shopId, shopId), eq(taxInvoices.status, "ISSUED"), gte(taxInvoices.issuedAt, new Date(`${from}T00:00:00+05:30`)), lt(taxInvoices.issuedAt, new Date(`${to}T00:00:00+05:30`))));
    const [counter] = await db
      .select({ v: sql<number>`coalesce(sum(${accSalesInvoices.totalPaise}), 0)::bigint` })
      .from(accSalesInvoices)
      .where(and(eq(accSalesInvoices.shopId, shopId), eq(accSalesInvoices.status, "ISSUED"), gte(accSalesInvoices.invoiceDate, from), lt(accSalesInvoices.invoiceDate, to)));
    const rule = await getRule("billing");
    const rateBp = shop.shopType === "RESTAURANT" ? rule.compositionRestaurantRateBp : rule.compositionRateBp;
    const turnover = Number(online.v) + Number(counter.v);
    const tax = Math.round((turnover * rateBp) / 10_000);
    const half = Math.floor(tax / 2);
    const payload = { gstin: shop.gstin, quarter: period, outward: { turnover: r2(turnover), rate: rateBp / 100, camt: r2(half), samt: r2(tax - half) }, note: "Composition: turnover of supplies × the composition rate (CGST + SGST). Inward reverse-charge supplies, if any, are added by the CA." };
    return { payload, summary: { taxable: r2(turnover), igst: 0, cgst: r2(half), sgst: r2(tax - half), cess: 0, documents: 0 } };
  }
  // GSTR-4: the year's four quarters.
  const fy = period.slice(0, 4);
  const quarters = [1, 2, 3, 4].map((q) => `${fy}-${period.slice(5, 7)}-Q${q}`);
  const parts: ReturnTotals[] = [];
  for (const q of quarters) parts.push((await buildPayload(shopId, "CMP08", q)).summary);
  const sum = (k: keyof ReturnTotals) => Math.round(parts.reduce((n, p) => n + p[k], 0) * 100) / 100;
  const payload = { gstin: shop.gstin, fy: period, quarters: quarters.map((q, i) => ({ quarter: q, ...parts[i] })), total: { turnover: sum("taxable"), camt: sum("cgst"), samt: sum("sgst") } };
  return { payload, summary: { taxable: sum("taxable"), igst: 0, cgst: sum("cgst"), sgst: sum("sgst"), cess: 0, documents: 0 } };
}

export async function prepareReturn(shopId: string, type: GstFilingType, period: string): Promise<GstFiling> {
  checkPeriod(type, period);
  const { payload, summary } = await buildPayload(shopId, type, period);
  const [existing] = await db.select().from(gstFilings).where(and(eq(gstFilings.shopId, shopId), eq(gstFilings.returnType, type), eq(gstFilings.period, period)));
  if (existing?.status === "FILED") throw conflict(`${type} for ${period} is already filed (ARN ${existing.arn}). Corrections go in the next return.`);
  return upsertRow(db, gstFilings, {
    keys: [gstFilings.shopId, gstFilings.returnType, gstFilings.period],
    values: { shopId, returnType: type, period, status: "PREPARED", payload, checksum: sha(payload), ourSummary: summary as unknown as Record<string, unknown>, portalSummary: null, referenceId: null, error: null, preparedAt: new Date() },
    set: { status: "PREPARED", payload, checksum: sha(payload), ourSummary: summary as unknown as Record<string, unknown>, portalSummary: null, referenceId: null, error: null, preparedAt: new Date() },
  });
}

async function filingOf(shopId: string, filingId: string): Promise<GstFiling> {
  const [f] = await db.select().from(gstFilings).where(and(eq(gstFilings.id, filingId), eq(gstFilings.shopId, shopId)));
  if (!f) throw notFound("Return");
  return f;
}

const fail = async (filingId: string, error: unknown) => {
  const message = error instanceof GspError ? error.message : error instanceof Error ? error.message : String(error);
  await db.update(gstFilings).set({ status: "ERROR", error: message }).where(eq(gstFilings.id, filingId));
  if (error instanceof GspError) throw validationFailed(`${message}${error.code === "UNAVAILABLE" || error.code === "NOT_CONFIGURED" ? " You can download the return and file it on gst.gov.in." : ""}`);
  throw error;
};

/** Saves the prepared return on the portal and reads back the portal's totals for comparison. */
export async function saveToPortal(shopId: string, filingId: string, actorId: string): Promise<GstFiling> {
  const f = await filingOf(shopId, filingId);
  if (f.status === "FILED") throw conflict("This return is already filed.");
  const { session, gstin, provider } = await sessionFor(shopId);
  try {
    const { referenceId } = await callGsp(op(provider, `save:${f.returnType}`, shopId, actorId), () => provider.saveReturn(session, gstin, f.returnType, f.period, f.payload));
    const portal = await callGsp(op(provider, `summary:${f.returnType}`, shopId, actorId), () => provider.returnSummary(session, gstin, f.returnType, f.period));
    const [row] = await db.update(gstFilings).set({ status: "SAVED", referenceId, portalSummary: portal as unknown as Record<string, unknown>, savedAt: new Date(), error: null }).where(eq(gstFilings.id, f.id)).returning();
    return row;
  } catch (error) {
    return fail(f.id, error);
  }
}

/** GoKesari's totals against the portal's, line by line. */
export function compareSummaries(ours: ReturnTotals | null, portal: ReturnTotals | null): { field: keyof ReturnTotals; ours: number; portal: number; matches: boolean }[] {
  if (!ours || !portal) return [];
  return (["taxable", "igst", "cgst", "sgst", "cess"] as const).map((field) => ({ field, ours: ours[field], portal: portal[field], matches: Math.abs(ours[field] - portal[field]) < 0.01 }));
}

export async function requestFilingOtp(shopId: string, filingId: string, actorId: string): Promise<{ requestId: string }> {
  const f = await filingOf(shopId, filingId);
  if (f.status !== "SAVED") throw conflict("Save the return on the portal and check the totals before filing.");
  const mismatch = compareSummaries(f.ourSummary as unknown as ReturnTotals, f.portalSummary as unknown as ReturnTotals).filter((c) => !c.matches);
  if (mismatch.length) throw conflict(`The portal's totals differ from GoKesari's (${mismatch.map((m) => m.field).join(", ")}). Save again or check with your CA before filing.`);
  const { session, gstin, provider } = await sessionFor(shopId);
  return callGsp(op(provider, `evc-otp:${f.returnType}`, shopId, actorId), () => provider.requestEvcOtp(session, gstin, f.returnType, f.period));
}

/** Files with the OTP the owner received (EVC). DSC needs the GSP's signer: file on the portal instead. */
export async function fileWithEvc(shopId: string, filingId: string, requestId: string, otp: string, actorId: string): Promise<GstFiling> {
  const f = await filingOf(shopId, filingId);
  if (f.status === "FILED") return f;
  if (!/^\d{6}$/.test(otp)) throw validationFailed("Enter the 6-digit OTP.");
  const { session, gstin, provider } = await sessionFor(shopId);
  try {
    const { arn } = await callGsp(op(provider, `file:${f.returnType}`, shopId, actorId), () => provider.fileReturn(session, gstin, f.returnType, f.period, { requestId, otp }));
    const [row] = await db.update(gstFilings).set({ status: "FILED", arn, filedAt: new Date(), filedBy: actorId, error: null }).where(eq(gstFilings.id, f.id)).returning();
    return row;
  } catch (error) {
    if (error instanceof GspError && error.code === "AUTH") throw validationFailed(error.message);
    return fail(f.id, error);
  }
}

export async function listFilings(shopId: string): Promise<GstFiling[]> {
  return db.select().from(gstFilings).where(eq(gstFilings.shopId, shopId)).orderBy(sql`${gstFilings.period} desc`, gstFilings.returnType);
}

/* ---------------------------------------------------------------- ledgers */

export async function portalLedgers(shopId: string, from: string, to: string, actorId: string) {
  const { session, gstin, provider } = await sessionFor(shopId);
  return callGsp(op(provider, "ledgers", shopId, actorId), () => provider.ledgers(session, gstin, from, to, shopId));
}

/* -------------------------------------------------------------------- IMS */

export interface ImsRow extends ImsDocument {
  decision: "ACCEPTED" | "REJECTED" | "PENDING" | null;
  reason: string | null;
  pushed: "NOT_SENT" | "SENT" | "FAILED" | null;
}

export async function imsInward(shopId: string, period: string, actorId: string): Promise<ImsRow[]> {
  const { session, gstin, provider } = await sessionFor(shopId);
  const docs = await callGsp(op(provider, "ims:list", shopId, actorId), () => provider.imsInward(session, gstin, period, shopId));
  const decided = await db.select().from(imsActions).where(eq(imsActions.shopId, shopId));
  return docs.map((d) => {
    const a = decided.find((x) => x.supplierGstin === d.supplierGstin && x.docType === d.docType && x.docNumber === d.docNumber);
    return { ...d, decision: a?.action ?? null, reason: a?.reason ?? null, pushed: a?.pushed ?? null };
  });
}

export interface ImsDecision {
  supplierGstin: string;
  docType: "INV" | "CN" | "DN";
  docNumber: string;
  docDate?: string | null;
  total?: number;
  action: "ACCEPTED" | "REJECTED" | "PENDING";
  reason?: string | null;
}

/** Records the owner's decisions and sends them to the portal's IMS. A rejection needs a reason. */
export async function decideIms(shopId: string, period: string, decisions: ImsDecision[], actorId: string): Promise<{ saved: number; sent: boolean }> {
  for (const d of decisions) if (d.action === "REJECTED" && !d.reason?.trim()) throw validationFailed(`Say why ${d.docNumber} is rejected.`);
  for (const d of decisions) {
    const values = { shopId, period, supplierGstin: d.supplierGstin, docType: d.docType, docNumber: d.docNumber, docDate: d.docDate ?? null, totalPaise: Math.round((d.total ?? 0) * 100), action: d.action, reason: d.reason ?? null, pushed: "NOT_SENT" as const, decidedBy: actorId, decidedAt: new Date() };
    await upsertRow(db, imsActions, { keys: [imsActions.shopId, imsActions.supplierGstin, imsActions.docType, imsActions.docNumber], values, set: { action: d.action, reason: d.reason ?? null, pushed: "NOT_SENT", decidedBy: actorId, decidedAt: new Date(), period } });
  }
  let sent = false;
  try {
    const { session, gstin, provider } = await sessionFor(shopId);
    await callGsp(op(provider, "ims:save", shopId, actorId), () => provider.imsSave(session, gstin, decisions.map((d) => ({ supplierGstin: d.supplierGstin, docType: d.docType, docNumber: d.docNumber, action: d.action }))));
    sent = true;
  } catch (error) {
    console.warn("[ims] decisions kept, not sent to the portal", error instanceof Error ? error.message : error);
  }
  for (const d of decisions) {
    await db
      .update(imsActions)
      .set({ pushed: sent ? "SENT" : "FAILED" })
      .where(and(eq(imsActions.shopId, shopId), eq(imsActions.supplierGstin, d.supplierGstin), eq(imsActions.docType, d.docType), eq(imsActions.docNumber, d.docNumber)));
  }
  return { saved: decisions.length, sent };
}

/* ------------------------------------------------ suppliers' e-invoices */

export async function supplierEinvoices(shopId: string, period: string, actorId: string) {
  const { session, gstin, provider } = await sessionFor(shopId);
  return callGsp(op(provider, "einvoice:inward", shopId, actorId), () => provider.supplierEinvoices(session, gstin, period, shopId));
}

/**
 * A supplier's e-invoice as a draft bill in the bill-review screen (the same
 * mandatory review as an OCR'd bill): the owner checks it and confirms.
 */
export async function draftBillFromEinvoice(shopId: string, period: string, irn: string, actorId: string): Promise<{ captureId: string }> {
  const list = await supplierEinvoices(shopId, period, actorId);
  const e = list.find((x) => x.irn === irn);
  if (!e) throw notFound("E-invoice");
  const { createManualCapture, saveDraft } = await import("@/server/accounts/capture/service");
  const capture = await createManualCapture(shopId, actorId);
  const draft = { ...(capture.draft as Record<string, unknown>) } as Record<string, unknown> & { supplier?: Record<string, unknown>; lines?: unknown[] };
  draft.supplier = { ...(draft.supplier ?? {}), name: e.supplierName ?? e.supplierGstin, gstin: e.supplierGstin };
  draft.invoiceNo = e.docNumber;
  draft.invoiceDate = e.docDate;
  draft.irn = e.irn;
  draft.lines = e.items.map((i) => ({ description: i.description, hsn: i.hsn, qty: i.qty, unit: i.unit, ratePaise: Math.round(i.rate * 100), gstRateBp: Math.round(i.gstRate * 100) }));
  await saveDraft(shopId, capture.id, draft as never).catch(() => null);
  return { captureId: capture.id };
}

/* ------------------------------------------------------ session reminders */

/** Hourly / daily: owners whose portal session ends within `hours` are asked to link again (§9.1, scenario 15). */
export async function sendGstSessionReminders(hours = 6): Promise<{ sent: number }> {
  const soon = new Date(Date.now() + hours * 3600_000);
  const rows = await db
    .select({ shopId: gstPortalLinks.shopId, expires: gstPortalLinks.tokenExpiresAt, ownerId: shops.ownerId, name: shops.name })
    .from(gstPortalLinks)
    .innerJoin(shops, eq(shops.id, gstPortalLinks.shopId))
    .where(and(eq(gstPortalLinks.status, "LINKED"), lt(gstPortalLinks.tokenExpiresAt, soon)));
  for (const r of rows) {
    await notify({
      userId: r.ownerId,
      type: NOTIFICATION_TYPES.SHOP_GST_DUE_REMINDER,
      title: "Your GST portal link ends soon",
      body: `${r.name}: the GST portal session ${r.expires && r.expires < new Date() ? "has ended" : "ends soon"}. Link again with a new OTP to keep filing and syncing from GoKesari.`,
      actionUrl: "/shop/accounts/gst",
      dedupeKey: `gst-session:${r.shopId}:${r.expires?.toISOString().slice(0, 13) ?? "none"}`,
    });
  }
  return { sent: rows.length };
}
