/** Remove a person's access to edit this shop's product photos and descriptions (Module 1). Owner only. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { removeShopStaff } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), staffId: z.string().uuid() });

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; staffId: string }>) => {
  const { id, staffId } = ids.parse(await context.params);
  const user = await requireUser();
  enforceRateLimit(`shop-staff:${user.id}`, RATE_LIMITS.MUTATION);
  await removeShopStaff(id, staffId, user);
  return noContent();
});
