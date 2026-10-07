/** A shop's catalogue: list publicly, add as the owner (§11, §12). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { imageRefSchema } from "@/lib/image-ref";

import { ok, parseBody, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { getShopAccess, requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createShopProduct, listShopProducts, listStorefrontProducts } from "@/server/services/catalogue";
import { getPublicShopById } from "@/server/services/shops";

export const dynamic = "force-dynamic";

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The shop's owner and staff get every listing with its stock settings
 * (`onlineOnly=true` narrows to what is on sale online). Everyone else sees
 * what the storefront shows: an APPROVED shop's online listings, `limit` /
 * `offset` at a time, and a 404 for a shop that is not live.
 */
export const GET = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    if (await getShopAccess(id, { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY })) {
      const onlineOnly =
        new URL(request.url).searchParams.get("onlineOnly") === "true";
      return ok(await listShopProducts(id, { onlineOnly }));
    }
    if (!(await getPublicShopById(id))) throw notFound("Shop");
    const { limit, offset } = parseQuery(request, pageSchema);
    return ok(await listStorefrontProducts({ shopId: id, onlineOnly: true, limit, offset }));
  },
);

const schema = z
  .object({
    productId: z.string().uuid(),
    description: z.string().max(500).nullish(),
    imageUrl: imageRefSchema.nullish(),
    onlineSaleEnabled: z.boolean().default(false),
    offlineSaleEnabled: z.boolean().default(false),
    onlinePricePaise: z.number().int().min(0).nullish(),
    offlinePricePaise: z.number().int().min(0).nullish(),
    trackInventory: z.boolean().default(true),
    onlineStock: z.number().int().min(0).default(0),
    offlineStock: z.number().int().min(0).default(0),
    isActive: z.boolean().default(true),
    isAvailable: z.boolean().default(true),
  })
  // Mirrors the DB CHECK so the user gets a field-level message, not a 500.
  .refine((v) => !v.onlineSaleEnabled || v.onlinePricePaise != null, {
    message: "An online price is required when online selling is enabled",
    path: ["onlinePricePaise"],
  })
  .refine((v) => !v.offlineSaleEnabled || v.offlinePricePaise != null, {
    message: "An offline price is required when offline selling is enabled",
    path: ["offlinePricePaise"],
  });

export const POST = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireShopAccess(id, {
      anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
    });
    const body = await parseBody(request, schema);
    return ok(await createShopProduct({ ...body, shopId: id }, user as never), 201);
  },
);
