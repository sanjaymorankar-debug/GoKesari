/** GET ?provider=&problem=any|failed|offline&q= → every connected shop's sync health (support, read-only, no secrets). */
import type { NextRequest } from "next/server";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { healthQuerySchema, listIntegrationHealth } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.INTEGRATION_VIEW_ANY);
  return ok({ integrations: await listIntegrationHealth(parseQuery(request, healthQuerySchema)) });
});
