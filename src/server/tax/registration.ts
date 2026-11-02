/**
 * The shop's GST registration type (billing v2, docs/billing §3.1, gap G5).
 * A shop with a GSTIN is REGULAR or COMPOSITION by its verified GST status
 * (shop GST / PAN form → admin or provider verification). A shop without one
 * declares here whether it holds a GST Enrolment ID (an unregistered seller
 * of goods through an e-commerce operator, Notification 34/2023: intra-state
 * only, no TCS) or is a PAN-only service provider (rule
 * billing.panOnlyServiceRule). The engine reads the result through
 * effectiveRegistrationType.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { conflict, notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { effectiveRegistrationType, type GstRegistrationType } from "./engine";

export const registrationInput = z.object({
  /** BY_GSTIN: follow the GSTIN and its verified status (the default). */
  type: z.enum(["BY_GSTIN", "ENROLMENT_ID", "PAN_ONLY_SERVICE"]),
  enrolmentId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-Z]{15}$/, "An Enrolment ID has 15 letters and digits.")
    .nullable()
    .optional(),
});

export interface ShopRegistration {
  type: GstRegistrationType;
  declared: "BY_GSTIN" | "ENROLMENT_ID" | "PAN_ONLY_SERVICE";
  enrolmentId: string | null;
  hasGstin: boolean;
}

const view = (shop: typeof shops.$inferSelect): ShopRegistration => ({
  type: effectiveRegistrationType(shop),
  declared: shop.gstRegistrationType === "ENROLMENT_ID" || shop.gstRegistrationType === "PAN_ONLY_SERVICE" ? shop.gstRegistrationType : "BY_GSTIN",
  enrolmentId: shop.gstEnrolmentId,
  hasGstin: Boolean(shop.gstin) && shop.gstStatus !== "NOT_REGISTERED" && shop.gstStatus !== "VERIFICATION_FAILED",
});

export async function getShopRegistration(shopId: string): Promise<ShopRegistration> {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  return view(shop);
}

export async function setShopRegistration(shopId: string, raw: z.input<typeof registrationInput>, actor: { id: string }): Promise<ShopRegistration> {
  const input = registrationInput.parse(raw);
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  if (input.type !== "BY_GSTIN" && view(shop).hasGstin) {
    throw conflict("This shop has a GSTIN, so it is registered under GST: its type follows the GSTIN (regular or composition). Remove the GSTIN first if it was entered by mistake.");
  }
  if (input.type === "ENROLMENT_ID" && !input.enrolmentId) throw conflict("Enter the 15-character Enrolment ID from the GST portal.");
  // "UNREGISTERED" stored = follow the GSTIN and gst_status (effectiveRegistrationType).
  const stored: GstRegistrationType = input.type === "BY_GSTIN" ? "UNREGISTERED" : input.type;
  const [updated] = await db
    .update(shops)
    .set({ gstRegistrationType: stored, gstEnrolmentId: input.type === "ENROLMENT_ID" ? input.enrolmentId! : null, updatedAt: new Date() })
    .where(eq(shops.id, shopId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    action: AUDIT_ACTIONS.SHOP_UPDATED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { gstRegistrationType: shop.gstRegistrationType, gstEnrolmentId: shop.gstEnrolmentId },
    newValue: { gstRegistrationType: stored, gstEnrolmentId: updated.gstEnrolmentId },
  });
  return view(updated);
}
