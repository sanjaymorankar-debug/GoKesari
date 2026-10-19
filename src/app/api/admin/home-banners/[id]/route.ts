/**
 * One home hero banner (docs/homepage-uiux-2026-10, F1) — admin and operator (HOME_BANNER_MANAGE).
 *   PATCH  { …same fields as POST /api/admin/home-banners } → change it
 *   POST   { action: "activate" | "deactivate" | "up" | "down" } → switch on/off, move in the carousel
 *   DELETE → remove it
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { deleteBanner, moveBanner, setBannerActive, updateBanner, type BannerInput } from "@/server/services/home-banners";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<{ id: string }>;

const idSchema = z.string().uuid();

export const PATCH = route(async (request: NextRequest, context: Ctx) => {
  const user = await requirePermission(PERMISSIONS.HOME_BANNER_MANAGE);
  enforceRateLimit(`home-banner:${user.id}`, RATE_LIMITS.MUTATION);
  const id = idSchema.parse((await context.params).id);
  const body = (await parseBody(request, z.unknown())) as BannerInput;
  return ok({ banner: await updateBanner(user, id, body) });
});

const actionSchema = z.object({ action: z.enum(["activate", "deactivate", "up", "down"]) });

export const POST = route(async (request: NextRequest, context: Ctx) => {
  const user = await requirePermission(PERMISSIONS.HOME_BANNER_MANAGE);
  enforceRateLimit(`home-banner:${user.id}`, RATE_LIMITS.MUTATION);
  const id = idSchema.parse((await context.params).id);
  const { action } = await parseBody(request, actionSchema);
  if (action === "up" || action === "down") {
    await moveBanner(user, id, action);
    return ok({ moved: action });
  }
  return ok({ banner: await setBannerActive(user, id, action === "activate") });
});

export const DELETE = route(async (_request: NextRequest, context: Ctx) => {
  const user = await requirePermission(PERMISSIONS.HOME_BANNER_MANAGE);
  enforceRateLimit(`home-banner:${user.id}`, RATE_LIMITS.MUTATION);
  await deleteBanner(user, idSchema.parse((await context.params).id));
  return noContent();
});
