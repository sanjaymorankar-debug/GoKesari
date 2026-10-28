/**
 * One staff-added shop type (operator / admin).
 *   PATCH { label?, standardGoods?, isFood?, status? }  edit, activate / deactivate
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { updateShopType } from "@/server/services/shop-types";

export const dynamic = "force-dynamic";

const schema = z.object({
  label: z.string().min(2).max(80).optional(),
  standardGoods: z.array(z.string().max(80)).max(40).optional(),
  isFood: z.boolean().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ key: string }>) => {
  const user = await requireRole("OPERATOR", "ADMIN");
  const { key } = await context.params;
  return ok(await updateShopType(key, await parseBody(request, schema), user));
});
