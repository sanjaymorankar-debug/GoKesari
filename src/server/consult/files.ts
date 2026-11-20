/**
 * Consultant appointments: private files (prescriptions, case papers,
 * registration certificates). Stored AES-GCM encrypted in the database;
 * served only through a short-lived signed link (HMAC of file, viewer and
 * expiry with AUTH_SECRET) that is checked again against the viewer's
 * session and access rights; every download by the firm or staff is logged.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { consultBookingFiles, consultBookings, consultMemberDocuments, consultMembers } from "@/server/db/schema";
import { detectDocumentFile } from "@/server/services/seller-verification";
import { getRule } from "@/server/services/settings";
import { bookingViewer, isConsultStaff, logPrivateAccess, requireFirmAccess, type ConsultActor } from "./access";

const LINK_SECONDS = 300;

function sign(kind: "booking" | "member", fileId: string, viewerId: string, exp: number): string {
  return createHmac("sha256", getEnv().AUTH_SECRET).update(`consult-file:${kind}:${fileId}:${viewerId}:${exp}`).digest("base64url");
}

/** A link valid for five minutes, for this viewer only. */
export function signedFileUrl(kind: "booking" | "member", fileId: string, viewerId: string, now: Date = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + LINK_SECONDS;
  return `/api/consult/files/${kind}/${fileId}?exp=${exp}&sig=${sign(kind, fileId, viewerId, exp)}`;
}

export function checkSignature(kind: "booking" | "member", fileId: string, viewerId: string, exp: number, sig: string, now: Date = new Date()): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(now.getTime() / 1000)) return false;
  const want = Buffer.from(sign(kind, fileId, viewerId, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export async function uploadBookingFile(bookingId: string, file: { name: string; bytes: Buffer }, actor: ConsultActor): Promise<{ id: string; signedUrl: string }> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) throw notFound("Booking");
  const { viewer, firm } = await bookingViewer(b, actor);
  if (viewer === "STAFF") throw forbidden("Staff cannot add files to a booking.");
  if (b.status === "EXPIRED") throw validationFailed("This booking has lapsed.");
  const rule = await getRule("consultBooking");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(consultBookingFiles).where(eq(consultBookingFiles.bookingId, b.id));
  if (n >= rule.maxFilesPerBooking) throw validationFailed(`At most ${rule.maxFilesPerBooking} files per booking.`);
  if (!file.bytes.length) throw validationFailed("Choose a file.");
  if (file.bytes.length > rule.maxFileBytes) throw validationFailed(`The file is too large (${Math.round(rule.maxFileBytes / 1_000_000)} MB at most).`);
  const contentType = detectDocumentFile(file.bytes);
  if (!contentType) throw validationFailed("Upload a PDF, JPEG, PNG or WebP file.");
  const side = viewer === "CUSTOMER" && !(firm && b.customerId !== actor.id) ? "CUSTOMER" : "CONSULTANT";
  const [row] = await db
    .insert(consultBookingFiles)
    .values({ bookingId: b.id, uploadedBy: actor.id, uploaderSide: side, fileName: file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file", contentType, sizeBytes: file.bytes.length, data: encryptBytes(file.bytes) })
    .returning({ id: consultBookingFiles.id });
  await logPrivateAccess({ bookingId: b.id, fileId: row.id, actor, action: "FILE_UPLOADED" });
  return { id: row.id, signedUrl: signedFileUrl("booking", row.id, actor.id) };
}

/** Signed links for a booking's files, for whoever may see the booking. */
export async function bookingFileLinks(bookingId: string, actor: ConsultActor): Promise<{ id: string; fileName: string; url: string }[]> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) throw notFound("Booking");
  await bookingViewer(b, actor);
  const rows = await db.select({ id: consultBookingFiles.id, fileName: consultBookingFiles.fileName }).from(consultBookingFiles).where(eq(consultBookingFiles.bookingId, b.id)).orderBy(asc(consultBookingFiles.createdAt));
  return rows.map((r) => ({ id: r.id, fileName: r.fileName, url: signedFileUrl("booking", r.id, actor.id) }));
}

export async function readBookingFile(fileId: string, actor: ConsultActor, ip?: string | null): Promise<{ contentType: string; fileName: string; data: Buffer }> {
  const [f] = await db.select().from(consultBookingFiles).where(eq(consultBookingFiles.id, fileId));
  if (!f) throw notFound("File");
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, f.bookingId));
  if (!b) throw notFound("File");
  const { viewer } = await bookingViewer(b, actor);
  if (viewer !== "CUSTOMER" || b.customerId !== actor.id) await logPrivateAccess({ bookingId: b.id, fileId: f.id, actor, action: viewer === "STAFF" ? "STAFF_DOWNLOADED_FILE" : "FIRM_DOWNLOADED_FILE", ipAddress: ip ?? null });
  return { contentType: f.contentType, fileName: f.fileName, data: decryptBytes(f.data) };
}

/** A member's latest registration certificate: the firm, or staff verifying it. */
export async function readMemberDocument(documentId: string, actor: ConsultActor, ip?: string | null): Promise<{ contentType: string; fileName: string; data: Buffer }> {
  const [d] = await db.select({ doc: consultMemberDocuments, shopId: consultMembers.shopId }).from(consultMemberDocuments).innerJoin(consultMembers, eq(consultMembers.id, consultMemberDocuments.memberId)).where(eq(consultMemberDocuments.id, documentId));
  if (!d) throw notFound("Document");
  if (!isConsultStaff(actor)) await requireFirmAccess(d.shopId, actor, "setup").catch(() => requireFirmAccess(d.shopId, actor, "bookings"));
  await logPrivateAccess({ memberDocumentId: d.doc.id, actor, action: isConsultStaff(actor) ? "STAFF_VIEWED_REGISTRATION" : "FIRM_VIEWED_REGISTRATION", ipAddress: ip ?? null });
  return { contentType: d.doc.contentType, fileName: d.doc.fileName, data: decryptBytes(d.doc.data) };
}

export async function memberDocumentLinks(memberId: string, actor: ConsultActor): Promise<{ id: string; fileName: string; url: string; createdAt: string }[]> {
  const rows = await db.select({ id: consultMemberDocuments.id, fileName: consultMemberDocuments.fileName, createdAt: consultMemberDocuments.createdAt }).from(consultMemberDocuments).where(eq(consultMemberDocuments.memberId, memberId)).orderBy(asc(consultMemberDocuments.createdAt));
  return rows.map((r) => ({ id: r.id, fileName: r.fileName, url: signedFileUrl("member", r.id, actor.id), createdAt: r.createdAt.toISOString() }));
}
