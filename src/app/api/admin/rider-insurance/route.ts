/**
 * Admin → Rider insurance (Rider App v2).
 *   GET  → {policies: [...]}
 *   POST {insurer, policyNumber, healthCoverRupees, accidentCoverRupees, opdCoverRupees, minDeliveries,
 *         lookbackDays, validFrom, validTo, hospitalsUrl?, hospitals[], claimHelp?, isActive} → {policy}
 * Activating a policy switches the others off and notifies riders eligible now (cap 2000).
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listPolicies, savePolicy } from "@/server/services/rider-insurance";
import { policySchema, toPolicyInput } from "./policy-schema";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
  return ok({ policies: await listPolicies() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
  enforceRateLimit(`admin-rider-insurance:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, policySchema);
  return ok({ policy: await savePolicy(toPolicyInput(body), user) }, 201);
});
