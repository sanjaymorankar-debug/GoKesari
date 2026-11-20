/**
 * GoKesari Health: doctor onboarding on top of the consultant profile. A doctor registers through the
 * existing shop / consultant registration (fee, PAN/GST, referral code), joins a doctor category, uploads
 * the council certificate (consult setup) and here adds what a prescription needs: full name as
 * registered, qualifications, specialties, council, registration number and year, signature and stamp.
 * GoKesari staff verify the certificate and the practice; unverified doctors can set up but cannot be
 * booked through Health or issue prescriptions.
 */
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { MEDICAL_COUNCILS, PRACTITIONER_TYPES } from "@/lib/health/constants";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { requireFirmAccess } from "@/server/consult/access";
import { db } from "@/server/db";
import { consultMembers, healthClinicSettings, healthDoctorProfiles, shops, type HealthClinicSettings, type HealthDoctorProfile } from "@/server/db/schema";
import { recordAudit, AUDIT_ACTIONS } from "@/server/services/audit";
import { doctorStatus, ownDoctorMembers, type HealthActor } from "./access";
import { publishHealthEvent } from "./events";

export const doctorProfileInput = z.object({
  practitionerType: z.enum(PRACTITIONER_TYPES).default("DOCTOR"),
  fullName: z.string().trim().min(3, "Enter the name exactly as registered.").max(120),
  qualifications: z.string().trim().min(2, "Enter the qualifications (e.g. MBBS, MD).").max(200),
  specialties: z.array(z.string().trim().min(2).max(80)).max(10).default([]),
  council: z.enum(MEDICAL_COUNCILS),
  registrationNumber: z
    .string()
    .trim()
    .min(3, "Enter the registration number.")
    .max(40)
    .regex(/^[A-Za-z0-9/\-. ]+$/, "Letters, digits, / - . only."),
  registrationYear: z.number().int().min(1940).max(new Date().getUTCFullYear()).nullish(),
  hprId: z.string().trim().max(40).nullish(),
});
export type DoctorProfileInput = z.input<typeof doctorProfileInput>;

/** Owner (or the doctor themselves) saves a member's doctor details. */
export async function saveDoctorProfile(memberId: string, raw: unknown, actor: HealthActor): Promise<HealthDoctorProfile> {
  const input = doctorProfileInput.parse(raw);
  const [m] = await db.select().from(consultMembers).where(eq(consultMembers.id, memberId));
  if (!m) throw notFound("Team member");
  if (m.userId !== actor.id) await requireFirmAccess(m.shopId, actor, "setup");
  const now = new Date();
  const values = {
    memberId: m.id,
    shopId: m.shopId,
    userId: m.userId,
    practitionerType: input.practitionerType,
    fullName: input.fullName,
    qualifications: input.qualifications,
    specialties: input.specialties,
    council: input.council,
    registrationNumber: input.registrationNumber.toUpperCase(),
    registrationYear: input.registrationYear ?? null,
    hprId: input.hprId ?? null,
    updatedAt: now,
  };
  const [row] = await db
    .insert(healthDoctorProfiles)
    .values(values)
    .onConflictDoUpdate({ target: healthDoctorProfiles.memberId, set: { ...values, memberId: undefined } as never })
    .returning();
  // Keep the consult member's registration fields (shown on the public profile) in step.
  await db
    .update(consultMembers)
    .set({ registrationNumber: values.registrationNumber, registrationBody: input.council, qualifications: input.qualifications, updatedAt: now })
    .where(eq(consultMembers.id, m.id));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_DOCTOR_PROFILE, entityType: "health_doctor_profile", entityId: row.id, newValue: { council: input.council, registrationNumber: values.registrationNumber } });
  const status = await doctorStatus(m.id);
  if (!status.verified) await publishHealthEvent({ name: "provider.verification_pending", shopId: m.shopId, subjectId: m.id, payload: { kind: "DOCTOR" } });
  return row;
}

/** Signature or stamp image: converted to a white-background JPEG and stored encrypted. */
export async function uploadDoctorImage(memberId: string, which: "signature" | "stamp", bytes: Buffer, actor: HealthActor): Promise<void> {
  const [m] = await db.select().from(consultMembers).where(eq(consultMembers.id, memberId));
  if (!m) throw notFound("Team member");
  if (m.userId !== actor.id) await requireFirmAccess(m.shopId, actor, "setup");
  const [dp] = await db.select({ id: healthDoctorProfiles.id }).from(healthDoctorProfiles).where(eq(healthDoctorProfiles.memberId, memberId));
  if (!dp) throw validationFailed("Save the doctor's registration details first.");
  if (!bytes.length || bytes.length > 3_000_000) throw validationFailed("Upload a PNG or JPEG under 3 MB.");
  const jpeg = await toJpeg(bytes, 800);
  const enc = encryptBytes(jpeg);
  await db
    .update(healthDoctorProfiles)
    .set(which === "signature" ? { signatureImage: enc, signatureType: "image/jpeg", updatedAt: new Date() } : { stampImage: enc, stampType: "image/jpeg", updatedAt: new Date() })
    .where(eq(healthDoctorProfiles.id, dp.id));
}

/** Any image → baseline RGB JPEG on white, at most maxWidth px wide (for the PDF writer). */
export async function toJpeg(bytes: Buffer, maxWidth = 2400): Promise<Buffer> {
  try {
    return await sharp(bytes, { pages: 1, limitInputPixels: 60_000_000 })
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88, progressive: false, mozjpeg: false })
      .toBuffer();
  } catch {
    throw validationFailed("That file is not an image we can read. Upload a PNG or JPEG.");
  }
}

export async function doctorImage(dp: Pick<HealthDoctorProfile, "signatureImage" | "stampImage">, which: "signature" | "stamp"): Promise<Buffer | null> {
  const enc = which === "signature" ? dp.signatureImage : dp.stampImage;
  if (!enc) return null;
  try {
    return decryptBytes(enc);
  } catch {
    return null;
  }
}

export interface DoctorSeat {
  memberId: string;
  shopId: string;
  shopName: string;
  name: string;
  isDoctor: boolean;
  verified: boolean;
  reasons: string[];
  profile: Omit<HealthDoctorProfile, "signatureImage" | "stampImage"> & { hasSignature: boolean; hasStamp: boolean } | null;
}

/** Every doctor seat the actor can run: their own member rows, and (as a clinic owner) the clinic's doctors. */
export async function doctorSeatsFor(actor: HealthActor): Promise<DoctorSeat[]> {
  const own = await ownDoctorMembers(actor);
  const owned = await db.select({ id: shops.id }).from(shops).where(eq(shops.ownerId, actor.id));
  const ownedIds = owned.map((s) => s.id);
  const clinicMembers = ownedIds.length
    ? await db.select({ memberId: consultMembers.id }).from(consultMembers).where(and(inArray(consultMembers.shopId, ownedIds), eq(consultMembers.status, "ACTIVE")))
    : [];
  const ids = [...new Set([...own.map((o) => o.memberId), ...clinicMembers.map((c) => c.memberId)])];
  if (!ids.length) return [];
  const rows = await db
    .select({ m: consultMembers, shopName: shops.name, dp: healthDoctorProfiles })
    .from(consultMembers)
    .innerJoin(shops, eq(shops.id, consultMembers.shopId))
    .leftJoin(healthDoctorProfiles, eq(healthDoctorProfiles.memberId, consultMembers.id))
    .where(inArray(consultMembers.id, ids));
  const out: DoctorSeat[] = [];
  for (const r of rows) {
    const s = await doctorStatus(r.m.id);
    if (!s.isDoctor) continue;
    // A clinic owner sees the clinic's doctors; a member sees only themselves.
    if (r.m.userId !== actor.id && !ownedIds.includes(r.m.shopId)) continue;
    const profile = r.dp ? (({ signatureImage, stampImage, ...rest }) => ({ ...rest, hasSignature: Boolean(signatureImage), hasStamp: Boolean(stampImage) }))(r.dp) : null;
    out.push({ memberId: r.m.id, shopId: r.m.shopId, shopName: r.shopName, name: r.m.name, isDoctor: s.isDoctor, verified: s.verified, reasons: s.reasons, profile });
  }
  return out.sort((a, b) => a.shopName.localeCompare(b.shopName) || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------ clinic settings */

export const clinicSettingsInput = z.object({
  tokenMode: z.boolean(),
  tokenDailyLimit: z.number().int().min(1).max(500),
  followUpDays: z.number().int().min(0).max(90),
  followUpFeeRupees: z.number().min(0).max(100_000).nullish(),
  hfrId: z.string().trim().max(40).nullish(),
});

export async function clinicSettings(shopId: string): Promise<HealthClinicSettings> {
  const [row] = await db.select().from(healthClinicSettings).where(eq(healthClinicSettings.shopId, shopId));
  return row ?? { shopId, tokenMode: false, tokenDailyLimit: 40, followUpDays: 7, followUpFeePaise: null, hfrId: null, payPerBooking: false, updatedAt: new Date(0) };
}

export async function saveClinicSettings(shopId: string, raw: unknown, actor: HealthActor): Promise<HealthClinicSettings> {
  const input = clinicSettingsInput.parse(raw);
  const access = await requireFirmAccess(shopId, actor, "setup");
  if (access.role === "ONBOARDER") throw forbidden("Only the clinic can change this.");
  const values = {
    shopId,
    tokenMode: input.tokenMode,
    tokenDailyLimit: input.tokenDailyLimit,
    followUpDays: input.followUpDays,
    followUpFeePaise: input.followUpFeeRupees == null ? null : Math.round(input.followUpFeeRupees * 100),
    hfrId: input.hfrId ?? null,
    updatedAt: new Date(),
  };
  const [row] = await db.insert(healthClinicSettings).values(values).onConflictDoUpdate({ target: healthClinicSettings.shopId, set: values }).returning();
  return row;
}
