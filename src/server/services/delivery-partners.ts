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
import { and, desc, eq, isNull } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { VEHICLE_TYPE_KEYS, type VehicleTypeKey } from "@/lib/vehicle-types";
import { db } from "@/server/db";
import {
  deliveryPartners,
  users,
  type DeliveryPartner,
  type DeliveryPartnerStatus,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { encryptKycInput, toPublicPartner, type PublicDeliveryPartner } from "./delivery-partner-kyc";
import { resolveLocationVerification } from "./geocoding";
import { NOTIFICATION_TYPES, notify } from "./notifications";

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
}

function validate(input: RegisterDeliveryPartnerInput): void {
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
}

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
): Promise<PublicDeliveryPartner> {
  validate(input);

  const existing = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.userId, userId), isNull(deliveryPartners.deletedAt)),
  });
  if (existing) {
    throw conflict("You have already applied to become a delivery partner.");
  }

  // SEC-02: KYC and bank details are stored as ciphertext only. Encrypted up
  // front so a missing key fails the application before anything is written.
  const encryptedKyc = encryptKycInput(input);

  const { locationVerified, locationVerifiedAt, locationSource } =
    await resolveLocationVerification(input.latitude, input.longitude, "delivery_partner_registration", "delivery_partner");

  const [partner] = await db
    .insert(deliveryPartners)
    .values({
      userId,
      fullName: input.fullName.trim(),
      mobile: input.mobile,
      email: input.email?.trim() || null,
      dateOfBirth: input.dateOfBirth || null,
      profilePhotoUrl: input.profilePhotoUrl || null,
      governmentIdType: input.governmentIdType?.trim() || null,
      ...encryptedKyc,
      vehicleType: input.vehicleType,
      vehicleRegistrationNumber: input.vehicleRegistrationNumber?.trim() || null,
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
  const [account] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (account?.role === "CUSTOMER") {
    await db.update(users).set({ role: "DELIVERY_PARTNER" }).where(eq(users.id, userId));
  }

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

async function loadForTransition(id: string): Promise<DeliveryPartner> {
  const current = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.id, id), isNull(deliveryPartners.deletedAt)),
  });
  if (!current) throw notFound("Delivery partner");
  if (TERMINAL_STATUSES.includes(current.status)) {
    throw conflict("This delivery partner has been deactivated and cannot be changed.");
  }
  return current;
}

async function transition(
  id: string,
  actor: Actor,
  set: Partial<{
    status: DeliveryPartnerStatus;
    reviewNotes: string | null;
    rejectionReason: string | null;
  }>,
): Promise<PublicDeliveryPartner> {
  const current = await loadForTransition(id);

  const [updated] = await db
    .update(deliveryPartners)
    .set({
      ...set,
      reviewedBy: actor.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deliveryPartners.id, id))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_STATUS_CHANGED,
    entityType: "delivery_partner",
    entityId: id,
    previousValue: { status: current.status },
    newValue: { status: updated.status, reviewNotes: updated.reviewNotes },
  });

  return toPublicPartner(updated);
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
  const current = await loadForTransition(id);
  const updated = await transition(id, actor, {
    status: "APPROVED",
    reviewNotes: notes ?? null,
    rejectionReason: null,
  });

  await notify({
    userId: current.userId,
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
  const current = await loadForTransition(id);
  const updated = await transition(id, actor, { status: "REJECTED", rejectionReason: reason.trim() });

  await notify({
    userId: current.userId,
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
  const current = await loadForTransition(id);
  if (current.status !== "APPROVED") {
    throw conflict("Only an approved delivery partner can be suspended.");
  }
  const updated = await transition(id, actor, { status: "SUSPENDED", rejectionReason: reason.trim() });

  await notify({
    userId: current.userId,
    type: NOTIFICATION_TYPES.DELIVERY_PARTNER_SUSPENDED,
    title: "Your delivery partner account has been suspended",
    body: reason.trim(),
    actionUrl: "/delivery-partner",
  });
  return updated;
}

export async function reactivateDeliveryPartner(id: string, actor: Actor): Promise<PublicDeliveryPartner> {
  const current = await loadForTransition(id);
  if (current.status !== "SUSPENDED") {
    throw conflict("Only a suspended delivery partner can be reactivated.");
  }
  return transition(id, actor, { status: "APPROVED", rejectionReason: null });
}

/** Permanent close-out — e.g. the partner asked to stop, or a serious policy violation. Terminal; no further transitions. */
export async function deactivateDeliveryPartner(
  id: string,
  reason: string,
  actor: Actor,
): Promise<PublicDeliveryPartner> {
  if (!reason.trim()) throw validationFailed("A reason is required.");
  return transition(id, actor, { status: "DEACTIVATED", rejectionReason: reason.trim() });
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

/**
 * Goes online with a current position — gated to APPROVED partners only, so
 * assignment (Slice C) never offers a delivery to someone still under
 * review. Location comes from the browser's native geolocation; this
 * function never calls any Google Maps Platform service.
 */
export async function goOnline(
  userId: string,
  latitude: number,
  longitude: number,
): Promise<PublicDeliveryPartner> {
  if (!validCoordinate(latitude, longitude)) {
    throw validationFailed("A valid current location is required to go online.");
  }
  const partner = await getMyDeliveryPartnerProfile(userId);
  if (!partner) throw notFound("Delivery partner profile");
  if (partner.status !== "APPROVED") {
    throw conflict("Only an approved delivery partner can go online.");
  }

  const [updated] = await db
    .update(deliveryPartners)
    .set({
      isOnline: true,
      lastLocationLatitude: String(latitude),
      lastLocationLongitude: String(longitude),
      lastLocationAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deliveryPartners.id, partner.id))
    .returning();

  await recordAudit({
    actorId: userId,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_ONLINE_STATUS_CHANGED,
    entityType: "delivery_partner",
    entityId: partner.id,
    newValue: { isOnline: true },
  });

  return toPublicPartner(updated);
}

export async function goOffline(userId: string): Promise<PublicDeliveryPartner> {
  const partner = await getMyDeliveryPartnerProfile(userId);
  if (!partner) throw notFound("Delivery partner profile");

  const [updated] = await db
    .update(deliveryPartners)
    .set({ isOnline: false, updatedAt: new Date() })
    .where(eq(deliveryPartners.id, partner.id))
    .returning();

  await recordAudit({
    actorId: userId,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_ONLINE_STATUS_CHANGED,
    entityType: "delivery_partner",
    entityId: partner.id,
    newValue: { isOnline: false },
  });

  return toPublicPartner(updated);
}

/**
 * Location heartbeat while online. Silently a no-op for an offline partner
 * rather than trusting the client's own "I'm online" claim — per the
 * brief's privacy requirement, location is never written while offline.
 */
export async function updateMyLocation(
  userId: string,
  latitude: number,
  longitude: number,
): Promise<void> {
  if (!validCoordinate(latitude, longitude)) {
    throw validationFailed("A valid location is required.");
  }
  const partner = await getMyDeliveryPartnerProfile(userId);
  if (!partner || !partner.isOnline) return;

  await db
    .update(deliveryPartners)
    .set({
      lastLocationLatitude: String(latitude),
      lastLocationLongitude: String(longitude),
      lastLocationAt: new Date(),
    })
    .where(eq(deliveryPartners.id, partner.id));
}
