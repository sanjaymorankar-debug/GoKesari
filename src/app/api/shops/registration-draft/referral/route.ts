/** Shop registration (0120), first step: POST { referralCode } — checked now; empty when the admin makes it optional. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { answerDraftReferral } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.object({ referralCode: z.string().trim().max(32).nullish(), employeeId: z.string().trim().max(120).nullish() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await answerDraftReferral({ actor: user, referralCode: body.referralCode || null, employeeId: body.employeeId === undefined ? undefined : body.employeeId || null }));
});
