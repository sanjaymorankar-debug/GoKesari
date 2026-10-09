/**
 * A shop's accounting / inventory connection (Module 2, docs/three-modules-2026-10).
 *   GET → the software list, the current connection (no secrets) and whether
 *         the server is ready (encryption key, Zoho client).
 *   PUT { provider, config, credentials?, paused? } — connect or change.
 *       Credentials are write-only: omitted means "keep what is stored".
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import {
  getIntegrationView,
  providerCatalogue,
  requireIntegrationAccess,
  saveIntegration,
  saveIntegrationSchema,
} from "@/server/integrations/connections";
import { isCredentialEncryptionConfigured } from "@/server/integrations/credentials";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "view");
  return ok({
    providers: providerCatalogue(),
    integration: await getIntegrationView(id),
    ready: {
      encryption: isCredentialEncryptionConfigured(),
      zoho: Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET),
    },
    canManage: actor.via === "OWNER" || actor.role === "ADMIN",
  });
});

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "manage");
  enforceRateLimit(`integration-save:${actor.id}`, { limit: 30, windowMs: 60 * 60_000 });
  const input = await parseBody(request, saveIntegrationSchema);
  return ok({ integration: await saveIntegration(id, input, actor) });
});
