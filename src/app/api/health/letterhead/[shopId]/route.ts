/**
 * Letterhead and print settings. GET ?member= → effective settings (without images) ; POST → save;
 * GET ?member=&calibration=1 → the calibration sheet PDF (mm grid with the current margins).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireFirmAccess } from "@/server/consult/access";
import { bodyOf, fileResponse, uuidParam } from "@/server/health/http";
import { calibrationPdf, effectiveLetterhead, letterheadView, saveLetterhead } from "@/server/health/letterheads";

export const dynamic = "force-dynamic";

const memberOf = (request: NextRequest) => {
  const m = request.nextUrl.searchParams.get("member");
  return m ? z.string().uuid().parse(m) : null;
};

export const GET = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const user = await requireUser();
  const shopId = await uuidParam(context, "shopId");
  const member = memberOf(request);
  if (request.nextUrl.searchParams.get("calibration") === "1") return fileResponse(await calibrationPdf(shopId, member, user), "application/pdf", "letterhead-calibration.pdf");
  await requireFirmAccess(shopId, user, "bookings");
  return ok({ letterhead: letterheadView(await effectiveLetterhead(shopId, member)) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`health-letterhead:${user.id}`, RATE_LIMITS.MUTATION);
  return ok({ letterhead: letterheadView(await saveLetterhead(await uuidParam(context, "shopId"), await bodyOf(request), user)) });
});
