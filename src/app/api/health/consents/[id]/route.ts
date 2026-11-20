/** DELETE → withdraw one consent now. */
import type { NextRequest } from "next/server";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { revokeConsent } from "@/server/health/consent";
import { uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_r: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  await revokeConsent(await uuidParam(context, "id"), user);
  return noContent();
});
