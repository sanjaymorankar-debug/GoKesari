/**
 * Complete your profile (Module 3, after self-registration).
 *   GET   → what is filled in and what is missing.
 *   PATCH { ownerName, addressLine1, addressLine2?, city, state?, pincode, shopType, gstin? }
 *         → saved; a GSTIN is checked through the GSP first (refused when
 *           invalid, unknown or not active; a state mismatch is warned).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { profileSetupSchema, profileSetupView, saveProfileSetup } from "@/server/registration/profile";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok(await profileSetupView(z.string().uuid().parse((await context.params).id), user));
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`profile-setup:${user.id}`, { limit: 30, windowMs: 60 * 60_000 });
  const id = z.string().uuid().parse((await context.params).id);
  return ok(await saveProfileSetup(id, await parseBody(request, profileSetupSchema), user));
});
