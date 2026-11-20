/**
 * GoKesari Health: the patient side — the My Health notice (consent), the health profile, family
 * members (dependents managed fully; adults linked only after their one-time code), privacy requests.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { BLOOD_GROUPS, GENDERS, HEALTH_NOTICE_POINTS, HEALTH_NOTICE_VERSION, RELATIONS } from "@/lib/health/constants";
import { db, type DbClient } from "@/server/db";
import { healthConsents, healthDataRequests, healthPatients, users, type HealthPatient } from "@/server/db/schema";
import { recordAudit, AUDIT_ACTIONS } from "@/server/services/audit";
import { notify, NOTIFICATION_TYPES } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { logRecordAccess, patientsForUser, requirePatientAccess, type HealthActor } from "./access";
import { publishHealthEvent } from "./events";
import { addTimeline } from "./timeline";

export const NOTICE_TEXT = HEALTH_NOTICE_POINTS.map((p) => `${p.heading}: ${p.text}`).join("\n");

/** The account holder's own patient row, or null until they accept the My Health notice. */
export async function selfPatient(userId: string, client: DbClient = db): Promise<HealthPatient | null> {
  const [p] = await client.select().from(healthPatients).where(and(eq(healthPatients.accountUserId, userId), eq(healthPatients.relation, "SELF"), isNull(healthPatients.hiddenAt)));
  return p ?? null;
}

/**
 * Accepts the My Health notice: creates the SELF patient (record start = now) and the consent record
 * with the exact text and an IST-displayable timestamp. Idempotent.
 */
export async function acceptHealthNotice(actor: HealthActor, now: Date = new Date()): Promise<HealthPatient> {
  return db.transaction(async (tx) => {
    const existing = await selfPatient(actor.id, tx);
    if (existing) return existing;
    const [u] = await tx.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));
    const [p] = await tx
      .insert(healthPatients)
      .values({ accountUserId: actor.id, linkedUserId: actor.id, relation: "SELF", fullName: u?.name?.trim() || "Me", email: u?.email ?? null, phone: u?.phone ?? null, recordStartAt: now })
      .returning();
    await tx.insert(healthConsents).values({ patientId: p.id, kind: "HEALTH_NOTICE", mode: "ALWAYS", version: HEALTH_NOTICE_VERSION, textSnapshot: NOTICE_TEXT, grantedBy: actor.id, grantedAt: now });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_CONSENT_CHANGED, entityType: "health_patient", entityId: p.id, newValue: { kind: "HEALTH_NOTICE", version: HEALTH_NOTICE_VERSION } }, tx);
    await addTimeline(tx, { patientId: p.id, occurredAt: now, kind: "PROFILE", title: "My Health record started", summary: "You accepted the My Health notice. Your record covers every GoKesari visit from today.", refType: "patient", refId: p.id });
    return p;
  });
}

/** True once the actor has accepted the notice (they may still manage family records only after it). */
export async function requireNoticeAccepted(actor: HealthActor): Promise<HealthPatient> {
  const p = await selfPatient(actor.id);
  if (!p) throw forbidden("Please read and accept the My Health notice first.");
  return p;
}

/* ------------------------------------------------------------ profile */

const listOf = z
  .array(z.string().trim().min(1).max(80))
  .max(30)
  .transform((v) => [...new Set(v)]);

export const profileInput = z.object({
  fullName: z.string().trim().min(2, "Enter the name.").max(120),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date of birth.")
    .nullish(),
  gender: z.enum(GENDERS).nullish(),
  bloodGroup: z.enum(BLOOD_GROUPS).nullish(),
  allergies: listOf.optional(),
  conditions: listOf.optional(),
  currentMedicines: z.string().trim().max(1000).nullish(),
  emergencyName: z.string().trim().max(120).nullish(),
  emergencyPhone: z.string().trim().max(20).nullish(),
  emergencyRelation: z.string().trim().max(60).nullish(),
  abhaNumber: z
    .string()
    .trim()
    .regex(/^(\d{2}-?\d{4}-?\d{4}-?\d{4})?$/, "ABHA number: 14 digits.")
    .nullish(),
});
export type ProfileInput = z.input<typeof profileInput>;

export async function updatePatientProfile(patientId: string, raw: unknown, actor: HealthActor): Promise<HealthPatient> {
  const input = profileInput.parse(raw);
  const p = await requirePatientAccess(patientId, actor);
  if (input.dateOfBirth && input.dateOfBirth > new Date().toISOString().slice(0, 10)) throw validationFailed("The date of birth cannot be in the future.", { fields: { dateOfBirth: "In the future." } });
  const [u] = await db
    .update(healthPatients)
    .set({
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth ?? null,
      gender: input.gender ?? null,
      bloodGroup: input.bloodGroup ?? null,
      allergies: input.allergies ?? p.allergies,
      conditions: input.conditions ?? p.conditions,
      currentMedicines: input.currentMedicines ?? null,
      emergencyName: input.emergencyName ?? null,
      emergencyPhone: input.emergencyPhone ?? null,
      emergencyRelation: input.emergencyRelation ?? null,
      abhaNumber: input.abhaNumber ? input.abhaNumber.replace(/-/g, "") : null,
      updatedAt: new Date(),
    })
    .where(eq(healthPatients.id, p.id))
    .returning();
  await logRecordAccess({ patientId: p.id, actor, actorLabel: actor.id === p.accountUserId ? "You" : (actor.name ?? "Family member"), action: "UPDATE", objectType: "profile", objectId: p.id });
  return u;
}

/* ------------------------------------------------------------ family */

export const familyInput = z.object({
  fullName: z.string().trim().min(2, "Enter the name.").max(120),
  relation: z.enum(RELATIONS).refine((r) => r !== "SELF", "Choose how they are related to you."),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  gender: z.enum(GENDERS).nullish(),
  /** true: a child or an elderly parent you manage fully. false: an adult who must approve with a code. */
  dependent: z.boolean(),
  phone: z.string().trim().max(20).nullish(),
  email: z.string().trim().email().max(200).nullish().or(z.literal("")),
});

function ageOn(dob: string, now: Date): number {
  const d = new Date(`${dob}T00:00:00Z`);
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

function codeHash(patientId: string, code: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET).update(`health-family:${patientId}:${code}`).digest("base64url");
}

/** Adds a family member. Dependents are active at once; an adult gets a one-time code to approve the link. */
export async function addFamilyMember(raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<{ patient: HealthPatient; codeSentTo: string | null; devCode?: string }> {
  const input = familyInput.parse(raw);
  await requireNoticeAccepted(actor);
  const minor = input.dateOfBirth ? ageOn(input.dateOfBirth, now) < 18 : input.relation === "CHILD";
  const dependent = input.dependent || minor;
  if (!dependent && !input.phone && !input.email) throw validationFailed("Enter their mobile number or e-mail so they can approve with a one-time code.", { fields: { phone: "Needed for an adult." } });
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(healthPatients).where(and(eq(healthPatients.accountUserId, actor.id), isNull(healthPatients.hiddenAt)));
  if (n >= 20) throw conflict("You can manage at most 20 family records.");
  // A linked adult with a GoKesari account can also open the record from their own account.
  let linkedUserId: string | null = null;
  if (!dependent) {
    const phone = input.phone?.replace(/\D/g, "").slice(-10) || null;
    const email = input.email?.toLowerCase() || null;
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(or(email ? eq(sql`lower(${users.email})`, email) : sql`false`, phone ? sql`right(regexp_replace(coalesce(${users.phone}, ''), '\\D', '', 'g'), 10) = ${phone}` : sql`false`))
      .limit(1);
    linkedUserId = u?.id && u.id !== actor.id ? u.id : null;
  }
  const code = String(randomInt(100000, 1000000));
  const rule = await getRule("health");
  const [p] = await db
    .insert(healthPatients)
    .values({
      accountUserId: actor.id,
      linkedUserId,
      relation: input.relation,
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth ?? null,
      gender: input.gender ?? null,
      phone: input.phone ?? null,
      email: input.email || null,
      recordStartAt: now,
      linkStatus: dependent ? "ACTIVE" : "PENDING_APPROVAL",
      linkCodeHash: dependent ? null : null,
      linkCodeExpiresAt: null,
    })
    .returning();
  let sentTo: string | null = null;
  if (!dependent) {
    await db
      .update(healthPatients)
      .set({ linkCodeHash: codeHash(p.id, code), linkCodeExpiresAt: new Date(now.getTime() + rule.familyLinkCodeMinutes * 60_000), linkCodeAttempts: 0 })
      .where(eq(healthPatients.id, p.id));
    sentTo = await sendFamilyCode(p, code, actor);
  }
  await addTimeline(db, { patientId: p.id, occurredAt: now, kind: "PROFILE", title: "Health record started", summary: `Added by ${actor.name ?? "the account holder"} as ${input.relation.toLowerCase()}.`, refType: "patient", refId: p.id });
  const devCode = getEnv().NODE_ENV === "test" && !dependent ? code : undefined;
  return { patient: (await requirePatientAccess(p.id, actor)) ?? p, codeSentTo: sentTo, devCode };
}

async function sendFamilyCode(p: HealthPatient, code: string, actor: HealthActor): Promise<string | null> {
  const text = `${actor.name ?? "A GoKesari user"} wants to keep your health record in their GoKesari family account. To approve, tell them this code: ${code}. It expires in a few minutes. Ignore this if you do not agree.`;
  // Each channel on its own: SMS not set up on a server must not stop the e-mail.
  if (p.phone) {
    try {
      const { sendText } = await import("@/server/messaging/sms-whatsapp");
      await sendText("SMS", p.phone, text, "health-family-link");
    } catch (error) {
      console.error("[health] family code SMS failed", error instanceof Error ? error.message : error);
    }
  }
  if (p.email) {
    try {
      const { sendEmail } = await import("@/server/email/transport");
      await sendEmail({ to: p.email, subject: "Approve a GoKesari family health record", text });
    } catch (error) {
      console.error("[health] family code e-mail failed", error instanceof Error ? error.message : error);
    }
  }
  if (p.linkedUserId) {
    await notify({ userId: p.linkedUserId, type: NOTIFICATION_TYPES.HEALTH_FAMILY_LINK, title: "Approve a family health record", body: `${actor.name ?? "A GoKesari user"} asked to keep your health record. Your code was sent by SMS / e-mail.`, actionUrl: "/health" });
  }
  const masked = p.phone ? `•••••${p.phone.replace(/\D/g, "").slice(-4)}` : p.email ? p.email.replace(/^(.).*(@.*)$/, "$1•••$2") : null;
  return masked;
}

export async function resendFamilyCode(patientId: string, actor: HealthActor, now: Date = new Date()): Promise<{ codeSentTo: string | null; devCode?: string }> {
  const [p] = await db.select().from(healthPatients).where(and(eq(healthPatients.id, patientId), eq(healthPatients.accountUserId, actor.id)));
  if (!p) throw notFound("Family member");
  if (p.linkStatus !== "PENDING_APPROVAL") throw conflict("This family member is already linked.");
  const rule = await getRule("health");
  const code = String(randomInt(100000, 1000000));
  await db.update(healthPatients).set({ linkCodeHash: codeHash(p.id, code), linkCodeExpiresAt: new Date(now.getTime() + rule.familyLinkCodeMinutes * 60_000), linkCodeAttempts: 0, updatedAt: now }).where(eq(healthPatients.id, p.id));
  return { codeSentTo: await sendFamilyCode(p, code, actor), devCode: getEnv().NODE_ENV === "test" ? code : undefined };
}

/** The account holder enters the code the adult family member received: the link becomes active. */
export async function confirmFamilyLink(patientId: string, code: string, actor: HealthActor, now: Date = new Date()): Promise<HealthPatient> {
  const [p] = await db.select().from(healthPatients).where(and(eq(healthPatients.id, patientId), eq(healthPatients.accountUserId, actor.id)));
  if (!p) throw notFound("Family member");
  if (p.linkStatus === "ACTIVE") return p;
  if (p.linkStatus !== "PENDING_APPROVAL" || !p.linkCodeHash) throw conflict("Send a new code first.");
  if (p.linkCodeAttempts >= 5) throw conflict("Too many wrong codes. Send a new code.");
  if (!p.linkCodeExpiresAt || p.linkCodeExpiresAt.getTime() < now.getTime()) throw conflict("The code has expired. Send a new code.");
  const want = Buffer.from(p.linkCodeHash);
  const got = Buffer.from(codeHash(p.id, code.trim()));
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    await db.update(healthPatients).set({ linkCodeAttempts: p.linkCodeAttempts + 1 }).where(eq(healthPatients.id, p.id));
    throw validationFailed("That code is not right.", { fields: { code: "Wrong code." } });
  }
  const [u] = await db.update(healthPatients).set({ linkStatus: "ACTIVE", linkCodeHash: null, linkCodeExpiresAt: null, updatedAt: now }).where(eq(healthPatients.id, p.id)).returning();
  await db.insert(healthConsents).values({ patientId: p.id, kind: "FAMILY_LINK", mode: "ALWAYS", version: HEALTH_NOTICE_VERSION, textSnapshot: `Approved by one-time code: ${actor.name ?? "the account holder"} keeps this health record.`, grantedBy: actor.id, grantedAt: now });
  await publishHealthEvent({ name: "consent.granted", userIds: [actor.id, p.linkedUserId], subjectId: p.id, payload: { kind: "FAMILY_LINK" } });
  return u;
}

/** Removes a family record from the account (hidden, retained for the legal period). */
export async function removeFamilyMember(patientId: string, actor: HealthActor, now: Date = new Date()): Promise<void> {
  const [p] = await db.select().from(healthPatients).where(and(eq(healthPatients.id, patientId), eq(healthPatients.accountUserId, actor.id)));
  if (!p) throw notFound("Family member");
  if (p.relation === "SELF") throw conflict("Use 'Delete my account' to remove your own record.");
  await db.update(healthPatients).set({ linkStatus: "REMOVED", hiddenAt: now, updatedAt: now }).where(eq(healthPatients.id, p.id));
}

export async function listFamily(actor: HealthActor): Promise<HealthPatient[]> {
  const own = await db.select().from(healthPatients).where(and(eq(healthPatients.accountUserId, actor.id), isNull(healthPatients.hiddenAt)));
  const linked = await patientsForUser(actor.id);
  const map = new Map<string, HealthPatient>();
  for (const p of [...own, ...linked]) map.set(p.id, p);
  return [...map.values()].sort((a, b) => (a.relation === "SELF" ? -1 : b.relation === "SELF" ? 1 : a.createdAt.getTime() - b.createdAt.getTime()));
}

/* ------------------------------------------------------------ data requests (DPDP) */

export async function requestDataAction(kind: "EXPORT" | "DELETE", actor: HealthActor, note: string | null, now: Date = new Date()): Promise<{ id: string }> {
  await requireNoticeAccepted(actor);
  const [open] = await db
    .select({ id: healthDataRequests.id })
    .from(healthDataRequests)
    .where(and(eq(healthDataRequests.userId, actor.id), eq(healthDataRequests.kind, kind), eq(healthDataRequests.status, "OPEN")));
  if (open) return open;
  const [row] = await db.insert(healthDataRequests).values({ userId: actor.id, kind, note: note?.slice(0, 500) ?? null, createdAt: now }).returning({ id: healthDataRequests.id });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_DATA_REQUEST, entityType: "health_data_request", entityId: row.id, newValue: { kind } });
  if (kind === "DELETE") {
    // Deletion: every record of this account is hidden from the patient views at once; prescriptions,
    // consultations and notes stay (restricted) for the legal retention period. Staff close the request.
    await db.update(healthPatients).set({ hiddenAt: now, updatedAt: now }).where(eq(healthPatients.accountUserId, actor.id));
  }
  return row;
}
