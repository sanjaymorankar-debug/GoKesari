/**
 * Vendors near a saved address who deliver there and sell the chosen titles
 * (docs/newspaper-subscriptions-2026-11).
 * GET ?addressId=<uuid>&productIds=<uuid>,<uuid>
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { findNewspaperVendors } from "@/server/services/newspaper-subscriptions";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  addressId: z.string().uuid(),
  productIds: z
    .string()
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(1).max(20)),
});

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE_OWN);
  const query = parseQuery(request, querySchema);
  return ok(await findNewspaperVendors({ userId: user.id, addressId: query.addressId, productIds: query.productIds }));
});
