/**
 * The people who may edit this shop's product photos and descriptions (Module 1).
 *   GET  → current and past staff (contact masked).
 *   POST { identifier } — a 10-digit mobile number or an email address of an
 *        existing GoKesari account. Owner only (operators/admins for support).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { addShopStaff, listShopStaff } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const user = await requireUser();
  return ok({ staff: await listShopStaff(id, user) });
});

const schema = z.object({ identifier: z.string().trim().min(5).max(200) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const user = await requireUser();
  enforceRateLimit(`shop-staff-add:${user.id}`, { limit: 20, windowMs: 60 * 60_000 });
  const { identifier } = await parseBody(request, schema);
  return ok(await addShopStaff(id, identifier, user), 201);
});
