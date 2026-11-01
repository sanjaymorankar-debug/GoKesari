/**
 * Fallback GST rates by HSN prefix, dated (Module 2) — used only for a
 * product with no rate of its own. Admin only; filled as the CA advises.
 *   GET ?q= → rates.   PUT { hsnPrefix, ratePercent, cessPercent?, description?, effectiveFrom }.
 *   POST { csv } → many rates at once (billing v2: the CBIC list from the CA).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { hsnRateSchema, importHsnRates, listHsnRates, setHsnRate } from "@/server/gst/config";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.GST_CONFIG_MANAGE);
  const { q } = parseQuery(request, z.object({ q: z.string().trim().max(50).optional() }));
  return ok({ rates: await listHsnRates(q) });
});

export const PUT = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.GST_CONFIG_MANAGE);
  return ok({ rate: await setHsnRate(await parseBody(request, hsnRateSchema), user) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.GST_CONFIG_MANAGE);
  const { csv } = await parseBody(request, z.object({ csv: z.string().min(1).max(1_000_000) }));
  return ok(await importHsnRates(csv, user));
});
