/** RBAC v2 documents: a short-lived signed download link (?version=n, default the latest). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { issueDownloadLink } from "@/server/rbac-support/documents";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireUser();
  const { id } = await context.params;
  const { version } = parseQuery(request, z.object({ version: z.coerce.number().int().positive().optional() }));
  return ok(await issueDownloadLink(id, version ?? null, actor));
});
