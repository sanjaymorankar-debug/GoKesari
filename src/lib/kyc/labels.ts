/**
 * Plain-language status and reason text for seller verification screens.
 * Client-safe; the reason codes come from seller_verifications.last_error_code.
 */
import type { SellerVerificationStatus } from "./doc-formats";

export const STATUS_LABELS: Record<SellerVerificationStatus, string> = {
  NOT_SUBMITTED: "Not submitted",
  PENDING: "Checking",
  VERIFIED: "Verified",
  FAILED: "Not verified",
  MANUAL_REVIEW: "Under review",
  EXPIRED: "Expired",
};

export const STATUS_TONES: Record<SellerVerificationStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  NOT_SUBMITTED: "neutral",
  PENDING: "info",
  VERIFIED: "success",
  FAILED: "danger",
  MANUAL_REVIEW: "warning",
  EXPIRED: "danger",
};

/** Seller-facing explanation of why a document isn't verified (yet). */
export const REASON_TEXT: Record<string, string> = {
  not_found_at_source: "This number wasn't found in the government record. Check it and submit again.",
  document_expired: "This document has expired. Submit the renewed one.",
  document_cancelled: "The government record shows this document as cancelled.",
  document_inactive: "The government record shows this document as inactive.",
  document_suspended: "The government record shows this document as suspended.",
  name_mismatch: "The name on the record doesn't clearly match your name or business name. Our team will check it.",
  name_not_returned: "The record didn't include a name. Our team will check it.",
  gstin_pan_mismatch: "The PAN inside this GSTIN is different from the PAN you submitted. Our team will check it.",
  state_mismatch: "This GSTIN is registered in a different state from your shop. Our team will check it.",
  address_mismatch: "The address on the record is at a different PIN code from your shop. Our team will check it.",
  expiry_not_returned: "The record didn't include an expiry date. Our team will check it.",
  consistency_below_threshold: "Your documents don't fully agree with each other. Our team will check them.",
  vendor_unsupported: "This document can't be checked online for your state. Upload a copy of the certificate.",
  certificate_review: "Our team will compare your uploaded certificate with the number you entered.",
  gst_declaration_review: "Our team will review your GST declaration.",
  source_status_unknown: "The record's status wasn't clear. Our team will check it.",
  rejected_by_admin: "Our team couldn't accept this document.",
  vendor_timeout: "The government service is slow right now. We'll keep trying automatically.",
  vendor_network: "We couldn't reach the verification service. We'll keep trying automatically.",
  vendor_rate_limited: "The verification service is busy. We'll keep trying automatically.",
  vendor_vendor_error: "The verification service had a problem. We'll keep trying automatically.",
  vendor_source_down: "The government service is down. We'll keep trying automatically.",
};

export function reasonText(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("config_")) return "Verification is paused on our side. We'll check this as soon as it's back.";
  return REASON_TEXT[code] ?? null;
}
