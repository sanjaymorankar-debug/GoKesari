/** POST → cancel an unpaid registration (frees its slot on the referral code). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { cancelRegistration } from "@/server/registration/service";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  await cancelRegistration(z.string().uuid().parse((await context.params).id), user);
  return noContent();
});
