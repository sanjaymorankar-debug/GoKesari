/**
 * Cashfree Verification Suite adapter — FSSAI licences only (owner decision,
 * 21-Nov-2026). Sandbox.co.in, the KYC_PROVIDER for PAN and GSTIN, has no
 * FSSAI lookup, so without this every FSSAI number went to manual review.
 * Chosen by rule sellerVerification.fssaiProvider = "cashfree"; any other
 * document is "unsupported" here.
 *
 *   POST {https://api.cashfree.com | https://sandbox.cashfree.com}/verification/fssai
 *   headers  x-client-id, x-client-secret, x-cf-signature (when CASHFREE_VERIFICATION_PUBLIC_KEY is set)
 *   body     { verification_id, fssai_number }
 *   200      status "VALID" (+ business_name, license_type, license_active_flag,
 *            address, state, pincode …) or "INVALID" (no such licence)
 *
 * Cashfree returns no expiry date: an active licence comes back with
 * activeConfirmed instead of validUntil, and verified licences are re-checked
 * every sellerVerification.fssaiRecheckDays (seller-verification-jobs.ts).
 *
 * Keys and two-factor authentication: payments/cashfree-verification.ts.
 * Sandbox test numbers (docs.cashfree.com, "Data to test integration"):
 * 10121002000677 valid licence, 20121002000678 valid registration,
 * 99121002000679 invalid.
 *
 * Neither the keys nor the licence number are ever logged.
 */
import { createHash } from "node:crypto";

import { cashfreeEnvProblem } from "@/lib/env";
import {
  cashfreeSignature,
  cashfreeVerificationApiBase,
  type CashfreeVerificationConfig,
} from "@/server/payments/cashfree-verification";

import { kycRequestJson, type KycHttpOptions } from "../http";
import {
  KycConfigError,
  KycUnavailableError,
  type KycAdapter,
  type ProviderOutcome,
  type SourceRecord,
  type VerifyRequest,
} from "../types";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Any word with a digit in it becomes "[number]", so a Cashfree message can be logged. */
function maskNumbers(text: string): string {
  return text.replace(/[A-Za-z0-9-]*\d[A-Za-z0-9-]*/g, "[number]").slice(0, 160);
}

/** Cashfree's error `code` and `message` (numbers masked), for the log and the admin. */
function describeError(httpStatus: number, body: unknown): string {
  const code = isObject(body) ? str(body.code) : null;
  const message = isObject(body) ? str(body.message) : null;
  return [`HTTP ${httpStatus}`, code ? `code ${maskNumbers(code)}` : null, message ? `"${maskNumbers(message)}"` : null]
    .filter(Boolean)
    .join(", ");
}

/**
 * Cashfree's verification_id: at most 50 characters of letters, digits, ".",
 * "-" and "_", unique per call. Derived from our idempotency key (one per
 * check attempt), so the same attempt always sends the same id.
 */
export function cashfreeVerificationId(idempotencyKey: string): string {
  return `gk-fssai-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

/** Registration / State License / Central License → BASIC / STATE / CENTRAL (SourceRecord.category). */
function licenceCategory(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes("central")) return "CENTRAL";
  if (s.includes("state")) return "STATE";
  if (s.includes("registration") || s.includes("basic")) return "BASIC";
  return raw.toUpperCase();
}

/** Reads Cashfree's 200 answer. A shape it does not recognise is never treated as verified. */
export function parseCashfreeFssai(body: unknown): ProviderOutcome {
  if (!isObject(body)) throw new KycConfigError("unexpected_response", "Cashfree FSSAI answered without a JSON object.");
  const providerRef = str(body.reference_id);
  const status = str(body.status)?.toUpperCase() ?? null;
  if (status === "INVALID") return { kind: "not_found", providerRef };
  if (status !== "VALID") {
    throw new KycConfigError("unexpected_response", `Cashfree FSSAI status "${maskNumbers(status ?? "(none)")}" is not VALID or INVALID.`);
  }

  const flag = body.license_active_flag;
  const activeConfirmed = flag === true ? true : flag === false ? false : null;
  const pincode = str(body.pincode)?.replace(/\D/g, "") ?? null;
  const record: SourceRecord = {
    // A licence the source holds but says is not in force (lapsed, cancelled) is not active;
    // no flag at all leaves the decision to a person.
    docStatus: activeConfirmed === true ? "active" : activeConfirmed === false ? "inactive" : "unknown",
    name: str(body.business_name),
    stateCode: str(body.state),
    pincode: pincode && /^\d{6}$/.test(pincode) ? pincode : null,
    address: [str(body.address), str(body.village), str(body.taluk), str(body.district), str(body.state), pincode]
      .filter(Boolean)
      .join(", ") || null,
    category: licenceCategory(str(body.license_type)),
    validUntil: null,
    activeConfirmed,
  };
  return { kind: "found", record, providerRef };
}

export function createCashfreeAdapter(config: CashfreeVerificationConfig, http: KycHttpOptions): KycAdapter {
  return {
    id: "cashfree",
    async verify(req: VerifyRequest): Promise<ProviderOutcome> {
      if (req.docType !== "FSSAI") return { kind: "unsupported", reason: "Cashfree is used here for FSSAI licences only." };

      // A sandbox answer must never verify a real licence on gokesari.com, nor the test site call production.
      const envProblem = cashfreeEnvProblem("verification");
      if (envProblem) throw new KycConfigError("environment_mismatch", envProblem);

      const headers: Record<string, string> = { "x-client-id": config.clientId, "x-client-secret": config.clientSecret };
      if (config.publicKey) {
        try {
          headers["x-cf-signature"] = cashfreeSignature(config.clientId, config.publicKey);
        } catch (error) {
          throw new KycConfigError(
            "not_configured",
            `CASHFREE_VERIFICATION_PUBLIC_KEY could not be used (${error instanceof Error ? error.name : "error"}).`,
          );
        }
      }

      let response;
      try {
        response = await kycRequestJson(
          "POST",
          `${cashfreeVerificationApiBase(config.env)}/fssai`,
          headers,
          { verification_id: cashfreeVerificationId(req.idempotencyKey), fssai_number: req.number },
          req.idempotencyKey,
          http,
          // Answers to read rather than generic failures: Cashfree explains these in its body.
          [400, 409, 422],
        );
      } catch (error) {
        if (error instanceof KycConfigError && error.code === "auth_failed") {
          throw new KycConfigError(
            "auth_failed",
            `${error.message} Check CASHFREE_VERIFICATION_CLIENT_ID / _CLIENT_SECRET and Cashfree's two-factor authentication: whitelist this server's IP in the Cashfree Verification dashboard, or set CASHFREE_VERIFICATION_PUBLIC_KEY.`,
          );
        }
        throw error;
      }

      if (response.status === 409) {
        // The same verification id reached Cashfree on an earlier attempt that we never heard back from.
        // The next re-try is a new attempt with a new id.
        throw new KycUnavailableError("vendor_error", `Cashfree already has this check (${describeError(response.status, response.body)}).`);
      }
      if (response.status === 422) {
        throw new KycConfigError(
          "not_configured",
          `Cashfree refused the check (${describeError(response.status, response.body)}); top up the Verification Suite balance in the Cashfree dashboard.`,
        );
      }
      if (response.status === 400) {
        throw new KycConfigError("bad_request", `Cashfree refused the request (${describeError(response.status, response.body)}).`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new KycConfigError("unexpected_response", `Cashfree FSSAI answered ${describeError(response.status, response.body)}.`);
      }
      return parseCashfreeFssai(response.body);
    },
  };
}
