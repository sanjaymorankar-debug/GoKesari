/**
 * GoKesari Health: the patient's record views (owner brief §2.3) — Timeline, By provider, Medicines,
 * Reports and documents — plus uploads, expiring share links and the full-record PDF.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { notFound, validationFailed } from "@/lib/errors";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABELS, DOCUMENT_SOURCE_LABELS, TIMELINE_KIND_LABELS, type DocumentKind, type DocumentSource, type TimelineKind } from "@/lib/health/constants";
import { PdfDocument, mm, wrapText } from "@/lib/health/pdf-writer";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import {
  consultMembers,
  healthConsultations,
  healthDocuments,
  healthPatients,
  healthPrescriptionItems,
  healthPrescriptions,
  healthShareLinks,
  healthSuggestions,
  healthTimeline,
  shops,
  type HealthPatient,
  type HealthTimelineRow,
} from "@/server/db/schema";
import { detectDocumentFile } from "@/server/services/seller-verification";
import { getRule } from "@/server/services/settings";
import { logRecordAccess, patientAudience, requirePatientAccess, type HealthActor } from "./access";
import { publishHealthEvent } from "./events";
import type { RxContent } from "./rx-pdf";
import { addTimeline, timelineFor } from "./timeline";

/* ------------------------------------------------------------ views */

export async function recordTimeline(patientId: string, actor: HealthActor, opts: { kind?: TimelineKind | null; q?: string | null } = {}): Promise<HealthTimelineRow[]> {
  const p = await requirePatientAccess(patientId, actor);
  return timelineFor(p.id, opts);
}

export interface ProviderGroup {
  key: string;
  name: string;
  clinic: string | null;
  memberId: string | null;
  shopId: string | null;
  lastAt: Date;
  items: HealthTimelineRow[];
}

/** Every doctor / provider the patient has seen, each with their visits, prescriptions, notes and reports. */
export async function recordByProvider(patientId: string, actor: HealthActor): Promise<ProviderGroup[]> {
  const rows = await recordTimeline(patientId, actor);
  const memberIds = [...new Set(rows.map((r) => r.providerMemberId).filter((v): v is string => Boolean(v)))];
  const names = memberIds.length
    ? await db.select({ id: consultMembers.id, name: consultMembers.name, clinic: shops.name, shopId: shops.id }).from(consultMembers).innerJoin(shops, eq(shops.id, consultMembers.shopId)).where(inArray(consultMembers.id, memberIds))
    : [];
  const groups = new Map<string, ProviderGroup>();
  for (const r of rows) {
    if (!r.providerMemberId && !r.providerShopId) continue;
    const key = r.providerMemberId ?? `shop:${r.providerShopId}`;
    let g = groups.get(key);
    if (!g) {
      const n = names.find((x) => x.id === r.providerMemberId);
      g = { key, name: n?.name ?? r.providerName ?? "Provider", clinic: n?.clinic ?? null, memberId: r.providerMemberId, shopId: n?.shopId ?? r.providerShopId, lastAt: r.occurredAt, items: [] };
      groups.set(key, g);
    }
    g.items.push(r);
    if (r.occurredAt > g.lastAt) g.lastAt = r.occurredAt;
  }
  return [...groups.values()].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
}

export interface MedicineRow {
  itemId: string;
  prescriptionId: string;
  rxNumber: string;
  name: string;
  generic: string;
  strength: string | null;
  form: string;
  dose: string;
  frequency: string;
  timing: string;
  durationDays: number;
  quantity: number;
  dispensedQty: number;
  start: string;
  end: string;
  current: boolean;
  doctor: string;
  instructions: string | null;
}

/** Current and past medicines from GoKesari prescriptions (latest version only); current ones first. */
export async function recordMedicines(patientId: string, actor: HealthActor, now: Date = new Date()): Promise<MedicineRow[]> {
  const p = await requirePatientAccess(patientId, actor);
  const rows = await db
    .select({ i: healthPrescriptionItems, rx: healthPrescriptions })
    .from(healthPrescriptionItems)
    .innerJoin(healthPrescriptions, eq(healthPrescriptions.id, healthPrescriptionItems.prescriptionId))
    .where(and(eq(healthPrescriptions.patientId, p.id), eq(healthPrescriptions.status, "ISSUED")))
    .orderBy(desc(healthPrescriptions.issuedAt), asc(healthPrescriptionItems.lineNo));
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const out = rows.map((r) => {
    const start = new Date(r.rx.issuedAt.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const endDate = new Date(new Date(`${start}T00:00:00Z`).getTime() + Math.max(0, r.i.durationDays - 1) * 86_400_000).toISOString().slice(0, 10);
    const content = r.rx.content as unknown as RxContent;
    return {
      itemId: r.i.id,
      prescriptionId: r.rx.id,
      rxNumber: r.rx.rxNumber,
      name: r.i.brandName ?? r.i.genericName,
      generic: r.i.genericName,
      strength: r.i.strength,
      form: r.i.form,
      dose: r.i.dose,
      frequency: r.i.frequency,
      timing: r.i.timing,
      durationDays: r.i.durationDays,
      quantity: r.i.quantity,
      dispensedQty: r.i.dispensedQty,
      start,
      end: endDate,
      current: r.i.durationDays > 0 && endDate >= today,
      doctor: content.doctor.name,
      instructions: r.i.instructions,
    };
  });
  return out.sort((a, b) => Number(b.current) - Number(a.current) || b.start.localeCompare(a.start));
}

export interface DocumentRow {
  id: string;
  title: string;
  kind: string;
  kindLabel: string;
  source: string;
  sourceLabel: string;
  documentDate: string | null;
  providerName: string | null;
  fileName: string;
  sizeBytes: number;
  createdAt: Date;
}

export async function recordDocuments(patientId: string, actor: HealthActor, kind?: DocumentKind | null): Promise<DocumentRow[]> {
  const p = await requirePatientAccess(patientId, actor);
  const rows = await db
    .select({ id: healthDocuments.id, title: healthDocuments.title, kind: healthDocuments.kind, source: healthDocuments.source, documentDate: healthDocuments.documentDate, providerName: healthDocuments.providerName, fileName: healthDocuments.fileName, sizeBytes: healthDocuments.sizeBytes, createdAt: healthDocuments.createdAt })
    .from(healthDocuments)
    .where(and(eq(healthDocuments.patientId, p.id), isNull(healthDocuments.hiddenAt), kind ? eq(healthDocuments.kind, kind) : undefined))
    .orderBy(desc(sql`coalesce(${healthDocuments.documentDate}, ${healthDocuments.createdAt}::date)`), desc(healthDocuments.createdAt));
  return rows.map((r) => ({ ...r, kindLabel: DOCUMENT_KIND_LABELS[r.kind as DocumentKind] ?? r.kind, sourceLabel: DOCUMENT_SOURCE_LABELS[r.source as DocumentSource] ?? r.source }));
}

/* ------------------------------------------------------------ uploads */

export const uploadInput = z.object({
  title: z.string().trim().min(2, "Give the document a name.").max(160),
  kind: z.enum(DOCUMENT_KINDS),
  documentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  providerName: z.string().trim().max(160).nullish(),
});

/** A patient uploads an older report (tagged "patient uploaded"); stored AES-GCM encrypted. */
export async function uploadPatientDocument(patientId: string, raw: unknown, file: { name: string; bytes: Buffer }, actor: HealthActor, now: Date = new Date()): Promise<{ id: string }> {
  const input = uploadInput.parse(raw);
  const p = await requirePatientAccess(patientId, actor);
  const rule = await getRule("health");
  if (!file.bytes.length) throw validationFailed("Choose a file.");
  if (file.bytes.length > rule.maxDocumentBytes) throw validationFailed(`The file is too large (${Math.round(rule.maxDocumentBytes / 1_000_000)} MB at most).`);
  const contentType = detectDocumentFile(file.bytes);
  if (!contentType) throw validationFailed("Upload a PDF, JPEG, PNG or WebP file.");
  const [row] = await db
    .insert(healthDocuments)
    .values({
      patientId: p.id,
      uploadedBy: actor.id,
      source: "PATIENT",
      kind: input.kind,
      title: input.title,
      documentDate: input.documentDate ?? null,
      providerName: input.providerName ?? null,
      fileName: file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "document",
      contentType,
      sizeBytes: file.bytes.length,
      data: encryptBytes(file.bytes),
      createdAt: now,
    })
    .returning({ id: healthDocuments.id });
  await addTimeline(db, {
    patientId: p.id,
    occurredAt: input.documentDate ? new Date(`${input.documentDate}T06:30:00Z`) : now,
    kind: "DOCUMENT",
    title: `${DOCUMENT_KIND_LABELS[input.kind]}: ${input.title}`,
    summary: `Patient uploaded${input.providerName ? ` (from ${input.providerName})` : ""}.`,
    providerName: input.providerName ?? null,
    refType: "document",
    refId: row.id,
    meta: { source: "PATIENT", kind: input.kind },
  });
  await publishHealthEvent({ name: "record.added", userIds: patientAudience(p), subjectId: p.id, payload: { documentId: row.id } });
  return row;
}

/** A document's bytes for the patient (download / view). Logged. */
export async function readPatientDocument(documentId: string, actor: HealthActor, ip?: string | null): Promise<{ contentType: string; fileName: string; data: Buffer }> {
  const [d] = await db.select().from(healthDocuments).where(eq(healthDocuments.id, documentId));
  if (!d || d.hiddenAt) throw notFound("Document");
  await requirePatientAccess(d.patientId, actor);
  await logRecordAccess({ patientId: d.patientId, actor, actorLabel: "You", action: "DOWNLOAD", objectType: "document", objectId: d.id, ipAddress: ip ?? null });
  return { contentType: d.contentType, fileName: d.fileName, data: decryptBytes(d.data) };
}

/** Hides a patient-uploaded document (other sources are part of the medical record and stay). */
export async function hidePatientDocument(documentId: string, actor: HealthActor): Promise<void> {
  const [d] = await db.select().from(healthDocuments).where(eq(healthDocuments.id, documentId));
  if (!d) throw notFound("Document");
  await requirePatientAccess(d.patientId, actor);
  if (d.source !== "PATIENT") throw validationFailed("Only documents you uploaded can be removed.");
  const now = new Date();
  await db.update(healthDocuments).set({ hiddenAt: now }).where(eq(healthDocuments.id, d.id));
  await db.update(healthTimeline).set({ hiddenAt: now }).where(and(eq(healthTimeline.refType, "document"), eq(healthTimeline.refId, d.id)));
}

/* ------------------------------------------------------------ share links */

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** A link to one prescription or document that works for shareLinkHours (rule), for anyone holding it. */
export async function createShareLink(patientId: string, objectType: "PRESCRIPTION" | "DOCUMENT", objectId: string, actor: HealthActor, now: Date = new Date()): Promise<{ url: string; expiresAt: Date }> {
  const p = await requirePatientAccess(patientId, actor);
  if (objectType === "PRESCRIPTION") {
    const [rx] = await db.select({ patientId: healthPrescriptions.patientId }).from(healthPrescriptions).where(eq(healthPrescriptions.id, objectId));
    if (!rx || rx.patientId !== p.id) throw notFound("Prescription");
  } else {
    const [d] = await db.select({ patientId: healthDocuments.patientId }).from(healthDocuments).where(eq(healthDocuments.id, objectId));
    if (!d || d.patientId !== p.id) throw notFound("Document");
  }
  const rule = await getRule("health");
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(now.getTime() + rule.shareLinkHours * 3_600_000);
  await db.insert(healthShareLinks).values({ tokenHash: hashToken(token), patientId: p.id, objectType, objectId, createdBy: actor.id, expiresAt });
  await logRecordAccess({ patientId: p.id, actor, actorLabel: "You", action: "SHARE", objectType: objectType.toLowerCase(), objectId, reason: `Link valid until ${expiresAt.toISOString()}` });
  return { url: `/api/health/share/${token}`, expiresAt };
}

/** Opens a share link (no sign-in needed). Logged in the patient's access log. */
export async function openShareLink(token: string, ip?: string | null, now: Date = new Date()): Promise<{ contentType: string; fileName: string; data: Buffer }> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound("Link");
  const [link] = await db.select().from(healthShareLinks).where(eq(healthShareLinks.tokenHash, hashToken(token)));
  if (!link || link.revokedAt || link.expiresAt.getTime() < now.getTime()) throw notFound("Link");
  await db.update(healthShareLinks).set({ openCount: sql`${healthShareLinks.openCount} + 1` }).where(eq(healthShareLinks.id, link.id));
  await logRecordAccess({ patientId: link.patientId, actor: null, actorLabel: "Someone with your share link", actorRole: "SHARE_LINK", action: "VIEW", objectType: link.objectType.toLowerCase(), objectId: link.objectId, ipAddress: ip ?? null });
  if (link.objectType === "PRESCRIPTION") {
    const [rx] = await db.select({ pdf: healthPrescriptions.pdf, rxNumber: healthPrescriptions.rxNumber, version: healthPrescriptions.version }).from(healthPrescriptions).where(eq(healthPrescriptions.id, link.objectId));
    if (!rx?.pdf) throw notFound("Prescription");
    return { contentType: "application/pdf", fileName: `${rx.rxNumber}${rx.version > 1 ? `-v${rx.version}` : ""}.pdf`, data: decryptBytes(rx.pdf) };
  }
  const [d] = await db.select().from(healthDocuments).where(eq(healthDocuments.id, link.objectId));
  if (!d || d.hiddenAt) throw notFound("Document");
  return { contentType: d.contentType, fileName: d.fileName, data: decryptBytes(d.data) };
}

export async function revokeShareLinks(patientId: string, actor: HealthActor): Promise<number> {
  const p = await requirePatientAccess(patientId, actor);
  const rows = await db.update(healthShareLinks).set({ revokedAt: new Date() }).where(and(eq(healthShareLinks.patientId, p.id), isNull(healthShareLinks.revokedAt))).returning({ id: healthShareLinks.id });
  return rows.length;
}

/* ------------------------------------------------------------ full record PDF */

function istDate(at: Date): string {
  const d = new Date(at.getTime() + 330 * 60_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** The whole record of one person as a PDF (profile, medicines, timeline, documents list). Logged as EXPORT. */
export async function recordPdf(patientId: string, actor: HealthActor, now: Date = new Date()): Promise<{ pdf: Buffer; filename: string }> {
  const p: HealthPatient = await requirePatientAccess(patientId, actor);
  const timeline = await timelineFor(p.id, { limit: 2000 });
  const meds = await recordMedicines(p.id, actor, now);
  const docs = await recordDocuments(p.id, actor);
  const doc = new PdfDocument({ title: `Health record - ${p.fullName}`, author: "GoKesari Health" });
  let page = doc.addPageMm("A4");
  const x0 = mm(15);
  const x1 = mm(195);
  let y = mm(297 - 15);
  const line = (text: string, opts: { size?: number; bold?: boolean; indent?: number; grey?: boolean } = {}) => {
    const size = opts.size ?? 9.5;
    for (const l of wrapText(text, size, x1 - x0 - (opts.indent ?? 0), opts.bold ? "bold" : "regular")) {
      if (y < mm(18)) {
        page = doc.addPageMm("A4");
        y = mm(297 - 15);
      }
      page.text(x0 + (opts.indent ?? 0), y, l, { size, font: opts.bold ? "bold" : "regular", color: opts.grey ? [0.4, 0.4, 0.4] : undefined });
      y -= size * 1.35;
    }
  };
  line(`GoKesari Health record: ${p.fullName}`, { size: 15, bold: true });
  line(`Downloaded ${istDate(now)} by the account holder. Record kept since ${istDate(p.recordStartAt)}.`, { grey: true });
  y -= 6;
  line("Profile", { size: 11, bold: true });
  line(`Date of birth: ${p.dateOfBirth ?? "-"}   Gender: ${p.gender ?? "-"}   Blood group: ${p.bloodGroup ?? "-"}${p.abhaNumber ? `   ABHA: ${p.abhaNumber}` : ""}`);
  line(`Allergies: ${p.allergies.join(", ") || "none recorded"}`);
  line(`Long-term conditions: ${p.conditions.join(", ") || "none recorded"}`);
  if (p.currentMedicines) line(`Medicines (self-reported): ${p.currentMedicines}`);
  if (p.emergencyName) line(`Emergency contact: ${p.emergencyName}${p.emergencyRelation ? ` (${p.emergencyRelation})` : ""} ${p.emergencyPhone ?? ""}`);
  y -= 6;
  line("Medicines from GoKesari prescriptions", { size: 11, bold: true });
  if (!meds.length) line("None.", { grey: true });
  for (const m of meds) line(`${m.current ? "[current] " : ""}${m.name}${m.strength ? ` ${m.strength}` : ""} - ${m.dose}, ${m.frequency}, ${m.durationDays} days (${m.start} to ${m.end}) - ${m.doctor}, ${m.rxNumber}`);
  y -= 6;
  line("Timeline (newest first)", { size: 11, bold: true });
  for (const t of timeline) {
    line(`${istDate(t.occurredAt)}  ${TIMELINE_KIND_LABELS[t.kind as TimelineKind] ?? t.kind}: ${t.title}`, { bold: true, size: 9 });
    if (t.summary) line(t.summary, { indent: 12, size: 9, grey: true });
  }
  y -= 6;
  line("Reports and documents", { size: 11, bold: true });
  if (!docs.length) line("None.", { grey: true });
  for (const d of docs) line(`${d.documentDate ?? istDate(d.createdAt)}  ${d.kindLabel}: ${d.title} (${d.sourceLabel}${d.providerName ? `, ${d.providerName}` : ""})`);
  doc.pages.forEach((pg, i) => pg.textRight(x1, mm(8), `GoKesari Health - ${p.fullName} - page ${i + 1} of ${doc.pages.length}`, { size: 7, color: [0.5, 0.5, 0.5] }));
  await logRecordAccess({ patientId: p.id, actor, actorLabel: "You", action: "EXPORT", objectType: "full_record" });
  return { pdf: doc.build(), filename: `health-record-${p.fullName.replace(/[^A-Za-z0-9]+/g, "-")}.pdf` };
}

/* ------------------------------------------------------------ suggestions for the patient */

export async function patientSuggestions(patientId: string, actor: HealthActor) {
  const p = await requirePatientAccess(patientId, actor);
  return db
    .select({ s: healthSuggestions, doctor: consultMembers.name, clinic: shops.name, rxNumber: healthPrescriptions.rxNumber, consultationDate: healthConsultations.startedAt })
    .from(healthSuggestions)
    .innerJoin(consultMembers, eq(consultMembers.id, healthSuggestions.memberId))
    .innerJoin(shops, eq(shops.id, consultMembers.shopId))
    .leftJoin(healthPrescriptions, eq(healthPrescriptions.id, healthSuggestions.prescriptionId))
    .innerJoin(healthConsultations, eq(healthConsultations.id, healthSuggestions.consultationId))
    .where(eq(healthSuggestions.patientId, p.id))
    .orderBy(desc(healthSuggestions.createdAt));
}

export async function setSuggestionShare(suggestionId: string, share: boolean, actor: HealthActor): Promise<void> {
  const [s] = await db.select().from(healthSuggestions).where(eq(healthSuggestions.id, suggestionId));
  if (!s) throw notFound("Suggestion");
  await requirePatientAccess(s.patientId, actor);
  await db.update(healthSuggestions).set({ shareRecords: share }).where(eq(healthSuggestions.id, s.id));
}

export async function dismissSuggestion(suggestionId: string, actor: HealthActor): Promise<void> {
  const [s] = await db.select().from(healthSuggestions).where(eq(healthSuggestions.id, suggestionId));
  if (!s) throw notFound("Suggestion");
  await requirePatientAccess(s.patientId, actor);
  if (s.status === "OPEN") await db.update(healthSuggestions).set({ status: "CANCELLED" }).where(eq(healthSuggestions.id, s.id));
}

export { healthPatients };
