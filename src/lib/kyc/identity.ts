/**
 * One-time identity verification of customers and shop owners
 * (docs/identity-verification-2026-11): the consent wording, retention
 * statement, labels and reasons shared by the page and the service.
 * Client-safe.
 *
 * Consent must be specific, informed, voluntary and recorded (DPDP Act 2023;
 * Aadhaar use by a private company only voluntarily and through a licensed
 * KYC provider). Change any text here → bump IDENTITY_CONSENT_VERSION.
 * LEGAL REVIEW PENDING before the flag is turned on at gokesari.com.
 */
import type { IdentityVerificationMethod, IdentityVerificationStatus } from "@/server/db/schema";

export const IDENTITY_CONSENT_VERSION = "2026-11-24-v1";

/** How long what we keep is kept. One place, shown on the consent screen and in the docs. */
export const IDENTITY_RETENTION_TEXT =
  "We keep it while your GoKesari account is open. When you close the account we delete it, except where a law " +
  "requires us to keep a record for longer — then only for that period.";

export const IDENTITY_PURPOSE_TEXT =
  "To keep GoKesari safe for buyers and sellers, we confirm once that you are a real person and that the name on " +
  "your account is yours. Customers do this before their first order; shop owners before their shop takes orders.";

/** What is kept from the check. */
export const IDENTITY_STORED_ITEMS = [
  "The last four characters of the document number only (for example XXXX XXXX 1234)",
  "Your name as it appears on the document",
  "Which method you used (Aadhaar through DigiLocker, or PAN)",
  "The verification provider's reference number for this check",
  "When you gave consent and when the check was done",
] as const;

/** What is never kept. */
export const IDENTITY_NOT_STORED_ITEMS = [
  "Your full Aadhaar number or full PAN",
  "Any OTP",
  "The Aadhaar document or e-KYC file itself",
  "Your photo, date of birth or address from the document",
] as const;

export const IDENTITY_VOLUNTARY_TEXT =
  "Using Aadhaar is voluntary. You can verify with your PAN instead — you will not lose any service by choosing it. " +
  "Aadhaar is checked through DigiLocker by our licensed verification partner; GoKesari never sees or stores the number.";

/** The sentence next to the (unticked) checkbox. */
export const IDENTITY_CONSENT_TEXT =
  "I agree that GoKesari may verify my identity once through its licensed verification partner, using the method I " +
  "choose, for the purpose above. I understand what is kept and what is not, how long it is kept, and that using " +
  "Aadhaar is voluntary.";

export const IDENTITY_METHOD_LABELS: Record<IdentityVerificationMethod, string> = {
  AADHAAR_DIGILOCKER: "Aadhaar through DigiLocker",
  PAN: "PAN",
  DRIVING_LICENCE: "Driving licence",
  VOTER_ID: "Voter ID",
};

export const IDENTITY_STATUS_LABELS: Record<IdentityVerificationStatus, string> = {
  PENDING: "In progress",
  VERIFIED: "Verified",
  NAME_MISMATCH_REVIEW: "Being reviewed",
  REJECTED: "Rejected",
  FAILED: "Not verified",
};

/** Why a check is not Verified, for the person. */
const REASONS: Record<string, string> = {
  digilocker_started: "Finish in DigiLocker: sign in with the OTP sent to your Aadhaar-linked mobile and allow GoKesari to see your Aadhaar.",
  digilocker_denied: "Sharing was declined in DigiLocker. Try again, or verify with your PAN instead.",
  digilocker_expired: "The DigiLocker link expired before you finished. Start again.",
  digilocker_no_aadhaar: "No Aadhaar was shared from DigiLocker. Try again, or verify with your PAN instead.",
  digilocker_unreadable: "We could not read the shared document. Our team will check it.",
  name_mismatch: "The name on the document doesn't match the name on your account closely enough. Our team will check it.",
  no_account_name: "Your account has no name to compare with. Our team will check it.",
  duplicate_identity: "This identity is already verified on another GoKesari account. Our team will check it.",
  manual_review: "Our team is checking this by hand.",
  not_found_at_source: "The government record has no such number. Check it and try again.",
  document_inactive: "The record says this PAN is not active.",
  vendor_unsupported: "This check can't be done online right now. Try the other method, or try again later.",
  superseded: "Replaced by a newer attempt.",
};

export function identityReason(code: string | null | undefined): string | null {
  if (!code) return null;
  if (REASONS[code]) return REASONS[code];
  if (code.startsWith("vendor_") || code.startsWith("config_")) return "The verification service is not answering right now. Try again in a few minutes.";
  if (code.startsWith("document_")) return "The record says this document is not valid.";
  return null;
}

/** The checkout page sends the customer here and back (`next`). */
export const VERIFY_IDENTITY_PATH = "/profile/verify-identity";
