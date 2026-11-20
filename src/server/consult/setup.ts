/**
 * Consultant appointments: a firm's booking profile, team, services, weekly
 * hours, time off and registration documents (docs/consult-booking-2026-11).
 *
 * A consultant or professional firm registers as a shop through the existing
 * flow (fee, referral, GST/PAN, payment-based auto-approval, seller
 * documents). This module adds what bookings need on top. A profile goes LIVE
 * — listed in "Find a Consultant" — once the shop is approved and it has at
 * least one member with hours, one service, and, for categories that need a
 * professional registration (medical council, Bar Council, ICAI …), each such
 * member's certificate uploaded. Staff verify the certificates; a profile with
 * none to check is verified at once (rule consultBooking.autoVerifyWithoutDocs).
 */
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { CONSULT_MODES, type ConsultDocStatus } from "@/lib/consult/constants";
import { DEFAULT_POLICY } from "@/lib/consult/policy";
import { isDateKey, istAt, parseClock } from "@/lib/consult/time";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { encryptBytes } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import {
  consultCategories,
  consultMemberCategories,
  consultMemberDocuments,
  consultMembers,
  consultPolicyTemplates,
  consultProfiles,
  consultServices,
  consultTimeOff,
  consultWeeklyHours,
  shops,
  users,
  type ConsultCategory,
  type ConsultMember,
  type ConsultProfile,
  type ConsultService,
} from "@/server/db/schema";
import { detectDocumentFile } from "@/server/services/seller-verification";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { requireConsultEnabled, requireFirmAccess, type ConsultActor } from "./access";

/* ------------------------------------------------------------------ schemas */

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const profileInput = z.object({
  kind: z.enum(["INDIVIDUAL", "FIRM"]).optional(),
  displayName: text(120).min(2, "Enter the name customers will see.").optional(),
  headline: optText(160),
  about: optText(3000),
  photoUrl: optText(500),
  addressLine: optText(300),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  policyTemplateId: z.string().uuid().nullish(),
  freeCancelHours: z.number().int().min(0).max(720).optional(),
  lateCancelRefundPct: z.number().int().min(0).max(100).optional(),
  noShowRefundPct: z.number().int().min(0).max(100).optional(),
  rescheduleMinHours: z.number().int().min(0).max(720).optional(),
  maxReschedules: z.number().int().min(0).max(10).optional(),
  policyNote: optText(500),
  manualApproval: z.boolean().optional(),
  bookingWindowDays: z.number().int().min(1).max(365).optional(),
  minNoticeMinutes: z.number().int().min(0).max(10080).optional(),
  completionOtp: z.boolean().optional(),
});
export type ProfileInput = z.input<typeof profileInput>;

export const memberInput = z.object({
  id: z.string().uuid().optional(),
  name: text(120).min(2, "Enter the consultant's name."),
  title: optText(120),
  photoUrl: optText(500),
  qualifications: optText(300),
  experienceYears: z.number().int().min(0).max(80).nullish(),
  languages: z.array(text(40).min(1)).max(12).default([]),
  bio: optText(2000),
  registrationNumber: optText(80),
  registrationBody: optText(120),
  categoryIds: z.array(z.string().uuid()).max(10).default([]),
  slotMinutes: z.number().int().min(5).max(480).default(30),
  bufferMinutes: z.number().int().min(0).max(240).default(0),
  maxPerSlot: z.number().int().min(1).max(50).default(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#c2410c"),
  /** Link the member's own GoKesari account by its e-mail, so they can run their own calendar. */
  userEmail: z.string().trim().email().nullish().or(z.literal("")),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
});
export type MemberInput = z.input<typeof memberInput>;

const rupees = z.number().min(0).max(10_000_000);

export const serviceInput = z
  .object({
    id: z.string().uuid().optional(),
    name: text(120).min(2, "Enter the service name."),
    description: optText(1000),
    categoryId: z.string().uuid().nullish(),
    durationMinutes: z.number().int().min(5).max(600),
    feeType: z.enum(["FREE", "FIXED", "DEPOSIT"]),
    feeRupees: rupees.default(0),
    depositRupees: rupees.default(0),
    modes: z.array(z.enum(CONSULT_MODES)).min(1, "Choose at least one way to meet."),
    bookingKind: z.enum(["INDIVIDUAL", "TEAM", "GROUP"]).default("INDIVIDUAL"),
    capacity: z.number().int().min(1).max(500).default(1),
    requiredMembers: z.number().int().min(1).max(20).default(1),
    memberIds: z.array(z.string().uuid()).max(50).default([]),
    payOnline: z.boolean().default(true),
    payAtVisit: z.boolean().default(true),
    gstRatePct: z.number().min(0).max(28).default(0),
    status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
    sortOrder: z.number().int().min(0).max(10_000).default(100),
  })
  .superRefine((v, ctx) => {
    if (v.feeType !== "FREE" && v.feeRupees <= 0) ctx.addIssue({ code: "custom", path: ["feeRupees"], message: "Enter the fee, or choose Free." });
    if (v.feeType === "DEPOSIT" && (v.depositRupees <= 0 || v.depositRupees >= v.feeRupees)) ctx.addIssue({ code: "custom", path: ["depositRupees"], message: "The advance must be more than ₹0 and less than the fee." });
    if (v.feeType !== "FREE" && !v.payOnline && !v.payAtVisit) ctx.addIssue({ code: "custom", path: ["payOnline"], message: "Allow paying online, at the visit, or both." });
    if (v.feeType === "DEPOSIT" && !v.payOnline) ctx.addIssue({ code: "custom", path: ["payOnline"], message: "An advance is paid online: allow online payment." });
    if (v.bookingKind === "GROUP" && v.capacity < 2) ctx.addIssue({ code: "custom", path: ["capacity"], message: "A group session needs room for at least 2 people." });
    if (v.bookingKind === "TEAM" && v.requiredMembers < 2) ctx.addIssue({ code: "custom", path: ["requiredMembers"], message: "A team appointment needs at least 2 members." });
  });
export type ServiceInput = z.input<typeof serviceInput>;

export const hoursInput = z
  .array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string(), end: z.string() }))
  .max(42)
  .transform((rows, ctx) => {
    const out: { weekday: number; startMinute: number; endMinute: number }[] = [];
    rows.forEach((r, i) => {
      const s = parseClock(r.start);
      const e = parseClock(r.end);
      if (s == null || e == null || s >= e) {
        ctx.addIssue({ code: "custom", path: [i], message: "Each session needs a start before its end (HH:MM)." });
        return;
      }
      out.push({ weekday: r.weekday, startMinute: s, endMinute: e });
    });
    for (const d of [0, 1, 2, 3, 4, 5, 6]) {
      const day = out.filter((r) => r.weekday === d).sort((a, b) => a.startMinute - b.startMinute);
      for (let i = 1; i < day.length; i++) if (day[i].startMinute < day[i - 1].endMinute) ctx.addIssue({ code: "custom", message: "Two sessions on the same day overlap." });
    }
    return out;
  });

export const timeOffInput = z.object({
  memberId: z.string().uuid().nullish(),
  kind: z.enum(["LEAVE", "HOLIDAY", "BLOCK", "EXTRA"]),
  /** Whole days (leave, holiday) as dates; blocks and extra hours with times. */
  fromDate: z.string().refine(isDateKey, "Choose the first day."),
  toDate: z.string().refine(isDateKey, "Choose the last day."),
  fromTime: z.string().nullish(),
  toTime: z.string().nullish(),
  reason: optText(200),
});

/* ------------------------------------------------------------------ helpers */

const now = () => new Date();

async function categoriesById(ids: readonly string[], client: DbClient = db): Promise<ConsultCategory[]> {
  if (!ids.length) return [];
  return client.select().from(consultCategories).where(inArray(consultCategories.id, [...ids]));
}

/** What a member must upload for their categories. */
function requiredDocFor(categories: readonly ConsultCategory[]): ConsultCategory | null {
  return categories.find((c) => c.requiredDoc !== "NONE") ?? null;
}

function nextDocStatus(current: ConsultDocStatus, needsDoc: boolean, hasDoc: boolean): ConsultDocStatus {
  if (!needsDoc) return current === "VERIFIED" ? "VERIFIED" : "NOT_REQUIRED";
  if (current === "VERIFIED" || current === "REJECTED") return current;
  return hasDoc ? "SUBMITTED" : "MISSING";
}

export async function profileForShop(shopId: string, client: DbClient = db): Promise<ConsultProfile | null> {
  const [row] = await client.select().from(consultProfiles).where(eq(consultProfiles.shopId, shopId));
  return row ?? null;
}

async function profileOrThrow(shopId: string, client: DbClient = db): Promise<ConsultProfile> {
  const p = await profileForShop(shopId, client);
  if (!p) throw notFound("Booking profile");
  return p;
}

async function memberOfShop(memberId: string, shopId: string, client: DbClient = db): Promise<ConsultMember> {
  const [m] = await client.select().from(consultMembers).where(and(eq(consultMembers.id, memberId), eq(consultMembers.shopId, shopId)));
  if (!m) throw notFound("Team member");
  return m;
}

/** Mon–Sat 10:00–13:00 and 17:00–20:00 — a starting week the consultant edits. */
const STARTER_HOURS = [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
  { weekday, startMinute: 600, endMinute: 780 },
  { weekday, startMinute: 1020, endMinute: 1200 },
]);

/* ------------------------------------------------------------------ profile */

/**
 * The firm's booking profile, made on first use with the shop's name, the
 * default policy template and the owner as its first consultant (with a
 * starter week of hours).
 */
export async function ensureProfile(shopId: string, actor: ConsultActor): Promise<ConsultProfile> {
  await requireConsultEnabled();
  await requireFirmAccess(shopId, actor, "setup");
  const existing = await profileForShop(shopId);
  if (existing) return existing;
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  const [template] = await db.select().from(consultPolicyTemplates).where(and(eq(consultPolicyTemplates.isDefault, true), eq(consultPolicyTemplates.status, "ACTIVE"))).limit(1);
  const policy = template ?? { id: null, ...DEFAULT_POLICY };
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(consultProfiles)
      .values({
        shopId,
        displayName: shop.name,
        kind: "INDIVIDUAL",
        photoUrl: shop.logoUrl ?? null,
        policyTemplateId: policy.id,
        freeCancelHours: policy.freeCancelHours,
        lateCancelRefundPct: policy.lateCancelRefundPct,
        noShowRefundPct: policy.noShowRefundPct,
        rescheduleMinHours: policy.rescheduleMinHours,
        maxReschedules: policy.maxReschedules,
        createdBy: actor.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) return (await profileForShop(shopId, tx))!;
    const [owner] = await tx
      .insert(consultMembers)
      .values({ profileId: created.id, shopId, userId: shop.ownerId, name: shop.ownerName || shop.name, isOwner: true, languages: ["English", "Hindi"], sortOrder: 0 })
      .returning();
    await tx.insert(consultWeeklyHours).values(STARTER_HOURS.map((h) => ({ ...h, memberId: owner.id })));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_CHANGED, entityType: "consult_profile", entityId: created.id, newValue: { created: true, shopId } }, tx);
    return created;
  });
}

export async function updateProfile(shopId: string, raw: unknown, actor: ConsultActor): Promise<ConsultProfile> {
  await requireConsultEnabled();
  await requireFirmAccess(shopId, actor, "setup");
  const input = profileInput.parse(raw);
  const before = await profileOrThrow(shopId);
  const patch: Partial<typeof consultProfiles.$inferInsert> = { updatedAt: now() };
  for (const key of ["kind", "displayName", "headline", "about", "photoUrl", "addressLine", "policyNote", "manualApproval", "bookingWindowDays", "minNoticeMinutes", "completionOtp"] as const) {
    if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
  }
  if (input.latitude !== undefined || input.longitude !== undefined) {
    if ((input.latitude == null) !== (input.longitude == null)) throw validationFailed("Set both the latitude and the longitude of the map pin.");
    patch.latitude = input.latitude ?? null;
    patch.longitude = input.longitude ?? null;
  }
  if (input.policyTemplateId) {
    const [t] = await db.select().from(consultPolicyTemplates).where(and(eq(consultPolicyTemplates.id, input.policyTemplateId), eq(consultPolicyTemplates.status, "ACTIVE")));
    if (!t) throw validationFailed("Choose a cancellation policy from the list.");
    Object.assign(patch, { policyTemplateId: t.id, freeCancelHours: t.freeCancelHours, lateCancelRefundPct: t.lateCancelRefundPct, noShowRefundPct: t.noShowRefundPct, rescheduleMinHours: t.rescheduleMinHours, maxReschedules: t.maxReschedules });
  } else {
    let custom = false;
    for (const key of ["freeCancelHours", "lateCancelRefundPct", "noShowRefundPct", "rescheduleMinHours", "maxReschedules"] as const) {
      if (input[key] !== undefined) {
        (patch as Record<string, unknown>)[key] = input[key];
        custom = true;
      }
    }
    if (custom) patch.policyTemplateId = null;
  }
  const [row] = await db.update(consultProfiles).set(patch).where(eq(consultProfiles.id, before.id)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_CHANGED, entityType: "consult_profile", entityId: before.id, previousValue: pick(before, Object.keys(patch)), newValue: pick(row, Object.keys(patch)) });
  return row;
}

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k !== "updatedAt").map((k) => [k, row[k]]));
}

export interface PublishProblem {
  key: string;
  message: string;
}

/** What still stops a profile from going live. */
export async function publishProblems(shopId: string, client: DbClient = db): Promise<PublishProblem[]> {
  const problems: PublishProblem[] = [];
  const [shop] = await client.select({ status: shops.status, lat: shops.latitude, lng: shops.longitude }).from(shops).where(eq(shops.id, shopId));
  const profile = await profileForShop(shopId, client);
  if (!shop || !profile) return [{ key: "profile", message: "Create the booking profile first." }];
  if (shop.status !== "APPROVED") problems.push({ key: "shop", message: "Your registration is not approved yet (pay the registration fee and finish verification)." });
  if (profile.status === "BLOCKED") problems.push({ key: "blocked", message: "GoKesari has blocked this profile. Contact support." });
  const members = await client.select().from(consultMembers).where(and(eq(consultMembers.profileId, profile.id), eq(consultMembers.status, "ACTIVE")));
  if (!members.length) problems.push({ key: "members", message: "Add at least one consultant." });
  const hours = members.length ? await client.select({ memberId: consultWeeklyHours.memberId }).from(consultWeeklyHours).where(inArray(consultWeeklyHours.memberId, members.map((m) => m.id))) : [];
  if (members.length && !hours.length) problems.push({ key: "hours", message: "Set working hours for at least one consultant." });
  const services = await client.select({ id: consultServices.id }).from(consultServices).where(and(eq(consultServices.profileId, profile.id), eq(consultServices.status, "ACTIVE")));
  if (!services.length) problems.push({ key: "services", message: "Add at least one service with its duration and fee." });
  for (const m of members) {
    if (m.docStatus === "MISSING") problems.push({ key: `doc:${m.id}`, message: `Upload ${m.name}'s professional registration certificate.` });
    if (m.docStatus === "REJECTED") problems.push({ key: `doc:${m.id}`, message: `${m.name}'s registration certificate was rejected${m.docNote ? `: ${m.docNote}` : ""}. Upload a correct one.` });
  }
  const hasPin = (profile.latitude != null && profile.longitude != null) || (shop.lat && shop.lng);
  if (!hasPin) problems.push({ key: "pin", message: "Set your office location on the map so nearby customers find you." });
  return problems;
}

export async function publishProfile(shopId: string, actor: ConsultActor): Promise<ConsultProfile> {
  await requireConsultEnabled();
  await requireFirmAccess(shopId, actor, "setup");
  const problems = await publishProblems(shopId);
  if (problems.length) throw conflict(problems.map((p) => p.message).join(" "), { problems });
  const profile = await profileOrThrow(shopId);
  const rule = await getRule("consultBooking");
  const members = await db.select({ docStatus: consultMembers.docStatus }).from(consultMembers).where(and(eq(consultMembers.profileId, profile.id), eq(consultMembers.status, "ACTIVE")));
  const docsToCheck = members.some((m) => m.docStatus === "SUBMITTED");
  const verification = profile.verification === "VERIFIED" && !docsToCheck ? "VERIFIED" : !docsToCheck && rule.autoVerifyWithoutDocs ? "VERIFIED" : profile.verification === "REJECTED" ? "PENDING" : profile.verification;
  const [row] = await db
    .update(consultProfiles)
    .set({ status: "LIVE", verification, verifiedAt: verification === "VERIFIED" && profile.verification !== "VERIFIED" ? now() : profile.verifiedAt, updatedAt: now() })
    .where(eq(consultProfiles.id, profile.id))
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_CHANGED, entityType: "consult_profile", entityId: profile.id, previousValue: { status: profile.status }, newValue: { status: "LIVE", verification } });
  return row;
}

export async function pauseProfile(shopId: string, actor: ConsultActor): Promise<ConsultProfile> {
  await requireFirmAccess(shopId, actor, "setup");
  const profile = await profileOrThrow(shopId);
  if (profile.status === "BLOCKED") throw conflict("GoKesari has blocked this profile.");
  const [row] = await db.update(consultProfiles).set({ status: "PAUSED", updatedAt: now() }).where(eq(consultProfiles.id, profile.id)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_CHANGED, entityType: "consult_profile", entityId: profile.id, previousValue: { status: profile.status }, newValue: { status: "PAUSED" } });
  return row;
}

/* ------------------------------------------------------------------ members */

export async function saveMember(shopId: string, raw: unknown, actor: ConsultActor): Promise<ConsultMember> {
  await requireConsultEnabled();
  await requireFirmAccess(shopId, actor, "setup");
  const input = memberInput.parse(raw);
  const profile = await profileOrThrow(shopId);
  const cats = await categoriesById(input.categoryIds);
  if (cats.length !== new Set(input.categoryIds).size) throw validationFailed("Choose categories from the list.");
  let userId: string | null | undefined;
  if (input.userEmail) {
    const [u] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.userEmail.toLowerCase()}`);
    if (!u) throw validationFailed("No GoKesari account uses that e-mail. Ask the team member to sign in once, then link them.");
    userId = u.id;
  } else if (input.userEmail === "") userId = null;
  const needsDoc = Boolean(requiredDocFor(cats));
  return db.transaction(async (tx) => {
    let member: ConsultMember;
    const values = {
      name: input.name,
      title: input.title,
      photoUrl: input.photoUrl,
      qualifications: input.qualifications,
      experienceYears: input.experienceYears ?? null,
      languages: [...new Set(input.languages)],
      bio: input.bio,
      registrationNumber: input.registrationNumber,
      registrationBody: input.registrationBody,
      slotMinutes: input.slotMinutes,
      bufferMinutes: input.bufferMinutes,
      maxPerSlot: input.maxPerSlot,
      color: input.color,
      status: input.status,
      sortOrder: input.sortOrder,
      ...(userId !== undefined ? { userId } : {}),
    };
    if (input.id) {
      const before = await memberOfShop(input.id, shopId, tx);
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(consultMemberDocuments).where(eq(consultMemberDocuments.memberId, before.id));
      [member] = await tx
        .update(consultMembers)
        .set({ ...values, docStatus: nextDocStatus(before.docStatus, needsDoc, n > 0), updatedAt: now() })
        .where(eq(consultMembers.id, before.id))
        .returning();
    } else {
      [member] = await tx
        .insert(consultMembers)
        .values({ ...values, profileId: profile.id, shopId, docStatus: needsDoc ? "MISSING" : "NOT_REQUIRED", userId: userId ?? null })
        .returning();
      if (profile.kind === "INDIVIDUAL") await tx.update(consultProfiles).set({ kind: "FIRM", updatedAt: now() }).where(eq(consultProfiles.id, profile.id));
    }
    await tx.delete(consultMemberCategories).where(eq(consultMemberCategories.memberId, member.id));
    if (cats.length) await tx.insert(consultMemberCategories).values(cats.map((c) => ({ memberId: member.id, categoryId: c.id })));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_CHANGED, entityType: "consult_member", entityId: member.id, newValue: { name: member.name, status: member.status, categories: cats.map((c) => c.slug) } }, tx);
    return member;
  });
}

export async function setMemberHours(shopId: string, memberId: string, raw: unknown, actor: ConsultActor): Promise<{ weekday: number; startMinute: number; endMinute: number }[]> {
  await requireConsultEnabled();
  const access = await requireFirmAccess(shopId, actor, "bookings").catch(() => requireFirmAccess(shopId, actor, "setup"));
  // A member may set their own hours; the owner, staff and the onboarding operator anyone's.
  if (!access.canSetup && access.memberId !== memberId) throw notFound("Team member");
  await memberOfShop(memberId, shopId);
  const rows = hoursInput.parse(raw);
  await db.transaction(async (tx) => {
    await tx.delete(consultWeeklyHours).where(eq(consultWeeklyHours.memberId, memberId));
    if (rows.length) await tx.insert(consultWeeklyHours).values(rows.map((r) => ({ ...r, memberId })));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_CHANGED, entityType: "consult_member", entityId: memberId, newValue: { hours: rows } }, tx);
  });
  return rows;
}

export async function addTimeOff(shopId: string, raw: unknown, actor: ConsultActor) {
  await requireConsultEnabled();
  const access = await requireFirmAccess(shopId, actor, "bookings").catch(() => requireFirmAccess(shopId, actor, "setup"));
  const input = timeOffInput.parse(raw);
  const profile = await profileOrThrow(shopId);
  if (input.memberId) await memberOfShop(input.memberId, shopId);
  if (!access.canSetup && (input.memberId !== access.memberId || input.kind === "HOLIDAY")) throw notFound("Team member");
  if (input.kind === "HOLIDAY" && input.memberId) throw validationFailed("A holiday is for the whole firm; use Leave for one person.");
  if (input.kind === "EXTRA" && !input.memberId) throw validationFailed("Choose whose extra hours these are.");
  if (input.toDate < input.fromDate) throw validationFailed("The last day is before the first day.");
  let startsAt: Date;
  let endsAt: Date;
  if (input.kind === "BLOCK" || input.kind === "EXTRA") {
    const s = parseClock(input.fromTime ?? "");
    const e = parseClock(input.toTime ?? "");
    if (s == null || e == null) throw validationFailed("Enter the start and end times (HH:MM).");
    startsAt = istAt(input.fromDate, s);
    endsAt = istAt(input.toDate, e);
  } else {
    startsAt = istAt(input.fromDate, 0);
    endsAt = istAt(input.toDate, 1440);
  }
  if (startsAt >= endsAt) throw validationFailed("The end must be after the start.");
  const [row] = await db
    .insert(consultTimeOff)
    .values({ profileId: profile.id, memberId: input.memberId ?? null, kind: input.kind, startsAt, endsAt, reason: input.reason, createdBy: actor.id })
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_CHANGED, entityType: "consult_time_off", entityId: row.id, newValue: { kind: row.kind, memberId: row.memberId, startsAt, endsAt } });
  return row;
}

export async function deleteTimeOff(shopId: string, timeOffId: string, actor: ConsultActor): Promise<void> {
  const access = await requireFirmAccess(shopId, actor, "bookings").catch(() => requireFirmAccess(shopId, actor, "setup"));
  const profile = await profileOrThrow(shopId);
  const [row] = await db.select().from(consultTimeOff).where(and(eq(consultTimeOff.id, timeOffId), eq(consultTimeOff.profileId, profile.id)));
  if (!row) throw notFound("Time off");
  if (!access.canSetup && row.memberId !== access.memberId) throw notFound("Time off");
  await db.delete(consultTimeOff).where(eq(consultTimeOff.id, row.id));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_CHANGED, entityType: "consult_time_off", entityId: row.id, previousValue: { kind: row.kind, startsAt: row.startsAt, endsAt: row.endsAt }, newValue: { deleted: true } });
}

/* --------------------------------------------------------------- documents */

export async function uploadMemberDocument(shopId: string, memberId: string, file: { name: string; bytes: Buffer }, actor: ConsultActor): Promise<{ docStatus: ConsultDocStatus }> {
  await requireConsultEnabled();
  const access = await requireFirmAccess(shopId, actor, "bookings").catch(() => requireFirmAccess(shopId, actor, "setup"));
  if (!access.canSetup && access.memberId !== memberId) throw notFound("Team member");
  const member = await memberOfShop(memberId, shopId);
  const rule = await getRule("consultBooking");
  if (!file.bytes.length) throw validationFailed("Choose the certificate file.");
  if (file.bytes.length > Math.max(rule.maxFileBytes, 5_000_000)) throw validationFailed("The file is too large (5 MB at most).");
  const contentType = detectDocumentFile(file.bytes);
  if (!contentType) throw validationFailed("Upload a PDF, JPEG, PNG or WebP file.");
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(consultMemberDocuments)
      .values({ memberId, fileName: file.name.slice(0, 120) || "certificate", contentType, sizeBytes: file.bytes.length, data: encryptBytes(file.bytes), uploadedBy: actor.id })
      .returning({ id: consultMemberDocuments.id });
    const docStatus: ConsultDocStatus = "SUBMITTED";
    await tx.update(consultMembers).set({ docStatus, docNote: null, updatedAt: now() }).where(eq(consultMembers.id, memberId));
    // A new certificate on a live, verified profile is checked again.
    await tx.update(consultProfiles).set({ verification: "PENDING", updatedAt: now() }).where(and(eq(consultProfiles.id, member.profileId), ne(consultProfiles.verification, "PENDING")));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_MEMBER_DOCUMENT, entityType: "consult_member", entityId: memberId, newValue: { documentId: doc.id, size: file.bytes.length, contentType } }, tx);
    return { docStatus };
  });
}

/* ----------------------------------------------------------------- services */

export async function saveService(shopId: string, raw: unknown, actor: ConsultActor): Promise<ConsultService> {
  await requireConsultEnabled();
  await requireFirmAccess(shopId, actor, "setup");
  const input = serviceInput.parse(raw);
  const profile = await profileOrThrow(shopId);
  if (input.categoryId) {
    const [c] = await db.select({ id: consultCategories.id }).from(consultCategories).where(eq(consultCategories.id, input.categoryId));
    if (!c) throw validationFailed("Choose a category from the list.");
  }
  if (input.memberIds.length) {
    const found = await db.select({ id: consultMembers.id }).from(consultMembers).where(and(eq(consultMembers.profileId, profile.id), inArray(consultMembers.id, input.memberIds)));
    if (found.length !== new Set(input.memberIds).size) throw validationFailed("Choose team members of this firm.");
  }
  const activeMembers = await db.select({ id: consultMembers.id }).from(consultMembers).where(and(eq(consultMembers.profileId, profile.id), eq(consultMembers.status, "ACTIVE")));
  const offering = input.memberIds.length ? input.memberIds.length : activeMembers.length;
  if (input.bookingKind === "TEAM" && offering < input.requiredMembers) throw validationFailed(`A team appointment for ${input.requiredMembers} needs at least ${input.requiredMembers} team members offering it.`);
  const values = {
    name: input.name,
    description: input.description,
    categoryId: input.categoryId ?? null,
    durationMinutes: input.durationMinutes,
    feeType: input.feeType,
    feePaise: input.feeType === "FREE" ? 0 : Math.round(input.feeRupees * 100),
    depositPaise: input.feeType === "DEPOSIT" ? Math.round(input.depositRupees * 100) : 0,
    modes: [...new Set(input.modes)],
    bookingKind: input.bookingKind,
    capacity: input.bookingKind === "GROUP" ? input.capacity : 1,
    requiredMembers: input.bookingKind === "TEAM" ? input.requiredMembers : 1,
    memberIds: [...new Set(input.memberIds)],
    payOnline: input.feeType === "FREE" ? false : input.payOnline,
    payAtVisit: input.feeType === "FREE" ? false : input.feeType === "DEPOSIT" ? true : input.payAtVisit,
    gstRateBp: Math.round(input.gstRatePct * 100),
    status: input.status,
    sortOrder: input.sortOrder,
    updatedAt: now(),
  };
  let row: ConsultService;
  if (input.id) {
    const [before] = await db.select().from(consultServices).where(and(eq(consultServices.id, input.id), eq(consultServices.profileId, profile.id)));
    if (!before) throw notFound("Service");
    [row] = await db.update(consultServices).set(values).where(eq(consultServices.id, before.id)).returning();
  } else {
    [row] = await db.insert(consultServices).values({ ...values, profileId: profile.id, shopId }).returning();
  }
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_CHANGED, entityType: "consult_service", entityId: row.id, newValue: { name: row.name, feeType: row.feeType, feePaise: row.feePaise, status: row.status } });
  return row;
}

/* -------------------------------------------------------------------- views */

export interface SetupView {
  profile: ConsultProfile;
  shop: { id: string; name: string; status: string; address: string; latitude: string | null; longitude: string | null; gstRegistered: boolean };
  members: (ConsultMember & { categoryIds: string[]; hours: { weekday: number; startMinute: number; endMinute: number }[]; documents: number; userEmail: string | null })[];
  services: ConsultService[];
  timeOff: (typeof consultTimeOff.$inferSelect)[];
  categories: ConsultCategory[];
  templates: (typeof consultPolicyTemplates.$inferSelect)[];
  problems: PublishProblem[];
}

export async function setupView(shopId: string, actor: ConsultActor): Promise<SetupView> {
  await requireFirmAccess(shopId, actor, "bookings").catch(() => requireFirmAccess(shopId, actor, "setup"));
  const profile = await profileOrThrow(shopId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  const members = await db.select().from(consultMembers).where(eq(consultMembers.profileId, profile.id)).orderBy(asc(consultMembers.sortOrder), asc(consultMembers.createdAt));
  const ids = members.map((m) => m.id);
  const [links, hours, docs, services, timeOff, categories, templates, problems] = await Promise.all([
    ids.length ? db.select().from(consultMemberCategories).where(inArray(consultMemberCategories.memberId, ids)) : [],
    ids.length ? db.select().from(consultWeeklyHours).where(inArray(consultWeeklyHours.memberId, ids)).orderBy(asc(consultWeeklyHours.weekday), asc(consultWeeklyHours.startMinute)) : [],
    ids.length ? db.select({ memberId: consultMemberDocuments.memberId, n: sql<number>`count(*)::int` }).from(consultMemberDocuments).where(inArray(consultMemberDocuments.memberId, ids)).groupBy(consultMemberDocuments.memberId) : [],
    db.select().from(consultServices).where(eq(consultServices.profileId, profile.id)).orderBy(asc(consultServices.sortOrder), asc(consultServices.createdAt)),
    db.select().from(consultTimeOff).where(and(eq(consultTimeOff.profileId, profile.id), sql`${consultTimeOff.endsAt} > now() - interval '1 day'`)).orderBy(asc(consultTimeOff.startsAt)),
    db.select().from(consultCategories).where(eq(consultCategories.status, "ACTIVE")).orderBy(asc(consultCategories.sortOrder), asc(consultCategories.name)),
    db.select().from(consultPolicyTemplates).where(eq(consultPolicyTemplates.status, "ACTIVE")).orderBy(asc(consultPolicyTemplates.name)),
    publishProblems(shopId),
  ]);
  const userIds = members.map((m) => m.userId).filter((v): v is string => Boolean(v));
  const emails = userIds.length ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, userIds)) : [];
  return {
    profile,
    shop: {
      id: shop.id,
      name: shop.name,
      status: shop.status,
      address: [shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.pincode].filter(Boolean).join(", "),
      latitude: shop.latitude,
      longitude: shop.longitude,
      gstRegistered: shop.gstRegistrationType === "REGULAR" && Boolean(shop.gstin),
    },
    members: members.map((m) => ({
      ...m,
      categoryIds: links.filter((l) => l.memberId === m.id).map((l) => l.categoryId),
      hours: hours.filter((h) => h.memberId === m.id).map((h) => ({ weekday: h.weekday, startMinute: h.startMinute, endMinute: h.endMinute })),
      documents: docs.find((d) => d.memberId === m.id)?.n ?? 0,
      userEmail: emails.find((e) => e.id === m.userId)?.email ?? null,
    })),
    services,
    timeOff,
    categories,
    templates,
    problems,
  };
}

/** Shops the actor may set up a booking profile for: own shops, or (operator-limited) shops they onboarded. */
export async function setupShopsFor(actor: ConsultActor): Promise<{ id: string; name: string; shopType: string; status: string; hasProfile: boolean }[]> {
  const rows = await db
    .select({ id: shops.id, name: shops.name, shopType: shops.shopType, status: shops.status, profileId: consultProfiles.id, ownerId: shops.ownerId, onboardedBy: shops.onboardedByUserId })
    .from(shops)
    .leftJoin(consultProfiles, eq(consultProfiles.shopId, shops.id))
    .where(and(isNull(shops.deletedAt), sql`(${shops.ownerId} = ${actor.id} OR ${shops.onboardedByUserId} = ${actor.id})`))
    .orderBy(asc(shops.name));
  return rows.map((r) => ({ id: r.id, name: r.name, shopType: r.shopType, status: r.status, hasProfile: Boolean(r.profileId) }));
}
