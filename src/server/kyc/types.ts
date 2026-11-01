/**
 * Provider-agnostic seller document verification (seller verification,
 * Part 2.1). The onboarding flows talk only to verifyDocument() in ./index.ts;
 * each vendor is one adapter implementing KycAdapter, so swapping Gridlines
 * for IDfy (or adding a fallback) never touches a flow.
 *
 * Adapters report what the government source said. Deciding what that means
 * for the shop (name match, cross-document checks, auto-approve or review)
 * is the service's job, not the adapter's.
 */
import type { SellerDocType } from "@/lib/kyc/doc-formats";

export type { SellerDocType };

export type KycProviderId = "mock" | "gridlines" | "sandboxco" | "idfy";

/** Extra inputs some lookups need. All optional; adapters ignore what they don't use. */
export interface VerifyExtraFields {
  /** Name to match against the record, where the vendor matches server-side. */
  nameToMatch?: string;
  /** Two-letter state code (e.g. "MH") — Shop Act lookups are state-specific. */
  stateCode?: string;
  /** City, for Shop Act lookups some states key by municipality. */
  city?: string;
}

export interface VerifyRequest {
  docType: SellerDocType;
  /** Normalised number (see lib/kyc/doc-formats.ts). Never log this. */
  number: string;
  extra: VerifyExtraFields;
  /** Sent to the vendor where supported, so a retried call is not billed twice. */
  idempotencyKey: string;
}

/** What the government source says about the document itself. */
export type SourceDocStatus = "active" | "inactive" | "cancelled" | "suspended" | "expired" | "unknown";

/**
 * Normalised record — the same fields whichever vendor answered. Only these
 * are stored (in seller_verifications.details); the vendor's raw response is
 * never persisted.
 */
export interface SourceRecord {
  docStatus: SourceDocStatus;
  /** Name on the record: PAN holder, GST legal name, Udyam enterprise, FSSAI licensee, establishment. */
  name: string | null;
  /** GSTIN trade name. */
  tradeName?: string | null;
  /** Udyam owner / FSSAI or Shop Act proprietor, where returned. */
  ownerName?: string | null;
  /** PAN holder type (P, C, F …) or GST constitution, as returned. */
  entityType?: string | null;
  /** GSTIN: PAN as returned by the source (also derivable from the GSTIN itself). */
  linkedPan?: string | null;
  stateCode?: string | null;
  pincode?: string | null;
  /** Free-text address, for display to a reviewer only. */
  address?: string | null;
  /** FSSAI: BASIC / STATE / CENTRAL. Udyam: MICRO / SMALL / MEDIUM. */
  category?: string | null;
  /** ISO date (YYYY-MM-DD) the document stops being valid, if it expires. */
  validUntil?: string | null;
  /** Vendor-side name-match score 0–100, where the vendor computes one. */
  vendorNameMatchScore?: number | null;
}

export type ProviderOutcome =
  /** The source returned a record for this number. */
  | { kind: "found"; record: SourceRecord; providerRef: string | null }
  /** The source has no such number. */
  | { kind: "not_found"; providerRef: string | null }
  /** This vendor cannot check this document (or this state) — route to manual review. */
  | { kind: "unsupported"; reason: string };

export interface KycAdapter {
  readonly id: KycProviderId;
  verify(request: VerifyRequest): Promise<ProviderOutcome>;
  /**
   * Gig worker flow, legacy: Aadhaar check by OTP to the Aadhaar-linked mobile (offline e-KYC).
   * Sandbox.co.in stopped it; reachable only with rule riderVerification.aadhaarMethod "okyc_legacy".
   */
  readonly aadhaar?: AadhaarOtpAdapter;
  /** Gig worker flow: Aadhaar shared by the rider from DigiLocker. Absent = this vendor can't. */
  readonly digilocker?: DigilockerAdapter;
}

/**
 * Gig worker flow: Aadhaar through DigiLocker (Sandbox.co.in DigiLocker API,
 * developer.sandbox.co.in/api-reference/kyc/digilocker). The rider signs in to
 * DigiLocker with an Aadhaar OTP there and consents to share the Aadhaar; we
 * then read the name, the last four digits and a stable DigiLocker account id.
 * Never the full number, photo, date of birth, address or the file itself.
 */
export type DigilockerSessionStatus = "created" | "succeeded" | "failed" | "expired";

export interface DigilockerStartRequest {
  /** Our https page DigiLocker sends the rider back to, consent given or not. */
  redirectUrl: string;
  /** Unix ms; at least an hour ahead (Sandbox refuses less). */
  consentExpiryMs: number;
}

export interface DigilockerSession {
  sessionId: string;
  /** The DigiLocker page the rider opens. */
  authorizationUrl: string;
  providerRef: string | null;
}

export interface DigilockerSessionState {
  status: DigilockerSessionStatus;
  /** Document types the rider consented to; only on "succeeded". */
  documentsConsented: string[];
  providerRef: string | null;
}

export type DigilockerAadhaarOutcome =
  | {
      kind: "found";
      /** Name on the Aadhaar. */
      name: string | null;
      /** Last four digits of the Aadhaar number, when the document shows them. */
      last4: string | null;
      /** DigiLocker's own id for the account — the same person on another partner finds it. */
      holderId: string | null;
      providerRef: string | null;
    }
  /** The rider did not consent to the Aadhaar, or DigiLocker holds none for them. */
  | { kind: "not_shared"; reason: "no_consent" | "not_in_digilocker"; providerRef: string | null }
  /** The session can't be used any more (expired, or consent never completed). */
  | { kind: "session_unusable"; providerRef: string | null };

export interface DigilockerAdapter {
  startSession(request: DigilockerStartRequest, idempotencyKey: string): Promise<DigilockerSession>;
  /** Null when the vendor has no such session. */
  sessionStatus(sessionId: string): Promise<DigilockerSessionState | null>;
  fetchAadhaar(sessionId: string): Promise<DigilockerAadhaarOutcome>;
}

/**
 * Gig worker flow (feature 2): Aadhaar offline e-KYC by OTP. The number goes
 * to the vendor once, to send the OTP; GoKesari never stores it. Only the name
 * on the record comes back into the app — never the photo, address or date of
 * birth the vendor may return.
 */
export type AadhaarOtpRequestOutcome =
  | { kind: "sent"; referenceId: string; providerRef: string | null }
  /** No such Aadhaar, or no mobile linked to it. */
  | { kind: "not_found"; providerRef: string | null }
  | { kind: "unsupported"; reason: string };

export type AadhaarOtpVerifyOutcome =
  | { kind: "verified"; name: string | null; providerRef: string | null }
  | { kind: "invalid_otp" }
  | { kind: "expired" }
  | { kind: "unsupported"; reason: string };

export interface AadhaarOtpAdapter {
  requestOtp(aadhaarNumber: string, idempotencyKey: string): Promise<AadhaarOtpRequestOutcome>;
  verifyOtp(referenceId: string, otp: string, idempotencyKey: string): Promise<AadhaarOtpVerifyOutcome>;
}

/**
 * The vendor (or the government source behind it) is down, slow or
 * rate-limiting us. Retryable: the document goes to PENDING and is checked
 * again later rather than being failed for the seller.
 */
export class KycUnavailableError extends Error {
  constructor(
    readonly code: "timeout" | "network" | "rate_limited" | "vendor_error" | "source_down",
    message: string,
  ) {
    super(message);
    this.name = "KycUnavailableError";
  }
}

/**
 * Our request or configuration is wrong (bad key, IP not whitelisted,
 * unexpected response shape). Retrying won't help; an admin needs to look.
 */
export class KycConfigError extends Error {
  constructor(
    readonly code: "not_configured" | "auth_failed" | "bad_request" | "unexpected_response" | "environment_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "KycConfigError";
  }
}
