/**
 * Delivery partner PAN and Aadhaar checks (gig worker flow, feature 2,
 * docs/gig-worker-2026-10).
 *
 *  - Consent first: nothing is sent to the KYC provider without the partner
 *    ticking the consent (RIDER_KYC_CONSENT_TEXT); version, time and IP are
 *    stored with the check.
 *  - PAN: one lookup through the seller adapters' `verifyDocument` (mock,
 *    Gridlines or Sandbox.co.in — whichever KYC_PROVIDER says). Stored
 *    encrypted (AES-256-GCM) and masked.
 *  - Aadhaar (rule riderVerification.aadhaarMethod "digilocker", the default):
 *    the partner shares it from DigiLocker through the adapter's `digilocker`
 *    half — we start a session, the partner signs in to DigiLocker (Aadhaar
 *    OTP there) and consents, DigiLocker sends them back to our return link,
 *    and Sandbox's webhook (or polling, as a fallback) settles the check. We
 *    keep the name, the last four digits and a keyed token of the DigiLocker
 *    account id. Legacy ("okyc_legacy"): OTP to the Aadhaar-linked mobile
 *    through the `aadhaar` half (Sandbox discontinued it). Either way the
 *    number is NEVER stored — only a masked form and a keyed token (blind
 *    index) that finds the same Aadhaar on another partner; a database check
 *    refuses an Aadhaar row with a stored number.
 *  - Verified / Pending / Failed per document. Pending covers "OTP sent",
 *    "the vendor can't check this" and "name doesn't match" — an admin then
 *    decides by hand (`decideRiderKycCheck`).
 *
 * Vendor calls happen outside any transaction; a vendor outage leaves the
 * check Pending, never Failed.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { and, desc, eq, ne } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  maskAadhaar,
  maskRiderPan,
  normaliseAadhaarInput,
  RIDER_KYC_CONSENT_VERSION,
  riderKycAdminReason,
  riderKycReason,
  type RiderAadhaarMethod,
  type RiderKycStatus,
} from "@/lib/gig/kyc";
import { isMobileAppScheme, type MobileAppScheme } from "@/lib/mobile-app";
import { looksLikeAadhaar } from "@/lib/kyc/doc-formats";
import { nameMatchScore } from "@/lib/kyc/name-match";
import { checkRiderPan } from "@/lib/kyc/rider-details";
import { docBlindIndex, encryptSecret } from "@/lib/pan-crypto";
import {
  getDigilockerAdapter,
  getKycAdapter,
  KycConfigError,
  KycUnavailableError,
  verifyDocument,
  type DigilockerAdapter,
  type KycProviderId,
} from "@/server/kyc";
import { db } from "@/server/db";
import {
  deliveryPartnerKycChecks,
  deliveryPartners,
  type DeliveryPartner,
  type DeliveryPartnerKycCheck,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

type DocType = DeliveryPartnerKycCheck["docType"];

/** Name on the record against the registered name: at or above this the check is Verified outright. */
export const RIDER_NAME_MATCH_MIN = 80;
/** Seconds before another Aadhaar OTP may be asked for. */
export const AADHAAR_OTP_COOLDOWN_SECONDS = 60;
/** Where DigiLocker sends the partner back (a route: it needs no sign-in, the random key finds the check). */
export const DIGILOCKER_RETURN_PATH = "/mobile-auth/digilocker-return";
/** `<scheme>://digilocker-return` — how the return link hands back to the app's in-app browser. */
export const DIGILOCKER_APP_CALLBACK_HOST = "digilocker-return";
/**
 * How long the DigiLocker consent stays valid. Sandbox refuses under an hour, and
 * DigiLocker refuses a link opened with less than an hour of consent left — so
 * two hours leaves the link usable for about an hour.
 */
export const DIGILOCKER_CONSENT_MS = 2 * 60 * 60_000;
/** A link is handed out again only while DigiLocker will still open it (an hour of consent, plus a margin). */
const DIGILOCKER_REUSE_MIN_LEFT_MS = 65 * 60_000;
/** Opening the KYC page re-asks Sandbox at most this often (the polling fallback to the webhook). */
const DIGILOCKER_POLL_MIN_MS = 10_000;
/** Shown until DigiLocker shares the Aadhaar: no digits are known yet. */
const DIGILOCKER_PENDING_MASK = "XXXX XXXX XXXX";
const NO_SESSION = { sessionId: null, sessionStatus: null, sessionUrl: null, sessionExpiresAt: null, sessionReturnKey: null } as const;

export interface RiderKycCheckView {
  id: string;
  docType: DocType;
  status: RiderKycStatus;
  numberMasked: string;
  /** Why it is Pending or Failed, in the partner's words; null when Verified. */
  reason: string | null;
  errorCode: string | null;
  /** Aadhaar: an OTP was sent and is waiting to be entered (legacy OTP method). */
  awaitingOtp: boolean;
  /** Aadhaar: how it is checked. Null for PAN, and for Aadhaar rows from before DigiLocker (OTP). */
  method: RiderAadhaarMethod | null;
  /** Aadhaar by DigiLocker: a session is open and its link can still be used. */
  digilockerOpen: boolean;
  verifiedAt: Date | null;
  updatedAt: Date;
}

export function toKycView(row: DeliveryPartnerKycCheck): RiderKycCheckView {
  return {
    id: row.id,
    docType: row.docType,
    status: row.status,
    numberMasked: row.numberMasked,
    reason: row.status === "VERIFIED" ? null : (row.reviewNote ?? riderKycReason(row.errorCode)),
    errorCode: row.errorCode,
    awaitingOtp: row.docType === "AADHAAR" && row.status === "PENDING" && Boolean(row.otpReference),
    method: row.docType === "AADHAAR" ? (row.method ?? "okyc_legacy") : null,
    digilockerOpen: digilockerOpen(row),
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
  };
}

function digilockerOpen(row: DeliveryPartnerKycCheck, now = Date.now()): boolean {
  return (
    row.docType === "AADHAAR" &&
    row.method === "digilocker" &&
    row.status === "PENDING" &&
    row.sessionStatus === "created" &&
    Boolean(row.sessionUrl) &&
    (row.sessionExpiresAt?.getTime() ?? 0) > now
  );
}

async function myPartner(userId: string): Promise<DeliveryPartner> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner || partner.deletedAt) throw notFound("Delivery partner profile");
  if (partner.status === "DEACTIVATED") throw conflict("This delivery partner profile has been closed.");
  return partner;
}

async function currentCheck(partnerId: string, docType: DocType): Promise<DeliveryPartnerKycCheck | undefined> {
  return db.query.deliveryPartnerKycChecks.findFirst({
    where: and(eq(deliveryPartnerKycChecks.deliveryPartnerId, partnerId), eq(deliveryPartnerKycChecks.docType, docType)),
  });
}

/** Another partner already holds a Verified check for this number. */
async function verifiedElsewhere(partnerId: string, docType: DocType, token: string): Promise<boolean> {
  const [row] = await db
    .select({ id: deliveryPartnerKycChecks.id })
    .from(deliveryPartnerKycChecks)
    .where(
      and(
        eq(deliveryPartnerKycChecks.docType, docType),
        eq(deliveryPartnerKycChecks.numberToken, token),
        eq(deliveryPartnerKycChecks.status, "VERIFIED"),
        ne(deliveryPartnerKycChecks.deliveryPartnerId, partnerId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

interface Consent {
  consentGiven: boolean;
  ipAddress?: string | null;
}

function requireConsent(consent: Consent): void {
  if (!consent.consentGiven) {
    throw validationFailed("Tick the consent box so we can verify your documents.", { fields: { consent: "Consent is required." } });
  }
}

type CheckWrite = Partial<Omit<typeof deliveryPartnerKycChecks.$inferInsert, "id" | "deliveryPartnerId" | "docType">>;

/** Creates or replaces the partner's one check of this type. Platform table: a plain upsert is fine. */
async function saveCheck(
  partner: DeliveryPartner,
  docType: DocType,
  values: CheckWrite & Pick<typeof deliveryPartnerKycChecks.$inferInsert, "numberMasked" | "numberToken" | "provider">,
  consent: Consent,
): Promise<DeliveryPartnerKycCheck> {
  const now = new Date();
  const row = {
    ...values,
    consentVersion: RIDER_KYC_CONSENT_VERSION,
    consentGivenAt: now,
    consentIp: consent.ipAddress ?? null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    updatedAt: now,
  };
  const [saved] = await db
    .insert(deliveryPartnerKycChecks)
    .values({ deliveryPartnerId: partner.id, docType, ...row })
    .onConflictDoUpdate({ target: [deliveryPartnerKycChecks.deliveryPartnerId, deliveryPartnerKycChecks.docType], set: row })
    .returning();
  return saved;
}

async function auditCheck(partner: DeliveryPartner, row: DeliveryPartnerKycCheck, actorId: string, step: string): Promise<void> {
  await recordAudit({
    actorId,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_KYC_CHECKED,
    entityType: "delivery_partner",
    entityId: partner.id,
    newValue: { docType: row.docType, step, status: row.status, numberMasked: row.numberMasked, errorCode: row.errorCode, provider: row.provider },
  });
}

/** Verified / Pending from a name on the record; no name to compare (the vendor gave none) counts as a match. */
function nameDecision(recordName: string | null, partnerName: string): { status: RiderKycStatus; score: number | null; errorCode: string | null } {
  if (!recordName) return { status: "VERIFIED", score: null, errorCode: null };
  const score = nameMatchScore(recordName, partnerName);
  return score >= RIDER_NAME_MATCH_MIN ? { status: "VERIFIED", score, errorCode: null } : { status: "PENDING", score, errorCode: "name_mismatch" };
}

/* ------------------------------------------------------------------ partner */

export interface MyRiderKyc {
  pan: RiderKycCheckView | null;
  aadhaar: RiderKycCheckView | null;
  complete: boolean;
}

export async function getMyRiderKyc(userId: string): Promise<MyRiderKyc> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner || partner.deletedAt) throw notFound("Delivery partner profile");
  const [pan, found] = await Promise.all([currentCheck(partner.id, "PAN"), currentCheck(partner.id, "AADHAAR")]);
  // Polling fallback: a DigiLocker session the webhook has not settled yet is asked about here.
  const aadhaar =
    found && found.method === "digilocker" && found.status === "PENDING" && found.sessionId && Date.now() - found.updatedAt.getTime() >= DIGILOCKER_POLL_MIN_MS
      ? await syncDigilockerCheck(found, "poll")
      : found;
  return {
    pan: pan ? toKycView(pan) : null,
    aadhaar: aadhaar ? toKycView(aadhaar) : null,
    complete: pan?.status === "VERIFIED" && aadhaar?.status === "VERIFIED",
  };
}

/** Checks the partner's PAN with the KYC provider (after consent). */
export async function verifyMyPan(userId: string, input: { pan: string } & Consent): Promise<RiderKycCheckView> {
  requireConsent(input);
  const partner = await myPartner(userId);
  const parsed = checkRiderPan(input.pan ?? "");
  if (!parsed.ok) throw validationFailed(parsed.error, { fields: { pan: parsed.error } });
  const pan = parsed.value;
  const token = docBlindIndex("RIDER_PAN", pan);

  const existing = await currentCheck(partner.id, "PAN");
  if (existing?.status === "VERIFIED" && existing.numberToken === token) return toKycView(existing);

  const base = { numberMasked: maskRiderPan(pan), numberToken: token, numberEncrypted: encryptSecret(pan), otpReference: null, otpRequestedAt: null, otpAttempts: 0 };
  if (await verifiedElsewhere(partner.id, "PAN", token)) {
    const row = await saveCheck(partner, "PAN", { ...base, provider: "none", status: "FAILED", errorCode: "already_used", verifiedAt: null }, input);
    await auditCheck(partner, row, userId, "pan");
    return toKycView(row);
  }

  const result = await verifyDocument("PAN", pan, { nameToMatch: partner.fullName }, `rider-pan:${partner.id}:${randomUUID()}`);
  let status: RiderKycStatus;
  let errorCode = result.errorCode;
  let score: number | null = null;
  if (result.status === "VERIFIED") {
    const decision = nameDecision(result.matchedName, partner.fullName);
    status = decision.status;
    score = decision.score;
    errorCode = decision.errorCode;
  } else if (result.status === "FAILED" || result.status === "EXPIRED") {
    status = "FAILED";
  } else {
    status = "PENDING";
    errorCode = errorCode ?? "manual_review";
  }

  const row = await saveCheck(
    partner,
    "PAN",
    {
      ...base,
      provider: result.providerId,
      providerRef: result.rawRef,
      nameOnRecord: result.matchedName,
      nameMatchScore: score,
      status,
      errorCode,
      verifiedAt: status === "VERIFIED" ? new Date() : null,
    },
    input,
  );
  // The partner's own PAN column follows the check (encrypted only, SEC-02).
  await db.update(deliveryPartners).set({ panNumberEncrypted: base.numberEncrypted, updatedAt: new Date() }).where(eq(deliveryPartners.id, partner.id));
  await auditCheck(partner, row, userId, "pan");
  return toKycView(row);
}

/** Starts the Aadhaar check: the provider sends an OTP to the Aadhaar-linked mobile. */
/** Legacy OTP method only: refused while rule riderVerification.aadhaarMethod is "digilocker". */
async function requireLegacyOtpMethod(): Promise<void> {
  if ((await getRule("riderVerification")).aadhaarMethod !== "okyc_legacy") {
    throw conflict("Aadhaar is now verified through DigiLocker. Use \"Verify with DigiLocker\".");
  }
}

export async function requestMyAadhaarOtp(userId: string, input: { aadhaar: string } & Consent): Promise<RiderKycCheckView> {
  requireConsent(input);
  await requireLegacyOtpMethod();
  const partner = await myPartner(userId);
  const digits = normaliseAadhaarInput(input.aadhaar ?? "");
  if (!/^\d{12}$/.test(digits) || !looksLikeAadhaar(digits)) {
    const message = "Enter the 12-digit Aadhaar number as printed on your card.";
    throw validationFailed(message, { fields: { aadhaar: message } });
  }
  const token = docBlindIndex("RIDER_AADHAAR", digits);
  const existing = await currentCheck(partner.id, "AADHAAR");
  if (existing?.status === "VERIFIED" && existing.numberToken === token) return toKycView(existing);
  if (existing?.otpRequestedAt && Date.now() - existing.otpRequestedAt.getTime() < AADHAAR_OTP_COOLDOWN_SECONDS * 1000) {
    throw conflict(`Wait a minute before asking for another OTP.`);
  }

  // Never the number itself: masked and tokenised only (the table refuses anything else).
  const base = {
    numberMasked: maskAadhaar(digits),
    numberToken: token,
    numberEncrypted: null,
    otpAttempts: 0,
    verifiedAt: null,
    nameOnRecord: null,
    nameMatchScore: null,
    method: "okyc_legacy" as const,
    ...NO_SESSION,
  };
  if (await verifiedElsewhere(partner.id, "AADHAAR", token)) {
    const row = await saveCheck(partner, "AADHAAR", { ...base, provider: "none", status: "FAILED", errorCode: "already_used", otpReference: null, otpRequestedAt: null }, input);
    await auditCheck(partner, row, userId, "aadhaar_otp");
    return toKycView(row);
  }

  let provider = "none";
  let outcome: Awaited<ReturnType<NonNullable<ReturnType<typeof getKycAdapter>["aadhaar"]>["requestOtp"]>> | null = null;
  let errorCode: string | null = null;
  try {
    const adapter = getKycAdapter();
    provider = adapter.id;
    if (!adapter.aadhaar) errorCode = "vendor_unsupported";
    else outcome = await adapter.aadhaar.requestOtp(digits, `rider-aadhaar:${partner.id}:${randomUUID()}`);
  } catch (error) {
    if (error instanceof KycUnavailableError) errorCode = `vendor_${error.code}`;
    else if (error instanceof KycConfigError) {
      console.error(`[rider-kyc] ${provider} aadhaar otp: ${error.code} — ${error.message}`);
      errorCode = `config_${error.code}`;
    } else throw error;
  }

  const now = new Date();
  const values =
    outcome?.kind === "sent"
      ? { status: "PENDING" as const, errorCode: "otp_sent", otpReference: outcome.referenceId, otpRequestedAt: now, providerRef: outcome.providerRef }
      : outcome?.kind === "not_found"
        ? { status: "FAILED" as const, errorCode: "not_found_at_source", otpReference: null, otpRequestedAt: now, providerRef: outcome.providerRef }
        : { status: "PENDING" as const, errorCode: outcome?.kind === "unsupported" ? "vendor_unsupported" : errorCode, otpReference: null, otpRequestedAt: now, providerRef: null };
  const row = await saveCheck(partner, "AADHAAR", { ...base, provider, ...values }, input);
  await auditCheck(partner, row, userId, "aadhaar_otp");
  return toKycView(row);
}

/** Finishes the Aadhaar check with the OTP the partner received. */
export async function confirmMyAadhaarOtp(userId: string, otp: string): Promise<RiderKycCheckView> {
  await requireLegacyOtpMethod();
  const partner = await myPartner(userId);
  const check = await currentCheck(partner.id, "AADHAAR");
  if (!check || check.status !== "PENDING" || !check.otpReference) {
    throw conflict("Ask for an Aadhaar OTP first.");
  }
  const code = (otp ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw validationFailed("Enter the 6-digit OTP.", { fields: { otp: "Enter the 6-digit OTP." } });
  const maxAttempts = (await getRule("riderVerification")).aadhaarOtpMaxAttempts;

  const adapter = getKycAdapter();
  if (!adapter.aadhaar) throw conflict("Aadhaar can't be checked online right now. Our team will verify it by hand.");
  let outcome: Awaited<ReturnType<typeof adapter.aadhaar.verifyOtp>>;
  try {
    outcome = await adapter.aadhaar.verifyOtp(check.otpReference, code, `rider-aadhaar-verify:${check.id}:${randomUUID()}`);
  } catch (error) {
    if (error instanceof KycUnavailableError || error instanceof KycConfigError) {
      const [row] = await db
        .update(deliveryPartnerKycChecks)
        .set({ errorCode: error instanceof KycUnavailableError ? `vendor_${error.code}` : `config_${error.code}`, updatedAt: new Date() })
        .where(eq(deliveryPartnerKycChecks.id, check.id))
        .returning();
      return toKycView(row);
    }
    throw error;
  }

  const now = new Date();
  let set: CheckWrite;
  if (outcome.kind === "verified") {
    const decision = nameDecision(outcome.name, partner.fullName);
    set = {
      status: decision.status,
      nameOnRecord: outcome.name,
      nameMatchScore: decision.score,
      errorCode: decision.errorCode,
      providerRef: outcome.providerRef,
      otpReference: null,
      verifiedAt: decision.status === "VERIFIED" ? now : null,
    };
  } else if (outcome.kind === "invalid_otp") {
    const attempts = check.otpAttempts + 1;
    set = attempts >= maxAttempts ? { otpAttempts: attempts, otpReference: null, errorCode: "otp_locked" } : { otpAttempts: attempts, errorCode: "otp_invalid" };
  } else if (outcome.kind === "expired") {
    set = { otpReference: null, errorCode: "otp_expired" };
  } else {
    set = { otpReference: null, errorCode: "vendor_unsupported" };
  }
  const [row] = await db
    .update(deliveryPartnerKycChecks)
    .set({ ...set, updatedAt: now })
    .where(eq(deliveryPartnerKycChecks.id, check.id))
    .returning();
  await auditCheck(partner, row, userId, "aadhaar_verify");
  return toKycView(row);
}

/* ------------------------------------------------------- Aadhaar by DigiLocker */

function siteBase(): string {
  return (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/+$/, "");
}

/** The partner's next step for an Aadhaar check: open DigiLocker (a fresh or still-valid link), or nothing. */
export interface DigilockerStart {
  check: RiderKycCheckView;
  /** The DigiLocker page to open; null when there is nothing to open (already Verified, or the provider can't). */
  url: string | null;
}

type DigilockerSource = "kyc_provider" | "mock";

function adapterFor(source: DigilockerSource): { providerId: KycProviderId; adapter: DigilockerAdapter | null } {
  return getDigilockerAdapter(source);
}

function vendorErrorCode(error: unknown, providerId: string, step: string): string {
  if (error instanceof KycUnavailableError) return `vendor_${error.code}`;
  if (error instanceof KycConfigError) {
    console.error(`[rider-kyc] ${providerId} digilocker ${step}: ${error.code} — ${error.message}`);
    return `config_${error.code}`;
  }
  throw error;
}

/**
 * Starts a DigiLocker session for the partner's Aadhaar and stores it on their
 * one Aadhaar check (Pending). `app`: the app build's URL scheme when the
 * partner is in the GoKesari app, so the return link hands back to the app.
 */
async function startDigilockerSession(
  partner: DeliveryPartner,
  consent: Consent,
  app: MobileAppScheme | null,
  actorId: string,
  step: string,
): Promise<DigilockerStart> {
  const rule = await getRule("riderVerification");
  // Random, plus the app build to hand back to (decided here, never taken from the return request).
  const returnKey = `${randomBytes(18).toString("base64url")}${app ? `.${app}` : ""}`;
  const redirect = new URL(`${siteBase()}${DIGILOCKER_RETURN_PATH}`);
  redirect.searchParams.set("k", returnKey);
  const expiresAt = new Date(Date.now() + DIGILOCKER_CONSENT_MS);

  let providerId: string = rule.digilockerProvider === "mock" ? "mock" : getEnv().KYC_PROVIDER;
  let values: CheckWrite & { provider: string };
  try {
    const picked = adapterFor(rule.digilockerProvider);
    providerId = picked.providerId;
    if (!picked.adapter) {
      values = { provider: providerId, status: "PENDING", errorCode: "vendor_unsupported", ...NO_SESSION };
    } else {
      const session = await picked.adapter.startSession(
        { redirectUrl: redirect.toString(), consentExpiryMs: expiresAt.getTime() },
        `rider-digilocker:${partner.id}:${randomUUID()}`,
      );
      values = {
        provider: providerId,
        status: "PENDING",
        errorCode: "digilocker_started",
        providerRef: session.providerRef,
        sessionId: session.sessionId,
        sessionStatus: "created",
        sessionUrl: session.authorizationUrl,
        sessionExpiresAt: expiresAt,
        sessionReturnKey: returnKey,
      };
    }
  } catch (error) {
    values = { provider: providerId, status: "PENDING", errorCode: vendorErrorCode(error, providerId, "start"), ...NO_SESSION };
  }

  const row = await saveCheck(
    partner,
    "AADHAAR",
    {
      numberMasked: DIGILOCKER_PENDING_MASK,
      // A placeholder until DigiLocker answers: unique, so it can never match another partner's token.
      numberToken: `pending:${randomUUID()}`,
      numberEncrypted: null,
      nameOnRecord: null,
      nameMatchScore: null,
      otpReference: null,
      otpRequestedAt: null,
      otpAttempts: 0,
      verifiedAt: null,
      method: "digilocker",
      providerRef: null,
      ...values,
    },
    consent,
  );
  await auditCheck(partner, row, actorId, step);
  return { check: toKycView(row), url: row.sessionUrl };
}

/** "Verify with DigiLocker": a link to DigiLocker for the partner's Aadhaar (after consent). */
export async function startMyAadhaarDigilocker(userId: string, input: Consent & { app?: string | null }): Promise<DigilockerStart> {
  requireConsent(input);
  const partner = await myPartner(userId);
  if ((await getRule("riderVerification")).aadhaarMethod !== "digilocker") {
    throw conflict("Aadhaar is checked by OTP on this site. Enter your Aadhaar number to get an OTP.");
  }
  const existing = await currentCheck(partner.id, "AADHAAR");
  if (existing?.status === "VERIFIED") return { check: toKycView(existing), url: null };
  const app = isMobileAppScheme(input.app) ? input.app : null;
  // A link DigiLocker will still open is handed out again (a second tap, a reload), unless it
  // returns to the browser and the partner is now in the app (or the other way round).
  if (
    existing &&
    digilockerOpen(existing) &&
    (existing.sessionExpiresAt?.getTime() ?? 0) - Date.now() > DIGILOCKER_REUSE_MIN_LEFT_MS &&
    digilockerReturnApp(existing.sessionReturnKey) === app
  ) {
    return { check: toKycView(existing), url: existing.sessionUrl };
  }
  return startDigilockerSession(partner, input, app, userId, "aadhaar_digilocker_start");
}

/** The app build a return key hands back to; null for a browser. */
export function digilockerReturnApp(returnKey: string | null | undefined): MobileAppScheme | null {
  const suffix = returnKey?.split(".")[1] ?? null;
  return isMobileAppScheme(suffix) ? suffix : null;
}

export type DigilockerSyncTrigger = "poll" | "webhook" | "return" | "admin";

/**
 * Asks the provider where the check's DigiLocker session stands and settles
 * the check: Verified, Pending for an admin (name mismatch, unreadable
 * document, provider down) or Failed (consent declined, link expired, no
 * Aadhaar shared, already verified for another partner). Idempotent — the
 * webhook, the return link and polling may all arrive; the update only applies
 * while the check is still Pending on the same session, so the second one is a
 * no-op. Never throws for a provider problem.
 */
export async function syncDigilockerCheck(check: DeliveryPartnerKycCheck, trigger: DigilockerSyncTrigger): Promise<DeliveryPartnerKycCheck> {
  if (check.docType !== "AADHAAR" || check.method !== "digilocker" || check.status !== "PENDING" || !check.sessionId) return check;
  const sessionId = check.sessionId;
  const now = new Date();
  const source: DigilockerSource = check.provider === "mock" ? "mock" : "kyc_provider";

  let set: CheckWrite;
  try {
    const { adapter } = adapterFor(source);
    if (!adapter) {
      set = { errorCode: "vendor_unsupported" };
    } else {
      const state = await adapter.sessionStatus(sessionId);
      if (!state) {
        set = { status: "FAILED", errorCode: "digilocker_expired", sessionStatus: "expired" };
      } else if (state.status === "created") {
        const expired = (check.sessionExpiresAt?.getTime() ?? 0) <= now.getTime();
        set = expired
          ? { status: "FAILED", errorCode: "digilocker_expired", sessionStatus: "expired" }
          : { errorCode: "digilocker_started", sessionStatus: "created" };
      } else if (state.status === "failed") {
        set = { status: "FAILED", errorCode: "digilocker_denied", sessionStatus: "failed" };
      } else if (state.status === "expired") {
        set = { status: "FAILED", errorCode: "digilocker_expired", sessionStatus: "expired" };
      } else if (!state.documentsConsented.includes("aadhaar")) {
        set = { status: "FAILED", errorCode: "digilocker_no_aadhaar", sessionStatus: "succeeded" };
      } else {
        set = await settleSharedAadhaar(check, adapter, sessionId, now);
      }
    }
  } catch (error) {
    set = { errorCode: vendorErrorCode(error, check.provider, "sync") };
  }

  const final = set.status === "VERIFIED" || set.status === "FAILED";
  const [row] = await db
    .update(deliveryPartnerKycChecks)
    .set({ ...set, ...(final ? { sessionUrl: null } : {}), updatedAt: now })
    .where(
      and(
        eq(deliveryPartnerKycChecks.id, check.id),
        eq(deliveryPartnerKycChecks.sessionId, sessionId),
        eq(deliveryPartnerKycChecks.status, "PENDING"),
      ),
    )
    .returning();
  if (!row) {
    // Settled meanwhile by another trigger (webhook and return link together), or a new session started.
    return (await db.query.deliveryPartnerKycChecks.findFirst({ where: eq(deliveryPartnerKycChecks.id, check.id) })) ?? check;
  }
  if (row.status !== check.status || row.errorCode !== check.errorCode) {
    const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, row.deliveryPartnerId) });
    if (partner) {
      await auditCheck(partner, row, partner.userId, `aadhaar_digilocker_${trigger}`);
      // The partner may have closed the page: tell them how it ended.
      if (final && trigger !== "return") {
        await notify({
          userId: partner.userId,
          type: NOTIFICATION_TYPES.DELIVERY_PARTNER_KYC_DECIDED,
          title: row.status === "VERIFIED" ? "Your Aadhaar is verified" : "Your Aadhaar could not be verified yet",
          body: row.status === "VERIFIED" ? `Verified through DigiLocker (${row.numberMasked}).` : (riderKycReason(row.errorCode) ?? "Open the page to try again."),
          actionUrl: "/delivery-partner/kyc",
        });
      }
    }
  }
  return row;
}

/** The session succeeded with the Aadhaar consented: read it and decide. */
async function settleSharedAadhaar(check: DeliveryPartnerKycCheck, adapter: DigilockerAdapter, sessionId: string, now: Date): Promise<CheckWrite> {
  const outcome = await adapter.fetchAadhaar(sessionId);
  if (outcome.kind === "session_unusable") return { status: "FAILED", errorCode: "digilocker_expired", sessionStatus: "expired" };
  if (outcome.kind === "not_shared") return { status: "FAILED", errorCode: "digilocker_no_aadhaar", sessionStatus: "succeeded", providerRef: outcome.providerRef };

  const base: CheckWrite = { sessionStatus: "succeeded", providerRef: outcome.providerRef, nameOnRecord: outcome.name };
  if (!outcome.holderId || !outcome.last4) {
    // Shared, but not readable as expected: an admin compares the card by hand.
    return {
      ...base,
      numberMasked: outcome.last4 ? maskAadhaar(outcome.last4) : DIGILOCKER_PENDING_MASK,
      ...(outcome.holderId ? { numberToken: docBlindIndex("RIDER_AADHAAR_DIGILOCKER", outcome.holderId) } : {}),
      errorCode: "digilocker_unreadable",
    };
  }
  // The DigiLocker account id, keyed — the Aadhaar number itself never reaches us.
  const token = docBlindIndex("RIDER_AADHAAR_DIGILOCKER", outcome.holderId);
  const identity: CheckWrite = { ...base, numberMasked: maskAadhaar(outcome.last4), numberToken: token };
  if (await verifiedElsewhere(check.deliveryPartnerId, "AADHAAR", token)) {
    return { ...identity, status: "FAILED", errorCode: "already_used" };
  }
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, check.deliveryPartnerId) });
  const decision = nameDecision(outcome.name, partner?.fullName ?? "");
  return {
    ...identity,
    status: decision.status,
    nameMatchScore: decision.score,
    errorCode: decision.errorCode,
    verifiedAt: decision.status === "VERIFIED" ? now : null,
  };
}

/** The partner's own polling (the KYC page after returning from DigiLocker). */
export async function syncMyAadhaarDigilocker(userId: string): Promise<RiderKycCheckView | null> {
  const partner = await myPartner(userId);
  const check = await currentCheck(partner.id, "AADHAAR");
  if (!check) return null;
  return toKycView(await syncDigilockerCheck(check, "poll"));
}

/** Sandbox's session webhook: the payload only names the session; its status is read from Sandbox again. */
export async function handleDigilockerWebhook(sessionId: string): Promise<"settled" | "pending" | "unknown_session"> {
  const check = await db.query.deliveryPartnerKycChecks.findFirst({ where: eq(deliveryPartnerKycChecks.sessionId, sessionId) });
  if (!check) return "unknown_session";
  const row = await syncDigilockerCheck(check, "webhook");
  return row.status === "PENDING" ? "pending" : "settled";
}

/**
 * DigiLocker sent the partner back to our return link (in a browser that may
 * not be signed in — the app's in-app browser never is). The random key finds
 * the check; nothing about the partner is shown, only where to go next.
 */
export async function handleDigilockerReturn(returnKey: string): Promise<{ status: RiderKycStatus | null; app: MobileAppScheme | null }> {
  if (!/^[A-Za-z0-9_-]{16,40}(\.[a-z-]{1,24})?$/.test(returnKey)) return { status: null, app: null };
  const check = await db.query.deliveryPartnerKycChecks.findFirst({ where: eq(deliveryPartnerKycChecks.sessionReturnKey, returnKey) });
  if (!check) return { status: null, app: null };
  const row = await syncDigilockerCheck(check, "return");
  return { status: row.status, app: digilockerReturnApp(returnKey) };
}

/** The open DigiLocker link of the partner's own check (the "resend link" notification opens this). */
export async function myOpenDigilockerUrl(userId: string): Promise<string | null> {
  const partner = await myPartner(userId);
  const check = await currentCheck(partner.id, "AADHAAR");
  return check && digilockerOpen(check) ? check.sessionUrl : null;
}

/**
 * Admin: a new DigiLocker link for a partner whose check is Pending or Failed
 * (link expired, provider was down, settings fixed). The partner's recorded
 * consent stands; they get a notification that opens the new link.
 */
export async function resendDigilockerLink(checkId: string, actor: Actor): Promise<RiderKycCheckView> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can resend a DigiLocker link.");
  const check = await db.query.deliveryPartnerKycChecks.findFirst({ where: eq(deliveryPartnerKycChecks.id, checkId) });
  if (!check) throw notFound("KYC check");
  if (check.docType !== "AADHAAR") throw conflict("Only an Aadhaar check uses DigiLocker.");
  if (check.status === "VERIFIED") throw conflict("This Aadhaar is already verified.");
  if ((await getRule("riderVerification")).aadhaarMethod !== "digilocker") throw conflict("Aadhaar is checked by OTP on this site (rule riderVerification.aadhaarMethod).");
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, check.deliveryPartnerId) });
  if (!partner || partner.deletedAt) throw notFound("Delivery partner profile");
  const started = await startDigilockerSession(partner, { consentGiven: true, ipAddress: check.consentIp }, null, actor.id, "aadhaar_digilocker_resend");
  if (started.url) {
    await db
      .update(deliveryPartnerKycChecks)
      .set({ errorCode: "digilocker_resent" })
      .where(and(eq(deliveryPartnerKycChecks.id, started.check.id), eq(deliveryPartnerKycChecks.status, "PENDING")));
    await notify({
      userId: partner.userId,
      type: NOTIFICATION_TYPES.DELIVERY_PARTNER_KYC_DECIDED,
      title: "Finish your Aadhaar check in DigiLocker",
      body: "Our team sent you a new DigiLocker link. It works for about an hour.",
      actionUrl: "/delivery-partner/kyc/digilocker/open",
    });
  }
  const row = await db.query.deliveryPartnerKycChecks.findFirst({ where: eq(deliveryPartnerKycChecks.id, started.check.id) });
  return toKycView(row!);
}

/** PAN and Aadhaar both Verified — half of the availability gate (rider-availability.ts). */
export async function isRiderKycComplete(partnerId: string): Promise<boolean> {
  const rows = await db
    .select({ docType: deliveryPartnerKycChecks.docType })
    .from(deliveryPartnerKycChecks)
    .where(and(eq(deliveryPartnerKycChecks.deliveryPartnerId, partnerId), eq(deliveryPartnerKycChecks.status, "VERIFIED")));
  const verified = new Set(rows.map((r) => r.docType));
  return verified.has("PAN") && verified.has("AADHAAR");
}

/* -------------------------------------------------------------------- admin */

export interface AdminRiderKycCheck extends RiderKycCheckView {
  /** Why it is Pending or Failed, for the admin (what to do, which setting). */
  adminReason: string | null;
  /** DigiLocker: Sandbox's last known session status (created / succeeded / failed / expired). */
  sessionStatus: string | null;
  sessionExpiresAt: Date | null;
  /** An admin may send the partner a new DigiLocker link. */
  canResend: boolean;
  deliveryPartnerId: string;
  riderName: string;
  riderMobile: string;
  nameOnRecord: string | null;
  nameMatchScore: number | null;
  provider: string;
  consentVersion: string;
  consentGivenAt: Date;
}

export async function listRiderKycChecksForAdmin(actor: Actor, status?: RiderKycStatus): Promise<AdminRiderKycCheck[]> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can see rider KYC checks.");
  const rows = await db
    .select({ check: deliveryPartnerKycChecks, name: deliveryPartners.fullName, mobile: deliveryPartners.mobile })
    .from(deliveryPartnerKycChecks)
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryPartnerKycChecks.deliveryPartnerId))
    .where(status ? eq(deliveryPartnerKycChecks.status, status) : undefined)
    .orderBy(desc(deliveryPartnerKycChecks.updatedAt))
    .limit(300);
  const { aadhaarMethod } = await getRule("riderVerification");
  return rows.map(({ check, name, mobile }) => ({
    ...toKycView(check),
    adminReason: check.status === "VERIFIED" ? null : (check.reviewNote ?? riderKycAdminReason(check.errorCode, check.provider)),
    sessionStatus: check.sessionStatus,
    sessionExpiresAt: check.sessionExpiresAt,
    canResend: check.docType === "AADHAAR" && check.status !== "VERIFIED" && aadhaarMethod === "digilocker",
    deliveryPartnerId: check.deliveryPartnerId,
    riderName: name,
    riderMobile: mobile,
    nameOnRecord: check.nameOnRecord,
    nameMatchScore: check.nameMatchScore,
    provider: check.provider,
    consentVersion: check.consentVersion,
    consentGivenAt: check.consentGivenAt,
  }));
}

/** An admin settles a Pending (or corrects any) check by hand, e.g. after comparing the uploaded card. */
export async function decideRiderKycCheck(
  checkId: string,
  decision: "VERIFIED" | "FAILED",
  note: string,
  actor: Actor,
): Promise<RiderKycCheckView> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can decide a rider KYC check.");
  const why = note?.trim() ?? "";
  if (why.length < 3) throw validationFailed("Say why, for the record.");
  const current = await db.query.deliveryPartnerKycChecks.findFirst({ where: eq(deliveryPartnerKycChecks.id, checkId) });
  if (!current) throw notFound("KYC check");
  if (decision === "VERIFIED" && (await verifiedElsewhere(current.deliveryPartnerId, current.docType, current.numberToken))) {
    throw conflict("This number is already verified for another delivery partner.");
  }
  const now = new Date();
  const [row] = await db
    .update(deliveryPartnerKycChecks)
    .set({
      status: decision,
      errorCode: decision === "VERIFIED" ? null : (current.errorCode ?? "manual_review"),
      // An Aadhaar settled by hand is recorded as such (the DigiLocker or OTP attempt is in the audit log).
      ...(current.docType === "AADHAAR" ? { method: "manual" as const, sessionUrl: null } : {}),
      otpReference: null,
      verifiedAt: decision === "VERIFIED" ? now : null,
      reviewedBy: actor.id,
      reviewedAt: now,
      reviewNote: why,
      updatedAt: now,
    })
    .where(eq(deliveryPartnerKycChecks.id, checkId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_KYC_DECIDED,
    entityType: "delivery_partner",
    entityId: current.deliveryPartnerId,
    previousValue: { docType: current.docType, status: current.status },
    newValue: { docType: current.docType, status: decision, note: why },
  });
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, current.deliveryPartnerId) });
  if (partner) {
    const label = current.docType === "PAN" ? "PAN" : "Aadhaar";
    await notify({
      userId: partner.userId,
      type: NOTIFICATION_TYPES.DELIVERY_PARTNER_KYC_DECIDED,
      title: decision === "VERIFIED" ? `Your ${label} is verified` : `Your ${label} could not be verified`,
      body: decision === "VERIFIED" ? `Our team verified your ${label} (${current.numberMasked}).` : why,
      actionUrl: "/delivery-partner/kyc",
    });
  }
  return toKycView(row);
}
