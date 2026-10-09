/**
 * TallyPrime adapter (Module 2). Tally is desktop software with an XML-over-HTTP
 * interface on the shop's own PC (default port 9000) — no REST API, no
 * webhooks, and it must never be exposed to the internet. The GoKesari
 * Connector (connector/tally) runs on that PC, asks GoKesari for work over
 * HTTPS, posts each request below to http://localhost:9000 and sends the reply
 * back. All XML is built and read here, so the connector stays a dumb pipe.
 *
 * Mapping:
 *   GoKesari product  ↔  Tally stock item (by its name; the mapping screen)
 *   order invoice     →  Sales voucher, invoice view, with inventory entries,
 *                        the sales ledger and CGST/SGST/IGST ledgers —
 *                        posting it reduces Tally's stock
 *   credit note       →  Credit Note voucher (inventory entries only when
 *                        goods came back, so stock goes up only then)
 *
 * No duplicates on retry: every push first looks the voucher up by
 * GoKesari's number (which is Tally's voucher number) and creates it only when
 * it is not there; the voucher also carries REMOTEID = GoKesari's id.
 *
 * Element names follow TallyPrime's XML interface as documented for Tally.ERP
 * 9 / TallyPrime; GST detail tags differ between Tally releases, so the item
 * reader looks for them leniently. Confirm both against the shop's own Tally
 * on test before relying on them (MODULE2 doc, "To verify").
 */
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { gstState } from "@/lib/gst-states";
import type { IntegrationJob } from "@/server/db/schema";
import type { CanonicalCreditNote, CanonicalInvoice, CanonicalItem, CanonicalLine } from "../canonical";
import { IntegrationError } from "../errors";
import type { AdapterContext, ConnectorAdapter, ConnectorStep, StepOutcome } from "../types";

export const tallyConfigSchema = z.object({
  /** The company name exactly as in Tally (Gateway of Tally → company). */
  company: z.string().trim().min(1).max(200),
  salesVoucherType: z.string().trim().min(1).max(100).default("Sales"),
  creditNoteVoucherType: z.string().trim().min(1).max(100).default("Credit Note"),
  /** The party ledger for GoKesari's online customers (Sundry Debtors). */
  partyLedger: z.string().trim().min(1).max(200).default("GoKesari Online Customers"),
  salesLedger: z.string().trim().min(1).max(200).default("Sales"),
  cgstLedger: z.string().trim().min(1).max(200).default("CGST"),
  sgstLedger: z.string().trim().min(1).max(200).default("SGST"),
  igstLedger: z.string().trim().min(1).max(200).default("IGST"),
  roundOffLedger: z.string().trim().min(1).max(200).default("Round Off"),
  /** A product sold online but not matched to a Tally item: refuse the voucher, or post it without stock for that line. */
  unmappedItems: z.enum(["FAIL", "ACCOUNTING_ONLY"]).default("FAIL"),
});
export type TallyConfig = z.infer<typeof tallyConfigSchema>;

/* ------------------------------------------------------------------ XML out */

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Characters XML 1.0 cannot carry at all.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** Tally formula string literal: double quotes doubled. */
const formulaString = (value: string) => `"${value.replace(/"/g, '""')}"`;

const amount = (paise: number) => (paise / 100).toFixed(2);
const tallyDate = (iso: string) => iso.slice(0, 10).replace(/-/g, "");
const qty = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(3).replace(/0+$/, ""));

/** Financial year bounds (April–March) around a date, for voucher look-ups. */
function fyBounds(iso: string): { from: string; to: string } {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}0401`, to: `${start + 1}0331` };
}

/** Collection export: does a voucher of this type and number exist? */
export function voucherLookupXml(company: string, voucherType: string, number: string, dateIso: string): string {
  const { from, to } = fyBounds(dateIso);
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>GoKesariVoucherLookup</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY><SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="GoKesariVoucherLookup" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>VoucherNumber, VoucherTypeName, MasterID, GUID, RemoteID</FETCH><FILTER>GoKesariByNumber</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="GoKesariByNumber">$VoucherNumber = ${xmlEscape(formulaString(number))} AND $VoucherTypeName = ${xmlEscape(formulaString(voucherType))}</SYSTEM>
</TDLMESSAGE></TDL>
</DESC></BODY>
</ENVELOPE>`;
}

/** Collection export of every stock item with what the integration pulls. */
export function stockItemsXml(company: string): string {
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>GoKesariStockItems</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="GoKesariStockItems" ISMODIFY="No"><TYPE>StockItem</TYPE>
<FETCH>Name, Parent, BaseUnits, ClosingBalance, ClosingRate, MasterID, AlterID, GUID, PartNo, Description, Narration, LanguageName, GSTDetails, HSNDetails, MRPDetails, StandardPriceList, FullPriceList</FETCH>
</COLLECTION>
</TDLMESSAGE></TDL>
</DESC></BODY>
</ENVELOPE>`;
}

interface UnitResolver {
  (line: CanonicalLine): string;
}

function inventoryEntry(line: CanonicalLine, unit: string, salesLedger: string, isCredit: boolean): string {
  // Sales: inventory lines are credits (positive). Credit note: debits (negative).
  const value = isCredit ? amount(line.taxablePaise) : `-${amount(line.taxablePaise)}`;
  return `<ALLINVENTORYENTRIES.LIST>
<STOCKITEMNAME>${xmlEscape(line.externalItemId!)}</STOCKITEMNAME>
<ISDEEMEDPOSITIVE>${isCredit ? "No" : "Yes"}</ISDEEMEDPOSITIVE>
<RATE>${amount(line.ratePaise)}/${xmlEscape(unit)}</RATE>
<AMOUNT>${value}</AMOUNT>
<ACTUALQTY> ${qty(line.quantity)} ${xmlEscape(unit)}</ACTUALQTY>
<BILLEDQTY> ${qty(line.quantity)} ${xmlEscape(unit)}</BILLEDQTY>
<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${xmlEscape(salesLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${isCredit ? "No" : "Yes"}</ISDEEMEDPOSITIVE><AMOUNT>${value}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
</ALLINVENTORYENTRIES.LIST>`;
}

function ledgerEntry(name: string, paise: number, debit: boolean, party = false): string {
  // Tally XML: a debit is ISDEEMEDPOSITIVE=Yes with a negative amount.
  return `<LEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>${
    party ? "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : ""
  }<AMOUNT>${debit ? "-" : ""}${amount(paise)}</AMOUNT></LEDGERENTRIES.LIST>`;
}

/**
 * The import request for a Sales voucher (invoice) or a Credit Note.
 * `withInventory` false posts accounting entries only (a refund with no goods back).
 */
export function voucherImportXml(
  config: TallyConfig,
  doc: CanonicalInvoice | CanonicalCreditNote,
  type: "SALES" | "CREDIT_NOTE",
  unitFor: UnitResolver,
  withInventory = true,
): string {
  const sales = type === "SALES";
  const voucherType = sales ? config.salesVoucherType : config.creditNoteVoucherType;
  const state = gstState(doc.placeOfSupply ?? doc.buyer.stateCode ?? doc.seller.stateCode ?? null);
  const inventory: string[] = [];
  let accountingOnly = 0;
  for (const line of doc.lines) {
    if (withInventory && line.externalItemId) inventory.push(inventoryEntry(line, unitFor(line), config.salesLedger, sales));
    else accountingOnly += line.taxablePaise;
  }
  const t = doc.totals;
  const ledgers = [
    // Party: debited on a sale, credited on a credit note.
    ledgerEntry(config.partyLedger, t.totalPaise, sales, true),
    accountingOnly > 0 ? ledgerEntry(config.salesLedger, accountingOnly, !sales) : "",
    t.cgstPaise > 0 ? ledgerEntry(config.cgstLedger, t.cgstPaise, !sales) : "",
    t.sgstPaise > 0 ? ledgerEntry(config.sgstLedger, t.sgstPaise, !sales) : "",
    t.igstPaise > 0 ? ledgerEntry(config.igstLedger, t.igstPaise, !sales) : "",
    t.roundOffPaise !== 0 ? ledgerEntry(config.roundOffLedger, Math.abs(t.roundOffPaise), sales ? t.roundOffPaise < 0 : t.roundOffPaise > 0) : "",
  ].filter(Boolean);
  const narration = sales
    ? `GoKesari order ${doc.orderNumber}`
    : `GoKesari order ${doc.orderNumber}; against invoice ${(doc as CanonicalCreditNote).againstInvoice.number}`;
  return `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(config.company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="${xmlEscape(`gokesari-${doc.id}`)}" VCHTYPE="${xmlEscape(voucherType)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
<DATE>${tallyDate(doc.date)}</DATE>
<VOUCHERTYPENAME>${xmlEscape(voucherType)}</VOUCHERTYPENAME>
<VOUCHERNUMBER>${xmlEscape(doc.number)}</VOUCHERNUMBER>
<REFERENCE>${xmlEscape(sales ? doc.orderNumber : (doc as CanonicalCreditNote).againstInvoice.number)}</REFERENCE>
<PARTYLEDGERNAME>${xmlEscape(config.partyLedger)}</PARTYLEDGERNAME>
<BASICBUYERNAME>${xmlEscape(doc.buyer.name)}</BASICBUYERNAME>
${doc.buyer.gstin ? `<PARTYGSTIN>${xmlEscape(doc.buyer.gstin)}</PARTYGSTIN>` : ""}
${state ? `<PLACEOFSUPPLY>${xmlEscape(state.name)}</PLACEOFSUPPLY><STATENAME>${xmlEscape(state.name)}</STATENAME>` : ""}
<NARRATION>${xmlEscape(narration)}</NARRATION>
<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
<ISINVOICE>Yes</ISINVOICE>
${ledgers.join("\n")}
${inventory.join("\n")}
</VOUCHER>
</TALLYMESSAGE></REQUESTDATA>
</IMPORTDATA></BODY>
</ENVELOPE>`;
}

/* ------------------------------------------------------------------- XML in */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

type Node = Record<string, unknown>;

function parse(xml: string): Node {
  try {
    // Tally sometimes emits control-character references XML 1.0 forbids.
    return parser.parse(xml.replace(/&#(?:[0-8]|1[124-9]|2\d|3[01]);/g, "")) as Node;
  } catch (error) {
    throw new IntegrationError("REJECTED", `Unreadable reply from Tally: ${String(error)}`);
  }
}

/** Every value under `key` anywhere in the tree (case-insensitive). */
function findAll(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Node)) {
      if (k.toUpperCase() === key) {
        if (Array.isArray(v)) out.push(...v);
        else out.push(v);
      }
      findAll(v, key, out);
    }
  }
  return out;
}

const text = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return String(v).trim() || null;
  if (typeof v === "object" && "#text" in (v as Node)) return text((v as Node)["#text"]);
  return null;
};
const first = (node: unknown, key: string) => text(findAll(node, key)[0]);

/** Turns Tally's error text into the catalogue's codes. */
export function classifyTallyError(message: string): IntegrationError {
  const m = message.toLowerCase();
  if (/ledger .*does not exist|ledger.*not found/.test(m)) return new IntegrationError("LEDGER_MISSING", message);
  if (/stock item .*does not exist|item.*not found/.test(m)) return new IntegrationError("ITEM_NOT_MAPPED", message);
  if (/company|could not set .*svcurrentcompany/.test(m)) return new IntegrationError("TALLY_COMPANY_NOT_OPEN", message);
  if (/duplicate|already exists/.test(m)) return new IntegrationError("DUPLICATE_NUMBER", message);
  return new IntegrationError("REJECTED", message);
}

export interface TallyImportResult {
  created: number;
  altered: number;
  errors: number;
  lastVoucherId: string | null;
  lineErrors: string[];
}

export function parseImportResponse(xml: string): TallyImportResult {
  const tree = parse(xml);
  const n = (k: string) => Number(first(tree, k) ?? "0") || 0;
  return {
    created: n("CREATED"),
    altered: n("ALTERED"),
    errors: n("ERRORS") + n("EXCEPTIONS"),
    lastVoucherId: first(tree, "LASTVCHID"),
    lineErrors: findAll(tree, "LINEERROR").map(text).filter((s): s is string => Boolean(s)),
  };
}

/** The matching voucher's MasterID/GUID from a lookup reply, or null when there is none. */
export function parseVoucherLookup(xml: string, number: string): string | null {
  const tree = parse(xml);
  const errors = findAll(tree, "LINEERROR").map(text).filter(Boolean) as string[];
  if (errors.length > 0) throw classifyTallyError(errors.join("; "));
  for (const v of findAll(tree, "VOUCHER")) {
    const num = first(v, "VOUCHERNUMBER");
    if (num !== number) continue;
    return first(v, "MASTERID") ?? first(v, "GUID") ?? num;
  }
  return null;
}

/** "25 Nos" / "-3.5 kg" → number; "" → null. */
function leadingNumber(value: string | null): number | null {
  if (!value) return null;
  const m = /-?\d[\d,]*(\.\d+)?/.exec(value);
  return m ? Number(m[0].replace(/,/g, "")) : null;
}

const toPaise = (rupees: number | null) => (rupees == null || !Number.isFinite(rupees) ? null : Math.round(rupees * 100));

/** Stock items from the collection export, in the canonical shape. */
export function parseStockItems(xml: string): CanonicalItem[] {
  const tree = parse(xml);
  const errors = findAll(tree, "LINEERROR").map(text).filter(Boolean) as string[];
  if (errors.length > 0) throw classifyTallyError(errors.join("; "));
  const out: CanonicalItem[] = [];
  for (const raw of findAll(tree, "STOCKITEM")) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Node;
    const name = text(item["@NAME"]) ?? first(item, "NAME");
    if (!name) continue;
    const closing = first(item, "CLOSINGBALANCE");
    const unit = first(item, "BASEUNITS") ?? (closing ? (/[A-Za-z][\w.]*\s*$/.exec(closing)?.[0]?.trim() ?? null) : null);
    // Rate: the standard selling price list, else the closing rate ("50.00/Nos").
    const price = leadingNumber(first(item, "RATE") ?? first(item, "CLOSINGRATE"));
    const mrp = leadingNumber(first(item, "MRPRATE"));
    const hsn = first(item, "HSNCODE");
    // The integrated (IGST) rate is the full GST rate.
    let gst: number | null = null;
    for (const d of findAll(item, "RATEDETAILS.LIST")) {
      const head = (first(d, "GSTRATEDUTYHEAD") ?? "").toLowerCase();
      if (head.includes("integrated") || head.includes("igst")) gst = leadingNumber(first(d, "GSTRATE"));
    }
    if (gst == null) gst = leadingNumber(first(item, "GSTRATE"));
    // Aliases often hold the barcode or code; part number is the usual SKU.
    const aliases = findAll(item, "NAME").map(text).filter((s): s is string => Boolean(s) && s !== name);
    const barcode = aliases.find((a) => /^\d{8,14}$/.test(a)) ?? null;
    out.push({
      externalId: name,
      name,
      sku: first(item, "PARTNO") ?? aliases.find((a) => a !== barcode) ?? null,
      barcode,
      unit,
      stock: leadingNumber(closing),
      pricePaise: toPaise(price),
      mrpPaise: toPaise(mrp),
      hsn: hsn && /^\d{4,8}$/.test(hsn) ? hsn : null,
      gstRateBp: gst != null ? Math.round(gst * 100) : null,
      version: first(item, "ALTERID"),
    });
  }
  return out;
}

/* ------------------------------------------------------- the job's steps */

type Step = "LOOKUP" | "CREATE";

interface TallyJobState extends Record<string, unknown> {
  step?: Step;
}

function documentOf(job: IntegrationJob): { doc: CanonicalInvoice | CanonicalCreditNote; type: "SALES" | "CREDIT_NOTE" } {
  const doc = job.payload as unknown as CanonicalInvoice | CanonicalCreditNote;
  return { doc, type: job.kind === "PUSH_CREDIT_NOTE" ? "CREDIT_NOTE" : "SALES" };
}

function configOf(ctx: AdapterContext): TallyConfig {
  const parsed = tallyConfigSchema.safeParse(ctx.config);
  if (!parsed.success) throw new IntegrationError("NOT_CONFIGURED", parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

export const tallyAdapter: ConnectorAdapter = {
  provider: "TALLY",
  transport: "CONNECTOR",
  label: "TallyPrime",
  description: "Tally on your shop computer, through the GoKesari Connector. Tally stays private: nothing opens it to the internet.",
  configSchema: tallyConfigSchema as unknown as z.ZodType<Record<string, unknown>>,
  credentialsSchema: z.object({}) as unknown as z.ZodType<Record<string, unknown>>,

  stepFor(job, ctx): ConnectorStep {
    const config = configOf(ctx);
    if (job.kind === "PULL_ITEMS" || job.kind === "TEST_CONNECTION") {
      return { stepId: "ITEMS", body: stockItemsXml(config.company) };
    }
    const { doc, type } = documentOf(job);
    const state = job.state as TallyJobState;
    const voucherType = type === "SALES" ? config.salesVoucherType : config.creditNoteVoucherType;
    if (state.step !== "CREATE") {
      return { stepId: "LOOKUP", body: voucherLookupXml(config.company, voucherType, doc.number, doc.date) };
    }
    const unmapped = doc.lines.filter((l) => !l.externalItemId);
    if (unmapped.length > 0 && config.unmappedItems === "FAIL") {
      throw new IntegrationError("ITEM_NOT_MAPPED", `Not matched to a Tally item: ${unmapped.map((l) => l.name).join(", ")}`);
    }
    // Lines carry the Tally item's own unit when mapped (set by the push builder).
    const withInventory = type === "SALES" || (doc as CanonicalCreditNote).restock;
    return { stepId: "CREATE", body: voucherImportXml(config, doc, type, (line) => line.unit, withInventory) };
  },

  applyStepResult(job, _ctx, stepId, response): StepOutcome {
    if (stepId === "ITEMS") {
      parseStockItems(response);
      return { kind: "done", result: { externalRef: "items", created: false }, state: {} };
    }
    const { doc } = documentOf(job);
    if (stepId === "LOOKUP") {
      const existing = parseVoucherLookup(response, doc.number);
      if (existing) return { kind: "done", result: { externalRef: existing, created: false }, state: { step: "LOOKUP" } };
      return { kind: "next", state: { ...(job.state as TallyJobState), step: "CREATE" } };
    }
    const result = parseImportResponse(response);
    if (result.errors > 0 || result.lineErrors.length > 0 || result.created + result.altered === 0) {
      throw classifyTallyError(result.lineErrors.join("; ") || `Tally created nothing (errors: ${result.errors}).`);
    }
    return { kind: "done", result: { externalRef: result.lastVoucherId ?? doc.number, created: true }, state: { step: "CREATE" } };
  },

  itemsRequest(ctx) {
    return stockItemsXml(configOf(ctx).company);
  },

  parseItems: parseStockItems,
};
