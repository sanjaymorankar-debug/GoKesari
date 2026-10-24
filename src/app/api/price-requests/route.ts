/** Price update requests: list pending, submit a proposal (§2.4, §7). */
import type { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import {
  listAllPending,
  listPendingForShop,
  submitPriceRequests,
} from "@/server/services/price-requests";

const submitSchema = z.object({
  shopId: z.string().uuid(),
  note: z.string().max(500).nullish(),
  changes: z
    .array(
      z.object({
        shopProductId: z.string().uuid(),
        priceType: z.enum(["ONLINE", "OFFLINE"]),
        proposedPricePaise: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Pending queue. Scope follows capability: an owner sees their own shop's
 * queue, an admin sees every shop's.
 */
export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const shopId = new URL(request.url).searchParams.get("shopId");

  if (shopId) {
    await requireShopAccess(shopId, {
      anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
    });
    return ok({ requests: await listPendingForShop(shopId) });
  }

  if (!can(user.role, PERMISSIONS.PRICE_REQUEST_DECIDE_ANY)) {
    return ok({ requests: [] });
  }
  return ok({ requests: await listAllPending() });
});

export const POST = route(async (request: NextRequest) => {
  // Signed in first: a guest gets 401 before the body or the record is read (TC-SEC-001);
  // and someone who owns no shop and is not operations gets 403 before it is read (TC-RBAC-003).
  // Ownership, not the active role: an owner acting as a customer may still propose prices.
  const caller = await requireUser();
  if (!can(caller.role, PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY)) {
    const owned = await db.query.shops.findFirst({ where: and(eq(shops.ownerId, caller.id), isNull(shops.deletedAt)), columns: { id: true } });
    if (!owned) throw forbidden("Only a shop's owner or operations can propose prices.");
  }
  const body = await parseBody(request, submitSchema);

  // Ownership is checked against the shop, so an operator cannot propose
  // prices for a shop they were not granted access to.
  const { user } = await requireShopAccess(body.shopId, {
    anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
  });

  const result = await submitPriceRequests(
    { shopId: body.shopId, changes: body.changes, note: body.note },
    user,
  );
  return ok(
    { batchId: result.batch.id, pending: result.requests.length },
    201,
  );
});
