/**
 * One shop's registration (0210): its payment history and the registration audit trail (who, when in IST,
 * old value, new value, reason). Admin and operator only.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { registrationAuditTrail, registrationPaymentHistory } from "@/server/services/shop-registration-subscription";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: { params: Promise<{ shopId: string }> }) => {
  await requirePermission(PERMISSIONS.SHOP_REGISTRATION_SUBSCRIPTION_MANAGE);
  const { shopId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(shopId)) return ok({ payments: [], audit: [] });
  const [payments, audit] = await Promise.all([registrationPaymentHistory(shopId), registrationAuditTrail(shopId)]);
  return ok({ payments, audit });
});
