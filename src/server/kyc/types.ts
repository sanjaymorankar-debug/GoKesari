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

export type KycProviderId = "mock" | "gridlines" | "idfy";

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
