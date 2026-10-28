/**
 * Mandatory legal documents by shop category (docs/four-features-2026-10,
 * feature 2) — client-safe: labels, what each document needs, and the format
 * checks the form and the server share.
 */
import { parseSellerFssai } from "./kyc/doc-formats";

export const LEGAL_DOC_KEYS = [
  "FSSAI",
  "DRUG_LICENCE",
  "MEDICAL_REGISTRATION",
  "TRADE_LICENCE",
  "LEGAL_METROLOGY",
  "FIRE_NOC",
  "AGRI_INPUT_LICENCE",
  "OTHER_LICENCE",
] as const;
export type LegalDocKey = (typeof LEGAL_DOC_KEYS)[number];

/**
 * Licences a shop may hold besides the three the category rules ask for
 * (docs/document-upload-2026-10, "More licences"). Optional unless the
 * legalDocuments rule's otherRequirements names them for a shop type or
 * category; none has a national lookup, so operations review the copy.
 */
export const ADDITIONAL_LICENCE_KEYS = ["TRADE_LICENCE", "LEGAL_METROLOGY", "FIRE_NOC", "AGRI_INPUT_LICENCE", "OTHER_LICENCE"] as const;
export type AdditionalLicenceKey = (typeof ADDITIONAL_LICENCE_KEYS)[number];

export function isAdditionalLicence(docType: string): docType is AdditionalLicenceKey {
  return (ADDITIONAL_LICENCE_KEYS as readonly string[]).includes(docType);
}

export const LEGAL_DOC_LABELS: Record<LegalDocKey, string> = {
  FSSAI: "FSSAI licence",
  DRUG_LICENCE: "Drug licence",
  MEDICAL_REGISTRATION: "Medical registration",
  TRADE_LICENCE: "Trade licence (municipal)",
  LEGAL_METROLOGY: "Weights & measures (legal metrology) certificate",
  FIRE_NOC: "Fire NOC",
  AGRI_INPUT_LICENCE: "Seeds / fertiliser / pesticide licence",
  OTHER_LICENCE: "Other licence",
};

export const LEGAL_DOC_WHO: Record<LegalDocKey, string> = {
  FSSAI: "Shops that sell food",
  DRUG_LICENCE: "Medical shops and pharmacies",
  MEDICAL_REGISTRATION: "Doctors and clinics",
  TRADE_LICENCE: "Shops your municipal corporation or council licenses",
  LEGAL_METROLOGY: "Shops that weigh or measure what they sell",
  FIRE_NOC: "Restaurants, large stores and shops that store fuel or gas",
  AGRI_INPUT_LICENCE: "Shops that sell seeds, fertilisers or pesticides",
  OTHER_LICENCE: "Any other licence or registration your shop holds",
};

/**
 * Which extra field each document has besides the number and the uploaded copy.
 * expiry: the expiry date is required. council: the issuing council is required
 * (medical registration). authority: the issuing authority may be given (optional).
 * licenceName: the owner names the licence (Other licence).
 */
export const LEGAL_DOC_NEEDS: Record<
  LegalDocKey,
  { expiry: boolean; council: boolean; authority?: boolean; licenceName?: boolean; numberHint: string }
> = {
  FSSAI: { expiry: true, council: false, numberHint: "14 digits, as printed on the licence" },
  DRUG_LICENCE: { expiry: true, council: false, numberHint: "As printed on the licence, e.g. MH-PZ1-123456 or 20B/12345" },
  MEDICAL_REGISTRATION: { expiry: false, council: true, numberHint: "Your registration number with the council" },
  TRADE_LICENCE: { expiry: false, council: false, authority: true, numberHint: "Licence number as printed, e.g. PMC/TL/2026/012345" },
  LEGAL_METROLOGY: { expiry: false, council: false, authority: true, numberHint: "Certificate or licence number as printed" },
  FIRE_NOC: { expiry: false, council: false, authority: true, numberHint: "NOC number as printed" },
  AGRI_INPUT_LICENCE: { expiry: false, council: false, authority: true, numberHint: "Licence number as printed" },
  OTHER_LICENCE: { expiry: false, council: false, authority: true, licenceName: true, numberHint: "Number as printed on the licence" },
};

/** The licence name an owner typed for an Other licence: trimmed, 3–80 characters. */
export function checkLicenceName(raw: string | null | undefined): { ok: true; name: string; key: string } | { ok: false; error: string } {
  const name = (raw ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 3 || name.length > 80) return { ok: false, error: "Enter the name of the licence (3–80 characters), e.g. Explosives licence." };
  if (!/^[A-Za-z0-9][A-Za-z0-9 &/().,'-]*$/.test(name)) return { ok: false, error: "Use only letters, digits, spaces and & / ( ) . , ' -" };
  return { ok: true, name, key: name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") };
}

/** Councils that register doctors in India; "Other" lets the owner type one. */
export const MEDICAL_COUNCILS = [
  "National Medical Commission (NMC)",
  "Maharashtra Medical Council",
  "Karnataka Medical Council",
  "Delhi Medical Council",
  "Tamil Nadu Medical Council",
  "Gujarat Medical Council",
  "Telangana State Medical Council",
  "Andhra Pradesh Medical Council",
  "West Bengal Medical Council",
  "Kerala State Medical Councils",
  "Uttar Pradesh Medical Council",
  "Madhya Pradesh Medical Council",
  "Rajasthan Medical Council",
  "Punjab Medical Council",
  "Dental Council of India / State Dental Council",
  "Maharashtra Council of Homoeopathy",
  "Maharashtra Council of Indian Medicine",
  "National Commission for Homoeopathy",
  "National Commission for Indian System of Medicine",
] as const;

export type ParsedLegalNumber = { ok: true; normalized: string; last4: string } | { ok: false; error: string };

/** Format check per document (FSSAI is exactly 14 digits; the others have no single national format). */
export function parseLegalDocNumber(docType: LegalDocKey, raw: string): ParsedLegalNumber {
  const value = raw.trim();
  if (docType === "FSSAI") {
    const parsed = parseSellerFssai(value);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, normalized: parsed.value.normalized, last4: parsed.value.normalized.slice(-4) };
  }
  const compact = value.toUpperCase().replace(/\s+/g, " ");
  if (compact.length < 4 || compact.length > 40) {
    return { ok: false, error: "Enter the number exactly as printed (4–40 characters)." };
  }
  if (!/^[A-Z0-9][A-Z0-9 /.\-()]*$/.test(compact)) {
    return { ok: false, error: "Use only letters, digits, spaces and / - . ( )." };
  }
  if ((compact.match(/\d/g) ?? []).length < 3) {
    return { ok: false, error: "A licence or registration number has at least 3 digits." };
  }
  const alnum = compact.replace(/[^A-Z0-9]/g, "");
  return { ok: true, normalized: compact, last4: alnum.slice(-4) };
}

/** "YYYY-MM-DD", a real date, today or later (an expired licence is refused). */
export function checkExpiryDate(raw: string | null | undefined, today: string): { ok: true; date: string } | { ok: false; error: string } {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, error: "Enter the expiry date shown on the licence." };
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return { ok: false, error: "That is not a valid date." };
  }
  if (raw < today) return { ok: false, error: "This licence has already expired — upload the renewed licence." };
  if (Number(raw.slice(0, 4)) > Number(today.slice(0, 4)) + 30) return { ok: false, error: "Check the expiry date — it is too far ahead." };
  return { ok: true, date: raw };
}

export function maskLegalNumber(last4: string | null): string | null {
  return last4 ? `••••${last4}` : null;
}

/** What the owner and the reviewer see for one required document. */
export type LegalDocState =
  | "MISSING"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED";

export const LEGAL_DOC_STATE_LABELS: Record<LegalDocState, string> = {
  MISSING: "Not uploaded",
  SUBMITTED: "Submitted — under review",
  APPROVED: "Approved",
  REJECTED: "Rejected — upload again",
  EXPIRED: "Expired — upload the renewed licence",
};
