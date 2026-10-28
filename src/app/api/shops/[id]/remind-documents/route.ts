/** Remind a pending shop's owner to upload the seller documents still missing (once a day per shop). */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { remindShopDocuments } from "@/server/services/shops";

export const POST = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requirePermission(PERMISSIONS.SHOP_APPROVE);
    enforceRateLimit(`shop-documents-reminder:${user.id}`, RATE_LIMITS.MUTATION);
    const { id } = await context.params;
    return ok(await remindShopDocuments(id, user));
  },
);
