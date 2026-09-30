/** Update or remove one shop offering: price, availability, stock (§11–§13). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { imageRefSchema } from "@/lib/image-ref";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shopProducts, shops } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { removeShopProduct, updateShopProduct } from "@/server/services/catalogue";
import {
  appliesImmediately,
  submitPriceRequests,
  type ProposedChange,
} from "@/server/services/price-requests";

const schema = z.object({
  description: z.string().max(500).nullish(),
  imageUrl: imageRefSchema.nullish(),
  onlineSaleEnabled: z.boolean().optional(),
  offlineSaleEnabled: z.boolean().optional(),
  onlinePricePaise: z.number().int().min(0).nullish(),
  offlinePricePaise: z.number().int().min(0).nullish(),
  trackInventory: z.boolean().optional(),
  onlineStock: z.number().int().min(0).optional(),
  offlineStock: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
});

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;

    // Resolve the owning shop first, then run the ownership check against it.
    // ownerId comes along because the price path below needs to know whether
    // the caller IS the owner (goes live) or merely privileged (proposal).
    const [existing] = await db
      .select({ shopId: shopProducts.shopId, ownerId: shops.ownerId })
      .from(shopProducts)
      .innerJoin(shops, eq(shops.id, shopProducts.shopId))
      .where(eq(shopProducts.id, id))
      .limit(1);
    if (!existing) throw notFound("Product");

    const { user } = await requireShopAccess(existing.shopId, {
      anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
    });

    const body = await parseBody(request, schema);

    /*
     * §7/§10 — a price change made by someone who is not the shop owner does
     * not go live. It becomes a proposal the owner must approve. Everything
     * else in the patch (stock, availability, description) is operational and
     * applies immediately, so the two are split here rather than blocking the
     * whole request.
     */
    const proposesPrice =
      body.onlinePricePaise != null || body.offlinePricePaise != null;

    if (proposesPrice && !appliesImmediately(user, existing.ownerId)) {
      const changes: ProposedChange[] = [];
      if (body.onlinePricePaise != null) {
        changes.push({
          shopProductId: id,
          priceType: "ONLINE",
          proposedPricePaise: body.onlinePricePaise,
        });
      }
      if (body.offlinePricePaise != null) {
        changes.push({
          shopProductId: id,
          priceType: "OFFLINE",
          proposedPricePaise: body.offlinePricePaise,
        });
      }

      const { requests } = await submitPriceRequests(
        { shopId: existing.shopId, changes },
        user,
      );

      // Apply the non-price part of the patch, if any.
      const {
        onlinePricePaise: _online,
        offlinePricePaise: _offline,
        ...rest
      } = body;
      const product = Object.keys(rest).length
        ? await updateShopProduct(id, rest, user as never)
        : undefined;

      return ok(
        {
          pendingApproval: true,
          requestIds: requests.map((r) => r.id),
          message:
            "Price changes were sent to the shop owner for approval. The live price is unchanged.",
          product,
        },
        202,
      );
    }

    return ok(await updateShopProduct(id, body, user as never));
  },
);

/** Removes a product from the shop's catalogue (§9 "remove products"). */
export const DELETE = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;

    const existing = await db.query.shopProducts.findFirst({
      where: eq(shopProducts.id, id),
      columns: { shopId: true },
    });
    if (!existing) throw notFound("Product");

    const { user } = await requireShopAccess(existing.shopId, {
      anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
    });

    await removeShopProduct(id, user as never);
    return ok({ removed: true });
  },
);
