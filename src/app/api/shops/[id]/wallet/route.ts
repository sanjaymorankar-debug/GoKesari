/**
 * A shop's prepaid wallet (docs/shop-wallet-delivery-otp-2026-10): balance,
 * minimum and low-balance levels, whether the shop can accept orders, and the
 * ledger. The shop's owner, or finance staff for any shop.
 *
 * GET ?limit=&offset=
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getShopWalletView } from "@/server/services/shop-wallet";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.FINANCE_VIEW });
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit") ?? 50);
  const offset = Number(params.get("offset") ?? 0);
  return ok(
    await getShopWalletView(id, {
      limit: Number.isInteger(limit) && limit > 0 ? limit : 50,
      offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
    }),
  );
});
