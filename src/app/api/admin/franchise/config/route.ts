/** Admin: PUT { patch, reason, effectiveFrom? } — a new versioned franchise config (audited). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { saveFranchiseConfig } from "@/server/franchise/config";
import { requireFranchiseAdmin } from "@/server/franchise/http";
import { refuseDirectTaxEdit } from "@/server/tax-register/changes";

export const dynamic = "force-dynamic";

export const PUT = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const body = await parseBody(request, z.object({ patch: z.record(z.string(), z.unknown()), reason: z.string().min(5).max(500), effectiveFrom: z.string().datetime().optional() }));
  if ("gstRateBp" in body.patch) await refuseDirectTaxEdit("The franchise fee GST rate");
  return ok(await saveFranchiseConfig(body.patch as never, { reason: body.reason, effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : undefined }, actor));
});
