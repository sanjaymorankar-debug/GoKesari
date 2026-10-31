/**
 * Sandbox.co.in (Quicko) adapter — PAN and GSTIN, both OTP-free.
 *
 * Auth (developer.sandbox.co.in/api-reference/authenticate): POST
 * /authenticate with `x-api-key` + `x-api-secret` returns
 * `data.access_token`, valid 24 hours. Every other call sends that token in
 * `authorization` (no "Bearer") plus `x-api-key`. The token is cached per
 * process and shared by concurrent checks; a 401/403 on a lookup drops it and
 * the lookup is tried once more with a fresh token.
 *
 * Hosts: test keys (`key_test_…`) work only on test-api.sandbox.co.in, live
 * keys (`key_live_…`) only on api.sandbox.co.in. The host follows KYC_ENV,
 * and kycConfigProblem() refuses a key whose prefix does not match.
 *
 * Endpoints (from Sandbox's OpenAPI specs, Oct 2026):
 *   PAN   POST /kyc/pan/search/lite              — name, valid/invalid, category only
 *                                                  (no mobile, e-mail or Aadhaar: the least
 *                                                  personal data that answers the question)
 *   GSTIN POST /gst/compliance/public/gstin/search — the public GST record
 * Udyam, FSSAI and Shop Act are not offered: they come back "unsupported",
 * which sends the document to manual review.
 *
 * Gig worker flow: delivery partners' Aadhaar by OTP (offline e-KYC):
 *   POST /kyc/aadhaar/okyc/otp          — sends the OTP, returns a reference
 *   POST /kyc/aadhaar/okyc/otp/verify   — checks the OTP; only the name is kept
 *
 * Neither the secret, the token nor a document number is ever logged.
 */
import type { SellerDocType } from "@/lib/kyc/doc-formats";

import { kycPostJson, type KycHttpOptions } from "../http";
import {
  KycConfigError,
  type AadhaarOtpAdapter,
  type AadhaarOtpRequestOutcome,
  type AadhaarOtpVerifyOutcome,
  type KycAdapter,
  type ProviderOutcome,
  type SourceDocStatus,
  type SourceRecord,
  type VerifyRequest,
} from "../types";

export const SANDBOX_CO_BASE_URLS = {
  sandbox: "https://test-api.sandbox.co.in",
  production: "https://api.sandbox.co.in",
} as const;

/**
 * The `reason` Sandbox records against every PAN lookup. Kept word for word as
 * Sandbox's own example: its test environment answers only a request body
 * that exactly matches a saved example, so test.gokesari.com needs this text.
 */
const PAN_REASON = "for KYC";

/** Refresh this long before the token's own expiry, so a check never starts on a dying token. */
const TOKEN_EARLY_REFRESH_MS = 10 * 60 * 1000;
const TOKEN_DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/* ------------------------------------------------------------ token */

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokens = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<CachedToken>>();

/** Tests only. */
export function clearSandboxCoTokens(): void {
  tokens.clear();
  inFlight.clear();
}

/** The JWT's own `exp`, when it has one; 24 hours from now otherwise. */
export function tokenExpiry(token: string, now = Date.now()): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Json;
    if (typeof payload.exp === "number" && payload.exp * 1000 > now) return payload.exp * 1000;
  } catch {
    // Not a readable JWT: fall back to the documented lifetime.
  }
  return now + TOKEN_DEFAULT_LIFETIME_MS;
}

export function parseAuthenticateResponse(body: unknown): string {
  const token = isObject(body) ? (str(isObject(body.data) ? body.data.access_token : null) ?? str(body.access_token)) : null;
  if (!token) throw new KycConfigError("unexpected_response", "Sandbox /authenticate answered without an access token.");
  return token;
}

export interface SandboxCoCredentials {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
}

async function authenticate(creds: SandboxCoCredentials, http: KycHttpOptions): Promise<CachedToken> {
  const { body } = await kycPostJson(
    `${creds.baseUrl}/authenticate`,
    { "x-api-key": creds.apiKey, "x-api-secret": creds.apiSecret, "x-api-version": "1.0" },
    undefined,
    `auth:${Date.now()}`,
    http,
  );
  const token = parseAuthenticateResponse(body);
  return { token, expiresAt: tokenExpiry(token) };
}

/** A valid token, from the cache or one /authenticate call shared by everyone waiting. */
export async function getSandboxCoToken(creds: SandboxCoCredentials, http: KycHttpOptions, forceNew = false): Promise<string> {
  const cacheKey = `${creds.baseUrl}|${creds.apiKey}`;
  const cached = tokens.get(cacheKey);
  if (!forceNew && cached && cached.expiresAt - TOKEN_EARLY_REFRESH_MS > Date.now()) return cached.token;
  if (forceNew) tokens.delete(cacheKey);

  let pending = inFlight.get(cacheKey);
  if (!pending) {
    pending = authenticate(creds, http).finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, pending);
  }
  const fresh = await pending;
  tokens.set(cacheKey, fresh);
  return fresh.token;
}

/* -------------------------------------------------------- endpoints */

const ENDPOINTS: Partial<Record<SellerDocType, { path: string; body: (req: VerifyRequest) => Json }>> = {
  PAN: {
    path: "/kyc/pan/search/lite",
    body: (r) => ({ "@entity": "in.co.sandbox.kyc.pan_search_lite.request", pan: r.number, consent: "y", reason: PAN_REASON }),
  },
  GSTIN: { path: "/gst/compliance/public/gstin/search", body: (r) => ({ gstin: r.number }) },
};

/* ---------------------------------------------------------- readers */

/** Any word with a digit in it (a PAN, GSTIN, id) becomes "[number]", so a vendor message can be logged. */
function maskNumbers(text: string): string {
  return text.replace(/[A-Za-z0-9-]*\d[A-Za-z0-9-]*/g, "[number]").slice(0, 160);
}

/**
 * What an answer we could not read looked like — HTTP status, Sandbox's own
 * `code` and `message`, and the field names — without a single value that
 * could be a document number or a name.
 */
export function describeSandboxBody(httpStatus: number, body: unknown): string {
  if (!isObject(body)) return `HTTP ${httpStatus}, body is not an object`;
  const parts = [`HTTP ${httpStatus}`];
  if (body.code !== undefined) {
    const code = String(body.code);
    // A status like 404 or 422 is kept; anything longer could be an identifier.
    parts.push(`code ${/^\d{1,4}$/.test(code) ? code : maskNumbers(code)}`);
  }
  const message = str(body.message);
  if (message) parts.push(`message "${maskNumbers(message)}"`);
  parts.push(`fields [${Object.keys(body).join(", ")}]`);
  if (isObject(body.data)) parts.push(`data fields [${Object.keys(body.data).join(", ")}]`);
  return parts.join(", ");
}

function gstDocStatus(raw: string | null): SourceDocStatus {
  const s = (raw ?? "").toLowerCase();
  if (s === "active") return "active";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("suspend")) return "suspended";
  if (s.includes("inactive")) return "inactive";
  // "Provisional" and anything new: a person decides.
  return "unknown";
}

function joinAddress(addr: Json): string | null {
  const parts = ["flno", "bno", "bnm", "st", "locality", "loc", "landMark", "dst", "stcd", "pncd"]
    .map((k) => str(addr[k]))
    .filter((v): v is string => Boolean(v));
  return parts.length ? parts.join(", ") : null;
}

/** /kyc/pan/search/lite: `data.status` is "valid" or "invalid" (no such PAN). */
export function parseSandboxPan(body: unknown): ProviderOutcome {
  if (!isObject(body) || !isObject(body.data)) throw new KycConfigError("unexpected_response", "Sandbox PAN response had no data.");
  const providerRef = str(body.transaction_id);
  const data = body.data;
  const status = (str(data.status) ?? "").toLowerCase();
  if (status === "invalid") return { kind: "not_found", providerRef };
  if (status !== "valid") throw new KycConfigError("unexpected_response", "Sandbox PAN response had a status this code does not know.");
  const record: SourceRecord = {
    docStatus: "active",
    name: str(data.full_name),
    entityType: str(data.category),
  };
  return { kind: "found", record, providerRef };
}

/**
 * /gst/compliance/public/gstin/search: the GSTN answer sits in `data.data`,
 * with `data.status_cd` "1"; "0" plus `data.error` (FO8000) means no such GSTIN.
 */
export function parseSandboxGstin(body: unknown): ProviderOutcome {
  if (!isObject(body) || !isObject(body.data)) throw new KycConfigError("unexpected_response", "Sandbox GSTIN response had no data.");
  const providerRef = str(body.transaction_id);
  const outer = body.data;
  if (String(outer.status_cd ?? "") === "0" || isObject(outer.error)) {
    const code = isObject(outer.error) ? str(outer.error.error_cd) : null;
    if (!code || code === "FO8000") return { kind: "not_found", providerRef };
    throw new KycConfigError("unexpected_response", `Sandbox GSTIN lookup returned error ${code}.`);
  }
  const g = isObject(outer.data) ? outer.data : null;
  if (!g) throw new KycConfigError("unexpected_response", "Sandbox GSTIN response had no record.");

  const addr = isObject(g.pradr) && isObject(g.pradr.addr) ? g.pradr.addr : {};
  const record: SourceRecord = {
    docStatus: gstDocStatus(str(g.sts)),
    name: str(g.lgnm),
    tradeName: str(g.tradeNam),
    entityType: str(g.ctb),
    // A state name ("Karnataka"); the checks turn it into a code.
    stateCode: str(addr.stcd),
    pincode: str(addr.pncd),
    address: joinAddress(addr),
  };
  if (!record.name && !record.tradeName && record.docStatus === "unknown") {
    throw new KycConfigError("unexpected_response", "Sandbox GSTIN record had neither a name nor a status.");
  }
  if (record.docStatus === "unknown") {
    // The GST status word ("Provisional", …) is not personal; it tells the team why a person must decide.
    console.warn(`[kyc] sandboxco GSTIN: status "${maskNumbers(str(g.sts) ?? "(none)")}" is not one this code decides on`);
  }
  return { kind: "found", record, providerRef };
}

/* --------------------------------------------- Aadhaar OTP (gig worker flow) */

/** Sandbox records this against each Aadhaar OTP; kept as its documented example for the test environment. */
const AADHAAR_REASON = "For KYC";

/**
 * POST /kyc/aadhaar/okyc/otp → `data.reference_id` (a number) once the OTP is
 * sent to the Aadhaar-linked mobile; a `data.message` about an invalid Aadhaar
 * or no linked mobile means there is nothing to check.
 */
export function parseSandboxAadhaarOtp(body: unknown): AadhaarOtpRequestOutcome {
  if (!isObject(body) || !isObject(body.data)) throw new KycConfigError("unexpected_response", "Sandbox Aadhaar OTP response had no data.");
  const providerRef = str(body.transaction_id);
  const ref = body.data.reference_id;
  if (typeof ref === "number" || (typeof ref === "string" && ref.trim())) {
    return { kind: "sent", referenceId: String(ref), providerRef };
  }
  const message = (str(body.data.message) ?? "").toLowerCase();
  if (message.includes("invalid") || message.includes("not linked") || message.includes("does not exist")) {
    return { kind: "not_found", providerRef };
  }
  throw new KycConfigError("unexpected_response", "Sandbox Aadhaar OTP response had no reference.");
}

/** POST /kyc/aadhaar/okyc/otp/verify → `data.status` "VALID" with the name; the rest of the record is dropped here. */
export function parseSandboxAadhaarVerify(body: unknown): AadhaarOtpVerifyOutcome {
  if (!isObject(body) || !isObject(body.data)) throw new KycConfigError("unexpected_response", "Sandbox Aadhaar verify response had no data.");
  const status = (str(body.data.status) ?? "").toUpperCase();
  if (status === "VALID") return { kind: "verified", name: str(body.data.name), providerRef: str(body.transaction_id) };
  const message = (str(body.data.message) ?? "").toLowerCase();
  if (message.includes("expired")) return { kind: "expired" };
  if (message.includes("otp")) return { kind: "invalid_otp" };
  throw new KycConfigError("unexpected_response", "Sandbox Aadhaar verify response had a status this code does not know.");
}

function sandboxAadhaar(creds: SandboxCoCredentials, http: KycHttpOptions): AadhaarOtpAdapter {
  // Never retried: a second POST would send the person a second OTP.
  const once: KycHttpOptions = { ...http, retries: 0 };
  const post = async (path: string, payload: Json, idempotencyKey: string) => {
    const call = async (forceNewToken: boolean) => {
      const token = await getSandboxCoToken(creds, once, forceNewToken);
      return kycPostJson(`${creds.baseUrl}${path}`, { authorization: token, "x-api-key": creds.apiKey }, payload, idempotencyKey, once);
    };
    try {
      return await call(false);
    } catch (error) {
      if (!(error instanceof KycConfigError && error.code === "auth_failed")) throw error;
      return call(true);
    }
  };
  return {
    async requestOtp(aadhaarNumber, idempotencyKey) {
      const response = await post(
        "/kyc/aadhaar/okyc/otp",
        { "@entity": "in.co.sandbox.kyc.aadhaar.okyc.otp.request", aadhaar_number: aadhaarNumber, consent: "y", reason: AADHAAR_REASON },
        idempotencyKey,
      );
      if (response.status === 404) return { kind: "not_found", providerRef: null };
      return parseSandboxAadhaarOtp(response.body);
    },
    async verifyOtp(referenceId, otp, idempotencyKey) {
      try {
        const response = await post(
          "/kyc/aadhaar/okyc/otp/verify",
          { "@entity": "in.co.sandbox.kyc.aadhaar.okyc.request", reference_id: referenceId, otp },
          idempotencyKey,
        );
        return parseSandboxAadhaarVerify(response.body);
      } catch (error) {
        // Sandbox answers a wrong or used OTP with a 4xx; the body is not kept (kycPostJson), and the
        // partner's next step is the same either way: try again or ask for a new OTP.
        if (error instanceof KycConfigError && error.code === "bad_request") return { kind: "invalid_otp" };
        throw error;
      }
    },
  };
}

/* ---------------------------------------------------------- adapter */

export function createSandboxCoAdapter(creds: SandboxCoCredentials, http: KycHttpOptions): KycAdapter {
  return {
    id: "sandboxco",
    async verify(req: VerifyRequest): Promise<ProviderOutcome> {
      const endpoint = ENDPOINTS[req.docType];
      if (!endpoint) return { kind: "unsupported", reason: "Sandbox.co.in does not check this document." };

      const call = async (forceNewToken: boolean) => {
        const token = await getSandboxCoToken(creds, http, forceNewToken);
        return kycPostJson(
          `${creds.baseUrl}${endpoint.path}`,
          { authorization: token, "x-api-key": creds.apiKey },
          endpoint.body(req),
          req.idempotencyKey,
          http,
        );
      };

      let response;
      try {
        response = await call(false);
      } catch (error) {
        // An expired or revoked token: one more try with a new one. A second
        // refusal is a real credential problem and goes to the admin.
        if (!(error instanceof KycConfigError && error.code === "auth_failed")) throw error;
        response = await call(true);
      }
      try {
        return req.docType === "PAN" ? parseSandboxPan(response.body) : parseSandboxGstin(response.body);
      } catch (error) {
        if (!(error instanceof KycConfigError && error.code === "unexpected_response")) throw error;
        throw new KycConfigError("unexpected_response", `${error.message} (${describeSandboxBody(response.status, response.body)})`);
      }
    },
    aadhaar: sandboxAadhaar(creds, http),
  };
}
