/**
 * Delivery partner KYC (gig worker flow, feature 2): consent wording, masks
 * and labels shared by the KYC page and the service. Client-safe.
 *
 * Consent must be specific, informed and recorded (DPDP Act 2023): the text
 * is shown next to the checkbox and its version is stored with each check.
 * Change the text → bump the version. Needs a lawyer's review before
 * production use, like the seller wording (docs/seller-verification/COMPLIANCE.md).
 */
export const RIDER_KYC_CONSENT_VERSION = "2026-10-31";

export const RIDER_KYC_CONSENT_TEXT =
  "I agree that GoKesari may send my PAN and my Aadhaar number to its verification partner, which checks them " +
  "against the Income Tax Department and UIDAI records (for Aadhaar, by an OTP sent to my Aadhaar-linked mobile), " +
  "only to verify my identity as a GoKesari delivery partner. GoKesari keeps my PAN encrypted, never stores my " +
  "Aadhaar number (only a masked form), and shows only masked numbers. I can ask for this data to be deleted when " +
  "I stop delivering, subject to the legal retention period.";

export const RIDER_KYC_STATUSES = ["PENDING", "VERIFIED", "FAILED"] as const;
export type RiderKycStatus = (typeof RIDER_KYC_STATUSES)[number];
export const RIDER_KYC_STATUS_LABELS: Record<RiderKycStatus, string> = {
  PENDING: "Pending",
  VERIFIED: "Verified",
  FAILED: "Failed",
};

/** "XXXX XXXX 1234". */
export function maskAadhaar(digits: string): string {
  return `XXXX XXXX ${digits.slice(-4)}`;
}

/** "XXXXX1234X": the four digits and the check letter stay, like the PAN card's own masked print. */
export function maskRiderPan(pan: string): string {
  return `XXXXX${pan.slice(5)}`;
}

/** 12 digits after dropping spaces; the Verhoeff check is lib/kyc/doc-formats.ts looksLikeAadhaar. */
export function normaliseAadhaarInput(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** Why a check is Pending or Failed, for the partner. */
export const RIDER_KYC_REASONS: Record<string, string> = {
  not_found_at_source: "The government record has no such number. Check it and try again.",
  document_inactive: "The record says this PAN is not active.",
  name_mismatch: "The name on the record doesn't match your registered name closely enough. Our team will check it.",
  vendor_unsupported: "This check can't be done online right now. Our team will verify it by hand.",
  otp_sent: "We sent an OTP to the mobile number linked to your Aadhaar. Enter it to finish.",
  otp_invalid: "That OTP didn't match. Try again, or ask for a new one.",
  otp_expired: "The OTP has expired. Ask for a new one.",
  otp_locked: "Too many wrong OTPs. Ask for a new one.",
  already_used: "This number is already verified for another delivery partner. Contact support if it is yours.",
  manual_review: "Our team is checking this by hand.",
};

export function riderKycReason(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("vendor_") || code.startsWith("config_")) {
    return "The verification service is not answering right now. We'll check again, or you can retry later.";
  }
  return RIDER_KYC_REASONS[code] ?? null;
}
