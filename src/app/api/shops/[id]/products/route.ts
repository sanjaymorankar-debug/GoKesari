/** A shop's catalogue: list publicly, add as the owner (§11, §12). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { imageRefSchema } from "@/lib/image-ref";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createShopProduct, listShopProducts } from "@/server/services/catalogue";

export const dynamic = "force-dynamic";

export const GET = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const onlineOnly =
      new URL(request.url).searchParams.get("onlineOnly") === "true";
    return ok(await listShopProducts(id, { onlineOnly }));
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
