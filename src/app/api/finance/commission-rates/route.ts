/**
 * Commission rates (GS-061, decision D6): platform default, per shop type,
 * per shop. GET — FINANCE_VIEW. POST sets (replaces) one rate — FINANCE_MANAGE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHOP_TYPE_KEYS } from "@/lib/shop-types";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listCommissionRates, setCommissionRate } from "@/server/services/finance";

const schema = z.object({
  scope: z.enum(["DEFAULT", "SHOP_TYPE", "SHOP"]),
  shopType: z.enum(SHOP_TYPE_KEYS).nullish(),
  shopId: z.string().uuid().nullish(),
  /** Basis points: 500 = 5%. */
  rateBp: z.number().int().min(0).max(5000),
  note: z.string().max(300).nullish(),
});

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok(await listCommissionRates());
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  const body = await parseBody(request, schema);
  return ok(await setCommissionRate(body, user), 201);
});
