/**
 * F6.1.3 (batch-2026-10 WS-C): the shop's after-packing cancellation fee.
 * GET shows the admin's default and limits with the shop's own setting; PUT
 * sets the shop's fee (refused above the admin's limits); DELETE goes back to
 * the platform default. The shop's owner (or shop staff with SHOP_UPDATE_ANY).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  getShopCancellationFeeSettings,
  resetShopCancellationFee,
  setShopCancellationFee,
} from "@/server/aftercare/cancellation-fee";

export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean(),
  feeType: z.enum(["FLAT", "PERCENT"]),
  feePaise: z.number().int().min(0).optional(),
  feeBp: z.number().int().min(0).max(10_000).optional(),
  capPaise: z.number().int().min(0).nullish(),
});

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  return ok(await getShopCancellationFeeSettings(id, await requireUser()));
});

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  // The shop's owner or operations first: another shop's owner gets 403 before the body is read (TC-RBAC-005).
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  return ok(await setShopCancellationFee(id, await parseBody(request, schema), user));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await resetShopCancellationFee(id, await requireUser());
  return noContent();
});
