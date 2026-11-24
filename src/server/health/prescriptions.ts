/**
 * GoKesari Health: e-prescriptions — check, preview, issue, e-mail, verify, print, amend.
 *
 * Issue (one transaction): a unique number RX-<year>-<000001> and a verification token (QR), the frozen
 * content, the medicine lines, the doctor's suggestions, the PDF on the chosen letterhead with its
 * SHA-256, the patient's timeline (consultation, prescription, suggestions), the consultation closed.
 * After commit: the PDF is e-mailed to the account holder (and a linked adult), the patient is told
 * in-app / push / SMS / WhatsApp, the doctor's screens update live, and the booking is completed when
 * the patient's code was checked at check-in (the fee settles through the consult engine).
 * An issued version is never changed: an amendment is a new version with a reason; both are kept.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { autoQuantity, DRUG_FORMS, RX_TIMINGS, SUGGESTION_TYPES, URGENCIES } from "@/lib/health/constants";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { completeBooking, completionNeedsCode } from "@/server/consult/bookings";
import { completionCode } from "@/server/consult/otp";
import { db, type DbClient } from "@/server/db";
import {
  consultBookings,
  consultMembers,
  consultProfiles,
  healthConsultations,
  healthDoctorProfiles,
  healthDrugMaster,
  healthPatients,
  healthPrescriptionItems,
  healthPrescriptions,
  healthSuggestions,
  shops,
  type HealthConsultation,
  type HealthPatient,
  type HealthPrescription,
  type HealthPrescriptionItem,
} from "@/server/db/schema";
import { queueDocumentEmail, safeName } from "@/server/documents/email";
import { recordAudit, AUDIT_ACTIONS } from "@/server/services/audit";
import { notify, NOTIFICATION_TYPES } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { doctorLabel, logRecordAccess, patientAudience, requirePatientAccess, requireVerifiedDoctor, sameDoctorMemberIds, type HealthActor } from "./access";
import { ageText, checkedInWithCode, loadConsultationForDoctor, timelineForConsultation } from "./consultations";
import { doctorImage } from "./doctors";
import { publishHealthEvent } from "./events";
import { effectiveLetterhead, imageWithSize, letterheadImages } from "./letterheads";
import { renderRxPdf, type RxContent } from "./rx-pdf";
import { addTimeline, nextNumber } from "./timeline";

/* ------------------------------------------------------------ input */

export const itemInput = z.object({
  drugId: z.string().uuid().nullish(),
  genericName: z.string().trim().min(2, "Enter the medicine.").max(160),
  brandName: z.string().trim().max(120).nullish(),
  strength: z.string().trim().max(60).nullish(),
  form: z.enum(DRUG_FORMS).default("TABLET"),
  dose: z.string().trim().min(1, "Enter the dose.").max(60),
  frequency: z.string().trim().min(1, "Enter how often.").max(40),
  timing: z.enum(RX_TIMINGS).default("AFTER_FOOD"),
  durationDays: z.number().int().min(0).max(3650),
  quantity: z.number().int().min(1).max(10000).nullish(),
  instructions: z.string().trim().max(300).nullish(),
  instructionsLocal: z.string().trim().max(300).nullish(),
});
export type RxItemInput = z.input<typeof itemInput>;

export const suggestionInput = z.object({
  type: z.enum(SUGGESTION_TYPES),
  urgency: z.enum(URGENCIES).default("ROUTINE"),
  printOnRx: z.boolean().default(true),
  /** DOCTOR_REFERRAL: specialty (category slug) and / or a specific doctor; note for the referred doctor. */
  specialty: z.string().trim().max(80).nullish(),
  targetMemberId: z.string().uuid().nullish(),
  note: z.string().trim().max(1000).nullish(),
  /** CARE_STAFF: category slug (home-nurse, physiotherapist …), service, frequency, duration, start. */
  careCategory: z.string().trim().max(80).nullish(),
  serviceType: z.string().trim().max(120).nullish(),
  frequency: z.string().trim().max(80).nullish(),
  durationDays: z.number().int().min(1).max(365).nullish(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  /** EQUIPMENT: master slug / name, buy or rent, rental days. */
  equipment: z.string().trim().max(120).nullish(),
  buyOrRent: z.enum(["BUY", "RENT"]).nullish(),
  /** LAB_TEST: tests and whether home collection is fine. */
  tests: z.array(z.string().trim().min(2).max(120)).max(30).nullish(),
  homeCollection: z.boolean().nullish(),
  /** FOLLOW_UP: date. */
  followUpDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
});
export type SuggestionInput = z.input<typeof suggestionInput>;

export const issueInput = z.object({
  items: z.array(itemInput).max(40),
  suggestions: z.array(suggestionInput).max(20).default([]),
  /** The doctor saw the warnings (allergy, duplicate) and still prescribes. */
  acknowledgeWarnings: z.boolean().default(false),
});

export interface RxWarning {
  line: number;
  kind: "ALLERGY" | "DUPLICATE" | "TELE_LIST_B" | "NOT_IN_MASTER";
  message: string;
}

/* ------------------------------------------------------------ checks */

/** Schedule X and NDPS medicines: never prescribed by video / phone, whatever the tele list says. */
const REMOTE_BLOCKED_SCHEDULES = new Set(["X", "NDPS"]);
const TELE_RANK: Record<string, number> = { O: 0, A: 1, B: 2, PROHIBITED: 3 };

type MasterMatch = { teleList: string; schedule: string; genericName: string };

/**
 * Hand-typed medicines (no drug-master link) matched to the master by generic or brand name, case-insensitive.
 * Several matches (strengths, brands) → the strictest teleconsultation list and schedule win.
 */
async function matchFreeText(names: string[], client: DbClient): Promise<Map<string, MasterMatch>> {
  const keys = [...new Set(names.map((n) => n.toLowerCase().trim()).filter((n) => n.length >= 3))];
  const out = new Map<string, MasterMatch>();
  if (!keys.length) return out;
  const rows = await client
    .select({ genericName: healthDrugMaster.genericName, brandName: healthDrugMaster.brandName, teleList: healthDrugMaster.teleList, schedule: healthDrugMaster.schedule })
    .from(healthDrugMaster)
    .where(and(eq(healthDrugMaster.status, "ACTIVE"), sql`(lower(${healthDrugMaster.genericName}) in ${keys} or lower(coalesce(${healthDrugMaster.brandName}, '')) in ${keys})`));
  for (const r of rows) {
    for (const k of [r.genericName.toLowerCase(), (r.brandName ?? "").toLowerCase()]) {
      if (!keys.includes(k)) continue;
      const prev = out.get(k);
      if (!prev) {
        out.set(k, { teleList: r.teleList, schedule: r.schedule, genericName: r.genericName });
        continue;
      }
      if ((TELE_RANK[r.teleList] ?? 3) > (TELE_RANK[prev.teleList] ?? 3)) prev.teleList = r.teleList;
      if (REMOTE_BLOCKED_SCHEDULES.has(r.schedule)) prev.schedule = r.schedule;
    }
  }
  return out;
}

/**
 * Telemedicine Practice Guidelines 2020 (drug master tele_list): by video / phone a PROHIBITED medicine — and any
 * Schedule X or NDPS medicine — is refused; a List B medicine is allowed only as a follow-up of an in-person
 * consultation by this doctor. A hand-typed medicine is matched to the master by name and checked the same way;
 * one that matches nothing is refused remotely (rule health.remoteFreeTextMedicines = REFUSE) or left as a warning
 * (WARN). Allergies and duplicates are warnings the doctor must acknowledge.
 */
export async function checkItems(c: Pick<HealthConsultation, "patientId" | "memberId" | "mode" | "id">, items: z.infer<typeof itemInput>[], client: DbClient = db): Promise<{ errors: string[]; warnings: RxWarning[]; resolved: (z.infer<typeof itemInput> & { teleList: string | null; rxRequired: boolean; quantity: number })[] }> {
  const errors: string[] = [];
  const warnings: RxWarning[] = [];
  const [patient] = await client.select().from(healthPatients).where(eq(healthPatients.id, c.patientId));
  const drugIds = items.map((i) => i.drugId).filter((v): v is string => Boolean(v));
  const drugs = drugIds.length ? await client.select().from(healthDrugMaster).where(inArray(healthDrugMaster.id, drugIds)) : [];
  const remote = c.mode === "VIDEO" || c.mode === "PHONE";
  const freeTextMode = remote ? (await getRule("health")).remoteFreeTextMedicines : "WARN";
  const matches = remote ? await matchFreeText(items.filter((i) => !i.drugId).flatMap((i) => [i.genericName, i.brandName ?? ""]), client) : new Map<string, MasterMatch>();
  let inPersonBefore = false;
  if (remote) {
    const memberIds = await sameDoctorMemberIds(c.memberId, client);
    const [row] = await client
      .select({ id: healthConsultations.id })
      .from(healthConsultations)
      .where(and(eq(healthConsultations.patientId, c.patientId), inArray(healthConsultations.memberId, memberIds), inArray(healthConsultations.mode, ["IN_PERSON", "HOME_VISIT"]), eq(healthConsultations.status, "COMPLETED"), ne(healthConsultations.id, c.id)))
      .limit(1);
    inPersonBefore = Boolean(row);
  }
  const seen = new Map<string, number>();
  const allergies = (patient?.allergies ?? []).map((a) => a.toLowerCase().trim()).filter((a) => a.length >= 3);
  const resolved = items.map((item, idx) => {
    const line = idx + 1;
    const drug = item.drugId ? drugs.find((d) => d.id === item.drugId) : undefined;
    if (item.drugId && !drug) errors.push(`Line ${line}: that medicine is not in the drug master any more.`);
    const match = !drug ? (matches.get(item.genericName.toLowerCase().trim()) ?? (item.brandName ? matches.get(item.brandName.toLowerCase().trim()) : undefined)) : undefined;
    const teleList = drug?.teleList ?? match?.teleList ?? null;
    const schedule = drug?.schedule ?? match?.schedule ?? null;
    const shown = drug?.genericName ?? item.genericName;
    const how = c.mode === "VIDEO" ? "video" : "phone";
    const generic = (drug?.genericName ?? item.genericName).toLowerCase();
    if (remote && schedule && REMOTE_BLOCKED_SCHEDULES.has(schedule)) errors.push(`Line ${line}: ${shown} (Schedule ${schedule}) cannot be prescribed in a ${how} consultation (Telemedicine Practice Guidelines: prohibited list).`);
    else if (remote && teleList === "PROHIBITED") errors.push(`Line ${line}: ${shown} cannot be prescribed in a ${how} consultation (Telemedicine Practice Guidelines: prohibited list).`);
    if (remote && teleList === "B" && !inPersonBefore) errors.push(`Line ${line}: ${shown} is List B — by teleconsultation only as a follow-up after an in-person visit with you.`);
    if (remote && !drug && !match) {
      if (freeTextMode === "REFUSE") errors.push(`Line ${line}: ${item.genericName} is not in the drug master, so it cannot be checked for a ${how} consultation. Pick it from the list, or prescribe it at an in-person visit.`);
      else warnings.push({ line, kind: "NOT_IN_MASTER", message: `Line ${line}: ${item.genericName} is not in the drug master, so its teleconsultation list cannot be checked. Confirm it may be prescribed by ${how}.` });
    }
    for (const a of allergies) {
      if (generic.includes(a) || a.includes(generic) || (item.brandName && item.brandName.toLowerCase().includes(a))) {
        warnings.push({ line, kind: "ALLERGY", message: `Line ${line}: the patient's recorded allergy "${a}" matches ${item.brandName ?? item.genericName}.` });
      }
    }
    const key = `${generic}|${(item.strength ?? drug?.strength ?? "").toLowerCase()}`;
    if (seen.has(generic)) warnings.push({ line, kind: "DUPLICATE", message: `Line ${line}: ${item.genericName} is also on line ${seen.get(generic)}.` });
    seen.set(generic, line);
    void key;
    const quantity = item.quantity ?? autoQuantity({ form: item.form, dose: item.dose, frequency: item.frequency, durationDays: item.durationDays });
    return { ...item, genericName: drug?.genericName ?? item.genericName, strength: item.strength ?? drug?.strength ?? null, form: (drug?.form as typeof item.form) ?? item.form, teleList, rxRequired: drug?.rxRequired ?? true, quantity };
  });
  return { errors, warnings, resolved };
}

/* ------------------------------------------------------------ content */

const verifyBase = () => (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
export const verifyUrlOf = (token: string) => `${verifyBase()}/rx/verify/${token}`;

function suggestionText(s: z.infer<typeof suggestionInput>, targetName: string | null): string {
  switch (s.type) {
    case "DOCTOR_REFERRAL":
      return `Refer to ${targetName ?? s.specialty ?? "a specialist"}${s.urgency !== "ROUTINE" ? ` (${s.urgency.toLowerCase()})` : ""}${s.note ? `: ${s.note}` : ""}`;
    case "CARE_STAFF":
      return `Home care: ${[s.serviceType ?? s.careCategory?.replace(/-/g, " "), s.frequency, s.durationDays ? `for ${s.durationDays} days` : null, s.startDate ? `from ${s.startDate}` : null].filter(Boolean).join(", ")}${s.note ? ` - ${s.note}` : ""}`;
    case "EQUIPMENT":
      return `Equipment: ${s.equipment ?? "as advised"}${s.buyOrRent ? ` (${s.buyOrRent === "RENT" ? `rent${s.durationDays ? ` for ${s.durationDays} days` : ""}` : "buy"})` : ""}${s.note ? ` - ${s.note}` : ""}`;
    case "LAB_TEST":
      return `Lab tests: ${(s.tests ?? []).join(", ") || "as advised"}${s.homeCollection ? " (home sample collection is fine)" : ""}`;
    case "FOLLOW_UP":
      return `Follow-up visit${s.followUpDate ? ` on ${s.followUpDate}` : ""}${s.note ? `: ${s.note}` : ""}`;
  }
}

async function buildContent(
  client: DbClient,
  c: HealthConsultation,
  patient: HealthPatient,
  items: (z.infer<typeof itemInput> & { quantity: number })[],
  suggestions: { input: z.infer<typeof suggestionInput>; text: string }[],
  meta: { rxNumber: string; version: number; issuedAt: Date; validUntil: string; token: string; amendReason?: string | null; bookingNumber: string | null; visitorAge: number | null },
): Promise<RxContent> {
  const [d] = await client
    .select({ dp: healthDoctorProfiles, member: consultMembers, shop: shops, profile: consultProfiles })
    .from(consultMembers)
    .innerJoin(shops, eq(shops.id, consultMembers.shopId))
    .innerJoin(consultProfiles, eq(consultProfiles.id, consultMembers.profileId))
    .leftJoin(healthDoctorProfiles, eq(healthDoctorProfiles.memberId, consultMembers.id))
    .where(eq(consultMembers.id, c.memberId));
  if (!d?.dp) throw forbidden("Fill in the doctor's registration details first.");
  const name = /^dr\.?\s/i.test(d.dp.fullName) ? d.dp.fullName : `Dr ${d.dp.fullName}`;
  const address = d.profile.addressLine ?? [d.shop.area, d.shop.city, d.shop.state, d.shop.pincode].filter(Boolean).join(", ");
  return {
    rxNumber: meta.rxNumber,
    version: meta.version,
    issuedAt: meta.issuedAt.toISOString(),
    validUntil: meta.validUntil,
    amendReason: meta.amendReason ?? null,
    doctor: { name, qualifications: d.dp.qualifications, specialties: d.dp.specialties, council: d.dp.council, registrationNumber: d.dp.registrationNumber, registrationYear: d.dp.registrationYear },
    clinic: { name: d.shop.name, address, phone: d.shop.contactPhone ?? d.shop.phone ?? null, email: d.shop.email ?? null },
    patient: {
      name: patient.fullName,
      age: ageText(patient.dateOfBirth, meta.issuedAt) ?? (meta.visitorAge != null ? `${meta.visitorAge} y` : null),
      gender: patient.gender ? patient.gender.charAt(0) + patient.gender.slice(1).toLowerCase() : null,
      phone: patient.phone,
      abha: patient.abhaNumber,
    },
    mode: c.mode,
    bookingNumber: meta.bookingNumber,
    vitals: c.vitals ?? {},
    chiefComplaints: c.chiefComplaints,
    history: c.history,
    examination: c.examination,
    diagnoses: c.diagnoses ?? [],
    items: items.map((i, idx) => ({
      lineNo: idx + 1,
      genericName: i.genericName,
      brandName: i.brandName ?? null,
      strength: i.strength ?? null,
      form: i.form,
      dose: i.dose,
      frequency: i.frequency,
      timing: i.timing,
      durationDays: i.durationDays,
      quantity: i.quantity,
      instructions: i.instructions ?? null,
      instructionsLocal: i.instructionsLocal ?? null,
    })),
    investigations: (c.investigations ?? []).map((i) => ({ name: i.name, note: i.note ?? null })),
    advice: c.advice,
    followUpDate: c.followUpDate,
    suggestions: suggestions.map((s) => ({ type: s.input.type, text: s.text, printOnRx: s.input.printOnRx })),
    verifyUrl: verifyUrlOf(meta.token),
  };
}

function qrModules(text: string): boolean[][] {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let col = 0; col < size; col++) row.push(Boolean(qr.modules.get(r, col)));
    rows.push(row);
  }
  return rows;
}

/** Renders the PDF for a prescription content with the doctor's letterhead. */
export async function renderPrescriptionPdf(content: RxContent, shopId: string, memberId: string, purpose: "print" | "email"): Promise<Buffer> {
  const lh = await effectiveLetterhead(shopId, memberId);
  const imgs = await letterheadImages(lh);
  const [dp] = await db.select().from(healthDoctorProfiles).where(eq(healthDoctorProfiles.memberId, memberId));
  const signature = dp ? await imageWithSize(await doctorImage(dp, "signature")) : null;
  const stamp = dp ? await imageWithSize(await doctorImage(dp, "stamp")) : null;
  return renderRxPdf(content, lh, { ...imgs, signature, stamp }, purpose, qrModules(content.verifyUrl));
}

/* ------------------------------------------------------------ preview */

export async function previewPrescription(consultationId: string, raw: unknown, actor: HealthActor): Promise<{ pdf: Buffer; warnings: RxWarning[]; errors: string[] }> {
  const input = issueInput.parse(raw);
  const c = await loadConsultationForDoctor(consultationId, actor);
  await requireVerifiedDoctor(c.memberId, actor);
  const [patient] = await db.select().from(healthPatients).where(eq(healthPatients.id, c.patientId));
  const check = await checkItems(c, input.items);
  const rule = await getRule("health");
  const now = new Date();
  const content = await buildContent(
    db,
    c,
    patient,
    check.resolved,
    input.suggestions.map((s) => ({ input: s, text: suggestionText(s, null) })),
    { rxNumber: "PREVIEW", version: 1, issuedAt: now, validUntil: new Date(now.getTime() + rule.rxValidityDays * 86_400_000).toISOString().slice(0, 10), token: "preview", bookingNumber: null, visitorAge: null },
  );
  return { pdf: await renderPrescriptionPdf(content, c.shopId, c.memberId, "print"), warnings: check.warnings, errors: check.errors };
}

/* ------------------------------------------------------------ issue */

export interface IssuedPrescription {
  prescription: Omit<HealthPrescription, "pdf">;
  warnings: RxWarning[];
  bookingCompleted: boolean;
}

/** With rule health.requireRegistryCheck on, staff must have recorded a register check of this doctor. */
export async function requireRegistryChecked(memberId: string, client: DbClient = db): Promise<void> {
  if (!(await getRule("health")).requireRegistryCheck) return;
  const [dp] = await client.select({ checkedAt: healthDoctorProfiles.registryCheckedAt }).from(healthDoctorProfiles).where(eq(healthDoctorProfiles.memberId, memberId));
  if (!dp?.checkedAt) throw forbidden("Prescriptions open once GoKesari has checked your medical registration with the council register. Please contact support.");
}

export async function issuePrescription(consultationId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<IssuedPrescription> {
  const input = issueInput.parse(raw);
  const c = await loadConsultationForDoctor(consultationId, actor);
  const ctx = await requireVerifiedDoctor(c.memberId, actor);
  await requireRegistryChecked(c.memberId);
  if (c.status !== "IN_PROGRESS") throw conflict("A prescription was already issued for this consultation. Use Amend to change it.");
  if (!input.items.length && !(c.diagnoses ?? []).length && !c.advice && !input.suggestions.length) throw validationFailed("Add at least a diagnosis, advice, a medicine or a suggestion.");
  const check = await checkItems(c, input.items);
  if (check.errors.length) throw validationFailed(check.errors.join(" "), { errors: check.errors });
  if (check.warnings.length && !input.acknowledgeWarnings) throw conflict("Please review the warnings before issuing.", { reason: "RX_WARNINGS", warnings: check.warnings });
  const rule = await getRule("health");
  const validUntil = new Date(now.getTime() + rule.rxValidityDays * 86_400_000).toISOString().slice(0, 10);
  const label = await doctorLabel(c.memberId);
  // Referral targets: only verified doctors on GoKesari.
  const targetIds = input.suggestions.map((s) => s.targetMemberId).filter((v): v is string => Boolean(v));
  const targets = targetIds.length ? await db.select({ id: consultMembers.id, name: consultMembers.name, shopId: consultMembers.shopId, shopName: shops.name }).from(consultMembers).innerJoin(shops, eq(shops.id, consultMembers.shopId)).where(inArray(consultMembers.id, targetIds)) : [];
  const result = await db.transaction(async (tx) => {
    // Lock the consultation so a double click issues once.
    const [locked] = await tx.execute<{ status: string }>(sql`select status from health.consultations where id = ${c.id} for update`);
    if (locked?.status !== "IN_PROGRESS") throw conflict("A prescription was already issued for this consultation.");
    const [patient] = await tx.select().from(healthPatients).where(eq(healthPatients.id, c.patientId));
    const year = Number(new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 4));
    const seq = await nextNumber(tx, `RX-${year}`);
    const rxNumber = `RX-${year}-${String(seq).padStart(6, "0")}`;
    const token = randomBytes(18).toString("base64url");
    const [booking] = c.bookingId ? await tx.select().from(consultBookings).where(eq(consultBookings.id, c.bookingId)) : [];
    const suggestions = input.suggestions.map((s) => {
      const t = s.targetMemberId ? targets.find((x) => x.id === s.targetMemberId) : null;
      return { input: s, text: suggestionText(s, t ? `${t.name} (${t.shopName})` : null), target: t ?? null };
    });
    const content = await buildContent(tx, c, patient, check.resolved, suggestions, { rxNumber, version: 1, issuedAt: now, validUntil, token, bookingNumber: booking?.bookingNumber ?? null, visitorAge: booking?.visitorAge ?? null });
    const pdf = await renderPrescriptionPdf(content, c.shopId, c.memberId, "email");
    const [rx] = await tx
      .insert(healthPrescriptions)
      .values({
        consultationId: c.id,
        patientId: c.patientId,
        shopId: c.shopId,
        memberId: c.memberId,
        doctorUserId: ctx.userId ?? actor.id,
        rxNumber,
        version: 1,
        status: "ISSUED",
        content: content as unknown as Record<string, unknown>,
        pdf: encryptBytes(pdf),
        pdfHash: createHash("sha256").update(pdf).digest("hex"),
        verificationToken: token,
        issuedAt: now,
        validUntil,
      })
      .returning();
    await tx.update(healthPrescriptions).set({ rootId: rx.id }).where(eq(healthPrescriptions.id, rx.id));
    if (check.resolved.length) {
      await tx.insert(healthPrescriptionItems).values(
        check.resolved.map((i, idx) => ({
          prescriptionId: rx.id,
          lineNo: idx + 1,
          drugId: i.drugId ?? null,
          genericName: i.genericName,
          brandName: i.brandName ?? null,
          strength: i.strength ?? null,
          form: i.form,
          dose: i.dose,
          frequency: i.frequency,
          timing: i.timing,
          durationDays: i.durationDays,
          quantity: i.quantity,
          instructions: i.instructions ?? null,
          instructionsLocal: i.instructionsLocal ?? null,
          teleList: i.teleList,
          rxRequired: i.rxRequired,
        })),
      );
    }
    const createdSuggestions: { id: string; type: string; text: string; targetMemberId: string | null; targetShopId: string | null; note: string | null }[] = [];
    for (const s of suggestions) {
      const [row] = await tx
        .insert(healthSuggestions)
        .values({
          consultationId: c.id,
          prescriptionId: rx.id,
          patientId: c.patientId,
          memberId: c.memberId,
          type: s.input.type,
          details: { ...s.input, text: s.text },
          targetMemberId: s.target?.id ?? null,
          targetShopId: s.target?.shopId ?? null,
          urgency: s.input.urgency,
          printOnRx: s.input.printOnRx,
        })
        .returning({ id: healthSuggestions.id });
      createdSuggestions.push({ id: row.id, type: s.input.type, text: s.text, targetMemberId: s.target?.id ?? null, targetShopId: s.target?.shopId ?? null, note: s.input.note ?? null });
      await addTimeline(tx, {
        patientId: c.patientId,
        occurredAt: now,
        kind: s.input.type === "DOCTOR_REFERRAL" ? "REFERRAL" : "SUGGESTION",
        title: s.input.type === "DOCTOR_REFERRAL" ? `Referral by ${label}` : `Suggested by ${label}`,
        summary: s.text,
        providerName: label,
        providerMemberId: c.memberId,
        providerShopId: c.shopId,
        refType: "suggestion",
        refId: row.id,
        meta: { type: s.input.type, prescriptionId: rx.id },
      });
    }
    const [closed] = await tx.update(healthConsultations).set({ status: "COMPLETED", completedAt: now, updatedAt: now }).where(eq(healthConsultations.id, c.id)).returning();
    await timelineForConsultation(tx, closed, label);
    await addTimeline(tx, {
      patientId: c.patientId,
      occurredAt: now,
      kind: "PRESCRIPTION",
      title: `Prescription ${rxNumber} from ${label}`,
      summary: check.resolved.length ? check.resolved.map((i) => `${i.brandName ?? i.genericName}${i.strength ? ` ${i.strength}` : ""} ${i.frequency} × ${i.durationDays} d`).join("; ") : "No medicines (advice only).",
      providerName: label,
      providerMemberId: c.memberId,
      providerShopId: c.shopId,
      refType: "prescription",
      refId: rx.id,
      meta: { rxNumber, version: 1 },
    });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_PRESCRIPTION_ISSUED, entityType: "health_prescription", entityId: rx.id, newValue: { rxNumber, items: check.resolved.length, suggestions: suggestions.length, pdfHash: rx.pdfHash } }, tx);
    return { rx, patient, booking: booking ?? null, createdSuggestions };
  });
  const { pdf: _pdf, ...rxNoPdf } = result.rx;
  void _pdf;
  await afterIssue(result.rx, result.patient, label, "ISSUED", null);
  for (const s of result.createdSuggestions) {
    await publishHealthEvent({ name: s.type === "DOCTOR_REFERRAL" ? "referral.created" : "suggestion.created", userIds: patientAudience(result.patient), shopId: s.targetShopId, subjectId: s.id, payload: { suggestionId: s.id, type: s.type } });
    if (s.type === "DOCTOR_REFERRAL" && s.targetMemberId) {
      const [t] = await db.select({ userId: consultMembers.userId, ownerId: shops.ownerId }).from(consultMembers).innerJoin(shops, eq(shops.id, consultMembers.shopId)).where(eq(consultMembers.id, s.targetMemberId));
      for (const uid of [...new Set([t?.userId, t?.ownerId].filter((v): v is string => Boolean(v)))]) {
        await notify({ userId: uid, type: NOTIFICATION_TYPES.HEALTH_REFERRAL_RECEIVED, title: `New referral from ${label}`, body: `${label} referred a patient to you. You will see the referral note when the patient books.`, actionUrl: "/shop/health", channels: ["PUSH"], metadata: { suggestionId: s.id } });
      }
    }
  }
  let bookingCompleted = false;
  if (result.booking && result.booking.status === "CONFIRMED") {
    try {
      const needsCode = await completionNeedsCode(result.booking);
      if (!needsCode) {
        await completeBooking(result.booking.id, actor, null, now);
        bookingCompleted = true;
      } else if (await checkedInWithCode(result.booking.id)) {
        await completeBooking(result.booking.id, actor, completionCode(result.booking.id, result.booking.otpSalt ?? ""), now);
        bookingCompleted = true;
      }
    } catch (error) {
      console.error("[health] booking completion after issue failed", result.booking.id, error instanceof Error ? error.message : error);
    }
  }
  return { prescription: rxNoPdf, warnings: check.warnings, bookingCompleted };
}

/** E-mail with the PDF, in-app / push / SMS / WhatsApp notice, live update. Never throws. */
async function afterIssue(rx: HealthPrescription, patient: HealthPatient, label: string, kind: "ISSUED" | "AMENDED", reason: string | null): Promise<void> {
  try {
    const audience = patientAudience(patient);
    const title = kind === "ISSUED" ? `Prescription ${rx.rxNumber} from ${label}` : `Prescription ${rx.rxNumber} updated (version ${rx.version})`;
    const body =
      kind === "ISSUED"
        ? `${label} issued a prescription for ${patient.fullName}. The PDF is attached. Open My Health to see it, print it or send it to a medical store for pickup or home delivery.`
        : `${label} amended the prescription for ${patient.fullName}: ${reason}. The new PDF is attached; the earlier version stays in your record.`;
    for (const userId of audience) {
      await queueDocumentEmail({ docType: "HEALTH_PRESCRIPTION", docId: rx.id, userId, recipientRole: "CUSTOMER", title, body, actionUrl: `/health/prescriptions/${rx.id}`, category: "HEALTH", maxAttempts: 8 });
      await notify({
        userId,
        type: kind === "ISSUED" ? NOTIFICATION_TYPES.HEALTH_PRESCRIPTION_ISSUED : NOTIFICATION_TYPES.HEALTH_PRESCRIPTION_AMENDED,
        title,
        body: kind === "ISSUED" ? `${label} issued a prescription for ${patient.fullName}. Open it in My Health.` : `${label} updated the prescription for ${patient.fullName}.`,
        actionUrl: `/health/prescriptions/${rx.id}`,
        channels: ["PUSH", "SMS", "WHATSAPP"],
        metadata: { prescriptionId: rx.id, rxNumber: rx.rxNumber, version: rx.version },
      });
    }
    await db.update(healthPrescriptions).set({ emailedAt: new Date() }).where(eq(healthPrescriptions.id, rx.id));
    await publishHealthEvent({ name: kind === "ISSUED" ? "prescription.issued" : "prescription.amended", userIds: audience, shopId: rx.shopId, subjectId: rx.id, payload: { prescriptionId: rx.id, rxNumber: rx.rxNumber, version: rx.version, consultationId: rx.consultationId } });
  } catch (error) {
    console.error("[health] after-issue failed", rx.id, error);
  }
}

/* ------------------------------------------------------------ amend */

export const amendInput = issueInput.extend({ reason: z.string().trim().min(5, "Give the reason for the change (at least 5 characters).").max(500) });

export async function amendPrescription(prescriptionId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<IssuedPrescription> {
  const input = amendInput.parse(raw);
  const [old] = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.id, prescriptionId));
  if (!old) throw notFound("Prescription");
  await requireVerifiedDoctor(old.memberId, actor);
  await requireRegistryChecked(old.memberId);
  if (old.status !== "ISSUED") throw conflict("Only the latest version can be amended.");
  const [c] = await db.select().from(healthConsultations).where(eq(healthConsultations.id, old.consultationId));
  const check = await checkItems(c, input.items);
  if (check.errors.length) throw validationFailed(check.errors.join(" "), { errors: check.errors });
  if (check.warnings.length && !input.acknowledgeWarnings) throw conflict("Please review the warnings before issuing.", { reason: "RX_WARNINGS", warnings: check.warnings });
  const label = await doctorLabel(old.memberId);
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.execute<{ status: string }>(sql`select status from health.prescriptions where id = ${old.id} for update`);
    if (locked?.status !== "ISSUED") throw conflict("This prescription was already amended.");
    const [patient] = await tx.select().from(healthPatients).where(eq(healthPatients.id, old.patientId));
    const oldItems = await tx.select().from(healthPrescriptionItems).where(eq(healthPrescriptionItems.prescriptionId, old.id));
    const oldContent = old.content as unknown as RxContent;
    const token = randomBytes(18).toString("base64url");
    const version = old.version + 1;
    const suggestions = input.suggestions.map((s) => ({ input: s, text: suggestionText(s, null) }));
    const content = await buildContent(tx, c, patient, check.resolved, suggestions.length ? suggestions : oldContent.suggestions.map((s) => ({ input: { type: s.type as "FOLLOW_UP", printOnRx: s.printOnRx, urgency: "ROUTINE" as const }, text: s.text })), {
      rxNumber: old.rxNumber,
      version,
      issuedAt: now,
      validUntil: old.validUntil ?? now.toISOString().slice(0, 10),
      token,
      amendReason: input.reason,
      bookingNumber: oldContent.bookingNumber ?? null,
      visitorAge: null,
    });
    const pdf = await renderPrescriptionPdf(content, old.shopId, old.memberId, "email");
    await tx.update(healthPrescriptions).set({ status: "SUPERSEDED" }).where(eq(healthPrescriptions.id, old.id));
    const [rx] = await tx
      .insert(healthPrescriptions)
      .values({
        consultationId: old.consultationId,
        patientId: old.patientId,
        shopId: old.shopId,
        memberId: old.memberId,
        doctorUserId: old.doctorUserId,
        rxNumber: old.rxNumber,
        version,
        rootId: old.rootId ?? old.id,
        supersedesId: old.id,
        amendReason: input.reason,
        status: "ISSUED",
        content: content as unknown as Record<string, unknown>,
        pdf: encryptBytes(pdf),
        pdfHash: createHash("sha256").update(pdf).digest("hex"),
        verificationToken: token,
        issuedAt: now,
        validUntil: old.validUntil,
      })
      .returning();
    if (check.resolved.length) {
      await tx.insert(healthPrescriptionItems).values(
        check.resolved.map((i, idx) => {
          // Medicines already dispensed against the earlier version stay dispensed (same medicine and strength).
          const prev = oldItems.find((o) => o.genericName.toLowerCase() === i.genericName.toLowerCase() && (o.strength ?? "").toLowerCase() === (i.strength ?? "").toLowerCase() && o.form === i.form);
          return {
            prescriptionId: rx.id,
            lineNo: idx + 1,
            drugId: i.drugId ?? null,
            genericName: i.genericName,
            brandName: i.brandName ?? null,
            strength: i.strength ?? null,
            form: i.form,
            dose: i.dose,
            frequency: i.frequency,
            timing: i.timing,
            durationDays: i.durationDays,
            quantity: i.quantity,
            instructions: i.instructions ?? null,
            instructionsLocal: i.instructionsLocal ?? null,
            teleList: i.teleList,
            rxRequired: i.rxRequired,
            dispensedQty: Math.min(prev?.dispensedQty ?? 0, i.quantity),
          };
        }),
      );
    }
    // Suggestions stay linked to the prescription family; new ones (if given) are added.
    for (const s of input.suggestions) {
      await tx.insert(healthSuggestions).values({ consultationId: old.consultationId, prescriptionId: rx.id, patientId: old.patientId, memberId: old.memberId, type: s.type, details: { ...s, text: suggestionText(s, null) }, urgency: s.urgency, printOnRx: s.printOnRx });
    }
    await addTimeline(tx, {
      patientId: old.patientId,
      occurredAt: now,
      kind: "PRESCRIPTION",
      title: `Prescription ${old.rxNumber} amended (version ${version})`,
      summary: `Reason: ${input.reason}`,
      providerName: label,
      providerMemberId: old.memberId,
      providerShopId: old.shopId,
      refType: "prescription",
      refId: rx.id,
      meta: { rxNumber: old.rxNumber, version, supersedes: old.id },
    });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_PRESCRIPTION_AMENDED, entityType: "health_prescription", entityId: rx.id, previousValue: { id: old.id, version: old.version }, newValue: { version, reason: input.reason, pdfHash: rx.pdfHash } }, tx);
    return { rx, patient };
  });
  await afterIssue(result.rx, result.patient, label, "AMENDED", input.reason);
  const { pdf: _p, ...rxNoPdf } = result.rx;
  void _p;
  return { prescription: rxNoPdf, warnings: check.warnings, bookingCompleted: false };
}

/* ------------------------------------------------------------ read */

export type PrescriptionViewer = "PATIENT" | "DOCTOR" | "STORE" | "STAFF";

export interface PrescriptionView {
  prescription: Omit<HealthPrescription, "pdf">;
  content: RxContent;
  items: HealthPrescriptionItem[];
  versions: { id: string; version: number; issuedAt: Date; status: string; amendReason: string | null }[];
  suggestions: { id: string; type: string; status: string; text: string; targetMemberId: string | null; linkedBookingId: string | null; linkedRxOrderId: string | null; linkedRentalId: string | null; details: Record<string, unknown> }[];
  viewer: PrescriptionViewer;
}

/** Who may open a prescription: the patient's account; the issuing doctor (or clinic owner); a store it was sent to. */
export async function prescriptionAccess(rx: HealthPrescription, actor: HealthActor, client: DbClient = db): Promise<PrescriptionViewer> {
  const [p] = await client.select().from(healthPatients).where(eq(healthPatients.id, rx.patientId));
  if (p && (p.accountUserId === actor.id || (p.linkedUserId === actor.id && p.linkStatus === "ACTIVE"))) return "PATIENT";
  const memberIds = await sameDoctorMemberIds(rx.memberId, client);
  const [m] = await client.select({ userId: consultMembers.userId, ownerId: shops.ownerId }).from(consultMembers).innerJoin(shops, eq(shops.id, consultMembers.shopId)).where(eq(consultMembers.id, rx.memberId));
  if (m && (m.userId === actor.id || m.ownerId === actor.id)) return "DOCTOR";
  void memberIds;
  const rows = await client.execute<{ ok: number }>(sql`
    select 1 as ok from health.rx_orders o join shops s on s.id = o.shop_id
     where o.prescription_id in (select id from health.prescriptions where coalesce(root_id, id) = ${rx.rootId ?? rx.id})
       and s.owner_id = ${actor.id} limit 1`);
  if (rows.length) return "STORE";
  throw notFound("Prescription");
}

export async function prescriptionView(prescriptionId: string, actor: HealthActor, ip?: string | null): Promise<PrescriptionView> {
  const [rx] = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.id, prescriptionId));
  if (!rx) throw notFound("Prescription");
  const viewer = await prescriptionAccess(rx, actor);
  const items = await db.select().from(healthPrescriptionItems).where(eq(healthPrescriptionItems.prescriptionId, rx.id)).orderBy(asc(healthPrescriptionItems.lineNo));
  const versions = await db
    .select({ id: healthPrescriptions.id, version: healthPrescriptions.version, issuedAt: healthPrescriptions.issuedAt, status: healthPrescriptions.status, amendReason: healthPrescriptions.amendReason })
    .from(healthPrescriptions)
    .where(eq(healthPrescriptions.rootId, rx.rootId ?? rx.id))
    .orderBy(desc(healthPrescriptions.version));
  const sugg =
    viewer === "STORE"
      ? []
      : await db
          .select()
          .from(healthSuggestions)
          .where(eq(healthSuggestions.consultationId, rx.consultationId))
          .orderBy(asc(healthSuggestions.createdAt));
  if (viewer === "STORE") {
    await logRecordAccess({ patientId: rx.patientId, actor, actorLabel: "Medical store you sent it to", actorRole: "STORE", action: "VIEW", objectType: "prescription", objectId: rx.id, ipAddress: ip ?? null });
  }
  const { pdf: _pdf, ...rest } = rx;
  void _pdf;
  return {
    prescription: rest,
    content: rx.content as unknown as RxContent,
    items,
    versions,
    // The doctor sees whether a suggestion was booked — status only, never prices or commissions (NMC).
    suggestions: sugg.map((s) => ({ id: s.id, type: s.type, status: s.status, text: String((s.details as { text?: string }).text ?? ""), targetMemberId: s.targetMemberId, linkedBookingId: viewer === "PATIENT" ? s.linkedBookingId : null, linkedRxOrderId: viewer === "PATIENT" ? s.linkedRxOrderId : null, linkedRentalId: viewer === "PATIENT" ? s.linkedRentalId : null, details: viewer === "PATIENT" ? s.details : { type: s.type } })),
    viewer,
  };
}

/** The issued PDF (decrypted) for an allowed viewer; logs print / download. */
export async function prescriptionPdf(prescriptionId: string, actor: HealthActor, action: "DOWNLOAD" | "PRINT", ip?: string | null): Promise<{ pdf: Buffer; filename: string }> {
  const [rx] = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.id, prescriptionId));
  if (!rx) throw notFound("Prescription");
  const viewer = await prescriptionAccess(rx, actor);
  let pdf: Buffer;
  if (viewer === "DOCTOR" && action === "PRINT") {
    // The clinic's print copy follows its letterhead mode (pre-printed paper: no header / footer).
    pdf = await renderPrescriptionPdf(rx.content as unknown as RxContent, rx.shopId, rx.memberId, "print");
    await db.update(healthPrescriptions).set({ printCount: sql`${healthPrescriptions.printCount} + 1` }).where(eq(healthPrescriptions.id, rx.id));
  } else {
    if (!rx.pdf) throw notFound("Prescription PDF");
    pdf = decryptBytes(rx.pdf);
  }
  const label = viewer === "PATIENT" ? (actor.name ?? "You") : viewer === "DOCTOR" ? await doctorLabel(rx.memberId) : viewer === "STORE" ? "Medical store you sent it to" : "GoKesari staff";
  if (viewer !== "PATIENT" || action === "PRINT") {
    await logRecordAccess({ patientId: rx.patientId, actor, actorLabel: viewer === "PATIENT" ? "You" : label, actorRole: viewer, action, objectType: "prescription", objectId: rx.id, reason: viewer === "DOCTOR" && action === "PRINT" && rx.printCount > 0 ? `Reprint #${rx.printCount}` : null, ipAddress: ip ?? null });
  }
  return { pdf, filename: `${safeName(rx.rxNumber)}${rx.version > 1 ? `-v${rx.version}` : ""}.pdf` };
}

/** The HTML print view was printed (clinic copy): count it and log it (reprints are logged too). */
export async function logPrescriptionPrint(prescriptionId: string, actor: HealthActor, ip?: string | null): Promise<void> {
  const [rx] = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.id, prescriptionId));
  if (!rx) throw notFound("Prescription");
  const viewer = await prescriptionAccess(rx, actor);
  await db.update(healthPrescriptions).set({ printCount: sql`${healthPrescriptions.printCount} + 1` }).where(eq(healthPrescriptions.id, rx.id));
  await logRecordAccess({ patientId: rx.patientId, actor, actorLabel: viewer === "DOCTOR" ? await doctorLabel(rx.memberId) : viewer === "PATIENT" ? "You" : "Medical store you sent it to", actorRole: viewer, action: "PRINT", objectType: "prescription", objectId: rx.id, reason: rx.printCount > 0 ? `Reprint #${rx.printCount}` : null, ipAddress: ip ?? null });
}

/** A signature image for a printed copy: only to someone who may open that prescription. */
export async function signatureForPrescription(prescriptionId: string, memberId: string, actor: HealthActor): Promise<Buffer | null> {
  const [rx] = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.id, prescriptionId));
  if (!rx || rx.memberId !== memberId) throw notFound("Prescription");
  await prescriptionAccess(rx, actor);
  const [dp] = await db.select().from(healthDoctorProfiles).where(eq(healthDoctorProfiles.memberId, memberId));
  return dp ? doctorImage(dp, "signature") : null;
}

/** For the document-email outbox (no actor: the outbox only sends to the patient's own account). */
export async function prescriptionPdfForEmail(prescriptionId: string): Promise<{ pdf: Buffer; filename: string } | null> {
  const [rx] = await db.select({ pdf: healthPrescriptions.pdf, rxNumber: healthPrescriptions.rxNumber, version: healthPrescriptions.version }).from(healthPrescriptions).where(eq(healthPrescriptions.id, prescriptionId));
  if (!rx?.pdf) return null;
  return { pdf: decryptBytes(rx.pdf), filename: `${safeName(rx.rxNumber)}${rx.version > 1 ? `-v${rx.version}` : ""}.pdf` };
}

/* ------------------------------------------------------------ verify (QR) */

export interface VerifyResult {
  valid: boolean;
  status: "VALID" | "SUPERSEDED" | "NOT_FOUND";
  rxNumber?: string;
  version?: number;
  issuedAt?: Date;
  validUntil?: string | null;
  doctor?: string;
  registration?: string;
  clinic?: string;
  /** Authorised viewers (patient, doctor, store it was sent to) see the patient and medicines. */
  details?: { patient: string; items: string[]; pdfHash: string | null } | null;
  latestVersion?: number;
}

/**
 * The page the QR opens. Anyone learns only whether the prescription is genuine, by whom, and when;
 * the patient, the doctor and a store it was sent to (signed in) also see the patient and medicines.
 */
export async function verifyPrescription(token: string, actor: HealthActor | null): Promise<VerifyResult> {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return { valid: false, status: "NOT_FOUND" };
  const [rx] = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.verificationToken, token));
  if (!rx) return { valid: false, status: "NOT_FOUND" };
  const content = rx.content as unknown as RxContent;
  const [latest] = await db.select({ version: sql<number>`max(${healthPrescriptions.version})::int` }).from(healthPrescriptions).where(eq(healthPrescriptions.rootId, rx.rootId ?? rx.id));
  let details: VerifyResult["details"] = null;
  if (actor) {
    try {
      const viewer = await prescriptionAccess(rx, actor);
      const items = await db.select().from(healthPrescriptionItems).where(eq(healthPrescriptionItems.prescriptionId, rx.id)).orderBy(asc(healthPrescriptionItems.lineNo));
      details = { patient: content.patient.name, items: items.map((i) => `${i.brandName ?? i.genericName}${i.strength ? ` ${i.strength}` : ""} - qty ${i.quantity}`), pdfHash: rx.pdfHash };
      if (viewer === "STORE") await logRecordAccess({ patientId: rx.patientId, actor, actorLabel: "Medical store you sent it to", actorRole: "STORE", action: "VIEW", objectType: "prescription_verify", objectId: rx.id });
    } catch {
      details = null;
    }
  }
  return {
    valid: rx.status === "ISSUED",
    status: rx.status === "ISSUED" ? "VALID" : "SUPERSEDED",
    rxNumber: rx.rxNumber,
    version: rx.version,
    issuedAt: rx.issuedAt,
    validUntil: rx.validUntil,
    doctor: content.doctor.name,
    registration: `${content.doctor.registrationNumber} (${content.doctor.council})`,
    clinic: content.clinic.name,
    details,
    latestVersion: latest?.version ?? rx.version,
  };
}

/* ------------------------------------------------------------ patient lists */

export async function patientPrescriptions(patientId: string, actor: HealthActor): Promise<{ id: string; rxNumber: string; version: number; issuedAt: Date; doctor: string; clinic: string; items: number; status: string }[]> {
  const p = await requirePatientAccess(patientId, actor);
  const rows = await db
    .select({ rx: healthPrescriptions, n: sql<number>`(select count(*)::int from health.prescription_items i where i.prescription_id = ${healthPrescriptions.id})` })
    .from(healthPrescriptions)
    .where(and(eq(healthPrescriptions.patientId, p.id), eq(healthPrescriptions.status, "ISSUED")))
    .orderBy(desc(healthPrescriptions.issuedAt));
  return rows.map((r) => {
    const c = r.rx.content as unknown as RxContent;
    return { id: r.rx.id, rxNumber: r.rx.rxNumber, version: r.rx.version, issuedAt: r.rx.issuedAt, doctor: c.doctor.name, clinic: c.clinic.name, items: r.n, status: r.rx.status };
  });
}

/** Repeat last prescription: the doctor's latest issued medicines for this patient. */
export async function lastPrescriptionItems(consultationId: string, actor: HealthActor): Promise<RxItemInput[]> {
  const c = await loadConsultationForDoctor(consultationId, actor);
  const memberIds = await sameDoctorMemberIds(c.memberId);
  const [last] = await db
    .select({ id: healthPrescriptions.id })
    .from(healthPrescriptions)
    .where(and(eq(healthPrescriptions.patientId, c.patientId), inArray(healthPrescriptions.memberId, memberIds), eq(healthPrescriptions.status, "ISSUED")))
    .orderBy(desc(healthPrescriptions.issuedAt))
    .limit(1);
  if (!last) return [];
  const items = await db.select().from(healthPrescriptionItems).where(eq(healthPrescriptionItems.prescriptionId, last.id)).orderBy(asc(healthPrescriptionItems.lineNo));
  return items.map((i) => ({
    drugId: i.drugId,
    genericName: i.genericName,
    brandName: i.brandName,
    strength: i.strength,
    form: i.form as RxItemInput["form"],
    dose: i.dose,
    frequency: i.frequency,
    timing: i.timing as RxItemInput["timing"],
    durationDays: i.durationDays,
    quantity: i.quantity,
    instructions: i.instructions,
    instructionsLocal: i.instructionsLocal,
  }));
}

export { isNull };
