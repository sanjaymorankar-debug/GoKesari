/**
 * Registration fee of an onboarded shop (F8.4.2), paid online (F1.7.3 gateway).
 *
 * POST { mode: "LINK" }     → a payment link, emailed to the owner now
 * POST { mode: "CHECKOUT" } → a checkout the owner pays in session
 * GET                       → re-checks the payment's state (failed / expired → pending admin approval)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listMyOnboardedShops, requestRegistrationFee, sweepOnboardingFees } from "@/server/services/operator-limited";

export const dynamic = "force-dynamic";

const schema = z.object({ mode: z.enum(["LINK", "CHECKOUT"]) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_ONBOARD);
  enforceRateLimit(clientKey(request, `opltd-fee:${user.id}`), RATE_LIMITS.PAYMENT);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await requestRegistrationFee(z.string().uuid().parse(id), body, user), 201);
});

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_ONBOARD);
  const id = z.string().uuid().parse((await context.params).id);
  const mine = await listMyOnboardedShops(user, { audit: false });
  const row = mine.find((s) => s.session?.id === id);
  if (!row) return ok({ found: false }, 404);
  await sweepOnboardingFees({ sessionIds: [id] });
  const after = (await listMyOnboardedShops(user)).find((s) => s.session?.id === id);
  return ok({ found: true, shop: after ?? row });
});
