/**
 * GoKesari Health: record-sharing consent and the patient's access log (DPDP Act 2023).
 *
 * A patient (or the account holder) decides, per doctor, whether that doctor may see their earlier
 * GoKesari records: ALWAYS, ASK (each time — the doctor sends a request the patient approves for that
 * visit) or OFF. A choice made on a booking is THIS_BOOKING. Withdrawal is one tap and takes effect at
 * once. Every grant, withdrawal and look is in the access log the patient can read.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { RECORD_SHARE_CONSENT_VERSION, type ShareChoice } from "@/lib/health/constants";
import { db, type DbClient } from "@/server/db";
import { consultMembers, healthAccessLog, healthConsents, healthPatients, shops, type HealthAccessLogRow } from "@/server/db/schema";
import { recordAudit, AUDIT_ACTIONS } from "@/server/services/audit";
import { notify, NOTIFICATION_TYPES } from "@/server/services/notifications";
import { doctorLabel, logRecordAccess, patientAudience, requirePatientAccess, sameDoctorMemberIds, type HealthActor } from "./access";
import { publishHealthEvent } from "./events";

const SHARE_TEXT = (doctor: string, mode: string) =>
  mode === "ALWAYS"
    ? `${doctor} may see my earlier GoKesari health records (other doctors, providers, my uploads) until I withdraw this.`
    : mode === "THIS_BOOKING"
      ? `${doctor} may see my earlier GoKesari health records for this appointment only.`
      : mode === "ASK"
        ? `${doctor} must ask me each time before seeing my earlier GoKesari health records.`
        : `${doctor} may not see my earlier GoKesari health records.`;

/** Records the patient's sharing choice for one doctor (member). Earlier active choices for that doctor are withdrawn. */
export async function setDoctorConsent(
  input: { patientId: string; memberId: string; mode: "ALWAYS" | "ASK" | "OFF" | "THIS_BOOKING"; bookingId?: string | null; kind?: "DOCTOR_RECORDS" | "REFERRAL_RECORDS" | "PROVIDER_RECORDS" },
  actor: HealthActor,
  client: DbClient = db,
  now: Date = new Date(),
): Promise<string> {
  const patient = await requirePatientAccess(input.patientId, actor, client);
  const [m] = await client.select({ shopId: consultMembers.shopId }).from(consultMembers).where(eq(consultMembers.id, input.memberId));
  if (!m) throw notFound("Doctor");
  const label = await doctorLabel(input.memberId, client);
  const kind = input.kind ?? "DOCTOR_RECORDS";
  // A per-visit choice does not replace a standing one; a standing choice replaces every earlier one.
  if (input.mode !== "THIS_BOOKING") {
    await client
      .update(healthConsents)
      .set({ revokedAt: now, revokedBy: actor.id })
      .where(and(eq(healthConsents.patientId, patient.id), eq(healthConsents.granteeMemberId, input.memberId), inArray(healthConsents.kind, ["DOCTOR_RECORDS", "REFERRAL_RECORDS", "PROVIDER_RECORDS"]), isNull(healthConsents.revokedAt)));
  }
  const [row] = await client
    .insert(healthConsents)
    .values({
      patientId: patient.id,
      kind,
      mode: input.mode,
      granteeMemberId: input.memberId,
      granteeShopId: m.shopId,
      bookingId: input.bookingId ?? null,
      version: RECORD_SHARE_CONSENT_VERSION,
      textSnapshot: SHARE_TEXT(label, input.mode),
      grantedBy: actor.id,
      grantedAt: now,
    })
    .returning({ id: healthConsents.id });
  const granted = input.mode === "ALWAYS" || input.mode === "THIS_BOOKING";
  await logRecordAccess({ patientId: patient.id, actor, actorLabel: "You", action: granted ? "CONSENT_GRANTED" : "CONSENT_REVOKED", objectType: "consent", objectId: row.id, reason: SHARE_TEXT(label, input.mode) }, client);
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_CONSENT_CHANGED, entityType: "health_consent", entityId: row.id, newValue: { kind, mode: input.mode, memberId: input.memberId } }, client);
  await publishHealthEvent({ name: granted ? "consent.granted" : "consent.revoked", userIds: patientAudience(patient), shopId: m.shopId, subjectId: patient.id, payload: { memberId: input.memberId, mode: input.mode } }, client);
  return row.id;
}

/** The booking form's choice (ON / OFF / ASK) as a consent row. */
export async function applyBookingShareChoice(patientId: string, memberIds: readonly string[], bookingId: string, choice: ShareChoice, actor: HealthActor, client: DbClient = db): Promise<void> {
  for (const memberId of memberIds) {
    if (choice === "ON") await setDoctorConsent({ patientId, memberId, mode: "THIS_BOOKING", bookingId }, actor, client);
    else if (choice === "ASK") await setDoctorConsent({ patientId, memberId, mode: "ASK", bookingId }, actor, client);
    // OFF: nothing to record unless a standing ALWAYS exists — the patient withdraws that from Privacy.
  }
}

/** Withdraws one consent at once. */
export async function revokeConsent(consentId: string, actor: HealthActor, now: Date = new Date()): Promise<void> {
  const [c] = await db.select().from(healthConsents).where(eq(healthConsents.id, consentId));
  if (!c) throw notFound("Consent");
  const patient = await requirePatientAccess(c.patientId, actor);
  if (c.kind === "HEALTH_NOTICE") throw conflict("To withdraw the My Health notice, use 'Delete my account' in Privacy.");
  if (c.revokedAt) return;
  await db.update(healthConsents).set({ revokedAt: now, revokedBy: actor.id }).where(eq(healthConsents.id, c.id));
  await logRecordAccess({ patientId: patient.id, actor, actorLabel: "You", action: "CONSENT_REVOKED", objectType: "consent", objectId: c.id, reason: c.textSnapshot });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_CONSENT_CHANGED, entityType: "health_consent", entityId: c.id, newValue: { revoked: true } });
  await publishHealthEvent({ name: "consent.revoked", userIds: patientAudience(patient), shopId: c.granteeShopId, subjectId: patient.id, payload: { consentId: c.id } });
}

export interface ConsentRow {
  id: string;
  kind: string;
  mode: string;
  who: string;
  text: string;
  grantedAt: Date;
  revokedAt: Date | null;
  bookingId: string | null;
}

export async function consentsFor(patientId: string, actor: HealthActor): Promise<ConsentRow[]> {
  const patient = await requirePatientAccess(patientId, actor);
  const rows = await db
    .select({ c: healthConsents, member: consultMembers.name, clinic: shops.name })
    .from(healthConsents)
    .leftJoin(consultMembers, eq(consultMembers.id, healthConsents.granteeMemberId))
    .leftJoin(shops, eq(shops.id, healthConsents.granteeShopId))
    .where(eq(healthConsents.patientId, patient.id))
    .orderBy(desc(healthConsents.grantedAt));
  return rows.map((r) => ({
    id: r.c.id,
    kind: r.c.kind,
    mode: r.c.mode,
    who: r.member ? `${r.member}${r.clinic ? ` (${r.clinic})` : ""}` : r.c.kind === "HEALTH_NOTICE" ? "GoKesari (My Health notice)" : "—",
    text: r.c.textSnapshot,
    grantedAt: r.c.grantedAt,
    revokedAt: r.c.revokedAt,
    bookingId: r.c.bookingId,
  }));
}

export async function accessLogFor(patientId: string, actor: HealthActor, limit = 300): Promise<HealthAccessLogRow[]> {
  const patient = await requirePatientAccess(patientId, actor);
  return db.select().from(healthAccessLog).where(eq(healthAccessLog.patientId, patient.id)).orderBy(desc(healthAccessLog.createdAt)).limit(limit);
}

/** ASK mode: the doctor asks to see earlier records for a booking; the patient is told and approves in the app. */
export async function requestRecordAccess(patientId: string, memberId: string, bookingId: string | null, actor: HealthActor): Promise<void> {
  const [p] = await db.select().from(healthPatients).where(eq(healthPatients.id, patientId));
  if (!p) throw notFound("Patient");
  const memberIds = await sameDoctorMemberIds(memberId);
  if (!memberIds.includes(memberId)) throw notFound("Doctor");
  const label = await doctorLabel(memberId);
  for (const userId of patientAudience(p)) {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.HEALTH_CONSENT,
      title: `${label} asks to see earlier records`,
      body: `${label} asks to see ${p.fullName}'s earlier GoKesari health records for this visit. Open My Health → Privacy to allow it for this visit, always, or not at all.`,
      actionUrl: `/health/privacy?patient=${p.id}&member=${memberId}${bookingId ? `&booking=${bookingId}` : ""}`,
      channels: ["PUSH"],
      metadata: { patientId: p.id, memberId, bookingId },
    });
  }
  await logRecordAccess({ patientId: p.id, actor, actorLabel: label, actorRole: "DOCTOR", action: "VIEW", objectType: "access_request", reason: "Asked to see earlier records" });
}
