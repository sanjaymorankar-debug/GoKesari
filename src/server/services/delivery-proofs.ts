/**
 * NEW-007 photo proof of delivery (rule deliveryProof).
 *
 * The rider takes or uploads a photo at the door; it is validated like every
 * stored image (real type from the bytes — JPEG, PNG or WebP — and the image
 * size limit), stored privately (purpose DELIVERY_PROOF) and linked to the
 * delivery. While the rule is on, markDelivered refuses until a photo exists.
 * The photo is shown only to the order's customer, its shop, the rider who
 * took it, and operations.
 *
 * Gig worker flow (feature 9): the rider may also add an optional photo at
 * pickup (kind PICKUP); it never counts as the door photo the rule asks for.
 *
 * Module 4 (23-Nov-2026): the customer's signature (kind SIGNATURE, a PNG
 * from the signature pad, optional signer name) while rule
 * deliveryProof.signatureEnabled is on; deliveryProof.signatureRequired makes
 * markDelivered wait for it. Same private storage, audit and viewers as the
 * photo. With deliveryProof.captureGps on, the rider's position is kept with
 * the proof (shown to operations only).
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { conflict, forbidden, notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { deliveryOrders, deliveryPartners, deliveryProofs, orders, shops, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { imageUrl, saveImage } from "./image-store";
import { getRule } from "./settings";

export async function isDeliveryProofRequired(): Promise<boolean> {
  return (await getRule("deliveryProof")).photoRequired;
}

export type ProofKind = "PICKUP" | "DELIVERY" | "SIGNATURE";

export interface ProofExtras {
  /** SIGNATURE only: who signed (optional). */
  signerName?: string | null;
  /** Rider's position; kept only while rule deliveryProof.captureGps is on. */
  position?: { latitude: number; longitude: number } | null;
}

/** The signature rules as the rider's screen and markDelivered see them (required only when the pad is on). */
export async function signatureRules(): Promise<{ enabled: boolean; required: boolean }> {
  const rule = await getRule("deliveryProof");
  return { enabled: rule.signatureEnabled, required: rule.signatureEnabled && rule.signatureRequired };
}

/** Trims the optional signer name; blank → null; at most 80 characters. */
export function cleanSignerName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, 80) : null;
}

/**
 * Stores the rider's photo for their own delivery: at the door once picked up
 * (DELIVERY), or — gig worker flow, feature 9 — the optional photo of the
 * parcel at the shop (PICKUP), from acceptance until the drop.
 */
export async function uploadDeliveryProof(
  deliveryOrderId: string,
  rider: { id: string; role: UserRole },
  data: Buffer,
  kind: ProofKind = "DELIVERY",
  extras: ProofExtras = {},
): Promise<{ id: string; url: string; kind: ProofKind }> {
  const rule = await getRule("deliveryProof");
  if (kind === "SIGNATURE" && !rule.signatureEnabled) throw notFound("Signature capture");
  const [row] = await db
    .select({ d: deliveryOrders, riderUserId: deliveryPartners.userId })
    .from(deliveryOrders)
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryOrders.deliveryPartnerId))
    .where(eq(deliveryOrders.id, deliveryOrderId));
  if (!row) throw notFound("Delivery assignment");
  if (row.riderUserId !== rider.id) throw forbidden("This delivery assignment does not belong to you.");
  if (kind === "PICKUP" && row.d.status !== "ACCEPTED" && row.d.status !== "PICKED_UP") {
    throw conflict("A pickup photo can be added once you have accepted the order and before it is delivered.");
  }
  if (kind === "DELIVERY" && row.d.status !== "PICKED_UP") throw conflict("Take the delivery photo once the order is picked up and at the door.");
  if (kind === "SIGNATURE" && row.d.status !== "PICKED_UP") throw conflict("Take the customer's signature once the order is picked up and at the door.");
  const signerName = kind === "SIGNATURE" ? cleanSignerName(extras.signerName) : null;
  const position = rule.captureGps ? validPosition(extras.position) : null;

  return db.transaction(async (tx) => {
    const image = await saveImage(data, { purpose: "DELIVERY_PROOF", ownerId: rider.id }, tx);
    const [proof] = await tx
      .insert(deliveryProofs)
      .values({
        deliveryOrderId,
        orderId: row.d.orderId,
        storedImageId: image.id,
        kind,
        uploadedBy: rider.id,
        signerName,
        latitude: position?.latitude ?? null,
        longitude: position?.longitude ?? null,
      })
      .returning();
    await recordAudit(
      {
        actorId: rider.id,
        actorRole: rider.role,
        action: AUDIT_ACTIONS.DELIVERY_PROOF_UPLOADED,
        entityType: "delivery_order",
        entityId: deliveryOrderId,
        newValue: {
          proofId: proof.id,
          kind,
          bytes: image.sizeBytes,
          contentType: image.contentType,
          ...(signerName ? { signerName } : {}),
          ...(position ? { gps: true } : {}),
        },
      },
      tx,
    );
    return { id: proof.id, url: imageUrl(image.id), kind };
  });
}

/** A finite latitude / longitude pair in range, or null. */
export function validPosition(
  p: { latitude: number; longitude: number } | null | undefined,
): { latitude: number; longitude: number } | null {
  if (!p) return null;
  const { latitude, longitude } = p;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

/**
 * Throws when the rules need a photo (photoRequired) or — Module 4 — a
 * customer signature (signatureEnabled + signatureRequired) and the delivery
 * has none. Called by markDelivered.
 */
export async function assertDeliveryProof(deliveryOrderId: string): Promise<void> {
  const rule = await getRule("deliveryProof");
  if (rule.photoRequired) {
    const [proof] = await db
      .select({ id: deliveryProofs.id })
      .from(deliveryProofs)
      .where(and(eq(deliveryProofs.deliveryOrderId, deliveryOrderId), eq(deliveryProofs.kind, "DELIVERY")))
      .limit(1);
    if (!proof) throw conflict("Take a photo of the order at the door before marking it delivered.");
  }
  if (rule.signatureEnabled && rule.signatureRequired) {
    const [signature] = await db
      .select({ id: deliveryProofs.id })
      .from(deliveryProofs)
      .where(and(eq(deliveryProofs.deliveryOrderId, deliveryOrderId), eq(deliveryProofs.kind, "SIGNATURE")))
      .limit(1);
    if (!signature) throw conflict("Take the customer's signature before marking it delivered.");
  }
}

export async function hasDeliveryProof(deliveryOrderId: string, kind: ProofKind = "DELIVERY"): Promise<boolean> {
  const [proof] = await db
    .select({ id: deliveryProofs.id })
    .from(deliveryProofs)
    .where(and(eq(deliveryProofs.deliveryOrderId, deliveryOrderId), eq(deliveryProofs.kind, kind)))
    .limit(1);
  return Boolean(proof);
}

/** Latest proof photo per order (for order lists): the door photo by default, or the pickup photo. */
export async function proofPhotosForOrders(
  orderIds: string[],
  kind: ProofKind = "DELIVERY",
): Promise<Map<string, { url: string; takenAt: Date }>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({ orderId: deliveryProofs.orderId, imageId: deliveryProofs.storedImageId, createdAt: deliveryProofs.createdAt })
    .from(deliveryProofs)
    .where(and(inArray(deliveryProofs.orderId, orderIds), eq(deliveryProofs.kind, kind)))
    .orderBy(desc(deliveryProofs.createdAt));
  const out = new Map<string, { url: string; takenAt: Date }>();
  for (const r of rows) if (!out.has(r.orderId)) out.set(r.orderId, { url: imageUrl(r.imageId), takenAt: r.createdAt });
  return out;
}

/** Module 4: latest customer signature per order (for order lists), with its time and signer name. */
export async function signaturesForOrders(
  orderIds: string[],
): Promise<Map<string, { url: string; takenAt: Date; signerName: string | null }>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({
      orderId: deliveryProofs.orderId,
      imageId: deliveryProofs.storedImageId,
      createdAt: deliveryProofs.createdAt,
      signerName: deliveryProofs.signerName,
    })
    .from(deliveryProofs)
    .where(and(inArray(deliveryProofs.orderId, orderIds), eq(deliveryProofs.kind, "SIGNATURE")))
    .orderBy(desc(deliveryProofs.createdAt));
  const out = new Map<string, { url: string; takenAt: Date; signerName: string | null }>();
  for (const r of rows) {
    if (!out.has(r.orderId)) out.set(r.orderId, { url: imageUrl(r.imageId), takenAt: r.createdAt, signerName: r.signerName });
  }
  return out;
}

/** May `user` see this proof photo? The order's customer and shop, the rider who took it, operations. */
export async function canViewDeliveryProof(imageId: string, user: { id: string; role: UserRole }): Promise<boolean> {
  if (user.role === "ADMIN" || user.role === "OPERATOR") return true;
  const [row] = await db
    .select({ customerId: orders.userId, shopOwnerId: shops.ownerId, uploadedBy: deliveryProofs.uploadedBy })
    .from(deliveryProofs)
    .innerJoin(orders, eq(orders.id, deliveryProofs.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(and(eq(deliveryProofs.storedImageId, imageId)));
  if (!row) return false;
  return user.id === row.customerId || user.id === row.shopOwnerId || user.id === row.uploadedBy;
}

export interface DeliveryGpsView {
  delivered: { latitude: number; longitude: number; accuracyM: number | null } | null;
  failed: { latitude: number; longitude: number } | null;
}

/**
 * Module 4 (rule deliveryProof.captureGps): where the rider marked each order
 * delivered or failed. Operations only — the admin order view calls this; the
 * customer's and the shop's views never do.
 */
export async function deliveryGpsForOrders(orderIds: string[]): Promise<Map<string, DeliveryGpsView>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({
      orderId: deliveryOrders.orderId,
      deliveredLatitude: deliveryOrders.deliveredLatitude,
      deliveredLongitude: deliveryOrders.deliveredLongitude,
      deliveredAccuracyM: deliveryOrders.deliveredAccuracyM,
      failedLatitude: deliveryOrders.failedLatitude,
      failedLongitude: deliveryOrders.failedLongitude,
    })
    .from(deliveryOrders)
    .where(inArray(deliveryOrders.orderId, orderIds));
  const out = new Map<string, DeliveryGpsView>();
  for (const r of rows) {
    const delivered =
      r.deliveredLatitude != null && r.deliveredLongitude != null
        ? { latitude: r.deliveredLatitude, longitude: r.deliveredLongitude, accuracyM: r.deliveredAccuracyM }
        : null;
    const failed =
      r.failedLatitude != null && r.failedLongitude != null ? { latitude: r.failedLatitude, longitude: r.failedLongitude } : null;
    if (delivered || failed) out.set(r.orderId, { delivered, failed });
  }
  return out;
}
