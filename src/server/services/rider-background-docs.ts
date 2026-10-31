/**
 * Police verification form and character certificate (gig worker flow,
 * feature 3, docs/gig-worker-2026-10).
 *
 *  - PDF, JPG or PNG only, decided from the file's bytes (never the name or
 *    the declared type); at most `riderVerification.maxDocumentBytes`.
 *  - Private storage: the file is encrypted (AES-256-GCM, lib/pan-crypto.ts)
 *    in `delivery_partner_background_docs`, never in a public bucket or under
 *    a public link. Only an admin can open it, and each opening is audited.
 *  - Review: Uploaded → Under review → Approved / Rejected (with a reason).
 *    A new upload of the same type replaces the current one and starts again
 *    at Uploaded.
 */
import { createHash } from "node:crypto";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import {
  deliveryPartnerBackgroundDocs,
  deliveryPartners,
  type DeliveryPartner,
  type DeliveryPartnerBackgroundDoc,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { detectImage } from "./image-store";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

export const BACKGROUND_DOC_TYPES = ["POLICE_VERIFICATION", "CHARACTER_CERTIFICATE"] as const;
export type BackgroundDocType = (typeof BACKGROUND_DOC_TYPES)[number];
export const BACKGROUND_DOC_LABELS: Record<BackgroundDocType, string> = {
  POLICE_VERIFICATION: "Police verification form",
  CHARACTER_CERTIFICATE: "Character certificate",
};
export type BackgroundDocStatus = DeliveryPartnerBackgroundDoc["status"];
export const BACKGROUND_DOC_STATUS_LABELS: Record<BackgroundDocStatus, string> = {
  UPLOADED: "Uploaded",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

type AllowedType = DeliveryPartnerBackgroundDoc["contentType"];

/** PDF, JPEG or PNG from the bytes; anything else (WebP, HEIC, a renamed file) is null. */
export function detectBackgroundDocFile(data: Buffer): AllowedType | null {
  if (data.length > 5 && data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  const image = detectImage(data)?.contentType;
  return image === "image/jpeg" || image === "image/png" ? image : null;
}

export interface BackgroundDocView {
  id: string;
  docType: BackgroundDocType;
  label: string;
  status: BackgroundDocStatus;
  statusLabel: string;
  rejectionReason: string | null;
  contentType: AllowedType;
  sizeBytes: number;
  createdAt: Date;
  reviewedAt: Date | null;
}

const toView = (d: DeliveryPartnerBackgroundDoc): BackgroundDocView => ({
  id: d.id,
  docType: d.docType,
  label: BACKGROUND_DOC_LABELS[d.docType],
  status: d.status,
  statusLabel: BACKGROUND_DOC_STATUS_LABELS[d.status],
  rejectionReason: d.rejectionReason,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes,
  createdAt: d.createdAt,
  reviewedAt: d.reviewedAt,
});

/** The columns every list reads: never the file itself. */
const META = {
  id: deliveryPartnerBackgroundDocs.id,
  deliveryPartnerId: deliveryPartnerBackgroundDocs.deliveryPartnerId,
  docType: deliveryPartnerBackgroundDocs.docType,
  status: deliveryPartnerBackgroundDocs.status,
  rejectionReason: deliveryPartnerBackgroundDocs.rejectionReason,
  contentType: deliveryPartnerBackgroundDocs.contentType,
  sizeBytes: deliveryPartnerBackgroundDocs.sizeBytes,
  sha256: deliveryPartnerBackgroundDocs.sha256,
  uploadedBy: deliveryPartnerBackgroundDocs.uploadedBy,
  reviewedBy: deliveryPartnerBackgroundDocs.reviewedBy,
  reviewedAt: deliveryPartnerBackgroundDocs.reviewedAt,
  replacedAt: deliveryPartnerBackgroundDocs.replacedAt,
  createdAt: deliveryPartnerBackgroundDocs.createdAt,
  updatedAt: deliveryPartnerBackgroundDocs.updatedAt,
};
type DocMeta = Omit<DeliveryPartnerBackgroundDoc, "dataEncrypted">;
const metaView = (d: DocMeta) => toView({ ...d, dataEncrypted: Buffer.alloc(0) });

async function myPartner(userId: string): Promise<DeliveryPartner> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner || partner.deletedAt) throw notFound("Delivery partner profile");
  return partner;
}

/** The partner uploads (or replaces) one document. */
export async function uploadMyBackgroundDoc(userId: string, role: UserRole, docType: string, data: Buffer): Promise<BackgroundDocView> {
  if (!(BACKGROUND_DOC_TYPES as readonly string[]).includes(docType)) throw validationFailed("Choose the document type.");
  const partner = await myPartner(userId);
  if (partner.status === "DEACTIVATED") throw conflict("This profile has been closed.");
  if (data.length === 0) throw validationFailed("The file is empty.");
  const { maxDocumentBytes } = await getRule("riderVerification");
  if (data.length > maxDocumentBytes) {
    throw validationFailed(`The file can be at most ${(maxDocumentBytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB.`);
  }
  const contentType = detectBackgroundDocFile(data);
  if (!contentType) throw validationFailed("Upload a PDF, JPG or PNG file.");

  const type = docType as BackgroundDocType;
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    await tx
      .update(deliveryPartnerBackgroundDocs)
      .set({ replacedAt: now, updatedAt: now })
      .where(
        and(
          eq(deliveryPartnerBackgroundDocs.deliveryPartnerId, partner.id),
          eq(deliveryPartnerBackgroundDocs.docType, type),
          isNull(deliveryPartnerBackgroundDocs.replacedAt),
        ),
      );
    const [inserted] = await tx
      .insert(deliveryPartnerBackgroundDocs)
      .values({
        deliveryPartnerId: partner.id,
        docType: type,
        contentType,
        sizeBytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        dataEncrypted: encryptBytes(data),
        uploadedBy: userId,
      })
      .returning(META);
    return inserted;
  });
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_BACKGROUND_DOC_UPLOADED,
    entityType: "delivery_partner_background_doc",
    entityId: row.id,
    newValue: { deliveryPartnerId: partner.id, docType: type, contentType, sizeBytes: data.length },
  });
  return metaView(row);
}

/** The partner's current documents: type, status and reason — never the file. */
export async function listMyBackgroundDocs(userId: string): Promise<BackgroundDocView[]> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner) return [];
  const rows = await db
    .select(META)
    .from(deliveryPartnerBackgroundDocs)
    .where(and(eq(deliveryPartnerBackgroundDocs.deliveryPartnerId, partner.id), isNull(deliveryPartnerBackgroundDocs.replacedAt)))
    .orderBy(desc(deliveryPartnerBackgroundDocs.createdAt));
  return rows.map(metaView);
}

/** Police verification (and, with the rule, the character certificate) Approved — half of the availability gate. */
export async function isRiderBackgroundApproved(partnerId: string): Promise<boolean> {
  const { requireCharacterCertificate } = await getRule("riderVerification");
  const needed: BackgroundDocType[] = requireCharacterCertificate ? ["POLICE_VERIFICATION", "CHARACTER_CERTIFICATE"] : ["POLICE_VERIFICATION"];
  const rows = await db
    .select({ docType: deliveryPartnerBackgroundDocs.docType })
    .from(deliveryPartnerBackgroundDocs)
    .where(
      and(
        eq(deliveryPartnerBackgroundDocs.deliveryPartnerId, partnerId),
        isNull(deliveryPartnerBackgroundDocs.replacedAt),
        eq(deliveryPartnerBackgroundDocs.status, "APPROVED"),
        inArray(deliveryPartnerBackgroundDocs.docType, needed),
      ),
    );
  const approved = new Set(rows.map((r) => r.docType));
  return needed.every((t) => approved.has(t));
}

/* -------------------------------------------------------------------- admin */

export interface AdminBackgroundDoc extends BackgroundDocView {
  deliveryPartnerId: string;
  riderName: string;
  riderMobile: string;
  /** Admin-only, access-checked and audited. */
  fileUrl: string;
}

export async function listBackgroundDocsForAdmin(actor: Actor, status?: BackgroundDocStatus): Promise<AdminBackgroundDoc[]> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can see police verification documents.");
  const rows = await db
    .select({ doc: META, name: deliveryPartners.fullName, mobile: deliveryPartners.mobile })
    .from(deliveryPartnerBackgroundDocs)
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryPartnerBackgroundDocs.deliveryPartnerId))
    .where(and(isNull(deliveryPartnerBackgroundDocs.replacedAt), status ? eq(deliveryPartnerBackgroundDocs.status, status) : undefined))
    .orderBy(desc(deliveryPartnerBackgroundDocs.createdAt))
    .limit(300);
  return rows.map(({ doc, name, mobile }) => ({
    ...metaView(doc),
    deliveryPartnerId: doc.deliveryPartnerId,
    riderName: name,
    riderMobile: mobile,
    fileUrl: `/api/admin/rider-background-docs/${doc.id}/file`,
  }));
}

const ALLOWED_MOVES: Record<BackgroundDocStatus, readonly BackgroundDocStatus[]> = {
  UPLOADED: ["UNDER_REVIEW", "APPROVED", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["REJECTED"],
  REJECTED: ["APPROVED"],
};

/** Admin moves a document on: start review, approve, or reject with a reason. */
export async function decideBackgroundDoc(
  docId: string,
  to: Exclude<BackgroundDocStatus, "UPLOADED">,
  reason: string | null,
  actor: Actor,
): Promise<BackgroundDocView> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can review police verification documents.");
  const why = reason?.trim() || null;
  if (to === "REJECTED" && !why) throw validationFailed("Give a reason for rejecting the document.");
  const [current] = await db.select(META).from(deliveryPartnerBackgroundDocs).where(eq(deliveryPartnerBackgroundDocs.id, docId));
  if (!current || current.replacedAt) throw notFound("Document");
  if (!ALLOWED_MOVES[current.status].includes(to)) {
    throw conflict(`A document that is ${BACKGROUND_DOC_STATUS_LABELS[current.status].toLowerCase()} can't move to ${BACKGROUND_DOC_STATUS_LABELS[to].toLowerCase()}.`);
  }
  const now = new Date();
  const [row] = await db
    .update(deliveryPartnerBackgroundDocs)
    .set({ status: to, rejectionReason: to === "REJECTED" ? why : null, reviewedBy: actor.id, reviewedAt: now, updatedAt: now })
    .where(and(eq(deliveryPartnerBackgroundDocs.id, docId), eq(deliveryPartnerBackgroundDocs.status, current.status)))
    .returning(META);
  if (!row) throw conflict("Someone else changed this document just now. Reload and try again.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_BACKGROUND_DOC_DECIDED,
    entityType: "delivery_partner_background_doc",
    entityId: docId,
    previousValue: { status: current.status },
    newValue: { status: to, ...(why ? { reason: why } : {}) },
  });
  if (to === "APPROVED" || to === "REJECTED") {
    const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, current.deliveryPartnerId) });
    if (partner) {
      const label = BACKGROUND_DOC_LABELS[current.docType];
      await notify({
        userId: partner.userId,
        type: NOTIFICATION_TYPES.DELIVERY_PARTNER_BACKGROUND_DOC_DECIDED,
        title: to === "APPROVED" ? `${label} approved` : `${label} rejected`,
        body: to === "APPROVED" ? `Your ${label.toLowerCase()} has been approved.` : `${why} Upload a new one from Documents.`,
        actionUrl: "/delivery-partner/documents",
      });
    }
  }
  return metaView(row);
}

/** The file, for an admin only. Every opening is audited. */
export async function getBackgroundDocFile(docId: string, actor: Actor): Promise<{ contentType: string; data: Buffer; fileName: string }> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can open this document.");
  const doc = await db.query.deliveryPartnerBackgroundDocs.findFirst({ where: eq(deliveryPartnerBackgroundDocs.id, docId) });
  if (!doc) throw notFound("Document");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_BACKGROUND_DOC_VIEWED,
    entityType: "delivery_partner_background_doc",
    entityId: doc.id,
    newValue: { deliveryPartnerId: doc.deliveryPartnerId, docType: doc.docType },
  });
  const extension = doc.contentType === "application/pdf" ? "pdf" : doc.contentType === "image/png" ? "png" : "jpg";
  return { contentType: doc.contentType, data: decryptBytes(doc.dataEncrypted), fileName: `${doc.docType.toLowerCase()}-${doc.id.slice(0, 8)}.${extension}` };
}
