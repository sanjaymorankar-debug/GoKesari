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

export type ProofKind = "PICKUP" | "DELIVERY";

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
): Promise<{ id: string; url: string; kind: ProofKind }> {
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

  return db.transaction(async (tx) => {
    const image = await saveImage(data, { purpose: "DELIVERY_PROOF", ownerId: rider.id }, tx);
    const [proof] = await tx
      .insert(deliveryProofs)
      .values({ deliveryOrderId, orderId: row.d.orderId, storedImageId: image.id, kind, uploadedBy: rider.id })
      .returning();
    await recordAudit(
      {
        actorId: rider.id,
        actorRole: rider.role,
        action: AUDIT_ACTIONS.DELIVERY_PROOF_UPLOADED,
        entityType: "delivery_order",
        entityId: deliveryOrderId,
        newValue: { proofId: proof.id, kind, bytes: image.sizeBytes, contentType: image.contentType },
      },
      tx,
    );
    return { id: proof.id, url: imageUrl(image.id), kind };
  });
}

/** Throws when the rule needs a photo and the delivery has none. Called by markDelivered. */
export async function assertDeliveryProof(deliveryOrderId: string): Promise<void> {
  if (!(await isDeliveryProofRequired())) return;
  const [proof] = await db
    .select({ id: deliveryProofs.id })
    .from(deliveryProofs)
    .where(and(eq(deliveryProofs.deliveryOrderId, deliveryOrderId), eq(deliveryProofs.kind, "DELIVERY")))
    .limit(1);
  if (!proof) throw conflict("Take a photo of the order at the door before marking it delivered.");
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
