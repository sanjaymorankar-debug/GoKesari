/**
 * Consultant appointments: who may do what (docs/consult-booking-2026-11).
 *
 *  - The firm's OWNER (shops.owner_id) runs everything for the firm.
 *  - A MEMBER (consult_members.user_id) sees and runs their own calendar and
 *    the bookings assigned to them.
 *  - STAFF with consult:manage (admins, operators) see every firm and booking.
 *  - An ONBOARDER (operator-limited with consult:onboard) sets up the profile,
 *    team, services, hours and map pin of a shop they onboarded — never a
 *    customer's booking details.
 *  - The CUSTOMER sees their own bookings.
 *
 * Medical and legal notes and files are shown only to the customer, the firm
 * (owner / assigned member) and authorised staff; every look by the firm or
 * staff is written to consult_access_logs.
 */
import { and, eq } from "drizzle-orm";

import { forbidden, notFound } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import { consultAccessLogs, consultBookingMembers, consultMembers, shops, type ConsultBooking, type UserRole } from "@/server/db/schema";
import { featureNotAvailableError } from "./errors";
import { getRule } from "@/server/services/settings";

export interface ConsultActor {
  id: string;
  role: UserRole;
  name?: string | null;
  email?: string | null;
}

export type FirmRole = "OWNER" | "MEMBER" | "STAFF" | "ONBOARDER";

export interface FirmAccess {
  shopId: string;
  role: FirmRole;
  /** The actor's own member row in this firm (owners and members). */
  memberId: string | null;
  /** May change the profile, team, services, hours and policy. */
  canSetup: boolean;
  /** May see and act on bookings (all of them, or MEMBER: their own). */
  canBookings: boolean;
}

export async function consultEnabled(): Promise<boolean> {
  return (await getRule("consultBooking")).enabled;
}

/** Throws 404 "not available" while rule consultBooking is off. */
export async function requireConsultEnabled(): Promise<void> {
  if (!(await consultEnabled())) throw featureNotAvailableError();
}

export function isConsultStaff(actor: Pick<ConsultActor, "role">): boolean {
  return can(actor.role, PERMISSIONS.CONSULT_MANAGE);
}

/** The actor's access to a firm, or null. */
export async function firmAccessOrNull(shopId: string, actor: ConsultActor, client: DbClient = db): Promise<FirmAccess | null> {
  const [shop] = await client.select({ id: shops.id, ownerId: shops.ownerId, onboardedBy: shops.onboardedByUserId, deletedAt: shops.deletedAt }).from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.deletedAt) return null;
  const [own] = await client
    .select({ id: consultMembers.id })
    .from(consultMembers)
    .where(and(eq(consultMembers.shopId, shopId), eq(consultMembers.userId, actor.id), eq(consultMembers.status, "ACTIVE")))
    .limit(1);
  if (shop.ownerId === actor.id) return { shopId, role: "OWNER", memberId: own?.id ?? null, canSetup: true, canBookings: true };
  if (isConsultStaff(actor)) return { shopId, role: "STAFF", memberId: null, canSetup: true, canBookings: true };
  if (own) return { shopId, role: "MEMBER", memberId: own.id, canSetup: false, canBookings: true };
  if (can(actor.role, PERMISSIONS.CONSULT_ONBOARD) && shop.onboardedBy === actor.id) {
    return { shopId, role: "ONBOARDER", memberId: null, canSetup: true, canBookings: false };
  }
  return null;
}

export async function requireFirmAccess(shopId: string, actor: ConsultActor, need: "setup" | "bookings", client: DbClient = db): Promise<FirmAccess> {
  const access = await firmAccessOrNull(shopId, actor, client);
  if (!access) throw notFound("Consultant");
  if (need === "setup" && !access.canSetup) throw forbidden("Only the firm's owner can change this.");
  if (need === "bookings" && !access.canBookings) throw forbidden("You cannot see this firm's bookings.");
  return access;
}

export type BookingViewer = "CUSTOMER" | "FIRM" | "STAFF";

/** Who is looking at a booking, or a 404 for anyone else. A MEMBER sees only bookings assigned to them. */
export async function bookingViewer(booking: Pick<ConsultBooking, "id" | "shopId" | "customerId">, actor: ConsultActor, client: DbClient = db): Promise<{ viewer: BookingViewer; firm: FirmAccess | null }> {
  if (booking.customerId === actor.id) {
    const firm = await firmAccessOrNull(booking.shopId, actor, client);
    // A consultant booking their own firm is still the customer of that booking.
    return { viewer: "CUSTOMER", firm: firm?.canBookings ? firm : null };
  }
  const firm = await firmAccessOrNull(booking.shopId, actor, client);
  if (!firm || !firm.canBookings) throw notFound("Booking");
  if (firm.role === "STAFF") return { viewer: "STAFF", firm };
  if (firm.role === "MEMBER") {
    const [mine] = await client
      .select({ id: consultBookingMembers.id })
      .from(consultBookingMembers)
      .where(and(eq(consultBookingMembers.bookingId, booking.id), eq(consultBookingMembers.memberId, firm.memberId!)))
      .limit(1);
    if (!mine) throw notFound("Booking");
  }
  return { viewer: "FIRM", firm };
}

/** Writes who opened a private booking record, file or registration document. Never throws. */
export async function logPrivateAccess(
  entry: { bookingId?: string | null; fileId?: string | null; memberDocumentId?: string | null; actor: ConsultActor; action: string; ipAddress?: string | null },
  client: DbClient = db,
): Promise<void> {
  try {
    await client.insert(consultAccessLogs).values({
      bookingId: entry.bookingId ?? null,
      fileId: entry.fileId ?? null,
      memberDocumentId: entry.memberDocumentId ?? null,
      userId: entry.actor.id,
      role: entry.actor.role,
      action: entry.action.slice(0, 60),
      ipAddress: entry.ipAddress ?? null,
    });
  } catch (error) {
    console.error("[consult] access log failed", entry.action, error);
  }
}
