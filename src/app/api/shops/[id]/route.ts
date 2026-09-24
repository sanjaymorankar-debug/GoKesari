/**
 * A single shop's own editable details — name/contact/address, shop type,
 * and "shop time" (opening hours). Status and classification are NOT here:
 * those go through /approve, /reject and /classification (§8, §10).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHOP_TYPE_KEYS } from "@/lib/shop-types";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getShopById, updateShop } from "@/server/services/shops";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const shop = await getShopById(id);
    if (!shop) throw notFound("Shop");
    return ok(shop);
  },
);

const schema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    ownerName: z.string().min(2).max(120).optional(),
    phone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number").optional(),
    email: z.string().email().nullish(),
    addressLine1: z.string().min(3).max(200).optional(),
    addressLine2: z.string().max(200).nullish(),
    area: z.string().max(120).nullish(),
    city: z.string().min(2).max(120).optional(),
    state: z.string().max(120).nullish(),
    pincode: z.string().regex(/^\d{6}$/, "PIN code must be 6 digits").optional(),
    latitude: z.string().nullish(),
    longitude: z.string().nullish(),
    pickupLatitude: z.string().nullish(),
    pickupLongitude: z.string().nullish(),
    pickupInstructions: z.string().max(500).nullish(),
    landmark: z.string().max(200).nullish(),
    shopType: z.enum(SHOP_TYPE_KEYS).optional(),
    logoUrl: z.string().url().nullish(),
    photos: z.array(z.string().url()).max(10).optional(),
    // "Shop time" — opening hours per weekday (§9).
    openingHours: z
      .array(
        z.object({
          day: z.number().int().min(0).max(6),
          open: z.string(),
          close: z.string(),
          closed: z.boolean().optional(),
        }),
      )
      .optional(),
    deliveryAvailable: z.boolean().optional(),
    deliveryFeePaise: z.number().int().min(0).optional(),
    freeDeliveryAbovePaise: z.number().int().min(0).nullish(),
    /** GS-010 delivery zone in km from the shop pin. */
    serviceRadiusKm: z.number().int().min(1).max(50).optional(),
    description: z.string().max(1000).nullish(),
  })
  .strict();

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireShopAccess(id, {
      anyPermission: PERMISSIONS.SHOP_UPDATE_ANY,
    });
    const body = await parseBody(request, schema);
    return ok(await updateShop(id, body, user));
  },
);
