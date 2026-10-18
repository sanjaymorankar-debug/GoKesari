/**
 * POST { source: "GS1" | "OFF", gtins: [...] } — barcode look-up into staging (batch-2026-10 WS-D, F9.1.2).
 * 409 when the source's rule flag is off (pmdSources.gs1Enabled / openFoodFactsEnabled, both default OFF).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { guardedWsd } from "@/server/pmd/api-access";
import { lookupAndStage } from "@/server/pmd/source-lookups";

export const dynamic = "force-dynamic";

const schema = z.object({ source: z.enum(["GS1", "OFF"]), gtins: z.array(z.string().trim().max(20)).min(1).max(200) });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PMD_IMPORT);
  enforceRateLimit(clientKey(request, `pmd-lookup:${user.id}`), RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await guardedWsd(() => lookupAndStage(body, user)));
});
