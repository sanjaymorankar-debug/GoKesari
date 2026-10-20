/**
 * Home hero banners (docs/homepage-uiux-2026-10, F1) — admin and operator (HOME_BANNER_MANAGE).
 *   GET  → every banner, in carousel order
 *   POST { title, subtitle?, imageUrl?, ctaLabel?, ctaHref, kind?, city?, pincode?, startsAt?, endsAt?, active? } → new banner
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createBanner, listAllBanners, type BannerInput } from "@/server/services/home-banners";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.HOME_BANNER_MANAGE);
  return ok({ banners: await listAllBanners(user) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.HOME_BANNER_MANAGE);
  enforceRateLimit(`home-banner:${user.id}`, RATE_LIMITS.MUTATION);
  const body = (await parseBody(request, z.unknown())) as BannerInput;
  return ok({ banner: await createBanner(user, body) }, 201);
});
