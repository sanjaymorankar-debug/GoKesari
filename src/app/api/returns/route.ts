/**
 * Returns lists.
 *   GET                  — the signed-in customer's own returns
 *   GET ?shopId=<uuid>   — a shop's returns (its owner, or staff)
 *   GET ?all=1[&status=] — every return (staff)
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { forbidden } from "@/lib/errors";
import { RETURN_STATUSES, type ReturnStatus } from "@/lib/return-states";
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { listAllReturns, listReturnsForShop, listReturnsForUser } from "@/server/services/returns";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const p = new URL(request.url).searchParams;
  const status = RETURN_STATUSES.find((s) => s === p.get("status")) as ReturnStatus | undefined;
  const staff = user.role === "OPERATOR" || user.role === "ADMIN";

  if (p.get("all") === "1") {
    if (!staff) throw forbidden("Staff only.");
    return ok({ returns: await listAllReturns({ status }) });
  }
  const shopId = p.get("shopId");
  if (shopId) {
    const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
    if (!shop || (shop.ownerId !== user.id && !staff)) throw forbidden("This shop does not belong to you.");
    return ok({ returns: await listReturnsForShop(shopId, status) });
  }
  return ok({ returns: await listReturnsForUser(user.id) });
});
