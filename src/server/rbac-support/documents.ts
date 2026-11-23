/**
 * RBAC v2 document management (brief §9; docs/rbac/05-documents.md).
 *
 *   Upload        Support (shops of tickets assigned to them), Support / Operations managers, Operations Users (shops they
 *                 onboarded), admins. Type is read from the bytes (PDF, JPEG, PNG, WebP; CSV / XLSX for price lists and
 *                 catalogues), never from the name; size within rule documentUpload.maxUploadBytes. No virus scanner
 *                 exists on the platform: the type check stands in for it and a scanner is a recorded follow-up.
 *   Versions      a new upload of the same document is version n+1; earlier versions are kept and never changed.
 *   Download      only through a signed link valid for LINK_MINUTES, issued to someone who may see the document.
 *   Verify        a Support Manager or admin marks a document verified / rejected.
 *   Delete        nobody below admin deletes; an admin's delete is a DOCUMENT_DELETE request a second admin approves
 *                 (then the document and all its versions are removed).
 * The shop owner sees the documents of their own shop.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import {
  shopProducts,
  shops,
  staffDocuments,
  staffDocumentVersions,
  supportTickets,
  STAFF_DOC_TYPES,
  type StaffDocType,
  type StaffDocument,
  type UserRole,
} from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { registerApprovalHandler, submitApproval } from "@/server/approvals/engine";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { requireFeatureForRole } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

interface Actor {
  id: string;
  role: UserRole;
}

export const DOCUMENT_DELETE = "DOCUMENT_DELETE";
export const LINK_MINUTES = 10;

/* -------------------------------------------------------------- file type */

export function detectStaffFile(data: Buffer, filename: string): string | null {
  if (data.length > 5 && data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length > 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  // XLSX is a ZIP container: accept only with the .xlsx name.
  if (data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04 && /\.xlsx$/i.test(filename)) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  // CSV: printable UTF-8 text only (no control bytes other than tab / CR / LF), with the .csv name.
  if (/\.csv$/i.test(filename)) {
    const head = data.subarray(0, Math.min(data.length, 4096));
    if (head.every((b) => b === 9 || b === 10 || b === 13 || b >= 32)) return "text/csv";
  }
  return null;
}

/* ----------------------------------------------------------------- access */

async function canWorkOnShop(shopId: string, actor: Actor): Promise<boolean> {
  if (actor.role === "ADMIN" || can(actor.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE) || can(actor.role, PERMISSIONS.OPS_TEAM_MANAGE)) return true;
  if (can(actor.role, PERMISSIONS.SUPPORT_TICKET_WORK_ASSIGNED)) {
    const [t] = await db.select({ id: supportTickets.id }).from(supportTickets).where(and(eq(supportTickets.shopId, shopId), eq(supportTickets.assignedToUserId, actor.id))).limit(1);
    if (t) return true;
  }
  if (can(actor.role, PERMISSIONS.OPS_TASK_WORK_OWN)) {
    const [s] = await db.select({ by: shops.onboardedByUserId }).from(shops).where(eq(shops.id, shopId));
    if (s?.by === actor.id) return true;
  }
  return false;
}

async function canSee(doc: StaffDocument, actor: Actor): Promise<boolean> {
  if (await canWorkOnShop(doc.shopId, actor)) return true;
  const [s] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, doc.shopId));
  return s?.ownerId === actor.id;
}

/* ----------------------------------------------------------------- upload */

export interface UploadInput {
  shopId: string;
  shopProductId?: string | null;
  documentId?: string | null;
  docType: StaffDocType;
  title: string;
  filename: string;
  data: Buffer;
  ticketId?: string | null;
}

export async function uploadStaffDocument(input: UploadInput, actor: Actor): Promise<{ document: StaffDocument; version: number }> {
  await requireFeatureForRole("rbac_v2_support", actor.role);
  if (!STAFF_DOC_TYPES.includes(input.docType)) throw validationFailed("Choose the document type.");
  if (!(await canWorkOnShop(input.shopId, actor))) throw forbidden("You cannot add documents to this shop.");
  if (input.data.length === 0) throw validationFailed("The file is empty.");
  const { maxUploadBytes } = await getRule("documentUpload");
  if (input.data.length > maxUploadBytes) throw validationFailed(`A file can be at most ${(maxUploadBytes / 1_000_000).toFixed(1)} MB.`);
  const contentType = detectStaffFile(input.data, input.filename);
  if (!contentType) throw validationFailed("Upload a PDF, JPEG, PNG or WebP file, or a price list as .csv / .xlsx.");
  if (input.shopProductId) {
    const [sp] = await db.select({ shopId: shopProducts.shopId }).from(shopProducts).where(eq(shopProducts.id, input.shopProductId));
    if (!sp || sp.shopId !== input.shopId) throw validationFailed("That product is not in this shop.");
  }
  const sha256 = createHash("sha256").update(input.data).digest("hex");
  const filename = input.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "document";

  return db.transaction(async (tx) => {
    let doc: StaffDocument;
    let version = 1;
    if (input.documentId) {
      const [current] = await tx.select().from(staffDocuments).where(eq(staffDocuments.id, input.documentId)).for("update");
      if (!current || current.status !== "ACTIVE") throw notFound("Document");
      if (current.shopId !== input.shopId) throw validationFailed("That document belongs to another shop.");
      version = current.currentVersion + 1;
      [doc] = await tx
        .update(staffDocuments)
        .set({ currentVersion: version, verificationStatus: "UNVERIFIED", verifiedBy: null, verifiedAt: null })
        .where(eq(staffDocuments.id, current.id))
        .returning();
    } else {
      const title = input.title.trim();
      if (title.length < 2) throw validationFailed("Give the document a title.");
      [doc] = await tx
        .insert(staffDocuments)
        .values({ shopId: input.shopId, shopProductId: input.shopProductId ?? null, docType: input.docType, title: title.slice(0, 200), ticketId: input.ticketId ?? null, createdBy: actor.id })
        .returning();
    }
    await tx.insert(staffDocumentVersions).values({ documentId: doc.id, version, filename, contentType, sizeBytes: input.data.length, sha256, data: input.data, uploadedBy: actor.id });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STAFF_DOCUMENT_UPLOADED, entityType: "staff_document", entityId: doc.id, newValue: { version, filename, contentType, sizeBytes: input.data.length, sha256 } }, tx);
    return { document: doc, version };
  });
}

/* ------------------------------------------------------------------ reads */

export async function listShopDocuments(shopId: string, actor: Actor) {
  const docs = await db.select().from(staffDocuments).where(and(eq(staffDocuments.shopId, shopId), eq(staffDocuments.status, "ACTIVE"))).orderBy(desc(staffDocuments.createdAt));
  if (docs.length && !(await canSee(docs[0], actor))) throw forbidden("You cannot see this shop's documents.");
  if (!docs.length && !(await canWorkOnShop(shopId, actor))) {
    const [s] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
    if (s?.ownerId !== actor.id) throw forbidden("You cannot see this shop's documents.");
  }
  const versions = await db
    .select({
      documentId: staffDocumentVersions.documentId,
      version: staffDocumentVersions.version,
      filename: staffDocumentVersions.filename,
      contentType: staffDocumentVersions.contentType,
      sizeBytes: staffDocumentVersions.sizeBytes,
      uploadedBy: staffDocumentVersions.uploadedBy,
      uploadedAt: staffDocumentVersions.uploadedAt,
    })
    .from(staffDocumentVersions)
    .innerJoin(staffDocuments, eq(staffDocuments.id, staffDocumentVersions.documentId))
    .where(eq(staffDocuments.shopId, shopId))
    .orderBy(desc(staffDocumentVersions.version));
  return docs.map((d) => ({ ...d, versions: versions.filter((v) => v.documentId === d.id) }));
}

/* ------------------------------------------------------------ signed links */

function sign(payload: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET).update(`staff-doc:${payload}`).digest("base64url");
}

/** A link valid for LINK_MINUTES to one version, for someone allowed to see it. */
export async function issueDownloadLink(documentId: string, version: number | null, actor: Actor): Promise<{ url: string; expiresAt: Date }> {
  const [doc] = await db.select().from(staffDocuments).where(eq(staffDocuments.id, documentId));
  if (!doc || doc.status !== "ACTIVE") throw notFound("Document");
  if (!(await canSee(doc, actor))) throw notFound("Document");
  const v = version ?? doc.currentVersion;
  const expiresAt = new Date(Date.now() + LINK_MINUTES * 60_000);
  const payload = `${documentId}.${v}.${Math.floor(expiresAt.getTime() / 1000)}.${actor.id}`;
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STAFF_DOCUMENT_LINK, entityType: "staff_document", entityId: documentId, newValue: { version: v } });
  return { url: `/api/staff/documents/file?t=${encodeURIComponent(`${payload}.${sign(payload)}`)}`, expiresAt };
}

/** Reads a signed link: the file, or NOT_FOUND for a bad, expired or deleted one. */
export async function readByLink(token: string): Promise<{ filename: string; contentType: string; data: Buffer }> {
  const parts = token.split(".");
  if (parts.length !== 5) throw notFound("Document");
  const [documentId, version, exp, userId, mac] = parts;
  const payload = `${documentId}.${version}.${exp}.${userId}`;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw notFound("Document");
  if (Number(exp) * 1000 < Date.now()) throw notFound("Document");
  const [doc] = await db.select().from(staffDocuments).where(eq(staffDocuments.id, documentId));
  if (!doc || doc.status !== "ACTIVE") throw notFound("Document");
  const [row] = await db
    .select()
    .from(staffDocumentVersions)
    .where(and(eq(staffDocumentVersions.documentId, documentId), eq(staffDocumentVersions.version, Number(version))));
  if (!row) throw notFound("Document");
  return { filename: row.filename, contentType: row.contentType, data: row.data };
}

/* ------------------------------------------------------------------ verify */

export async function verifyStaffDocument(documentId: string, status: "VERIFIED" | "REJECTED", actor: Actor): Promise<StaffDocument> {
  if (actor.role !== "ADMIN" && !can(actor.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE)) throw forbidden("Only a Support Manager or admin verifies documents.");
  const [doc] = await db
    .update(staffDocuments)
    .set({ verificationStatus: status, verifiedBy: actor.id, verifiedAt: new Date() })
    .where(and(eq(staffDocuments.id, documentId), eq(staffDocuments.status, "ACTIVE")))
    .returning();
  if (!doc) throw notFound("Document");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STAFF_DOCUMENT_VERIFIED, entityType: "staff_document", entityId: documentId, newValue: { status } });
  return doc;
}

/* ------------------------------------------------------------------ delete */

export async function requestDocumentDeletion(documentId: string, reason: string, actor: Actor) {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can ask for a document to be deleted.");
  const [doc] = await db.select().from(staffDocuments).where(eq(staffDocuments.id, documentId));
  if (!doc || doc.status !== "ACTIVE") throw notFound("Document");
  return submitApproval({
    type: DOCUMENT_DELETE,
    actor,
    subjectType: "staff_document",
    subjectId: doc.id,
    shopId: null,
    title: `Delete document "${doc.title}" (${doc.currentVersion} version${doc.currentVersion === 1 ? "" : "s"})`,
    reason,
    payload: { documentId: doc.id },
  });
}

registerApprovalHandler({
  type: DOCUMENT_DELETE,
  checker: "ADMIN",
  async apply(context) {
    const documentId = String(context.request.payload.documentId);
    await db.transaction(async (tx) => {
      const [doc] = await tx.select().from(staffDocuments).where(eq(staffDocuments.id, documentId)).for("update");
      if (!doc) throw notFound("Document");
      if (doc.status !== "ACTIVE") throw conflict("Already deleted.");
      // Two admins agreed: the file bytes go; the document row stays as a DELETED record of what existed.
      await tx.delete(staffDocumentVersions).where(eq(staffDocumentVersions.documentId, documentId));
      await tx.update(staffDocuments).set({ status: "DELETED", deletedBy: context.request.requestedBy, deletedAt: new Date() }).where(eq(staffDocuments.id, documentId));
      await recordAudit(
        { actorId: context.decidedBy.id, actorRole: context.decidedBy.role, action: AUDIT_ACTIONS.STAFF_DOCUMENT_DELETED, entityType: "staff_document", entityId: documentId, previousValue: { title: doc.title, versions: doc.currentVersion }, newValue: { requestedBy: context.request.requestedBy } },
        tx,
      );
    });
  },
});
