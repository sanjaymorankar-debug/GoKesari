/**
 * The GST filing adapter (billing v2, docs/billing §9): what a shop does on the
 * GST portal through a licensed GSP once it has linked its GSTIN with an OTP
 * (accounts/gst.ts) — save a return, read the portal's summary of it, file it
 * with the owner's EVC (an OTP to the mobile on the portal), read the
 * electronic cash / credit / liability ledgers, read and act on the Invoice
 * Management System (IMS), and fetch the e-invoices suppliers raised to the
 * shop. GSTIN search, IRN and e-way bills stay on the e-invoice adapter
 * (gst/gsp); GSTR-2B / 2A pulls on the returns adapter (accounts/
 * gst-returns-provider.ts) — all three choose the same GSP.
 *
 * Only the mock exists until a GSP is contracted (BLOCKERS.md B1): a licensed
 * GSP's adapter implements this interface with its own API; until then it
 * answers NOT_CONFIGURED and owners use the downloads / uploads (§9.11).
 * DSC signing needs the GSP's signer utility: the web flow files with EVC.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, gte, lt } from "drizzle-orm";

import { db } from "@/server/db";
import { accPurchaseInvoices, platformInvoices } from "@/server/db/schema";
import { GspError } from "@/server/gst/gsp/types";
import { getRule } from "@/server/services/settings";
import { gstReturnsProviderName, MOCK_GST_OTP, type PortalSession } from "@/server/accounts/gst-returns-provider";

export type FilingReturnType = "GSTR1" | "IFF" | "GSTR3B" | "CMP08" | "GSTR4" | "GSTR8";

export interface ReturnTotals {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  documents: number;
}

export interface LedgerView {
  cash: { igst: number; cgst: number; sgst: number; cess: number; entries: { date: string; description: string; amount: number }[] };
  credit: { igst: number; cgst: number; sgst: number; cess: number };
  liability: { igst: number; cgst: number; sgst: number; cess: number };
}

export interface ImsDocument {
  supplierGstin: string;
  supplierName: string | null;
  docType: "INV" | "CN" | "DN";
  docNumber: string;
  docDate: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
  /** As the portal holds it: NO_ACTION / ACCEPTED / REJECTED / PENDING. */
  portalAction: "NO_ACTION" | "ACCEPTED" | "REJECTED" | "PENDING";
}

export interface SupplierEinvoice {
  irn: string;
  supplierGstin: string;
  supplierName: string | null;
  docNumber: string;
  docDate: string;
  total: number;
  /** The signed JSON's item list (description, HSN, qty, unit, rate, GST %). */
  items: { description: string; hsn: string | null; qty: number; unit: string; rate: number; gstRate: number }[];
}

export interface GstFilingProvider {
  readonly name: string;
  saveReturn(session: PortalSession, gstin: string, type: FilingReturnType, period: string, payload: Record<string, unknown>): Promise<{ referenceId: string }>;
  returnSummary(session: PortalSession, gstin: string, type: FilingReturnType, period: string): Promise<ReturnTotals>;
  requestEvcOtp(session: PortalSession, gstin: string, type: FilingReturnType, period: string): Promise<{ requestId: string }>;
  fileReturn(session: PortalSession, gstin: string, type: FilingReturnType, period: string, evc: { requestId: string; otp: string }): Promise<{ arn: string }>;
  ledgers(session: PortalSession, gstin: string, from: string, to: string, shopId: string): Promise<LedgerView>;
  imsInward(session: PortalSession, gstin: string, period: string, shopId: string): Promise<ImsDocument[]>;
  imsSave(session: PortalSession, gstin: string, actions: { supplierGstin: string; docType: string; docNumber: string; action: "ACCEPTED" | "REJECTED" | "PENDING" }[]): Promise<{ saved: number }>;
  supplierEinvoices(session: PortalSession, gstin: string, period: string, shopId: string): Promise<SupplierEinvoice[]>;
}

/** Sums every txval / iamt / camt / samt / csamt in a return's JSON (any section), and counts documents. */
export function totalsOf(payload: unknown): ReturnTotals {
  const t: ReturnTotals = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, documents: 0 };
  const walk = (node: unknown, inDoc = false) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, inDoc));
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if ("inum" in o || "nt_num" in o) t.documents += 1;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "number") {
        if (k === "txval" || k === "suppval") t.taxable += v;
        else if (k === "iamt" || k === "igst") t.igst += v;
        else if (k === "camt" || k === "cgst") t.cgst += v;
        else if (k === "samt" || k === "sgst") t.sgst += v;
        else if (k === "csamt" || k === "cess") t.cess += v;
      } else if (k !== "hsn" && k !== "doc_issue" && k !== "summary") walk(v, inDoc);
    }
  };
  walk(payload);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { taxable: r(t.taxable), igst: r(t.igst), cgst: r(t.cgst), sgst: r(t.sgst), cess: r(t.cess), documents: t.documents };
}

/* ----------------------------------------------------------------- mock */

const saved = new Map<string, Record<string, unknown>>();
const filed = new Map<string, string>();
const otps = new Map<string, string>();
const ims = new Map<string, string>();

/** Tests: forget what the mock portal holds. */
export function resetMockFiling(): void {
  saved.clear();
  filed.clear();
  otps.clear();
  ims.clear();
}

function monthBounds(period: string) {
  const [y, m] = period.split("-").map(Number);
  const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from: `${period}-01`, to };
}

function createMockFiling(): GstFilingProvider {
  const key = (gstin: string, type: string, period: string) => `${gstin}|${type}|${period}`;
  return {
    name: "mock",
    async saveReturn(_s, gstin, type, period, payload) {
      if (filed.has(key(gstin, type, period))) throw new GspError("INVALID", `${type} for ${period} is already filed.`, "RET191106");
      saved.set(key(gstin, type, period), payload);
      return { referenceId: `MOCK-${createHash("sha256").update(key(gstin, type, period) + JSON.stringify(payload)).digest("hex").slice(0, 16)}` };
    },
    async returnSummary(_s, gstin, type, period) {
      const payload = saved.get(key(gstin, type, period));
      if (!payload) throw new GspError("INVALID", "Nothing saved for this return yet.", "RET13509");
      return totalsOf(payload);
    },
    async requestEvcOtp(_s, gstin, type, period) {
      if (!saved.has(key(gstin, type, period))) throw new GspError("INVALID", "Save the return before filing it.", "RET13509");
      const requestId = randomBytes(8).toString("hex");
      otps.set(requestId, key(gstin, type, period));
      return { requestId };
    },
    async fileReturn(_s, gstin, type, period, evc) {
      if (otps.get(evc.requestId) !== key(gstin, type, period)) throw new GspError("AUTH", "The OTP request is not for this return; ask for a new OTP.", "EVC01");
      if (evc.otp !== MOCK_GST_OTP) throw new GspError("AUTH", "Wrong OTP.", "EVC02");
      otps.delete(evc.requestId);
      const arn = `AA${gstin.slice(0, 2)}${period.replace(/\D/g, "").slice(2, 6)}${randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 15);
      filed.set(key(gstin, type, period), arn);
      return { arn };
    },
    async ledgers(_s, gstin, from, to, shopId) {
      // The cash ledger shows the TCS GoKesari collected (credited when GoKesari files GSTR-8).
      const { shopTaxStatement } = await import("@/server/tax/compliance");
      const entries: LedgerView["cash"]["entries"] = [];
      const cash = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
      for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) < to; d.setUTCMonth(d.getUTCMonth() + 1)) {
        const st = await shopTaxStatement(shopId, d.toISOString().slice(0, 7));
        const tcs = st.tcs.igstPaise + st.tcs.cgstPaise + st.tcs.sgstPaise;
        if (tcs) {
          entries.push({ date: d.toISOString().slice(0, 10), description: `TCS credit by e-commerce operator (${(await getRule("platformTaxProfile")).gstin})`, amount: tcs / 100 });
          cash.igst += st.tcs.igstPaise / 100;
          cash.cgst += st.tcs.cgstPaise / 100;
          cash.sgst += st.tcs.sgstPaise / 100;
        }
      }
      void gstin;
      return { cash: { ...cash, entries }, credit: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, liability: { igst: 0, cgst: 0, sgst: 0, cess: 0 } };
    },
    async imsInward(_s, gstin, period, shopId) {
      const { from, to } = monthBounds(period);
      const bills = await db.select().from(accPurchaseInvoices).where(and(eq(accPurchaseInvoices.shopId, shopId), gte(accPurchaseInvoices.invoiceDate, from), lt(accPurchaseInvoices.invoiceDate, to)));
      const fees = await db.select().from(platformInvoices).where(and(eq(platformInvoices.shopId, shopId), gte(platformInvoices.issuedAt, new Date(`${from}T00:00:00+05:30`)), lt(platformInvoices.issuedAt, new Date(`${to}T00:00:00+05:30`))));
      const gk = (await getRule("platformTaxProfile")).gstin;
      const docs: ImsDocument[] = [
        ...bills
          .filter((b) => b.supplierGstin)
          .map((b) => ({ supplierGstin: b.supplierGstin!, supplierName: b.supplierName, docType: "INV" as const, docNumber: b.invoiceNo, docDate: b.invoiceDate, taxable: b.taxablePaise / 100, igst: b.igstPaise / 100, cgst: b.cgstPaise / 100, sgst: b.sgstPaise / 100, cess: b.cessPaise / 100, total: b.totalPaise / 100, portalAction: "NO_ACTION" as const })),
        ...fees.map((f) => ({ supplierGstin: gk, supplierName: "GoKesari", docType: "INV" as const, docNumber: f.invoiceNumber, docDate: f.issuedAt.toISOString().slice(0, 10), taxable: f.taxablePaise / 100, igst: f.igstPaise / 100, cgst: f.cgstPaise / 100, sgst: f.sgstPaise / 100, cess: 0, total: f.totalPaise / 100, portalAction: "NO_ACTION" as const })),
      ];
      return docs.map((d) => ({ ...d, portalAction: (ims.get(`${gstin}|${d.supplierGstin}|${d.docType}|${d.docNumber}`) as ImsDocument["portalAction"]) ?? "NO_ACTION" }));
    },
    async imsSave(_s, gstin, actions) {
      for (const a of actions) ims.set(`${gstin}|${a.supplierGstin}|${a.docType}|${a.docNumber}`, a.action);
      return { saved: actions.length };
    },
    async supplierEinvoices(_s, gstin, period) {
      const date = `${period}-05`;
      return [
        {
          irn: createHash("sha256").update(`${gstin}|${period}|einv`).digest("hex"),
          supplierGstin: "27AABCM1234D1Z5",
          supplierName: "MOCK WHOLESALE DAIRY",
          docNumber: `MW/${period.replace("-", "")}/001`,
          docDate: date,
          total: 1050,
          items: [{ description: "Cow Milk 1 L (crate of 10)", hsn: "0401", qty: 10, unit: "L", rate: 100, gstRate: 5 }],
        },
      ];
    },
  };
}

function notImplemented(name: string): GstFilingProvider {
  const fail = async (): Promise<never> => {
    throw new GspError("NOT_CONFIGURED", `Filing through the ${name} GSP needs that GSP's API contract and credentials. Download the return here and file it on gst.gov.in meanwhile.`);
  };
  return { name, saveReturn: fail, returnSummary: fail, requestEvcOtp: fail, fileReturn: fail, ledgers: fail, imsInward: fail, imsSave: fail, supplierEinvoices: fail };
}

let override: GstFilingProvider | null = null;
let mock: GstFilingProvider | null = null;

/** Tests only. */
export function setGstFilingProviderForTests(provider: GstFilingProvider | null): void {
  override = provider;
}

/** Follows the returns adapter's choice (GST_RETURNS_PROVIDER / GSP_PROVIDER); null when the API is off. */
export function getGstFilingProvider(): GstFilingProvider | null {
  if (override) return override;
  const name = gstReturnsProviderName();
  if (name === "none" || name === "off") return null;
  if (name === "mock") return (mock ??= createMockFiling());
  return notImplemented(name);
}
