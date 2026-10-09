/**
 * PATCH { status?, label?, note?, expiresAt?, distributorId?, maxUses? } —
 * change a referral code (Module 3: distributor and usage limit for
 * self-registration). Operator/admin only.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { updateReferralCode } from "@/server/services/referrals";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE", "EXPIRED"]).optional(),
  label: z.string().max(120).nullish(),
  note: z.string().max(500).nullish(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  distributorId: z.string().uuid().nullish(),
  maxUses: z.number().int().min(1).max(100_000).nullish(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.REFERRAL_MANAGE);
  const id = z.string().uuid().parse((await context.params).id);
  const patch = await parseBody(request, schema);
  return ok(await updateReferralCode(id, patch, user));
});
