/**
 * Help-desk routing rules (docs/flows-v3/wave1.md, F17; flag flow_f17 — "not available" while it is off).
 *   GET  — the rules (active and switched off).
 *   POST — add a rule { category, districtCode?, userId } (or switch an old one back on).
 * Administrators and Support Managers.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { addRoutingRule, listRoutingRules } from "@/server/aftercare/ticket-routing";

export const dynamic = "force-dynamic";

const schema = z.object({
  category: z.string().min(2).max(40),
  districtCode: z.string().max(20).nullish(),
  userId: z.string().uuid(),
});

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.SUPPORT_QUEUE_MANAGE);
  return ok({ rules: await listRoutingRules(user) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SUPPORT_QUEUE_MANAGE);
  enforceRateLimit(`support-routing:${user.id}`, RATE_LIMITS.MUTATION);
  return ok(await addRoutingRule(await parseBody(request, schema), user), 201);
});
