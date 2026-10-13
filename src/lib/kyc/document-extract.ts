/**
 * Reading a shop document (Task 2, docs/document-upload-2026-10): turns the
 * text an OCR engine read off a photo or PDF into the fields the seller then
 * reviews — document type, number, name, address and validity dates — and
 * flags what needs a re-upload or a correction.
 *
 * Pure functions only (no I/O), so the same rules run in tests, on the server
 * and, for the hints, in the browser. The server re-checks everything the
 * seller confirms; nothing here is trusted on its own.
 *
 * Aadhaar numbers are never extracted: any Aadhaar-shaped number in the text
 * is dropped before parsing (Aadhaar Act s.29, see doc-formats.ts).
 */
import { bestNameMatch } from "./name-match";
import {
  looksLikeAadhaar,
  parseSellerDocNumber,
  SELLER_DOC_LABELS,
  SELLER_DOC_TYPES,
  type SellerDocType,
} from "./doc-formats";
import { LEGAL_DOC_LABELS, parseLegalDocNumber, type LegalDocKey } from "../legal-documents";

/** Every document the upload screen can read: the seller-verification set plus the licences. */
export const UPLOAD_DOC_TYPES = ["PAN", "GSTIN", "UDYAM", "FSSAI", "SHOP_ACT", "DRUG_LICENCE", "MEDICAL_REGISTRATION"] as const;
export type UploadDocType = (typeof UPLOAD_DOC_TYPES)[number];

export const UPLOAD_DOC_LABELS: Record<UploadDocType, string> = {
  ...SELLER_DOC_LABELS,
  FSSAI: "FSSAI licence / registration",
  DRUG_LICENCE: LEGAL_DOC_LABELS.DRUG_LICENCE,
  MEDICAL_REGISTRATION: LEGAL_DOC_LABELS.MEDICAL_REGISTRATION,
};

export function isUploadDocType(value: unknown): value is UploadDocType {
  return typeof value === "string" && (UPLOAD_DOC_TYPES as readonly string[]).includes(value);
}

export function isSellerDocType(value: UploadDocType): value is SellerDocType {
  return (SELLER_DOC_TYPES as readonly string[]).includes(value);
}

/** Documents whose expiry date must be known (and in the future) before they are accepted. */
export const EXPIRY_REQUIRED: readonly UploadDocType[] = ["FSSAI", "DRUG_LICENCE"];

export interface ExtractedFields {
  /** What the document looks like, from its wording; null when unclear. */
  detectedType: UploadDocType | null;
  number: string | null;
  name: string | null;
  address: string | null;
  /** YYYY-MM-DD */
  validFrom: string | null;
  /** YYYY-MM-DD */
  validUntil: string | null;
}

export type FlagCode =
  | "UNREADABLE"
  | "WRONG_DOCUMENT"
  | "NUMBER_NOT_FOUND"
  | "NUMBER_INVALID"
  | "NAME_MISMATCH"
  | "EXPIRED"
  | "EXPIRING_SOON"
  | "NO_EXPIRY"
  | "LOW_QUALITY"
  | "AADHAAR_HIDDEN"
  /** The reader itself was unavailable or too slow (not the document's fault): the owner types the details. */
  | "NOT_READ";

export interface ExtractionFlag {
  code: FlagCode;
  /** block: the seller must re-upload (or fix the field) before submitting. warn: shown, recorded, not blocking. */
  severity: "block" | "warn";
  message: string;
}

/* ------------------------------------------------------------ text tidy */

/** Upper-cased lines with OCR noise trimmed; Aadhaar-shaped numbers removed. */
export function normaliseOcrText(raw: string): { lines: string[]; aadhaarRemoved: boolean } {
  let aadhaarRemoved = false;
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/[|¦]/g, " ")
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .map((line) =>
      line.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, (m) => {
        if (looksLikeAadhaar(m)) {
          aadhaarRemoved = true;
          return "[hidden]";
        }
        return m;
      }),
    )
    .filter((line) => line.length > 0);
  return { lines, aadhaarRemoved };
}

/* ------------------------------------------------------------ doc type */

const TYPE_SIGNALS: [UploadDocType, RegExp][] = [
  ["FSSAI", /\bFSSAI\b|FOOD SAFETY (AND|&) STANDARDS/i],
  ["GSTIN", /FORM GST REG|GOODS AND SERVICES TAX|REGISTRATION CERTIFICATE.*GST/i],
  ["UDYAM", /\bUDYAM\b/i],
  ["PAN", /INCOME ?TAX DEPARTMENT|PERMANENT ACCOUNT NUMBER/i],
  ["DRUG_LICENCE", /DRUGS? (AND|&) COSMETICS|DRUG LICEN[CS]E|FORM[- ]?2[01]\b/i],
  ["MEDICAL_REGISTRATION", /MEDICAL COUNCIL|MEDICAL REGISTRATION|COUNCIL OF (HOMOEOPATHY|INDIAN MEDICINE)/i],
  ["SHOP_ACT", /SHOPS? (AND|&) ESTABLISHMENTS?|INTIMATION|FORM ['"]?[BG]['"]?\b/i],
];

export function detectDocType(lines: string[]): UploadDocType | null {
  const text = lines.join("\n");
  for (const [type, re] of TYPE_SIGNALS) if (re.test(text)) return type;
  return null;
}

/* ------------------------------------------------------------ numbers */

// Common OCR confusions, applied only where a position must be a digit or a letter.
const TO_DIGIT: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G" };

/** Fixes a candidate to a letter/digit pattern ("A" letter, "9" digit, "*" either). */
function coerce(candidate: string, pattern: string): string | null {
  if (candidate.length !== pattern.length) return null;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = candidate[i];
    const p = pattern[i];
    if (p === "A") out += /[A-Z]/.test(c) ? c : (TO_LETTER[c] ?? "?");
    else if (p === "9") out += /\d/.test(c) ? c : (TO_DIGIT[c] ?? "?");
    else out += c;
  }
  return out.includes("?") ? null : out;
}

/** Words of the text, plus each pair and triple of neighbours joined ("ABCPE 1234F" → "ABCPE1234F"). */
function tokens(lines: string[]): string[] {
  const words = lines.join(" ").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const out = [...words];
  for (let i = 0; i < words.length; i++) {
    if (i + 1 < words.length) out.push(words[i] + words[i + 1]);
    if (i + 2 < words.length) out.push(words[i] + words[i + 1] + words[i + 2]);
  }
  return out;
}

function findPan(lines: string[]): string | null {
  for (const t of tokens(lines)) {
    if (t.length !== 10) continue;
    const fixed = coerce(t, "AAAAA9999A");
    if (fixed && parseSellerDocNumber("PAN", fixed).ok) return fixed;
  }
  return null;
}

function findGstin(lines: string[]): string | null {
  for (const t of tokens(lines)) {
    if (t.length !== 15) continue;
    const fixed = coerce(t, "99AAAAA9999A***");
    if (fixed && parseSellerDocNumber("GSTIN", fixed).ok) return fixed;
  }
  return null;
}

function findFssai(lines: string[]): string | null {
  const candidates: { value: string; labelled: boolean }[] = [];
  for (const line of lines) {
    const labelled = /LICEN[CS]E|REGISTRATION|REG\.? ?NO/i.test(line);
    for (const m of line.matchAll(/(?<!\d)(\d[\d ]{12,20}\d)(?!\d)/g)) {
      const digits = m[1].replace(/\s/g, "");
      if (digits.length === 14) candidates.push({ value: digits, labelled });
    }
  }
  return (candidates.find((c) => c.labelled) ?? candidates[0])?.value ?? null;
}

function findUdyam(lines: string[]): string | null {
  const text = lines.join(" ").toUpperCase();
  const m = text.match(/UDYAM\s*[-–]?\s*([A-Z]{2})\s*[-–]?\s*(\d{2})\s*[-–]?\s*(\d{7})/);
  return m ? `UDYAM-${m[1]}-${m[2]}-${m[3]}` : null;
}

const LABELLED_NUMBER =
  /(?:REGISTRATION|REGN\.?|CERTIFICATE|INTIMATION|RECEIPT|LICEN[CS]E|REG\.?)\s*(?:NO\.?|NUMBER|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-.]{2,39})/i;

function findLabelledNumber(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.match(LABELLED_NUMBER);
    if (m && (m[1].match(/\d/g) ?? []).length >= 3) {
      return m[1].replace(/[.\-/]+$/, "").toUpperCase();
    }
  }
  return null;
}

function findNumber(docType: UploadDocType, lines: string[]): string | null {
  switch (docType) {
    case "PAN":
      return findPan(lines);
    case "GSTIN":
      return findGstin(lines);
    case "FSSAI":
      return findFssai(lines);
    case "UDYAM":
      return findUdyam(lines);
    default:
      return findLabelledNumber(lines);
  }
}

/* ------------------------------------------------------------ names, address */

const NAME_LABEL =
  /^(?:NAME OF (?:THE )?(?:LICENSEE|LICENCE HOLDER|PROPRIETOR|APPLICANT|ENTERPRISE|ESTABLISHMENT|EMPLOYER|BUSINESS|FIRM|SHOP|REGISTERED PRACTITIONER|DOCTOR)|LEGAL NAME(?: OF BUSINESS)?|TRADE NAME(?:, IF ANY)?|NAME OF (?:THE )?(?:FBO|FOOD BUSINESS OPERATOR)|NAME)\b\s*[:\-.]?\s*(.*)$/i;

function cleanName(value: string): string | null {
  const name = value.replace(/[^A-Za-z .&'()-]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 3 || name.length > 120) return null;
  if (!/[A-Za-z]{2}/.test(name)) return null;
  return name.toUpperCase();
}

function findName(docType: UploadDocType, lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(NAME_LABEL);
    if (!m) continue;
    // "Name" with the value on the same line, or (PAN cards) on the next one.
    const sameLine = cleanName(m[1] ?? "");
    if (sameLine && !/FATHER|DATE|BIRTH/i.test(sameLine)) return sameLine;
    const next = lines[i + 1] ? cleanName(lines[i + 1]) : null;
    if (next && !/FATHER|DATE|BIRTH|SIGNATURE/i.test(next)) return next;
  }
  if (docType === "PAN") {
    // PAN cards: the holder's name is the first all-capitals line after the department heading.
    const start = lines.findIndex((l) => /INCOME ?TAX DEPARTMENT|GOVT\.? OF INDIA/i.test(l));
    for (const line of lines.slice(start + 1)) {
      if (/INCOME|GOVT|INDIA|PERMANENT|ACCOUNT|NUMBER|CARD|\d/i.test(line)) continue;
      const name = cleanName(line);
      if (name && name === line.toUpperCase()) return name;
    }
  }
  return null;
}

const ADDRESS_LABEL =
  /^(?:(?:ADDRESS|ADDR\.?)(?: OF (?:THE )?(?:PREMISES|BUSINESS|ESTABLISHMENT|PRINCIPAL PLACE OF BUSINESS|SHOP|KITCHEN))?|PREMISES|PRINCIPAL PLACE OF BUSINESS|PLACE OF BUSINESS)\b\s*[:\-.]?\s*(.*)$/i;
const ANY_LABEL = /^[A-Za-z][A-Za-z /().]{2,40}\s*[:]/;

function findAddress(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ADDRESS_LABEL);
    if (!m) continue;
    const parts = m[1] ? [m[1]] : [];
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      if (ANY_LABEL.test(lines[j])) break;
      parts.push(lines[j]);
      if (/\b\d{6}\b/.test(lines[j])) break;
    }
    const address = parts.join(", ").replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "");
    if (address.length >= 8) return address.slice(0, 300);
  }
  return null;
}

/* ------------------------------------------------------------ dates */

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}

/** Every date in a piece of text, in order: 31/03/2027, 31-03-27, 31.03.2027, 31 Mar 2027, 2027-03-31. */
export function parseDates(text: string): string[] {
  const found: { index: number; date: string }[] = [];
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const d = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) found.push({ index: m.index ?? 0, date: d });
  }
  for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g)) {
    const d = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
    if (d) found.push({ index: m.index ?? 0, date: d });
  }
  for (const m of text.matchAll(/\b(\d{1,2})(?:ST|ND|RD|TH)?[\s\-/.,]*([A-Z]{3,9})[\s\-/.,]*(\d{2,4})\b/gi)) {
    const month = MONTHS[m[2].toUpperCase().slice(0, m[2].toUpperCase().startsWith("SEPT") ? 4 : 3)];
    const d = month ? isoDate(Number(m[3]), month, Number(m[1])) : null;
    if (d) found.push({ index: m.index ?? 0, date: d });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.date);
}

const UNTIL_LABEL = /VALID\s*(?:UP\s*TO|UPTO|TILL|UNTIL|THROUGH)|VALIDITY|EXPIRY|EXPIRES|DATE OF EXPIRY|EXPIRING ON|RENEWAL DUE/i;
const FROM_LABEL = /VALID\s*FROM|DATE OF ISSUE|ISSUE DATE|ISSUED ON|DATE OF REGISTRATION|REGISTRATION DATE|DATE OF INCORPORATION/i;

function dateAfterLabel(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(label);
    if (!m) continue;
    const rest = lines[i].slice((m.index ?? 0) + m[0].length);
    // "Validity: 01/04/2022 to 31/03/2027" — the last date on a validity line is the end.
    const dates = parseDates(rest);
    if (dates.length) return label === UNTIL_LABEL ? dates[dates.length - 1] : dates[0];
    const next = lines[i + 1] ? parseDates(lines[i + 1]) : [];
    if (next.length) return label === UNTIL_LABEL ? next[next.length - 1] : next[0];
  }
  return null;
}

/* ------------------------------------------------------------ extract */

export function extractDocumentFields(rawText: string, expectedType: UploadDocType): {
  fields: ExtractedFields;
  aadhaarRemoved: boolean;
  textLength: number;
} {
  const { lines, aadhaarRemoved } = normaliseOcrText(rawText);
  const detectedType = detectDocType(lines);
  const validUntil = dateAfterLabel(lines, UNTIL_LABEL);
  let validFrom = dateAfterLabel(lines, FROM_LABEL);
  if (validFrom && validUntil && validFrom >= validUntil) validFrom = null;
  return {
    fields: {
      detectedType,
      number: findNumber(expectedType, lines),
      name: findName(expectedType, lines),
      address: findAddress(lines),
      validFrom,
      validUntil,
    },
    aadhaarRemoved,
    textLength: lines.join("").replace(/\s/g, "").length,
  };
}

/* ------------------------------------------------------------ checks */

/** Is this number well-formed for the document? Uses the same parsers as the typed-in flows. */
export function checkDocNumber(docType: UploadDocType, number: string): { ok: true; normalized: string } | { ok: false; error: string } {
  if (isSellerDocType(docType)) {
    const parsed = parseSellerDocNumber(docType, number);
    return parsed.ok ? { ok: true, normalized: parsed.value.normalized } : { ok: false, error: parsed.error };
  }
  const parsed = parseLegalDocNumber(docType as LegalDocKey, number);
  return parsed.ok ? { ok: true, normalized: parsed.normalized } : { ok: false, error: parsed.error };
}

function addDays(isoDay: string, days: number): string {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface AssessInput {
  expectedType: UploadDocType;
  fields: ExtractedFields;
  /** 0–100 from the OCR engine; null when the text came from a PDF's own text layer. */
  ocrConfidence: number | null;
  textLength: number;
  aadhaarRemoved: boolean;
  /** Owner, legal and shop names given at registration. */
  shopNames: (string | null | undefined)[];
  /** YYYY-MM-DD (India time). */
  today: string;
  expiryWarningDays: number;
  /** Below this name-match score (0–100) the name is flagged. */
  nameMatchMin: number;
  /** Smallest side of the image in pixels; null for PDFs. */
  imageMinSide?: number | null;
}

export function assessExtraction(input: AssessInput): ExtractionFlag[] {
  const { expectedType, fields } = input;
  const label = UPLOAD_DOC_LABELS[expectedType];
  const flags: ExtractionFlag[] = [];

  const unreadable = input.textLength < 25 || (!fields.number && input.ocrConfidence !== null && input.ocrConfidence < 45);
  if (unreadable) {
    flags.push({
      code: "UNREADABLE",
      severity: "block",
      message:
        "We couldn't read this document. Take the photo again in good light, flat on a table, with all four corners in the frame — or upload a clearer file.",
    });
  }
  if (input.imageMinSide != null && input.imageMinSide < 600) {
    flags.push({ code: "LOW_QUALITY", severity: "warn", message: "The picture is small, so some details may be misread. A sharper photo reads better." });
  }
  if (fields.detectedType && fields.detectedType !== expectedType) {
    flags.push({
      code: "WRONG_DOCUMENT",
      severity: fields.number ? "warn" : "block",
      message: `This looks like a ${UPLOAD_DOC_LABELS[fields.detectedType]}, not a ${label}. Please upload the ${label}.`,
    });
  }
  if (!fields.number) {
    if (!unreadable) {
      flags.push({ code: "NUMBER_NOT_FOUND", severity: "warn", message: `We couldn't find the ${label} number. Type it exactly as printed.` });
    }
  } else {
    const checked = checkDocNumber(expectedType, fields.number);
    if (!checked.ok) flags.push({ code: "NUMBER_INVALID", severity: "warn", message: `Check the number we read: ${checked.error}` });
  }
  if (fields.name) {
    const match = bestNameMatch([fields.name], input.shopNames);
    if (input.shopNames.some(Boolean) && match.score < input.nameMatchMin) {
      flags.push({
        code: "NAME_MISMATCH",
        severity: "warn",
        message: `The name on the document (${fields.name}) doesn't match the owner or shop name you registered with. Upload the document in the registered name, or our team will review it.`,
      });
    }
  }
  if (fields.validUntil) {
    if (fields.validUntil < input.today) {
      flags.push({
        code: "EXPIRED",
        severity: "block",
        message: `This ${label} expired on ${fields.validUntil}. Upload the renewed document.`,
      });
    } else if (fields.validUntil <= addDays(input.today, input.expiryWarningDays)) {
      flags.push({ code: "EXPIRING_SOON", severity: "warn", message: `This ${label} expires on ${fields.validUntil}. Renew it soon.` });
    }
  } else if (EXPIRY_REQUIRED.includes(expectedType) && !unreadable) {
    flags.push({ code: "NO_EXPIRY", severity: "warn", message: `We couldn't find the expiry date. Enter the "valid up to" date printed on the ${label}.` });
  }
  if (input.aadhaarRemoved) {
    flags.push({
      code: "AADHAAR_HIDDEN",
      severity: "warn",
      message: "An Aadhaar number on this document was ignored and not stored — GoKesari doesn't collect Aadhaar numbers.",
    });
  }
  return flags;
}

/** Shown when the reader failed or timed out: nothing was read, nothing is blocked, the owner types the details. */
export const NOT_READ_FLAG: ExtractionFlag = {
  code: "NOT_READ",
  severity: "warn",
  message:
    "We couldn't read this document automatically just now. Type the details exactly as printed on it — we check them before anything is approved.",
};

export interface ConfirmedFields {
  number: string;
  name?: string | null;
  address?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}

/**
 * What the seller submits after reviewing: re-checked on the server. Returns
 * the first problem per field; an empty object means it can be submitted.
 */
export function validateConfirmedFields(docType: UploadDocType, fields: ConfirmedFields, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const number = checkDocNumber(docType, fields.number ?? "");
  if (!number.ok) errors.number = number.error;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (fields.validFrom && !iso.test(fields.validFrom)) errors.validFrom = "Enter the date as YYYY-MM-DD.";
  if (fields.validUntil && !iso.test(fields.validUntil)) errors.validUntil = "Enter the date as YYYY-MM-DD.";
  if (!errors.validUntil) {
    if (EXPIRY_REQUIRED.includes(docType) && !fields.validUntil) {
      errors.validUntil = `Enter the expiry ("valid up to") date of the ${UPLOAD_DOC_LABELS[docType]}.`;
    } else if (fields.validUntil && fields.validUntil < today) {
      errors.validUntil = `This ${UPLOAD_DOC_LABELS[docType]} has expired (${fields.validUntil}). Upload the renewed document.`;
    }
  }
  if (fields.name && fields.name.length > 120) errors.name = "The name is too long.";
  if (fields.address && fields.address.length > 300) errors.address = "The address is too long.";
  return errors;
}
