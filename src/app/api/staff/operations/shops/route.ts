/**
 * RBAC v2 Phase 6: find a shop to attach to a task. GET ?q=name-or-pincode
 * Operations User: only shops they onboarded; Operations Manager: any shop.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { searchShopsForOps } from "@/server/rbac-operations";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const actor = await requireUser();
  const { q } = parseQuery(request, z.object({ q: z.string().trim().max(80).default("") }));
  return ok(await searchShopsForOps(actor, q));
});
