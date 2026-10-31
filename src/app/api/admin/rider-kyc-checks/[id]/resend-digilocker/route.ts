/** Gig worker flow: an admin sends a partner a new DigiLocker link for their Aadhaar (their recorded consent stands). */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { resendDigilockerLink } from "@/server/services/rider-kyc";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const { id } = await context.params;
  return ok({ check: await resendDigilockerLink(id, user) });
});
