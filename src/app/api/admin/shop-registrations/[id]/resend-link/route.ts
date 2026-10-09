/** POST → a new payment link by SMS for an unpaid registration (the old link stops working). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { resendRegistrationLink } from "@/server/registration/service";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  await resendRegistrationLink(z.string().uuid().parse((await context.params).id), user);
  return noContent();
});
