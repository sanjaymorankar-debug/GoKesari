/**
 * Rider identity, bank and vehicle details: the format rules shared by the
 * rider application (delivery-partners.ts registerDeliveryPartner) and the
 * rider's own edits (rider-profile.ts — the vehicle at once, identity and bank
 * by change request), so both paths accept, refuse and store the same thing
 * (TC-FLD-091, TC-FLD-092, TC-FLD-093, TC-DEL-030). Client-safe.
 *
 * Builds on the checks sellers and bank accounts already use: the PAN parser
 * of shop registration (lib/shop-identity.ts), the account-number and IFSC
 * checks of the bank-account form (lib/bank-accounts.ts) and the Aadhaar shape
 * and Verhoeff check digit (lib/kyc/doc-formats.ts).
 */
import { checkAccountNumber, checkIfsc } from "@/lib/bank-accounts";
import { looksLikeAadhaar } from "@/lib/kyc/doc-formats";
import { parsePanNumber, type ParseResult } from "@/lib/shop-identity";

export type RiderDetailField =
  | "panNumber"
  | "governmentIdNumber"
  | "bankAccountNumber"
  | "bankIfsc"
  | "vehicleRegistrationNumber";

export const RIDER_DETAIL_MESSAGES = {
  ifsc: "IFSC must be 11 characters, e.g. SBIN0001234.",
  aadhaar: "An Aadhaar number is 12 digits (spaces allowed) and does not start with 0 or 1. Check the number on the card.",
  vehicleCharacters: "Use letters, digits, spaces and hyphens only in the registration number, e.g. MH12 AB 1234.",
  vehicleFormat: "Enter the registration number as on the RC, e.g. MH12 AB 1234 (or 22 BH 1234 AA).",
  vehicleLength: "The registration number is too long.",
} as const;

/** "Aadhaar", "Aadhar card", "adhaar", "UID": the free-text ID type the application form takes. */
export function isAadhaarIdType(type: string | null | undefined): boolean {
  const letters = (type ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return /^(aa?dh?aa?r|uid)/.test(letters);
}

/** PAN, upper-cased: AAAAA9999A. */
export function checkRiderPan(raw: string): ParseResult<string> {
  return parsePanNumber(raw.trim());
}

/** A government ID number: an Aadhaar is 12 digits with a valid check digit (stored as digits); other IDs as typed. */
export function checkRiderGovernmentId(type: string | null | undefined, raw: string): ParseResult<string> {
  const value = raw.trim();
  if (!isAadhaarIdType(type)) return { ok: true, value };
  if (!/^[\d\s]+$/.test(value) || !looksLikeAadhaar(value)) return { ok: false, error: RIDER_DETAIL_MESSAGES.aadhaar };
  return { ok: true, value: value.replace(/\D/g, "") };
}

/** 9 to 18 digits (spaces and hyphens dropped), never letters. */
export function checkRiderAccountNumber(raw: string): ParseResult<string> {
  const checked = checkAccountNumber(raw.trim());
  return checked.ok ? { ok: true, value: checked.value } : { ok: false, error: checked.error };
}

/** 4 letters, 0, then 6 letters or digits; lower case is upper-cased. */
export function checkRiderIfsc(raw: string): ParseResult<string> {
  const checked = checkIfsc(raw);
  return checked.ok ? { ok: true, value: checked.value } : { ok: false, error: RIDER_DETAIL_MESSAGES.ifsc };
}

/* Indian registration marks, checked without their spaces and hyphens:
 *   state + RTO + series + number   MH12AB1234, DL3CAB1234, MH121234
 *   Bharat series                   22BH1234AA */
const STATE_SERIES_MARK = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;
const BHARAT_SERIES_MARK = /^\d{2}BH\d{4}[A-Z]{1,2}$/;

/**
 * A vehicle registration number, normalised the same way everywhere: trimmed,
 * upper-cased, inner runs of spaces collapsed ("  mh12 ab   1234 " →
 * "MH12 AB 1234"). Letters, digits, spaces and hyphens only, shaped like an
 * Indian registration mark (TC-FLD-091, TC-DEL-030).
 */
export function normaliseVehicleRegistration(raw: string): ParseResult<string> {
  const value = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (value.length > 30) return { ok: false, error: RIDER_DETAIL_MESSAGES.vehicleLength };
  if (!/^[A-Z0-9 -]+$/.test(value)) return { ok: false, error: RIDER_DETAIL_MESSAGES.vehicleCharacters };
  const compact = value.replace(/[\s-]/g, "");
  if (!STATE_SERIES_MARK.test(compact) && !BHARAT_SERIES_MARK.test(compact)) {
    return { ok: false, error: RIDER_DETAIL_MESSAGES.vehicleFormat };
  }
  return { ok: true, value };
}

export interface RiderDetailsInput {
  panNumber?: string | null;
  /** Decides whether the ID number is checked as an Aadhaar. Not itself checked. */
  governmentIdType?: string | null;
  governmentIdNumber?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  vehicleRegistrationNumber?: string | null;
}

export type RiderDetailsCheck =
  | { ok: true; values: Partial<Record<RiderDetailField, string | null>> }
  | { ok: false; message: string; fields: Partial<Record<RiderDetailField, string>> };

const CHECKS: Record<RiderDetailField, (raw: string, input: RiderDetailsInput) => ParseResult<string>> = {
  panNumber: (raw) => checkRiderPan(raw),
  governmentIdNumber: (raw, input) => checkRiderGovernmentId(input.governmentIdType, raw),
  bankAccountNumber: (raw) => checkRiderAccountNumber(raw),
  bankIfsc: (raw) => checkRiderIfsc(raw),
  vehicleRegistrationNumber: (raw) => normaliseVehicleRegistration(raw),
};

/**
 * Checks and normalises whichever of the fields the input carries. A blank
 * value is "not given" (null) — every one of these is optional — and a field
 * the input leaves out stays out of `values`. On failure `fields` names each
 * bad field with its message, for the form to show on the field.
 */
export function checkRiderDetails(input: RiderDetailsInput): RiderDetailsCheck {
  const values: Partial<Record<RiderDetailField, string | null>> = {};
  const fields: Partial<Record<RiderDetailField, string>> = {};
  for (const field of Object.keys(CHECKS) as RiderDetailField[]) {
    const raw = input[field];
    if (raw === undefined) continue;
    if (raw === null || !raw.trim()) {
      values[field] = null;
      continue;
    }
    const checked = CHECKS[field](raw, input);
    if (checked.ok) values[field] = checked.value;
    else fields[field] = checked.error;
  }
  const errors = Object.values(fields);
  return errors.length > 0 ? { ok: false, message: errors[0], fields } : { ok: true, values };
}
