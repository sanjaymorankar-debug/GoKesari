/**
 * C5 — rider photos, identity documents and the rider ID card.
 *
 *  - Photos (stored_images purpose PROFILE_PHOTO) open only for the rider,
 *    staff who manage riders, and the staff of a verified society that lists
 *    the rider (rule riderFiles.protectPhotos). They are never public.
 *  - Identity documents (purpose RIDER_KYC_DOC, table
 *    delivery_partner_documents) open only for an admin, always, and each
 *    opening is audited. The rider sees type, date and review status only.
 *  - The ID card shows photo, name, rider ID and the societies that list the
 *    rider, so the gate can check it.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import {
  deliveryPartnerDocuments,
  deliveryPartners,
  societies,
  societyMembers,
  societyRiders,
  storedImages,
  type DeliveryPartner,
  type DeliveryPartnerDocument,
  type StoredImage,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { saveImage } from "./image-store";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

export const RIDER_DOC_TYPES = ["AADHAAR", "PAN", "DRIVING_LICENCE", "VEHICLE_RC", "OTHER"] as const;
export type RiderDocType = (typeof RIDER_DOC_TYPES)[number];
export const RIDER_DOC_LABELS: Record<RiderDocType, string> = {
  AADHAAR: "Aadhaar card",
  PAN: "PAN card",
  DRIVING_LICENCE: "Driving licence",
  VEHICLE_RC: "Vehicle registration (RC)",
  OTHER: "Other identity document",
};

/** The rider ID printed on the card: stable, short, derived from the partner id (not a link). */
export function riderDisplayId(partnerId: string): string {
  return `GKR-${partnerId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

const IMAGE_PATH = /^\/api\/images\/([0-9a-f-]{36})$/i;

/** The stored image id of an uploaded photo link, or null for an outside link / none. */
export function uploadedPhotoId(url: string | null | undefined): string | null {
  const match = url ? IMAGE_PATH.exec(url) : null;
  return match ? match[1] : null;
}

/**
 * A rider's photo link must be their own uploaded photo. With protectPhotos
 * on, outside (https) links are refused so the photo can never sit at a
 * public address; off, they are accepted as before.
 */
export async function assertRiderPhotoUrl(url: string | null, userId: string): Promise<void> {
  if (!url) return;
  const imageId = uploadedPhotoId(url);
  // An /api/images/ path that is not an image id serves nothing (the image
  // route refuses it), so it exposes nothing: accepted as before.
  if (!imageId && url.startsWith("/api/images/")) return;
  if (!imageId) {
    if ((await getRule("riderFiles")).protectPhotos) {
      throw validationFailed("Upload your photo here — links to photos elsewhere are not accepted.");
    }
    return;
  }
  const [image] = await db
    .select({ ownerId: storedImages.ownerId, purpose: storedImages.purpose })
    .from(storedImages)
    .where(eq(storedImages.id, imageId));
  if (!image || image.ownerId !== userId || image.purpose !== "PROFILE_PHOTO") {
    throw validationFailed("Upload your own photo.");
  }
}

/** Who may open a rider's photo (rule riderFiles.protectPhotos on). */
export async function canViewRiderPhoto(image: Pick<StoredImage, "id" | "ownerId">, user: Actor): Promise<boolean> {
  if (image.ownerId && user.id === image.ownerId) return true;
  if (can(user.role, PERMISSIONS.DELIVERY_PARTNER_MANAGE)) return true;
  if (!image.ownerId) return false;
  // Society staff, for a rider their verified society lists — so the gate can check the face.
  const [row] = await db
    .select({ id: societyRiders.id })
    .from(deliveryPartners)
    .innerJoin(societyRiders, eq(societyRiders.deliveryPartnerId, deliveryPartners.id))
    .innerJoin(societies, eq(societies.id, societyRiders.societyId))
    .innerJoin(societyMembers, eq(societyMembers.societyId, societies.id))
    .where(
      and(
        eq(deliveryPartners.userId, image.ownerId),
        eq(societyRiders.status, "ACTIVE"),
        eq(societies.status, "VERIFIED"),
        eq(societyMembers.userId, user.id),
        eq(societyMembers.status, "ACTIVE"),
        inArray(societyMembers.role, ["ADMIN", "OPERATOR"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Identity document files: admins only, whatever the rule says. Each opening is audited. */
export async function canViewRiderKycFile(imageId: string, user: Actor): Promise<boolean> {
  if (user.role !== "ADMIN") return false;
  const [doc] = await db
    .select({ id: deliveryPartnerDocuments.id, partnerId: deliveryPartnerDocuments.deliveryPartnerId })
    .from(deliveryPartnerDocuments)
    .where(eq(deliveryPartnerDocuments.storedImageId, imageId));
  if (!doc) return false;
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_DOCUMENT_VIEWED,
    entityType: "delivery_partner_document",
    entityId: doc.id,
    newValue: { deliveryPartnerId: doc.partnerId },
  });
  return true;
}

async function myPartner(userId: string): Promise<DeliveryPartner> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner || partner.deletedAt) throw notFound("Delivery partner profile");
  return partner;
}

export interface RiderDocumentView {
  id: string;
  docType: RiderDocType;
  label: string;
  status: DeliveryPartnerDocument["status"];
  rejectionReason: string | null;
  createdAt: Date;
}

const toView = (d: DeliveryPartnerDocument): RiderDocumentView => ({
  id: d.id,
  docType: d.docType,
  label: RIDER_DOC_LABELS[d.docType],
  status: d.status,
  rejectionReason: d.rejectionReason,
  createdAt: d.createdAt,
});

/** A rider uploads (or replaces) one identity document. */
export async function uploadMyRiderDocument(userId: string, role: UserRole, docType: string, data: Buffer): Promise<RiderDocumentView> {
  if (!(await getRule("riderFiles")).kycDocuments) throw forbidden("Document upload is not available.");
  if (!(RIDER_DOC_TYPES as readonly string[]).includes(docType)) throw validationFailed("Choose the document type.");
  const partner = await myPartner(userId);
  if (partner.status === "DEACTIVATED") throw conflict("This profile has been deactivated.");

  const doc = await db.transaction(async (tx) => {
    const image = await saveImage(data, { purpose: "RIDER_KYC_DOC", ownerId: userId }, tx);
    await tx
      .update(deliveryPartnerDocuments)
      .set({ replacedAt: new Date() })
      .where(
        and(
          eq(deliveryPartnerDocuments.deliveryPartnerId, partner.id),
          eq(deliveryPartnerDocuments.docType, docType as RiderDocType),
          isNull(deliveryPartnerDocuments.replacedAt),
        ),
      );
    const [row] = await tx
      .insert(deliveryPartnerDocuments)
      .values({ deliveryPartnerId: partner.id, docType: docType as RiderDocType, storedImageId: image.id, uploadedBy: userId })
      .returning();
    return row;
  });
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_DOCUMENT_UPLOADED,
    entityType: "delivery_partner_document",
    entityId: doc.id,
    newValue: { deliveryPartnerId: partner.id, docType },
  });
  return toView(doc);
}

/** The rider's current documents — type, date and status, never the file. */
export async function listMyRiderDocuments(userId: string): Promise<RiderDocumentView[]> {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner) return [];
  const rows = await db
    .select()
    .from(deliveryPartnerDocuments)
    .where(and(eq(deliveryPartnerDocuments.deliveryPartnerId, partner.id), isNull(deliveryPartnerDocuments.replacedAt)))
    .orderBy(desc(deliveryPartnerDocuments.createdAt));
  return rows.map(toView);
}

export interface AdminRiderDocument extends RiderDocumentView {
  deliveryPartnerId: string;
  riderName: string;
  riderMobile: string;
  riderStatus: DeliveryPartner["status"];
  riderId: string;
  /** Admin-only, access-checked link (/api/images/{id}). */
  fileUrl: string;
}

/** Admin review list of current identity documents. */
export async function listRiderDocumentsForAdmin(actor: Actor, status?: DeliveryPartnerDocument["status"]): Promise<AdminRiderDocument[]> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can see rider identity documents.");
  const rows = await db
    .select({ doc: deliveryPartnerDocuments, partner: deliveryPartners })
    .from(deliveryPartnerDocuments)
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryPartnerDocuments.deliveryPartnerId))
    .where(
      and(
        isNull(deliveryPartnerDocuments.replacedAt),
        status ? eq(deliveryPartnerDocuments.status, status) : undefined,
      ),
    )
    .orderBy(desc(deliveryPartnerDocuments.createdAt))
    .limit(300);
  return rows.map(({ doc, partner }) => ({
    ...toView(doc),
    deliveryPartnerId: partner.id,
    riderName: partner.fullName,
    riderMobile: partner.mobile,
    riderStatus: partner.status,
    riderId: riderDisplayId(partner.id),
    fileUrl: `/api/images/${doc.storedImageId}`,
  }));
}

/** Admin accepts or rejects one document. */
export async function decideRiderDocument(
  documentId: string,
  decision: "ACCEPTED" | "REJECTED",
  reason: string | null,
  actor: Actor,
): Promise<RiderDocumentView> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can review rider identity documents.");
  if (decision === "REJECTED" && !reason?.trim()) throw validationFailed("Say why the document is rejected.");
  const current = await db.query.deliveryPartnerDocuments.findFirst({ where: eq(deliveryPartnerDocuments.id, documentId) });
  if (!current || current.replacedAt) throw notFound("Document");
  const [row] = await db
    .update(deliveryPartnerDocuments)
    .set({
      status: decision,
      rejectionReason: decision === "REJECTED" ? reason!.trim() : null,
      reviewedBy: actor.id,
      reviewedAt: new Date(),
    })
    .where(eq(deliveryPartnerDocuments.id, documentId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DELIVERY_PARTNER_DOCUMENT_DECIDED,
    entityType: "delivery_partner_document",
    entityId: documentId,
    previousValue: { status: current.status },
    newValue: { status: decision },
  });
  return toView(row);
}

export interface RiderIdCard {
  riderId: string;
  fullName: string;
  /** Access-checked photo link; null when no photo was uploaded here. */
  photoUrl: string | null;
  vehicleType: string;
  vehicleRegistrationNumber: string | null;
  status: DeliveryPartner["status"];
  /** Verified societies whose rider list includes this rider. */
  societies: { name: string; area: string | null; city: string; preferred: boolean }[];
  issuedAt: Date;
}

/** The rider's own ID card; null when the rule is off or the rider is not approved. */
export async function getMyRiderIdCard(userId: string): Promise<RiderIdCard | null> {
  const rule = await getRule("riderFiles");
  if (!rule.idCard) return null;
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, userId) });
  if (!partner || partner.deletedAt || partner.status !== "APPROVED") return null;
  const listed = await db
    .select({ name: societies.name, area: societies.area, city: societies.city, preferred: societyRiders.preferred })
    .from(societyRiders)
    .innerJoin(societies, eq(societies.id, societyRiders.societyId))
    .where(
      and(
        eq(societyRiders.deliveryPartnerId, partner.id),
        eq(societyRiders.status, "ACTIVE"),
        eq(societies.status, "VERIFIED"),
        isNull(societies.deletedAt),
      ),
    )
    .orderBy(societies.name);
  return {
    riderId: riderDisplayId(partner.id),
    fullName: partner.fullName,
    // With photos protected only an uploaded (access-checked) photo is shown.
    photoUrl: uploadedPhotoId(partner.profilePhotoUrl) || !rule.protectPhotos ? partner.profilePhotoUrl : null,
    vehicleType: partner.vehicleType,
    vehicleRegistrationNumber: partner.vehicleRegistrationNumber,
    status: partner.status,
    societies: listed,
    issuedAt: new Date(),
  };
}
