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
 *  - Aadhaar: OTP to the Aadhaar-linked mobile through the adapter's
 *    `aadhaar` half. The number is NEVER stored — only a masked form and a
 *    keyed token (blind index) that finds the same Aadhaar on another
 *    partner; a database check refuses an Aadhaar row with a stored number.
 *  - Verified / Pending / Failed per document. Pending covers "OTP sent",
 *    "the vendor can't check this" and "name doesn't match" — an admin then
 *    decides by hand (`decideRiderKycCheck`).
 *
 * Vendor calls happen outside any transaction; a vendor outage leaves the
 * check Pending, never Failed.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, ne } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  maskAadhaar,
  maskRiderPan,
  normaliseAadhaarInput,
  RIDER_KYC_CONSENT_VERSION,
  riderKycReason,
  type RiderKycStatus,
} from "@/lib/gig/kyc";
import { looksLikeAadhaar } from "@/lib/kyc/doc-formats";
import { nameMatchScore } from "@/lib/kyc/name-match";
import { checkRiderPan } from "@/lib/kyc/rider-details";
import { docBlindIndex, encryptSecret } from "@/lib/pan-crypto";
import { getKycAdapter, KycConfigError, KycUnavailableError, verifyDocument } from "@/server/kyc";
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

export interface RiderKycCheckView {
  id: string;
  docType: DocType;
  status: RiderKycStatus;
  numberMasked: string;
  /** Why it is Pending or Failed, in the partner's words; null when Verified. */
  reason: string | null;
  errorCode: string | null;
  /** Aadhaar: an OTP was sent and is waiting to be entered. */
  awaitingOtp: boolean;
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
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
  };
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
  const [pan, aadhaar] = await Promise.all([currentCheck(partner.id, "PAN"), currentCheck(partner.id, "AADHAAR")]);
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
export async function requestMyAadhaarOtp(userId: string, input: { aadhaar: string } & Consent): Promise<RiderKycCheckView> {
  requireConsent(input);
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
  const base = { numberMasked: maskAadhaar(digits), numberToken: token, numberEncrypted: null, otpAttempts: 0, verifiedAt: null, nameOnRecord: null, nameMatchScore: null };
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
  return rows.map(({ check, name, mobile }) => ({
    ...toKycView(check),
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
