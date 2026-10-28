/**
 * "Complete your profile" for a self-registered shop (Module 3): owner name,
 * address, shop type and GSTIN, after the shop went live on payment. The
 * GSTIN is checked through the GSP first (an invalid, unknown or cancelled
 * GSTIN is refused; the legal name, status and state are shown, and a state
 * that differs from the address is warned) and then saved through the
 * existing GST flow, where operations confirm it as before. Categories, PAN
 * and the map location use their existing pages.
 *
 * The profile counts as complete with owner name, address, PIN code, shop
 * type and at least one product category. A shop that sells food also needs
 * a valid FSSAI licence on file (Task 3, docs/document-upload-2026-10; rule
 * documentUpload.fssaiMandatoryForFood — with it off, the old "remind only"
 * behaviour returns).
 */
import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { gstState } from "@/lib/gst-states";
import { SHOP_TYPE_KEY_PATTERN } from "@/lib/shop-types";
import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shopProductCategories, shops, type UserRole } from "@/server/db/schema";
import { checkGstin, type GstinCheck } from "@/server/gst/gstin";
import { resolveLocationVerification } from "@/server/services/geocoding";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { submitGstin } from "@/server/services/gst-pan-verification";
import { fssaiBlocksRegistration, fssaiStatus } from "@/server/services/document-uploads";
import { shopSellsFood } from "@/server/services/seller-verification";
import { assertShopType } from "@/server/services/shop-types";
import { recordShopAttributionSafely } from "@/server/dealers/attribution";

type Actor = { id: string; role: UserRole };

export const profileSetupSchema = z.object({
  ownerName: z.string().trim().min(2, "Enter the owner's name.").max(100),
  addressLine1: z.string().trim().min(3, "Enter the shop's address.").max(200),
  addressLine2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(2, "Enter the city or town.").max(80),
  state: z.string().trim().max(60).nullish(),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "PIN code must be 6 digits and not start with 0."),
  shopType: z.string().regex(SHOP_TYPE_KEY_PATTERN),
  gstin: z.string().trim().max(20).nullish(),
  // docs/nearby-referral-2026-10: the shop's map pin (map or "use my current location"), so it shows in Nearby.
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
});

async function loadShop(shopId: string, actor: Actor) {
  const [shop] = await db.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  if (shop.ownerId !== actor.id && !can(actor.role, PERMISSIONS.SHOP_UPDATE_ANY)) throw forbidden("This shop does not belong to you.");
  return shop;
}

export async function profileSetupView(shopId: string, actor: Actor) {
  const shop = await loadShop(shopId, actor);
  const [{ n }] = await db.select({ n: count() }).from(shopProductCategories).where(eq(shopProductCategories.shopId, shopId));
  const missing: string[] = [];
  if (!shop.ownerName.trim()) missing.push("owner name");
  if (!shop.addressLine1.trim() || !shop.city.trim() || !/^\d{6}$/.test(shop.pincode)) missing.push("address");
  if (Number(n) === 0) missing.push("product categories");
  const sellsFood = await shopSellsFood(shop);
  // Task 3 (docs/document-upload-2026-10): with documentUpload.fssaiMandatoryForFood on, a food
  // shop's profile is not complete until a valid (unexpired) FSSAI licence is on file.
  const fssaiBlocker = await fssaiBlocksRegistration(shop);
  if (fssaiBlocker) missing.push("FSSAI licence");
  const fssai = await fssaiStatus(shop);
  return {
    shop: {
      id: shop.id,
      name: shop.name,
      registrationNumber: shop.registrationNumber,
      ownerName: shop.ownerName,
      addressLine1: shop.addressLine1,
      addressLine2: shop.addressLine2,
      city: shop.city,
      state: shop.state,
      pincode: shop.pincode,
      shopType: shop.shopType,
      gstin: shop.gstin,
      gstStatus: shop.gstStatus,
      panStatus: shop.panStatus,
      locationVerified: shop.locationVerified,
      latitude: shop.latitude,
      longitude: shop.longitude,
      onboardingChannel: shop.onboardingChannel,
      profileCompletedAt: shop.profileCompletedAt,
    },
    categories: Number(n),
    missing,
    fssai: { needed: sellsFood, onFile: fssai.onFile || Boolean(shop.fssaiLicenseNumber), ...(fssaiBlocker ? { blocker: fssaiBlocker } : {}) },
  };
}

export interface ProfileSaveResult {
  complete: boolean;
  missing: string[];
  gstin: GstinCheck | null;
  warnings: string[];
}

export async function saveProfileSetup(shopId: string, input: z.infer<typeof profileSetupSchema>, actor: Actor): Promise<ProfileSaveResult> {
  const shop = await loadShop(shopId, actor);
  const warnings: string[] = [];
  let gstinCheck: GstinCheck | null = null;
  const gstin = input.gstin?.replace(/\s+/g, "").toUpperCase() || null;
  if (gstin && gstin !== shop.gstin) {
    gstinCheck = await checkGstin(gstin, actor);
    if (!gstinCheck.ok && gstinCheck.reason === "FORMAT") throw validationFailed(gstinCheck.message);
    if (gstinCheck.ok && !gstinCheck.found) throw validationFailed("No GST registration was found for this GSTIN. Check the number.");
    if (gstinCheck.ok && !gstinCheck.active) throw validationFailed(`This GSTIN is ${gstinCheck.status?.toLowerCase() ?? "not active"} on the GST portal and cannot be used.`);
    if (!gstinCheck.ok) warnings.push(gstinCheck.message);
    const addressState = gstState(input.state ?? null);
    const gstinStateCode = gstin.slice(0, 2);
    if (addressState && addressState.code !== gstinStateCode) {
      warnings.push(`The GSTIN is registered in ${gstState(gstinStateCode)?.name ?? `state ${gstinStateCode}`}, but the address is in ${addressState.name}. A shop's GSTIN must be from the state it sells from.`);
    }
  }

  if (input.shopType !== shop.shopType) await assertShopType(input.shopType);

  const now = new Date();
  // A new pin is checked the same way as everywhere else (Google when configured; otherwise kept, not verified).
  const pinMoved =
    input.latitude != null && input.longitude != null && (String(input.latitude) !== shop.latitude || String(input.longitude) !== shop.longitude);
  const location = pinMoved
    ? {
        latitude: String(input.latitude),
        longitude: String(input.longitude),
        ...(await resolveLocationVerification(input.latitude, input.longitude, "shop_profile_setup", "shop", shopId)),
      }
    : {};
  await db
    .update(shops)
    .set({
      ...location,
      ownerName: input.ownerName,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2 ?? null,
      city: input.city,
      state: input.state ?? null,
      pincode: input.pincode,
      shopType: input.shopType,
      statusActorId: actor.id,
      updatedAt: now,
    })
    .where(eq(shops.id, shopId));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_UPDATED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { ownerName: shop.ownerName, city: shop.city, pincode: shop.pincode, shopType: shop.shopType },
    newValue: {
      ownerName: input.ownerName,
      city: input.city,
      pincode: input.pincode,
      shopType: input.shopType,
      ...(pinMoved ? { latitude: String(input.latitude), longitude: String(input.longitude) } : {}),
      via: "profile-setup",
    },
  });
  // Saved through the existing GST flow (operations confirm it there).
  if (gstin && gstin !== shop.gstin) await submitGstin(shopId, gstin, actor);

  const view = await profileSetupView(shopId, actor);
  const complete = view.missing.length === 0;
  if (complete && !shop.profileCompletedAt) {
    await db.update(shops).set({ profileCompletedAt: now }).where(and(eq(shops.id, shopId), isNull(shops.profileCompletedAt)));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SHOP_PROFILE_COMPLETED, entityType: "shop", entityId: shopId });
    // docs/dealer-programme: a self-registered shop gets its PIN code (district) only now.
    await recordShopAttributionSafely(shopId, actor);
  }
  return { complete, missing: view.missing, gstin: gstinCheck, warnings };
}
