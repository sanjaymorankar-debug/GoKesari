/**
 * GET — GoKesari Health "Find a doctor" (public): verified doctors only.
 * ?q (name / clinic) &specialty (category slug) &symptom &area &lat&lng&radiusKm &minFee&maxFee (rupees)
 * &language &mode=IN_PERSON|VIDEO &available=today|week &prime=1 &limit. ?featured=1: the Prime Plus strip.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireConsultEnabled } from "@/server/consult/access";
import { requireHealthEnabled } from "@/server/health/access";
import { featuredDoctors, searchDoctors } from "@/server/health/find-doctor";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "health-doctors"), RATE_LIMITS.SEARCH_SUGGEST);
  await requireHealthEnabled();
  await requireConsultEnabled();
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  if (params.featured === "1") {
    const lat = params.lat ? Number(params.lat) : null;
    const lng = params.lng ? Number(params.lng) : null;
    return ok({ results: await featuredDoctors({ lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null }) });
  }
  delete params.featured;
  return ok(await searchDoctors(params));
});
