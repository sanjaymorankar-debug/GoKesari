/**
 * Reading the files a shop owner downloads from gst.gov.in (Module 2,
 * purchase reconciliation): GSTR-2B and GSTR-2A (what suppliers reported) and
 * GSTR-1 (what the shop itself reported), as JSON or — for GSTR-2B — as the
 * portal's Excel workbook. Every shape becomes one flat list of documents
 * (PortalInvoice) that the reconciliation matches against the shop's books.
 *
 * Pure: no database, no network. Amounts become integer paise and GST rates
 * basis points; numbers are parsed from their decimal text, never through
 * float multiplication, so "1,180.50" and 1180.5 are both exactly 118050.
 *
 * Return-type detection (a caller's hint always wins; a disagreement is only
 * a warning):
 *  - "docdata" or "rtnprd" (top level or under "data")      → GSTR-2B
 *  - "fp" with supplier filing flags (cfs / cfs3b / fldtr1) on b2b, or a
 *    "cdn" / "cdna" / "isd" / "tds" / "tcs" section          → GSTR-2A
 *  - "fp" with a GSTR-1-only section (b2cs, b2cl, hsn, doc_issue, cdnr,
 *    cdnur, exp, nil, gt, cur_gt)                             → GSTR-1
 *  - "fp" with only b2b                                       → GSTR-1, with a warning
 *  - anything else is refused.
 *
 * Conventions:
 *  - Credit and debit notes keep positive amounts; docType ("CRN"/"DBN") says
 *    which way they count.
 *  - GSTR-1 B2CL invoices and B2CS summary lines become section "OTHER" rows
 *    with counterpartyGstin "" (no buyer GSTIN). A B2CS row is one summary
 *    line, not a document: its invoiceNo is "B2CS-<pos>-<rate>" and its date
 *    the first day of the return period. CDNUR notes are "OTHER" too.
 *  - IMPG (import of goods from the bill of entry) rows carry the bill of
 *    entry number and date as invoiceNo / invoiceDate; counterpartyGstin is ""
 *    (the SEZ supplier's GSTIN for IMPGSEZ).
 *  - Sections not listed above (ISD, TDS, exports, advances…) are not read;
 *    each one present and non-empty adds a warning, never a silent loss.
 */
import type ExcelJS from "exceljs";

import { validationFailed } from "@/lib/errors";
import { gstState } from "@/lib/gst-states";

export type PortalReturnType = "GSTR2B" | "GSTR2A" | "GSTR1";

export interface PortalInvoice {
  section: "B2B" | "B2BA" | "CDNR" | "CDNRA" | "IMPG" | "OTHER";
  /** Counter-party GSTIN: supplier (2A/2B) or buyer (GSTR-1). Uppercase. */
  counterpartyGstin: string;
  counterpartyName: string | null;
  /** As printed, trimmed. */
  invoiceNo: string;
  /** YYYY-MM-DD; "" (with a warning) when the file's date cannot be read. */
  invoiceDate: string;
  /** "INV" for invoices, "CRN"/"DBN" for credit/debit notes. */
  docType: "INV" | "CRN" | "DBN";
  /** 2-digit state code. */
  placeOfSupply: string | null;
  reverseCharge: boolean;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessPaise: number;
  /** Invoice value. */
  totalPaise: number;
  /** GSTR-2B itcavl; null when the file does not say. */
  itcAvailable: boolean | null;
  itcUnavailableReason: string | null;
  irn: string | null;
  /** Per-rate breakup when the file has items. */
  rates: PortalRate[];
}

export interface PortalRate {
  rateBp: number;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessPaise: number;
}

export interface ParsedPortalFile {
  returnType: PortalReturnType;
  /** The shop's own GSTIN in the file. */
  gstin: string | null;
  /** YYYY-MM. */
  period: string | null;
  invoices: PortalInvoice[];
  warnings: string[];
}

/** Most documents (JSON) or data rows (Excel) one file may hold. */
export const PORTAL_MAX_ROWS = 20_000;

type Json = Record<string, unknown>;
type Section = PortalInvoice["section"];
type DocType = PortalInvoice["docType"];
type Amounts = Omit<PortalRate, "rateBp">;

const GSTIN_LIKE = /^\d{2}[A-Z0-9]{13}$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/* ---------------------------------------------------------------- scalars */

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const objs = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);

function text(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return "";
}

const textOrNull = (v: unknown): string | null => text(v) || null;
const gstinOf = (v: unknown): string => text(v).replace(/\s+/g, "").toUpperCase();
const emptyAmounts = (): Amounts => ({ taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 });

/**
 * Rupees to integer paise from a number or text ("1,180.50", "₹ 1180.5",
 * "(25.00)" for a negative). Garbage, blanks and non-finite values give 0.
 * The decimal text is split, not multiplied, so there is no float drift;
 * the third decimal rounds half away from zero.
 */
export function rupeesToPaiseSafe(v: unknown): number {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return 0;
    s = String(v);
    // Exponent form only for |v| < 1e-6 or ≥ 1e21: no decimal text to split.
    if (/e/i.test(s)) return Math.round(v * 100) || 0;
  } else if (typeof v === "string") {
    s = v;
  } else {
    return 0;
  }
  s = s.replace(/₹|\binr\b|\brs\.?|,|\s/gi, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && !m[2])) return 0;
  const whole = m[1] === "" ? 0 : Number(m[1]);
  const frac = (m[2] ?? "").padEnd(3, "0");
  const paise = whole * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(paise)) return 0;
  return negative && paise !== 0 ? -paise : paise;
}

/** "18", 18, "18%", "18.00" → 1800 basis points. */
const rateBpOf = (v: unknown): number => rupeesToPaiseSafe(typeof v === "string" ? v.replace("%", "") : v);

function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function monthIndex(name: string): number {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i < 0 ? 0 : i + 1;
}

/**
 * A document date as YYYY-MM-DD: "dd-mm-yyyy", "dd/mm/yyyy", "yyyy-mm-dd",
 * "15-Sep-2026", a Date (Excel; rounded to the nearest UTC day so an
 * IST-midnight value is not a day early) or an Excel serial number.
 */
export function portalDate(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const d = new Date(Math.round(v.getTime() / 86_400_000) * 86_400_000);
    return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (typeof v === "number" || (typeof v === "string" && /^\d{5}(\.\d+)?$/.test(v.trim()))) {
    const serial = Math.floor(Number(v));
    // 1954-10-03 … 2119-01-11: wide enough for any return, narrow enough to skip amounts.
    if (serial < 20_000 || serial > 80_000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = text(v);
  let m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ,]+(\d{2}|\d{4})$/.exec(s);
  if (m && monthIndex(m[2])) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return isoDate(year, monthIndex(m[2]), Number(m[1]));
  }
  return null;
}

/** "092026" (the portal's MMYYYY) → "2026-09"; null when it is not one. */
function periodOfMmyyyy(v: unknown): string | null {
  const m = /^(\d{2})(\d{4})$/.exec(text(v));
  if (!m) return null;
  const month = Number(m[1]);
  return month >= 1 && month <= 12 ? `${m[2]}-${m[1]}` : null;
}

/** 27, "27", "7", "27-Maharashtra", "Maharashtra (27)", "Maharashtra" → "27"/"07". */
function posCode(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const lead = /^(\d{1,2})(?!\d)/.exec(s);
  if (lead) return lead[1].padStart(2, "0");
  const inner = /\((\d{1,2})\)/.exec(s);
  if (inner) return inner[1].padStart(2, "0");
  return gstState(s.replace(/[-–]\s*$/, ""))?.code ?? null;
}

/** Y/N, Yes/No, true/false → boolean; anything else null. */
function yesNo(v: unknown): boolean | null {
  const s = text(v).toUpperCase();
  if (s === "Y" || s === "YES" || s === "TRUE" || s === "1") return true;
  if (s === "N" || s === "NO" || s === "FALSE" || s === "0") return false;
  return null;
}

/* ---------------------------------------------------------------- building documents */

function addRate(rates: PortalRate[], rateBp: number, a: Amounts): void {
  const existing = rates.find((r) => r.rateBp === rateBp);
  if (existing) {
    existing.taxablePaise += a.taxablePaise;
    existing.igstPaise += a.igstPaise;
    existing.cgstPaise += a.cgstPaise;
    existing.sgstPaise += a.sgstPaise;
    existing.cessPaise += a.cessPaise;
  } else {
    rates.push({ rateBp, ...a });
  }
}

function sumAmounts(list: Amounts[]): Amounts {
  const out = emptyAmounts();
  for (const a of list) {
    out.taxablePaise += a.taxablePaise;
    out.igstPaise += a.igstPaise;
    out.cgstPaise += a.cgstPaise;
    out.sgstPaise += a.sgstPaise;
    out.cessPaise += a.cessPaise;
  }
  return out;
}

const taxOf = (a: Amounts) => a.igstPaise + a.cgstPaise + a.sgstPaise + a.cessPaise;

/** Amounts under either naming: GSTR-2B (igst, cgst…) or GSTR-1/2A itm_det (iamt, camt…). */
function amountsOf(o: Json): Amounts {
  return {
    taxablePaise: rupeesToPaiseSafe(o.txval),
    igstPaise: rupeesToPaiseSafe(o.igst ?? o.iamt),
    cgstPaise: rupeesToPaiseSafe(o.cgst ?? o.camt),
    sgstPaise: rupeesToPaiseSafe(o.sgst ?? o.samt),
    cessPaise: rupeesToPaiseSafe(o.cess ?? o.csamt),
  };
}

const AMOUNT_KEYS = ["txval", "igst", "cgst", "sgst", "cess", "iamt", "camt", "samt", "csamt"];

interface Ctx {
  warnings: string[];
  count: number;
}

function pushDoc(ctx: Ctx, out: PortalInvoice[], doc: PortalInvoice): void {
  ctx.count += 1;
  if (ctx.count > PORTAL_MAX_ROWS) {
    throw validationFailed(`The file has more than ${PORTAL_MAX_ROWS} documents. Download one month at a time.`);
  }
  out.push(doc);
}

/**
 * One invoice or note from any of the JSON shapes. Invoice-level amounts win
 * when present (GSTR-2B); otherwise they are summed from the items.
 */
function docFromJson(section: Section, ctin: string, name: string | null, doc: Json, isNote: boolean, ctx: Ctx): PortalInvoice | null {
  const invoiceNo = text(isNote ? (doc.ntnum ?? doc.nt_num ?? doc.inum) : (doc.inum ?? doc.boenum));
  if (!invoiceNo) {
    ctx.warnings.push(`A ${section} document from ${ctin || "an unregistered party"} has no number and was skipped.`);
    return null;
  }
  const rawDate = isNote ? (doc.dt ?? doc.nt_dt ?? doc.ntdt) : (doc.dt ?? doc.idt ?? doc.boedt);
  const invoiceDate = portalDate(rawDate) ?? "";
  if (!invoiceDate) ctx.warnings.push(`${section} ${invoiceNo}: the date "${text(rawDate)}" could not be read.`);

  const rates: PortalRate[] = [];
  for (const item of objs(doc.items ?? doc.itms)) {
    const det = isObj(item.itm_det) ? item.itm_det : item;
    addRate(rates, rateBpOf(det.rt), amountsOf(det));
  }
  rates.sort((a, b) => a.rateBp - b.rateBp);
  const fromItems = sumAmounts(rates);
  const hasInvoiceLevel = AMOUNT_KEYS.some((k) => doc[k] != null);
  const amounts = hasInvoiceLevel || rates.length === 0 ? amountsOf(doc) : fromItems;
  if (hasInvoiceLevel && rates.length > 0 && (fromItems.taxablePaise !== amounts.taxablePaise || taxOf(fromItems) !== taxOf(amounts))) {
    ctx.warnings.push(`${section} ${invoiceNo}: item amounts do not add up to the document's totals; the totals were used.`);
  }

  const noteType = text(isNote ? (doc.typ ?? doc.ntty) : doc.ntty).toUpperCase();
  const docType: DocType = isNote ? (noteType === "D" ? "DBN" : "CRN") : "INV";
  const total = doc.val != null ? rupeesToPaiseSafe(doc.val) : amounts.taxablePaise + taxOf(amounts);
  return {
    section,
    counterpartyGstin: ctin,
    counterpartyName: name,
    invoiceNo,
    invoiceDate,
    docType,
    placeOfSupply: posCode(doc.pos),
    reverseCharge: yesNo(doc.rev ?? doc.rchrg) === true,
    ...amounts,
    totalPaise: total,
    itcAvailable: yesNo(doc.itcavl),
    itcUnavailableReason: textOrNull(doc.rsn),
    irn: textOrNull(doc.irn),
    rates,
  };
}

/** b2b-style: [{ctin, trdnm, inv|nt: [...]}]. */
function readParties(section: Section, list: unknown, docsKey: "inv" | "nt", ctx: Ctx, out: PortalInvoice[]): void {
  for (const party of objs(list)) {
    const ctin = gstinOf(party.ctin);
    const name = textOrNull(party.trdnm ?? party.trade_name ?? party.lglnm);
    for (const doc of objs(party[docsKey])) {
      const d = docFromJson(section, ctin, name, doc, docsKey === "nt", ctx);
      if (d) pushDoc(ctx, out, d);
    }
  }
}

function readImpg(list: unknown, ctx: Ctx, out: PortalInvoice[]): void {
  for (const boe of objs(list)) {
    const d = docFromJson("IMPG", gstinOf(boe.ctin), textOrNull(boe.trdnm), boe, false, ctx);
    if (d) pushDoc(ctx, out, d);
  }
}

/** Non-empty sections this parser does not read: a warning each. */
function warnUnread(body: Json, known: Set<string>, label: string, ctx: Ctx): void {
  for (const [key, value] of Object.entries(body)) {
    if (known.has(key)) continue;
    const size = Array.isArray(value) ? value.length : isObj(value) ? Object.keys(value).length : 0;
    if (size > 0 && (Array.isArray(value) || key === key.toLowerCase())) {
      ctx.warnings.push(`${label} section "${key}" (${size} ${size === 1 ? "entry" : "entries"}) was not read.`);
    }
  }
}

/* ---------------------------------------------------------------- JSON */

/** The object holding the return: some downloads wrap it in {"data": …}. */
function bodyOf(root: Json): Json {
  return isObj(root.data) && !("b2b" in root) && !("docdata" in root) ? root.data : root;
}

const GSTR1_MARKERS = ["b2cs", "b2cl", "hsn", "doc_issue", "cdnr", "cdnur", "exp", "nil", "gt", "cur_gt", "b2csa", "b2cla", "at", "txpd"];

function detectReturnType(root: Json, ctx: Ctx): PortalReturnType | null {
  const body = bodyOf(root);
  if ("docdata" in body || "rtnprd" in body || "docdata" in root || "rtnprd" in root) return "GSTR2B";
  const filed = objs(body.b2b).some((s) => "cfs" in s || "cfs3b" in s || "fldtr1" in s || "flprdr1" in s);
  if (filed || ["cdn", "cdna", "isd", "tds", "tcs"].some((k) => k in body)) return "GSTR2A";
  if (GSTR1_MARKERS.some((k) => k in body)) return "GSTR1";
  if ("fp" in body && "b2b" in body) {
    ctx.warnings.push("Could not tell which return this file is; it was read as GSTR-1. Choose the return type if this is wrong.");
    return "GSTR1";
  }
  return null;
}

function parse2b(root: Json, ctx: Ctx): Omit<ParsedPortalFile, "returnType" | "warnings"> {
  const body = bodyOf(root);
  const period = periodOfMmyyyy(body.rtnprd ?? root.rtnprd);
  const docs = isObj(body.docdata) ? body.docdata : body;
  const out: PortalInvoice[] = [];
  readParties("B2B", docs.b2b, "inv", ctx, out);
  readParties("B2BA", docs.b2ba, "inv", ctx, out);
  readParties("CDNR", docs.cdnr, "nt", ctx, out);
  readParties("CDNRA", docs.cdnra, "nt", ctx, out);
  readImpg(docs.impg, ctx, out);
  readImpg(docs.impgsez, ctx, out);
  if (docs !== body) {
    warnUnread(docs, new Set(["b2b", "b2ba", "cdnr", "cdnra", "impg", "impgsez"]), "GSTR-2B", ctx);
  }
  return { gstin: gstinOf(body.gstin ?? root.gstin) || null, period, invoices: out };
}

function parse2a(root: Json, ctx: Ctx): Omit<ParsedPortalFile, "returnType" | "warnings"> {
  const body = bodyOf(root);
  const period = periodOfMmyyyy(body.fp ?? root.fp);
  const out: PortalInvoice[] = [];
  readParties("B2B", body.b2b, "inv", ctx, out);
  readParties("B2BA", body.b2ba, "inv", ctx, out);
  readParties("CDNR", body.cdn ?? body.cdnr, "nt", ctx, out);
  readParties("CDNRA", body.cdna ?? body.cdnra, "nt", ctx, out);
  readImpg(body.impg, ctx, out);
  readImpg(body.impgsez, ctx, out);
  warnUnread(body, new Set(["gstin", "fp", "b2b", "b2ba", "cdn", "cdnr", "cdna", "cdnra", "impg", "impgsez"]), "GSTR-2A", ctx);
  return { gstin: gstinOf(body.gstin ?? root.gstin) || null, period, invoices: out };
}

function parse1(root: Json, ctx: Ctx): Omit<ParsedPortalFile, "returnType" | "warnings"> {
  const body = bodyOf(root);
  const period = periodOfMmyyyy(body.fp ?? root.fp);
  const out: PortalInvoice[] = [];
  readParties("B2B", body.b2b, "inv", ctx, out);
  readParties("B2BA", body.b2ba, "inv", ctx, out);
  readParties("CDNR", body.cdnr, "nt", ctx, out);
  readParties("CDNRA", body.cdnra, "nt", ctx, out);

  // B2C large: [{pos, inv: [...]}] — no buyer GSTIN; pos is on the group.
  for (const group of objs(body.b2cl)) {
    for (const inv of objs(group.inv)) {
      const d = docFromJson("OTHER", "", null, { pos: group.pos, ...inv }, false, ctx);
      if (d) pushDoc(ctx, out, d);
    }
  }
  // Credit/debit notes to unregistered buyers.
  for (const note of objs(body.cdnur)) {
    const d = docFromJson("OTHER", "", null, note, true, ctx);
    if (d) pushDoc(ctx, out, d);
  }
  // B2C small: summary lines by place of supply and rate, not documents.
  for (const line of objs(body.b2cs)) {
    const pos = posCode(line.pos);
    const rateBp = rateBpOf(line.rt);
    const amounts = amountsOf(line);
    const etin = text(line.etin);
    pushDoc(ctx, out, {
      section: "OTHER",
      counterpartyGstin: "",
      counterpartyName: null,
      invoiceNo: `B2CS-${pos ?? "NA"}-${rateBp / 100}${etin ? `-${etin}` : ""}`,
      invoiceDate: period ? `${period}-01` : "",
      docType: "INV",
      placeOfSupply: pos,
      reverseCharge: false,
      ...amounts,
      totalPaise: amounts.taxablePaise + taxOf(amounts),
      itcAvailable: null,
      itcUnavailableReason: null,
      irn: null,
      rates: [{ rateBp, ...amounts }],
    });
  }
  // Summaries (hsn, doc_issue, nil) restate the documents above: ignored without a warning.
  const known = new Set(["gstin", "fp", "gt", "cur_gt", "version", "hash", "b2b", "b2ba", "cdnr", "cdnra", "b2cl", "cdnur", "b2cs", "hsn", "doc_issue", "nil"]);
  warnUnread(body, known, "GSTR-1", ctx);
  return { gstin: gstinOf(body.gstin ?? root.gstin) || null, period, invoices: out };
}

const RETURN_LABEL: Record<PortalReturnType, string> = { GSTR2B: "GSTR-2B", GSTR2A: "GSTR-2A", GSTR1: "GSTR-1" };

/**
 * A GSTR-2B / GSTR-2A / GSTR-1 JSON file. Throws a validation error (with a
 * message fit for the shop owner) when the text is not JSON or not a return.
 */
export function parsePortalJson(text: string, hint?: PortalReturnType): ParsedPortalFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw validationFailed("The file is not valid JSON. Download the JSON file from the GST portal again and upload it as it is.");
  }
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
  if (!isObj(parsed)) {
    throw validationFailed("This JSON file is not a GST return downloaded from the GST portal.");
  }
  const ctx: Ctx = { warnings: [], count: 0 };
  // Detection's own doubts matter only when there is no hint.
  const detection: Ctx = { warnings: [], count: 0 };
  const detected = detectReturnType(parsed, detection);
  if (!hint) ctx.warnings.push(...detection.warnings);
  const returnType = hint ?? detected;
  if (!returnType || (!detected && !["gstin", "fp", "b2b", "cdnr", "cdn"].some((k) => k in bodyOf(parsed as Json)))) {
    throw validationFailed("This JSON file is not a GSTR-2B, GSTR-2A or GSTR-1 file from the GST portal.");
  }
  if (hint && detected && detected !== hint && detection.warnings.length === 0) {
    ctx.warnings.push(`The file looks like ${RETURN_LABEL[detected]} but was read as ${RETURN_LABEL[hint]}, as chosen.`);
  }
  const read = returnType === "GSTR2B" ? parse2b(parsed, ctx) : returnType === "GSTR2A" ? parse2a(parsed, ctx) : parse1(parsed, ctx);
  return { returnType, ...read, warnings: ctx.warnings };
}

/* ---------------------------------------------------------------- Excel */

type Field =
  | "gstin"
  | "name"
  | "invoiceNo"
  | "invoiceType"
  | "noteType"
  | "invoiceDate"
  | "invoiceValue"
  | "pos"
  | "reverseCharge"
  | "rate"
  | "taxable"
  | "igst"
  | "cgst"
  | "sgst"
  | "cess"
  | "itc"
  | "reason"
  | "irn";

/** Lower-case letters and digits only: "Invoice Value(₹)" → "invoicevalue". */
const normLabel = (s: string) =>
  s
    .toLowerCase()
    .replace(/₹|\(rs\.?\)|\brs\.?(?=\s|\)|$)/g, "")
    .replace(/[^a-z0-9]/g, "");

/**
 * A header cell's field. "ignore" marks a recognised heading that is not
 * read (filing period, source…); null is not a heading at all.
 */
function fieldOf(label: string): Field | "ignore" | null {
  const n = normLabel(label);
  if (!n) return null;
  if (n.includes("period") || n.includes("filingdate") || n.includes("applicable") || n === "source" || n.includes("irndate")) return "ignore";
  if (n.includes("icegate") || n.includes("portcode") || n.includes("amended") || n.includes("ecommerce")) return "ignore";
  if (n.includes("gstin")) return "gstin";
  if (n.includes("tradelegalname") || n.includes("tradename") || n.includes("legalname") || n.includes("suppliername") || n.includes("nameofsupplier") || n.includes("partyname") || n === "name") return "name";
  if (n === "notetype" || n === "documenttype" || n === "doctype") return "noteType";
  if (n.includes("invoicetype") || n.includes("supplytype")) return "invoiceType";
  if (/^(invoice|note|document|bill|creditnote|debitnote)(number|no)$/.test(n) || n.includes("billofentrynumber") || n === "boenumber") return "invoiceNo";
  if (/^(invoice|note|document|bill|creditnote|debitnote)date$/.test(n) || n.includes("billofentrydate") || n === "date" || n === "dateofinvoice") return "invoiceDate";
  if (/^(invoice|note|document|bill|total)value$/.test(n)) return "invoiceValue";
  if (n.includes("placeofsupply") || n === "pos") return "pos";
  if (n.includes("reversecharge")) return "reverseCharge";
  if (n === "rate" || n === "taxrate" || n === "gstrate" || n === "ratepercent") return "rate";
  if (n.includes("taxablevalue")) return "taxable";
  if (n.includes("integratedtax") || n === "igst" || n === "igstamount") return "igst";
  if (n.includes("centraltax") || n === "cgst" || n === "cgstamount") return "cgst";
  if (n.includes("stateuttax") || n.includes("statetax") || n === "sgst" || n === "sgstamount" || n === "utgst") return "sgst";
  if (n.includes("cess")) return "cess";
  if (n.includes("itcavailab") || n === "itceligible") return "itc";
  if (n.includes("reason")) return "reason";
  if (n === "irn" || n === "irnnumber") return "irn";
  return null;
}

/** A cell's plain value: formulas give their result, rich text its text. */
function cellValue(v: ExcelJS.CellValue | undefined): unknown {
  if (v == null) return null;
  if (typeof v !== "object" || v instanceof Date) return v;
  const o = v as unknown as Json;
  if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text ?? "").join("");
  if ("error" in o) return null;
  if ("formula" in o || "sharedFormula" in o) return cellValue(o.result as ExcelJS.CellValue);
  if ("hyperlink" in o) return o.text ?? o.hyperlink;
  return null;
}

interface Row {
  n: number;
  cells: unknown[];
}

function readRows(sheet: ExcelJS.Worksheet, ctx: Ctx | null, limit = Infinity): Row[] {
  const rows: Row[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    if (rows.length >= limit) return;
    const cells: unknown[] = [];
    for (let c = 1; c <= row.cellCount; c++) cells.push(cellValue(row.getCell(c).value));
    if (cells.some((v) => text(v) !== "" || v instanceof Date)) rows.push({ n, cells });
  });
  if (!ctx) return rows;
  ctx.count += rows.length;
  if (ctx.count > PORTAL_MAX_ROWS + 50) {
    throw validationFailed(`The workbook has more than ${PORTAL_MAX_ROWS} rows. Download one month at a time.`);
  }
  return rows;
}

function sectionOfSheet(name: string): Section | "skip" | null {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n === "b2b") return "B2B";
  if (n === "b2ba") return "B2BA";
  if (n === "b2bcdnr" || n === "cdnr") return "CDNR";
  if (n === "b2bcdnra" || n === "cdnra") return "CDNRA";
  if (n === "impg" || n === "impgsez") return "IMPG";
  if (n.includes("readme") || n.startsWith("itc") || n.includes("summary")) return "skip";
  return null;
}

interface HeaderMap {
  columns: Map<Field, number>;
  dataFrom: number;
}

/**
 * Finds the header: the row (within the first 30) naming the most known
 * columns, with an invoice/note number among them. Merged header rows above
 * it give context — a column under "Original details" (B2BA, CDNRA) is not
 * read; a column whose bottom cell is not a known title takes the title above.
 */
function findHeader(rows: Row[]): HeaderMap | null {
  const scan = rows.slice(0, 30);
  let best = -1;
  let bestScore = 0;
  scan.forEach((row, i) => {
    const fields = row.cells.map((c) => fieldOf(text(c)));
    const score = fields.filter((f) => f !== null).length;
    if (score >= 3 && fields.includes("invoiceNo") && score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  if (best < 0) return null;
  let end = best;
  while (end + 1 < scan.length) {
    const next = scan[end + 1].cells;
    const score = next.filter((c) => fieldOf(text(c)) !== null).length;
    if (score < 2 || next.some((c) => GSTIN_LIKE.test(gstinOf(c)))) break;
    end += 1;
  }
  const block = scan.slice(Math.max(0, best - 2), end + 1);
  const width = Math.max(...block.map((r) => r.cells.length));
  const columns = new Map<Field, number>();
  for (let c = 0; c < width; c++) {
    if (block.some((r) => normLabel(text(r.cells[c])).includes("original"))) continue;
    for (let i = block.length - 1; i >= 0; i--) {
      const f = fieldOf(text(block[i].cells[c]));
      if (f === null) continue;
      if (f !== "ignore") columns.set(f, c);
      break;
    }
  }
  if (!columns.has("invoiceNo")) return null;
  return { columns, dataFrom: rows.indexOf(scan[end]) + 1 };
}

function readSheetDocs(rows: Row[], sheetSection: Section | null, sheetName: string, ctx: Ctx, out: PortalInvoice[]): boolean {
  const header = findHeader(rows);
  if (!header) return false;
  const get = (row: Row, f: Field): unknown => {
    const c = header.columns.get(f);
    return c === undefined ? null : row.cells[c];
  };
  const byKey = new Map<string, PortalInvoice>();
  let skipped = 0;
  for (const row of rows.slice(header.dataFrom)) {
    const invoiceNo = text(get(row, "invoiceNo"));
    const gstin = gstinOf(get(row, "gstin"));
    if (!invoiceNo || (!gstin && sheetSection !== "IMPG" && header.columns.has("gstin"))) {
      skipped += 1;
      continue;
    }
    const noteType = text(get(row, "noteType")).toLowerCase();
    let docType: DocType = noteType.includes("debit") ? "DBN" : noteType.includes("credit") ? "CRN" : "INV";
    if (docType === "INV" && (sheetSection === "CDNR" || sheetSection === "CDNRA")) docType = noteType.startsWith("d") ? "DBN" : "CRN";
    const section: Section = sheetSection ?? (docType === "INV" ? "B2B" : "CDNR");
    const invoiceDate = portalDate(get(row, "invoiceDate")) ?? "";
    const amounts: Amounts = {
      taxablePaise: rupeesToPaiseSafe(get(row, "taxable")),
      igstPaise: rupeesToPaiseSafe(get(row, "igst")),
      cgstPaise: rupeesToPaiseSafe(get(row, "cgst")),
      sgstPaise: rupeesToPaiseSafe(get(row, "sgst")),
      cessPaise: rupeesToPaiseSafe(get(row, "cess")),
    };
    const key = [section, gstin, invoiceNo.toUpperCase(), docType, invoiceDate].join("|");
    let doc = byKey.get(key);
    if (!doc) {
      if (!invoiceDate) ctx.warnings.push(`${sheetName} row ${row.n}: the date "${text(get(row, "invoiceDate"))}" could not be read.`);
      doc = {
        section,
        counterpartyGstin: gstin,
        counterpartyName: textOrNull(get(row, "name")),
        invoiceNo,
        invoiceDate,
        docType,
        placeOfSupply: posCode(get(row, "pos")),
        reverseCharge: yesNo(get(row, "reverseCharge")) === true,
        ...emptyAmounts(),
        totalPaise: 0,
        itcAvailable: yesNo(get(row, "itc")),
        itcUnavailableReason: textOrNull(get(row, "reason")),
        irn: textOrNull(get(row, "irn")),
        rates: [],
      };
      byKey.set(key, doc);
      pushDoc(ctx, out, doc);
    }
    doc.taxablePaise += amounts.taxablePaise;
    doc.igstPaise += amounts.igstPaise;
    doc.cgstPaise += amounts.cgstPaise;
    doc.sgstPaise += amounts.sgstPaise;
    doc.cessPaise += amounts.cessPaise;
    // The invoice value repeats on every rate row of the same invoice.
    if (!doc.totalPaise) doc.totalPaise = rupeesToPaiseSafe(get(row, "invoiceValue"));
    if (header.columns.has("rate")) addRate(doc.rates, rateBpOf(get(row, "rate")), amounts);
  }
  for (const doc of byKey.values()) {
    if (!doc.totalPaise) doc.totalPaise = doc.taxablePaise + taxOf(doc);
    doc.rates.sort((a, b) => a.rateBp - b.rateBp);
  }
  if (skipped > 0) ctx.warnings.push(`${sheetName}: ${skipped} row(s) without an invoice number or GSTIN were skipped.`);
  return true;
}

/** "September" + FY "2026-27" → "2026-09"; also "092026", "Sep-2026", "2026-09". */
function periodFromText(raw: string, fy: string | null): string | null {
  const s = raw.trim();
  const mmyyyy = periodOfMmyyyy(s);
  if (mmyyyy) return mmyyyy;
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return s;
  m = /^([A-Za-z]{3,9})[-/ ,']+(\d{2}|\d{4})$/.exec(s);
  if (m && monthIndex(m[1])) {
    const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    return `${year}-${String(monthIndex(m[1])).padStart(2, "0")}`;
  }
  const month = /^[A-Za-z]{3,9}$/.test(s) ? monthIndex(s) : 0;
  const fyStart = fy ? /^(\d{4})/.exec(fy.trim()) : null;
  if (month && fyStart) {
    const year = Number(fyStart[1]) + (month <= 3 ? 1 : 0);
    return `${year}-${String(month).padStart(2, "0")}`;
  }
  return null;
}

/** The shop's GSTIN and the tax period from the "Read me" sheet's label/value pairs. */
function readMeta(rows: Row[]): { gstin: string | null; period: string | null } {
  let gstin: string | null = null;
  let periodText: string | null = null;
  let fy: string | null = null;
  for (const row of rows.slice(0, 25)) {
    for (let c = 0; c < row.cells.length; c++) {
      const label = normLabel(text(row.cells[c]));
      if (!label) continue;
      const value = row.cells.slice(c + 1).map(text).find((v) => v !== "") ?? "";
      if (!gstin && label.includes("gstin") && GSTIN_LIKE.test(gstinOf(value))) gstin = gstinOf(value);
      else if (!periodText && (label.includes("taxperiod") || label === "period" || label === "returnperiod")) periodText = value;
      else if (!fy && label.includes("financialyear")) fy = value;
    }
  }
  return { gstin, period: periodText ? periodFromText(periodText, fy) : null };
}

/**
 * The GSTR-2B Excel workbook from the portal (sheets "B2B", "B2BA",
 * "B2B-CDNR", "B2B-CDNRA", "IMPG"; "Read me" for GSTIN and period), or any
 * workbook with those column titles on one sheet. Rows of one invoice (one
 * per rate) merge into one document. The caller checks the file size.
 */
export async function parsePortalExcel(bytes: Buffer, hint?: PortalReturnType): Promise<ParsedPortalFile> {
  const { default: Excel } = await import("exceljs");
  const workbook = new Excel.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw validationFailed("The Excel file could not be read. Upload the .xlsx file exactly as downloaded from the GST portal.");
  }
  const ctx: Ctx = { warnings: [], count: 0 };
  const sheets = workbook.worksheets.map((sheet) => ({ sheet, section: sectionOfSheet(sheet.name) }));
  let gstin: string | null = null;
  let period: string | null = null;
  for (const { sheet, section } of sheets) {
    if (section !== "skip" && sheets.some((s) => s.section === "skip")) continue;
    const meta = readMeta(readRows(sheet, null, 25));
    gstin ??= meta.gstin;
    period ??= meta.period;
    if (gstin && period) break;
  }

  const invoices: PortalInvoice[] = [];
  const named = sheets.filter((s) => s.section !== null && s.section !== "skip");
  if (named.length > 0) {
    for (const { sheet, section } of named) {
      const rows = readRows(sheet, ctx);
      if (rows.length === 0) continue;
      if (!readSheetDocs(rows, section as Section, sheet.name, ctx, invoices)) {
        ctx.warnings.push(`Sheet "${sheet.name}": the column titles were not recognised, so it was not read.`);
      }
    }
    for (const { sheet, section } of sheets) {
      if (section === null && sheet.actualRowCount > 0) ctx.warnings.push(`Sheet "${sheet.name}" was not read.`);
    }
  } else {
    // A plain sheet: the first one whose column titles are recognised.
    let found = false;
    for (const { sheet, section } of sheets) {
      if (section === "skip" || sheet.state === "hidden") continue;
      if (readSheetDocs(readRows(sheet, ctx), null, sheet.name, ctx, invoices)) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw validationFailed(
        'No sheet with invoice columns was found. Upload the GSTR-2B Excel from the GST portal, or a sheet with columns such as "GSTIN of supplier", "Invoice number", "Invoice Date" and "Taxable Value".',
      );
    }
  }
  return { returnType: hint ?? "GSTR2B", gstin, period, invoices, warnings: ctx.warnings };
}
