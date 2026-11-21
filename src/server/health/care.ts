/**
 * GoKesari Health: home care (owner brief §2.6, §4.2) — nurse, physiotherapist, massage therapist,
 * caretaker / attendant, baby care / japa, home sample collection.
 *
 * Home-care providers are consult members of a practice (an individual or an agency). The consult engine
 * already does registration, team, services, hours, certificates, verification, booking, payment,
 * refunds, rating and disputes; this module adds the health layer on top:
 *
 *  - the provider profile (kind, gender, care categories, registration, police verification set by staff,
 *    service PIN codes / radius) and an ID card with a QR to a public verify page;
 *  - a care visit for every health booking in a home-care category: SCHEDULED → "On my way" (live
 *    location, distance / ETA for the patient) → check-in with the patient's first OTP → IN_PROGRESS →
 *    check-out with the second OTP, notes and vitals → COMPLETED (an encrypted visit-note PDF in the
 *    patient's record, a timeline row, the consult booking completed and settled);
 *  - packages (N sessions booked one after another), SOS during a visit (emergency contact SMS + an urgent
 *    support ticket), rating and complaints (consult), agency reassignment, earnings.
 *
 * The provider sees the booking, address and instructions, and the patient's records only when the
 * patient shared them for that booking; every such look is in the patient's access log.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";

import { formatSlot, istDateKey, addDays, istAt } from "@/lib/consult/time";
import { getEnv } from "@/lib/env";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { CARE_CATEGORY_GROUP, CARE_VISIT_STATUS_LABELS, EXTRA_CARE_CATEGORY_SLUGS, GENDERS, SHARE_CHOICES, type CareVisitStatus } from "@/lib/health/constants";
import { PdfDocument, mm, wrapText } from "@/lib/health/pdf-writer";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { bookingViewer, firmAccessOrNull, requireFirmAccess, type FirmAccess } from "@/server/consult/access";
import { cancelBooking, completeBooking, completionNeedsCode, decideBooking, markArrived, raiseDispute, rateBooking, reassignBooking } from "@/server/consult/bookings";
import { publicProfileBySlug, searchConsultants, type ConsultantCard } from "@/server/consult/discovery";
import { completionCode } from "@/server/consult/otp";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  consultBookingMembers,
  consultBookings,
  consultCategories,
  consultMemberCategories,
  consultMembers,
  consultProfiles,
  consultServices,
  healthAppointmentLinks,
  healthCarePackages,
  healthCareProviderProfiles,
  healthCareVisits,
  healthDocuments,
  healthPatients,
  healthPrescriptions,
  healthSuggestions,
  shops,
  supportTickets,
  type ConsultBooking,
  type HealthCarePackage,
  type HealthCareProviderProfile,
  type HealthCareVisit,
  type HealthPatient,
  type Vitals,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify, NOTIFICATION_TYPES } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { firmUserIds, isHealthStaff, logRecordAccess, patientAudience, requireHealthEnabled, requirePatientAccess, type HealthActor } from "./access";
import { publishHealthEvent, pushLiveOnly, type HealthEventName } from "./events";
import { addTimeline, nextNumber } from "./timeline";

const MIN = 60_000;
const HOUR = 60 * MIN;

/* ------------------------------------------------------------ categories */

export interface CareCategory {
  id: string;
  slug: string;
  name: string;
  requiredDoc: string;
  requiredDocLabel: string | null;
}

/** The home-care categories: group "Home care" plus physiotherapists (in "Health — Therapy", 0160). */
export async function careCategories(client: DbClient = db): Promise<CareCategory[]> {
  return client
    .select({ id: consultCategories.id, slug: consultCategories.slug, name: consultCategories.name, requiredDoc: consultCategories.requiredDoc, requiredDocLabel: consultCategories.requiredDocLabel })
    .from(consultCategories)
    .where(and(eq(consultCategories.status, "ACTIVE"), or(eq(consultCategories.groupName, CARE_CATEGORY_GROUP), inArray(consultCategories.slug, [...EXTRA_CARE_CATEGORY_SLUGS]))))
    .orderBy(asc(consultCategories.sortOrder), asc(consultCategories.name));
}

/** Care categories of each member (only the home-care ones). */
async function memberCareCategories(memberIds: readonly string[], client: DbClient = db): Promise<Map<string, CareCategory[]>> {
  const out = new Map<string, CareCategory[]>();
  if (!memberIds.length) return out;
  const cats = await careCategories(client);
  if (!cats.length) return out;
  const rows = await client
    .select({ memberId: consultMemberCategories.memberId, categoryId: consultMemberCategories.categoryId })
    .from(consultMemberCategories)
    .where(and(inArray(consultMemberCategories.memberId, [...memberIds]), inArray(consultMemberCategories.categoryId, cats.map((c) => c.id))));
  for (const r of rows) {
    const c = cats.find((x) => x.id === r.categoryId);
    if (!c) continue;
    out.set(r.memberId, [...(out.get(r.memberId) ?? []), c]);
  }
  return out;
}

/* ------------------------------------------------------------ verification */

export interface CareBadges {
  memberId: string;
  /** Shown in search and bookable through Health. */
  verified: boolean;
  hasProfile: boolean;
  profileVerified: boolean;
  documentRequired: boolean;
  documentVerified: boolean;
  police: string | null;
  policeVerified: boolean;
  reasons: string[];
}

/**
 * A provider is listed only when: their health care profile exists, the practice is verified by GoKesari,
 * the registration certificate is verified where the category needs one (nurse, sample collection,
 * physiotherapist), police verification is VERIFIED (or staff marked it not required), and they are active.
 */
export async function careBadges(memberIds: readonly string[], client: DbClient = db): Promise<Map<string, CareBadges>> {
  const out = new Map<string, CareBadges>();
  if (!memberIds.length) return out;
  const rows = await client
    .select({ id: consultMembers.id, status: consultMembers.status, docStatus: consultMembers.docStatus, verification: consultProfiles.verification, profileStatus: consultProfiles.status, care: healthCareProviderProfiles })
    .from(consultMembers)
    .innerJoin(consultProfiles, eq(consultProfiles.id, consultMembers.profileId))
    .leftJoin(healthCareProviderProfiles, eq(healthCareProviderProfiles.memberId, consultMembers.id))
    .where(inArray(consultMembers.id, [...memberIds]));
  const cats = await memberCareCategories(memberIds, client);
  for (const r of rows) {
    const mc = cats.get(r.id) ?? [];
    const documentRequired = mc.some((c) => c.requiredDoc !== "NONE");
    const documentVerified = !documentRequired || r.docStatus === "VERIFIED";
    const profileVerified = r.verification === "VERIFIED";
    const police = r.care?.policeVerification ?? null;
    const reasons: string[] = [];
    if (!mc.length) reasons.push("Not in a home-care category.");
    if (!r.care) reasons.push("The home-care provider profile is not filled in (Health → Home care → Provider profile).");
    if (r.status !== "ACTIVE") reasons.push("The team member is inactive.");
    if (!profileVerified) reasons.push("The practice is not verified by GoKesari yet.");
    if (!documentVerified) reasons.push("The registration certificate is not verified yet.");
    if (police === "PENDING") reasons.push("Police verification is pending.");
    if (police === "FAILED") reasons.push("Police verification failed.");
    out.set(r.id, {
      memberId: r.id,
      verified: reasons.length === 0,
      hasProfile: Boolean(r.care),
      profileVerified,
      documentRequired,
      documentVerified,
      police,
      policeVerified: police === "VERIFIED",
      reasons,
    });
  }
  return out;
}

export async function careVerification(memberId: string, client: DbClient = db): Promise<CareBadges> {
  const m = (await careBadges([memberId], client)).get(memberId);
  if (!m) throw notFound("Provider");
  return m;
}

/* ------------------------------------------------------------ provider profile */

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const careProfileInput = z.object({
  memberId: z.string().uuid(),
  providerKind: z.enum(["INDIVIDUAL", "AGENCY"]).default("INDIVIDUAL"),
  gender: z.enum(GENDERS).nullish(),
  careCategories: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  registrationBody: optText(160),
  registrationNumber: optText(80),
  servicePincodes: z.array(z.string().trim().regex(/^\d{6}$/, "PIN codes have 6 digits.")).max(50).default([]),
  serviceRadiusKm: z.number().int().min(1).max(100).default(10),
});
export type CareProfileInput = z.input<typeof careProfileInput>;

async function memberOrThrow(memberId: string, client: DbClient = db) {
  const [m] = await client
    .select({ member: consultMembers, shopName: shops.name, shopSlug: shops.slug, ownerId: shops.ownerId })
    .from(consultMembers)
    .innerJoin(shops, eq(shops.id, consultMembers.shopId))
    .where(eq(consultMembers.id, memberId));
  if (!m) throw notFound("Team member");
  return m;
}

/** The member themself, or whoever may set up the practice (owner, staff, onboarder). */
async function requireMemberEditor(memberId: string, actor: HealthActor) {
  const m = await memberOrThrow(memberId);
  if (m.member.userId !== actor.id) await requireFirmAccess(m.member.shopId, actor, "setup");
  return m;
}

/** Saves a home-care provider's profile; a new profile gets its ID card number and waits for police verification. */
export async function saveCareProviderProfile(raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthCareProviderProfile> {
  await requireHealthEnabled();
  const input = careProfileInput.parse(raw);
  const m = await requireMemberEditor(input.memberId, actor);
  const own = (await memberCareCategories([m.member.id])).get(m.member.id) ?? [];
  if (!own.length) throw validationFailed("Add a home-care category to this team member first (Appointments → Setup → Team).");
  const all = await careCategories();
  const chosen = input.careCategories.length ? input.careCategories : own.map((c) => c.slug);
  const unknown = chosen.filter((s) => !all.some((c) => c.slug === s));
  if (unknown.length) throw validationFailed("Choose home-care categories from the list.", { fields: { careCategories: "Unknown category." } });
  const needsRegistration = all.filter((c) => chosen.includes(c.slug)).some((c) => c.requiredDoc !== "NONE");
  if (needsRegistration && (!input.registrationBody || !input.registrationNumber)) {
    throw validationFailed("Enter the registration body and number (for example the State Nursing Council registration).", { fields: { registrationNumber: "Required for this category." } });
  }
  const [existing] = await db.select().from(healthCareProviderProfiles).where(eq(healthCareProviderProfiles.memberId, m.member.id));
  const values = {
    providerKind: input.providerKind,
    gender: input.gender ?? null,
    careCategories: [...new Set(chosen)],
    registrationBody: input.registrationBody,
    registrationNumber: input.registrationNumber,
    servicePincodes: [...new Set(input.servicePincodes)],
    serviceRadiusKm: input.serviceRadiusKm,
    updatedAt: now,
  };
  const row = await db.transaction(async (tx) => {
    let saved: HealthCareProviderProfile;
    if (existing) {
      [saved] = await tx.update(healthCareProviderProfiles).set(values).where(eq(healthCareProviderProfiles.id, existing.id)).returning();
    } else {
      const year = istDateKey(now).slice(0, 4);
      const n = await nextNumber(tx, `GKC-${year}`);
      [saved] = await tx
        .insert(healthCareProviderProfiles)
        .values({ ...values, memberId: m.member.id, shopId: m.member.shopId, userId: m.member.userId, policeVerification: "PENDING", idCardNumber: `GKC-${year}-${String(n).padStart(5, "0")}`, createdAt: now })
        .returning();
    }
    // Keep the consult member's registration fields (shown on the public profile) in step.
    if (input.registrationNumber || input.registrationBody) {
      await tx
        .update(consultMembers)
        .set({ registrationNumber: input.registrationNumber ?? m.member.registrationNumber, registrationBody: input.registrationBody ?? m.member.registrationBody, updatedAt: now })
        .where(eq(consultMembers.id, m.member.id));
    }
    if (!existing) await publishHealthEvent({ name: "provider.verification_pending", shopId: m.member.shopId, subjectId: m.member.id, payload: { kind: "CARE_PROVIDER" } }, tx);
    return saved;
  });
  return row;
}

export interface CareProviderRow {
  memberId: string;
  name: string;
  title: string | null;
  photoUrl: string | null;
  userId: string | null;
  categories: CareCategory[];
  profile: HealthCareProviderProfile | null;
  badges: CareBadges | null;
}

/** The practice's home-care team (owner / staff), or the member's own row (a member). */
export async function careTeam(shopId: string, actor: HealthActor): Promise<{ access: FirmAccess; members: CareProviderRow[]; categories: CareCategory[] }> {
  const access = await requireFirmAccess(shopId, actor, "bookings");
  const members = await db
    .select()
    .from(consultMembers)
    .where(and(eq(consultMembers.shopId, shopId), access.role === "MEMBER" && access.memberId ? eq(consultMembers.id, access.memberId) : undefined))
    .orderBy(asc(consultMembers.sortOrder), asc(consultMembers.createdAt));
  const ids = members.map((m) => m.id);
  const [cats, profiles, badges, all] = await Promise.all([
    memberCareCategories(ids),
    ids.length ? db.select().from(healthCareProviderProfiles).where(inArray(healthCareProviderProfiles.memberId, ids)) : Promise.resolve([] as HealthCareProviderProfile[]),
    careBadges(ids),
    careCategories(),
  ]);
  return {
    access,
    categories: all,
    members: members
      .filter((m) => (cats.get(m.id) ?? []).length > 0)
      .map((m) => ({ memberId: m.id, name: m.name, title: m.title, photoUrl: m.photoUrl, userId: m.userId, categories: cats.get(m.id) ?? [], profile: profiles.find((p) => p.memberId === m.id) ?? null, badges: badges.get(m.id) ?? null })),
  };
}

export interface PendingCareProvider {
  memberId: string;
  profileId: string;
  name: string;
  shopId: string;
  shopName: string;
  idCardNumber: string;
  providerKind: string;
  gender: string | null;
  careCategories: string[];
  registrationBody: string | null;
  registrationNumber: string | null;
  policeVerification: string;
  documentStatus: string;
  practiceVerification: string;
  createdAt: Date;
}

/** Care providers waiting for staff (police verification, certificate or practice verification) — for Admin → Health. */
export async function pendingCareProviders(): Promise<PendingCareProvider[]> {
  const rows = await db
    .select({ care: healthCareProviderProfiles, name: consultMembers.name, docStatus: consultMembers.docStatus, verification: consultProfiles.verification, shopName: shops.name })
    .from(healthCareProviderProfiles)
    .innerJoin(consultMembers, eq(consultMembers.id, healthCareProviderProfiles.memberId))
    .innerJoin(consultProfiles, eq(consultProfiles.id, consultMembers.profileId))
    .innerJoin(shops, eq(shops.id, healthCareProviderProfiles.shopId))
    .where(or(eq(healthCareProviderProfiles.policeVerification, "PENDING"), eq(consultMembers.docStatus, "SUBMITTED"), eq(consultProfiles.verification, "PENDING")))
    .orderBy(asc(healthCareProviderProfiles.createdAt))
    .limit(500);
  return rows.map((r) => ({
    memberId: r.care.memberId,
    profileId: r.care.id,
    name: r.name,
    shopId: r.care.shopId,
    shopName: r.shopName,
    idCardNumber: r.care.idCardNumber,
    providerKind: r.care.providerKind,
    gender: r.care.gender,
    careCategories: r.care.careCategories,
    registrationBody: r.care.registrationBody,
    registrationNumber: r.care.registrationNumber,
    policeVerification: r.care.policeVerification,
    documentStatus: r.docStatus,
    practiceVerification: r.verification,
    createdAt: r.care.createdAt,
  }));
}

export const POLICE_STATUSES = ["PENDING", "VERIFIED", "FAILED", "NOT_REQUIRED"] as const;
export type PoliceStatus = (typeof POLICE_STATUSES)[number];

/** Staff (health:manage) record the police verification result. The provider is told. */
export async function setPoliceVerification(memberId: string, status: PoliceStatus, actor: HealthActor): Promise<HealthCareProviderProfile> {
  if (!isHealthStaff(actor)) throw forbidden("Only GoKesari Health staff can record police verification.");
  if (!(POLICE_STATUSES as readonly string[]).includes(status)) throw validationFailed("Unknown police verification status.");
  const [p] = await db.select().from(healthCareProviderProfiles).where(eq(healthCareProviderProfiles.memberId, memberId));
  if (!p) throw notFound("Care provider");
  const m = await memberOrThrow(memberId);
  const row = await db.transaction(async (tx) => {
    const [u] = await tx.update(healthCareProviderProfiles).set({ policeVerification: status, updatedAt: new Date() }).where(eq(healthCareProviderProfiles.id, p.id)).returning();
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_CARE_PROVIDER, entityType: "health_care_provider", entityId: p.id, previousValue: { policeVerification: p.policeVerification }, newValue: { policeVerification: status } },
      tx,
    );
    const name: HealthEventName = status === "FAILED" ? "provider.rejected" : status === "PENDING" ? "provider.verification_pending" : "provider.verified";
    await publishHealthEvent({ name, shopId: p.shopId, userIds: [m.member.userId, m.ownerId], subjectId: memberId, payload: { kind: "CARE_PROVIDER", police: status } }, tx);
    return u;
  });
  const text =
    status === "VERIFIED"
      ? `Police verification of ${m.member.name} is complete. The Police verified badge now shows on the profile and ID card.`
      : status === "FAILED"
        ? `Police verification of ${m.member.name} could not be completed. The provider is hidden from GoKesari Health until it is resolved. Contact GoKesari support.`
        : status === "NOT_REQUIRED"
          ? `GoKesari marked police verification as not required for ${m.member.name}.`
          : `Police verification of ${m.member.name} is pending.`;
  for (const userId of [...new Set([m.member.userId, m.ownerId].filter((v): v is string => Boolean(v)))]) {
    await notify({ userId, type: NOTIFICATION_TYPES.HEALTH_VERIFICATION, title: "Home-care provider verification", body: text, actionUrl: "/shop/health/care/profile", channels: ["PUSH"], metadata: { memberId, police: status } });
  }
  return row;
}

/* ------------------------------------------------------------ ID card */

const siteBase = () => (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
export const idCardVerifyUrl = (card: string) => `${siteBase()}/health/care/id/${encodeURIComponent(card)}`;

export interface CareIdCard {
  memberId: string;
  idCardNumber: string;
  name: string;
  title: string | null;
  photoUrl: string | null;
  categories: string[];
  providerKind: string;
  gender: string | null;
  shopName: string;
  registrationBody: string | null;
  registrationNumber: string | null;
  badges: CareBadges;
  verifyUrl: string;
  qrSvg: string;
}

async function idCardOf(memberId: string): Promise<CareIdCard | null> {
  const [p] = await db.select().from(healthCareProviderProfiles).where(eq(healthCareProviderProfiles.memberId, memberId));
  if (!p) return null;
  const m = await memberOrThrow(memberId);
  const cats = (await memberCareCategories([memberId])).get(memberId) ?? [];
  const badges = await careVerification(memberId);
  const verifyUrl = idCardVerifyUrl(p.idCardNumber);
  return {
    memberId,
    idCardNumber: p.idCardNumber,
    name: m.member.name,
    title: m.member.title,
    photoUrl: m.member.photoUrl,
    categories: cats.filter((c) => p.careCategories.includes(c.slug) || !p.careCategories.length).map((c) => c.name),
    providerKind: p.providerKind,
    gender: p.gender,
    shopName: m.shopName,
    registrationBody: p.registrationBody,
    registrationNumber: p.registrationNumber,
    badges,
    verifyUrl,
    qrSvg: await QRCode.toString(verifyUrl, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 180 }),
  };
}

/** The provider's ID card (the member themself, or the practice). */
export async function careIdCard(memberId: string, actor: HealthActor): Promise<CareIdCard> {
  const m = await memberOrThrow(memberId);
  if (m.member.userId !== actor.id) await requireFirmAccess(m.member.shopId, actor, "bookings");
  const card = await idCardOf(memberId);
  if (!card) throw notFound("ID card");
  return card;
}

/** Public verify page behind the ID card's QR: name, photo and verified status only. */
export async function publicIdCard(idCardNumber: string): Promise<{ idCardNumber: string; name: string; photoUrl: string | null; verified: boolean; policeVerified: boolean } | null> {
  const card = idCardNumber.trim().toUpperCase();
  if (!/^GKC-\d{4}-\d{1,8}$/.test(card)) return null;
  const [p] = await db.select().from(healthCareProviderProfiles).where(eq(healthCareProviderProfiles.idCardNumber, card));
  if (!p) return null;
  const [m] = await db.select({ name: consultMembers.name, photoUrl: consultMembers.photoUrl }).from(consultMembers).where(eq(consultMembers.id, p.memberId));
  if (!m) return null;
  const badges = await careVerification(p.memberId);
  return { idCardNumber: p.idCardNumber, name: m.name, photoUrl: m.photoUrl, verified: badges.verified, policeVerified: badges.policeVerified };
}

/* ------------------------------------------------------------ booking → visit */

async function isCareBooking(booking: Pick<ConsultBooking, "id" | "categoryId" | "mode">, client: DbClient = db): Promise<{ care: boolean; memberId: string | null }> {
  const cats = await careCategories(client);
  const [bm] = await client.select({ memberId: consultBookingMembers.memberId }).from(consultBookingMembers).where(eq(consultBookingMembers.bookingId, booking.id)).limit(1);
  if (booking.categoryId && cats.some((c) => c.id === booking.categoryId)) return { care: true, memberId: bm?.memberId ?? null };
  if (booking.mode === "HOME_VISIT" && bm) {
    const mc = (await memberCareCategories([bm.memberId], client)).get(bm.memberId) ?? [];
    if (mc.length) return { care: true, memberId: bm.memberId };
  }
  return { care: false, memberId: bm?.memberId ?? null };
}

/** Called by createHealthBooking after a booking is linked to a patient: starts a care visit for home-care categories. */
export async function onHealthBookingCreated(booking: ConsultBooking, patient: HealthPatient): Promise<void> {
  const { care, memberId } = await isCareBooking(booking);
  if (!care) return;
  const [link] = await db.select({ shareRecords: healthAppointmentLinks.shareRecords }).from(healthAppointmentLinks).where(eq(healthAppointmentLinks.bookingId, booking.id));
  const [visit] = await db
    .insert(healthCareVisits)
    .values({
      bookingId: booking.id,
      patientId: patient.id,
      shopId: booking.shopId,
      memberId,
      status: "SCHEDULED",
      otpSalt: randomBytes(8).toString("hex"),
      shareRecords: Boolean(link && link.shareRecords !== "OFF"),
    })
    .onConflictDoNothing()
    .returning();
  if (!visit) return;
  await publishHealthEvent({ name: "care_booking.created", userIds: patientAudience(patient), shopId: booking.shopId, subjectId: visit.id, payload: { visitId: visit.id, bookingId: booking.id, status: booking.status } });
  const team = memberId ? await careTeamUsers(booking.shopId, memberId) : await firmUserIds(booking.shopId);
  for (const userId of team) {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.HEALTH_CARE_BOOKING,
      title: booking.status === "PENDING_APPROVAL" ? "New home-care request — please accept" : "New home-care visit booked",
      body: `${booking.serviceName} for ${patient.fullName}, ${formatSlot(booking.startsAt)}. Booking ${booking.bookingNumber}.`,
      actionUrl: `/shop/health/care/visits/${visit.id}`,
      channels: ["PUSH"],
      metadata: { visitId: visit.id, bookingId: booking.id },
    });
  }
}

/** The owner and the assigned member's own login. */
async function careTeamUsers(shopId: string, memberId: string | null): Promise<string[]> {
  const [s] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  const [m] = memberId ? await db.select({ userId: consultMembers.userId }).from(consultMembers).where(eq(consultMembers.id, memberId)) : [];
  return [...new Set([s?.ownerId, m?.userId].filter((v): v is string => Boolean(v)))];
}

export const careBookingInput = z.object({
  patientId: z.string().uuid(),
  serviceId: z.string().uuid(),
  memberId: z.string().uuid().nullish(),
  /** HOME_VISIT: at the patient's home; IN_PERSON: at the provider's centre. */
  mode: z.enum(["HOME_VISIT", "IN_PERSON"]).default("HOME_VISIT"),
  start: z.string().datetime({ offset: true }),
  instructions: z.string().trim().max(1000).nullish(),
  shareRecords: z.enum(SHARE_CHOICES).default("OFF"),
  paymentMode: z.enum(["ONLINE", "PAY_AT_VISIT"]).nullish(),
  addressId: z.string().uuid().nullish(),
  visitAddress: z.string().trim().max(400).nullish(),
  visitLatitude: z.number().min(-90).max(90).nullish(),
  visitLongitude: z.number().min(-180).max(180).nullish(),
  suggestionId: z.string().uuid().nullish(),
  /** A package: the patient commits to N sessions and books them one after another. */
  sessions: z.number().int().min(1).max(200).default(1),
  /** The next session of an existing package. */
  packageId: z.string().uuid().nullish(),
  consent: z.literal(true, { message: "Please agree to share the details with the care provider." }),
});
export type CareBookingInput = z.input<typeof careBookingInput>;

/** Books a home-care visit for a family member (createHealthBooking) and starts / continues a package. */
export async function bookCareVisit(raw: unknown, actor: HealthActor, now: Date = new Date()) {
  await requireHealthEnabled();
  const input = careBookingInput.parse(raw);
  const patient = await requirePatientAccess(input.patientId, actor);
  const [svc] = await db.select().from(consultServices).where(eq(consultServices.id, input.serviceId));
  if (!svc || svc.status !== "ACTIVE") throw notFound("Service");
  const cats = await careCategories();
  const members = await db.select({ id: consultMembers.id }).from(consultMembers).where(and(eq(consultMembers.profileId, svc.profileId), eq(consultMembers.status, "ACTIVE")));
  const offering = (svc.memberIds.length ? members.filter((m) => svc.memberIds.includes(m.id)) : members).map((m) => m.id);
  const memberCats = await memberCareCategories(offering);
  const careMembers = offering.filter((id) => (memberCats.get(id) ?? []).length > 0);
  const isCareService = (svc.categoryId && cats.some((c) => c.id === svc.categoryId)) || careMembers.length > 0;
  if (!isCareService) throw validationFailed("This is not a home-care service.");
  const badges = await careBadges(careMembers);
  if (input.memberId) {
    if (!careMembers.includes(input.memberId)) throw validationFailed("That provider does not offer this service.");
    if (!badges.get(input.memberId)?.verified) throw forbidden("This provider is not verified yet and cannot be booked.");
  } else if (!careMembers.length || careMembers.some((id) => !badges.get(id)?.verified)) {
    throw validationFailed("Choose who should come.", { fields: { memberId: "Choose a provider." } });
  }
  // Address: a saved address (text + pin) or what was typed with a map pin.
  let visitAddress = input.visitAddress ?? null;
  let lat = input.visitLatitude ?? null;
  let lng = input.visitLongitude ?? null;
  if (input.addressId) {
    const [a] = await db.select().from(addresses).where(and(eq(addresses.id, input.addressId), eq(addresses.userId, actor.id)));
    if (!a) throw notFound("Address");
    visitAddress = [a.line1, a.line2, a.landmark, a.area, a.city, a.pincode].filter(Boolean).join(", ");
    lat = lat ?? (a.latitude && Number.isFinite(Number(a.latitude)) ? Number(a.latitude) : null);
    lng = lng ?? (a.longitude && Number.isFinite(Number(a.longitude)) ? Number(a.longitude) : null);
  }
  if (input.mode === "HOME_VISIT" && !visitAddress) throw validationFailed("Enter the address for the home visit.", { fields: { visitAddress: "Required." } });
  let pkg: HealthCarePackage | null = null;
  if (input.packageId) {
    [pkg] = await db.select().from(healthCarePackages).where(eq(healthCarePackages.id, input.packageId));
    if (!pkg || pkg.patientId !== patient.id) throw notFound("Package");
    if (pkg.status !== "ACTIVE" || pkg.shopId !== svc.shopId) throw conflict("This package is not active with this provider.");
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(healthCareVisits)
      .where(and(eq(healthCareVisits.packageId, pkg.id), ne(healthCareVisits.status, "CANCELLED")));
    if (n >= pkg.sessionsTotal) throw conflict("Every session of this package is already booked.");
  }
  const { createHealthBooking } = await import("./booking");
  const created = await createHealthBooking(
    {
      patientId: patient.id,
      serviceId: svc.id,
      memberId: input.memberId ?? null,
      mode: input.mode,
      start: input.start,
      reason: input.instructions ?? null,
      shareRecords: input.shareRecords,
      paymentMode: input.paymentMode ?? null,
      visitAddress,
      visitLatitude: lat,
      visitLongitude: lng,
      suggestionId: input.suggestionId ?? null,
      consent: true,
    },
    actor,
    now,
  );
  let [visit] = await db.select().from(healthCareVisits).where(eq(healthCareVisits.bookingId, created.booking.id));
  if (!visit) {
    await onHealthBookingCreated(created.booking, patient);
    [visit] = await db.select().from(healthCareVisits).where(eq(healthCareVisits.bookingId, created.booking.id));
  }
  if (visit && pkg) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(healthCareVisits)
      .where(and(eq(healthCareVisits.packageId, pkg.id), ne(healthCareVisits.status, "CANCELLED")));
    [visit] = await db.update(healthCareVisits).set({ packageId: pkg.id, sessionNo: n + 1, updatedAt: now }).where(eq(healthCareVisits.id, visit.id)).returning();
  } else if (visit && input.sessions > 1) {
    [pkg] = await db
      .insert(healthCarePackages)
      .values({ patientId: patient.id, customerId: actor.id, shopId: svc.shopId, serviceId: svc.id, name: `${svc.name} — ${input.sessions} sessions`, sessionsTotal: input.sessions, createdAt: now, updatedAt: now })
      .returning();
    [visit] = await db.update(healthCareVisits).set({ packageId: pkg.id, sessionNo: 1, updatedAt: now }).where(eq(healthCareVisits.id, visit.id)).returning();
  }
  return { ...created, visitId: visit?.id ?? null, packageId: pkg?.id ?? null };
}

/* ------------------------------------------------------------ search */

export const careSearchInput = z.object({
  category: z.string().trim().max(80).optional(),
  gender: z.enum(GENDERS).optional(),
  language: z.string().trim().max(40).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  minExperience: z.coerce.number().int().min(0).max(60).optional(),
  maxFee: z.coerce.number().min(0).max(1_000_000).optional(),
  /** HOME: visits at home; CENTRE: at the provider's centre. */
  setting: z.enum(["HOME", "CENTRE"]).optional(),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/)
    .optional(),
  q: z.string().trim().max(80).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(200).optional(),
  sort: z.enum(["distance", "rating", "price", "experience"]).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(30),
});

export interface CareProviderCard {
  memberId: string;
  name: string;
  title: string | null;
  photoUrl: string | null;
  gender: string | null;
  experienceYears: number | null;
  languages: string[];
  qualifications: string | null;
  categories: string[];
  providerKind: string;
  idCardNumber: string;
  policeVerified: boolean;
  documentVerified: boolean;
}

export interface CareSearchCard extends Omit<ConsultantCard, "categories"> {
  categories: string[];
  providers: CareProviderCard[];
  homeVisit: boolean;
  atCentre: boolean;
}

/** Nearby verified home-care providers (consult search + home-care filters; unverified providers are never shown). */
export async function searchCareProviders(raw: unknown, now: Date = new Date()): Promise<{ results: CareSearchCard[]; categories: CareCategory[] }> {
  const input = careSearchInput.parse(raw);
  const cats = await careCategories();
  if (input.category && !cats.some((c) => c.slug === input.category)) throw validationFailed("Choose a home-care category.");
  const slugs = input.category ? [input.category] : cats.map((c) => c.slug);
  const mode = input.setting === "HOME" ? "HOME_VISIT" : input.setting === "CENTRE" ? "IN_PERSON" : undefined;
  const byProfile = new Map<string, ConsultantCard>();
  for (const slug of slugs) {
    const r = await searchConsultants({ category: slug, language: input.language, mode, maxFee: input.maxFee, lat: input.lat, lng: input.lng, radiusKm: input.radiusKm, q: input.q, limit: 60 }, now);
    for (const c of r.results) if (!byProfile.has(c.profileId)) byProfile.set(c.profileId, c);
  }
  const profileIds = [...byProfile.keys()];
  if (!profileIds.length) return { results: [], categories: cats };
  const members = await db
    .select({ m: consultMembers, care: healthCareProviderProfiles })
    .from(consultMembers)
    .innerJoin(healthCareProviderProfiles, eq(healthCareProviderProfiles.memberId, consultMembers.id))
    .where(and(inArray(consultMembers.profileId, profileIds), eq(consultMembers.status, "ACTIVE")));
  const ids = members.map((r) => r.m.id);
  const [memberCats, badges, services] = await Promise.all([
    memberCareCategories(ids),
    careBadges(ids),
    db.select().from(consultServices).where(and(inArray(consultServices.profileId, profileIds), eq(consultServices.status, "ACTIVE"))),
  ]);
  const careCatIds = new Set(cats.map((c) => c.id));
  const results: CareSearchCard[] = [];
  for (const card of byProfile.values()) {
    const providers = members
      .filter((r) => r.m.profileId === card.profileId)
      .filter((r) => badges.get(r.m.id)?.verified)
      .filter((r) => !input.category || (memberCats.get(r.m.id) ?? []).some((c) => c.slug === input.category))
      .filter((r) => !input.gender || r.care.gender === input.gender)
      .filter((r) => input.minExperience == null || (r.m.experienceYears ?? 0) >= input.minExperience)
      .filter((r) => !input.language || r.m.languages.some((l) => l.toLowerCase() === input.language!.toLowerCase()))
      .filter((r) => !input.pincode || !r.care.servicePincodes.length || r.care.servicePincodes.includes(input.pincode))
      .filter((r) => card.distanceKm == null || input.setting === "CENTRE" || card.distanceKm <= r.care.serviceRadiusKm)
      .map((r) => ({
        memberId: r.m.id,
        name: r.m.name,
        title: r.m.title,
        photoUrl: r.m.photoUrl,
        gender: r.care.gender,
        experienceYears: r.m.experienceYears,
        languages: r.m.languages,
        qualifications: r.m.qualifications,
        categories: (memberCats.get(r.m.id) ?? []).map((c) => c.name),
        providerKind: r.care.providerKind,
        idCardNumber: r.care.idCardNumber,
        policeVerified: badges.get(r.m.id)?.policeVerified ?? false,
        documentVerified: badges.get(r.m.id)?.documentVerified ?? false,
      }));
    if (!providers.length) continue;
    if (input.minRating != null && card.rating < input.minRating) continue;
    const careServices = services.filter((s) => s.profileId === card.profileId && ((s.categoryId && careCatIds.has(s.categoryId)) || !s.categoryId));
    const fees = careServices.map((s) => s.feePaise);
    results.push({
      ...card,
      categories: [...new Set(providers.flatMap((p) => p.categories))],
      providers,
      feeFromPaise: fees.length ? Math.min(...fees) : card.feeFromPaise,
      feeToPaise: fees.length ? Math.max(...fees) : card.feeToPaise,
      homeVisit: careServices.some((s) => s.modes.includes("HOME_VISIT")),
      atCentre: careServices.some((s) => s.modes.includes("IN_PERSON")),
    });
  }
  const sort = input.sort ?? (input.lat != null ? "distance" : "rating");
  results.sort((a, b) => {
    if (sort === "distance") return (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9);
    if (sort === "price") return (a.feeFromPaise ?? 1e12) - (b.feeFromPaise ?? 1e12);
    if (sort === "experience") return Math.max(0, ...b.providers.map((p) => p.experienceYears ?? 0)) - Math.max(0, ...a.providers.map((p) => p.experienceYears ?? 0));
    return b.rating - a.rating || b.ratingCount - a.ratingCount;
  });
  return { results: results.slice(0, input.limit), categories: cats };
}

export interface CareProviderPage {
  profile: { id: string; shopId: string; slug: string; displayName: string; headline: string | null; about: string | null; photoUrl: string | null; kind: string; rating: number; ratingCount: number; verified: boolean };
  shop: { name: string; address: string; latitude: number | null; longitude: number | null; phone: string | null };
  providers: (CareProviderCard & { bio: string | null; registrationBody: string | null; registrationNumber: string | null; serviceRadiusKm: number; servicePincodes: string[] })[];
  services: { id: string; name: string; description: string | null; durationMinutes: number; feeType: string; feePaise: number; depositPaise: number; modes: string[]; memberIds: string[]; payOnline: boolean; payAtVisit: boolean; categoryName: string | null }[];
  reviews: { rating: number; review: string | null; serviceName: string; ratedAt: Date | null }[];
  bookable: boolean;
}

/** A care practice's page for patients: verified providers, badges, services and rates, reviews. */
export async function careProviderPage(slug: string): Promise<CareProviderPage> {
  const pub = await publicProfileBySlug(slug);
  const cats = await careCategories();
  const careCatIds = new Set(cats.map((c) => c.id));
  const ids = pub.members.map((m) => m.id);
  const [profiles, badges, memberCats, full] = await Promise.all([
    ids.length ? db.select().from(healthCareProviderProfiles).where(inArray(healthCareProviderProfiles.memberId, ids)) : Promise.resolve([] as HealthCareProviderProfile[]),
    careBadges(ids),
    memberCareCategories(ids),
    ids.length ? db.select().from(consultMembers).where(inArray(consultMembers.id, ids)) : Promise.resolve([]),
  ]);
  const providers = pub.members
    .filter((m) => badges.get(m.id)?.verified)
    .map((m) => {
      const p = profiles.find((x) => x.memberId === m.id)!;
      const fm = full.find((x) => x.id === m.id);
      return {
        memberId: m.id,
        name: m.name,
        title: m.title,
        photoUrl: m.photoUrl,
        gender: p.gender,
        experienceYears: m.experienceYears,
        languages: m.languages,
        qualifications: m.qualifications,
        categories: (memberCats.get(m.id) ?? []).map((c) => c.name),
        providerKind: p.providerKind,
        idCardNumber: p.idCardNumber,
        policeVerified: badges.get(m.id)?.policeVerified ?? false,
        documentVerified: badges.get(m.id)?.documentVerified ?? false,
        bio: m.bio,
        registrationBody: p.registrationBody ?? fm?.registrationBody ?? null,
        registrationNumber: p.registrationNumber ?? fm?.registrationNumber ?? null,
        serviceRadiusKm: p.serviceRadiusKm,
        servicePincodes: p.servicePincodes,
      };
    });
  const providerIds = new Set(providers.map((p) => p.memberId));
  const services = pub.services
    .filter((s) => (s.categoryId ? careCatIds.has(s.categoryId) : true))
    .filter((s) => (s.memberIds.length ? s.memberIds.some((id) => providerIds.has(id)) : providerIds.size > 0))
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      durationMinutes: s.durationMinutes,
      feeType: s.feeType,
      feePaise: s.feePaise,
      depositPaise: s.depositPaise,
      modes: s.modes.filter((m) => m === "HOME_VISIT" || m === "IN_PERSON"),
      memberIds: s.memberIds.filter((id) => providerIds.has(id)),
      payOnline: s.payOnline,
      payAtVisit: s.payAtVisit,
      categoryName: cats.find((c) => c.id === s.categoryId)?.name ?? null,
    }))
    .filter((s) => s.modes.length > 0);
  const reviews = await db
    .select({ rating: consultBookings.rating, review: consultBookings.review, serviceName: consultBookings.serviceName, ratedAt: consultBookings.ratedAt })
    .from(consultBookings)
    .where(and(eq(consultBookings.profileId, pub.profile.id), sql`${consultBookings.rating} IS NOT NULL`))
    .orderBy(desc(consultBookings.ratedAt))
    .limit(20);
  return {
    profile: {
      id: pub.profile.id,
      shopId: pub.profile.shopId,
      slug: pub.shop.slug,
      displayName: pub.profile.displayName,
      headline: pub.profile.headline,
      about: pub.profile.about,
      photoUrl: pub.profile.photoUrl,
      kind: pub.profile.kind,
      rating: pub.profile.ratingAvgX100 / 100,
      ratingCount: pub.profile.ratingCount,
      verified: pub.profile.verification === "VERIFIED",
    },
    shop: { name: pub.shop.name, address: pub.shop.address, latitude: pub.shop.latitude, longitude: pub.shop.longitude, phone: pub.shop.phone },
    providers,
    services,
    reviews: reviews.map((r) => ({ rating: r.rating ?? 0, review: r.review, serviceName: r.serviceName, ratedAt: r.ratedAt })),
    bookable: pub.bookable && providers.length > 0 && services.length > 0,
  };
}

/* ------------------------------------------------------------ visit OTP */

const CODE_LENGTH = 4;

/** The patient's 4-digit code: HMAC(AUTH_SECRET, salt + visit + stage) — never stored. */
export function visitCode(visitId: string, salt: string, stage: "in" | "out"): string {
  const mac = createHmac("sha256", getEnv().AUTH_SECRET).update(`care-otp:${salt}:${visitId}:${stage}`).digest();
  return String(mac.readUInt32BE(0) % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");
}

function visitCodeMatches(visitId: string, salt: string, stage: "in" | "out", entered: string | null | undefined): boolean {
  const clean = (entered ?? "").replace(/\D/g, "");
  if (clean.length !== CODE_LENGTH) return false;
  const want = Buffer.from(visitCode(visitId, salt, stage));
  const got = Buffer.from(clean);
  return want.length === got.length && timingSafeEqual(want, got);
}

/* ------------------------------------------------------------ visit loading */

async function loadVisit(visitId: string, client: DbClient = db): Promise<{ visit: HealthCareVisit; booking: ConsultBooking }> {
  if (!/^[0-9a-f-]{36}$/i.test(visitId)) throw notFound("Visit");
  const [row] = await client.select({ visit: healthCareVisits, booking: consultBookings }).from(healthCareVisits).innerJoin(consultBookings, eq(consultBookings.id, healthCareVisits.bookingId)).where(eq(healthCareVisits.id, visitId));
  if (!row) throw notFound("Visit");
  return synced(row.visit, row.booking);
}

/** A visit whose booking was cancelled, rejected, expired or marked no-show is cancelled too. */
async function synced(visit: HealthCareVisit, booking: ConsultBooking): Promise<{ visit: HealthCareVisit; booking: ConsultBooking }> {
  if (["CANCELLED", "REJECTED", "EXPIRED", "NO_SHOW"].includes(booking.status) && visit.status !== "COMPLETED" && visit.status !== "CANCELLED") {
    const [u] = await db.update(healthCareVisits).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(healthCareVisits.id, visit.id)).returning();
    return { visit: u ?? visit, booking };
  }
  return { visit, booking };
}

/** The practice side: owner, the assigned member, or staff. Anyone else (and the customer) gets 404. */
async function providerVisit(visitId: string, actor: HealthActor) {
  const { visit, booking } = await loadVisit(visitId);
  const v = await bookingViewer(booking, actor).catch(() => null);
  if (!v || (v.viewer === "CUSTOMER" && !v.firm)) throw notFound("Visit");
  const access = v.firm ?? (await firmAccessOrNull(booking.shopId, actor));
  if (!access) throw notFound("Visit");
  const [patient] = await db.select().from(healthPatients).where(eq(healthPatients.id, visit.patientId));
  if (!patient) throw notFound("Visit");
  return { visit, booking, access, patient };
}

/** The patient side: the account holder / linked adult of the visit's patient. */
async function patientVisit(visitId: string, actor: HealthActor) {
  const { visit, booking } = await loadVisit(visitId);
  const patient = await requirePatientAccess(visit.patientId, actor).catch(() => {
    throw notFound("Visit");
  });
  return { visit, booking, patient };
}

async function providerLabel(memberId: string | null, shopId: string): Promise<{ name: string; shopName: string; label: string; userId: string | null }> {
  const [s] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, shopId));
  const [m] = memberId ? await db.select({ name: consultMembers.name, userId: consultMembers.userId }).from(consultMembers).where(eq(consultMembers.id, memberId)) : [];
  const name = m?.name ?? s?.name ?? "Care provider";
  return { name, shopName: s?.name ?? "", label: m ? `${m.name} (${s?.name ?? ""})` : (s?.name ?? "Care provider"), userId: m?.userId ?? null };
}

async function tellPatient(patient: HealthPatient, visitId: string, title: string, body: string, type: "HEALTH_CARE_VISIT" | "HEALTH_CARE_BOOKING" | "HEALTH_CARE_SOS" = "HEALTH_CARE_VISIT"): Promise<void> {
  for (const userId of patientAudience(patient)) {
    await notify({ userId, type: NOTIFICATION_TYPES[type], title, body, actionUrl: `/health/care/visits/${visitId}`, channels: ["PUSH"], metadata: { visitId } });
  }
}

async function event(name: HealthEventName, visit: HealthCareVisit, booking: ConsultBooking, patient: HealthPatient, client: DbClient = db, extra: Record<string, unknown> = {}): Promise<void> {
  await publishHealthEvent({ name, userIds: patientAudience(patient), shopId: booking.shopId, subjectId: visit.id, payload: { visitId: visit.id, bookingId: booking.id, status: visit.status, ...extra } }, client);
}

/* ------------------------------------------------------------ provider inbox */

export interface CareInboxRow {
  visitId: string;
  bookingId: string;
  bookingNumber: string;
  startsAt: Date;
  endsAt: Date;
  bookingStatus: string;
  visitStatus: string;
  serviceName: string;
  mode: string;
  patientName: string;
  area: string | null;
  memberId: string | null;
  memberName: string | null;
  sessionNo: number | null;
  packageName: string | null;
  sessionsTotal: number | null;
  sos: boolean;
  feePaise: number;
  paymentStatus: string;
}

/** The visit inbox / schedule of a practice (a member sees their own visits). */
export async function careInbox(shopId: string, actor: HealthActor, opts: { fromKey?: string; days?: number } = {}, now: Date = new Date()): Promise<{ rows: CareInboxRow[]; team: { memberId: string; name: string }[]; canAssign: boolean }> {
  const access = await requireFirmAccess(shopId, actor, "bookings");
  const fromKey = opts.fromKey && /^\d{4}-\d{2}-\d{2}$/.test(opts.fromKey) ? opts.fromKey : addDays(istDateKey(now), -7);
  const toKey = addDays(fromKey, Math.min(120, Math.max(1, opts.days ?? 60)));
  const rows = await db
    .select({ v: healthCareVisits, b: consultBookings, p: healthPatients, memberName: consultMembers.name, pkg: healthCarePackages })
    .from(healthCareVisits)
    .innerJoin(consultBookings, eq(consultBookings.id, healthCareVisits.bookingId))
    .innerJoin(healthPatients, eq(healthPatients.id, healthCareVisits.patientId))
    .leftJoin(consultMembers, eq(consultMembers.id, healthCareVisits.memberId))
    .leftJoin(healthCarePackages, eq(healthCarePackages.id, healthCareVisits.packageId))
    .where(
      and(
        eq(healthCareVisits.shopId, shopId),
        gte(consultBookings.startsAt, istAt(fromKey, 0)),
        sql`${consultBookings.startsAt} < ${istAt(toKey, 0).toISOString()}::timestamptz`,
        access.role === "MEMBER" && access.memberId ? eq(healthCareVisits.memberId, access.memberId) : undefined,
      ),
    )
    .orderBy(asc(consultBookings.startsAt))
    .limit(500);
  const team = access.role === "MEMBER" ? [] : (await careTeam(shopId, actor)).members.filter((m) => m.badges?.verified).map((m) => ({ memberId: m.memberId, name: m.name }));
  return {
    canAssign: access.role === "OWNER" || access.role === "STAFF",
    team,
    rows: rows.map((r) => ({
      visitId: r.v.id,
      bookingId: r.b.id,
      bookingNumber: r.b.bookingNumber,
      startsAt: r.b.startsAt,
      endsAt: r.b.endsAt,
      bookingStatus: r.b.status,
      visitStatus: ["CANCELLED", "REJECTED", "EXPIRED", "NO_SHOW"].includes(r.b.status) && r.v.status !== "COMPLETED" ? "CANCELLED" : r.v.status,
      serviceName: r.b.serviceName,
      mode: r.b.mode,
      patientName: r.p.fullName,
      area: r.b.visitAddress ? r.b.visitAddress.split(",").slice(-3).join(",").trim() : null,
      memberId: r.v.memberId,
      memberName: r.memberName,
      sessionNo: r.v.sessionNo,
      packageName: r.pkg?.name ?? null,
      sessionsTotal: r.pkg?.sessionsTotal ?? null,
      sos: Boolean(r.v.sosAt),
      feePaise: r.b.feePaise,
      paymentStatus: r.b.paymentStatus,
    })),
  };
}

/* ------------------------------------------------------------ provider visit view */

export interface SharedRecords {
  bloodGroup: string | null;
  allergies: string[];
  conditions: string[];
  currentMedicines: string | null;
  prescriptions: { rxNumber: string; issuedAt: Date }[];
  documents: { title: string; kind: string; documentDate: string | null; createdAt: Date }[];
}

export interface ProviderVisitView {
  visit: Pick<HealthCareVisit, "id" | "status" | "onTheWayAt" | "checkedInAt" | "checkedOutAt" | "notes" | "vitals" | "shareRecords" | "sosAt" | "sessionNo" | "memberId" | "otpAttempts"> & { statusLabel: string };
  booking: Pick<ConsultBooking, "id" | "bookingNumber" | "startsAt" | "endsAt" | "status" | "mode" | "serviceName" | "feePaise" | "paymentMode" | "paymentStatus" | "paidOnlinePaise" | "paidOfflinePaise" | "visitAddress" | "visitLatitude" | "visitLongitude" | "visitorPhone" | "shopId" | "rating" | "review">;
  patient: { name: string; age: string | null; gender: string | null; emergencyName: string | null };
  instructions: string | null;
  package: { name: string; sessionsTotal: number; sessionsDone: number } | null;
  memberName: string | null;
  sharedRecords: SharedRecords | null;
  documentId: string | null;
  can: { accept: boolean; decline: boolean; onTheWay: boolean; checkIn: boolean; checkOut: boolean; reassign: boolean };
  team: { memberId: string; name: string }[];
  otpMaxAttempts: number;
}

/** What the provider sees: booking, address, instructions — and the patient's records only when shared for this booking (logged). */
export async function careVisitForProvider(visitId: string, actor: HealthActor, ip?: string | null): Promise<ProviderVisitView> {
  const { visit, booking, access, patient } = await providerVisit(visitId, actor);
  const [link] = await db.select().from(healthAppointmentLinks).where(eq(healthAppointmentLinks.bookingId, booking.id));
  const [pkg] = visit.packageId ? await db.select().from(healthCarePackages).where(eq(healthCarePackages.id, visit.packageId)) : [];
  const who = await providerLabel(visit.memberId, booking.shopId);
  let sharedRecords: SharedRecords | null = null;
  if (visit.shareRecords && visit.status !== "CANCELLED") {
    const [rxs, docs] = await Promise.all([
      db.select({ rxNumber: healthPrescriptions.rxNumber, issuedAt: healthPrescriptions.issuedAt }).from(healthPrescriptions).where(and(eq(healthPrescriptions.patientId, patient.id), eq(healthPrescriptions.status, "ISSUED"))).orderBy(desc(healthPrescriptions.issuedAt)).limit(10),
      db
        .select({ title: healthDocuments.title, kind: healthDocuments.kind, documentDate: healthDocuments.documentDate, createdAt: healthDocuments.createdAt })
        .from(healthDocuments)
        .where(and(eq(healthDocuments.patientId, patient.id), isNull(healthDocuments.hiddenAt)))
        .orderBy(desc(healthDocuments.createdAt))
        .limit(10),
    ]);
    sharedRecords = { bloodGroup: patient.bloodGroup, allergies: patient.allergies, conditions: patient.conditions, currentMedicines: patient.currentMedicines, prescriptions: rxs, documents: docs };
    await logRecordAccess({ patientId: patient.id, actor, actorLabel: access.role === "STAFF" ? "GoKesari staff" : who.label, actorRole: access.role === "STAFF" ? actor.role : "CARE_PROVIDER", action: "VIEW", objectType: "care_visit", objectId: visit.id, reason: `Home-care booking ${booking.bookingNumber}`, ipAddress: ip ?? null });
  }
  const [doc] = await db.select({ id: healthDocuments.id }).from(healthDocuments).where(and(eq(healthDocuments.careVisitId, visit.id), isNull(healthDocuments.hiddenAt))).limit(1);
  const rule = await getRule("health");
  const canAssign = (access.role === "OWNER" || access.role === "STAFF") && visit.status === "SCHEDULED" && ["CONFIRMED", "PENDING_APPROVAL"].includes(booking.status);
  const { ageText } = await import("./consultations");
  return {
    visit: { id: visit.id, status: visit.status, statusLabel: CARE_VISIT_STATUS_LABELS[visit.status as CareVisitStatus] ?? visit.status, onTheWayAt: visit.onTheWayAt, checkedInAt: visit.checkedInAt, checkedOutAt: visit.checkedOutAt, notes: visit.notes, vitals: visit.vitals, shareRecords: visit.shareRecords, sosAt: visit.sosAt, sessionNo: visit.sessionNo, memberId: visit.memberId, otpAttempts: visit.otpAttempts },
    booking: {
      id: booking.id,
      bookingNumber: booking.bookingNumber,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      status: booking.status,
      mode: booking.mode,
      serviceName: booking.serviceName,
      feePaise: booking.feePaise,
      paymentMode: booking.paymentMode,
      paymentStatus: booking.paymentStatus,
      paidOnlinePaise: booking.paidOnlinePaise,
      paidOfflinePaise: booking.paidOfflinePaise,
      visitAddress: booking.visitAddress,
      visitLatitude: booking.visitLatitude,
      visitLongitude: booking.visitLongitude,
      visitorPhone: booking.visitorPhone,
      shopId: booking.shopId,
      rating: booking.rating,
      review: booking.review,
    },
    patient: { name: patient.fullName, age: ageText(patient.dateOfBirth), gender: patient.gender, emergencyName: patient.emergencyName },
    instructions: link?.reason ?? booking.customerNote,
    package: pkg ? { name: pkg.name, sessionsTotal: pkg.sessionsTotal, sessionsDone: pkg.sessionsDone } : null,
    memberName: visit.memberId ? who.name : null,
    sharedRecords,
    documentId: doc?.id ?? null,
    can: {
      accept: booking.status === "PENDING_APPROVAL" || (booking.status === "CONFIRMED" && visit.status === "SCHEDULED"),
      decline: (booking.status === "PENDING_APPROVAL" || booking.status === "CONFIRMED") && visit.status === "SCHEDULED",
      onTheWay: booking.status === "CONFIRMED" && (visit.status === "SCHEDULED" || visit.status === "ON_THE_WAY"),
      checkIn: booking.status === "CONFIRMED" && (visit.status === "SCHEDULED" || visit.status === "ON_THE_WAY"),
      checkOut: visit.status === "IN_PROGRESS",
      reassign: canAssign,
    },
    team: canAssign ? (await careTeam(booking.shopId, actor)).members.filter((m) => m.badges?.verified).map((m) => ({ memberId: m.memberId, name: m.name })) : [],
    otpMaxAttempts: rule.careOtpMaxAttempts,
  };
}

/* ------------------------------------------------------------ visit lifecycle (provider) */

/** Accept (a booking waiting for approval, or acknowledge a confirmed one) or decline (with a reason; money refunded by the consult engine). */
export async function decideCareVisit(visitId: string, accept: boolean, actor: HealthActor, reason: string | null, now: Date = new Date()): Promise<{ status: string }> {
  const { visit, booking, patient } = await providerVisit(visitId, actor);
  if (visit.status !== "SCHEDULED") throw conflict("This visit has already started or ended.");
  if (accept) {
    if (booking.status === "PENDING_APPROVAL") await decideBooking(booking.id, true, actor, null, now);
    else if (booking.status !== "CONFIRMED") throw conflict("This booking cannot be accepted.");
    await event("care_booking.accepted", visit, booking, patient);
    await tellPatient(patient, visit.id, "Home-care visit confirmed", `${booking.serviceName} on ${formatSlot(booking.startsAt)} is confirmed. You will see the provider's photo and ID card in My Health before the visit.`, "HEALTH_CARE_BOOKING");
    return { status: "CONFIRMED" };
  }
  if (!reason?.trim()) throw validationFailed("Give the patient a reason.", { fields: { reason: "Required." } });
  if (booking.status === "PENDING_APPROVAL") await decideBooking(booking.id, false, actor, reason, now);
  else if (booking.status === "CONFIRMED") await cancelBooking(booking.id, actor, reason, now);
  else throw conflict("This booking cannot be declined.");
  const [u] = await db.update(healthCareVisits).set({ status: "CANCELLED", updatedAt: now }).where(eq(healthCareVisits.id, visit.id)).returning();
  await event("care_booking.declined", u, booking, patient);
  await tellPatient(patient, visit.id, "Home-care visit declined", `${booking.serviceName} on ${formatSlot(booking.startsAt)} was declined: ${reason.trim().slice(0, 200)}. Any online payment is refunded.`, "HEALTH_CARE_BOOKING");
  return { status: "CANCELLED" };
}

export const locationInput = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });

/** "On my way": the patient sees the provider coming, with distance and ETA, while the page is open. */
export async function startOnTheWay(visitId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthCareVisit> {
  const loc = raw == null ? null : locationInput.partial().parse(raw);
  const { visit, booking, patient } = await providerVisit(visitId, actor);
  if (booking.status !== "CONFIRMED") throw conflict("The booking is not confirmed yet.");
  if (visit.status !== "SCHEDULED" && visit.status !== "ON_THE_WAY") throw conflict("This visit has already started or ended.");
  if (now.getTime() < booking.startsAt.getTime() - 6 * HOUR) throw conflict("You can start the trip from 6 hours before the visit.");
  const hasLoc = loc?.latitude != null && loc?.longitude != null;
  const [u] = await db
    .update(healthCareVisits)
    .set({ status: "ON_THE_WAY", onTheWayAt: visit.onTheWayAt ?? now, ...(hasLoc ? { lastLatitude: loc!.latitude!, lastLongitude: loc!.longitude!, lastLocationAt: now } : {}), updatedAt: now })
    .where(eq(healthCareVisits.id, visit.id))
    .returning();
  if (visit.status === "SCHEDULED") {
    await event("care_booking.provider_on_the_way", u, booking, patient);
    const who = await providerLabel(visit.memberId, booking.shopId);
    await tellPatient(patient, visit.id, `${who.name} is on the way`, `${who.name} is on the way for ${booking.serviceName}. Open the visit to see how far they are, their photo and ID card. Give the check-in code only when they arrive.`);
  }
  return u;
}

/** The provider's browser sends its position about every 30 seconds while "On my way" is open. */
export async function updateVisitLocation(visitId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<{ ok: true }> {
  const loc = locationInput.parse(raw);
  const { visit, booking, patient } = await providerVisit(visitId, actor);
  if (visit.status !== "ON_THE_WAY") throw conflict("Location is shared only while you are on the way.");
  await db.update(healthCareVisits).set({ lastLatitude: loc.latitude, lastLongitude: loc.longitude, lastLocationAt: now, updatedAt: now }).where(eq(healthCareVisits.id, visit.id));
  // Live push only (no outbox row every 30 s); the patient's screen reloads the distance from the API.
  pushLiveOnly({ name: "care_booking.provider_on_the_way", shopId: booking.shopId, userIds: patientAudience(patient), subjectId: visit.id, payload: { visitId: visit.id, location: true } });
  return { ok: true };
}

async function wrongCode(visit: HealthCareVisit, max: number, now: Date): Promise<never> {
  await db.update(healthCareVisits).set({ otpAttempts: sql`${healthCareVisits.otpAttempts} + 1`, updatedAt: now }).where(eq(healthCareVisits.id, visit.id));
  const left = max - visit.otpAttempts - 1;
  throw new AppError("VALIDATION_FAILED", left > 0 ? `That code is not right. ${left} tries left. Ask the patient for the code shown in My Health.` : "That code is not right. No tries left — ask GoKesari support.", { reason: "OTP_WRONG", left, fields: { code: "Wrong code." } });
}

/** Check-in with the patient's first code → visit in progress. */
export async function checkInVisit(visitId: string, code: string | null, actor: HealthActor, now: Date = new Date()): Promise<HealthCareVisit> {
  const { visit, booking, patient } = await providerVisit(visitId, actor);
  if (booking.status !== "CONFIRMED") throw conflict("The booking is not confirmed.");
  if (visit.status !== "SCHEDULED" && visit.status !== "ON_THE_WAY") throw conflict("This visit has already started or ended.");
  if (now.getTime() < booking.startsAt.getTime() - 3 * HOUR) throw conflict("You can check in from 3 hours before the visit.");
  const rule = await getRule("health");
  if (visit.otpAttempts >= rule.careOtpMaxAttempts) throw conflict("Too many wrong codes. Ask GoKesari support to help.", { reason: "OTP_LOCKED" });
  if (!visitCodeMatches(visit.id, visit.otpSalt, "in", code)) await wrongCode(visit, rule.careOtpMaxAttempts, now);
  const u = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(healthCareVisits)
      .set({ status: "IN_PROGRESS", checkedInAt: now, otpAttempts: 0, updatedAt: now })
      .where(and(eq(healthCareVisits.id, visit.id), inArray(healthCareVisits.status, ["SCHEDULED", "ON_THE_WAY"])))
      .returning();
    if (!row) throw conflict("This visit has already started.");
    await event("care_booking.checked_in", row, booking, patient, tx);
    return row;
  });
  await markArrived(booking.id, actor, now).catch(() => null);
  const who = await providerLabel(visit.memberId, booking.shopId);
  await tellPatient(patient, visit.id, "Home-care visit started", `${who.name} checked in at ${formatSlot(now)}. At the end, give them the check-out code from My Health.`);
  return u;
}

const vitalsInput = z
  .object({
    bpSystolic: z.number().int().min(40).max(300).nullish(),
    bpDiastolic: z.number().int().min(20).max(200).nullish(),
    pulse: z.number().int().min(20).max(250).nullish(),
    temperatureC: z.number().min(30).max(45).nullish(),
    spo2: z.number().int().min(50).max(100).nullish(),
    weightKg: z.number().min(0.5).max(400).nullish(),
    respiratoryRate: z.number().int().min(4).max(80).nullish(),
    bloodSugar: z.number().min(10).max(1000).nullish(),
  })
  .default({});

export const checkOutInput = z.object({
  code: z.string().trim().max(10),
  notes: z.string().trim().min(3, "Write a short note about the visit.").max(4000),
  vitals: vitalsInput,
  /** Photos (JPEG / PNG / WebP as data URLs or base64), only with the patient's consent. */
  photos: z.array(z.string().max(6_000_000)).max(3).default([]),
  photoConsent: z.boolean().default(false),
});

interface VisitNoteContent {
  patientName: string;
  age: string | null;
  gender: string | null;
  providerName: string;
  shopName: string;
  idCardNumber: string | null;
  categories: string[];
  bookingNumber: string;
  serviceName: string;
  checkedInAt: Date | null;
  checkedOutAt: Date;
  notes: string;
  vitals: Vitals;
  photos: { jpeg: Buffer; width: number; height: number }[];
}

const VITAL_LABELS: [keyof Vitals, string, string][] = [
  ["bpSystolic", "BP systolic", "mmHg"],
  ["bpDiastolic", "BP diastolic", "mmHg"],
  ["pulse", "Pulse", "/min"],
  ["temperatureC", "Temperature", "°C"],
  ["spo2", "SpO2", "%"],
  ["respiratoryRate", "Respiratory rate", "/min"],
  ["bloodSugar", "Blood sugar", "mg/dL"],
  ["weightKg", "Weight", "kg"],
];

/** The visit note PDF (A4): who, when, vitals, notes, photos. */
export function renderVisitNotePdf(c: VisitNoteContent): Buffer {
  const doc = new PdfDocument({ title: `Home-care visit note ${c.bookingNumber}`, author: c.providerName, subject: "GoKesari Health visit note" });
  const W = mm(210);
  const H = mm(297);
  const x0 = mm(18);
  const maxW = W - 2 * x0;
  let page = doc.addPage(W, H);
  let y = H - mm(20);
  const newPage = () => {
    page = doc.addPage(W, H);
    y = H - mm(20);
  };
  const line = (text: string, size = 10, bold = false, gap = 4.6) => {
    for (const l of wrapText(text, size, maxW, bold ? "bold" : "regular")) {
      if (y < mm(20)) newPage();
      page.text(x0, y, l, { size, font: bold ? "bold" : "regular" });
      y -= mm(gap);
    }
  };
  page.text(x0, y, "GoKesari Health", { size: 9, color: [0.76, 0.25, 0.05] });
  y -= mm(7);
  line("Home-care visit note", 16, true, 7);
  page.line(x0, y + mm(3), W - x0, y + mm(3), { width: 0.6 });
  y -= mm(3);
  line(`Patient: ${c.patientName}${c.age ? `, ${c.age}` : ""}${c.gender ? `, ${c.gender.toLowerCase()}` : ""}`, 11, true);
  line(`Provider: ${c.providerName}${c.categories.length ? ` (${c.categories.join(", ")})` : ""}${c.idCardNumber ? ` - ID ${c.idCardNumber}` : ""}`);
  line(`Practice: ${c.shopName}`);
  line(`Service: ${c.serviceName} - booking ${c.bookingNumber}`);
  line(`Checked in: ${c.checkedInAt ? formatSlot(c.checkedInAt) : "-"}    Checked out: ${formatSlot(c.checkedOutAt)}`);
  y -= mm(3);
  const vitals = VITAL_LABELS.filter(([k]) => c.vitals[k] != null);
  if (vitals.length) {
    line("Vitals", 12, true, 6);
    for (const [k, label, unit] of vitals) line(`${label}: ${c.vitals[k]} ${unit}`);
    y -= mm(3);
  }
  line("Notes", 12, true, 6);
  for (const para of c.notes.split(/\n+/)) line(para);
  for (const [i, p] of c.photos.entries()) {
    newPage();
    line(`Photo ${i + 1} (taken with the patient's consent)`, 11, true, 6);
    const scale = Math.min(maxW / p.width, (y - mm(20)) / p.height);
    const w = p.width * scale;
    const h = p.height * scale;
    page.image(doc.addJpeg(p.jpeg, p.width, p.height), x0, y - h, w, h);
  }
  return doc.build();
}

function photoBytes(data: string): Buffer {
  const b64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  return Buffer.from(b64, "base64");
}

/** Check-out with the patient's second code: notes + vitals (+ photos with consent) → the patient's record; the booking completes. */
export async function checkOutVisit(visitId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<{ visit: HealthCareVisit; documentId: string; bookingCompleted: boolean }> {
  const input = checkOutInput.parse(raw);
  const { visit, booking, patient } = await providerVisit(visitId, actor);
  if (visit.status !== "IN_PROGRESS") throw conflict("Check in first (with the patient's check-in code).");
  if (input.photos.length && !input.photoConsent) throw validationFailed("Photos can be added only when the patient agrees. Tick the consent box or remove the photos.", { fields: { photoConsent: "Required for photos." } });
  const rule = await getRule("health");
  if (visit.otpAttempts >= rule.careOtpMaxAttempts) throw conflict("Too many wrong codes. Ask GoKesari support to help.", { reason: "OTP_LOCKED" });
  if (!visitCodeMatches(visit.id, visit.otpSalt, "out", input.code)) await wrongCode(visit, rule.careOtpMaxAttempts, now);
  const who = await providerLabel(visit.memberId, booking.shopId);
  const [care] = visit.memberId ? await db.select().from(healthCareProviderProfiles).where(eq(healthCareProviderProfiles.memberId, visit.memberId)) : [];
  const cats = visit.memberId ? ((await memberCareCategories([visit.memberId])).get(visit.memberId) ?? []) : [];
  const photos: { jpeg: Buffer; width: number; height: number }[] = [];
  if (input.photos.length) {
    const { toJpeg } = await import("./doctors");
    const { imageWithSize } = await import("./letterheads");
    for (const p of input.photos) {
      const bytes = photoBytes(p);
      if (!bytes.length || bytes.length > 4_000_000) throw validationFailed("Each photo must be under 4 MB.");
      const sized = await imageWithSize(await toJpeg(bytes, 1400));
      if (sized) photos.push(sized);
    }
  }
  const vitals: Vitals = Object.fromEntries(Object.entries(input.vitals).filter(([, v]) => v != null)) as Vitals;
  const { ageText } = await import("./consultations");
  const pdf = renderVisitNotePdf({
    patientName: patient.fullName,
    age: ageText(patient.dateOfBirth, now),
    gender: patient.gender,
    providerName: who.name,
    shopName: who.shopName,
    idCardNumber: care?.idCardNumber ?? null,
    categories: cats.map((c) => c.name),
    bookingNumber: booking.bookingNumber,
    serviceName: booking.serviceName,
    checkedInAt: visit.checkedInAt,
    checkedOutAt: now,
    notes: input.notes,
    vitals,
    photos,
  });
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(healthCareVisits)
      .set({ status: "COMPLETED", checkedOutAt: now, notes: input.notes, vitals, otpAttempts: 0, updatedAt: now })
      .where(and(eq(healthCareVisits.id, visit.id), eq(healthCareVisits.status, "IN_PROGRESS")))
      .returning();
    if (!row) throw conflict("This visit was already checked out.");
    const [docRow] = await tx
      .insert(healthDocuments)
      .values({
        patientId: patient.id,
        uploadedBy: actor.id,
        source: "PROVIDER",
        kind: "VISIT_NOTE",
        title: `${booking.serviceName} — visit note`.slice(0, 160),
        documentDate: istDateKey(now),
        careVisitId: visit.id,
        providerMemberId: visit.memberId,
        providerName: who.label.slice(0, 160),
        fileName: `visit-note-${booking.bookingNumber}.pdf`,
        contentType: "application/pdf",
        sizeBytes: pdf.length,
        data: encryptBytes(pdf),
        createdAt: now,
      })
      .returning({ id: healthDocuments.id });
    await addTimeline(tx, {
      patientId: patient.id,
      occurredAt: now,
      kind: "CARE_VISIT",
      title: `${booking.serviceName} (home care)`,
      summary: `Visit by ${who.name}${visit.sessionNo ? `, session ${visit.sessionNo}` : ""}. Visit note added.`,
      providerName: who.label,
      providerMemberId: visit.memberId,
      providerShopId: booking.shopId,
      refType: "care_visit",
      refId: visit.id,
      meta: { bookingNumber: booking.bookingNumber, documentId: docRow.id, sessionNo: visit.sessionNo },
    });
    if (visit.packageId) {
      await tx
        .update(healthCarePackages)
        .set({
          sessionsDone: sql`least(${healthCarePackages.sessionsDone} + 1, ${healthCarePackages.sessionsTotal})`,
          status: sql`case when ${healthCarePackages.sessionsDone} + 1 >= ${healthCarePackages.sessionsTotal} then 'COMPLETED' else ${healthCarePackages.status} end`,
          updatedAt: now,
        })
        .where(eq(healthCarePackages.id, visit.packageId));
    }
    await event("care_booking.checked_out", row, booking, patient, tx, { documentId: docRow.id });
    await publishHealthEvent({ name: "record.added", userIds: patientAudience(patient), subjectId: patient.id, payload: { documentId: docRow.id } }, tx);
    return { visit: row, documentId: docRow.id };
  });
  // The patient's code was checked here, so the consult booking completes with the booking's own code.
  let bookingCompleted = false;
  if (booking.status === "CONFIRMED") {
    try {
      const needsCode = await completionNeedsCode(booking);
      await completeBooking(booking.id, actor, needsCode ? completionCode(booking.id, booking.otpSalt ?? "") : null, now);
      bookingCompleted = true;
    } catch (error) {
      console.error("[health] care booking completion failed", booking.id, error instanceof Error ? error.message : error);
    }
  }
  await event("care_booking.completed", result.visit, booking, patient);
  await tellPatient(patient, visit.id, "Home-care visit completed", `${who.name} finished ${booking.serviceName}. The visit note is in your health record. Please rate the visit.`);
  return { ...result, bookingCompleted };
}

/** The agency gives a visit to another verified provider of the team (same time). */
export async function reassignCareVisit(visitId: string, memberId: string, actor: HealthActor): Promise<HealthCareVisit> {
  const { visit, booking, access, patient } = await providerVisit(visitId, actor);
  if (access.role !== "OWNER" && access.role !== "STAFF") throw forbidden("Only the agency owner can assign staff.");
  if (visit.status !== "SCHEDULED") throw conflict("A visit can be reassigned only before it starts.");
  const m = await memberOrThrow(memberId);
  if (m.member.shopId !== booking.shopId) throw validationFailed("Choose someone from your team.");
  if (!(await careVerification(memberId)).verified) throw forbidden("Only verified providers can be sent on visits.");
  await reassignBooking(booking.id, memberId, actor);
  const [u] = await db.update(healthCareVisits).set({ memberId, updatedAt: new Date() }).where(eq(healthCareVisits.id, visit.id)).returning();
  await event("care_booking.accepted", u, booking, patient, db, { reassigned: true });
  if (m.member.userId) {
    await notify({ userId: m.member.userId, type: NOTIFICATION_TYPES.HEALTH_CARE_BOOKING, title: "Home-care visit assigned to you", body: `${booking.serviceName}, ${formatSlot(booking.startsAt)}. Booking ${booking.bookingNumber}.`, actionUrl: `/shop/health/care/visits/${visit.id}`, channels: ["PUSH"], metadata: { visitId: visit.id } });
  }
  await tellPatient(patient, visit.id, "Your care provider changed", `${m.member.name} will come for ${booking.serviceName} on ${formatSlot(booking.startsAt)}. See their photo and ID card in My Health.`, "HEALTH_CARE_BOOKING");
  return u;
}

export interface CareEarningRow {
  bookingId: string;
  bookingNumber: string;
  startsAt: Date;
  serviceName: string;
  memberName: string | null;
  status: string;
  feePaise: number;
  paidOnlinePaise: number;
  paidOfflinePaise: number;
  refundPaise: number;
  commissionPaise: number;
  /** What GoKesari pays out: online money kept − commission (commission on money taken at the visit is recovered here too). */
  payoutPaise: number;
  settledAt: Date | null;
}

/** Earnings from home-care visits (from the consult bookings; commission as the consult engine settled it). */
export async function careEarnings(shopId: string, actor: HealthActor, opts: { fromKey?: string; toKey?: string } = {}, now: Date = new Date()): Promise<{ rows: CareEarningRow[]; totals: { visits: number; onlinePaise: number; offlinePaise: number; commissionPaise: number; payoutPaise: number } }> {
  const access = await requireFirmAccess(shopId, actor, "bookings");
  const toKey = opts.toKey && /^\d{4}-\d{2}-\d{2}$/.test(opts.toKey) ? opts.toKey : istDateKey(now);
  const fromKey = opts.fromKey && /^\d{4}-\d{2}-\d{2}$/.test(opts.fromKey) ? opts.fromKey : addDays(toKey, -60);
  const rows = await db
    .select({ b: consultBookings, memberName: consultMembers.name })
    .from(healthCareVisits)
    .innerJoin(consultBookings, eq(consultBookings.id, healthCareVisits.bookingId))
    .leftJoin(consultMembers, eq(consultMembers.id, healthCareVisits.memberId))
    .where(
      and(
        eq(healthCareVisits.shopId, shopId),
        inArray(consultBookings.status, ["COMPLETED", "NO_SHOW", "CANCELLED", "REJECTED", "CONFIRMED"]),
        gte(consultBookings.startsAt, istAt(fromKey, 0)),
        sql`${consultBookings.startsAt} < ${istAt(addDays(toKey, 1), 0).toISOString()}::timestamptz`,
        access.role === "MEMBER" && access.memberId ? eq(healthCareVisits.memberId, access.memberId) : undefined,
      ),
    )
    .orderBy(desc(consultBookings.startsAt))
    .limit(1000);
  const out = rows
    .filter((r) => r.b.paidOnlinePaise + r.b.paidOfflinePaise > 0 || r.b.status === "COMPLETED")
    .map((r) => ({
      bookingId: r.b.id,
      bookingNumber: r.b.bookingNumber,
      startsAt: r.b.startsAt,
      serviceName: r.b.serviceName,
      memberName: r.memberName,
      status: r.b.status,
      feePaise: r.b.feePaise,
      paidOnlinePaise: r.b.paidOnlinePaise,
      paidOfflinePaise: r.b.paidOfflinePaise,
      refundPaise: r.b.refundPaise,
      commissionPaise: r.b.commissionPaise,
      payoutPaise: Math.max(0, r.b.paidOnlinePaise - r.b.refundPaise) - r.b.commissionPaise,
      settledAt: r.b.settledAt,
    }));
  return {
    rows: out,
    totals: {
      visits: out.filter((r) => r.status === "COMPLETED").length,
      onlinePaise: out.reduce((n, r) => n + Math.max(0, r.paidOnlinePaise - r.refundPaise), 0),
      offlinePaise: out.reduce((n, r) => n + r.paidOfflinePaise, 0),
      commissionPaise: out.reduce((n, r) => n + r.commissionPaise, 0),
      payoutPaise: out.reduce((n, r) => n + r.payoutPaise, 0),
    },
  };
}

/* ------------------------------------------------------------ patient side */

export interface PatientVisitCard {
  visitId: string;
  bookingId: string;
  bookingNumber: string;
  startsAt: Date;
  serviceName: string;
  status: string;
  statusLabel: string;
  bookingStatus: string;
  patientName: string;
  providerName: string | null;
  shopName: string;
  sessionNo: number | null;
  packageName: string | null;
}

/** Every home-care visit of the people the actor manages (newest first). */
export async function patientCareVisits(actor: HealthActor): Promise<PatientVisitCard[]> {
  const { patientsForUser } = await import("./access");
  const patients = await patientsForUser(actor.id);
  if (!patients.length) return [];
  const rows = await db
    .select({ v: healthCareVisits, b: consultBookings, memberName: consultMembers.name, shopName: shops.name, pkg: healthCarePackages })
    .from(healthCareVisits)
    .innerJoin(consultBookings, eq(consultBookings.id, healthCareVisits.bookingId))
    .innerJoin(shops, eq(shops.id, healthCareVisits.shopId))
    .leftJoin(consultMembers, eq(consultMembers.id, healthCareVisits.memberId))
    .leftJoin(healthCarePackages, eq(healthCarePackages.id, healthCareVisits.packageId))
    .where(inArray(healthCareVisits.patientId, patients.map((p) => p.id)))
    .orderBy(desc(consultBookings.startsAt))
    .limit(200);
  return rows.map((r) => {
    const status = ["CANCELLED", "REJECTED", "EXPIRED", "NO_SHOW"].includes(r.b.status) && r.v.status !== "COMPLETED" ? "CANCELLED" : r.v.status;
    return {
      visitId: r.v.id,
      bookingId: r.b.id,
      bookingNumber: r.b.bookingNumber,
      startsAt: r.b.startsAt,
      serviceName: r.b.serviceName,
      status,
      statusLabel: r.b.status === "PENDING_PAYMENT" ? "Awaiting payment" : r.b.status === "PENDING_APPROVAL" ? "Waiting for the provider to accept" : (CARE_VISIT_STATUS_LABELS[status as CareVisitStatus] ?? status),
      bookingStatus: r.b.status,
      patientName: patients.find((p) => p.id === r.v.patientId)?.fullName ?? "",
      providerName: r.memberName,
      shopName: r.shopName,
      sessionNo: r.v.sessionNo,
      packageName: r.pkg?.name ?? null,
    };
  });
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export interface PatientVisitView {
  visit: { id: string; status: string; statusLabel: string; onTheWayAt: Date | null; checkedInAt: Date | null; checkedOutAt: Date | null; notes: string | null; vitals: Vitals; shareRecords: boolean; sosAt: Date | null; sessionNo: number | null };
  booking: { id: string; bookingNumber: string; startsAt: Date; endsAt: Date; status: string; mode: string; serviceName: string; feePaise: number; paymentMode: string; paymentStatus: string; visitAddress: string | null; rating: number | null; review: string | null; ticketId: string | null; serviceId: string };
  patient: { id: string; name: string; hasEmergencyContact: boolean };
  provider: { memberId: string | null; name: string; title: string | null; photoUrl: string | null; qualifications: string | null; experienceYears: number | null; languages: string[]; shopName: string; shopSlug: string; phone: string | null; idCard: CareIdCard | null };
  codes: { checkIn: string | null; checkOut: string | null };
  live: { distanceKm: number | null; etaMinutes: number | null; lastLocationAt: Date | null } | null;
  documentId: string | null;
  package: { id: string; name: string; sessionsTotal: number; sessionsDone: number; status: string; canBookNext: boolean } | null;
  ticketNumber: string | null;
  can: { rate: boolean; complain: boolean; sos: boolean; cancel: boolean };
}

/** The patient's visit screen: status, provider card and ID card, OTP codes, live "on the way", notes, rating. */
export async function careVisitForPatient(visitId: string, actor: HealthActor, now: Date = new Date()): Promise<PatientVisitView> {
  const { visit, booking, patient } = await patientVisit(visitId, actor);
  const [m] = visit.memberId ? await db.select().from(consultMembers).where(eq(consultMembers.id, visit.memberId)) : [];
  const [s] = await db.select({ name: shops.name, slug: shops.slug, phone: shops.contactPhone }).from(shops).where(eq(shops.id, booking.shopId));
  const idCard = visit.memberId ? await idCardOf(visit.memberId).catch(() => null) : null;
  const [pkg] = visit.packageId ? await db.select().from(healthCarePackages).where(eq(healthCarePackages.id, visit.packageId)) : [];
  let booked = 0;
  if (pkg) {
    [{ n: booked }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(healthCareVisits)
      .where(and(eq(healthCareVisits.packageId, pkg.id), ne(healthCareVisits.status, "CANCELLED")));
  }
  const [doc] = await db.select({ id: healthDocuments.id }).from(healthDocuments).where(and(eq(healthDocuments.careVisitId, visit.id), isNull(healthDocuments.hiddenAt))).limit(1);
  const [ticket] = booking.ticketId ? await db.select({ number: supportTickets.ticketNumber }).from(supportTickets).where(eq(supportTickets.id, booking.ticketId)) : [];
  let live: PatientVisitView["live"] = null;
  if (visit.status === "ON_THE_WAY") {
    const distanceKm =
      visit.lastLatitude != null && visit.lastLongitude != null && booking.visitLatitude != null && booking.visitLongitude != null
        ? Math.round(haversineKm({ lat: visit.lastLatitude, lng: visit.lastLongitude }, { lat: booking.visitLatitude, lng: booking.visitLongitude }) * 10) / 10
        : null;
    // City travel at about 20 km/h door to door, plus a couple of minutes to park and walk up.
    live = { distanceKm, etaMinutes: distanceKm == null ? null : Math.max(1, Math.round((distanceKm / 20) * 60) + 2), lastLocationAt: visit.lastLocationAt };
  }
  const isCustomer = booking.customerId === actor.id;
  const active = booking.status === "CONFIRMED";
  return {
    visit: { id: visit.id, status: visit.status, statusLabel: booking.status === "PENDING_PAYMENT" ? "Awaiting payment" : booking.status === "PENDING_APPROVAL" ? "Waiting for the provider to accept" : (CARE_VISIT_STATUS_LABELS[visit.status as CareVisitStatus] ?? visit.status), onTheWayAt: visit.onTheWayAt, checkedInAt: visit.checkedInAt, checkedOutAt: visit.checkedOutAt, notes: visit.status === "COMPLETED" ? visit.notes : null, vitals: visit.status === "COMPLETED" ? visit.vitals : {}, shareRecords: visit.shareRecords, sosAt: visit.sosAt, sessionNo: visit.sessionNo },
    booking: { id: booking.id, bookingNumber: booking.bookingNumber, startsAt: booking.startsAt, endsAt: booking.endsAt, status: booking.status, mode: booking.mode, serviceName: booking.serviceName, feePaise: booking.feePaise, paymentMode: booking.paymentMode, paymentStatus: booking.paymentStatus, visitAddress: booking.visitAddress, rating: booking.rating, review: booking.review, ticketId: booking.ticketId, serviceId: booking.serviceId },
    patient: { id: patient.id, name: patient.fullName, hasEmergencyContact: Boolean(patient.emergencyPhone) },
    provider: { memberId: visit.memberId, name: m?.name ?? s?.name ?? "Care provider", title: m?.title ?? null, photoUrl: m?.photoUrl ?? null, qualifications: m?.qualifications ?? null, experienceYears: m?.experienceYears ?? null, languages: m?.languages ?? [], shopName: s?.name ?? "", shopSlug: s?.slug ?? "", phone: s?.phone ?? null, idCard },
    codes: {
      checkIn: active && (visit.status === "SCHEDULED" || visit.status === "ON_THE_WAY") ? visitCode(visit.id, visit.otpSalt, "in") : null,
      checkOut: visit.status === "IN_PROGRESS" ? visitCode(visit.id, visit.otpSalt, "out") : null,
    },
    live,
    documentId: doc?.id ?? null,
    package: pkg ? { id: pkg.id, name: pkg.name, sessionsTotal: pkg.sessionsTotal, sessionsDone: pkg.sessionsDone, status: pkg.status, canBookNext: pkg.status === "ACTIVE" && booked < pkg.sessionsTotal } : null,
    ticketNumber: ticket?.number ?? null,
    can: {
      rate: isCustomer && booking.status === "COMPLETED" && !booking.rating,
      complain: isCustomer && !booking.ticketId && ["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED", "REJECTED"].includes(booking.status),
      sos: ["SCHEDULED", "ON_THE_WAY", "IN_PROGRESS"].includes(visit.status) && active && now.getTime() >= booking.startsAt.getTime() - 6 * HOUR,
      cancel: isCustomer && visit.status === "SCHEDULED" && ["CONFIRMED", "PENDING_APPROVAL", "PENDING_PAYMENT"].includes(booking.status),
    },
  };
}

export const sosInput = z.object({ latitude: z.number().min(-90).max(90).nullish(), longitude: z.number().min(-180).max(180).nullish() }).default({});

/** SOS during a visit: SMS to the patient's emergency contact, an urgent GoKesari support ticket, the practice told. */
export async function careSos(visitId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<{ smsSent: boolean; ticketNumber: string | null }> {
  const input = sosInput.parse(raw ?? {});
  const { visit, booking, patient } = await patientVisit(visitId, actor);
  const recentlyDone = visit.status === "COMPLETED" && visit.checkedOutAt && now.getTime() - visit.checkedOutAt.getTime() < 2 * HOUR;
  if (!["SCHEDULED", "ON_THE_WAY", "IN_PROGRESS"].includes(visit.status) && !recentlyDone) throw conflict("SOS is available during a visit.");
  const [u] = await db.update(healthCareVisits).set({ sosAt: now, updatedAt: now }).where(eq(healthCareVisits.id, visit.id)).returning();
  const who = await providerLabel(visit.memberId, booking.shopId);
  const where = input.latitude != null && input.longitude != null ? ` Location: https://maps.google.com/?q=${input.latitude},${input.longitude}` : booking.visitAddress ? ` Address: ${booking.visitAddress.slice(0, 160)}` : "";
  let smsSent = false;
  if (patient.emergencyPhone) {
    try {
      const { sendText } = await import("@/server/messaging/sms-whatsapp");
      await sendText("SMS", patient.emergencyPhone, `GoKesari SOS: ${patient.fullName} pressed SOS during a home-care visit (booking ${booking.bookingNumber}) at ${formatSlot(now)}. Please call them now.${where}`, "health-care-sos");
      smsSent = true;
    } catch (error) {
      console.error("[health] SOS SMS failed", visit.id, error instanceof Error ? error.message : error);
    }
  }
  let ticketNumber: string | null = null;
  try {
    const { createTicket } = await import("@/server/aftercare/support-tickets");
    const ticket = await createTicket(
      {
        category: "BOOKING",
        subject: `SOS: home-care visit ${booking.bookingNumber}`,
        description: `The patient's family pressed SOS during a home-care visit. Booking ${booking.bookingNumber}, ${formatSlot(booking.startsAt)}. Provider: ${who.label}. Visit status: ${visit.status}. Emergency contact ${smsSent ? "was sent an SMS" : patient.emergencyPhone ? "could not be sent an SMS" : "is not on file"}.${where} Call the patient at once.`,
        priority: "URGENT",
      },
      actor,
    );
    await db.update(supportTickets).set({ shopId: booking.shopId }).where(eq(supportTickets.id, ticket.id));
    ticketNumber = ticket.ticketNumber;
  } catch (error) {
    console.error("[health] SOS ticket failed", visit.id, error instanceof Error ? error.message : error);
  }
  await event("care_booking.sos", u, booking, patient, db, { smsSent, ticket: Boolean(ticketNumber) });
  for (const userId of await careTeamUsers(booking.shopId, visit.memberId)) {
    await notify({ userId, type: NOTIFICATION_TYPES.HEALTH_CARE_SOS, title: "SOS raised during a home-care visit", body: `The patient's family pressed SOS during booking ${booking.bookingNumber}. GoKesari support will call. Please check on the visit now.`, actionUrl: `/shop/health/care/visits/${visit.id}`, channels: ["PUSH"], metadata: { visitId: visit.id } });
  }
  await tellPatient(patient, visit.id, "SOS sent", `${smsSent ? "Your emergency contact got an SMS. " : ""}${ticketNumber ? `GoKesari support will call you now (ticket ${ticketNumber}). ` : ""}If anyone is in danger, call 112.`, "HEALTH_CARE_SOS");
  return { smsSent, ticketNumber };
}

/** Rating after the visit (consult rateBooking: the account holder who booked). */
export async function rateCareVisit(visitId: string, raw: unknown, actor: HealthActor) {
  const { booking } = await patientVisit(visitId, actor);
  return rateBooking(booking.id, raw, actor);
}

/** A complaint opens a consult dispute (help-desk ticket). */
export async function complainCareVisit(visitId: string, raw: unknown, actor: HealthActor) {
  const { booking } = await patientVisit(visitId, actor);
  return raiseDispute(booking.id, raw, actor);
}

/** The patient cancels before the visit (consult policy refunds apply). */
export async function cancelCareVisit(visitId: string, reason: string | null, actor: HealthActor): Promise<{ status: string }> {
  const { visit, booking, patient } = await patientVisit(visitId, actor);
  if (booking.customerId !== actor.id) throw forbidden("Only the person who booked can cancel.");
  if (visit.status !== "SCHEDULED") throw conflict("The visit has already started.");
  await cancelBooking(booking.id, actor, reason);
  const [u] = await db.update(healthCareVisits).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(healthCareVisits.id, visit.id)).returning();
  await event("care_booking.declined", u, booking, patient, db, { by: "PATIENT" });
  return { status: "CANCELLED" };
}

/** The visit note PDF: the patient side, or the practice that wrote it. Every look is logged. */
export async function careVisitNote(visitId: string, actor: HealthActor, ip?: string | null): Promise<{ contentType: string; fileName: string; data: Buffer }> {
  const { visit, booking } = await loadVisit(visitId);
  let label = "You";
  let role: string | undefined;
  try {
    await requirePatientAccess(visit.patientId, actor);
  } catch {
    const v = await bookingViewer(booking, actor).catch(() => null);
    if (!v || v.viewer === "CUSTOMER") throw notFound("Visit note");
    label = v.viewer === "STAFF" ? "GoKesari staff" : (await providerLabel(visit.memberId, booking.shopId)).label;
    role = v.viewer === "STAFF" ? actor.role : "CARE_PROVIDER";
  }
  const [d] = await db.select().from(healthDocuments).where(and(eq(healthDocuments.careVisitId, visit.id), isNull(healthDocuments.hiddenAt))).limit(1);
  if (!d) throw notFound("Visit note");
  await logRecordAccess({ patientId: visit.patientId, actor, actorLabel: label, actorRole: role, action: "DOWNLOAD", objectType: "document", objectId: d.id, ipAddress: ip ?? null });
  return { contentType: d.contentType, fileName: d.fileName, data: decryptBytes(d.data) };
}

/**
 * For the booking form: the actor's family, saved addresses, an optional package to continue, and an
 * optional doctor's suggestion ("Book now" on a prescription: /health/care?category=…&suggestion=…) whose
 * patient is preselected when the actor may manage that patient.
 */
export async function careBookingContext(actor: HealthActor, opts: { packageId?: string | null; suggestionId?: string | null } = {}) {
  const packageId = opts.packageId;
  const { patientsForUser } = await import("./access");
  const [patients, saved] = await Promise.all([
    patientsForUser(actor.id),
    db.select().from(addresses).where(eq(addresses.userId, actor.id)).orderBy(desc(addresses.isDefault), desc(addresses.createdAt)).limit(20),
  ]);
  let suggestion: { id: string; patientId: string; type: string } | null = null;
  if (opts.suggestionId && /^[0-9a-f-]{36}$/i.test(opts.suggestionId)) {
    const [s] = await db.select({ id: healthSuggestions.id, patientId: healthSuggestions.patientId, type: healthSuggestions.type, status: healthSuggestions.status }).from(healthSuggestions).where(eq(healthSuggestions.id, opts.suggestionId));
    if (s && s.status === "OPEN" && (await requirePatientAccess(s.patientId, actor).then(() => true).catch(() => false))) suggestion = { id: s.id, patientId: s.patientId, type: s.type };
  }
  let pkg: HealthCarePackage | null = null;
  if (packageId && /^[0-9a-f-]{36}$/i.test(packageId)) {
    [pkg] = await db.select().from(healthCarePackages).where(eq(healthCarePackages.id, packageId));
    if (pkg && !patients.some((p) => p.id === pkg!.patientId)) pkg = null;
  }
  let lastVisit: { memberId: string | null; serviceId: string; address: string | null; latitude: number | null; longitude: number | null } | null = null;
  if (pkg) {
    const [last] = await db
      .select({ memberId: healthCareVisits.memberId, serviceId: consultBookings.serviceId, address: consultBookings.visitAddress, latitude: consultBookings.visitLatitude, longitude: consultBookings.visitLongitude })
      .from(healthCareVisits)
      .innerJoin(consultBookings, eq(consultBookings.id, healthCareVisits.bookingId))
      .where(eq(healthCareVisits.packageId, pkg.id))
      .orderBy(desc(consultBookings.startsAt))
      .limit(1);
    lastVisit = last ?? null;
  }
  return {
    patients: patients.map((p) => ({ id: p.id, name: p.fullName, relation: p.relation })),
    addresses: saved.map((a) => ({ id: a.id, label: a.label, text: [a.line1, a.line2, a.area, a.city, a.pincode].filter(Boolean).join(", "), latitude: a.latitude, longitude: a.longitude })),
    package: pkg ? { id: pkg.id, name: pkg.name, patientId: pkg.patientId, serviceId: pkg.serviceId, sessionsTotal: pkg.sessionsTotal, sessionsDone: pkg.sessionsDone, last: lastVisit } : null,
    suggestion,
  };
}
