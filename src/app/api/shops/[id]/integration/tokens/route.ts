/**
 * Tally connector sign-in tokens.
 *   GET  → tokens (prefix, label, last used; never the token).
 *   POST { label? } → a new token, shown ONCE in the reply.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { issueConnectorToken, listConnectorTokens, requireIntegrationAccess } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  await requireIntegrationAccess(id, "view");
  return ok({ tokens: await listConnectorTokens(id) });
});

const schema = z.object({ label: z.string().trim().max(60).optional() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "manage");
  enforceRateLimit(`integration-token:${actor.id}`, { limit: 10, windowMs: 60 * 60_000 });
  const { label } = await parseBody(request, schema);
  const token = await issueConnectorToken(id, label ?? null, actor);
  return NextResponse.json(token, { status: 201, headers: { "cache-control": "no-store" } });
});
