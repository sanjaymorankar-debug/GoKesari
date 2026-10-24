/**
 * Create a brand-new master product and attach it to one shop (product
 * management brief, "Create New Product").
 *
 * Reuses `requireShopAccess`, exactly like every other shop-scoped mutation:
 * the caller passes as long as they own `shopId`, or hold PRODUCT_CREATE_ANY.
 * A SHOP_OWNER can never reach another shop's `shopId` through this route —
 * that ownership check is the IDOR guard, not anything client-supplied.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { imageRefSchema } from "@/lib/image-ref";
import {
  MAX_PRICE_PAISE,
  MIN_PRICE_PAISE,
  PRICE_MAX_MESSAGE,
  PRICE_MIN_MESSAGE,
} from "@/lib/price-rules";
import { normaliseProductUnit, PRODUCT_UNITS } from "@/lib/product-units";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { createProductForShop } from "@/server/services/catalogue";
import {
  appliesImmediately,
  submitPriceRequests,
  type ProposedChange,
} from "@/server/services/price-requests";

const schema = z
  .object({
    shopId: z.string().uuid(),
    // Optional: General when omitted (a product always has a category).
    categoryId: z.string().uuid().nullish(),
    name: z.string().trim().min(2).max(200),
    description: z.string().max(2000).nullish(),
    specifications: z.string().max(2000).nullish(),
    subCategory: z.string().max(120).nullish(),
    // Only a unit the catalogue knows, in its standard spelling (TC-FLD-074).
    unit: z
      .string()
      .max(20)
      .transform((v, ctx) => {
        const unit = normaliseProductUnit(v);
        if (!unit) {
          ctx.addIssue({ code: "custom", message: `Choose a unit from the list: ${PRODUCT_UNITS.join(", ")}.` });
          return z.NEVER;
        }
        return unit;
      }),
    unitSizeMilli: z.number().int().positive().default(1000),
    subscribable: z.boolean().default(false),
    imageUrl: imageRefSchema.nullish(),
    onlineSaleEnabled: z.boolean().default(false),
    offlineSaleEnabled: z.boolean().default(false),
    // A price is 1 paisa to ₹10 lakh; null means no price (TC-CAT-004, TC-FLD-058/059).
    onlinePricePaise: z.number().int().min(MIN_PRICE_PAISE, PRICE_MIN_MESSAGE).max(MAX_PRICE_PAISE, PRICE_MAX_MESSAGE).nullish(),
    offlinePricePaise: z.number().int().min(MIN_PRICE_PAISE, PRICE_MIN_MESSAGE).max(MAX_PRICE_PAISE, PRICE_MAX_MESSAGE).nullish(),
    isAvailable: z.boolean().default(true),
    confirmDuplicate: z.boolean().default(false),
  })
  .refine((v) => !v.onlineSaleEnabled || v.onlinePricePaise != null, {
    message: "An online price is required when online selling is enabled",
    path: ["onlinePricePaise"],
  })
  .refine((v) => !v.offlineSaleEnabled || v.offlinePricePaise != null, {
    message: "An offline price is required when offline selling is enabled",
    path: ["offlinePricePaise"],
  });

export const POST = route(async (request: NextRequest) => {
  // Signed in first: a guest gets 401 before the body or the record is read (TC-SEC-001).
  await requireUser();
  const body = await parseBody(request, schema);

  const { user } = await requireShopAccess(body.shopId, {
    anyPermission: PERMISSIONS.PRODUCT_CREATE_ANY,
  });

  const [shop] = await db
    .select({ ownerId: shops.ownerId })
    .from(shops)
    .where(eq(shops.id, body.shopId))
    .limit(1);

  // Same rule as every other price mutation: the owner's own change (or an
  // admin override) goes live immediately; anyone else's is withheld pending
  // the owner's approval (§7/§10 of the RBAC brief — preserved, not bypassed).
  const immediate = appliesImmediately(user, shop?.ownerId ?? user.id);
  const result = await createProductForShop(body, user, immediate);

  let pendingPriceRequestId: string | null = null;
  const wantsPrice = body.onlinePricePaise != null || body.offlinePricePaise != null;

  if (!immediate && wantsPrice) {
    const changes: ProposedChange[] = [];
    if (body.onlinePricePaise != null) {
      changes.push({
        shopProductId: result.shopProduct.id,
        priceType: "ONLINE",
        proposedPricePaise: body.onlinePricePaise,
      });
    }
    if (body.offlinePricePaise != null) {
      changes.push({
        shopProductId: result.shopProduct.id,
        priceType: "OFFLINE",
        proposedPricePaise: body.offlinePricePaise,
      });
    }
    const { batch } = await submitPriceRequests(
      {
        shopId: body.shopId,
        changes,
        note: `Initial price for new product "${result.product.name}"`,
      },
      user,
    );
    pendingPriceRequestId = batch.id;
  }

  return ok({ ...result, pendingPriceRequestId }, 201);
});
