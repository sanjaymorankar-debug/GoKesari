/**
 * Shop legal/regulatory compliance fields (Part 58).
 *
 * Legal business name, GSTIN and FSSAI licence number are verifiable
 * regulatory credentials, not free-text profile fields — they go through the
 * same admin/operator-gated path as classification (§10 pattern), not the
 * shop owner's own settings form.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { toShopView, updateShopCompliance } from "@/server/services/shops";

const schema = z.object({
  legalBusinessName: z.string().trim().min(1).max(200).nullable().optional(),
  gstin: z.string().trim().toUpperCase().nullable().optional(),
  fssaiLicenseNumber: z.string().trim().min(1).max(50).nullable().optional(),
  returnPolicyText: z.string().trim().max(2000).nullable().optional(),
});

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requirePermission(PERMISSIONS.SHOP_COMPLIANCE_MANAGE);
    const { id } = await context.params;
    const body = await parseBody(request, schema);
    return ok(toShopView(await updateShopCompliance(id, body, user)));
  },
);
