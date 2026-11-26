/**
 * Onboarding v2 (docs/onboarding-v2-2026-11): an account's marketplace roles and role history (IST), and an
 * admin's override of its team role. ADMIN (USER_SET_ROLE); 404 while onboarding_v2 is off.
 *
 * GET → { roles, team, leads, history }
 * POST { to: "TEAM_LEAD" | "AGENT" | "REMOVE", parentId?, reason } — recorded as OVERRIDE in the role history.
 * DEFAULT – confirm with Sanjay: an override applies at once (not through the four-eye approval used for staff roles).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { adminMarketplaceRoleView, adminOverrideTeamRole, requireOnboardingV2 } from "@/server/onboarding-v2/team";

export const dynamic = "force-dynamic";

const schema = z.object({ to: z.enum(["TEAM_LEAD", "AGENT", "REMOVE"]), parentId: z.string().uuid().nullish(), reason: z.string().min(5).max(300) });

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireOnboardingV2();
  await requirePermission(PERMISSIONS.USER_SET_ROLE);
  const { id } = await context.params;
  return ok(await adminMarketplaceRoleView(id));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireOnboardingV2();
  const actor = await requirePermission(PERMISSIONS.USER_SET_ROLE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  await adminOverrideTeamRole(actor, id, { to: body.to, parentId: body.parentId ?? null, reason: body.reason });
  return ok(await adminMarketplaceRoleView(id));
});
