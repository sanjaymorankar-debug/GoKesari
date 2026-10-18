/**
 * Operator-Limited onboarding (batch-2026-10 WS-D, F8.4.2).
 *
 * GET                    → open onboardings of the signed-in operator (to resume)
 * POST { ownerEmail }    → emails the owner a consent code; returns the onboarding id
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listOpenOnboardings, startOwnerConsent } from "@/server/services/operator-limited";

export const dynamic = "force-dynamic";

const schema = z.object({ ownerEmail: z.string().trim().email("Enter the owner's email address.").max(254) });

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_ONBOARD);
  return ok({ onboardings: await listOpenOnboardings(user) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_ONBOARD);
  enforceRateLimit(clientKey(request, `opltd-otp:${user.id}`), RATE_LIMITS.SHOP_IDENTITY_CHECK);
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return ok(await startOwnerConsent(body, user, ip), 201);
});
