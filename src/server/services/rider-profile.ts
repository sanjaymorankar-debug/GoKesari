/**
 * Rider self-edit of profile (feature F2).
 *
 * Everyday details — name, phone, email, date of birth, photo, vehicle and
 * working radius — apply at once. Identity and bank details (PAN, government
 * ID, bank account, IFSC, driving licence) go to an admin first: the new
 * values are encrypted into one change request and copied onto the rider only
 * when approved. Values are never logged or returned; reviewers see a masked
 * tail.
 */
import { and, asc, eq } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "@/lib/pan-crypto";
import { parsePhone } from "@/lib/phone";
import { VEHICLE_TYPE_KEYS, type VehicleTypeKey } from "@/lib/vehicle-types";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import {
  deliveryPartnerChangeRequests,
  deliveryPartners,
  type DeliveryPartnerChangeRequest,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { encryptKycInput, toPublicPartner, type KycField, type PublicDeliveryPartner } from "./delivery-partner-kyc";
import { NOTIFICATION_TYPES, notify } from "./notifications";

interface Actor {
  id: string;
  role: UserRole;
}

export interface RiderProfilePatch {
  fullName?: string;
  mobile?: string;
  email?: string | null;
  dateOfBirth?: string | null;
  profilePhotoUrl?: string | null;
  vehicleType?: VehicleTypeKey;
  vehicleRegistrationNumber?: string | null;
  operatingRadiusKm?: number;
}

/** Identity / bank fields a rider may ask to change. governmentIdType travels with the ID number. */
export const SENSITIVE_RIDER_FIELDS = [
  "panNumber",
  "governmentIdType",
  "governmentIdNumber",
  "bankAccountHolderName",
  "bankAccountNumber",
  "bankIfsc",
  "drivingLicenceNumber",
] as const;
export type SensitiveRiderField = (typeof SENSITIVE_RIDER_FIELDS)[number];

export const SENSITIVE_FIELD_LABELS: Record<SensitiveRiderField, string> = {
  panNumber: "PAN",
  governmentIdType: "Government ID type",
  governmentIdNumber: "Government ID number",
  bankAccountHolderName: "Bank account holder",
  bankAccountNumber: "Bank account number",
  bankIfsc: "IFSC",
  drivingLicenceNumber: "Driving licence",
};

async function myPartner(userId: string) {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner || partner.deletedAt) throw notFound("Delivery partner profile");
  if (partner.status === "DEACTIVATED") throw conflict("This profile has been deactivated and cannot be edited.");
  return partner;
}

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** Applies the everyday fields at once. Returns the public (KYC-free) profile. */
export async function updateMyRiderProfile(userId: string, patch: RiderProfilePatch): Promise<PublicDeliveryPartner> {
  const partner = await myPartner(userId);
  const set: Record<string, unknown> = {};

  if (patch.fullName !== undefined) {
    const name = patch.fullName.trim();
    if (name.length < 2 || name.length > 120) throw validationFailed("Enter your full name (2–120 characters).");
    set.fullName = name;
  }
  if (patch.mobile !== undefined) {
    const parsed = parsePhone("+91", patch.mobile);
    if (!parsed.ok) throw validationFailed("Enter a valid 10-digit Indian mobile number.");
    set.mobile = parsed.national;
  }
  if (patch.email !== undefined) {
    const email = clean(patch.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validationFailed("Enter a valid email address.");
    set.email = email;
  }
  if (patch.dateOfBirth !== undefined) {
    const dob = clean(patch.dateOfBirth);
    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw validationFailed("Use the date format YYYY-MM-DD.");
    set.dateOfBirth = dob;
  }
  if (patch.profilePhotoUrl !== undefined) {
    const url = clean(patch.profilePhotoUrl);
    if (url && !/^(https:\/\/|\/api\/images\/)/.test(url)) throw validationFailed("Upload a photo or give an https link.");
    set.profilePhotoUrl = url;
  }
  if (patch.vehicleType !== undefined) {
    if (!(VEHICLE_TYPE_KEYS as readonly string[]).includes(patch.vehicleType)) throw validationFailed("Choose a vehicle type.");
    set.vehicleType = patch.vehicleType;
  }
  if (patch.vehicleRegistrationNumber !== undefined) {
    const reg = clean(patch.vehicleRegistrationNumber)?.toUpperCase().replace(/\s+/g, " ") ?? null;
    if (reg && reg.length > 30) throw validationFailed("The registration number is too long.");
    set.vehicleRegistrationNumber = reg;
  }
  if (patch.operatingRadiusKm !== undefined) {
    if (!Number.isInteger(patch.operatingRadiusKm) || patch.operatingRadiusKm < 1 || patch.operatingRadiusKm > 50) {
      throw validationFailed("The working radius must be between 1 and 50 km.");
    }
    set.operatingRadiusKm = patch.operatingRadiusKm;
  }

  const changed = Object.keys(set).filter((k) => (partner as Record<string, unknown>)[k] !== set[k]);
  if (changed.length === 0) return toPublicPartner(partner);

  const [updated] = await db
    .update(deliveryPartners)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(deliveryPartners.id, partner.id))
    .returning();
  await recordAudit({
    actorId: userId,
    actorRole: "DELIVERY_PARTNER",
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_PROFILE_UPDATED,
    entityType: "delivery_partner",
    entityId: partner.id,
    newValue: { fields: changed },
  });
  return toPublicPartner(updated);
}

function maskTail(value: string): string {
  return value.length <= 4 ? "…" : `…${value.slice(-4)}`;
}

/** Sends identity / bank changes for review. Replaces any request still pending. */
export async function requestSensitiveChange(
  userId: string,
  values: Partial<Record<SensitiveRiderField, string | null>>,
): Promise<DeliveryPartnerChangeRequest> {
  const partner = await myPartner(userId);
  const provided = SENSITIVE_RIDER_FIELDS.filter((f) => clean(values[f]) !== null);
  if (provided.length === 0) throw validationFailed("Enter at least one detail to change.");
  for (const f of provided) {
    if (clean(values[f])!.length > 120) throw validationFailed(`${SENSITIVE_FIELD_LABELS[f]} is too long.`);
  }
  if (values.panNumber && !/^[A-Z]{5}\d{4}[A-Z]$/.test(values.panNumber.trim().toUpperCase())) {
    throw validationFailed("PAN must be 10 characters in the format AAAAA9999A.");
  }
  if (values.bankIfsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(values.bankIfsc.trim().toUpperCase())) {
    throw validationFailed("IFSC must be 11 characters, e.g. SBIN0001234.");
  }
  const payload: Record<string, string> = {};
  const masked: Record<string, string> = {};
  for (const f of provided) {
    const v = clean(values[f])!;
    payload[f] = f === "panNumber" || f === "bankIfsc" ? v.toUpperCase() : v;
    masked[f] = f === "governmentIdType" || f === "bankAccountHolderName" ? v : maskTail(v);
  }
  // Encrypt before touching the database: no key means no request, never plaintext.
  encryptKycInput({ panNumber: "probe" });
  const payloadEncrypted = encryptSecret(JSON.stringify(payload));

  const request = await db.transaction(async (tx) => {
    await tx
      .update(deliveryPartnerChangeRequests)
      .set({ status: "SUPERSEDED", reviewedAt: new Date() })
      .where(
        and(eq(deliveryPartnerChangeRequests.deliveryPartnerId, partner.id), eq(deliveryPartnerChangeRequests.status, "PENDING")),
      );
    const [row] = await tx
      .insert(deliveryPartnerChangeRequests)
      .values({ deliveryPartnerId: partner.id, fields: provided, payloadEncrypted, masked, requestedBy: userId })
      .returning();
    return row;
  });
  await recordAudit({
    actorId: userId,
    actorRole: "DELIVERY_PARTNER",
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_CHANGE_REQUESTED,
    entityType: "delivery_partner",
    entityId: partner.id,
    newValue: { requestId: request.id, fields: provided },
  });
  return request;
}

export type PublicChangeRequest = Omit<DeliveryPartnerChangeRequest, "payloadEncrypted">;

function publicRequest(r: DeliveryPartnerChangeRequest): PublicChangeRequest {
  const { payloadEncrypted: _omit, ...rest } = r;
  void _omit;
  return rest;
}

/** The rider's latest request (pending or decided), for the profile page. */
export async function getMyLatestChangeRequest(userId: string): Promise<PublicChangeRequest | null> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner) return null;
  const rows = await db.query.deliveryPartnerChangeRequests.findMany({
    where: eq(deliveryPartnerChangeRequests.deliveryPartnerId, partner.id),
    orderBy: (t, { desc }) => desc(t.createdAt),
    limit: 1,
  });
  return rows[0] ? publicRequest(rows[0]) : null;
}

function assertReviewer(actor: Actor) {
  if (!can(actor.role, PERMISSIONS.DELIVERY_PARTNER_MANAGE)) throw forbidden("You can't review rider changes.");
}

export async function listPendingChangeRequests(
  actor: Actor,
): Promise<(PublicChangeRequest & { riderName: string; riderMobile: string })[]> {
  assertReviewer(actor);
  const rows = await db
    .select({ r: deliveryPartnerChangeRequests, name: deliveryPartners.fullName, mobile: deliveryPartners.mobile })
    .from(deliveryPartnerChangeRequests)
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryPartnerChangeRequests.deliveryPartnerId))
    .where(eq(deliveryPartnerChangeRequests.status, "PENDING"))
    .orderBy(asc(deliveryPartnerChangeRequests.createdAt))
    .limit(200);
  return rows.map(({ r, name, mobile }) => ({ ...publicRequest(r), riderName: name, riderMobile: mobile }));
}

/** Approve copies the new values onto the rider (encrypted); reject needs a reason. */
export async function decideChangeRequest(
  requestId: string,
  input: { decision: "approve" | "reject"; reason?: string },
  actor: Actor,
): Promise<PublicChangeRequest> {
  assertReviewer(actor);
  const reason = input.reason?.trim() ?? "";
  if (input.decision === "reject" && reason.length < 3) throw validationFailed("A rejection reason is required.");

  const result = await db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(deliveryPartnerChangeRequests)
      .where(eq(deliveryPartnerChangeRequests.id, requestId))
      .for("update");
    if (!req) throw notFound("Change request");
    if (req.status !== "PENDING") throw conflict("This request has already been decided.");

    if (input.decision === "approve") {
      const payload = JSON.parse(decryptSecret(req.payloadEncrypted)) as Partial<Record<SensitiveRiderField, string>>;
      const { governmentIdType, ...kyc } = payload;
      const encrypted = encryptKycInput(kyc as Partial<Record<KycField, string>>);
      // Clear the legacy plaintext twin of every replaced field so it can't contradict the new value.
      const plaintextNulls = Object.fromEntries(Object.keys(kyc).map((k) => [k, null]));
      await tx
        .update(deliveryPartners)
        .set({
          ...encrypted,
          ...plaintextNulls,
          ...(governmentIdType !== undefined ? { governmentIdType } : {}),
          updatedAt: new Date(),
        })
        .where(eq(deliveryPartners.id, req.deliveryPartnerId));
    }
    const [updated] = await tx
      .update(deliveryPartnerChangeRequests)
      .set({
        status: input.decision === "approve" ? "APPROVED" : "REJECTED",
        rejectionReason: input.decision === "reject" ? reason : null,
        reviewedBy: actor.id,
        reviewedAt: new Date(),
      })
      .where(eq(deliveryPartnerChangeRequests.id, req.id))
      .returning();
    return updated;
  });

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_CHANGE_DECIDED,
    entityType: "delivery_partner",
    entityId: result.deliveryPartnerId,
    newValue: { requestId: result.id, decision: input.decision, fields: result.fields, reason: reason || null },
  });
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, result.deliveryPartnerId) });
  if (partner) {
    await notify({
      userId: partner.userId,
      type: NOTIFICATION_TYPES.DELIVERY_PARTNER_CHANGE_DECIDED,
      title: input.decision === "approve" ? "Your profile change was approved" : "Your profile change was not approved",
      body: input.decision === "approve" ? "Your updated identity or bank details are now on file." : reason,
      actionUrl: "/gig/profile",
    });
  }
  return publicRequest(result);
}
