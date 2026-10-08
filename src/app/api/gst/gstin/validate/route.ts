/**
 * POST { gstin, fresh? } → the GST system's record for a GSTIN, through the
 * GSP (Module 2, Phase 1): legal / trade name, status, state, taxpayer type.
 * Shop owners (their own GSTIN, at profile completion) and operations.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { checkGstin } from "@/server/gst/gstin";

export const dynamic = "force-dynamic";

const schema = z.object({ gstin: z.string().trim().min(15).max(20), fresh: z.boolean().optional() });

export const POST = route(async (request: NextRequest) => {
  const user = await requireAnyPermission([PERMISSIONS.SHOP_GST_PAN_MANAGE_OWN, PERMISSIONS.SHOP_GST_PAN_VERIFY]);
  enforceRateLimit(`gstin-check:${user.id}`, { limit: 30, windowMs: 60 * 60_000 });
  const { gstin, fresh } = await parseBody(request, schema);
  return ok(await checkGstin(gstin, user, { fresh: fresh && user.role !== "SHOP_OWNER" }));
});
