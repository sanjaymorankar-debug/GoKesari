/**
 * Delivery partner registration & verification (delivery-system Part 58
 * follow-up, Slice B).
 *
 * Deliberately scoped to registration and the verification state machine
 * only — no online/offline status, no assignment, no earnings. Those need
 * deliveryOrders/deliveryPartnerEarnings (Slice C) to attach to and would be
 * premature here. Mirrors shops.ts's registration/approval pattern closely:
 * self-service create (with a role promotion, same as SHOP_OWNER), admin-
 * gated status transitions, every transition audited.
 *
 * State machine: REGISTERED → UNDER_REVIEW → APPROVED/REJECTED → SUSPENDED
 * (from APPROVED) → APPROVED (reactivate) → DEACTIVATED (terminal, from
 * anywhere non-terminal). Only APPROVED partners will be eligible for
 * delivery assignment once Slice C exists.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { checkRegistrationDetails, REGISTRATION_MESSAGES } from "@/lib/gig/registration";
import { checkRiderDetails, isAadhaarIdType } from "@/lib/kyc/rider-details";
import { RIDER_IDLE_CAP_MINUTES } from "@/lib/rider-sessions";
import { VEHICLE_TYPE_KEYS, type VehicleTypeKey } from "@/lib/vehicle-types";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartnerDocuments,
  deliveryPartnerSessions,
  deliveryPartners,
  type DeliveryPartner,
  type DeliveryPartnerStatus,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { assertRiderPhotoUrl, RIDER_IDENTITY_DOC_TYPES } from "./rider-files";
import { ACTIVE_ASSIGNMENT_STATUSES } from "./delivery-eligibility";
import { grantRole } from "./roles";
import { encryptKycInput, toPublicPartner, type PublicDeliveryPartner } from "./delivery-partner-kyc";
import { resolveLocationVerification } from "./geocoding";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

export interface RegisterDeliveryPartnerInput {
  fullName: string;
  mobile: string;
  email?: string | null;
  dateOfBirth?: string | null;
  profilePhotoUrl?: string | null;

  panNumber?: string | null;
  governmentIdType?: string | null;
  governmentIdNumber?: string | null;
  bankAccountHolderName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;

  vehicleType: VehicleTypeKey;
  vehicleRegistrationNumber?: string | null;
  drivingLicenceNumber?: string | null;

  latitude?: number | null;
  longitude?: number | null;
  operatingRadiusKm?: number;

  /* Gig worker flow (feature 1). Required through the registration API ({ required: true }). */
  gender?: string | null;
  addressLine?: string | null;
  addressCity?: string | null;
  addressPincode?: string | null;
  emergencyContactName?: string | null;
  emergencyContactMobile?: string | null;
  emergencyContactRelation?: string | null;
}

export interface RegisterOptions {
  /**
   * The registration form and API: every detail of the gig worker brief is
   * mandatory, including the device location (feature 4). Off for internal
   * callers (tests, scripts), which still get every format check.
   */
  required?: boolean;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Checks the application; returns the identity, bank and vehicle details normalised for storage. */
function validate(input: RegisterDeliveryPartnerInput, options: RegisterOptions = {}) {
  if (!input.fullName.trim()) throw validationFailed("Enter your full name.");
  if (!/^[6-9]\d{9}$/.test(input.mobile)) {
    throw validationFailed("Enter a valid 10-digit Indian mobile number.");
  }
  if (!(VEHICLE_TYPE_KEYS as readonly string[]).includes(input.vehicleType)) {
    throw validationFailed("Select a valid vehicle type.");
  }
  if (
    input.operatingRadiusKm !== undefined &&
    (!Number.isFinite(input.operatingRadiusKm) || input.operatingRadiusKm <= 0)
  ) {
    throw validationFailed("Operating radius must be a positive number.");
  }
  // TC-FLD-091/092/093: the same PAN, Aadhaar, bank and vehicle-number rules
  // as the rider's own profile edit and change request (lib/kyc/rider-details.ts).
  const details = checkRiderDetails({
    panNumber: input.panNumber ?? null,
    governmentIdType: input.governmentIdType,
    governmentIdNumber: input.governmentIdNumber ?? null,
    bankAccountNumber: input.bankAccountNumber ?? null,
    bankIfsc: input.bankIfsc ?? null,
    vehicleRegistrationNumber: input.vehicleRegistrationNumber ?? null,
  });
  if (!details.ok) throw validationFailed(details.message, { fields: details.fields });
  // Gig worker flow (feature 2): the Aadhaar number is checked on the KYC step and kept masked and
  // tokenised only, never taken here (where it would be stored, encrypted, in full).
  if (isAadhaarIdType(input.governmentIdType) && input.governmentIdNumber?.trim()) {
    const message = "Don't enter your Aadhaar number here. Verify it with an OTP on the KYC step after you register; GoKesari keeps only a masked form.";
    throw validationFailed(message, { fields: { governmentIdNumber: message } });
  }
  const fieldErrors = checkRegistrationDetails(input, { required: Boolean(options.required), today: todayIso() });
  const first = Object.values(fieldErrors)[0];
  if (first) throw validationFailed(first, { fields: fieldErrors });
  return details.values;
}

const clean = (value: string | null | undefined) => value?.trim() || null;

/**
 * Self-service registration. Promotes a plain CUSTOMER to DELIVERY_PARTNER —
 * same pattern as registering a shop promotes CUSTOMER to SHOP_OWNER — so
 * they can see their own application/profile even before it's reviewed.
 * Being APPROVED (not just holding the role) is what will gate delivery
 * assignment once that exists.
 */
export async function registerDeliveryPartner(
  userId: string,
  input: RegisterDeliveryPartnerInput,
  options: RegisterOptions = {},
): Promise<PublicDeliveryPartner> {
  const details = validate(input, options);

  const existing = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.userId, userId), isNull(deliveryPartners.deletedAt)),
  });
  if (existing) {
    throw conflict("You have already applied to become a delivery partner.");
  }
  // Gig worker flow (feature 1): one partner per mobile number, across accounts.
  const [sameMobile] = await db
    .select({ id: deliveryPartners.id })
    .from(deliveryPartners)
    .where(and(eq(deliveryPartners.mobile, input.mobile), isNull(deliveryPartners.deletedAt)))
    .limit(1);
  if (sameMobile) {
    throw conflict(REGISTRATION_MESSAGES.duplicateMobile, { fields: { mobile: REGISTRATION_MESSAGES.duplicateMobile } });
  }

  // SEC-02: KYC and bank details are stored as ciphertext only. Encrypted up
  // front so a missing key fails the application before anything is written.
  const encryptedKyc = encryptKycInput({ ...input, ...details });
  // C5: a photo given at application must be the applicant's own upload.
  await assertRiderPhotoUrl(input.profilePhotoUrl || null, userId);

  const { locationVerified, locationVerifiedAt, locationSource } =
    await resolveLocationVerification(input.latitude, input.longitude, "delivery_partner_registration", "delivery_partner");

  const [partner] = await db
    .insert(deliveryPartners)
    .values({
      userId,
      statusActorId: userId,
      fullName: input.fullName.trim(),
      mobile: input.mobile,
      email: input.email?.trim() || null,
      dateOfBirth: input.dateOfBirth || null,
      profilePhotoUrl: input.profilePhotoUrl || null,
      gender: clean(input.gender),
      addressLine: clean(input.addressLine),
      addressCity: clean(input.addressCity),
      addressPincode: clean(input.addressPincode),
      emergencyContactName: clean(input.emergencyContactName),
      emergencyContactMobile: clean(input.emergencyContactMobile),
      emergencyContactRelation: clean(input.emergencyContactRelation),
      registrationLocationAt: input.latitude != null && input.longitude != null ? new Date() : null,
      governmentIdType: input.governmentIdType?.trim() || null,
      ...encryptedKyc,
      vehicleType: input.vehicleType,
      vehicleRegistrationNumber: details.vehicleRegistrationNumber ?? null,
      latitude: input.latitude != null ? String(input.latitude) : null,
      longitude: input.longitude != null ? String(input.longitude) : null,
      operatingRadiusKm: input.operatingRadiusKm ?? 5,
      locationVerified,
      locationVerifiedAt,
      locationSource,
      status: "REGISTERED",
    })
    .returning();

  // A plain customer applying becomes DELIVERY_PARTNER immediately, the same
  // way shop registration promotes to SHOP_OWNER — operators/admins keep
  // their higher role.
  // GS-003: granted alongside any role already held (a shop owner can also deliver).
  await grantRole(userId, "DELIVERY_PARTNER", {
    source: "DELIVERY_PARTNER_APPLICATION",
    grantedBy: userId,
    activateIfCustomer: true,
  });

  await recordAudit({
    actorId: userId,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_REGISTERED,
    entityType: "delivery_partner",
    entityId: partner.id,
    newValue: { status: "REGISTERED", vehicleType: partner.vehicleType },
  });

  return toPublicPartner(partner);
}

export async function getMyDeliveryPartnerProfile(userId: string): Promise<PublicDeliveryPartner | null> {
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.userId, userId), isNull(deliveryPartners.deletedAt)),
  });
  return partner ? toPublicPartner(partner) : null;
}

export interface DeliveryPartnerFilters {
  status?: DeliveryPartnerStatus;
  limit?: number;
}

export async function listDeliveryPartners(
  filters: DeliveryPartnerFilters = {},
): Promise<PublicDeliveryPartner[]> {
  const conditions = [isNull(deliveryPartners.deletedAt)];
  if (filters.status) conditions.push(eq(deliveryPartners.status, filters.status));

  const rows = await db
    .select()
    .from(deliveryPartners)
    .where(and(...conditions))
    .orderBy(desc(deliveryPartners.createdAt))
    .limit(filters.limit ?? 200);
  return rows.map(toPublicPartner);
}

export async function countDeliveryPartnersByStatus(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: deliveryPartners.status })
    .from(deliveryPartners)
    .where(isNull(deliveryPartners.deletedAt));
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

const TERMINAL_STATUSES: readonly DeliveryPartnerStatus[] = ["DEACTIVATED"];

/**
 * Reads the partner FOR UPDATE inside the transaction, so the terminal-state
 * check, the caller's `guard` and the audited previous value all see the
 * committed row and a concurrent transition or go-online/offline cannot slip
 * in between the check and the write.
 */
async function transition(
  id: string,
  actor: Actor,
  set: Partial<{
    status: DeliveryPartnerStatus;
    reviewNotes: string | null;
    rejectionReason: string | null;
  }>,
  guard?: (current: DeliveryPartner, tx: DbClient) => void | Promise<void>,
): Promise<PublicDeliveryPartner> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(deliveryPartners)
      .where(and(eq(deliveryPartners.id, id), isNull(deliveryPartners.deletedAt)))
      .for("update");
    if (!current) throw notFound("Delivery partner");
    if (TERMINAL_STATUSES.includes(current.status)) {
      throw conflict("This delivery partner has been deactivated and cannot be changed.");
    }
    await guard?.(current, tx);

    // Only an APPROVED partner may be online: leaving APPROVED, or entering it from another status (which also
    // clears an online flag left by an older build), always ends offline.
    const takeOffline = set.status !== undefined && (set.status !== "APPROVED" || current.status !== "APPROVED");
    const now = new Date();
    const [updated] = await tx
      .update(deliveryPartners)
      .set({
        ...set,
        ...(takeOffline ? { isOnline: false, availability: "OFFLINE" as const } : {}),
        reviewedBy: actor.id,
        statusActorId: actor.id,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(deliveryPartners.id, id))
      .returning();

    if (takeOffline) await closeOpenSessions(tx, id, updated.lastLocationAt, now);

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DELIVERY_PARTNER_STATUS_CHANGED,
        entityType: "delivery_partner",
        entityId: id,
        previousValue: { status: current.status, ...(takeOffline ? { isOnline: current.isOnline } : {}) },
        newValue: {
          status: updated.status,
          reviewNotes: updated.reviewNotes,
          // The reason given for a reject, suspension or deactivation (a reactivation's is the review note).
          ...(set.rejectionReason ? { reason: set.rejectionReason } : {}),
          ...(takeOffline ? { isOnline: false } : {}),
        },
      },
      tx,
    );

    return toPublicPartner(updated);
  });
}

/** Marks an application as actively being reviewed (REGISTERED → UNDER_REVIEW). */
export async function startDeliveryPartnerReview(
  id: string,
  actor: Actor,
  notes?: string | null,
): Promise<PublicDeliveryPartner> {
  return transition(id, actor, { status: "UNDER_REVIEW", reviewNotes: notes ?? null });
}

/** Approves an application (from REGISTERED or UNDER_REVIEW). Only APPROVED partners are assignment-eligible once Slice C exists. */
export async function approveDeliveryPartner(
  id: string,
  actor: Actor,
  notes?: string | null,
): Promise<PublicDeliveryPartner> {
  const updated = await transition(
    id,
    actor,
    { status: "APPROVED", reviewNotes: notes ?? null, rejectionReason: null },
    async (current, tx) => {
      // TC-DEL-027: approve was also moving SUSPENDED and REJECTED riders to
      // APPROVED — a suspended rider comes back only through reactivate (with a reason).
      if (current.status !== "REGISTERED" && current.status !== "UNDER_REVIEW") {
        throw conflict(
          current.status === "SUSPENDED"
            ? "This delivery partner is suspended. Reactivate them with a reason instead."
            : "Only an application that is registered or under review can be approved.",
        );
      }
      // D-57 (owner, 25 Oct 2026): no approval without an identity document on file.
      const [identity] = await tx
        .select({ id: deliveryPartnerDocuments.id })
        .from(deliveryPartnerDocuments)
        .where(
          and(
            eq(deliveryPartnerDocuments.deliveryPartnerId, current.id),
            inArray(deliveryPartnerDocuments.docType, [...RIDER_IDENTITY_DOC_TYPES]),
            isNull(deliveryPartnerDocuments.replacedAt),
            ne(deliveryPartnerDocuments.status, "REJECTED"),
          ),
        )
        .limit(1);
      if (!identity) {
        throw conflict(
          "This rider has no identity document on file. Ask them to upload an Aadhaar, PAN, driving licence or other identity document (Profile → Documents) before approving.",
        );
      }
    },
  );

  await notify({
    userId: updated.userId,
    type: NOTIFICATION_TYPES.DELIVERY_PARTNER_APPROVED,
    title: "You're approved as a delivery partner",
    body: "Your application has been approved. Welcome aboard.",
    actionUrl: "/delivery-partner",
  });
  return updated;
}

export async function rejectDeliveryPartner(
  id: string,
  reason: string,
  actor: Actor,
): Promise<PublicDeliveryPartner> {
  if (!reason.trim()) throw validationFailed("A rejection reason is required.");
  const updated = await transition(id, actor, { status: "REJECTED", rejectionReason: reason.trim() });

  await notify({
    userId: updated.userId,
    type: NOTIFICATION_TYPES.DELIVERY_PARTNER_REJECTED,
    title: "Your delivery partner application was not approved",
    body: reason.trim(),
    actionUrl: "/delivery-partner",
  });
  return updated;
}

/** Suspends an approved partner (temporary — reactivate returns them to APPROVED). */
export async function suspendDeliveryPartner(
  id: string,
  reason: string,
  actor: Actor,
): Promise<PublicDeliveryPartner> {
  if (!reason.trim()) throw validationFailed("A suspension reason is required.");
  const updated = await transition(id, actor, { status: "SUSPENDED", rejectionReason: reason.trim() }, (current) => {
    if (current.status !== "APPROVED") {
      throw conflict("Only an approved delivery partner can be suspended.");
    }
  });

  await withdrawOpenOffers(updated.id, "The rider's account was suspended.", actor);
  await notify({
    userId: updated.userId,
    type: NOTIFICATION_TYPES.DELIVERY_PARTNER_SUSPENDED,
    title: "Your delivery partner account has been suspended",
    body: reason.trim(),
    actionUrl: "/delivery-partner",
  });
  return updated;
}

/**
 * TC-DEL-026: once a rider may no longer work, an offer they have not
 * accepted goes to another rider (delivery-assignment.ts withdrawPartnerOffers).
 * After the status change commits; never fails it — an offer left behind
 * cannot be accepted any more and expires on the next sweep.
 */
async function withdrawOpenOffers(partnerId: string, reason: string, actor: Actor): Promise<void> {
  // Imported lazily: delivery-assignment.ts imports this module.
  const { withdrawPartnerOffers } = await import("./delivery-assignment");
  await withdrawPartnerOffers(partnerId, reason, actor).catch((error) => {
    console.error("[delivery-partner] withdrawing open offers failed", partnerId, error);
  });
}

/** SUSPENDED → APPROVED. TC-DEL-027: needs a reason, kept as the review note and in the audit. */
export async function reactivateDeliveryPartner(
  id: string,
  reason: string,
  actor: Actor,
): Promise<PublicDeliveryPartner> {
  const why = reason.trim();
  if (why.length < 3) throw validationFailed("Say why the delivery partner is being reactivated.");
  const updated = await transition(id, actor, { status: "APPROVED", rejectionReason: null, reviewNotes: why }, (current) => {
    if (current.status !== "SUSPENDED") {
      throw conflict("Only a suspended delivery partner can be reactivated.");
    }
  });

  // TC-DEL-015: the rider hears of every review decision, as for approve, reject and suspend.
  await notify({
    userId: updated.userId,
    type: NOTIFICATION_TYPES.DELIVERY_PARTNER_REACTIVATED,
    title: "Your delivery partner account is active again",
    body: "Your suspension has been lifted. Go online to start receiving delivery offers.",
    actionUrl: "/delivery-partner",
  });
  return updated;
}

/** Permanent close-out — e.g. the partner asked to stop, or a serious policy violation. Terminal; no further transitions. */
export async function deactivateDeliveryPartner(
  id: string,
  reason: string,
  actor: Actor,
): Promise<PublicDeliveryPartner> {
  if (!reason.trim()) throw validationFailed("A reason is required.");
  const updated = await transition(id, actor, { status: "DEACTIVATED", rejectionReason: reason.trim() });

  await withdrawOpenOffers(updated.id, "The rider's account was closed.", actor);
  // TC-DEL-015: told like the other decisions.
  await notify({
    userId: updated.userId,
    type: NOTIFICATION_TYPES.DELIVERY_PARTNER_DEACTIVATED,
    title: "Your delivery partner account has been closed",
    body: reason.trim(),
    actionUrl: "/delivery-partner",
  });
  return updated;
}

export async function getDeliveryPartnerById(id: string): Promise<PublicDeliveryPartner> {
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.id, id), isNull(deliveryPartners.deletedAt)),
  });
  if (!partner) throw notFound("Delivery partner");
  return toPublicPartner(partner);
}

/** Ownership guard for self-service routes ("my profile"). */
export async function requireOwnDeliveryPartnerProfile(
  userId: string,
  partnerId: string,
): Promise<PublicDeliveryPartner> {
  const partner = await getDeliveryPartnerById(partnerId);
  if (partner.userId !== userId) throw forbidden("This profile does not belong to you.");
  return partner;
}

function validCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

const RIDER_IDLE_CAP_MS = RIDER_IDLE_CAP_MINUTES * 60_000;

async function lockMyPartner(tx: DbClient, userId: string): Promise<DeliveryPartner | undefined> {
  const [partner] = await tx
    .select()
    .from(deliveryPartners)
    .where(and(eq(deliveryPartners.userId, userId), isNull(deliveryPartners.deletedAt)))
    .for("update");
  return partner;
}

/**
 * KPI-013: ends open sessions at the rider's last sign of life plus the idle
 * cap (never later than `now`, never before the session started), so time the
 * app sat unattended is not counted as online.
 */
async function closeOpenSessions(
  client: DbClient,
  partnerId: string,
  lastLocationAt: Date | null,
  now: Date,
): Promise<void> {
  const startedAt = deliveryPartnerSessions.startedAt;
  const lastSeen = sql`greatest(${lastLocationAt?.toISOString() ?? null}::timestamptz, ${startedAt})`;
  await client
    .update(deliveryPartnerSessions)
    .set({
      endedAt: sql`greatest(${startedAt}, least(${now.toISOString()}::timestamptz, ${lastSeen} + make_interval(mins => ${RIDER_IDLE_CAP_MINUTES})))`,
    })
    .where(and(eq(deliveryPartnerSessions.deliveryPartnerId, partnerId), isNull(deliveryPartnerSessions.endedAt)));
}

/** KPI-013: keeps one open session; after an idle gap longer than the cap, ends it at the gap and starts a new one now. */
async function syncOnlineSession(
  tx: DbClient,
  partnerId: string,
  lastLocationAt: Date | null,
  now: Date,
): Promise<void> {
  const [open] = await tx
    .select({ startedAt: deliveryPartnerSessions.startedAt })
    .from(deliveryPartnerSessions)
    .where(and(eq(deliveryPartnerSessions.deliveryPartnerId, partnerId), isNull(deliveryPartnerSessions.endedAt)))
    .orderBy(desc(deliveryPartnerSessions.startedAt))
    .limit(1);
  if (open) {
    const lastSeen = Math.max(open.startedAt.getTime(), lastLocationAt?.getTime() ?? 0);
    if (now.getTime() - lastSeen <= RIDER_IDLE_CAP_MS) return;
    await closeOpenSessions(tx, partnerId, lastLocationAt, now);
  }
  await tx.insert(deliveryPartnerSessions).values({ deliveryPartnerId: partnerId, startedAt: now });
}

export type RiderAvailability = DeliveryPartner["availability"];

export interface AvailabilityGate {
  /** The partner may switch to Active or Ready. */
  allowed: boolean;
  /** Rule riderVerification.gateAvailability is on. */
  enforced: boolean;
  overridden: boolean;
  kycComplete: boolean;
  backgroundApproved: boolean;
  /** What is still needed, in the partner's words. */
  missing: string[];
}

/**
 * Gig worker flow (feature 5): Active and Ready need PAN and Aadhaar Verified
 * and the police verification form (and character certificate) Approved —
 * unless rule riderVerification.gateAvailability is off or an admin overrode
 * the gate for this partner.
 */
export async function getAvailabilityGate(partner: Pick<DeliveryPartner, "id" | "availabilityOverrideAt">): Promise<AvailabilityGate> {
  const rule = await getRule("riderVerification");
  // Imported lazily, like the offer withdrawal: both modules read deliveryPartners.
  const [{ isRiderKycComplete }, { isRiderBackgroundApproved }] = await Promise.all([import("./rider-kyc"), import("./rider-background-docs")]);
  const [kycComplete, backgroundApproved] = await Promise.all([isRiderKycComplete(partner.id), isRiderBackgroundApproved(partner.id)]);
  const overridden = Boolean(partner.availabilityOverrideAt);
  const missing: string[] = [];
  if (!kycComplete) missing.push("PAN and Aadhaar verified (KYC)");
  if (!backgroundApproved) {
    missing.push(rule.requireCharacterCertificate ? "police verification form and character certificate approved" : "police verification form approved");
  }
  return {
    allowed: !rule.gateAvailability || overridden || missing.length === 0,
    enforced: rule.gateAvailability,
    overridden,
    kycComplete,
    backgroundApproved,
    missing,
  };
}

/**
 * Goes Active or Ready with a current position — gated to APPROVED partners
 * only, so assignment never offers a delivery to someone still under review,
 * and (gig worker flow) to partners who passed the verification gate. Only
 * READY partners get new offers; ACTIVE is on duty without new orders, so a
 * Ready → Active switch hands back any offer not yet accepted. Location comes
 * from the browser's native geolocation; this function never calls any
 * Google Maps Platform service.
 */
export async function goOnline(
  userId: string,
  latitude: number,
  longitude: number,
  availability: Exclude<RiderAvailability, "OFFLINE"> = "READY",
): Promise<PublicDeliveryPartner> {
  if (!validCoordinate(latitude, longitude)) {
    throw validationFailed("A valid current location is required to go online.");
  }

  const result = await db.transaction(async (tx) => {
    const partner = await lockMyPartner(tx, userId);
    if (!partner) throw notFound("Delivery partner profile");
    if (partner.status !== "APPROVED") {
      throw conflict("Only an approved delivery partner can go online.");
    }
    const gate = await getAvailabilityGate(partner);
    if (!gate.allowed) {
      throw conflict(`You can switch to ${availability === "READY" ? "Ready" : "Active"} once you have: ${gate.missing.join("; ")}.`, {
        missing: gate.missing,
      });
    }

    const now = new Date();
    await syncOnlineSession(tx, partner.id, partner.lastLocationAt, now);
    const [updated] = await tx
      .update(deliveryPartners)
      .set({
        isOnline: true,
        availability,
        statusActorId: userId,
        lastLocationLatitude: String(latitude),
        lastLocationLongitude: String(longitude),
        lastLocationAt: now,
        updatedAt: now,
      })
      .where(eq(deliveryPartners.id, partner.id))
      .returning();

    await recordAudit(
      {
        actorId: userId,
        action: AUDIT_ACTIONS.DELIVERY_PARTNER_ONLINE_STATUS_CHANGED,
        entityType: "delivery_partner",
        entityId: partner.id,
        previousValue: { availability: partner.availability },
        newValue: { isOnline: true, availability },
      },
      tx,
    );

    return { partner: toPublicPartner(updated), wasReady: partner.availability === "READY" };
  });
  // No new orders while Active: an offer not yet accepted goes to the next rider.
  if (availability === "ACTIVE" && result.wasReady) {
    await withdrawOpenOffers(result.partner.id, "The rider switched to Active (not taking new orders).", { id: userId, role: "DELIVERY_PARTNER" });
  }
  return result.partner;
}

/** Admin turns the verification gate off (or back on) for one partner, with a reason. */
export async function setAvailabilityOverride(
  partnerId: string,
  enabled: boolean,
  reason: string,
  actor: Actor,
): Promise<PublicDeliveryPartner> {
  const why = reason?.trim() ?? "";
  if (why.length < 3) throw validationFailed("Say why the verification gate is being overridden.");
  const current = await db.query.deliveryPartners.findFirst({ where: and(eq(deliveryPartners.id, partnerId), isNull(deliveryPartners.deletedAt)) });
  if (!current) throw notFound("Delivery partner");
  const now = new Date();
  const [updated] = await db
    .update(deliveryPartners)
    .set(
      enabled
        ? { availabilityOverrideAt: now, availabilityOverrideBy: actor.id, availabilityOverrideReason: why, updatedAt: now }
        : { availabilityOverrideAt: null, availabilityOverrideBy: null, availabilityOverrideReason: why, updatedAt: now },
    )
    .where(eq(deliveryPartners.id, partnerId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_AVAILABILITY_OVERRIDDEN,
    entityType: "delivery_partner",
    entityId: partnerId,
    previousValue: { overridden: Boolean(current.availabilityOverrideAt) },
    newValue: { overridden: enabled, reason: why },
  });
  return toPublicPartner(updated);
}

/**
 * Refused while the rider holds any active assignment (a pending offer too),
 * the same set the dashboard disables the button on and analytics counts as busy.
 */
export async function goOffline(userId: string): Promise<PublicDeliveryPartner> {
  return db.transaction(async (tx) => {
    const partner = await lockMyPartner(tx, userId);
    if (!partner) throw notFound("Delivery partner profile");

    const [holding] = await tx
      .select({ status: deliveryOrders.status })
      .from(deliveryOrders)
      .where(
        and(
          eq(deliveryOrders.deliveryPartnerId, partner.id),
          inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES),
        ),
      )
      .limit(1);
    if (holding) {
      throw conflict(
        holding.status === "OFFERED"
          ? "Accept or reject your pending delivery offer before going offline."
          : "Finish or hand back your current delivery before going offline.",
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(deliveryPartners)
      .set({ isOnline: false, availability: "OFFLINE", statusActorId: userId, updatedAt: now })
      .where(eq(deliveryPartners.id, partner.id))
      .returning();
    await closeOpenSessions(tx, partner.id, partner.lastLocationAt, now);

    await recordAudit(
      {
        actorId: userId,
        action: AUDIT_ACTIONS.DELIVERY_PARTNER_ONLINE_STATUS_CHANGED,
        entityType: "delivery_partner",
        entityId: partner.id,
        previousValue: { availability: partner.availability },
        newValue: { isOnline: false, availability: "OFFLINE" },
      },
      tx,
    );

    return toPublicPartner(updated);
  });
}

/**
 * Signing out (TC-AUTH-040): an online rider goes offline exactly as the Go
 * offline button does, so assignment stops offering them jobs. goOffline's own
 * guard still applies — while the rider holds a delivery or a pending offer it
 * refuses, and then the rider and that job are left as they are (the sign-out
 * itself goes ahead). Only the availability flag changes; no assignment is touched.
 */
export async function goOfflineOnSignOut(userId: string): Promise<"OFFLINE" | "NOT_ONLINE" | "BUSY"> {
  const [partner] = await db
    .select({ isOnline: deliveryPartners.isOnline })
    .from(deliveryPartners)
    .where(and(eq(deliveryPartners.userId, userId), isNull(deliveryPartners.deletedAt)));
  if (!partner?.isOnline) return "NOT_ONLINE";
  try {
    await goOffline(userId);
    return "OFFLINE";
  } catch (error) {
    if (error instanceof AppError && error.code === "CONFLICT") return "BUSY";
    if (error instanceof AppError && error.code === "NOT_FOUND") return "NOT_ONLINE";
    throw error;
  }
}

/**
 * Location heartbeat while online. Returns false (writing nothing) unless the
 * partner is online, APPROVED and not deleted — checked on the locked row, so
 * a concurrent go-offline or suspension always wins. Location is never
 * written while offline.
 */
export async function updateMyLocation(
  userId: string,
  latitude: number,
  longitude: number,
): Promise<boolean> {
  if (!validCoordinate(latitude, longitude)) {
    throw validationFailed("A valid location is required.");
  }

  const partnerId = await db.transaction(async (tx) => {
    const [partner] = await tx
      .select({ id: deliveryPartners.id, lastLocationAt: deliveryPartners.lastLocationAt })
      .from(deliveryPartners)
      .where(
        and(
          eq(deliveryPartners.userId, userId),
          isNull(deliveryPartners.deletedAt),
          eq(deliveryPartners.isOnline, true),
          eq(deliveryPartners.status, "APPROVED"),
        ),
      )
      .for("update");
    if (!partner) return false;

    // The rider stays online across a gap (phones lock mid-delivery); only the session is split.
    const now = new Date();
    await syncOnlineSession(tx, partner.id, partner.lastLocationAt, now);
    await tx
      .update(deliveryPartners)
      .set({
        lastLocationLatitude: String(latitude),
        lastLocationLongitude: String(longitude),
        lastLocationAt: now,
      })
      .where(eq(deliveryPartners.id, partner.id));
    return partner.id;
  });
  if (!partnerId) return false;
  // Gig worker flow (feature 6): every new position re-checks the rider's open offers against the zone.
  await recheckZoneForPartner(partnerId, { latitude, longitude });
  return true;
}

/** After commit; never fails the location update. Imported lazily: delivery-assignment.ts imports this module. */
async function recheckZoneForPartner(partnerId: string, at: { latitude: number; longitude: number }): Promise<void> {
  const { withdrawOutOfZoneOffers } = await import("./delivery-assignment");
  await withdrawOutOfZoneOffers(partnerId, at).catch((error) => {
    console.error("[delivery-partner] zone re-check failed", partnerId, error);
  });
}
