/**
 * docs/delta CF-006: riders ask to join a society's authorised rider list.
 *
 * Today only the society ADMIN adds riders (by mobile number, `addSocietyRider`). This adds the
 * other direction: an approved rider asks, the society ADMIN approves or declines. Approval calls
 * the existing `addSocietyRider`, so every rule of the rider list still applies there (verified
 * society, GoKesari's per-society block, the audit row). Nothing else about the rider list changes.
 *
 * Behind the flag `society_rider_join_requests_enabled`, checked by the society's district.
 * Notifications reuse the society membership types; audit rows use SOCIETY_RIDER_CHANGED with
 * entity type `society_join_request`.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  deliveryPartners,
  societies,
  societyJoinRequests,
  societyPartnerAccess,
  societyRiders,
  type SocietyJoinRequest,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { featureNotAvailable, isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { addSocietyRider, requireSocietyRole, societyStaffUserIds } from "@/server/services/societies";

export const SOCIETY_JOIN_FLAG = "society_rider_join_requests_enabled" as const;

interface Actor {
  id: string;
  role: UserRole;
}

const MESSAGE_MAX = 300;

/** The flag, for one society (by its PIN code's district). */
export async function joinRequestsEnabledFor(society: { pincode: string }): Promise<boolean> {
  return isFeatureEnabledForShop(SOCIETY_JOIN_FLAG, { pincode: society.pincode });
}

async function requireFlag(society: { pincode: string }): Promise<void> {
  if (!(await joinRequestsEnabledFor(society))) throw featureNotAvailable(SOCIETY_JOIN_FLAG);
}

async function loadSociety(societyId: string) {
  const [society] = await db
    .select()
    .from(societies)
    .where(and(eq(societies.id, societyId), isNull(societies.deletedAt)));
  if (!society) throw notFound("Society");
  return society;
}

/** The caller's own delivery-partner profile; only an APPROVED rider may ask. */
async function requireApprovedRider(actor: Actor) {
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.userId, actor.id), isNull(deliveryPartners.deletedAt)),
  });
  if (!partner) throw forbidden("Only delivery partners can ask to join a society.");
  if (partner.status !== "APPROVED") throw forbidden("Your delivery partner account must be approved first.");
  return partner;
}

/** A rider asks to join a verified society. Society ADMIN/OPERATOR users are told. */
export async function requestToJoinSociety(societyId: string, actor: Actor, message?: string | null): Promise<SocietyJoinRequest> {
  const society = await loadSociety(societyId);
  await requireFlag(society);
  const partner = await requireApprovedRider(actor);
  if (society.status !== "VERIFIED") throw conflict("This society is not open for riders yet.");
  const note = message?.trim() || null;
  if (note && note.length > MESSAGE_MAX) throw validationFailed(`Keep the note under ${MESSAGE_MAX} characters.`);

  const [listed] = await db
    .select({ id: societyRiders.id })
    .from(societyRiders)
    .where(
      and(
        eq(societyRiders.societyId, societyId),
        eq(societyRiders.deliveryPartnerId, partner.id),
        eq(societyRiders.status, "ACTIVE"),
      ),
    );
  if (listed) throw conflict("You are already on this society's rider list.");

  const [blocked] = await db
    .select({ id: societyPartnerAccess.id })
    .from(societyPartnerAccess)
    .where(
      and(
        eq(societyPartnerAccess.societyId, societyId),
        eq(societyPartnerAccess.deliveryPartnerId, partner.id),
        eq(societyPartnerAccess.access, "BLOCKED"),
      ),
    );
  if (blocked) throw conflict("You can't ask to join this society. Contact GoKesari support.");

  const [pending] = await db
    .select()
    .from(societyJoinRequests)
    .where(
      and(
        eq(societyJoinRequests.societyId, societyId),
        eq(societyJoinRequests.deliveryPartnerId, partner.id),
        eq(societyJoinRequests.status, "PENDING"),
      ),
    );
  if (pending) return pending;

  const [row] = await db
    .insert(societyJoinRequests)
    .values({ societyId, deliveryPartnerId: partner.id, message: note })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_RIDER_CHANGED,
    entityType: "society_join_request",
    entityId: row.id,
    newValue: { societyId, deliveryPartnerId: partner.id, status: "PENDING" },
  });
  // After the row is saved (CLAUDE.md: side effects outside the write).
  for (const userId of await societyStaffUserIds(societyId)) {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.SOCIETY_MEMBERSHIP_REQUESTED,
      title: "A rider asked to join",
      body: `${partner.fullName} asked to deliver in ${society.name}. Approve or decline on the society page.`,
      actionUrl: `/society/${societyId}`,
      dedupeKey: `society-rider-join:${row.id}`,
    });
  }
  return row;
}

export interface MyJoinRequest {
  id: string;
  societyId: string;
  societyName: string;
  area: string | null;
  city: string;
  status: SocietyJoinRequest["status"];
  decisionNote: string | null;
  createdAt: Date;
}

/** The rider's own requests, newest first. */
export async function listMyJoinRequests(actor: Actor): Promise<MyJoinRequest[]> {
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.userId, actor.id), isNull(deliveryPartners.deletedAt)),
  });
  if (!partner) return [];
  return db
    .select({
      id: societyJoinRequests.id,
      societyId: societies.id,
      societyName: societies.name,
      area: societies.area,
      city: societies.city,
      status: societyJoinRequests.status,
      decisionNote: societyJoinRequests.decisionNote,
      createdAt: societyJoinRequests.createdAt,
    })
    .from(societyJoinRequests)
    .innerJoin(societies, eq(societyJoinRequests.societyId, societies.id))
    .where(eq(societyJoinRequests.deliveryPartnerId, partner.id))
    .orderBy(desc(societyJoinRequests.createdAt))
    .limit(50);
}

export interface SocietyJoinRequestView {
  id: string;
  riderName: string;
  vehicleType: string | null;
  ratingAvgX100: number | null;
  ratingCount: number;
  message: string | null;
  createdAt: Date;
}

/** PENDING requests for a society: its ADMIN/OPERATOR, or platform staff. No phone numbers. */
export async function listSocietyJoinRequests(societyId: string, actor: Actor): Promise<SocietyJoinRequestView[]> {
  const { society } = await requireSocietyRole(societyId, actor, ["ADMIN", "OPERATOR"]);
  await requireFlag(society);
  return db
    .select({
      id: societyJoinRequests.id,
      riderName: deliveryPartners.fullName,
      vehicleType: deliveryPartners.vehicleType,
      ratingAvgX100: deliveryPartners.ratingAvgX100,
      ratingCount: deliveryPartners.ratingCount,
      message: societyJoinRequests.message,
      createdAt: societyJoinRequests.createdAt,
    })
    .from(societyJoinRequests)
    .innerJoin(deliveryPartners, eq(societyJoinRequests.deliveryPartnerId, deliveryPartners.id))
    .where(and(eq(societyJoinRequests.societyId, societyId), eq(societyJoinRequests.status, "PENDING")))
    .orderBy(societyJoinRequests.createdAt);
}

/**
 * Society ADMIN approves or declines. Approval lists the rider through the existing
 * `addSocietyRider` (same checks and audit as adding by mobile number), not preferred.
 */
export async function decideJoinRequest(
  requestId: string,
  approve: boolean,
  actor: Actor,
  note?: string | null,
): Promise<SocietyJoinRequest> {
  const request = await db.query.societyJoinRequests.findFirst({ where: eq(societyJoinRequests.id, requestId) });
  if (!request) throw notFound("Join request");
  const { society } = await requireSocietyRole(request.societyId, actor, ["ADMIN"]);
  await requireFlag(society);
  if (request.status !== "PENDING") throw conflict("This request has already been decided.");
  const decisionNote = note?.trim() || null;
  if (decisionNote && decisionNote.length > MESSAGE_MAX) throw validationFailed(`Keep the note under ${MESSAGE_MAX} characters.`);

  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, request.deliveryPartnerId) });
  if (!partner) throw notFound("Delivery partner");

  if (approve) await addSocietyRider(request.societyId, partner.mobile, false, actor);

  const [updated] = await db
    .update(societyJoinRequests)
    .set({
      status: approve ? "APPROVED" : "DECLINED",
      decidedBy: actor.id,
      decidedAt: new Date(),
      decisionNote,
      updatedAt: new Date(),
    })
    .where(and(eq(societyJoinRequests.id, requestId), eq(societyJoinRequests.status, "PENDING")))
    .returning();
  if (!updated) throw conflict("This request has already been decided.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_RIDER_CHANGED,
    entityType: "society_join_request",
    entityId: requestId,
    previousValue: { status: "PENDING" },
    newValue: { status: updated.status, societyId: request.societyId, deliveryPartnerId: request.deliveryPartnerId },
  });
  if (partner.userId) {
    await notify({
      userId: partner.userId,
      type: NOTIFICATION_TYPES.SOCIETY_MEMBERSHIP_DECIDED,
      title: approve ? "Society request approved" : "Society request declined",
      body: approve
        ? `${society.name} added you to its rider list. Its residents' deliveries can now be offered to you first.`
        : `${society.name} declined your request${decisionNote ? `: ${decisionNote}` : "."}`,
      actionUrl: "/delivery-partner/societies",
    });
  }
  return updated;
}

/** The rider withdraws their own PENDING request. */
export async function withdrawJoinRequest(requestId: string, actor: Actor): Promise<SocietyJoinRequest> {
  const request = await db.query.societyJoinRequests.findFirst({ where: eq(societyJoinRequests.id, requestId) });
  if (!request) throw notFound("Join request");
  const society = await loadSociety(request.societyId);
  await requireFlag(society);
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.userId, actor.id), isNull(deliveryPartners.deletedAt)),
  });
  if (!partner || partner.id !== request.deliveryPartnerId) throw notFound("Join request");
  if (request.status !== "PENDING") throw conflict("This request has already been decided.");
  const [updated] = await db
    .update(societyJoinRequests)
    .set({ status: "WITHDRAWN", updatedAt: new Date() })
    .where(and(eq(societyJoinRequests.id, requestId), inArray(societyJoinRequests.status, ["PENDING"])))
    .returning();
  if (!updated) throw conflict("This request has already been decided.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_RIDER_CHANGED,
    entityType: "society_join_request",
    entityId: requestId,
    previousValue: { status: "PENDING" },
    newValue: { status: "WITHDRAWN" },
  });
  return updated;
}
