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
 * Gig worker flow: delivery partners' Aadhaar through DigiLocker (Sandbox
 * replaced offline e-KYC with it; developer.sandbox.co.in/api-reference/kyc/digilocker):
 *   POST /kyc/digilocker/sessions/init                       — the DigiLocker link for the rider
 *   GET  /kyc/digilocker/sessions/{id}/status                 — created / succeeded / failed / expired
 *   GET  /kyc/digilocker/sessions/{id}/documents/aadhaar      — a pre-signed link to UIDAI's XML
 *   GET  /kyc/digilocker/sessions/{id}/user/profile           — DigiLocker account id and name
 * The XML is read in memory for the name and the last four digits, then dropped.
 *
 * Legacy, unreachable unless rule riderVerification.aadhaarMethod is "okyc_legacy"
 * (Sandbox discontinued both endpoints):
 *   POST /kyc/aadhaar/okyc/otp          — sends the OTP, returns a reference
 *   POST /kyc/aadhaar/okyc/otp/verify   — checks the OTP; only the name is kept
 *
 * Neither the secret, the token nor a document number is ever logged.
 */
import type { SellerDocType } from "@/lib/kyc/doc-formats";

import { kycGetBytes, kycPostJson, kycRequestJson, type KycHttpOptions } from "../http";
import {
  KycConfigError,
  type AadhaarOtpAdapter,
  type DigilockerAadhaarOutcome,
  type DigilockerAdapter,
  type DigilockerSession,
  type DigilockerSessionState,
  type DigilockerSessionStatus,
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

/* ------------------------------------------- DigiLocker (gig worker flow) */

/** Shown to the rider on DigiLocker's consent screen: letters, digits, spaces and underscores only (else 400). */
export const DIGILOCKER_PURPOSE = "Delivery partner KYC";
export const DIGILOCKER_REQUESTOR = "GoKesari";
/** UIDAI's issued Aadhaar in DigiLocker. */
const UIDAI_ISSUER_ID = "in.gov.uidai";
/** The Aadhaar XML is ~20 KB (it carries the photo); anything far larger is not it. */
const AADHAAR_FILE_MAX_BYTES = 2_000_000;
/** Sandbox: 521 = no session with this id, 523 = the session can't be used (consent not done, or expired). */
const SESSION_NOT_FOUND = 521;
const SESSION_UNUSABLE = 523;

const SESSION_STATUSES: readonly DigilockerSessionStatus[] = ["created", "succeeded", "failed", "expired"];

/** POST /kyc/digilocker/sessions/init → `data.session_id` and `data.authorization_url`. */
export function parseDigilockerInit(body: unknown): DigilockerSession {
  if (!isObject(body) || !isObject(body.data)) throw new KycConfigError("unexpected_response", "Sandbox DigiLocker session response had no data.");
  const sessionId = str(body.data.session_id);
  const authorizationUrl = str(body.data.authorization_url);
  if (!sessionId || !authorizationUrl || !/^https:\/\//.test(authorizationUrl)) {
    throw new KycConfigError("unexpected_response", "Sandbox DigiLocker session response had no session id or link.");
  }
  return { sessionId, authorizationUrl, providerRef: str(body.transaction_id) };
}

/**
 * The session object of GET …/status — also the `data` of the session webhook,
 * so the webhook route reads it with this too.
 */
export function parseDigilockerSession(data: unknown, providerRef: string | null = null): DigilockerSessionState & { sessionId: string } {
  if (!isObject(data)) throw new KycConfigError("unexpected_response", "Sandbox DigiLocker session had no data.");
  const sessionId = str(data.id);
  const status = (str(data.status) ?? "").toLowerCase() as DigilockerSessionStatus;
  if (!sessionId || !SESSION_STATUSES.includes(status)) {
    throw new KycConfigError("unexpected_response", "Sandbox DigiLocker session had no id or a status this code does not know.");
  }
  const consented = Array.isArray(data.documents_consented) ? data.documents_consented.filter((d): d is string => typeof d === "string") : [];
  return { sessionId, status, documentsConsented: status === "succeeded" ? consented : [], providerRef };
}

export function parseDigilockerStatus(body: unknown): DigilockerSessionState {
  if (!isObject(body)) throw new KycConfigError("unexpected_response", "Sandbox DigiLocker status response was not an object.");
  const { status, documentsConsented, providerRef } = parseDigilockerSession(body.data, str(body.transaction_id));
  return { status, documentsConsented, providerRef };
}

/** GET …/documents/aadhaar → `data.files[]`; the UIDAI XML link, if there is one. */
export function pickAadhaarXmlUrl(body: unknown): string | null {
  if (!isObject(body) || !isObject(body.data) || !Array.isArray(body.data.files)) {
    throw new KycConfigError("unexpected_response", "Sandbox DigiLocker document response had no files.");
  }
  const files = body.data.files.filter(isObject);
  const isXml = (f: Json) => (str(isObject(f.metadata) ? f.metadata.ContentType : null) ?? "").toLowerCase().includes("xml");
  const fromUidai = (f: Json) => str(isObject(f.metadata) ? f.metadata.issuer_id : null) === UIDAI_ISSUER_ID;
  const file = files.find((f) => isXml(f) && fromUidai(f)) ?? files.find(isXml);
  const url = file ? str(file.url) : null;
  return url && /^https:\/\//.test(url) ? url : null;
}

/** GET …/user/profile → DigiLocker's account `id` and `name`; date of birth, mobile, e-mail and gender are dropped here. */
export function parseDigilockerProfile(body: unknown): { holderId: string | null; name: string | null } {
  if (!isObject(body) || !isObject(body.data)) throw new KycConfigError("unexpected_response", "Sandbox DigiLocker profile response had no data.");
  return { holderId: str(body.data.id), name: str(body.data.name) };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function xmlAttribute(xml: string, element: string, attribute: string): string | null {
  const tag = new RegExp(`<${element}\\b[^>]*>`, "i").exec(xml)?.[0];
  if (!tag) return null;
  const value = new RegExp(`\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  const text = value ? decodeXmlText(value[1] ?? value[2] ?? "") : "";
  return text || null;
}

/**
 * UIDAI's Aadhaar XML as DigiLocker issues it (not a Sandbox format, so read
 * defensively): the name from `Poi@name` (KYC data) or `Person@name`
 * (certificate holder), and the last four digits of `uid`, which DigiLocker
 * masks ("xxxxxxxx1234"). Only those two values leave this function; the
 * date of birth, address and photo in the same file are never read.
 */
export function readAadhaarXml(xml: string): { name: string | null; last4: string | null } {
  const name = xmlAttribute(xml, "Poi", "name") ?? xmlAttribute(xml, "Person", "name");
  const uid = xmlAttribute(xml, "UidData", "uid") ?? xmlAttribute(xml, "Person", "uid");
  const last4 = uid ? (/(\d{4})$/.exec(uid.replace(/\s/g, ""))?.[1] ?? null) : null;
  return { name, last4 };
}

function sandboxDigilocker(creds: SandboxCoCredentials, http: KycHttpOptions): DigilockerAdapter {
  // Reads may retry; starting a session never does (each POST is a new DigiLocker link).
  const startOnce: KycHttpOptions = { ...http, retries: 0 };
  const call = async (method: "GET" | "POST", path: string, payload: Json | undefined, key: string, opts: KycHttpOptions, answer: number[] = []) => {
    const go = async (forceNewToken: boolean) => {
      const token = await getSandboxCoToken(creds, opts, forceNewToken);
      return kycRequestJson(method, `${creds.baseUrl}${path}`, { authorization: token, "x-api-key": creds.apiKey }, payload, key, opts, answer);
    };
    try {
      return await go(false);
    } catch (error) {
      if (!(error instanceof KycConfigError && error.code === "auth_failed")) throw error;
      return go(true);
    }
  };
  const read = <T>(what: string, response: { status: number; body: unknown }, parse: (body: unknown) => T): T => {
    try {
      return parse(response.body);
    } catch (error) {
      if (!(error instanceof KycConfigError && error.code === "unexpected_response")) throw error;
      throw new KycConfigError("unexpected_response", `${what}: ${error.message} (${describeSandboxBody(response.status, response.body)})`);
    }
  };
  const session = (id: string) => `/kyc/digilocker/sessions/${encodeURIComponent(id)}`;

  return {
    async startSession(request, idempotencyKey) {
      const response = await call(
        "POST",
        "/kyc/digilocker/sessions/init",
        {
          "@entity": "in.co.sandbox.kyc.digilocker.session.request",
          flow: "signin",
          redirect_url: request.redirectUrl,
          doc_types: ["aadhaar"],
          purpose: DIGILOCKER_PURPOSE,
          requestor_name: DIGILOCKER_REQUESTOR,
          consent_expiry: request.consentExpiryMs,
        },
        idempotencyKey,
        startOnce,
      );
      return read("DigiLocker session", response, parseDigilockerInit);
    },
    async sessionStatus(sessionId) {
      const response = await call("GET", `${session(sessionId)}/status`, undefined, `dl-status:${sessionId}:${Date.now()}`, http, [SESSION_NOT_FOUND]);
      if (response.status === SESSION_NOT_FOUND || response.status === 404) return null;
      return read("DigiLocker status", response, parseDigilockerStatus);
    },
    async fetchAadhaar(sessionId) {
      let documents;
      try {
        documents = await call("GET", `${session(sessionId)}/documents/aadhaar`, undefined, `dl-doc:${sessionId}`, http, [SESSION_NOT_FOUND, SESSION_UNUSABLE]);
      } catch (error) {
        // 400 "Consent for aadhaar not provided" (the body is not kept by kycRequestJson).
        if (error instanceof KycConfigError && error.code === "bad_request") return { kind: "not_shared", reason: "no_consent", providerRef: null };
        throw error;
      }
      const ref = isObject(documents.body) ? str(documents.body.transaction_id) : null;
      if (documents.status === SESSION_NOT_FOUND || documents.status === SESSION_UNUSABLE) return { kind: "session_unusable", providerRef: ref };
      if (documents.status === 404) return { kind: "not_shared", reason: "not_in_digilocker", providerRef: ref };
      const xmlUrl = read("DigiLocker Aadhaar", documents, pickAadhaarXmlUrl);

      const profileResponse = await call("GET", `${session(sessionId)}/user/profile`, undefined, `dl-profile:${sessionId}`, http, [SESSION_NOT_FOUND, SESSION_UNUSABLE]);
      if (profileResponse.status === SESSION_NOT_FOUND || profileResponse.status === SESSION_UNUSABLE) return { kind: "session_unusable", providerRef: ref };
      const profile = read("DigiLocker profile", profileResponse, parseDigilockerProfile);

      let fromXml: { name: string | null; last4: string | null } = { name: null, last4: null };
      if (xmlUrl) fromXml = readAadhaarXml((await kycGetBytes(xmlUrl, http, AADHAAR_FILE_MAX_BYTES)).toString("utf8"));
      const outcome: DigilockerAadhaarOutcome = {
        kind: "found",
        name: fromXml.name ?? profile.name,
        last4: fromXml.last4,
        holderId: profile.holderId,
        providerRef: ref,
      };
      return outcome;
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
    digilocker: sandboxDigilocker(creds, http),
  };
}
