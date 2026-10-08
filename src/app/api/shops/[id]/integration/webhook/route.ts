/**
 * POST → a new change-webhook address for Odoo / Zoho Books (shown once; the
 * old one stops working). The software calls it when items change → GoKesari pulls.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { issueWebhookSecret, requireIntegrationAccess } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "manage");
  const origin = process.env.AUTH_URL ?? request.nextUrl.origin;
  return ok(await issueWebhookSecret(id, origin, actor), 201);
});
