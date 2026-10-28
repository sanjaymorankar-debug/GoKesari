/**
 * Shop types (built-in plus staff-added).
 *   GET ?all=1  the list for pickers (active only; staff may pass all=1 to include inactive)
 *   POST { label, standardGoods?, isFood? }  add a type (operator / admin)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { getCurrentUser, requireRole } from "@/server/authz/guards";
import { createShopType, listShopTypes } from "@/server/services/shop-types";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await getCurrentUser();
  const staff = user?.role === "OPERATOR" || user?.role === "ADMIN";
  const all = staff && new URL(request.url).searchParams.get("all") === "1";
  return ok({ shopTypes: await listShopTypes({ includeInactive: all }) });
});

const typeSchema = z.object({
  label: z.string().min(2).max(80),
  standardGoods: z.array(z.string().max(80)).max(40).optional(),
  isFood: z.boolean().optional(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireRole("OPERATOR", "ADMIN");
  return ok(await createShopType(await parseBody(request, typeSchema), user), 201);
});
