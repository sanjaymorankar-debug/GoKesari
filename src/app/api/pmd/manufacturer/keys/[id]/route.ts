/** DELETE — revoke an API key at once (batch-2026-10 WS-D, F9.1.2). Signed-in member of the key's account. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireManufacturerMembership, revokeApiKey } from "@/server/pmd/manufacturers";

export const dynamic = "force-dynamic";

export const DELETE = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const account = await requireManufacturerMembership(user.id, new URL(request.url).searchParams.get("account"));
  const id = z.string().uuid().parse((await context.params).id);
  await revokeApiKey(account.id, id, user);
  return noContent();
});
