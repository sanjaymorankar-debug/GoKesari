/**
 * Delivery partner KYC (gig worker flow, feature 2): consent wording, masks
 * and labels shared by the KYC page and the service. Client-safe.
 *
 * Consent must be specific, informed and recorded (DPDP Act 2023): the text
 * is shown next to the checkbox and its version is stored with each check.
 * Change the text → bump the version. Needs a lawyer's review before
 * production use, like the seller wording (docs/seller-verification/COMPLIANCE.md).
 */
export const RIDER_KYC_CONSENT_VERSION = "2026-10-31-digilocker";

/**
 * Nov 2026: Aadhaar is shared from DigiLocker (Sandbox.co.in stopped the OTP
 * check, offline e-KYC). Partners who consented to the earlier wording
 * ("2026-10-31") keep that record on their existing checks.
 */
export const RIDER_KYC_CONSENT_TEXT =
  "I agree that GoKesari may send my PAN to its verification partner, which checks it against the Income Tax " +
  "Department's records, and that I will share my Aadhaar from my DigiLocker account (I sign in to DigiLocker with " +
  "an OTP to my Aadhaar-linked mobile and approve the sharing there), only to verify my identity as a GoKesari " +
  "delivery partner. From the Aadhaar, GoKesari keeps only my name and the last four digits; it never stores my " +
  "Aadhaar number, photo, date of birth or address, and shows only masked numbers. I can ask for this data to be " +
  "deleted when I stop delivering, subject to the legal retention period.";

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
  digilocker_started: "Finish in DigiLocker: sign in with the OTP sent to your Aadhaar-linked mobile and allow GoKesari to see your Aadhaar.",
  digilocker_denied: "DigiLocker did not share your Aadhaar (consent was declined or not finished). Start again to retry.",
  digilocker_expired: "The DigiLocker link expired before it was finished. Start again.",
  digilocker_no_aadhaar: "DigiLocker did not share an Aadhaar. On DigiLocker's consent screen, allow the Aadhaar card, then try again.",
  digilocker_unreadable: "We could not read the Aadhaar from DigiLocker. Our team will check it.",
  digilocker_resent: "Our team sent you a new DigiLocker link. Open it to finish.",
  method_changed: "Aadhaar is now verified through DigiLocker. Start again with DigiLocker.",
};

export function riderKycReason(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("vendor_") || code.startsWith("config_")) {
    return "The verification service is not answering right now. We'll check again, or you can retry later.";
  }
  return RIDER_KYC_REASONS[code] ?? null;
}

/** How an Aadhaar check was done, for the admin screen. */
export type RiderAadhaarMethod = "digilocker" | "okyc_legacy" | "manual";
export const RIDER_AADHAAR_METHOD_LABELS: Record<RiderAadhaarMethod, string> = {
  digilocker: "DigiLocker",
  okyc_legacy: "Legacy OTP",
  manual: "Manual",
};

/**
 * Why a check is Pending or Failed, for an admin: the partner's reason plus
 * what to do about it. Vendor and configuration codes name the setting.
 */
export function riderKycAdminReason(code: string | null | undefined, provider: string): string | null {
  if (!code) return null;
  if (code === "vendor_unsupported" && provider === "gridlines") {
    return "Gridlines has no DigiLocker or Aadhaar check, so this waits for you: compare the partner's Aadhaar card and decide by hand, or switch KYC_PROVIDER to sandboxco.";
  }
  if (code === "vendor_unsupported") return "The KYC provider can't check this online. Decide by hand.";
  if (code === "config_environment_mismatch") {
    return "KYC settings refused on this site (KYC_PROVIDER / KYC_ENV / keys don't match the host). Fix the settings, then use Resend link.";
  }
  if (code === "config_auth_failed") return "The KYC provider refused our keys (or DigiLocker is not enabled on the Sandbox account). Fix, then Resend link.";
  if (code.startsWith("config_")) return `KYC provider set-up problem (${code}). Fix the settings, then Resend link.`;
  if (code.startsWith("vendor_")) return `KYC provider not answering (${code}). The check retries when the partner opens the page; or Resend link.`;
  return riderKycReason(code);
}
