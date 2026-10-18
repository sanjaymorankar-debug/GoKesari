/**
 * POST — bulk edit of selected products (batch-2026-10 WS-D, F9.1.4), audited per product.
 * { masterProductIds, set: { categoryCode?, hsnCode?, gstRateBp?, brandName?, mrpPaise? }, reason? }
 * PMD_BULK_EDIT; changing the MRP also needs PRODUCT_MRP_MANAGE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { guardedWsd } from "@/server/pmd/api-access";
import { bulkEdit } from "@/server/pmd/browser";

export const dynamic = "force-dynamic";

const schema = z.object({
  masterProductIds: z.array(z.string().regex(/^GKS-PROD-\d{9}$/)).min(1).max(500),
  set: z.object({
    categoryCode: z.string().max(200).optional(),
    hsnCode: z.string().regex(/^\d{4}(\d{2}){0,2}$/).nullable().optional(),
    gstRateBp: z.number().int().min(0).max(10000).nullable().optional(),
    brandName: z.string().trim().min(1).max(120).optional(),
    mrpPaise: z.number().int().positive().optional(),
  }),
  reason: z.string().max(300).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PMD_BULK_EDIT);
  const body = await parseBody(request, schema);
  if (body.set.mrpPaise !== undefined && !can(user.role, PERMISSIONS.PRODUCT_MRP_MANAGE)) throw forbidden("Changing the MRP needs the MRP permission.");
  return ok(await guardedWsd(() => bulkEdit(body, user)));
});
