/**
 * The one entry point the onboarding flows use:
 *
 *   verifyDocument(docType, number, extraFields)
 *     -> { status, matchedName, rawRef, validUntil, providerId, record, errorCode }
 *
 * It picks the configured adapter (KYC_PROVIDER), enforces the
 * sandbox/production pairing (kycConfigProblem in lib/env.ts), and turns the
 * vendor's answer — or its failure — into a SellerVerificationStatus. It
 * never throws for a vendor problem: a down or misconfigured vendor yields
 * PENDING with an errorCode, so a seller is never failed for our outage.
 *
 * Status here reflects the document alone. Name matching and cross-document
 * checks (Part 3) may move a VERIFIED result to MANUAL_REVIEW.
 */
import type { SellerDocType, SellerVerificationStatus } from "@/lib/kyc/doc-formats";
import { getEnv, kycConfigProblem } from "@/lib/env";

import { createGridlinesAdapter, GRIDLINES_BASE_URL } from "./adapters/gridlines";
import { createMockAdapter } from "./adapters/mock";
import type { KycHttpOptions } from "./http";
import {
  KycConfigError,
  KycUnavailableError,
  type KycAdapter,
  type KycProviderId,
  type ProviderOutcome,
  type SourceRecord,
  type VerifyExtraFields,
} from "./types";

export * from "./types";

export interface VerifyDocumentResult {
  status: SellerVerificationStatus;
  /** Name on the government record, if one was returned. */
  matchedName: string | null;
  /** Vendor's request/reference id — for support tickets and audit, never the raw response. */
  rawRef: string | null;
  /** YYYY-MM-DD, for documents that expire (FSSAI, some Shop Act certificates). */
  validUntil: string | null;
  providerId: KycProviderId;
  /** Normalised fields for the flows and the reviewer; null when nothing was found. */
  record: SourceRecord | null;
  /** Why the result is PENDING / MANUAL_REVIEW / FAILED, as a short code. */
  errorCode: string | null;
}

let adapterOverride: KycAdapter | null = null;

/** Tests only: route verification through a given adapter. Pass null to restore. */
export function setKycAdapterForTests(adapter: KycAdapter | null): void {
  adapterOverride = adapter;
}

function httpOptions(): KycHttpOptions {
  return { timeoutMs: getEnv().KYC_TIMEOUT_MS, retries: 2, backoffMs: 500 };
}

export function getKycAdapter(): KycAdapter {
  if (adapterOverride) return adapterOverride;
  const env = getEnv();
  const problem = kycConfigProblem(env);
  if (problem) throw new KycConfigError("environment_mismatch", problem);

  switch (env.KYC_PROVIDER) {
    case "mock":
      return createMockAdapter();
    case "gridlines":
      return createGridlinesAdapter(env.GRIDLINES_API_KEY!, httpOptions(), env.GRIDLINES_BASE_URL ?? GRIDLINES_BASE_URL);
    case "idfy":
      throw new KycConfigError("not_configured", "The IDfy adapter has not been built yet; use KYC_PROVIDER=gridlines or mock.");
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Maps a vendor answer onto a document status, before any name matching. */
export function statusFromOutcome(outcome: ProviderOutcome, onDate = today()): {
  status: SellerVerificationStatus;
  errorCode: string | null;
} {
  if (outcome.kind === "not_found") return { status: "FAILED", errorCode: "not_found_at_source" };
  if (outcome.kind === "unsupported") return { status: "MANUAL_REVIEW", errorCode: "vendor_unsupported" };

  const { docStatus, validUntil } = outcome.record;
  if (docStatus === "expired" || (validUntil && validUntil < onDate)) {
    return { status: "EXPIRED", errorCode: "document_expired" };
  }
  if (docStatus === "active") return { status: "VERIFIED", errorCode: null };
  if (docStatus === "unknown") return { status: "MANUAL_REVIEW", errorCode: "source_status_unknown" };
  return { status: "FAILED", errorCode: `document_${docStatus}` };
}

export async function verifyDocument(
  docType: SellerDocType,
  number: string,
  extra: VerifyExtraFields,
  idempotencyKey: string,
): Promise<VerifyDocumentResult> {
  let providerId: KycProviderId = getEnv().KYC_PROVIDER;
  try {
    const adapter = getKycAdapter();
    providerId = adapter.id;
    const outcome = await adapter.verify({ docType, number, extra, idempotencyKey });
    const { status, errorCode } = statusFromOutcome(outcome);
    const record = outcome.kind === "found" ? outcome.record : null;
    return {
      status,
      matchedName: record?.name ?? null,
      rawRef: outcome.kind === "unsupported" ? null : outcome.providerRef,
      validUntil: record?.validUntil ?? null,
      providerId,
      record,
      errorCode,
    };
  } catch (error) {
    const base = { matchedName: null, rawRef: null, validUntil: null, providerId, record: null };
    if (error instanceof KycUnavailableError) {
      return { ...base, status: "PENDING", errorCode: `vendor_${error.code}` };
    }
    if (error instanceof KycConfigError) {
      // A response we can't read needs a person; a bad key or wrong
      // environment needs an admin to fix settings, then a re-check.
      const status = error.code === "unexpected_response" ? "MANUAL_REVIEW" : "PENDING";
      console.error(`[kyc] ${providerId} ${docType}: ${error.code} — ${error.message}`);
      return { ...base, status, errorCode: `config_${error.code}` };
    }
    throw error;
  }
}
