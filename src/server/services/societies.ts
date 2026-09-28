/**
 * Societies (Phase 2 — GS-005, GS-044..047, GA-001/002, NAV Society).
 *
 * A society is a residential community that residents join and that a
 * society admin runs: it lists which riders may deliver there (GS-045), which
 * of them are preferred (GA-002), whether that list is exclusive (GA-001),
 * gate/parking instructions for riders (GS-047), security notifications
 * (GS-046), and the shops it recommends to residents.
 *
 * Roles are scoped per society (society_members.role ADMIN / OPERATOR /
 * RESIDENT), never global. `requireSocietyRole` is the one gate every
 * society-level action goes through; platform operators/admins
 * (SOCIETY_MANAGE_ANY) may act on any society.
 *
 * Privacy: society staff see what they need to run the gate — order number,
 * status, shop, rider name and vehicle, the resident's unit label — never the
 * customer's name, phone, items or payment.
 */
import { and, desc, eq, gte, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  deliveryOrders,
  deliveryPartners,
  orders,
  shops,
  societies,
  societyMembers,
  societyRiders,
  societyShops,
  users,
  type Society,
  type SocietyMember,
  type SocietyMemberRole,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";

interface Actor {
  id: string;
  role: UserRole;
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${base || "society"}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ================================================================ access */

/**
 * The single authorisation gate for society-level actions. Platform staff
 * with SOCIETY_MANAGE_ANY pass for any society; everyone else needs an ACTIVE
 * membership with one of `roles`.
 */
export async function requireSocietyRole(
  societyId: string,
  actor: Actor,
  roles: readonly SocietyMemberRole[],
  client: DbClient = db,
): Promise<{ society: Society; membership: SocietyMember | null }> {
  const [society] = await client
    .select()
    .from(societies)
    .where(and(eq(societies.id, societyId), isNull(societies.deletedAt)));
  if (!society) throw notFound("Society");
  if (can(actor.role, PERMISSIONS.SOCIETY_MANAGE_ANY)) return { society, membership: null };
  const [membership] = await client
    .select()
    .from(societyMembers)
    .where(
      and(
        eq(societyMembers.societyId, societyId),
        eq(societyMembers.userId, actor.id),
        eq(societyMembers.status, "ACTIVE"),
      ),
    );
  if (!membership || !roles.includes(membership.role)) {
    throw forbidden("You do not manage this society.");
  }
  return { society, membership };
}

/** Users who administer or operate a society, for notifications. */
async function societyStaffUserIds(societyId: string, client: DbClient = db): Promise<string[]> {
  const rows = await client
    .select({ userId: societyMembers.userId })
    .from(societyMembers)
    .where(
      and(
        eq(societyMembers.societyId, societyId),
        eq(societyMembers.status, "ACTIVE"),
        inArray(societyMembers.role, ["ADMIN", "OPERATOR"]),
      ),
    );
  return rows.map((r) => r.userId);
}

/** Give a plain customer the SOCIETY_ADMIN role once they run a society (navigation hint only). */
async function promoteToSocietyRole(userId: string, client: DbClient): Promise<void> {
  await client
    .update(users)
    .set({ role: "SOCIETY_ADMIN", updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.role, "CUSTOMER")));
}

/* ======================================================= registration */

export interface RegisterSocietyInput {
  name: string;
  addressLine1: string;
  area?: string | null;
  city: string;
  pincode: string;
  latitude?: number | null;
  longitude?: number | null;
  unitLabel?: string | null;
}

/** Anyone signed in may register a society; they become its first ADMIN. Operator verifies it (GS-044). */
export async function registerSociety(input: RegisterSocietyInput, actor: Actor): Promise<Society> {
  const name = input.name.trim();
  if (name.length < 3) throw validationFailed("Enter the society's name.");
  if (!input.addressLine1.trim()) throw validationFailed("Enter the society's address.");
  if (!input.city.trim()) throw validationFailed("Enter the city.");
  if (!/^\d{6}$/.test(input.pincode.trim())) throw validationFailed("Enter a valid 6-digit PIN code.");

  return db.transaction(async (tx) => {
    const duplicate = await tx.query.societies.findFirst({
      where: and(
        ilike(societies.name, name),
        eq(societies.pincode, input.pincode.trim()),
        ne(societies.status, "REJECTED"),
        isNull(societies.deletedAt),
      ),
    });
    if (duplicate) throw conflict("This society is already registered — ask to join it instead.");

    const [society] = await tx
      .insert(societies)
      .values({
        name,
        slug: slugify(name),
        addressLine1: input.addressLine1.trim(),
        area: input.area?.trim() || null,
        city: input.city.trim(),
        pincode: input.pincode.trim(),
        latitude: input.latitude != null ? String(input.latitude) : null,
        longitude: input.longitude != null ? String(input.longitude) : null,
        registeredBy: actor.id,
      })
      .returning();
    await tx.insert(societyMembers).values({
      societyId: society.id,
      userId: actor.id,
      role: "ADMIN",
      status: "ACTIVE",
      unitLabel: input.unitLabel?.trim() || null,
      approvedBy: actor.id,
      approvedAt: new Date(),
    });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SOCIETY_REGISTERED,
        entityType: "society",
        entityId: society.id,
        newValue: { name, pincode: society.pincode },
      },
      tx,
    );
    return society;
  });
}

export type SocietyDecision = "verify" | "reject" | "suspend" | "reinstate";

const SOCIETY_STEPS: Record<SocietyDecision, { from: Society["status"][]; to: Society["status"] }> = {
  verify: { from: ["APPLIED"], to: "VERIFIED" },
  reject: { from: ["APPLIED"], to: "REJECTED" },
  suspend: { from: ["VERIFIED"], to: "SUSPENDED" },
  reinstate: { from: ["SUSPENDED"], to: "VERIFIED" },
};

/** Platform operator/admin decision on a society (GS-044 verification). */
export async function decideSociety(
  societyId: string,
  decision: SocietyDecision,
  actor: Actor,
  reason?: string,
): Promise<Society> {
  if (!can(actor.role, PERMISSIONS.SOCIETY_MANAGE_ANY)) throw forbidden("Only operations can verify societies.");
  const step = SOCIETY_STEPS[decision];
  if ((decision === "reject" || decision === "suspend") && !reason?.trim()) {
    throw validationFailed("Give a reason.");
  }

  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(societies).where(eq(societies.id, societyId)).for("update");
    if (!current) throw notFound("Society");
    if (!step.from.includes(current.status)) {
      throw conflict(`A ${current.status.toLowerCase()} society cannot be ${decision === "verify" ? "verified" : decision + "ed"}.`);
    }
    const [row] = await tx
      .update(societies)
      .set({
        status: step.to,
        ...(decision === "verify" ? { verifiedBy: actor.id, verifiedAt: new Date(), rejectionReason: null } : {}),
        ...(decision === "reject" || decision === "suspend" ? { rejectionReason: reason!.trim() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(societies.id, societyId))
      .returning();
    if (step.to === "VERIFIED") {
      for (const userId of await societyStaffUserIds(societyId, tx)) await promoteToSocietyRole(userId, tx);
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SOCIETY_STATUS_CHANGED,
        entityType: "society",
        entityId: societyId,
        previousValue: { status: current.status },
        newValue: { status: step.to, reason: reason ?? null },
      },
      tx,
    );
    return row;
  });

  for (const userId of await societyStaffUserIds(societyId)) {
    await notify({
      userId,
      type: step.to === "VERIFIED" ? NOTIFICATION_TYPES.SOCIETY_VERIFIED : NOTIFICATION_TYPES.SOCIETY_REJECTED,
      title: `Society ${step.to.toLowerCase()}`,
      body:
        step.to === "VERIFIED"
          ? `${updated.name} is verified — residents can now join and you can set up riders and instructions.`
          : `${updated.name} was ${step.to.toLowerCase()}: ${reason ?? ""}`,
      actionUrl: `/society/${updated.id}`,
    });
  }
  return updated;
}

export interface SocietySettingsInput {
  deliveryInstructions?: string | null;
  securityNotifyEnabled?: boolean;
  exclusiveRiders?: boolean;
  boundaryRadiusMeters?: number;
  latitude?: number | null;
  longitude?: number | null;
}

/** Society ADMIN (or platform staff) edits rules and instructions. */
export async function updateSocietySettings(societyId: string, input: SocietySettingsInput, actor: Actor): Promise<Society> {
  const { society } = await requireSocietyRole(societyId, actor, ["ADMIN"]);
  if (
    input.boundaryRadiusMeters !== undefined &&
    (!Number.isInteger(input.boundaryRadiusMeters) || input.boundaryRadiusMeters < 50 || input.boundaryRadiusMeters > 3000)
  ) {
    throw validationFailed("Boundary must be 50–3000 metres.");
  }
  const [updated] = await db
    .update(societies)
    .set({
      ...(input.deliveryInstructions !== undefined ? { deliveryInstructions: input.deliveryInstructions?.trim() || null } : {}),
      ...(input.securityNotifyEnabled !== undefined ? { securityNotifyEnabled: input.securityNotifyEnabled } : {}),
      ...(input.exclusiveRiders !== undefined ? { exclusiveRiders: input.exclusiveRiders } : {}),
      ...(input.boundaryRadiusMeters !== undefined ? { boundaryRadiusMeters: input.boundaryRadiusMeters } : {}),
      ...(input.latitude !== undefined ? { latitude: input.latitude != null ? String(input.latitude) : null } : {}),
      ...(input.longitude !== undefined ? { longitude: input.longitude != null ? String(input.longitude) : null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(societies.id, societyId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_UPDATED,
    entityType: "society",
    entityId: societyId,
    previousValue: {
      securityNotifyEnabled: society.securityNotifyEnabled,
      exclusiveRiders: society.exclusiveRiders,
      boundaryRadiusMeters: society.boundaryRadiusMeters,
    },
    newValue: input,
  });
  return updated;
}

/* ========================================================= membership */

/** A resident asks to join a verified society (GS-005). Society staff approve. */
export async function requestMembership(societyId: string, actor: Actor, unitLabel?: string | null): Promise<SocietyMember> {
  const society = await db.query.societies.findFirst({ where: eq(societies.id, societyId) });
  if (!society || society.deletedAt) throw notFound("Society");
  if (society.status !== "VERIFIED") throw conflict("This society is not open for residents yet.");

  const existing = await db.query.societyMembers.findFirst({
    where: and(eq(societyMembers.societyId, societyId), eq(societyMembers.userId, actor.id)),
  });
  if (existing?.status === "ACTIVE") throw conflict("You are already a member of this society.");
  if (existing?.status === "PENDING") return existing;

  const [member] = existing
    ? await db
        .update(societyMembers)
        .set({ status: "PENDING", role: "RESIDENT", unitLabel: unitLabel?.trim() || existing.unitLabel, updatedAt: new Date() })
        .where(eq(societyMembers.id, existing.id))
        .returning()
    : await db
        .insert(societyMembers)
        .values({ societyId, userId: actor.id, role: "RESIDENT", status: "PENDING", unitLabel: unitLabel?.trim() || null })
        .returning();

  for (const userId of await societyStaffUserIds(societyId)) {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.SOCIETY_MEMBERSHIP_REQUESTED,
      title: "New resident request",
      body: `Someone${member.unitLabel ? ` in ${member.unitLabel}` : ""} asked to join ${society.name}.`,
      actionUrl: `/society/${societyId}`,
      dedupeKey: `society-join:${member.id}:${member.updatedAt.getTime()}`,
    });
  }
  return member;
}

/** Society ADMIN/OPERATOR approves or declines a resident. */
export async function decideMembership(memberId: string, approve: boolean, actor: Actor): Promise<SocietyMember> {
  const member = await db.query.societyMembers.findFirst({ where: eq(societyMembers.id, memberId) });
  if (!member) throw notFound("Membership");
  const { society } = await requireSocietyRole(member.societyId, actor, ["ADMIN", "OPERATOR"]);
  if (member.status !== "PENDING") throw conflict("This request has already been decided.");

  const [updated] = await db
    .update(societyMembers)
    .set({
      status: approve ? "ACTIVE" : "REMOVED",
      approvedBy: approve ? actor.id : null,
      approvedAt: approve ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(societyMembers.id, memberId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_MEMBER_CHANGED,
    entityType: "society_member",
    entityId: memberId,
    previousValue: { status: member.status },
    newValue: { status: updated.status },
  });
  await notify({
    userId: member.userId,
    type: NOTIFICATION_TYPES.SOCIETY_MEMBERSHIP_DECIDED,
    title: approve ? "Welcome to your society" : "Society request declined",
    body: approve
      ? `You are now a member of ${society.name}. Link your home address to it in My Addresses for society delivery.`
      : `Your request to join ${society.name} was declined.`,
    actionUrl: approve ? "/profile/addresses" : "/society",
  });
  return updated;
}

/** Society ADMIN changes a member's society role (never leaving the society without an admin). */
export async function setMemberRole(memberId: string, role: SocietyMemberRole, actor: Actor): Promise<SocietyMember> {
  const member = await db.query.societyMembers.findFirst({ where: eq(societyMembers.id, memberId) });
  if (!member) throw notFound("Membership");
  await requireSocietyRole(member.societyId, actor, ["ADMIN"]);
  if (member.status !== "ACTIVE") throw conflict("Only an active member can be given a role.");
  if (member.role === "ADMIN" && role !== "ADMIN") {
    const [{ admins }] = await db
      .select({ admins: sql<number>`count(*)::int` })
      .from(societyMembers)
      .where(and(eq(societyMembers.societyId, member.societyId), eq(societyMembers.role, "ADMIN"), eq(societyMembers.status, "ACTIVE")));
    if (admins <= 1) throw conflict("A society needs at least one admin.");
  }
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(societyMembers)
      .set({ role, updatedAt: new Date() })
      .where(eq(societyMembers.id, memberId))
      .returning();
    if (role !== "RESIDENT") await promoteToSocietyRole(member.userId, tx);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SOCIETY_MEMBER_CHANGED,
        entityType: "society_member",
        entityId: memberId,
        previousValue: { role: member.role },
        newValue: { role },
      },
      tx,
    );
    return updated;
  });
}

/**
 * Remove a member (society staff) or leave (the member themselves). Their
 * addresses stop being treated as inside the society.
 */
export async function removeMember(memberId: string, actor: Actor): Promise<SocietyMember> {
  const member = await db.query.societyMembers.findFirst({ where: eq(societyMembers.id, memberId) });
  if (!member) throw notFound("Membership");
  if (member.userId !== actor.id) await requireSocietyRole(member.societyId, actor, ["ADMIN", "OPERATOR"]);
  if (member.role === "ADMIN") {
    const [{ admins }] = await db
      .select({ admins: sql<number>`count(*)::int` })
      .from(societyMembers)
      .where(and(eq(societyMembers.societyId, member.societyId), eq(societyMembers.role, "ADMIN"), eq(societyMembers.status, "ACTIVE")));
    if (admins <= 1) throw conflict("A society needs at least one admin — hand over first.");
  }
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(societyMembers)
      .set({ status: "REMOVED", updatedAt: new Date() })
      .where(eq(societyMembers.id, memberId))
      .returning();
    await tx
      .update(addresses)
      .set({ societyId: null })
      .where(and(eq(addresses.userId, member.userId), eq(addresses.societyId, member.societyId)));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SOCIETY_MEMBER_CHANGED,
        entityType: "society_member",
        entityId: memberId,
        previousValue: { status: member.status },
        newValue: { status: "REMOVED" },
      },
      tx,
    );
    return updated;
  });
}

/**
 * Mark (or clear) one of the user's own addresses as inside a society they
 * are an ACTIVE member of. Society delivery rules then apply to orders to it.
 */
export async function linkAddressToSociety(userId: string, addressId: string, societyId: string | null): Promise<void> {
  const address = await db.query.addresses.findFirst({
    where: and(eq(addresses.id, addressId), eq(addresses.userId, userId), isNull(addresses.deletedAt)),
  });
  if (!address) throw notFound("Address");
  if (societyId) {
    const member = await db.query.societyMembers.findFirst({
      where: and(eq(societyMembers.societyId, societyId), eq(societyMembers.userId, userId), eq(societyMembers.status, "ACTIVE")),
    });
    const society = await db.query.societies.findFirst({ where: eq(societies.id, societyId) });
    if (!member || society?.status !== "VERIFIED") {
      throw forbidden("You can only link an address to a verified society you belong to.");
    }
  }
  await db.update(addresses).set({ societyId }).where(eq(addresses.id, addressId));
}

/** Verified societies whose boundary contains the address (suggestion for residents). */
export async function suggestSocietiesForAddress(address: { latitude: string | null; longitude: string | null; pincode: string }) {
  const rows = await db
    .select()
    .from(societies)
    .where(and(eq(societies.status, "VERIFIED"), isNull(societies.deletedAt), eq(societies.pincode, address.pincode)))
    .limit(50);
  const point = parseCoordinates(address.latitude, address.longitude);
  return rows.filter((s) => {
    const centre = parseCoordinates(s.latitude, s.longitude);
    if (!point || !centre) return true; // same PIN, no pins to compare
    return haversineDistanceKm(point, centre) * 1000 <= s.boundaryRadiusMeters;
  });
}

/**
 * The society an order to this address belongs to — only while the owner is
 * still an ACTIVE member of a VERIFIED society. Used at checkout / generation.
 */
export async function resolveAddressSociety(userId: string, societyId: string | null, client: DbClient = db): Promise<string | null> {
  if (!societyId) return null;
  const [row] = await client
    .select({ id: societies.id })
    .from(societies)
    .innerJoin(societyMembers, and(eq(societyMembers.societyId, societies.id), eq(societyMembers.userId, userId)))
    .where(and(eq(societies.id, societyId), eq(societies.status, "VERIFIED"), eq(societyMembers.status, "ACTIVE")));
  return row?.id ?? null;
}

/* ============================================ riders & shops (society admin) */

/** GS-045: add a rider by their registered mobile number. Effective immediately, audited. */
export async function addSocietyRider(societyId: string, mobile: string, preferred: boolean, actor: Actor) {
  await requireSocietyRole(societyId, actor, ["ADMIN"]);
  const digits = mobile.replace(/\D/g, "").slice(-10);
  if (!/^[6-9]\d{9}$/.test(digits)) throw validationFailed("Enter the rider's 10-digit mobile number.");
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(
      eq(deliveryPartners.status, "APPROVED"),
      isNull(deliveryPartners.deletedAt),
      sql`right(regexp_replace(${deliveryPartners.mobile}, '\\D', '', 'g'), 10) = ${digits}`,
    ),
  });
  if (!partner) throw notFound("Approved delivery partner with that mobile number");

  const [row] = await db
    .insert(societyRiders)
    .values({ societyId, deliveryPartnerId: partner.id, preferred, addedBy: actor.id })
    .onConflictDoUpdate({
      target: [societyRiders.societyId, societyRiders.deliveryPartnerId],
      set: { status: "ACTIVE", preferred, revokedAt: null, revokedBy: null, updatedAt: new Date() },
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_RIDER_CHANGED,
    entityType: "society_rider",
    entityId: row.id,
    newValue: { societyId, deliveryPartnerId: partner.id, status: "ACTIVE", preferred },
  });
  return row;
}

/** Revoke (effective immediately) or change the preferred flag of a listed rider. */
export async function updateSocietyRider(
  riderLinkId: string,
  change: { revoke?: boolean; preferred?: boolean },
  actor: Actor,
) {
  const link = await db.query.societyRiders.findFirst({ where: eq(societyRiders.id, riderLinkId) });
  if (!link) throw notFound("Society rider");
  await requireSocietyRole(link.societyId, actor, ["ADMIN"]);
  const [row] = await db
    .update(societyRiders)
    .set({
      ...(change.revoke ? { status: "REVOKED" as const, revokedBy: actor.id, revokedAt: new Date() } : {}),
      ...(change.preferred !== undefined ? { preferred: change.preferred } : {}),
      updatedAt: new Date(),
    })
    .where(eq(societyRiders.id, riderLinkId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_RIDER_CHANGED,
    entityType: "society_rider",
    entityId: riderLinkId,
    previousValue: { status: link.status, preferred: link.preferred },
    newValue: { status: row.status, preferred: row.preferred },
  });
  return row;
}

/** Add / remove a shop the society recommends to residents. */
export async function setSocietyShop(societyId: string, shopId: string, active: boolean, actor: Actor) {
  await requireSocietyRole(societyId, actor, ["ADMIN"]);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || shop.status !== "APPROVED") throw notFound("Approved shop");
  const [row] = await db
    .insert(societyShops)
    .values({ societyId, shopId, status: active ? "ACTIVE" : "REVOKED", addedBy: actor.id })
    .onConflictDoUpdate({
      target: [societyShops.societyId, societyShops.shopId],
      set: { status: active ? "ACTIVE" : "REVOKED", updatedAt: new Date() },
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_SHOP_CHANGED,
    entityType: "society_shop",
    entityId: row.id,
    newValue: { societyId, shopId, status: row.status },
  });
  return row;
}

/* ======================================================= reading */

export async function listMySocieties(userId: string) {
  return db
    .select({ membership: societyMembers, society: societies })
    .from(societyMembers)
    .innerJoin(societies, eq(societyMembers.societyId, societies.id))
    .where(and(eq(societyMembers.userId, userId), ne(societyMembers.status, "REMOVED"), isNull(societies.deletedAt)))
    .orderBy(desc(societyMembers.createdAt));
}

/** Verified societies to join, by name / area / PIN. */
export async function searchSocieties(query: string, limit = 20) {
  const term = `%${query.trim()}%`;
  return db
    .select({ id: societies.id, name: societies.name, area: societies.area, city: societies.city, pincode: societies.pincode })
    .from(societies)
    .where(
      and(
        eq(societies.status, "VERIFIED"),
        isNull(societies.deletedAt),
        query.trim() ? or(ilike(societies.name, term), ilike(societies.area, term), eq(societies.pincode, query.trim())) : undefined,
      ),
    )
    .orderBy(societies.name)
    .limit(limit);
}

/** Platform view: societies by status (verification queue). */
export async function listSocietiesForReview(status?: Society["status"]) {
  return db
    .select({
      society: societies,
      members: sql<number>`(select count(*)::int from ${societyMembers} where ${societyMembers.societyId} = ${societies.id} and ${societyMembers.status} = 'ACTIVE')`,
    })
    .from(societies)
    .where(and(isNull(societies.deletedAt), status ? eq(societies.status, status) : undefined))
    .orderBy(desc(societies.createdAt))
    .limit(200);
}

/**
 * Everything the society dashboard shows (NAV Society). Caller must be
 * society ADMIN/OPERATOR or platform staff. Residents' contact details and
 * order contents are never included.
 */
export async function getSocietyDashboard(societyId: string, actor: Actor) {
  const { society, membership } = await requireSocietyRole(societyId, actor, ["ADMIN", "OPERATOR"]);
  const [members, riders, partnerShops, recentOrders] = await Promise.all([
    db
      .select({
        id: societyMembers.id,
        role: societyMembers.role,
        status: societyMembers.status,
        unitLabel: societyMembers.unitLabel,
        name: users.name,
        createdAt: societyMembers.createdAt,
      })
      .from(societyMembers)
      .innerJoin(users, eq(societyMembers.userId, users.id))
      .where(and(eq(societyMembers.societyId, societyId), ne(societyMembers.status, "REMOVED")))
      .orderBy(societyMembers.status, societyMembers.createdAt),
    db
      .select({
        id: societyRiders.id,
        status: societyRiders.status,
        preferred: societyRiders.preferred,
        name: deliveryPartners.fullName,
        vehicleType: deliveryPartners.vehicleType,
        ratingAvgX100: deliveryPartners.ratingAvgX100,
        ratingCount: deliveryPartners.ratingCount,
      })
      .from(societyRiders)
      .innerJoin(deliveryPartners, eq(societyRiders.deliveryPartnerId, deliveryPartners.id))
      .where(eq(societyRiders.societyId, societyId))
      .orderBy(desc(societyRiders.preferred), deliveryPartners.fullName),
    db
      .select({ id: societyShops.id, shopId: shops.id, name: shops.name, status: societyShops.status, shopType: shops.shopType })
      .from(societyShops)
      .innerJoin(shops, eq(societyShops.shopId, shops.id))
      .where(and(eq(societyShops.societyId, societyId), eq(societyShops.status, "ACTIVE"))),
    db
      .select({
        orderNumber: orders.orderNumber,
        status: orders.status,
        promisedByAt: orders.promisedByAt,
        shopName: shops.name,
        riderName: deliveryPartners.fullName,
        riderVehicle: deliveryPartners.vehicleType,
        riderVehicleNumber: deliveryPartners.vehicleRegistrationNumber,
        unitLabel: societyMembers.unitLabel,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(shops, eq(orders.shopId, shops.id))
      .leftJoin(deliveryOrders, eq(deliveryOrders.orderId, orders.id))
      .leftJoin(deliveryPartners, eq(deliveryOrders.deliveryPartnerId, deliveryPartners.id))
      .leftJoin(societyMembers, and(eq(societyMembers.societyId, orders.societyId), eq(societyMembers.userId, orders.userId)))
      .where(and(eq(orders.societyId, societyId), gte(orders.createdAt, sql`now() - interval '7 days'`)))
      .orderBy(desc(orders.createdAt))
      .limit(100),
  ]);
  return { society, myRole: membership?.role ?? "PLATFORM", members, riders, partnerShops, recentOrders };
}

/* ================================================ delivery integration */

export interface SocietyDispatchRules {
  societyId: string;
  exclusive: boolean;
  /** deliveryPartnerId → preferred */
  riders: Map<string, boolean>;
}

/** GA-001/002 inputs for an order's society; null when the order is not a society delivery. */
export async function getSocietyDispatchRules(societyId: string | null, client: DbClient = db): Promise<SocietyDispatchRules | null> {
  if (!societyId) return null;
  const [society] = await client.select().from(societies).where(eq(societies.id, societyId));
  if (!society || society.status !== "VERIFIED") return null;
  const rows = await client
    .select({ deliveryPartnerId: societyRiders.deliveryPartnerId, preferred: societyRiders.preferred })
    .from(societyRiders)
    .where(and(eq(societyRiders.societyId, societyId), eq(societyRiders.status, "ACTIVE")));
  return {
    societyId,
    // Exclusive only bites when there is someone on the list — an empty list never blocks deliveries.
    exclusive: society.exclusiveRiders && rows.length > 0,
    riders: new Map(rows.map((r) => [r.deliveryPartnerId, r.preferred])),
  };
}

/** Society gate/parking notes for the rider of an active job (GS-047). */
export async function getSocietyDeliveryNotes(societyId: string | null) {
  if (!societyId) return null;
  const society = await db.query.societies.findFirst({ where: eq(societies.id, societyId) });
  if (!society || society.status !== "VERIFIED") return null;
  return { name: society.name, instructions: society.deliveryInstructions };
}

/**
 * GS-046: tell society staff which rider is coming, for which unit — only
 * when the society turned security notifications on.
 */
export async function notifySocietySecurity(orderId: string): Promise<void> {
  const [row] = await db
    .select({
      orderNumber: orders.orderNumber,
      societyId: orders.societyId,
      userId: orders.userId,
      riderName: deliveryPartners.fullName,
      vehicleType: deliveryPartners.vehicleType,
      vehicleNumber: deliveryPartners.vehicleRegistrationNumber,
    })
    .from(orders)
    .innerJoin(deliveryOrders, eq(deliveryOrders.orderId, orders.id))
    .innerJoin(deliveryPartners, eq(deliveryOrders.deliveryPartnerId, deliveryPartners.id))
    .where(eq(orders.id, orderId));
  if (!row?.societyId) return;
  const society = await db.query.societies.findFirst({ where: eq(societies.id, row.societyId) });
  if (!society || society.status !== "VERIFIED" || !society.securityNotifyEnabled) return;
  const member = await db.query.societyMembers.findFirst({
    where: and(eq(societyMembers.societyId, row.societyId), eq(societyMembers.userId, row.userId)),
  });
  for (const userId of await societyStaffUserIds(row.societyId)) {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.SOCIETY_SECURITY_ALERT,
      title: "Delivery rider on the way",
      body: `${row.riderName} (${row.vehicleType}${row.vehicleNumber ? `, ${row.vehicleNumber}` : ""}) is delivering order ${row.orderNumber}${member?.unitLabel ? ` to ${member.unitLabel}` : ""}.`,
      actionUrl: `/society/${row.societyId}`,
      dedupeKey: `society-security:${orderId}:${row.riderName}`,
    });
  }
}
