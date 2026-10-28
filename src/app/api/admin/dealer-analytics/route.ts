/**
 * Dealer programme analytics (docs/dealer-programme, step 8: GKS-GEO-001, GKS-AN-001/002).
 * GET ?area= → coverage under the area (default: all), performance scores, activation report. Admin and operator.
 * POST { areaCode, targetShops (null removes), note } → an area's shop target. ADMIN only (checked again in the service).
 * Not there (404) while the dealer programme is off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { AppError } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { activationReport, coverageReport, dealerScores, setAreaTarget } from "@/server/dealers/analytics";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

async function requireOn() {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) throw new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE" });
}

export const GET = route(async (request: NextRequest) => {
  await requireOn();
  await requireRole("ADMIN", "OPERATOR");
  const area = request.nextUrl.searchParams.get("area");
  const [coverage, scores, activation] = await Promise.all([coverageReport(area || null), dealerScores(), activationReport()]);
  return ok({ coverage, scores, activation });
});

const schema = z.object({ areaCode: z.string().min(1).max(40), targetShops: z.number().int().nullable(), note: z.string().max(300).default("") });

export const POST = route(async (request: NextRequest) => {
  await requireOn();
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  await setAreaTarget(body.areaCode, body.targetShops, body.note, admin);
  return ok({ saved: true });
});
