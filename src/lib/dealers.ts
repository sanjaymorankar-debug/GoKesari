/**
 * Dealer programme (docs/dealer-programme): names shared by the server and the
 * screens. No secrets here — client bundles import this file.
 */

import { generatedReferralCodePattern } from "./referral-codes";

export const DEALER_TYPES = ["INDIVIDUAL", "PROPRIETORSHIP", "PARTNERSHIP", "COMPANY"] as const;
export type DealerType = (typeof DEALER_TYPES)[number];

export const DEALER_STATUSES = ["DRAFT", "PENDING", "APPROVED", "SUSPENDED", "REJECTED", "TERMINATED"] as const;
export type DealerStatus = (typeof DEALER_STATUSES)[number];

export const DEALER_DOC_TYPES = ["PAN", "GSTIN", "SHOP_ACT", "ADDRESS_PROOF", "BANK_PROOF", "AGREEMENT"] as const;
export type DealerDocType = (typeof DEALER_DOC_TYPES)[number];

export const DEALER_CODE_KINDS = ["DEALER", "SALESPERSON", "LEGACY"] as const;
export type DealerCodeKind = (typeof DEALER_CODE_KINDS)[number];

export const DEALER_CODE_STATUSES = ["ACTIVE", "SUSPENDED", "REPLACED", "RETIRED"] as const;
export type DealerCodeStatus = (typeof DEALER_CODE_STATUSES)[number];

export const DEALER_BANK_STATUSES = ["NOT_PROVIDED", "PENDING", "VERIFIED", "FAILED"] as const;
export type DealerBankStatus = (typeof DEALER_BANK_STATUSES)[number];

export const DEALER_TYPE_LABELS: Record<DealerType, string> = {
  INDIVIDUAL: "Individual",
  PROPRIETORSHIP: "Proprietorship",
  PARTNERSHIP: "Partnership",
  COMPANY: "Company",
};

export const DEALER_STATUS_LABELS: Record<DealerStatus, string> = {
  DRAFT: "Draft",
  PENDING: "Pending approval",
  APPROVED: "Approved",
  SUSPENDED: "Suspended",
  REJECTED: "Rejected",
  TERMINATED: "Terminated",
};

export const DEALER_DOC_LABELS: Record<DealerDocType, string> = {
  PAN: "PAN card",
  GSTIN: "GST registration certificate",
  SHOP_ACT: "Shop & Establishment registration",
  ADDRESS_PROOF: "Address proof",
  BANK_PROOF: "Cancelled cheque or bank proof",
  AGREEMENT: "Signed dealer agreement",
};

/** The dealer agreement the applicant accepts online; bump when its text changes. */
export const DEALER_AGREEMENT_VERSION = "2026-10-28";

/**
 * A dealer's or employee's code is an ordinary referral code (8 letters and
 * digits, src/lib/referral-codes.ts). Codes issued before 30 Oct 2026
 * (GKS-MH-PUN-7K4Q9X, GKS-FE-8P2M5N) keep working.
 */
export function dealerCodePattern(): RegExp {
  return generatedReferralCodePattern();
}

/** An employee's (salesperson's) code: the same 8-character form. */
export function salespersonCodePattern(): RegExp {
  return generatedReferralCodePattern();
}
