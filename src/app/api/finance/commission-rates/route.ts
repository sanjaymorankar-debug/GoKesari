/**
 * Commission rates (GS-061, decision D6): platform default, per shop type,
 * per shop. GET — FINANCE_VIEW. POST sets (replaces) one rate — FINANCE_MANAGE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHOP_TYPE_KEY_PATTERN } from "@/lib/shop-types";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listCommissionRates, setCommissionRate } from "@/server/services/finance";
import { fourEyeAdminOn, requestFourEye, FOUR_EYE_TYPES } from "@/server/approvals";

const schema = z.object({
  scope: z.enum(["DEFAULT", "SHOP_TYPE", "SHOP"]),
  shopType: z.string().regex(SHOP_TYPE_KEY_PATTERN).nullish(),
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
  // docs/rbac: with rbac_v2_four_eye_admin on, a second admin approves a commission change first.
  if (await fourEyeAdminOn()) {
    return ok(
      await requestFourEye(FOUR_EYE_TYPES.COMMISSION_RATE_SET, user, {
        subjectType: "commission_rate",
        subjectId: body.scope === "DEFAULT" ? "DEFAULT" : `${body.scope}:${body.shopType ?? body.shopId}`,
        title: `Commission ${body.scope}${body.shopType ? ` ${body.shopType}` : ""} → ${(body.rateBp / 100).toFixed(2)}%`,
        reason: body.note?.trim() || "Commission rate change",
        payload: body,
      }),
      202,
    );
  }
  return ok(await setCommissionRate(body, user), 201);
});
