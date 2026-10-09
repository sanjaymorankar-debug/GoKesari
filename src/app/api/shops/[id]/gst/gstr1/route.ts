/**
 * GET ?period=YYYY-MM&format=json|xlsx → the shop's GSTR-1-ready file for the
 * month (GoKesari sales only). Download only: nothing is filed. The shop's
 * owner and operations; every download is recorded.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { parseQuery, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { exportGstr1 } from "@/server/gst/gstr1";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`gstr1:${user.id}`, { limit: 60, windowMs: 60 * 60_000 });
  const { period, format } = parseQuery(request, z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), format: z.enum(["json", "xlsx"]).default("json") }));
  const file = await exportGstr1(id, period, format, user);
  return new NextResponse(new Uint8Array(file.body), {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "private, no-store",
    },
  });
});
