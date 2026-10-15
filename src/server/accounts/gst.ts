/**
 * GST portal data in the shop's books (docs/inventory-accounting-2026-10, Part 3):
 * linking the GSTIN (consent + OTP), importing GSTR-2B / 2A / 1 (through the
 * GSP or from an uploaded file), reconciling suppliers' invoices with the
 * bills in the books, the GST liability per month or quarter, and due-date
 * reminders. Everything here is an estimate for the owner and their CA —
 * nothing is filed.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { conflict, validationFailed } from "@/lib/errors";
import { isValidGstin } from "@/lib/gst-states";
import { parsePortalExcel, parsePortalJson, type ParsedPortalFile, type PortalReturnType } from "@/lib/gst/portal-parsers";
import { CA_NOTE, type FilingFrequency } from "@/lib/accounts/constants";
import { addHeads, dueDatesFor, monthsBetween, periodRange, quarterMonths, setOff, ZERO_HEADS, type DueDate, type Heads, type SetOffResult } from "@/lib/accounts/gst-liability";
import { reconcile } from "@/lib/accounts/reconcile";
import { db } from "@/server/db";
import {
  accExpenses,
  accPurchaseInvoices,
  accSalesInvoices,
  creditNotes,
  gstItcRecords,
  gstPortalImports,
  gstPortalInvoices,
  gstPortalLinks,
  gstReconItems,
  gstReminders,
  invSettings,
  shops,
  taxInvoices,
  type GstPortalLink,
} from "@/server/db/schema";
import { GspError } from "@/server/gst/gsp/types";
import { decryptCredentials, encryptCredentials } from "@/server/integrations/credentials";
import { notify } from "@/server/services/notifications";
import { getSettings, logChange, todayIst } from "./books";
import { putFile } from "./files";
import { getGstReturnsProvider, gstReturnsProviderName, type PortalSession } from "./gst-returns-provider";

export const GST_LINK_CONSENT_TEXT =
  "I authorise GoKesari and its GST Suvidha Provider to access my GST returns data (GSTR-1, GSTR-2A, GSTR-2B) on the GST portal for my GSTIN, " +
  "to show my input tax credit, reconcile my purchase bills and estimate my GST payable. GoKesari will not file any return for me. " +
  "I can remove this access at any time.";

/* ------------------------------------------------------------------ link */

export async function getPortalLink(shopId: string): Promise<(Omit<GstPortalLink, "credentialsEncrypted"> & { hasToken: boolean }) | null> {
  const [link] = await db.select().from(gstPortalLinks).where(eq(gstPortalLinks.shopId, shopId));
  if (!link) return null;
  const { credentialsEncrypted, ...rest } = link;
  return { ...rest, hasToken: Boolean(credentialsEncrypted) };
}

export function portalApiAvailable(): boolean {
  return getGstReturnsProvider() !== null;
}

export async function requestLinkOtp(shopId: string, input: { gstin: string; username: string; consent: boolean }, actorId: string) {
  if (!input.consent) throw validationFailed("Tick the consent to link your GSTIN.");
  const gstin = input.gstin.replace(/\s+/g, "").toUpperCase();
  if (!isValidGstin(gstin)) throw validationFailed("Enter a valid GSTIN.");
  const username = input.username.trim();
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(username)) throw validationFailed("Enter your GST portal username.");
  const [shop] = await db.select({ gstin: shops.gstin }).from(shops).where(eq(shops.id, shopId));
  if (shop?.gstin && shop.gstin.toUpperCase() !== gstin) throw validationFailed(`Your shop's GSTIN is ${shop.gstin}. Link that GSTIN.`);
  const provider = getGstReturnsProvider();
  if (!provider) throw conflict("Linking through the GST portal is not switched on yet. Upload the GSTR-2B file from gst.gov.in instead.");
  try {
    const { requestId } = await provider.requestOtp(gstin, username);
    const values = {
      shopId,
      gstin,
      portalUsername: username,
      provider: provider.name,
      status: "OTP_SENT" as const,
      consentText: GST_LINK_CONSENT_TEXT,
      consentAt: new Date(),
      credentialsEncrypted: encryptCredentials({ requestId }),
      tokenExpiresAt: null,
      lastError: null,
      linkedBy: actorId,
      updatedAt: new Date(),
    };
    await db.insert(gstPortalLinks).values(values).onConflictDoUpdate({ target: gstPortalLinks.shopId, set: values });
    await logChange({ shopId, entityType: "gst_link", entityId: shopId, action: "OTP_REQUESTED", changes: [{ field: "gstin", old: null, new: gstin }], actorId });
    return { status: "OTP_SENT" as const, provider: provider.name };
  } catch (error) {
    if (error instanceof GspError) throw validationFailed(error.message);
    throw error;
  }
}

export async function verifyLinkOtp(shopId: string, otp: string, actorId: string) {
  const [link] = await db.select().from(gstPortalLinks).where(eq(gstPortalLinks.shopId, shopId));
  if (!link || link.status !== "OTP_SENT") throw validationFailed("Ask for an OTP first.");
  const provider = getGstReturnsProvider();
  if (!provider) throw conflict("Linking through the GST portal is not switched on.");
  const { requestId } = decryptCredentials(link.credentialsEncrypted) as { requestId?: string };
  try {
    const session = await provider.verifyOtp(link.gstin, link.portalUsername, String(requestId ?? ""), otp.trim());
    await db
      .update(gstPortalLinks)
      .set({ status: "LINKED", credentialsEncrypted: encryptCredentials({ ...session }), tokenExpiresAt: new Date(session.expiresAt), lastError: null, updatedAt: new Date() })
      .where(eq(gstPortalLinks.shopId, shopId));
    await logChange({ shopId, entityType: "gst_link", entityId: shopId, action: "LINKED", changes: [{ field: "status", old: "OTP_SENT", new: "LINKED" }], actorId });
    return { status: "LINKED" as const };
  } catch (error) {
    if (error instanceof GspError) {
      await db.update(gstPortalLinks).set({ lastError: error.message, updatedAt: new Date() }).where(eq(gstPortalLinks.shopId, shopId));
      throw validationFailed(error.message);
    }
    throw error;
  }
}

export async function unlinkPortal(shopId: string, actorId: string): Promise<void> {
  await db.update(gstPortalLinks).set({ status: "REVOKED", credentialsEncrypted: null, tokenExpiresAt: null, updatedAt: new Date() }).where(eq(gstPortalLinks.shopId, shopId));
  await logChange({ shopId, entityType: "gst_link", entityId: shopId, action: "REVOKED", actorId });
}

/* --------------------------------------------------------------- imports */

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

async function storeImport(shopId: string, parsed: ParsedPortalFile, source: "API" | "UPLOAD_JSON" | "UPLOAD_EXCEL", period: string, fileId: string | null, actorId: string) {
  const [shop] = await db.select({ gstin: shops.gstin }).from(shops).where(eq(shops.id, shopId));
  const warnings = [...parsed.warnings];
  if (parsed.gstin && shop?.gstin && parsed.gstin.toUpperCase() !== shop.gstin.toUpperCase()) {
    throw validationFailed(`This file is for GSTIN ${parsed.gstin}, not your shop's ${shop.gstin}.`);
  }
  if (parsed.period && parsed.period !== period) warnings.push(`The file is for ${parsed.period}; it was imported as ${parsed.period}.`);
  const effectivePeriod = parsed.period ?? period;
  const rows = parsed.invoices.filter((i) => i.invoiceNo && i.invoiceDate && (parsed.returnType === "GSTR1" || i.counterpartyGstin));
  if (rows.length < parsed.invoices.length) warnings.push(`${parsed.invoices.length - rows.length} row(s) without a GSTIN, number or date were skipped.`);
  return db.transaction(async (tx) => {
    const [imp] = await tx
      .insert(gstPortalImports)
      .values({ shopId, returnType: parsed.returnType, period: effectivePeriod, source, fileId, gstinInFile: parsed.gstin, invoiceCount: rows.length, warnings, importedBy: actorId })
      .returning();
    // The latest import of a return and period replaces the previous one.
    await tx.delete(gstPortalInvoices).where(and(eq(gstPortalInvoices.shopId, shopId), eq(gstPortalInvoices.returnType, parsed.returnType), eq(gstPortalInvoices.period, effectivePeriod)));
    const seen = new Set<string>();
    const values = rows
      .filter((r) => {
        const k = `${r.counterpartyGstin}|${r.docType}|${r.invoiceNo.toUpperCase()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((r) => ({
        shopId,
        importId: imp.id,
        returnType: parsed.returnType,
        period: effectivePeriod,
        section: r.section,
        docType: r.docType,
        counterpartyGstin: r.counterpartyGstin,
        counterpartyName: r.counterpartyName,
        invoiceNo: r.invoiceNo,
        invoiceDate: r.invoiceDate,
        placeOfSupply: r.placeOfSupply,
        reverseCharge: r.reverseCharge,
        taxablePaise: r.taxablePaise,
        cgstPaise: r.cgstPaise,
        sgstPaise: r.sgstPaise,
        igstPaise: r.igstPaise,
        cessPaise: r.cessPaise,
        totalPaise: r.totalPaise,
        itcAvailable: r.itcAvailable,
        irn: r.irn,
      }));
    for (let i = 0; i < values.length; i += 500) await tx.insert(gstPortalInvoices).values(values.slice(i, i + 500));
    await logChange({ shopId, entityType: "gst_import", entityId: imp.id, action: source, changes: [{ field: "invoices", old: null, new: values.length }], snapshot: { returnType: parsed.returnType, period: effectivePeriod }, actorId }, tx);
    return { importId: imp.id, returnType: parsed.returnType, period: effectivePeriod, invoices: values.length, warnings };
  });
}

/** The fallback: the JSON or Excel file the owner downloaded from gst.gov.in. */
export async function importPortalFile(shopId: string, input: { bytes: Buffer; fileName: string; contentType: string; returnType?: PortalReturnType; period: string }, actorId: string) {
  if (!PERIOD.test(input.period)) throw validationFailed("Choose the month (YYYY-MM).");
  const isExcel = input.contentType.includes("spreadsheet") || /\.xlsx?$/i.test(input.fileName) || (input.bytes[0] === 0x50 && input.bytes[1] === 0x4b);
  const parsed = isExcel ? await parsePortalExcel(input.bytes, input.returnType) : parsePortalJson(input.bytes.toString("utf8").replace(/^﻿/, ""), input.returnType);
  const file = await putFile({ shopId, purpose: "PORTAL_RETURN", bytes: input.bytes, contentType: isExcel ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/json", originalName: input.fileName, uploadedBy: actorId });
  const result = await storeImport(shopId, parsed, isExcel ? "UPLOAD_EXCEL" : "UPLOAD_JSON", input.period, file.id, actorId);
  const recon = parsed.returnType === "GSTR1" ? null : await runReconciliation(shopId, result.period);
  return { ...result, recon };
}

/** Pulls a return through the GSP for a linked GSTIN. */
export async function importFromPortal(shopId: string, returnType: PortalReturnType, period: string, actorId: string) {
  if (!PERIOD.test(period)) throw validationFailed("Choose the month (YYYY-MM).");
  const provider = getGstReturnsProvider();
  if (!provider) throw conflict("The GST portal connection is not switched on. Upload the file from gst.gov.in instead.");
  const [link] = await db.select().from(gstPortalLinks).where(eq(gstPortalLinks.shopId, shopId));
  if (!link || link.status !== "LINKED") throw validationFailed("Link your GSTIN first.");
  if (link.tokenExpiresAt && link.tokenExpiresAt < new Date()) {
    await db.update(gstPortalLinks).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(gstPortalLinks.shopId, shopId));
    throw validationFailed("Your GST portal session has expired. Link again with a new OTP.");
  }
  const session = decryptCredentials(link.credentialsEncrypted) as unknown as PortalSession;
  try {
    const parsed = await provider.fetchReturn(session, link.gstin, returnType, period, shopId);
    const result = await storeImport(shopId, { ...parsed, returnType }, "API", period, null, actorId);
    await db.update(gstPortalLinks).set({ lastSyncAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(gstPortalLinks.shopId, shopId));
    const recon = returnType === "GSTR1" ? null : await runReconciliation(shopId, result.period);
    return { ...result, recon };
  } catch (error) {
    if (error instanceof GspError) {
      await db.update(gstPortalLinks).set({ lastError: error.message, updatedAt: new Date() }).where(eq(gstPortalLinks.shopId, shopId));
      throw validationFailed(error.message);
    }
    throw error;
  }
}

export async function listImports(shopId: string) {
  return db.select().from(gstPortalImports).where(eq(gstPortalImports.shopId, shopId)).orderBy(desc(gstPortalImports.createdAt)).limit(50);
}

/* -------------------------------------------------------- reconciliation */

function shiftMonths(period: string, delta: number): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Reconciles the suppliers' invoices of 2B period `period` (2A when no 2B was
 * imported) with the books. Bills dated in the period that are not on the
 * portal are reported missing; older unmatched bills (a supplier who filed
 * late) are matched when they appear but not reported again.
 */
export async function runReconciliation(shopId: string, period: string) {
  if (!PERIOD.test(period)) throw validationFailed("Choose the month (YYYY-MM).");
  const { from, to } = periodRange(period);
  const lookbackFrom = periodRange(shiftMonths(period, -6)).from;
  const portalRows = await db.select().from(gstPortalInvoices).where(and(eq(gstPortalInvoices.shopId, shopId), eq(gstPortalInvoices.period, period), inArray(gstPortalInvoices.returnType, ["GSTR2B", "GSTR2A"]), eq(gstPortalInvoices.docType, "INV")));
  const has2b = portalRows.some((r) => r.returnType === "GSTR2B");
  const portal = portalRows.filter((r) => r.returnType === (has2b ? "GSTR2B" : "GSTR2A"));
  // Bills of the period, plus earlier ones still waiting for their supplier.
  const itc = await db
    .select({ r: gstItcRecords, p: accPurchaseInvoices })
    .from(gstItcRecords)
    .innerJoin(accPurchaseInvoices, eq(gstItcRecords.purchaseInvoiceId, accPurchaseInvoices.id))
    .where(
      and(
        eq(gstItcRecords.shopId, shopId),
        isNull(gstItcRecords.supersededAt),
        eq(accPurchaseInvoices.status, "CONFIRMED"),
        gte(gstItcRecords.invoiceDate, lookbackFrom),
        lt(gstItcRecords.invoiceDate, to),
        or(gte(gstItcRecords.invoiceDate, from), inArray(gstItcRecords.status, ["PENDING_RECON", "NOT_ON_PORTAL", "MISMATCH"]), and(eq(gstItcRecords.status, "MATCHED"), inArray(gstItcRecords.portalInvoiceId, portal.length ? portal.map((p) => p.id) : ["00000000-0000-0000-0000-000000000000"]))),
      ),
    );
  // Bills with no ITC record (no tax) still reconcile.
  const noTax = await db
    .select()
    .from(accPurchaseInvoices)
    .where(and(eq(accPurchaseInvoices.shopId, shopId), eq(accPurchaseInvoices.status, "CONFIRMED"), gte(accPurchaseInvoices.invoiceDate, from), lt(accPurchaseInvoices.invoiceDate, to), sql`${accPurchaseInvoices.supplierGstin} IS NOT NULL`, sql`NOT EXISTS (SELECT 1 FROM gst_itc_records r WHERE r.purchase_invoice_id = ${accPurchaseInvoices.id} AND r.superseded_at IS NULL)`));
  const books = [
    ...itc.map(({ p }) => ({ id: p.id, supplierGstin: p.supplierGstin, invoiceNo: p.invoiceNo, invoiceDate: p.invoiceDate, totalPaise: p.totalPaise, taxPaise: p.cgstPaise + p.sgstPaise + p.igstPaise + p.cessPaise })),
    ...noTax.map((p) => ({ id: p.id, supplierGstin: p.supplierGstin, invoiceNo: p.invoiceNo, invoiceDate: p.invoiceDate, totalPaise: p.totalPaise, taxPaise: 0 })),
  ];
  const rows = reconcile(
    books,
    portal.map((p) => ({ id: p.id, supplierGstin: p.counterpartyGstin, invoiceNo: p.invoiceNo, invoiceDate: p.invoiceDate, totalPaise: p.totalPaise, taxPaise: p.cgstPaise + p.sgstPaise + p.igstPaise + p.cessPaise })),
  );
  const itcByPurchase = new Map(itc.map(({ r }) => [r.purchaseInvoiceId, r]));
  const portalById = new Map(portal.map((p) => [p.id, p]));

  await db.transaction(async (tx) => {
    await tx.delete(gstReconItems).where(and(eq(gstReconItems.shopId, shopId), eq(gstReconItems.period, period)));
    const items = [];
    for (const row of rows) {
      // Older bills not on this period's portal data are not this period's finding.
      if (row.status === "MISSING_ON_PORTAL" && row.book && row.book.invoiceDate < from) continue;
      items.push({
        shopId,
        period,
        status: row.status,
        portalInvoiceId: row.portal?.id ?? null,
        purchaseInvoiceId: row.book?.id ?? null,
        supplierGstin: row.book?.supplierGstin ?? row.portal?.supplierGstin ?? null,
        invoiceNo: row.book?.invoiceNo ?? row.portal?.invoiceNo ?? "",
        invoiceDate: row.book?.invoiceDate ?? row.portal?.invoiceDate ?? null,
        booksTotalPaise: row.book?.totalPaise ?? null,
        portalTotalPaise: row.portal?.totalPaise ?? null,
        booksTaxPaise: row.book?.taxPaise ?? null,
        portalTaxPaise: row.portal?.taxPaise ?? null,
        note: row.note,
      });
      const record = row.book ? itcByPurchase.get(row.book.id) : undefined;
      if (record && record.status !== "INELIGIBLE") {
        const portalRow = row.portal ? portalById.get(row.portal.id) : undefined;
        const status = row.status === "MATCHED" ? (portalRow?.itcAvailable === false ? "INELIGIBLE" : "MATCHED") : row.status === "AMOUNT_MISMATCH" ? "MISMATCH" : "NOT_ON_PORTAL";
        await tx.update(gstItcRecords).set({ status, portalInvoiceId: row.portal?.id ?? null, updatedAt: new Date() }).where(eq(gstItcRecords.id, record.id));
      }
    }
    for (let i = 0; i < items.length; i += 500) if (items.length) await tx.insert(gstReconItems).values(items.slice(i, i + 500));
  });
  const counts = { MATCHED: 0, AMOUNT_MISMATCH: 0, MISSING_IN_BOOKS: 0, MISSING_ON_PORTAL: 0 };
  for (const r of rows) if (!(r.status === "MISSING_ON_PORTAL" && r.book && r.book.invoiceDate < from)) counts[r.status] += 1;
  return { period, source: portal.length ? (has2b ? "GSTR2B" : "GSTR2A") : null, counts };
}

export async function reconciliationView(shopId: string, period: string) {
  const items = await db.select().from(gstReconItems).where(and(eq(gstReconItems.shopId, shopId), eq(gstReconItems.period, period))).orderBy(asc(gstReconItems.status), asc(gstReconItems.invoiceDate));
  const imports = await db.select().from(gstPortalImports).where(and(eq(gstPortalImports.shopId, shopId), eq(gstPortalImports.period, period))).orderBy(desc(gstPortalImports.createdAt));
  return { items, imports, lastRunAt: items[0]?.runAt ?? null };
}

/* -------------------------------------------------------------- liability */

const IST_OFFSET = "330 minutes";

/** Output tax of one month: the shop's own invoices and its GoKesari order invoices, less credit notes. */
interface MonthFigures {
  output: { heads: Heads; own: Heads; online: Heads; taxablePaise: number };
  input: { eligible: Heads; pending: Heads; ineligible: Heads; expenseGst: number };
}

/**
 * Output GST and input credit of every month in `months` (sorted "YYYY-MM"),
 * in five grouped queries whatever the number of months — the shop's database
 * can be far from the web server, so per-month queries add up to seconds.
 */
async function monthlyFigures(shopId: string, months: string[]): Promise<Map<string, MonthFigures>> {
  const from = periodRange(months[0]).from;
  const to = periodRange(months[months.length - 1]).to;
  const istDate = (col: typeof taxInvoices.issuedAt | typeof creditNotes.issuedAt) => sql`(${col} + interval '${sql.raw(IST_OFFSET)}')::date`;
  const month = (d: SQL) => sql<string>`to_char(${d}, 'YYYY-MM')`;
  const [own, inv, cn, exp, itc] = await Promise.all([
    db
      .select({ m: month(sql`${accSalesInvoices.invoiceDate}`), cgst: sql<number>`coalesce(sum(${accSalesInvoices.cgstPaise}),0)::bigint`, sgst: sql<number>`coalesce(sum(${accSalesInvoices.sgstPaise}),0)::bigint`, igst: sql<number>`coalesce(sum(${accSalesInvoices.igstPaise}),0)::bigint`, cess: sql<number>`coalesce(sum(${accSalesInvoices.cessPaise}),0)::bigint`, taxable: sql<number>`coalesce(sum(${accSalesInvoices.taxablePaise}),0)::bigint` })
      .from(accSalesInvoices)
      .where(and(eq(accSalesInvoices.shopId, shopId), eq(accSalesInvoices.status, "ISSUED"), gte(accSalesInvoices.invoiceDate, from), lt(accSalesInvoices.invoiceDate, to)))
      .groupBy(sql`1`),
    db
      .select({ m: month(istDate(taxInvoices.issuedAt)), cgst: sql<number>`coalesce(sum(${taxInvoices.cgstPaise}),0)::bigint`, sgst: sql<number>`coalesce(sum(${taxInvoices.sgstPaise}),0)::bigint`, igst: sql<number>`coalesce(sum(${taxInvoices.igstPaise}),0)::bigint`, taxable: sql<number>`coalesce(sum(${taxInvoices.taxablePaise}),0)::bigint` })
      .from(taxInvoices)
      .where(and(eq(taxInvoices.shopId, shopId), eq(taxInvoices.kind, "TAX_INVOICE"), sql`${istDate(taxInvoices.issuedAt)} >= ${from}::date`, sql`${istDate(taxInvoices.issuedAt)} < ${to}::date`))
      .groupBy(sql`1`),
    db
      .select({ m: month(istDate(creditNotes.issuedAt)), cgst: sql<number>`coalesce(sum(${creditNotes.cgstPaise}),0)::bigint`, sgst: sql<number>`coalesce(sum(${creditNotes.sgstPaise}),0)::bigint`, igst: sql<number>`coalesce(sum(${creditNotes.igstPaise}),0)::bigint`, taxable: sql<number>`coalesce(sum(${creditNotes.taxablePaise}),0)::bigint` })
      .from(creditNotes)
      .where(and(eq(creditNotes.shopId, shopId), sql`${istDate(creditNotes.issuedAt)} >= ${from}::date`, sql`${istDate(creditNotes.issuedAt)} < ${to}::date`))
      .groupBy(sql`1`),
    db
      .select({ m: month(sql`${accExpenses.expenseDate}`), gst: sql<number>`coalesce(sum(${accExpenses.gstPaise}),0)::bigint` })
      .from(accExpenses)
      .where(and(eq(accExpenses.shopId, shopId), eq(accExpenses.status, "ACTIVE"), gte(accExpenses.expenseDate, from), lt(accExpenses.expenseDate, to)))
      .groupBy(sql`1`),
    db
      .select({ r: gstItcRecords, portalPeriod: gstPortalInvoices.period })
      .from(gstItcRecords)
      .leftJoin(gstPortalInvoices, eq(gstItcRecords.portalInvoiceId, gstPortalInvoices.id))
      .where(and(eq(gstItcRecords.shopId, shopId), isNull(gstItcRecords.supersededAt))),
  ]);
  const byMonth = <T extends { m: string }>(rows: T[]) => new Map(rows.map((r) => [r.m, r]));
  const ownBy = byMonth(own);
  const invBy = byMonth(inv);
  const cnBy = byMonth(cn);
  const expBy = byMonth(exp);
  const out = new Map<string, MonthFigures>();
  for (const m of months) {
    const o = ownBy.get(m);
    const i = invBy.get(m);
    const c = cnBy.get(m);
    const ownHeads = { cgst: Number(o?.cgst ?? 0), sgst: Number(o?.sgst ?? 0), igst: Number(o?.igst ?? 0), cess: Number(o?.cess ?? 0) };
    const onlineHeads = { cgst: Number(i?.cgst ?? 0) - Number(c?.cgst ?? 0), sgst: Number(i?.sgst ?? 0) - Number(c?.sgst ?? 0), igst: Number(i?.igst ?? 0) - Number(c?.igst ?? 0), cess: 0 };
    out.set(m, {
      output: { heads: addHeads(ownHeads, onlineHeads), own: ownHeads, online: onlineHeads, taxablePaise: Number(o?.taxable ?? 0) + Number(i?.taxable ?? 0) - Number(c?.taxable ?? 0) },
      input: { eligible: { ...ZERO_HEADS }, pending: { ...ZERO_HEADS }, ineligible: { ...ZERO_HEADS }, expenseGst: Number(expBy.get(m)?.gst ?? 0) },
    });
  }
  for (const { r, portalPeriod } of itc) {
    // Matched credit is taken in the month the supplier's invoice appears in GSTR-2B.
    const creditPeriod = r.status === "MATCHED" ? (portalPeriod ?? r.period) : r.period;
    const figures = out.get(creditPeriod);
    if (!figures) continue;
    const target = r.status === "MATCHED" ? figures.input.eligible : r.status === "INELIGIBLE" || r.status === "REVERSED" ? figures.input.ineligible : figures.input.pending;
    target.cgst += r.cgstPaise;
    target.sgst += r.sgstPaise;
    target.igst += r.igstPaise;
    target.cess += r.cessPaise;
  }
  return out;
}

export interface LiabilityMonth {
  period: string;
  output: Heads;
  outputOwn: Heads;
  outputOnline: Heads;
  taxablePaise: number;
  eligibleItc: Heads;
  pendingItc: Heads;
  ineligibleItc: Heads;
  expenseGstPaise: number;
  broughtForward: Heads;
  setOff: SetOffResult;
}

export interface LiabilityView {
  periodLabel: string;
  frequency: FilingFrequency;
  months: LiabilityMonth[];
  total: { output: Heads; eligibleItc: Heads; pendingItc: Heads; cash: Heads; totalCash: number; carryForward: Heads };
  dueDates: DueDate[];
  note: string;
}

/**
 * The liability of a month (MONTHLY) or of the quarter containing it
 * (QUARTERLY), with credit carried forward from the months before (up to 24).
 */
export async function gstLiability(shopId: string, period: string, frequencyOverride?: FilingFrequency): Promise<LiabilityView> {
  if (!PERIOD.test(period)) throw validationFailed("Choose the month (YYYY-MM).");
  const [settings, [shop], [first]] = await Promise.all([
    getSettings(shopId),
    db.select({ gstin: shops.gstin }).from(shops).where(eq(shops.id, shopId)),
    db
      .select({ d: sql<string | null>`min(${gstItcRecords.period})` })
      .from(gstItcRecords)
      .where(eq(gstItcRecords.shopId, shopId)),
  ]);
  const frequency = frequencyOverride ?? settings.filingFrequency;
  const target = frequency === "QUARTERLY" ? quarterMonths(period) : [period];
  const start = shiftMonths(target[0], -24);
  const from = first?.d && first.d > start ? first.d : start;
  const history = monthsBetween(from < target[0] ? from : target[0], shiftMonths(target[0], -1)).filter((m) => m < target[0]);

  const figures = await monthlyFigures(shopId, [...history, ...target]);

  // Carry credit forward through the earlier months (only months with data matter).
  let carry: Heads = { ...ZERO_HEADS };
  for (const m of history) {
    const { output: out, input: inp } = figures.get(m)!;
    if (!Object.values(out.heads).some(Boolean) && !Object.values(inp.eligible).some(Boolean) && !Object.values(carry).some(Boolean)) continue;
    carry = setOff(out.heads, addHeads(inp.eligible, carry)).carryForward;
  }
  const months: LiabilityMonth[] = [];
  for (const m of target) {
    const { output: out, input: inp } = figures.get(m)!;
    const so = setOff(out.heads, addHeads(inp.eligible, carry));
    months.push({ period: m, output: out.heads, outputOwn: out.own, outputOnline: out.online, taxablePaise: out.taxablePaise, eligibleItc: inp.eligible, pendingItc: inp.pending, ineligibleItc: inp.ineligible, expenseGstPaise: inp.expenseGst, broughtForward: carry, setOff: so });
    carry = so.carryForward;
  }
  const sum = (pick: (m: LiabilityMonth) => Heads) => months.reduce((acc, m) => addHeads(acc, pick(m)), { ...ZERO_HEADS });
  const cash = sum((m) => m.setOff.cash);
  return {
    periodLabel: frequency === "QUARTERLY" ? `${target[0]} to ${target[2]}` : period,
    frequency,
    months,
    total: { output: sum((m) => m.output), eligibleItc: sum((m) => m.eligibleItc), pendingItc: sum((m) => m.pendingItc), cash, totalCash: cash.cgst + cash.sgst + cash.igst + cash.cess, carryForward: carry },
    dueDates: target.flatMap((m) => dueDatesFor(m, frequency, shop?.gstin ?? null)).filter((d, i, all) => all.findIndex((x) => x.returnType === d.returnType && x.period === d.period) === i),
    note: CA_NOTE,
  };
}

/* -------------------------------------------------------------- reminders */

/**
 * Sends each owner one reminder per return and period, `reminderDaysBefore`
 * days ahead of its due date (POST /api/cron/gst-reminders, daily). Safe to
 * run repeatedly: gst_reminders holds one row per reminder sent.
 */
export async function sendGstReminders(today = todayIst()): Promise<{ sent: number }> {
  const rows = await db.select({ s: invSettings, shop: shops }).from(invSettings).innerJoin(shops, eq(invSettings.shopId, shops.id)).where(isNull(shops.deletedAt));
  let sent = 0;
  const thisMonth = today.slice(0, 7);
  const lastMonth = shiftMonths(thisMonth, -1);
  for (const { s, shop } of rows) {
    if (!shop.gstin) continue;
    for (const period of [lastMonth, thisMonth]) {
      for (const due of dueDatesFor(period, s.filingFrequency, shop.gstin)) {
        const daysLeft = Math.round((Date.parse(`${due.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
        if (daysLeft < 0 || daysLeft > s.reminderDaysBefore) continue;
        const [row] = await db.insert(gstReminders).values({ shopId: shop.id, returnType: due.returnType, period: due.period, dueDate: due.dueDate }).onConflictDoNothing().returning();
        if (!row) continue;
        let amount = "";
        if (due.returnType !== "GSTR1") {
          try {
            const view = await gstLiability(shop.id, period);
            amount = ` Estimated GST payable: ₹${(view.total.totalCash / 100).toFixed(2)}.`;
          } catch {
            amount = "";
          }
        }
        await notify({
          userId: shop.ownerId,
          type: "shop.gst_due_reminder",
          title: `${due.label} is due on ${due.dueDate}`,
          body: `${due.label} for ${shop.name} is due on ${due.dueDate} (${daysLeft === 0 ? "today" : `in ${daysLeft} day(s)`}).${amount} ${CA_NOTE}`,
          actionUrl: "/shop/accounts/gst",
          dedupeKey: `gst-due:${shop.id}:${due.returnType}:${due.period}`,
        });
        sent += 1;
      }
    }
  }
  return { sent };
}

/** For the hub: the next due date and days left. */
export async function nextDueDate(shopId: string): Promise<DueDate | null> {
  const settings = await getSettings(shopId);
  const [shop] = await db.select({ gstin: shops.gstin }).from(shops).where(eq(shops.id, shopId));
  const today = todayIst();
  const thisMonth = today.slice(0, 7);
  const candidates = [shiftMonths(thisMonth, -1), thisMonth].flatMap((p) => dueDatesFor(p, settings.filingFrequency, shop?.gstin ?? null)).filter((d) => d.dueDate >= today);
  return candidates.sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null;
}

export function providerSummary() {
  return { provider: gstReturnsProviderName(), apiAvailable: portalApiAvailable() };
}

