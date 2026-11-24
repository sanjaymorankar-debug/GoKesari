/**
 * Marketplace KPIs for a date window (GS-069, KPI-001…015). Admin
 * (REPORT_VIEW_ALL) and operators (REPORT_VIEW_OPERATIONAL) see the whole
 * marketplace or any shop; a shop owner sees only their own shop.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireShopPermission } from "@/server/authz/shop-permission";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { defaultWindow, getMarketplaceKpis } from "@/server/services/analytics";

export const dynamic = "force-dynamic";

const schema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  shopId: z.string().uuid().optional(),
});

export const GET = route(async (request: NextRequest) => {
  const query = parseQuery(request, schema);
  const user = await requireUser();
  const marketplace = can(user.role, PERMISSIONS.REPORT_VIEW_ALL) || can(user.role, PERMISSIONS.REPORT_VIEW_OPERATIONAL);
  if (query.shopId) {
    const { isPrivileged, via } = await requireShopPermission(query.shopId, "reports.view", { anyPermission: PERMISSIONS.REPORT_VIEW_OPERATIONAL });
    // Module 10: staff holding reports.view keep their own account role; their permission is the shop's grant.
    if (!isPrivileged && via !== "STAFF" && !can(user.role, PERMISSIONS.REPORT_VIEW_SHOP)) throw forbidden("Switch to your shop role to see its reports.");
  } else if (!marketplace) {
    throw forbidden("Marketplace reports are for operations only.");
  }
  const window = query.from && query.to ? { from: query.from, to: query.to } : defaultWindow(30);
  return ok(await getMarketplaceKpis({ ...window, shopId: query.shopId ?? null }));
});
