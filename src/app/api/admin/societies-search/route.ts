/** Gig worker flow (feature 7): admin picker of societies by name, area or city. */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { searchSocietiesForAccess } from "@/server/services/society-partner-access";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  return ok({ societies: await searchSocietiesForAccess(new URL(request.url).searchParams.get("q") ?? "", user) });
});
