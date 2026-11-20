/** The full health record of one person as a PDF (logged as an export). */
import type { NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { fileResponse, uuidParam } from "@/server/health/http";
import { recordPdf } from "@/server/health/records";

export const dynamic = "force-dynamic";

export const GET = route(async (_r: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`health-export:${user.id}`, RATE_LIMITS.MUTATION);
  const { pdf, filename } = await recordPdf(await uuidParam(context, "id"), user);
  return fileResponse(pdf, "application/pdf", filename, false);
});
