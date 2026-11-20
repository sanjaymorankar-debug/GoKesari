/**
 * Home-care provider profiles of a practice.
 * GET ?shopId= → the home-care team (each with profile, verification badges and ID card).
 * POST careProfileInput → save one member's profile (the owner, or the member themself).
 */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { firmForPage } from "@/server/consult/pages";
import { requireHealthEnabled } from "@/server/health/access";
import { careIdCard, careTeam, saveCareProviderProfile } from "@/server/health/care";
import { bodyOf } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  await requireHealthEnabled();
  const firm = await firmForPage(user, request.nextUrl.searchParams.get("shopId"));
  if (!firm) throw notFound("Practice");
  const team = await careTeam(firm.shopId, user);
  const members = await Promise.all(team.members.map(async (m) => ({ ...m, idCard: m.profile ? await careIdCard(m.memberId, user).catch(() => null) : null })));
  return ok({ shopId: firm.shopId, shopName: firm.shopName, canSetup: team.access.canSetup, categories: team.categories, members });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`health-care-profile:${user.id}`, RATE_LIMITS.MUTATION);
  const row = await saveCareProviderProfile(await bodyOf(request), user);
  return ok({ profile: row });
});
