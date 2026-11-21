/**
 * GoKesari Health: admin and operator tools (owner brief §6, §7; docs/health/).
 *
 *  - Verification queues: doctors and home-care providers (through the consultant engine's verifyProfile,
 *    which also decides each member's certificate), medical stores and equipment stores (their own
 *    health profile rows), police verification of home-care providers.
 *  - Lists: the equipment master (CRUD) and the home-care categories (kept in consultant categories).
 *  - Settings (read-only), reports, the access log and health audit rows — metadata only: no diagnosis,
 *    complaint, condition, allergy or medicine name ever leaves these functions.
 *  - Break-glass (admins, rule health.breakGlassEnabled): an emergency read of one patient's timeline and
 *    prescriptions with a reason; every open is logged, audited and told to the patient's account holder.
 *  - DPDP data requests (export / delete): staff close them; the patient downloads their own export.
 *
 * health:manage (admins and operators) for everything except Prime / Settings / Support (admins) and
 * break-glass (health:break_glass, admins only).
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { addDays, isDateKey, istAt, istDateKey, monthStart } from "@/lib/consult/time";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { ACCESS_ACTIONS, CARE_CATEGORY_GROUP, EXTRA_CARE_CATEGORY_SLUGS, HEALTH_DOCTOR_PATH, HEALTH_PATH } from "@/lib/health/constants";
import { HEALTH_GROUP_PREFIX, HEALTH_SPECIALTY_GROUPS, healthGroupOf, OTHER_HEALTH_GROUP } from "@/lib/health/specialties";
import { verifyProfile } from "@/server/consult/admin";
import { db } from "@/server/db";
import {
  auditLogs,
  consultBookings,
  consultCategories,
  consultMembers,
  healthAccessLog,
  healthAppointmentLinks,
  healthCareProviderProfiles,
  healthCareVisits,
  healthConsents,
  healthConsultations,
  healthDataRequests,
  healthDocuments,
  healthDoctorProfiles,
  healthDrugMaster,
  healthEquipmentListings,
  healthEquipmentMaster,
  healthEquipmentStoreProfiles,
  healthIcd10,
  healthPatients,
  healthPharmacyProfiles,
  healthPrescriptionItems,
  healthPrescriptions,
  healthRentals,
  healthRxOrders,
  healthTimeline,
  shopCategories,
  shops,
  users,
  type HealthEquipmentMaster,
  type HealthPatient,
} from "@/server/db/schema";
import { getShopLegalStatus } from "@/server/services/legal-documents";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify, NOTIFICATION_TYPES } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { canBreakGlass, isHealthStaff, logRecordAccess, patientAudience, patientsForUser, type HealthActor } from "./access";
import { publishHealthEvent } from "./events";
import { timelineFor } from "./timeline";

/**
 * Audit actions this module writes that are not (yet) in AUDIT_ACTIONS. Both start with "health." so the
 * Access & audit tab lists them. Lead: add HEALTH_PROVIDER_VERIFIED / HEALTH_EQUIPMENT_MASTER to
 * src/server/services/audit.ts and use them here.
 */
const HEALTH_PROVIDER_VERIFIED = AUDIT_ACTIONS.HEALTH_PROVIDER_VERIFIED;
const HEALTH_EQUIPMENT_MASTER = AUDIT_ACTIONS.HEALTH_EQUIPMENT_MASTER;

/** The patient's own prescription PDF (patient API, built with the My Health screens). */
export const prescriptionPdfPath = (id: string) => `/api/health/prescriptions/${id}/pdf`;

/* ------------------------------------------------------------------ who sees what */

export const HEALTH_ADMIN_TABS = ["verify", "specialties", "drugs", "lists", "prime", "settings", "reports", "logs", "breakglass", "requests", "support"] as const;
export type HealthAdminTab = (typeof HEALTH_ADMIN_TABS)[number];

/** Operators (health:manage) see verification, drug master, lists, reports, logs and data requests; admins see everything; break-glass needs health:break_glass. */
export function healthAdminTabs(actor: Pick<HealthActor, "role">): HealthAdminTab[] {
  if (!isHealthStaff(actor)) return [];
  const admin = actor.role === "ADMIN";
  return HEALTH_ADMIN_TABS.filter((t) => {
    if (t === "breakglass") return canBreakGlass(actor);
    if (t === "prime" || t === "settings" || t === "support") return admin;
    return true;
  });
}

function requireStaff(actor: HealthActor): void {
  if (!isHealthStaff(actor)) throw forbidden("GoKesari Health administration is for GoKesari staff.");
}

function requireAdmin(actor: HealthActor): void {
  requireStaff(actor);
  if (actor.role !== "ADMIN") throw forbidden("Only administrators can see this.");
}

const clean = (q: string | undefined | null) => (q ?? "").trim().replace(/[%_\\]/g, "").slice(0, 80);

/** "A.P." from "Asha Patil" — the only form of a patient's name in staff lists. */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  return parts
    .slice(0, 3)
    .map((p) => `${p[0]!.toUpperCase()}.`)
    .join("");
}

/* ------------------------------------------------------------------ verification: doctors and home care */

export const providerQueueInput = z.object({
  kind: z.enum(["DOCTOR", "CARE"]).default("DOCTOR"),
  status: z.enum(["PENDING", "VERIFIED", "REJECTED", "ALL"]).default("PENDING"),
  q: z.string().trim().max(80).optional(),
});

export interface ProviderMember {
  id: string;
  name: string;
  docStatus: string;
  registrationNumber: string | null;
  registrationBody: string | null;
  categories: string[];
  documents: number;
  doctor: { fullName: string; practitionerType: string; qualifications: string; specialties: string[]; council: string; registrationNumber: string; registrationYear: number | null; hprId: string | null } | null;
  care: { providerKind: string; gender: string | null; registrationBody: string | null; registrationNumber: string | null; policeVerification: string; servicePincodes: string[]; serviceRadiusKm: number; idCardNumber: string } | null;
}

export interface ProviderCard {
  profileId: string;
  shopId: string;
  slug: string;
  name: string;
  shopName: string;
  city: string;
  profileStatus: string;
  verification: string;
  verificationNote: string | null;
  members: ProviderMember[];
}

function kindCondition(kind: "DOCTOR" | "CARE"): SQL {
  return kind === "DOCTOR" ? sql`c.required_doc = 'MEDICAL_REGISTRATION'` : sql`(c.group_name = ${CARE_CATEGORY_GROUP} or c.slug in ${[...EXTRA_CARE_CATEGORY_SLUGS]})`;
}

/** Doctors (members of a category needing a medical council registration) or home-care providers, by profile. */
export async function providerQueue(actor: HealthActor, raw: unknown): Promise<ProviderCard[]> {
  requireStaff(actor);
  const f = providerQueueInput.parse(raw ?? {});
  const conds: SQL[] = [sql`m.status = 'ACTIVE'`, sql`exists (select 1 from consult_member_categories mc join consult_categories c on c.id = mc.category_id where mc.member_id = m.id and ${kindCondition(f.kind)})`];
  if (f.status === "PENDING") conds.push(sql`(m.doc_status = 'SUBMITTED' or p.verification = 'PENDING')`);
  if (f.status === "VERIFIED") conds.push(sql`(p.verification = 'VERIFIED' and m.doc_status in ('VERIFIED', 'NOT_REQUIRED'))`);
  if (f.status === "REJECTED") conds.push(sql`(p.verification = 'REJECTED' or m.doc_status = 'REJECTED')`);
  const term = clean(f.q);
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`(p.display_name ilike ${like} or s.name ilike ${like} or s.city ilike ${like} or m.name ilike ${like})`);
  }
  const rows = await db.execute<{
    member_id: string;
    member_name: string;
    doc_status: string;
    registration_number: string | null;
    registration_body: string | null;
    profile_id: string;
    display_name: string;
    profile_status: string;
    verification: string;
    verification_note: string | null;
    shop_id: string;
    slug: string;
    shop_name: string;
    city: string;
  }>(sql`
    select m.id as member_id, m.name as member_name, m.doc_status, m.registration_number, m.registration_body,
           p.id as profile_id, p.display_name, p.status as profile_status, p.verification, p.verification_note,
           s.id as shop_id, s.slug, s.name as shop_name, s.city
      from consult_members m
      join consult_profiles p on p.id = m.profile_id
      join shops s on s.id = p.shop_id
     where ${sql.join(conds, sql` and `)}
     order by (p.verification = 'PENDING' or m.doc_status = 'SUBMITTED') desc, p.updated_at desc, m.sort_order asc
     limit 300`);
  const memberIds = rows.map((r) => r.member_id);
  if (!memberIds.length) return [];
  const [docCounts, cats, doctors, cares] = await Promise.all([
    db.execute<{ member_id: string; n: number }>(sql`select member_id, count(*)::int as n from consult_member_documents where member_id in ${memberIds} group by member_id`),
    db.execute<{ member_id: string; name: string }>(sql`select mc.member_id, c.name from consult_member_categories mc join consult_categories c on c.id = mc.category_id where mc.member_id in ${memberIds} order by c.sort_order`),
    db
      .select({
        memberId: healthDoctorProfiles.memberId,
        fullName: healthDoctorProfiles.fullName,
        practitionerType: healthDoctorProfiles.practitionerType,
        qualifications: healthDoctorProfiles.qualifications,
        specialties: healthDoctorProfiles.specialties,
        council: healthDoctorProfiles.council,
        registrationNumber: healthDoctorProfiles.registrationNumber,
        registrationYear: healthDoctorProfiles.registrationYear,
        hprId: healthDoctorProfiles.hprId,
      })
      .from(healthDoctorProfiles)
      .where(inArray(healthDoctorProfiles.memberId, memberIds)),
    db.select().from(healthCareProviderProfiles).where(inArray(healthCareProviderProfiles.memberId, memberIds)),
  ]);
  const cards = new Map<string, ProviderCard>();
  for (const r of rows) {
    let card = cards.get(r.profile_id);
    if (!card) {
      card = { profileId: r.profile_id, shopId: r.shop_id, slug: r.slug, name: r.display_name, shopName: r.shop_name, city: r.city, profileStatus: r.profile_status, verification: r.verification, verificationNote: r.verification_note, members: [] };
      cards.set(r.profile_id, card);
    }
    const d = doctors.find((x) => x.memberId === r.member_id);
    const c = cares.find((x) => x.memberId === r.member_id);
    card.members.push({
      id: r.member_id,
      name: r.member_name,
      docStatus: r.doc_status,
      registrationNumber: r.registration_number,
      registrationBody: r.registration_body,
      categories: cats.filter((x) => x.member_id === r.member_id).map((x) => x.name),
      documents: Number(docCounts.find((x) => x.member_id === r.member_id)?.n ?? 0),
      doctor: d ? { fullName: d.fullName, practitionerType: d.practitionerType, qualifications: d.qualifications, specialties: d.specialties, council: d.council, registrationNumber: d.registrationNumber, registrationYear: d.registrationYear, hprId: d.hprId } : null,
      care: c ? { providerKind: c.providerKind, gender: c.gender, registrationBody: c.registrationBody, registrationNumber: c.registrationNumber, policeVerification: c.policeVerification, servicePincodes: c.servicePincodes, serviceRadiusKm: c.serviceRadiusKm, idCardNumber: c.idCardNumber } : null,
    });
  }
  return [...cards.values()];
}

export const providerDecisionInput = z.object({
  kind: z.enum(["DOCTOR", "CARE"]),
  profileId: z.string().uuid(),
  decision: z.enum(["VERIFIED", "REJECTED"]),
  note: z.string().trim().max(500).nullish(),
  /** The members (doctors / care providers) whose certificates this decision covers. */
  memberIds: z.array(z.string().uuid()).max(50).default([]),
});

/**
 * Approves or rejects a doctor's / care provider's practice and their certificates (consult verifyProfile
 * does the update, audit and the consultant notice), then publishes provider.verified / provider.rejected
 * and sends the Health notice to the owner.
 */
export async function decideProvider(raw: unknown, actor: HealthActor): Promise<{ profileId: string; verification: string; members: number }> {
  requireStaff(actor);
  const input = providerDecisionInput.parse(raw);
  const note = input.note || null;
  if (input.decision === "REJECTED" && !note) throw validationFailed("Give the provider a reason.");
  const members = input.memberIds.length
    ? await db
        .select({ id: consultMembers.id, docStatus: consultMembers.docStatus })
        .from(consultMembers)
        .where(and(inArray(consultMembers.id, input.memberIds), eq(consultMembers.profileId, input.profileId)))
    : [];
  // A member without an uploaded certificate (MISSING) or who needs none keeps their status.
  const decided = members.filter((m) => m.docStatus === "SUBMITTED" || m.docStatus === "VERIFIED" || m.docStatus === "REJECTED");
  const profile = await verifyProfile(input.profileId, { decision: input.decision, note, members: decided.map((m) => ({ id: m.id, decision: input.decision, note })) }, actor);
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, profile.shopId));
  const verified = input.decision === "VERIFIED";
  await publishHealthEvent({ name: verified ? "provider.verified" : "provider.rejected", shopId: profile.shopId, userIds: [shop?.ownerId], subjectId: profile.id, payload: { kind: input.kind, profileId: profile.id, memberIds: decided.map((m) => m.id) } });
  if (shop?.ownerId) {
    const what = input.kind === "DOCTOR" ? "doctor" : "home-care";
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.HEALTH_VERIFICATION,
      title: verified ? `Your ${what} profile is verified for GoKesari Health` : `Your ${what} profile needs changes`,
      body: verified
        ? input.kind === "DOCTOR"
          ? "GoKesari checked your medical registration. Verified doctors can take Health bookings and issue e-prescriptions."
          : "GoKesari checked your details. Patients can now book your home-care services."
        : `GoKesari could not verify it yet: ${note}`,
      actionUrl: input.kind === "DOCTOR" ? HEALTH_DOCTOR_PATH : "/shop/consult/setup",
      channels: ["PUSH"],
      metadata: { profileId: profile.id, kind: input.kind, decision: input.decision },
    });
  }
  return { profileId: profile.id, verification: profile.verification, members: decided.length };
}

export const POLICE_STATUSES = ["NOT_REQUIRED", "PENDING", "VERIFIED", "FAILED"] as const;

/** Sets a home-care provider's police verification (staff record what the police report says). */
export async function setPoliceVerification(memberId: string, status: unknown, actor: HealthActor): Promise<{ memberId: string; policeVerification: string }> {
  requireStaff(actor);
  const value = z.enum(POLICE_STATUSES).parse(status);
  const [before] = await db.select().from(healthCareProviderProfiles).where(eq(healthCareProviderProfiles.memberId, z.string().uuid().parse(memberId)));
  if (!before) throw notFound("Home-care provider profile");
  const [row] = await db.update(healthCareProviderProfiles).set({ policeVerification: value, updatedAt: new Date() }).where(eq(healthCareProviderProfiles.id, before.id)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: HEALTH_PROVIDER_VERIFIED, entityType: "health_care_provider", entityId: before.id, previousValue: { policeVerification: before.policeVerification }, newValue: { policeVerification: value, memberId: before.memberId } });
  return { memberId: row.memberId, policeVerification: row.policeVerification };
}

/* ------------------------------------------------------------------ verification: medical and equipment stores */

export const storeQueueInput = z.object({
  kind: z.enum(["PHARMACY", "EQUIPMENT"]).default("PHARMACY"),
  status: z.enum(["PENDING", "VERIFIED", "REJECTED", "ALL"]).default("PENDING"),
  q: z.string().trim().max(80).optional(),
});

export interface StoreCard {
  shopId: string;
  shopName: string;
  slug: string;
  city: string;
  shopStatus: string;
  ownerName: string | null;
  verification: string;
  verificationNote: string | null;
  verifiedAt: string | null;
  createdAt: string;
  details: { label: string; value: string }[];
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");

export async function storeQueue(actor: HealthActor, raw: unknown): Promise<StoreCard[]> {
  requireStaff(actor);
  const f = storeQueueInput.parse(raw ?? {});
  const term = clean(f.q);
  const nameCond = term ? or(ilike(shops.name, `%${term}%`), ilike(shops.city, `%${term}%`)) : undefined;
  if (f.kind === "PHARMACY") {
    const t = healthPharmacyProfiles;
    const rows = await db
      .select({ p: t, shopName: shops.name, slug: shops.slug, city: shops.city, shopStatus: shops.status, ownerName: shops.ownerName })
      .from(t)
      .innerJoin(shops, eq(shops.id, t.shopId))
      .where(and(f.status === "ALL" ? undefined : eq(t.verification, f.status), nameCond))
      .orderBy(sql`${t.verification} = 'PENDING' desc`, desc(t.updatedAt))
      .limit(300);
    return rows.map((r) => ({
      shopId: r.p.shopId,
      shopName: r.shopName,
      slug: r.slug,
      city: r.city,
      shopStatus: r.shopStatus,
      ownerName: r.ownerName,
      verification: r.p.verification,
      verificationNote: r.p.verificationNote,
      verifiedAt: r.p.verifiedAt?.toISOString() ?? null,
      createdAt: r.p.createdAt.toISOString(),
      details: [
        { label: "Drug licence", value: r.p.drugLicenceNumber },
        { label: "Pharmacist", value: r.p.pharmacistName },
        { label: "Pharmacist registration", value: `${r.p.pharmacistRegistrationNumber}${r.p.pharmacyCouncil ? ` (${r.p.pharmacyCouncil})` : ""}` },
        { label: "Takes prescriptions", value: yesNo(r.p.acceptsPrescriptions) },
        { label: "Own delivery", value: r.p.ownDelivery ? `Yes, ${r.p.deliveryRadiusKm} km` : "No" },
        { label: "Cash on handover", value: yesNo(r.p.cashOnHandover) },
      ],
    }));
  }
  const t = healthEquipmentStoreProfiles;
  const rows = await db
    .select({ p: t, shopName: shops.name, slug: shops.slug, city: shops.city, shopStatus: shops.status, ownerName: shops.ownerName, listings: sql<number>`(select count(*)::int from health.equipment_listings l where l.shop_id = ${t.shopId})` })
    .from(t)
    .innerJoin(shops, eq(shops.id, t.shopId))
    .where(and(f.status === "ALL" ? undefined : eq(t.verification, f.status), nameCond))
    .orderBy(sql`${t.verification} = 'PENDING' desc`, desc(t.updatedAt))
    .limit(300);
  return rows.map((r) => ({
    shopId: r.p.shopId,
    shopName: r.shopName,
    slug: r.slug,
    city: r.city,
    shopStatus: r.shopStatus,
    ownerName: r.ownerName,
    verification: r.p.verification,
    verificationNote: r.p.verificationNote,
    verifiedAt: r.p.verifiedAt?.toISOString() ?? null,
    createdAt: r.p.createdAt.toISOString(),
    details: [
      { label: "Delivery radius", value: `${r.p.deliveryRadiusKm} km` },
      { label: "Listings", value: String(Number(r.listings)) },
      { label: "Rental terms", value: r.p.rentalTerms?.slice(0, 300) || "—" },
      { label: "Damage policy", value: r.p.damagePolicy?.slice(0, 300) || "—" },
    ],
  }));
}

export const storeDecisionInput = z.object({
  kind: z.enum(["PHARMACY", "EQUIPMENT"]),
  shopId: z.string().uuid(),
  decision: z.enum(["VERIFIED", "REJECTED"]),
  note: z.string().trim().max(500).nullish(),
});

/** Verifies or rejects a medical store / equipment store; the owner is told and the stores' screens refresh. */
export async function decideStore(raw: unknown, actor: HealthActor): Promise<{ shopId: string; verification: string }> {
  requireStaff(actor);
  const input = storeDecisionInput.parse(raw);
  const note = input.note || null;
  if (input.decision === "REJECTED" && !note) throw validationFailed("Give the store a reason.");
  const t = input.kind === "PHARMACY" ? healthPharmacyProfiles : healthEquipmentStoreProfiles;
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [before] = await tx.select({ verification: t.verification, ownerId: shops.ownerId }).from(t).innerJoin(shops, eq(shops.id, t.shopId)).where(eq(t.shopId, input.shopId));
    if (!before) throw notFound(input.kind === "PHARMACY" ? "Medical store profile" : "Equipment store profile");
    const [row] = await tx.update(t).set({ verification: input.decision, verificationNote: note, verifiedBy: actor.id, verifiedAt: now, updatedAt: now }).where(eq(t.shopId, input.shopId)).returning({ verification: t.verification });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: HEALTH_PROVIDER_VERIFIED, entityType: input.kind === "PHARMACY" ? "health_pharmacy" : "health_equipment_store", entityId: input.shopId, previousValue: { verification: before.verification }, newValue: { verification: input.decision, note } }, tx);
    return { ownerId: before.ownerId, verification: row.verification };
  });
  const verified = input.decision === "VERIFIED";
  await publishHealthEvent({ name: verified ? "provider.verified" : "provider.rejected", shopId: input.shopId, userIds: [result.ownerId], subjectId: input.shopId, payload: { kind: input.kind } });
  const what = input.kind === "PHARMACY" ? "medical store" : "equipment store";
  await notify({
    userId: result.ownerId,
    type: NOTIFICATION_TYPES.HEALTH_VERIFICATION,
    title: verified ? `Your ${what} is verified for GoKesari Health` : `Your ${what} needs changes`,
    body: verified
      ? input.kind === "PHARMACY"
        ? "GoKesari checked your drug licence and pharmacist. Patients can now send you their prescriptions."
        : "GoKesari checked your store. Patients can now rent and buy your equipment."
      : `GoKesari could not verify it yet: ${note}`,
    actionUrl: HEALTH_DOCTOR_PATH,
    channels: ["PUSH"],
    metadata: { shopId: input.shopId, kind: input.kind, decision: input.decision },
  });
  return { shopId: input.shopId, verification: result.verification };
}

/** The shop's legal documents (drug licence, GST …) as the legal-documents module sees them. */
export async function storeLegalStatus(shopId: string, actor: HealthActor): Promise<{ enabled: boolean; restricted: boolean; documents: { label: string; state: string; number: string | null; expiryDate: string | null }[] }> {
  requireStaff(actor);
  const s = await getShopLegalStatus(z.string().uuid().parse(shopId));
  return {
    enabled: s.enabled,
    restricted: s.restricted,
    documents: [...s.documents, ...s.additional].map((d) => ({ label: d.label, state: d.state, number: d.numberMasked, expiryDate: d.expiryDate })),
  };
}

/* ------------------------------------------------------------------ lists */

export async function drugMasterStats(actor: HealthActor): Promise<{ drugs: number; active: number; prohibitedTele: number; icd10: number }> {
  requireStaff(actor);
  const [d] = await db
    .select({ n: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where ${healthDrugMaster.status} = 'ACTIVE')::int`, prohibited: sql<number>`count(*) filter (where ${healthDrugMaster.teleList} = 'PROHIBITED')::int` })
    .from(healthDrugMaster);
  const [i] = await db.select({ n: sql<number>`count(*)::int` }).from(healthIcd10);
  return { drugs: Number(d?.n ?? 0), active: Number(d?.active ?? 0), prohibitedTele: Number(d?.prohibited ?? 0), icd10: Number(i?.n ?? 0) };
}

/** Home-care categories (consultant categories in the "Home care" group, plus physiotherapists). */
export async function careCategories(actor: HealthActor): Promise<{ id: string; name: string; groupName: string; requiredDoc: string; status: string; providers: number }[]> {
  requireStaff(actor);
  const rows = await db
    .select({ id: consultCategories.id, name: consultCategories.name, groupName: consultCategories.groupName, requiredDoc: consultCategories.requiredDoc, status: consultCategories.status, providers: sql<number>`(select count(*)::int from consult_member_categories mc where mc.category_id = ${consultCategories.id})` })
    .from(consultCategories)
    .where(or(eq(consultCategories.groupName, CARE_CATEGORY_GROUP), inArray(consultCategories.slug, [...EXTRA_CARE_CATEGORY_SLUGS])))
    .orderBy(asc(consultCategories.sortOrder), asc(consultCategories.name));
  return rows.map((r) => ({ ...r, providers: Number(r.providers) }));
}

export interface HealthSpecialtyRow {
  id: string;
  name: string;
  slug: string;
  groupName: string;
  requiredDoc: string;
  requiredDocLabel: string | null;
  status: string;
  /** Listed on "Find a doctor" (needs a medical registration and is ACTIVE). */
  inDoctorSearch: boolean;
  /** Doctors / providers who offer it. */
  providers: number;
}

export interface HealthSpecialtyGroupView {
  key: string;
  name: string;
  short: string;
  /** Bookable specialties (consultant categories): what "Find a doctor" and bookings use. */
  specialties: HealthSpecialtyRow[];
  /** The same group in the registration list (shop categories), with how many shops chose each. */
  shopCategories: { id: string; name: string; status: string; shops: number }[];
}

/**
 * Health → Specialties (owner, 21-Nov-2026): every medical practitioner by Health group — the consultant
 * categories ("Find a doctor", bookings) and the shop categories (registration) side by side. Read-only:
 * names, commission and new specialties are edited in Consultants → Categories and Shop categories.
 */
export async function healthSpecialties(actor: HealthActor): Promise<HealthSpecialtyGroupView[]> {
  requireStaff(actor);
  const healthLike = `${HEALTH_GROUP_PREFIX}%`;
  const [consult, shopCats] = await Promise.all([
    db
      .select({
        id: consultCategories.id,
        name: consultCategories.name,
        slug: consultCategories.slug,
        groupName: consultCategories.groupName,
        requiredDoc: consultCategories.requiredDoc,
        requiredDocLabel: consultCategories.requiredDocLabel,
        status: consultCategories.status,
        providers: sql<number>`(select count(*)::int from consult_member_categories mc where mc.category_id = ${consultCategories.id})`,
      })
      .from(consultCategories)
      .where(or(sql`${consultCategories.groupName} like ${healthLike}`, eq(consultCategories.requiredDoc, "MEDICAL_REGISTRATION"), eq(consultCategories.groupName, CARE_CATEGORY_GROUP), inArray(consultCategories.slug, [...EXTRA_CARE_CATEGORY_SLUGS])))
      .orderBy(asc(consultCategories.sortOrder), asc(consultCategories.name)),
    db
      .select({
        id: shopCategories.id,
        name: shopCategories.name,
        groupName: shopCategories.groupName,
        status: shopCategories.status,
        shops: sql<number>`(select count(*)::int from shop_category_mapping m where m.category_id = ${shopCategories.id})`,
      })
      .from(shopCategories)
      .where(sql`${shopCategories.groupName} like ${healthLike}`)
      .orderBy(asc(shopCategories.name)),
  ]);
  const care = { key: "home-care", name: CARE_CATEGORY_GROUP, short: "Home care" };
  const keyOf = (groupName: string | null) => (groupName === CARE_CATEGORY_GROUP ? care.key : healthGroupOf(groupName).key);
  return [...HEALTH_SPECIALTY_GROUPS, care, OTHER_HEALTH_GROUP]
    .map((g) => ({
      key: g.key,
      name: g.name,
      short: g.short,
      specialties: consult
        .filter((c) => keyOf(c.groupName) === g.key)
        .map((c) => ({ ...c, providers: Number(c.providers), inDoctorSearch: c.requiredDoc === "MEDICAL_REGISTRATION" && c.status === "ACTIVE" })),
      shopCategories: shopCats.filter((c) => keyOf(c.groupName) === g.key).map((c) => ({ id: c.id, name: c.name, status: c.status, shops: Number(c.shops) })),
    }))
    .filter((g) => g.specialties.length || g.shopCategories.length);
}

export const equipmentInput = z.object({
  id: z.string().uuid().nullish(),
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9-]*$/, "Lower-case letters, digits and - only.")
    .nullish(),
  category: z.string().trim().min(2).max(60).default("Mobility"),
  description: z.string().trim().max(300).nullish(),
  rxRequired: z.boolean().default(false),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
});

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export async function listEquipmentMaster(actor: HealthActor): Promise<(HealthEquipmentMaster & { listings: number })[]> {
  requireStaff(actor);
  const rows = await db
    .select({ e: healthEquipmentMaster, listings: sql<number>`(select count(*)::int from health.equipment_listings l where l.master_id = ${healthEquipmentMaster.id})` })
    .from(healthEquipmentMaster)
    .orderBy(asc(healthEquipmentMaster.category), asc(healthEquipmentMaster.sortOrder), asc(healthEquipmentMaster.name));
  return rows.map((r) => ({ ...r.e, listings: Number(r.listings) }));
}

export async function saveEquipmentMaster(raw: unknown, actor: HealthActor): Promise<HealthEquipmentMaster> {
  requireStaff(actor);
  const input = equipmentInput.parse(raw);
  const slug = input.slug || slugify(input.name);
  if (!slug) throw validationFailed("Give the item a name with letters or digits.");
  const values = { name: input.name, slug, category: input.category, description: input.description || null, rxRequired: input.rxRequired, status: input.status, sortOrder: input.sortOrder };
  try {
    let row: HealthEquipmentMaster | undefined;
    let before: HealthEquipmentMaster | undefined;
    if (input.id) {
      [before] = await db.select().from(healthEquipmentMaster).where(eq(healthEquipmentMaster.id, input.id));
      if (!before) throw notFound("Equipment item");
      [row] = await db.update(healthEquipmentMaster).set(values).where(eq(healthEquipmentMaster.id, input.id)).returning();
    } else {
      [row] = await db.insert(healthEquipmentMaster).values(values).returning();
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: HEALTH_EQUIPMENT_MASTER, entityType: "health_equipment_master", entityId: row!.id, previousValue: before ?? null, newValue: row });
    return row!;
  } catch (error) {
    const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
    if (code === "23505") throw conflict("An equipment item with that short name (slug) already exists.");
    throw error;
  }
}

/** Removes an item no store lists; one that is listed can only be switched off. */
export async function deleteEquipmentMaster(id: string, actor: HealthActor): Promise<void> {
  requireStaff(actor);
  const [row] = await db.select().from(healthEquipmentMaster).where(eq(healthEquipmentMaster.id, z.string().uuid().parse(id)));
  if (!row) throw notFound("Equipment item");
  const [used] = await db.select({ n: sql<number>`count(*)::int` }).from(healthEquipmentListings).where(eq(healthEquipmentListings.masterId, row.id));
  if (Number(used?.n ?? 0) > 0) throw conflict("Stores list this item. Switch it off (Inactive) instead of deleting it.");
  await db.delete(healthEquipmentMaster).where(eq(healthEquipmentMaster.id, row.id));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: HEALTH_EQUIPMENT_MASTER, entityType: "health_equipment_master", entityId: row.id, previousValue: row, newValue: { deleted: true } });
}

/* ------------------------------------------------------------------ settings (read-only) */

export async function healthSettingsView(actor: HealthActor): Promise<{ health: Record<string, unknown>; consultBookingEnabled: boolean; live: boolean }> {
  requireAdmin(actor);
  const health = await getRule("health");
  const consult = await getRule("consultBooking");
  return { health: health as unknown as Record<string, unknown>, consultBookingEnabled: consult.enabled, live: health.enabled && consult.enabled };
}

/* ------------------------------------------------------------------ reports (counts only) */

export const reportInput = z.object({
  granularity: z.enum(["day", "week", "month"]).default("day"),
  from: z.string().refine(isDateKey, "Use YYYY-MM-DD.").optional(),
  to: z.string().refine(isDateKey, "Use YYYY-MM-DD.").optional(),
});

export interface ReportTable {
  key: string;
  title: string;
  columns: string[];
  rows: (string | number)[][];
  note?: string;
}

export interface HealthReport {
  from: string;
  to: string;
  granularity: "day" | "week" | "month";
  tables: ReportTable[];
}

const BUCKET_FORMAT = { day: "YYYY-MM-DD", week: "YYYY-MM-DD", month: "YYYY-MM" } as const;

const rupeesOf = (paise: number) => Math.round(paise) / 100;

/** Pivots (bucket, status, n) rows into one row per period with a column per status and a total. */
function pivot(key: string, title: string, period: string, rows: { bucket: string; status: string; n: number }[], order: readonly string[], extra?: { column: string; values: Map<string, number> }): ReportTable {
  const statuses = order.filter((s) => rows.some((r) => r.status === s));
  for (const r of rows) if (!statuses.includes(r.status)) statuses.push(r.status);
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
  const out: (string | number)[][] = buckets.map((b) => {
    const cells = statuses.map((s) => Number(rows.find((r) => r.bucket === b && r.status === s)?.n ?? 0));
    const line: (string | number)[] = [b, ...cells, cells.reduce((a, c) => a + c, 0)];
    if (extra) line.push(extra.values.get(b) ?? 0);
    return line;
  });
  const columns = [period, ...statuses, "Total", ...(extra ? [extra.column] : [])];
  return { key, title, columns, rows: withTotal(out) };
}

function withTotal(rows: (string | number)[][]): (string | number)[][] {
  if (!rows.length) return rows;
  const total: (string | number)[] = ["Total"];
  for (let i = 1; i < rows[0].length; i++) total.push(Math.round(rows.reduce((a, r) => a + Number(r[i] ?? 0), 0) * 100) / 100);
  return [...rows, total];
}

/**
 * Health activity by day / week / month (IST): bookings made through Health, prescriptions issued,
 * medicine orders and rentals by status, home-care visits, Prime revenue (by month), patient referrals,
 * consents granted / withdrawn and DPDP data requests. Counts and money only — no clinical text.
 */
export async function healthReport(actor: HealthActor, raw: unknown): Promise<HealthReport> {
  requireStaff(actor);
  const f = reportInput.parse(raw ?? {});
  const g = f.granularity;
  const to = f.to ?? istDateKey(new Date());
  const from = f.from ?? addDays(to, g === "day" ? -29 : g === "week" ? -83 : -364);
  if (from > to) throw validationFailed("The start date is after the end date.");
  const a = istAt(from, 0).toISOString();
  const b = istAt(addDays(to, 1), 0).toISOString();
  const unit = sql.raw(`'${g}'`);
  const fmt = sql.raw(`'${BUCKET_FORMAT[g]}'`);
  const bucket = (col: SQL) => sql`to_char(date_trunc(${unit}, ${col} at time zone 'Asia/Kolkata'), ${fmt})`;
  const inRange = (col: SQL) => sql`${col} >= ${a}::timestamptz and ${col} < ${b}::timestamptz`;
  const period = g === "day" ? "Day" : g === "week" ? "Week from" : "Month";

  const bookings = await db.execute<{ bucket: string; n: number; completed: number; cancelled: number; no_show: number; walk_in: number }>(sql`
    select ${bucket(sql`bk.starts_at`)} as bucket, count(*)::int as n,
           count(*) filter (where bk.status = 'COMPLETED')::int as completed,
           count(*) filter (where bk.status in ('CANCELLED', 'REJECTED'))::int as cancelled,
           count(*) filter (where bk.status = 'NO_SHOW')::int as no_show,
           count(*) filter (where l.walk_in)::int as walk_in
      from health.appointment_links l join consult_bookings bk on bk.id = l.booking_id
     where ${inRange(sql`bk.starts_at`)} and bk.status <> 'EXPIRED'
     group by 1 order by 1`);
  const rx = await db.execute<{ bucket: string; issued: number; amended: number; doctors: number }>(sql`
    select ${bucket(sql`p.issued_at`)} as bucket,
           count(*) filter (where p.version = 1)::int as issued,
           count(*) filter (where p.version > 1)::int as amended,
           count(distinct p.member_id)::int as doctors
      from health.prescriptions p where ${inRange(sql`p.issued_at`)}
     group by 1 order by 1`);
  const orders = await db.execute<{ bucket: string; status: string; n: number }>(sql`
    select ${bucket(sql`o.created_at`)} as bucket, o.status, count(*)::int as n
      from health.rx_orders o where ${inRange(sql`o.created_at`)} group by 1, 2`);
  const orderValue = await db.execute<{ bucket: string; paise: number }>(sql`
    select ${bucket(sql`o.created_at`)} as bucket, coalesce(sum(o.total_paise - o.refund_paise), 0)::bigint as paise
      from health.rx_orders o where ${inRange(sql`o.created_at`)} and o.status = 'COMPLETED' group by 1`);
  const rentals = await db.execute<{ bucket: string; status: string; n: number }>(sql`
    select ${bucket(sql`r.created_at`)} as bucket, r.status, count(*)::int as n
      from health.rentals r where ${inRange(sql`r.created_at`)} group by 1, 2`);
  const visits = await db.execute<{ bucket: string; status: string; n: number }>(sql`
    select ${bucket(sql`bk.starts_at`)} as bucket, v.status, count(*)::int as n
      from health.care_visits v join consult_bookings bk on bk.id = v.booking_id
     where ${inRange(sql`bk.starts_at`)} group by 1, 2`);
  // Prime revenue is always by month (plans are monthly / quarterly / yearly).
  const ma = istAt(monthStart(from), 0).toISOString();
  const prime = await db.execute<{ bucket: string; n: number; paise: number; gst: number }>(sql`
    select to_char(date_trunc('month', coalesce(s.starts_at, s.created_at) at time zone 'Asia/Kolkata'), 'YYYY-MM') as bucket,
           count(*)::int as n, coalesce(sum(s.total_paise), 0)::bigint as paise, coalesce(sum(s.gst_paise), 0)::bigint as gst
      from health.prime_subscriptions s
     where s.status in ('ACTIVE', 'GRACE', 'EXPIRED')
       and coalesce(s.starts_at, s.created_at) >= ${ma}::timestamptz and coalesce(s.starts_at, s.created_at) < ${b}::timestamptz
     group by 1 order by 1`);
  const referrals = await db.execute<{ bucket: string; status: string; n: number }>(sql`
    select ${bucket(sql`r.created_at`)} as bucket, r.status, count(*)::int as n
      from customer_referrals r where ${inRange(sql`r.created_at`)} group by 1, 2`);
  const granted = await db.execute<{ bucket: string; notice: number; sharing: number }>(sql`
    select ${bucket(sql`c.granted_at`)} as bucket,
           count(*) filter (where c.kind = 'HEALTH_NOTICE')::int as notice,
           count(*) filter (where c.kind <> 'HEALTH_NOTICE' and c.mode <> 'OFF')::int as sharing
      from health.consents c where ${inRange(sql`c.granted_at`)} group by 1`);
  const revoked = await db.execute<{ bucket: string; n: number }>(sql`
    select ${bucket(sql`c.revoked_at`)} as bucket, count(*)::int as n
      from health.consents c where c.revoked_at is not null and ${inRange(sql`c.revoked_at`)} group by 1`);
  const requests = await db.execute<{ bucket: string; exports: number; deletes: number; open: number; done: number; rejected: number }>(sql`
    select ${bucket(sql`d.created_at`)} as bucket,
           count(*) filter (where d.kind = 'EXPORT')::int as exports,
           count(*) filter (where d.kind = 'DELETE')::int as deletes,
           count(*) filter (where d.status = 'OPEN')::int as open,
           count(*) filter (where d.status = 'DONE')::int as done,
           count(*) filter (where d.status = 'REJECTED')::int as rejected
      from health.data_requests d where ${inRange(sql`d.created_at`)} group by 1 order by 1`);

  const consentBuckets = [...new Set([...granted.map((r) => r.bucket), ...revoked.map((r) => r.bucket)])].sort();
  const tables: ReportTable[] = [
    {
      key: "bookings",
      title: "Bookings made through Health (by appointment date)",
      columns: [period, "Bookings", "Completed", "Cancelled", "No-show", "Walk-in"],
      rows: withTotal(bookings.map((r) => [r.bucket, Number(r.n), Number(r.completed), Number(r.cancelled), Number(r.no_show), Number(r.walk_in)])),
    },
    {
      key: "prescriptions",
      title: "Prescriptions issued",
      columns: [period, "New prescriptions", "Amended versions", "Doctors"],
      rows: withTotal(rx.map((r) => [r.bucket, Number(r.issued), Number(r.amended), Number(r.doctors)])),
      note: "The Total row adds the doctors of each period.",
    },
    pivot("medicineOrders", "Medicine orders by status (by request date)", period, orders.map((r) => ({ bucket: r.bucket, status: r.status, n: Number(r.n) })), ["SENT", "QUOTED", "APPROVED", "PAID", "PACKED", "READY_FOR_PICKUP", "OUT_FOR_DELIVERY", "COMPLETED", "DECLINED", "EXPIRED", "CANCELLED"], {
      column: "Completed value (₹)",
      values: new Map(orderValue.map((r) => [r.bucket, rupeesOf(Number(r.paise))])),
    }),
    pivot("rentals", "Equipment rentals by status (by booking date)", period, rentals.map((r) => ({ bucket: r.bucket, status: r.status, n: Number(r.n) })), ["PENDING_PAYMENT", "CONFIRMED", "OUT_FOR_DELIVERY", "ACTIVE", "RETURN_SCHEDULED", "RETURNED", "CLOSED", "CANCELLED"]),
    pivot("careVisits", "Home-care visits by status (by visit date)", period, visits.map((r) => ({ bucket: r.bucket, status: r.status, n: Number(r.n) })), ["SCHEDULED", "ON_THE_WAY", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
    {
      key: "primeRevenue",
      title: "Prime revenue by month (paid plans: active, in grace or expired)",
      columns: ["Month", "Plans", "Revenue incl. GST (₹)", "GST (₹)"],
      rows: withTotal(prime.map((r) => [r.bucket, Number(r.n), rupeesOf(Number(r.paise)), rupeesOf(Number(r.gst))])),
    },
    pivot("referrals", "Patient referrals (customer referral programme)", period, referrals.map((r) => ({ bucket: r.bucket, status: r.status, n: Number(r.n) })), ["PENDING", "REWARDED", "REJECTED", "REVERSED"]),
    {
      key: "consents",
      title: "Consents",
      columns: [period, "My Health notices accepted", "Record sharing granted", "Withdrawn"],
      rows: withTotal(
        consentBuckets.map((bk) => {
          const gr = granted.find((r) => r.bucket === bk);
          return [bk, Number(gr?.notice ?? 0), Number(gr?.sharing ?? 0), Number(revoked.find((r) => r.bucket === bk)?.n ?? 0)];
        }),
      ),
    },
    {
      key: "dataRequests",
      title: "Data requests (DPDP)",
      columns: [period, "Export", "Delete", "Open", "Done", "Rejected"],
      rows: withTotal(requests.map((r) => [r.bucket, Number(r.exports), Number(r.deletes), Number(r.open), Number(r.done), Number(r.rejected)])),
    },
  ];
  return { from, to, granularity: g, tables };
}

/* ------------------------------------------------------------------ access log and audit */

export const accessLogInput = z.object({
  from: z.string().refine(isDateKey).optional(),
  to: z.string().refine(isDateKey).optional(),
  action: z.enum(ACCESS_ACTIONS).optional(),
  role: z.string().trim().max(40).optional(),
  patientId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export interface AccessLogItem {
  id: string;
  at: string;
  patientId: string;
  patient: string;
  actorRole: string;
  actorLabel: string;
  action: string;
  objectType: string;
  objectId: string | null;
  /** Admins (break-glass reviewers) see the reason; operators only that one was given. */
  reason: string | null;
  hasReason: boolean;
}

/** Who opened which record (health.access_log). Patients appear as id + initials only. */
export async function accessLogList(actor: HealthActor, raw: unknown): Promise<{ rows: AccessLogItem[]; roles: string[] }> {
  requireStaff(actor);
  const f = accessLogInput.parse(raw ?? {});
  const conds: SQL[] = [];
  if (f.from) conds.push(gte(healthAccessLog.createdAt, istAt(f.from, 0)));
  if (f.to) conds.push(lt(healthAccessLog.createdAt, istAt(addDays(f.to, 1), 0)));
  if (f.action) conds.push(eq(healthAccessLog.action, f.action));
  if (f.role) conds.push(eq(healthAccessLog.actorRole, f.role));
  if (f.patientId) conds.push(eq(healthAccessLog.patientId, f.patientId));
  const rows = await db
    .select({ l: healthAccessLog, name: healthPatients.fullName })
    .from(healthAccessLog)
    .innerJoin(healthPatients, eq(healthPatients.id, healthAccessLog.patientId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(healthAccessLog.createdAt))
    .limit(f.limit);
  const roles = await db.execute<{ actor_role: string }>(sql`select distinct actor_role from health.access_log order by 1 limit 50`);
  const reviewer = canBreakGlass(actor);
  return {
    rows: rows.map((r) => ({
      id: r.l.id,
      at: r.l.createdAt.toISOString(),
      patientId: r.l.patientId,
      patient: initialsOf(r.name),
      actorRole: r.l.actorRole,
      actorLabel: r.l.actorLabel,
      action: r.l.action,
      objectType: r.l.objectType,
      objectId: r.l.objectId,
      reason: reviewer ? r.l.reason : null,
      hasReason: Boolean(r.l.reason),
    })),
    roles: roles.map((r) => r.actor_role),
  };
}

export interface HealthAuditItem {
  id: string;
  at: string;
  action: string;
  actor: string;
  actorRole: string | null;
  entityType: string;
  entityId: string | null;
  change: string;
}

/** Recent audit rows of the health area (action "health.…"). Audit rows never carry clinical text. */
export async function healthAuditList(actor: HealthActor, raw: unknown): Promise<HealthAuditItem[]> {
  requireStaff(actor);
  const f = accessLogInput.pick({ from: true, to: true, limit: true }).parse(raw ?? {});
  const conds: SQL[] = [sql`${auditLogs.action} like 'health.%'`];
  if (f.from) conds.push(gte(auditLogs.createdAt, istAt(f.from, 0)));
  if (f.to) conds.push(lt(auditLogs.createdAt, istAt(addDays(f.to, 1), 0)));
  const rows = await db
    .select({ a: auditLogs, name: users.name, email: users.email })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt))
    .limit(f.limit);
  return rows.map((r) => ({
    id: r.a.id,
    at: r.a.createdAt.toISOString(),
    action: r.a.action,
    // A customer acting on their own record is a patient: initials only, like everywhere else here.
    actor: !r.a.actorId ? "System" : r.a.actorRole === "CUSTOMER" ? `${initialsOf(r.name)} (customer ${r.a.actorId.slice(0, 8)})` : r.name || r.email || r.a.actorId.slice(0, 8),
    actorRole: r.a.actorRole,
    entityType: r.a.entityType,
    entityId: r.a.entityId,
    change: r.a.newValue == null ? "" : JSON.stringify(r.a.newValue).slice(0, 240),
  }));
}

/* ------------------------------------------------------------------ break-glass */

async function requireBreakGlass(actor: HealthActor): Promise<void> {
  if (!canBreakGlass(actor)) throw forbidden("Only GoKesari administrators can open a health record in an emergency.");
  if (!(await getRule("health")).breakGlassEnabled) throw forbidden("Emergency access is switched off (rule health → breakGlassEnabled).");
}

/**
 * Finds the patients to open: a patient id, or the account's e-mail / mobile number (then every patient
 * the account manages). Returns ids, relation and initials only — nothing of the record.
 */
export async function breakGlassFind(raw: unknown, actor: HealthActor): Promise<{ id: string; initials: string; relation: string; birthYear: string | null }[]> {
  await requireBreakGlass(actor);
  const q = z.object({ q: z.string().trim().min(3).max(120) }).parse(raw).q;
  let rows: HealthPatient[];
  if (z.string().uuid().safeParse(q).success) {
    rows = await db.select().from(healthPatients).where(and(eq(healthPatients.id, q), isNull(healthPatients.hiddenAt)));
  } else {
    const digits = q.replace(/\D/g, "").slice(-10);
    const [u] = q.includes("@")
      ? await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${q.toLowerCase()}`)
      : digits.length === 10
        ? await db.select({ id: users.id }).from(users).where(or(eq(users.phone, digits), eq(users.phoneE164, `+91${digits}`)))
        : [];
    if (!u) return [];
    rows = await db.select().from(healthPatients).where(and(eq(healthPatients.accountUserId, u.id), isNull(healthPatients.hiddenAt))).orderBy(asc(healthPatients.createdAt));
  }
  return rows.map((p) => ({ id: p.id, initials: initialsOf(p.fullName), relation: p.relation, birthYear: p.dateOfBirth?.slice(0, 4) ?? null }));
}

export const breakGlassInput = z.object({
  patientId: z.string().uuid(),
  reason: z.string().trim().min(20, "Give the emergency reason (at least 20 characters).").max(500),
});

export interface BreakGlassView {
  accessLogId: string;
  openedAt: string;
  /** The screen closes the record at this time; opening it again is a new, logged open. */
  expiresAt: string;
  patient: {
    id: string;
    fullName: string;
    relation: string;
    dateOfBirth: string | null;
    gender: string | null;
    bloodGroup: string | null;
    allergies: string[];
    conditions: string[];
    currentMedicines: string | null;
    emergencyName: string | null;
    emergencyPhone: string | null;
    emergencyRelation: string | null;
  };
  timeline: { id: string; at: string; kind: string; title: string; summary: string | null; provider: string | null }[];
  prescriptions: { id: string; rxNumber: string; version: number; status: string; issuedAt: string; doctor: string; clinic: string; items: { name: string; dose: string; frequency: string; durationDays: number }[] }[];
}

export const BREAK_GLASS_MINUTES = 30;

/**
 * Emergency read-only view of one patient's record (admins with health:break_glass, rule
 * health.breakGlassEnabled). Each open is written to the patient's access log (action BREAK_GLASS, with
 * the reason) BEFORE anything is read — if that write fails, nothing is shown — then audited, and the
 * account holder (and a linked adult) is told at once (mandatory notice).
 */
export async function breakGlassOpen(patientId: string, reason: string, actor: HealthActor, ip?: string | null, now: Date = new Date()): Promise<BreakGlassView> {
  await requireBreakGlass(actor);
  const input = breakGlassInput.parse({ patientId, reason });
  const [p] = await db.select().from(healthPatients).where(eq(healthPatients.id, input.patientId));
  if (!p || p.hiddenAt) throw notFound("Patient");
  const [log] = await db
    .insert(healthAccessLog)
    .values({ patientId: p.id, actorUserId: actor.id, actorRole: actor.role, actorLabel: "GoKesari staff (emergency access)", action: "BREAK_GLASS", objectType: "patient", objectId: p.id, reason: input.reason, ipAddress: ip ?? null, createdAt: now })
    .returning({ id: healthAccessLog.id });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_BREAK_GLASS, entityType: "health_patient", entityId: p.id, newValue: { accessLogId: log.id, reasonChars: input.reason.length }, ipAddress: ip ?? null });

  const timeline = await timelineFor(p.id, { limit: 300 });
  const rxRows = await db
    .select({ id: healthPrescriptions.id, rxNumber: healthPrescriptions.rxNumber, version: healthPrescriptions.version, status: healthPrescriptions.status, issuedAt: healthPrescriptions.issuedAt, content: healthPrescriptions.content })
    .from(healthPrescriptions)
    .where(eq(healthPrescriptions.patientId, p.id))
    .orderBy(desc(healthPrescriptions.issuedAt))
    .limit(100);
  const items = rxRows.length
    ? await db
        .select({ prescriptionId: healthPrescriptionItems.prescriptionId, lineNo: healthPrescriptionItems.lineNo, genericName: healthPrescriptionItems.genericName, brandName: healthPrescriptionItems.brandName, strength: healthPrescriptionItems.strength, dose: healthPrescriptionItems.dose, frequency: healthPrescriptionItems.frequency, durationDays: healthPrescriptionItems.durationDays })
        .from(healthPrescriptionItems)
        .where(inArray(healthPrescriptionItems.prescriptionId, rxRows.map((r) => r.id)))
        .orderBy(asc(healthPrescriptionItems.lineNo))
    : [];

  const audience = patientAudience(p);
  const whose = p.relation === "SELF" ? "your" : `${p.fullName}'s`;
  for (const userId of audience) {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.HEALTH_BREAK_GLASS,
      title: "Emergency access to a health record",
      body: `GoKesari staff opened ${userId === p.linkedUserId && p.relation !== "SELF" ? "your" : whose} health record in an emergency. The reason is in the access log in My Health. If you did not expect this, write to the Grievance Officer from Help → Grievance.`,
      actionUrl: HEALTH_PATH,
      channels: ["PUSH"],
      mandatory: true,
      metadata: { patientId: p.id, accessLogId: log.id },
    });
  }
  await publishHealthEvent({ name: "record.accessed", userIds: audience, subjectId: p.id, payload: { patientId: p.id, action: "BREAK_GLASS" } });

  const content = (c: unknown) => (c ?? {}) as { doctor?: { name?: string }; clinic?: { name?: string } };
  return {
    accessLogId: log.id,
    openedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + BREAK_GLASS_MINUTES * 60_000).toISOString(),
    patient: {
      id: p.id,
      fullName: p.fullName,
      relation: p.relation,
      dateOfBirth: p.dateOfBirth,
      gender: p.gender,
      bloodGroup: p.bloodGroup,
      allergies: p.allergies,
      conditions: p.conditions,
      currentMedicines: p.currentMedicines,
      emergencyName: p.emergencyName,
      emergencyPhone: p.emergencyPhone,
      emergencyRelation: p.emergencyRelation,
    },
    timeline: timeline.map((t) => ({ id: t.id, at: t.occurredAt.toISOString(), kind: t.kind, title: t.title, summary: t.summary, provider: t.providerName })),
    prescriptions: rxRows.map((r) => ({
      id: r.id,
      rxNumber: r.rxNumber,
      version: r.version,
      status: r.status,
      issuedAt: r.issuedAt.toISOString(),
      doctor: content(r.content).doctor?.name ?? "—",
      clinic: content(r.content).clinic?.name ?? "—",
      items: items.filter((i) => i.prescriptionId === r.id).map((i) => ({ name: `${i.brandName ?? i.genericName}${i.strength ? ` ${i.strength}` : ""}`, dose: i.dose, frequency: i.frequency, durationDays: i.durationDays })),
    })),
  };
}

/* ------------------------------------------------------------------ DPDP data requests */

export const dataRequestFilter = z.object({
  status: z.enum(["OPEN", "DONE", "REJECTED", "ALL"]).default("OPEN"),
  kind: z.enum(["EXPORT", "DELETE"]).optional(),
});

export interface DataRequestRow {
  id: string;
  kind: string;
  status: string;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  userPhone: string | null;
  patients: number;
}

export async function listDataRequests(actor: HealthActor, raw: unknown): Promise<DataRequestRow[]> {
  requireStaff(actor);
  const f = dataRequestFilter.parse(raw ?? {});
  const conds: SQL[] = [];
  if (f.status !== "ALL") conds.push(eq(healthDataRequests.status, f.status));
  if (f.kind) conds.push(eq(healthDataRequests.kind, f.kind));
  const rows = await db
    .select({ r: healthDataRequests, name: users.name, email: users.email, phone: users.phone, patients: sql<number>`(select count(*)::int from health.patients p where p.account_user_id = ${healthDataRequests.userId})` })
    .from(healthDataRequests)
    .innerJoin(users, eq(users.id, healthDataRequests.userId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`${healthDataRequests.status} = 'OPEN' desc`, asc(healthDataRequests.createdAt))
    .limit(300);
  return rows.map((r) => ({
    id: r.r.id,
    kind: r.r.kind,
    status: r.r.status,
    note: r.r.note,
    createdAt: r.r.createdAt.toISOString(),
    completedAt: r.r.completedAt?.toISOString() ?? null,
    userId: r.r.userId,
    userName: r.name,
    userEmail: r.email,
    userPhone: r.phone,
    patients: Number(r.patients),
  }));
}

export const dataRequestDecisionInput = z.object({
  id: z.string().uuid(),
  decision: z.enum(["DONE", "REJECTED"]),
  note: z.string().trim().max(500).nullish(),
});

/**
 * Closes a DPDP request. EXPORT: the patient downloads the export themselves (My Health → Privacy,
 * GET /api/health/export); DELETE: the records were hidden when the patient asked (prescriptions and
 * consultations stay, restricted, for the legal retention period). The account holder is told.
 */
export async function decideDataRequest(raw: unknown, actor: HealthActor): Promise<{ id: string; status: string }> {
  requireStaff(actor);
  const input = dataRequestDecisionInput.parse(raw);
  const note = input.note || null;
  if (input.decision === "REJECTED" && !note) throw validationFailed("Give the reason (the account holder sees it).");
  const now = new Date();
  const [before] = await db.select().from(healthDataRequests).where(eq(healthDataRequests.id, input.id));
  if (!before) throw notFound("Data request");
  if (before.status !== "OPEN") throw conflict("This request is already closed.");
  const combined = note ? `${before.note ? `${before.note}\n` : ""}GoKesari: ${note}`.slice(0, 1000) : before.note;
  const [row] = await db
    .update(healthDataRequests)
    .set({ status: input.decision, completedAt: now, note: combined })
    .where(and(eq(healthDataRequests.id, before.id), eq(healthDataRequests.status, "OPEN")))
    .returning();
  if (!row) throw conflict("This request is already closed.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_DATA_REQUEST, entityType: "health_data_request", entityId: row.id, previousValue: { status: before.status }, newValue: { kind: row.kind, status: row.status } });
  const body =
    input.decision === "REJECTED"
      ? `We could not complete your ${row.kind === "EXPORT" ? "data download" : "deletion"} request: ${note}`
      : row.kind === "EXPORT"
        ? "Your health data is ready. Download it from My Health → Privacy → Download my data."
        : "Your My Health records are deleted from your account. Prescriptions and consultation notes are kept, locked, only for the period the law requires.";
  await notify({ userId: row.userId, type: NOTIFICATION_TYPES.HEALTH_CONSENT, title: "Your health data request", body, actionUrl: HEALTH_PATH, channels: ["PUSH"], mandatory: true, metadata: { dataRequestId: row.id, kind: row.kind, status: row.status } });
  return { id: row.id, status: row.status };
}

/* ------------------------------------------------------------------ the patient's own export */

export interface HealthExport {
  generatedAt: string;
  format: "gokesari-health-export-v1";
  accountUserId: string;
  notes: string[];
  patients: Record<string, unknown>[];
  consents: Record<string, unknown>[];
  timeline: Record<string, unknown>[];
  appointments: Record<string, unknown>[];
  consultations: Record<string, unknown>[];
  prescriptions: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  medicineOrders: Record<string, unknown>[];
  rentals: Record<string, unknown>[];
  careVisits: Record<string, unknown>[];
  accessLog: Record<string, unknown>[];
  dataRequests: Record<string, unknown>[];
}

/**
 * Everything GoKesari Health keeps for this account's patients (self, family it manages, and records
 * linked to this login), as JSON. Prescription PDFs and uploaded files are not inlined: each prescription
 * carries a download link the account holder can open while signed in. Each patient's access log records
 * the export.
 */
export async function exportAccountHealthData(userId: string, now: Date = new Date()): Promise<HealthExport> {
  const pats = await patientsForUser(userId);
  const own = await db.select().from(healthPatients).where(and(eq(healthPatients.accountUserId, userId), isNull(healthPatients.hiddenAt)));
  const patients = [...new Map([...own, ...pats].map((p) => [p.id, p])).values()];
  const ids = patients.map((p) => p.id);
  const empty: HealthExport = {
    generatedAt: now.toISOString(),
    format: "gokesari-health-export-v1",
    accountUserId: userId,
    notes: [
      "All times are UTC (ISO 8601).",
      "Prescription PDFs: open each prescription's downloadUrl while signed in to GoKesari.",
      "Uploaded reports are listed without their files; download them from My Health → Records.",
    ],
    patients: [],
    consents: [],
    timeline: [],
    appointments: [],
    consultations: [],
    prescriptions: [],
    documents: [],
    medicineOrders: [],
    rentals: [],
    careVisits: [],
    accessLog: [],
    dataRequests: [],
  };
  const requests = await db.select().from(healthDataRequests).where(eq(healthDataRequests.userId, userId)).orderBy(asc(healthDataRequests.createdAt));
  empty.dataRequests = requests.map((r) => ({ id: r.id, kind: r.kind, status: r.status, note: r.note, createdAt: r.createdAt, completedAt: r.completedAt }));
  if (!ids.length) return empty;

  const [consents, timeline, links, consultations, rx, items, documents, orders, rentals, visits, access] = await Promise.all([
    db.select().from(healthConsents).where(inArray(healthConsents.patientId, ids)).orderBy(asc(healthConsents.grantedAt)),
    db.select().from(healthTimeline).where(and(inArray(healthTimeline.patientId, ids), isNull(healthTimeline.hiddenAt))).orderBy(asc(healthTimeline.occurredAt)),
    db
      .select({ bookingId: healthAppointmentLinks.bookingId, patientId: healthAppointmentLinks.patientId, visitType: healthAppointmentLinks.visitType, reason: healthAppointmentLinks.reason, shareRecords: healthAppointmentLinks.shareRecords, walkIn: healthAppointmentLinks.walkIn, createdAt: healthAppointmentLinks.createdAt, bookingNumber: consultBookings.bookingNumber, startsAt: consultBookings.startsAt, status: consultBookings.status, mode: consultBookings.mode, service: consultBookings.serviceName, firm: shops.name })
      .from(healthAppointmentLinks)
      .innerJoin(consultBookings, eq(consultBookings.id, healthAppointmentLinks.bookingId))
      .innerJoin(shops, eq(shops.id, consultBookings.shopId))
      .where(inArray(healthAppointmentLinks.patientId, ids))
      .orderBy(asc(consultBookings.startsAt)),
    db.select().from(healthConsultations).where(inArray(healthConsultations.patientId, ids)).orderBy(asc(healthConsultations.startedAt)),
    db
      .select({ id: healthPrescriptions.id, patientId: healthPrescriptions.patientId, rxNumber: healthPrescriptions.rxNumber, version: healthPrescriptions.version, status: healthPrescriptions.status, amendReason: healthPrescriptions.amendReason, issuedAt: healthPrescriptions.issuedAt, validUntil: healthPrescriptions.validUntil, content: healthPrescriptions.content, pdfHash: healthPrescriptions.pdfHash })
      .from(healthPrescriptions)
      .where(inArray(healthPrescriptions.patientId, ids))
      .orderBy(asc(healthPrescriptions.issuedAt)),
    db.execute<Record<string, unknown>>(sql`select i.* from health.prescription_items i join health.prescriptions p on p.id = i.prescription_id where p.patient_id in ${ids} order by i.line_no`),
    db
      .select({ id: healthDocuments.id, patientId: healthDocuments.patientId, source: healthDocuments.source, kind: healthDocuments.kind, title: healthDocuments.title, documentDate: healthDocuments.documentDate, providerName: healthDocuments.providerName, fileName: healthDocuments.fileName, contentType: healthDocuments.contentType, sizeBytes: healthDocuments.sizeBytes, createdAt: healthDocuments.createdAt })
      .from(healthDocuments)
      .where(and(inArray(healthDocuments.patientId, ids), isNull(healthDocuments.hiddenAt))),
    db.select().from(healthRxOrders).where(inArray(healthRxOrders.patientId, ids)),
    db.select().from(healthRentals).where(or(inArray(healthRentals.patientId, ids), eq(healthRentals.customerId, userId))),
    db.select().from(healthCareVisits).where(inArray(healthCareVisits.patientId, ids)),
    db.select().from(healthAccessLog).where(inArray(healthAccessLog.patientId, ids)).orderBy(asc(healthAccessLog.createdAt)),
  ]);
  const strip = <T extends Record<string, unknown>>(row: T, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

  for (const p of patients) {
    await logRecordAccess({ patientId: p.id, actor: { id: userId, role: "CUSTOMER" }, actorLabel: "You (download of all data)", actorRole: "PATIENT", action: "EXPORT", objectType: "patient", objectId: p.id });
  }
  return {
    ...empty,
    patients: patients.map((p) => strip(p, ["linkCodeHash", "linkCodeExpiresAt", "linkCodeAttempts"])),
    consents: consents.map((c) => ({ ...c })),
    timeline: timeline.map((t) => ({ ...t })),
    appointments: links.map((l) => ({ ...l })),
    consultations: consultations.map((c) => ({ ...c })),
    prescriptions: rx.map((r) => {
      const c = (r.content ?? {}) as { doctor?: { name?: string; registrationNumber?: string; council?: string }; clinic?: { name?: string } };
      return {
        id: r.id,
        patientId: r.patientId,
        rxNumber: r.rxNumber,
        version: r.version,
        status: r.status,
        amendReason: r.amendReason,
        issuedAt: r.issuedAt,
        validUntil: r.validUntil,
        doctor: c.doctor?.name ?? null,
        doctorRegistration: c.doctor?.registrationNumber ? `${c.doctor.registrationNumber} (${c.doctor.council ?? ""})` : null,
        clinic: c.clinic?.name ?? null,
        pdfSha256: r.pdfHash,
        downloadUrl: prescriptionPdfPath(r.id),
        items: items.filter((i) => i.prescription_id === r.id).map((i) => strip(i, ["prescription_id"])),
      };
    }),
    documents: documents.map((d) => ({ ...d })),
    medicineOrders: orders.map((o) => strip(o, ["otpSalt", "otpAttempts"])),
    rentals: rentals.map((r) => strip(r, ["otpSalt", "otpAttempts"])),
    careVisits: visits.map((v) => strip(v, ["otpSalt", "otpAttempts", "lastLatitude", "lastLongitude"])),
    accessLog: access.map((a) => strip(a, ["ipAddress"])),
  };
}
