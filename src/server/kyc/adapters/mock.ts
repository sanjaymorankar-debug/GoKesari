/**
 * Deterministic stand-in for a real vendor: local development, CI, and
 * test.gokesari.com before sandbox keys arrive. It makes no network call.
 *
 * The outcome is chosen by the number itself, so every scenario in the
 * sandbox test plan can be reproduced by typing a number. For PAN and GSTIN
 * the four digits of the (embedded) PAN decide; for the others, the last
 * digits of the number:
 *
 *   …0000  not found at source             …9999  vendor timeout (stays PENDING)
 *   …8888  inactive / cancelled / expired  …7777  name on record does not match
 *   …6666  FSSAI only: expires in 20 days  …5555  vendor can't check this (manual review)
 *   anything else: active, name = the name supplied to match
 *
 * Shop Act in Maharashtra returns "unsupported" (no vendor confirms MH
 * coverage, see the Part 1 notes) unless the number ends in 2222, which
 * stands in for a registration the vendor can verify.
 */
import type {
  AadhaarOtpAdapter,
  DigilockerAdapter,
  DigilockerSessionStatus,
  KycAdapter,
  ProviderOutcome,
  SourceRecord,
  VerifyRequest,
} from "../types";
import { KycUnavailableError } from "../types";

const DAY_MS = 86_400_000;

function isoDate(offsetDays: number, from = Date.now()): string {
  return new Date(from + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** The four scenario digits for a request. */
function scenarioDigits(req: VerifyRequest): string {
  if (req.docType === "PAN") return req.number.slice(5, 9);
  if (req.docType === "GSTIN") return req.number.slice(7, 11);
  return req.number.replace(/\D/g, "").slice(-4);
}

export function createMockAdapter(now: () => number = Date.now): KycAdapter {
  return {
    id: "mock",
    async verify(req: VerifyRequest): Promise<ProviderOutcome> {
      const digits = scenarioDigits(req);
      const providerRef = `mock-${req.idempotencyKey}`;

      if (digits === "9999") throw new KycUnavailableError("timeout", "Mock vendor timeout.");
      if (digits === "0000") return { kind: "not_found", providerRef };
      if (digits === "5555") return { kind: "unsupported", reason: "Mock vendor cannot check this document." };
      if (req.docType === "SHOP_ACT" && (req.extra.stateCode ?? "MH") === "MH" && digits !== "2222") {
        return { kind: "unsupported", reason: "Shop Act verification is not available for Maharashtra." };
      }

      const name = digits === "7777" ? "MISMATCHED NAME ENTERPRISES" : (req.extra.nameToMatch ?? "TEST SELLER").toUpperCase();
      const record: SourceRecord = { docStatus: "active", name, stateCode: req.extra.stateCode ?? "MH", pincode: "411001" };

      switch (req.docType) {
        case "PAN":
          record.entityType = req.number[3];
          if (digits === "8888") record.docStatus = "inactive";
          break;
        case "GSTIN":
          record.tradeName = name;
          record.linkedPan = req.number.slice(2, 12);
          record.stateCode = req.number.slice(0, 2);
          // The onboarding wizard fills the shop's address from the GST record.
          record.address = "Shop No 4, Main Market, Shivajinagar, Pune, Maharashtra, 411001";
          record.entityType = req.number[5] === "P" ? "Proprietorship" : "Private Limited Company";
          if (digits === "8888") record.docStatus = "cancelled";
          break;
        case "UDYAM":
          record.category = "MICRO";
          record.ownerName = name;
          record.stateCode = req.number.slice(6, 8);
          if (digits === "8888") record.docStatus = "cancelled";
          break;
        case "FSSAI":
          record.category = "STATE";
          record.validUntil = isoDate(digits === "8888" ? -10 : digits === "6666" ? 20 : 730, now());
          if (digits === "8888") record.docStatus = "expired";
          break;
        case "SHOP_ACT":
          record.validUntil = digits === "8888" ? isoDate(-10, now()) : null;
          if (digits === "8888") record.docStatus = "expired";
          break;
      }
      return { kind: "found", record, providerRef };
    },
    aadhaar: mockAadhaar,
    digilocker: mockDigilocker,
  };
}

/**
 * Gig worker flow: Aadhaar OTP stand-in, chosen by the last four digits of
 * the number (…0000 no such Aadhaar, …9999 vendor timeout, …5555 can't check)
 * and by the OTP: MOCK_AADHAAR_OTP verifies, 000000 has expired, anything else
 * is wrong. It returns no name (nothing to compare: the OTP itself proves the
 * Aadhaar-linked mobile). No network call.
 */
export const MOCK_AADHAAR_OTP = "123456";

const mockAadhaar: AadhaarOtpAdapter = {
  async requestOtp(aadhaarNumber, idempotencyKey) {
    const digits = aadhaarNumber.slice(-4);
    if (digits === "9999") throw new KycUnavailableError("timeout", "Mock vendor timeout.");
    if (digits === "0000") return { kind: "not_found", providerRef: `mock-${idempotencyKey}` };
    if (digits === "5555") return { kind: "unsupported", reason: "Mock vendor cannot check this Aadhaar." };
    return { kind: "sent", referenceId: `mock-ref-${digits}-${idempotencyKey.slice(0, 8)}`, providerRef: `mock-${idempotencyKey}` };
  },
  async verifyOtp(referenceId, otp, idempotencyKey) {
    if (!referenceId.startsWith("mock-ref-")) return { kind: "expired" };
    if (otp === "000000") return { kind: "expired" };
    if (otp !== MOCK_AADHAAR_OTP) return { kind: "invalid_otp" };
    return { kind: "verified", name: null, providerRef: `mock-${idempotencyKey}` };
  },
};

/* ------------------------------------------------------------- DigiLocker */

/**
 * Gig worker flow: DigiLocker stand-in. startSession links to a local fake
 * consent page (/mobile-auth/digilocker-mock on the same site as the return link)
 * whose buttons decide the session:
 *
 *   approve   succeeded, Aadhaar shared, no name (nothing to compare)
 *   mismatch  succeeded, Aadhaar shared under MOCK_DIGILOCKER_OTHER_NAME
 *   deny      failed (the rider refused consent)
 *   expire    expired
 *   down      the vendor stops answering (stays Pending)
 *
 * Sessions live in this process's memory (one `next start` per site), so a
 * restart forgets them: the check then waits until its link expires. No
 * network call. Never reachable on gokesari.com (kycConfigProblem, and the
 * page and route refuse when the mock is not the DigiLocker provider).
 */
export const MOCK_DIGILOCKER_OTHER_NAME = "SOMEONE ELSE ENTIRELY";
export const MOCK_DIGILOCKER_LAST4 = "4321";
export const MOCK_DIGILOCKER_PATH = "/mobile-auth/digilocker-mock";
export const MOCK_DIGILOCKER_DECISIONS = ["approve", "mismatch", "deny", "expire", "down"] as const;
export type MockDigilockerDecision = (typeof MOCK_DIGILOCKER_DECISIONS)[number];

interface MockSession {
  redirectUrl: string;
  decision: MockDigilockerDecision | null;
  /** The DigiLocker account the mock "signs in" as: the same holder on two partners is one person. */
  holderId: string;
  expiresAt: number;
}

const store = globalThis as typeof globalThis & { __gokesariMockDigilocker?: Map<string, MockSession> };
function mockSessions(): Map<string, MockSession> {
  store.__gokesariMockDigilocker ??= new Map();
  return store.__gokesariMockDigilocker;
}

/** Tests only. */
export function clearMockDigilocker(): void {
  mockSessions().clear();
}

/** The consent page's buttons. Returns where to send the rider next, or null for an unknown session. */
export function decideMockDigilocker(sessionId: string, decision: MockDigilockerDecision, holderId?: string): string | null {
  const session = mockSessions().get(sessionId);
  if (!session) return null;
  session.decision = decision;
  if (holderId) session.holderId = holderId;
  return session.redirectUrl;
}

export function mockDigilockerSessionExists(sessionId: string): boolean {
  return mockSessions().has(sessionId);
}

function mockStatus(session: MockSession, now: number): DigilockerSessionStatus {
  if (session.decision === "approve" || session.decision === "mismatch") return "succeeded";
  if (session.decision === "deny") return "failed";
  if (session.decision === "expire" || now > session.expiresAt) return "expired";
  return "created";
}

const mockDigilocker: DigilockerAdapter = {
  async startSession(request, idempotencyKey) {
    const sessionId = `mock-dl-${crypto.randomUUID()}`;
    mockSessions().set(sessionId, {
      redirectUrl: request.redirectUrl,
      decision: null,
      holderId: `mock-holder-${sessionId.slice(-12)}`,
      expiresAt: request.consentExpiryMs,
    });
    const page = new URL(MOCK_DIGILOCKER_PATH, request.redirectUrl);
    page.searchParams.set("session", sessionId);
    return { sessionId, authorizationUrl: page.toString(), providerRef: `mock-${idempotencyKey}` };
  },
  async sessionStatus(sessionId) {
    const session = mockSessions().get(sessionId);
    if (!session) return null;
    if (session.decision === "down") throw new KycUnavailableError("source_down", "Mock DigiLocker is down.");
    const status = mockStatus(session, Date.now());
    return { status, documentsConsented: status === "succeeded" ? ["aadhaar"] : [], providerRef: `mock-status-${sessionId.slice(-8)}` };
  },
  async fetchAadhaar(sessionId) {
    const session = mockSessions().get(sessionId);
    if (!session || mockStatus(session, Date.now()) !== "succeeded") return { kind: "session_unusable", providerRef: null };
    return {
      kind: "found",
      name: session.decision === "mismatch" ? MOCK_DIGILOCKER_OTHER_NAME : null,
      last4: MOCK_DIGILOCKER_LAST4,
      holderId: session.holderId,
      providerRef: `mock-doc-${sessionId.slice(-8)}`,
    };
  },
};
