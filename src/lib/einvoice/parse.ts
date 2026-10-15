/**
 * Reading a supplier's e-invoice (Module 2, purchase entry): the NIC IRP
 * e-invoice JSON (schema v1.1) a supplier shares, the IRP's signed response
 * around it, and the signed QR code printed on the invoice.
 *
 * Accepted JSON shapes:
 *  - the invoice itself: {Version, TranDtls, DocDtls, SellerDtls, BuyerDtls,
 *    ItemList, ValDtls, …} (the portal's download adds AckNo/AckDt/Irn);
 *  - the IRP response: {AckNo, AckDt, Irn, SignedInvoice: "<JWT>",
 *    SignedQRCode: "<JWT>"}; the SignedInvoice payload's "data" is the
 *    invoice as a JSON string;
 *  - either of those wrapped in {"data": …} (object or JSON string), {"Data": …}
 *    or a one-element array.
 *
 * Signatures are NOT checked when reading the JSON: a JWT is only decoded.
 * verifySignedQr checks an RS256 signature against the IRP's public key,
 * which the caller supplies (it rotates; it is not bundled here).
 *
 * Pure: no database, no network. Amounts become integer paise, GST rates
 * basis points, dates YYYY-MM-DD; AckDt / IrnDt stay as the IRP wrote them
 * ("2026-09-15 12:34:00").
 */
import { createVerify } from "node:crypto";

import { validationFailed } from "@/lib/errors";
import { rupeesToPaiseSafe } from "@/lib/gst/portal-parsers";

export interface EinvoiceLine {
  slNo: number;
  description: string;
  hsn: string | null;
  barcode: string | null;
  qty: number;
  unit: string | null;
  unitPricePaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstRateBp: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  /** Cess of every kind on the line: ad valorem, non-ad valorem and state cess. */
  cessPaise: number;
  totalPaise: number;
}

export interface EinvoiceData {
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  docType: "INV" | "CRN" | "DBN";
  invoiceNo: string;
  /** YYYY-MM-DD. */
  invoiceDate: string;
  supplier: { gstin: string; legalName: string | null; tradeName: string | null; stateCode: string | null; address: string | null };
  /** gstin is null for an unregistered buyer ("URP"). */
  buyer: { gstin: string | null; legalName: string | null; stateCode: string | null; placeOfSupply: string | null };
  lines: EinvoiceLine[];
  totals: {
    taxablePaise: number;
    igstPaise: number;
    cgstPaise: number;
    sgstPaise: number;
    cessPaise: number;
    discountPaise: number;
    otherChargesPaise: number;
    roundOffPaise: number;
    totalPaise: number;
  };
}

export interface SignedQrPayload {
  sellerGstin: string;
  buyerGstin: string | null;
  docNo: string;
  docType: string;
  /** YYYY-MM-DD. */
  docDate: string;
  totalPaise: number;
  itemCount: number | null;
  mainHsn: string | null;
  irn: string;
  irnDate: string | null;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return "";
}

const textOrNull = (v: unknown): string | null => text(v) || null;
const paise = rupeesToPaiseSafe;

/** "15/09/2026" or "15-09-2026" (also "2026-09-15") → "2026-09-15"; null when not a real date. */
function dmyToIso(v: unknown): string | null {
  const s = text(v);
  let y: number, m: number, d: number;
  let match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (match) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!match) return null;
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A two-digit state code from "27", 27 or "7". */
function stateCode(v: unknown): string | null {
  const s = text(v);
  return /^\d{1,2}$/.test(s) ? s.padStart(2, "0") : s ? s.toUpperCase() : null;
}

/* ---------------------------------------------------------------- JWT */

/** base64url (or base64) with or without padding → bytes. */
function base64UrlDecode(part: string): Buffer {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64");
}

interface DecodedJwt {
  header: Json;
  payload: Json;
  signature: string;
  signingInput: string;
}

function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_\-+/=]*$/.test(p)) || !parts[0] || !parts[1]) return null;
  try {
    const header: unknown = JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
    const payload: unknown = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
    if (!isObj(header) || !isObj(payload)) return null;
    return { header, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
  } catch {
    return null;
  }
}

/** A JWT payload's "data": a JSON string (IRP) or already an object. */
function jwtData(payload: Json): Json | null {
  const data = payload.data;
  if (isObj(data)) return data;
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- invoice JSON */

const isInvoice = (o: Json) => isObj(o.DocDtls) && (Array.isArray(o.ItemList) || isObj(o.SellerDtls));

interface Found {
  invoice: Json;
  /** IRP response fields seen on the way down (AckNo, AckDt, Irn). */
  outer: Json;
}

/** Unwraps arrays of one, {"data"|"Data": …} and SignedInvoice down to the invoice. */
function findInvoice(v: unknown, outer: Json, depth: number): Found | null {
  if (depth > 6) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return findInvoice(JSON.parse(s), outer, depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(v)) return v.length === 1 ? findInvoice(v[0], outer, depth + 1) : null;
  if (!isObj(v)) return null;
  const merged: Json = { ...outer };
  for (const key of ["AckNo", "AckDt", "Irn"]) if (v[key] != null && v[key] !== "") merged[key] = v[key];
  if (isInvoice(v)) return { invoice: v, outer: merged };
  if (typeof v.SignedInvoice === "string") {
    const jwt = decodeJwt(v.SignedInvoice);
    const data = jwt ? jwtData(jwt.payload) : null;
    if (data) {
      const found = findInvoice(data, merged, depth + 1);
      if (found) return found;
    }
  }
  for (const key of ["data", "Data", "result", "Result"]) {
    if (key in v) {
      const found = findInvoice(v[key], merged, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function addressOf(d: Json): string | null {
  const parts = [d.Addr1, d.Addr2, d.Loc, d.Pin].map(text).filter((p) => p !== "");
  return parts.length ? parts.join(", ") : null;
}

function lineOf(item: Json, index: number): EinvoiceLine {
  const qty = Number(text(item.Qty) || 0);
  const taxable = paise(item.AssAmt);
  const igst = paise(item.IgstAmt);
  const cgst = paise(item.CgstAmt);
  const sgst = paise(item.SgstAmt);
  const cess = paise(item.CesAmt) + paise(item.CesNonAdvlAmt) + paise(item.StateCesAmt) + paise(item.StateCesNonAdvlAmt);
  const total = item.TotItemVal != null ? paise(item.TotItemVal) : taxable + igst + cgst + sgst + cess + paise(item.OthChrg);
  const slNo = Number.parseInt(text(item.SlNo), 10);
  return {
    slNo: Number.isFinite(slNo) ? slNo : index + 1,
    description: text(item.PrdDesc),
    hsn: textOrNull(item.HsnCd),
    barcode: textOrNull(item.Barcde),
    qty: Number.isFinite(qty) ? qty : 0,
    unit: textOrNull(item.Unit),
    unitPricePaise: paise(item.UnitPrice),
    discountPaise: paise(item.Discount),
    taxablePaise: taxable,
    gstRateBp: paise(item.GstRt),
    igstPaise: igst,
    cgstPaise: cgst,
    sgstPaise: sgst,
    cessPaise: cess,
    totalPaise: total,
  };
}

/**
 * The supplier's e-invoice JSON in any of the shapes above. Throws a
 * validation error when the text is not an e-invoice.
 */
export function parseEinvoiceJson(json: string): EinvoiceData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.replace(/^﻿/, ""));
  } catch {
    throw validationFailed("The file is not valid JSON. Upload the e-invoice JSON exactly as received.");
  }
  const found = findInvoice(parsed, {}, 0);
  if (!found) {
    throw validationFailed("This JSON is not an e-invoice (no DocDtls / ItemList from the IRP schema).");
  }
  const { invoice: inv, outer } = found;
  const doc = inv.DocDtls as Json;
  const seller = isObj(inv.SellerDtls) ? inv.SellerDtls : {};
  const buyer = isObj(inv.BuyerDtls) ? inv.BuyerDtls : {};

  const invoiceNo = text(doc.No);
  const invoiceDate = dmyToIso(doc.Dt);
  const sellerGstin = text(seller.Gstin).toUpperCase();
  if (!invoiceNo || !invoiceDate || !sellerGstin) {
    throw validationFailed("The e-invoice is missing its number, date or the supplier's GSTIN.");
  }
  const typ = text(doc.Typ).toUpperCase();
  const docType: EinvoiceData["docType"] = typ === "CRN" ? "CRN" : typ === "DBN" ? "DBN" : "INV";
  const buyerGstinRaw = text(buyer.Gstin).toUpperCase();

  const lines = (Array.isArray(inv.ItemList) ? inv.ItemList : []).filter(isObj).map(lineOf);
  const sum = (k: keyof EinvoiceLine) => lines.reduce((s, l) => s + (l[k] as number), 0);
  const val = isObj(inv.ValDtls) ? inv.ValDtls : null;
  const totals: EinvoiceData["totals"] = val
    ? {
        taxablePaise: paise(val.AssVal),
        igstPaise: paise(val.IgstVal),
        cgstPaise: paise(val.CgstVal),
        sgstPaise: paise(val.SgstVal),
        cessPaise: paise(val.CesVal) + paise(val.StCesVal),
        discountPaise: paise(val.Discount),
        otherChargesPaise: paise(val.OthChrg),
        roundOffPaise: paise(val.RndOffAmt),
        totalPaise: paise(val.TotInvVal),
      }
    : {
        taxablePaise: sum("taxablePaise"),
        igstPaise: sum("igstPaise"),
        cgstPaise: sum("cgstPaise"),
        sgstPaise: sum("sgstPaise"),
        cessPaise: sum("cessPaise"),
        discountPaise: 0,
        otherChargesPaise: 0,
        roundOffPaise: 0,
        totalPaise: sum("totalPaise"),
      };

  return {
    irn: textOrNull(outer.Irn ?? inv.Irn),
    ackNo: textOrNull(outer.AckNo ?? inv.AckNo),
    ackDate: textOrNull(outer.AckDt ?? inv.AckDt),
    docType,
    invoiceNo,
    invoiceDate,
    supplier: {
      gstin: sellerGstin,
      legalName: textOrNull(seller.LglNm),
      tradeName: textOrNull(seller.TrdNm),
      stateCode: stateCode(seller.Stcd),
      address: addressOf(seller),
    },
    buyer: {
      gstin: buyerGstinRaw && buyerGstinRaw !== "URP" ? buyerGstinRaw : null,
      legalName: textOrNull(buyer.LglNm),
      stateCode: stateCode(buyer.Stcd),
      placeOfSupply: stateCode(buyer.Pos),
    },
    lines,
    totals,
  };
}

/* ---------------------------------------------------------------- signed QR */

/**
 * The e-invoice signed QR code (a JWT whose payload "data" is a JSON string
 * of SellerGstin, BuyerGstin, DocNo, DocTyp, DocDt, TotInvVal, ItemCnt,
 * MainHsnCode, Irn, IrnDt). Decoded only — see verifySignedQr. null when the
 * text is not such a token.
 */
export function decodeSignedQr(
  token: string,
): { payload: SignedQrPayload; header: Record<string, unknown>; signature: string; signingInput: string } | null {
  const jwt = decodeJwt(token);
  if (!jwt) return null;
  const data = jwtData(jwt.payload);
  if (!data) return null;
  const sellerGstin = text(data.SellerGstin).toUpperCase();
  const docNo = text(data.DocNo);
  const irn = text(data.Irn);
  const docDate = dmyToIso(data.DocDt);
  if (!sellerGstin || !docNo || !irn || !docDate) return null;
  const buyerGstin = text(data.BuyerGstin).toUpperCase();
  const itemCount = Number.parseInt(text(data.ItemCnt), 10);
  return {
    payload: {
      sellerGstin,
      buyerGstin: buyerGstin && buyerGstin !== "URP" ? buyerGstin : null,
      docNo,
      docType: text(data.DocTyp).toUpperCase(),
      docDate,
      totalPaise: paise(data.TotInvVal),
      itemCount: Number.isFinite(itemCount) ? itemCount : null,
      mainHsn: textOrNull(data.MainHsnCode),
      irn,
      irnDate: textOrNull(data.IrnDt),
    },
    header: jwt.header,
    signature: jwt.signature,
    signingInput: jwt.signingInput,
  };
}

/** True only when the token is an RS256 JWT signed by the key's holder (the IRP). False on any error. */
export function verifySignedQr(token: string, publicKeyPem: string): boolean {
  try {
    const jwt = decodeJwt(token);
    if (!jwt || jwt.header.alg !== "RS256" || !jwt.signature) return false;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(jwt.signingInput);
    verifier.end();
    return verifier.verify(publicKeyPem, base64UrlDecode(jwt.signature));
  } catch {
    return false;
  }
}
