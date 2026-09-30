/**
 * One shop category (operator / admin).
 *   GET    the shops using it
 *   PATCH { name?, description?, status? }  rename, describe, activate / deactivate
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { listShopsInCategory, updateShopCategory } from "@/server/services/shop-categories";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireRole("OPERATOR", "ADMIN");
  const { id } = await context.params;
  return ok({ shops: await listShopsInCategory(id) });
});

const schema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(300).nullish(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("OPERATOR", "ADMIN");
  const { id } = await context.params;
  return ok(await updateShopCategory(id, await parseBody(request, schema), user));
});
