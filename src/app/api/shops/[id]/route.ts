/**
 * A single shop's own editable details — name/contact/address, shop type,
 * "shop time" (opening hours) and delivery settings. Status and classification are NOT here:
 * those go through /approve, /reject and /classification (§8, §10).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  deliveryFeePaiseSchema,
  freeDeliveryAbovePaiseSchema,
  minOrderPaiseSchema,
  openingHoursSchema,
  optionalText,
  preparationMinutesSchema,
  requiredText,
  shopImageUrlSchema,
} from "@/lib/shop-settings";
import { SHOP_TYPE_KEYS } from "@/lib/shop-types";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { getShopAccess, requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getPublicShopById, getShopById, toShopView, updateShop } from "@/server/services/shops";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * The owner and staff who may edit the shop get its details in any status;
 * everyone else gets an APPROVED shop's public card fields, and a 404 for a
 * shop that is not live.
 */
export const GET = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    if (await getShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY })) {
      const shop = await getShopById(id);
      if (shop) return ok(toShopView(shop));
    }
    const shop = await getPublicShopById(id);
    if (!shop) throw notFound("Shop");
    return ok(shop);
  },
);

const schema = z
  .object({
    // Text is trimmed before its length is checked, as at registration (TC-FLD-037).
    name: requiredText(2, 120).optional(),
    ownerName: requiredText(2, 120).optional(),
    phone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number").optional(),
    email: z.string().trim().email().nullish(),
    /** C1: shown to customers (rule shopContact); null clears. */
    contactPhone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number").nullish(),
    whatsappNumber: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number").nullish(),
    addressLine1: requiredText(3, 200).optional(),
    addressLine2: optionalText(200),
    area: optionalText(120),
    city: requiredText(2, 120).optional(),
    state: optionalText(120),
    pincode: z.string().regex(/^\d{6}$/, "PIN code must be 6 digits").optional(),
    latitude: z.string().nullish(),
    longitude: z.string().nullish(),
    pickupLatitude: z.string().nullish(),
    pickupLongitude: z.string().nullish(),
    pickupInstructions: optionalText(500),
    landmark: optionalText(200),
    shopType: z.enum(SHOP_TYPE_KEYS).optional(),
    // https or the site's own uploads only — it is rendered as <img src> (TC-FLD-056).
    logoUrl: shopImageUrlSchema.nullish(),
    photos: z.array(shopImageUrlSchema).max(10).optional(),
    // "Shop time" — opening hours per weekday (§9): HH:MM, open ≠ close, each day once (TC-FLD-052).
    openingHours: openingHoursSchema.optional(),
    deliveryAvailable: z.boolean().optional(),
    // Bounded amounts (TC-FLD-051, TC-FLD-053): ₹5,000 fee, ₹1 lakh minimum order / free-delivery threshold.
    deliveryFeePaise: deliveryFeePaiseSchema.optional(),
    freeDeliveryAbovePaise: freeDeliveryAbovePaiseSchema.nullish(),
    /** GS-010 delivery zone in km from the shop pin. */
    serviceRadiusKm: z.number().int().min(1).max(50).optional(),
    deliveryPincodes: z.array(z.string().regex(/^\d{6}$/)).max(50).optional(),
    minOrderPaise: minOrderPaiseSchema.optional(),
    /** TC-FLD-054: minutes to prepare an order; feeds delivery slots and the late-order alerts. */
    preparationTimeMinutes: preparationMinutesSchema.optional(),
    ordersPaused: z.boolean().optional(),
    /** GS-030 cash on delivery opt-in. */
    codEnabled: z.boolean().optional(),
    description: optionalText(1000),
  })
  .strict();

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireShopAccess(id, {
      anyPermission: PERMISSIONS.SHOP_UPDATE_ANY,
    });
    const body = await parseBody(request, schema);
    return ok(toShopView(await updateShop(id, body, user)));
  },
);
