/**
 * GoKesari Health: who may see what (docs/health/README.md "Access and consent"). Enforced here, on the
 * server, for every request:
 *
 *  - PATIENT side: the account holder sees every patient in their account (self and family they manage);
 *    an adult family member with their own GoKesari account sees the record linked to them.
 *  - DOCTOR: always their own consultations with the patient; other providers' records and patient
 *    uploads only while the patient's DOCTOR_RECORDS consent for that doctor is active (ALWAYS, or
 *    THIS_BOOKING for an open booking). Every such look is written to health.access_log.
 *  - CLINIC STAFF (shop team members who are not doctors): appointments, check-in, payments — no notes.
 *  - STORE / EQUIPMENT STORE: only the prescription attached to their order (rx-orders.ts).
 *  - ADMIN / OPERATOR (health:manage): metadata only; break-glass (health:break_glass) with a reason.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { forbidden, notFound } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import type { ConsultActor } from "@/server/consult/access";
import { db, type DbClient } from "@/server/db";
import {
  consultBookings,
  consultCategories,
  consultMemberCategories,
  consultMembers,
  consultProfiles,
  healthAccessLog,
  healthConsents,
  healthDoctorProfiles,
  healthPatients,
  shops,
  type HealthPatient,
} from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { featureNotAvailableError } from "@/server/consult/errors";
import type { AccessAction } from "@/lib/health/constants";

export type HealthActor = ConsultActor;

export async function healthEnabled(): Promise<boolean> {
  return (await getRule("health")).enabled;
}

/** Throws 404 "not available" while rule health is off. */
export async function requireHealthEnabled(): Promise<void> {
  if (!(await healthEnabled())) throw featureNotAvailableError();
}

export function isHealthStaff(actor: Pick<HealthActor, "role">): boolean {
  return can(actor.role, PERMISSIONS.HEALTH_MANAGE);
}

export function canBreakGlass(actor: Pick<HealthActor, "role">): boolean {
  return can(actor.role, PERMISSIONS.HEALTH_BREAK_GLASS);
}

/* ------------------------------------------------------------ patients */

/** Patients the actor manages or is linked to (active, not hidden). */
export async function patientsForUser(userId: string, client: DbClient = db): Promise<HealthPatient[]> {
  return client
    .select()
    .from(healthPatients)
    .where(
      and(
        isNull(healthPatients.hiddenAt),
        or(
          eq(healthPatients.accountUserId, userId),
          and(eq(healthPatients.linkedUserId, userId), eq(healthPatients.linkStatus, "ACTIVE")),
        ),
      ),
    )
    .orderBy(sql`case when ${healthPatients.relation} = 'SELF' then 0 else 1 end`, healthPatients.createdAt);
}

/**
 * The patient, if the actor may see and manage their record (account holder, or the linked adult
 * themselves). A pending adult link is visible to the account holder only (to finish the OTP step).
 */
export async function requirePatientAccess(patientId: string, actor: HealthActor, client: DbClient = db): Promise<HealthPatient> {
  const [p] = await client.select().from(healthPatients).where(eq(healthPatients.id, patientId));
  if (!p || p.hiddenAt) throw notFound("Patient");
  if (p.accountUserId === actor.id) return p;
  if (p.linkedUserId === actor.id && p.linkStatus === "ACTIVE") return p;
  throw notFound("Patient");
}

/** Users who should be told about a patient's record (account holder + linked adult). */
export function patientAudience(p: Pick<HealthPatient, "accountUserId" | "linkedUserId" | "linkStatus">): string[] {
  const ids = [p.accountUserId];
  if (p.linkedUserId && p.linkStatus === "ACTIVE" && p.linkedUserId !== p.accountUserId) ids.push(p.linkedUserId);
  return ids;
}

/* ------------------------------------------------------------ doctors */

export interface DoctorContext {
  memberId: string;
  shopId: string;
  profileId: string;
  name: string;
  userId: string | null;
  isOwner: boolean;
  /** The firm owner (not a doctor) acting for the clinic. */
  actingAs: "DOCTOR" | "OWNER";
  verified: boolean;
  registrationNumber: string | null;
  council: string | null;
}

/**
 * Is this consult member a doctor (a member of a category that requires a medical / dental / AYUSH
 * council registration) — and verified: registration certificate verified, practice verified by staff,
 * and a health doctor profile with council and registration number.
 */
export async function doctorStatus(memberId: string, client: DbClient = db): Promise<{ isDoctor: boolean; verified: boolean; reasons: string[] }> {
  const [m] = await client
    .select({ id: consultMembers.id, docStatus: consultMembers.docStatus, status: consultMembers.status, profileVerification: consultProfiles.verification, profileStatus: consultProfiles.status })
    .from(consultMembers)
    .innerJoin(consultProfiles, eq(consultProfiles.id, consultMembers.profileId))
    .where(eq(consultMembers.id, memberId));
  if (!m) return { isDoctor: false, verified: false, reasons: ["Not found."] };
  const cats = await client
    .select({ requiredDoc: consultCategories.requiredDoc })
    .from(consultMemberCategories)
    .innerJoin(consultCategories, eq(consultCategories.id, consultMemberCategories.categoryId))
    .where(eq(consultMemberCategories.memberId, memberId));
  const isDoctor = cats.some((c) => c.requiredDoc === "MEDICAL_REGISTRATION");
  const [dp] = await client.select({ id: healthDoctorProfiles.id }).from(healthDoctorProfiles).where(eq(healthDoctorProfiles.memberId, memberId));
  const reasons: string[] = [];
  if (!isDoctor) reasons.push("Not in a doctor category (one that needs a medical council registration).");
  if (m.status !== "ACTIVE") reasons.push("The team member is inactive.");
  if (m.docStatus !== "VERIFIED") reasons.push("The medical registration certificate is not verified yet.");
  if (m.profileVerification !== "VERIFIED") reasons.push("The practice is not verified by GoKesari yet.");
  if (!dp) reasons.push("The doctor's council, registration number and qualifications are not filled in (Health → Doctor profile).");
  return { isDoctor, verified: reasons.length === 0, reasons };
}

/** The member rows that are the actor's own doctor identities (one per clinic). */
export async function ownDoctorMembers(actor: HealthActor, client: DbClient = db): Promise<{ memberId: string; shopId: string; profileId: string; name: string }[]> {
  return client
    .select({ memberId: consultMembers.id, shopId: consultMembers.shopId, profileId: consultMembers.profileId, name: consultMembers.name })
    .from(consultMembers)
    .where(and(eq(consultMembers.userId, actor.id), eq(consultMembers.status, "ACTIVE")));
}

/**
 * The doctor context for acting on a member's consultations: the member themselves, or the clinic's
 * owner (who may run the clinic's pad for a doctor in their team, e.g. a one-person practice whose
 * member row is not linked to a login). Staff never get a clinical context here.
 */
export async function requireDoctorContext(memberId: string, actor: HealthActor, client: DbClient = db): Promise<DoctorContext> {
  const [m] = await client
    .select({
      memberId: consultMembers.id,
      shopId: consultMembers.shopId,
      profileId: consultMembers.profileId,
      name: consultMembers.name,
      userId: consultMembers.userId,
      isOwner: consultMembers.isOwner,
      ownerId: shops.ownerId,
      registrationNumber: healthDoctorProfiles.registrationNumber,
      council: healthDoctorProfiles.council,
    })
    .from(consultMembers)
    .innerJoin(shops, eq(shops.id, consultMembers.shopId))
    .leftJoin(healthDoctorProfiles, eq(healthDoctorProfiles.memberId, consultMembers.id))
    .where(eq(consultMembers.id, memberId));
  if (!m) throw notFound("Doctor");
  let actingAs: DoctorContext["actingAs"];
  if (m.userId === actor.id) actingAs = "DOCTOR";
  else if (m.ownerId === actor.id && (m.isOwner || !m.userId)) actingAs = "OWNER";
  else throw notFound("Doctor");
  const status = await doctorStatus(memberId, client);
  return { memberId: m.memberId, shopId: m.shopId, profileId: m.profileId, name: m.name, userId: m.userId, isOwner: m.isOwner, actingAs, verified: status.verified, registrationNumber: m.registrationNumber, council: m.council };
}

/** Throws unless the doctor is verified (unverified doctors cannot consult or prescribe). */
export async function requireVerifiedDoctor(memberId: string, actor: HealthActor, client: DbClient = db): Promise<DoctorContext> {
  const ctx = await requireDoctorContext(memberId, actor, client);
  if (!ctx.verified) {
    const { reasons } = await doctorStatus(memberId, client);
    throw forbidden(`Only verified doctors can do this. ${reasons.join(" ")}`);
  }
  return ctx;
}

/** Every member id of the same doctor (the same login across clinics), for "own consultations". */
export async function sameDoctorMemberIds(memberId: string, client: DbClient = db): Promise<string[]> {
  const [m] = await client.select({ userId: consultMembers.userId }).from(consultMembers).where(eq(consultMembers.id, memberId));
  if (!m?.userId) return [memberId];
  const rows = await client.select({ id: consultMembers.id }).from(consultMembers).where(eq(consultMembers.userId, m.userId));
  return [...new Set([memberId, ...rows.map((r) => r.id)])];
}

/** Has the doctor ever had a booking or consultation with this patient (a reason to open the summary)? */
export async function doctorKnowsPatient(memberIds: readonly string[], patientId: string, client: DbClient = db): Promise<boolean> {
  const rows = await client.execute<{ ok: number }>(sql`
    select 1 as ok from health.consultations c where c.patient_id = ${patientId} and c.member_id in ${memberIds as string[]}
    union all
    select 1 from health.appointment_links l
      join consult_booking_members bm on bm.booking_id = l.booking_id
     where l.patient_id = ${patientId} and bm.member_id in ${memberIds as string[]}
    union all
    select 1 from health.suggestions s
     where s.patient_id = ${patientId} and s.target_member_id in ${memberIds as string[]}
    limit 1`);
  return rows.length > 0;
}

/**
 * May this doctor see the patient's OTHER records (other doctors, providers, uploads)? Only while a
 * DOCTOR_RECORDS / REFERRAL_RECORDS consent for one of the doctor's member rows is active: ALWAYS, or
 * THIS_BOOKING tied to a booking that is not finished more than a day ago.
 */
export async function recordConsentFor(patientId: string, memberIds: readonly string[], client: DbClient = db, now: Date = new Date()): Promise<{ allowed: boolean; mode: "ALWAYS" | "THIS_BOOKING" | "ASK" | "OFF"; consentId: string | null }> {
  const rows = await client
    .select({ id: healthConsents.id, mode: healthConsents.mode, bookingId: healthConsents.bookingId })
    .from(healthConsents)
    .where(
      and(
        eq(healthConsents.patientId, patientId),
        inArray(healthConsents.kind, ["DOCTOR_RECORDS", "REFERRAL_RECORDS"]),
        inArray(healthConsents.granteeMemberId, memberIds as string[]),
        isNull(healthConsents.revokedAt),
      ),
    );
  const always = rows.find((r) => r.mode === "ALWAYS");
  if (always) return { allowed: true, mode: "ALWAYS", consentId: always.id };
  for (const r of rows.filter((x) => x.mode === "THIS_BOOKING" && x.bookingId)) {
    const [b] = await client.select({ endsAt: consultBookings.endsAt, status: consultBookings.status }).from(consultBookings).where(eq(consultBookings.id, r.bookingId!));
    if (b && ["CONFIRMED", "PENDING_APPROVAL", "COMPLETED"].includes(b.status) && b.endsAt.getTime() + 24 * 3_600_000 > now.getTime()) {
      return { allowed: true, mode: "THIS_BOOKING", consentId: r.id };
    }
  }
  if (rows.some((r) => r.mode === "ASK")) return { allowed: false, mode: "ASK", consentId: null };
  return { allowed: false, mode: "OFF", consentId: null };
}

/* ------------------------------------------------------------ access log */

export interface AccessLogEntry {
  patientId: string;
  actor: HealthActor | null;
  actorLabel: string;
  actorRole?: string;
  action: AccessAction;
  objectType: string;
  objectId?: string | null;
  reason?: string | null;
  ipAddress?: string | null;
}

/** Writes one access-log row (the patient sees these). Never throws. */
export async function logRecordAccess(entry: AccessLogEntry, client: DbClient = db): Promise<void> {
  try {
    await client.insert(healthAccessLog).values({
      patientId: entry.patientId,
      actorUserId: entry.actor?.id ?? null,
      actorRole: (entry.actorRole ?? entry.actor?.role ?? "SYSTEM").slice(0, 40),
      actorLabel: entry.actorLabel.slice(0, 160),
      action: entry.action,
      objectType: entry.objectType.slice(0, 40),
      objectId: entry.objectId ?? null,
      reason: entry.reason?.slice(0, 500) ?? null,
      ipAddress: entry.ipAddress ?? null,
    });
  } catch (error) {
    console.error("[health] access log failed", entry.action, error);
  }
}

/** Display label for a doctor in the patient's access log: "Dr <name> (<clinic>)". */
export async function doctorLabel(memberId: string, client: DbClient = db): Promise<string> {
  const [m] = await client
    .select({ name: consultMembers.name, clinic: shops.name, full: healthDoctorProfiles.fullName })
    .from(consultMembers)
    .innerJoin(shops, eq(shops.id, consultMembers.shopId))
    .leftJoin(healthDoctorProfiles, eq(healthDoctorProfiles.memberId, consultMembers.id))
    .where(eq(consultMembers.id, memberId));
  if (!m) return "A doctor";
  const name = m.full ?? m.name;
  return `${/^dr\.?\s/i.test(name) ? name : `Dr ${name}`} (${m.clinic})`;
}

/** Users who run a practice / store: the owner and every active member with a login. */
export async function firmUserIds(shopId: string, client: DbClient = db): Promise<string[]> {
  const [s] = await client.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  const members = await client.select({ userId: consultMembers.userId }).from(consultMembers).where(and(eq(consultMembers.shopId, shopId), eq(consultMembers.status, "ACTIVE")));
  return [...new Set([s?.ownerId, ...members.map((m) => m.userId)].filter((v): v is string => Boolean(v)))];
}

/** Shops the user works for (owner or active team member) — the live stream's shop channels. */
export async function shopsOfUser(userId: string, client: DbClient = db): Promise<string[]> {
  const owned = await client.select({ id: shops.id }).from(shops).where(and(eq(shops.ownerId, userId), isNull(shops.deletedAt)));
  const member = await client.select({ id: consultMembers.shopId }).from(consultMembers).where(and(eq(consultMembers.userId, userId), eq(consultMembers.status, "ACTIVE")));
  return [...new Set([...owned.map((r) => r.id), ...member.map((r) => r.id)])];
}

/* ------------------------------------------------------------ which shops are in Health */

/** Shop types that are medical by nature (owner, 20-Nov-2026: Health is only for the medical field). */
export const HEALTH_SHOP_TYPES = ["DOCTOR_CLINIC", "SUPER_SPECIALITY_CLINIC", "PHARMACY", "MEDICAL_EQUIPMENT"] as const;

/** Board flag that shows Seller Central → Orders → Health (src/lib/board/menus.ts). */
export const HEALTH_BOARD_FLAG = "health_provider";

/**
 * Is this shop part of GoKesari Health? Its type is medical (clinic, pharmacy, equipment store), or it is a
 * practice (consultant / firm) with a team member in a doctor or home-care category. A grocery or hardware
 * shop never is.
 */
export async function isHealthShop(shopId: string, client: DbClient = db): Promise<boolean> {
  const [s] = await client.select({ type: shops.shopType }).from(shops).where(eq(shops.id, shopId));
  if (!s) return false;
  if ((HEALTH_SHOP_TYPES as readonly string[]).includes(s.type)) return true;
  const rows = await client.execute<{ ok: number }>(sql`
    select 1 as ok from consult_members m
      join consult_member_categories mc on mc.member_id = m.id
      join consult_categories c on c.id = mc.category_id
     where m.shop_id = ${shopId} and m.status = 'ACTIVE'
       and (c.required_doc = 'MEDICAL_REGISTRATION' or c.group_name = 'Home care' or c.slug = 'physiotherapist')
     limit 1`);
  return rows.length > 0;
}
