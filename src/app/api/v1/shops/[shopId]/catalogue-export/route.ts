/**
 * Bulk product upload (docs/product-import-2026-10): "Download my catalogue" —
 * the shop's products in the upload template's layout (?format=xlsx, default,
 * or csv), to edit and upload again. Same access as the upload: the shop
 * owner for their own shops, operators and admins for any shop.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { parseQuery, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { exportShopCatalogue } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

const query = z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx") });

export const GET = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const shopId = z.string().uuid().parse((await context.params).shopId);
  const user = await requireUser();
  enforceRateLimit(`catalogue-export:${user.id}`, { limit: 30, windowMs: 60 * 60_000 });
  const { format } = parseQuery(request, query);
  const file = await exportShopCatalogue(shopId, format, user);
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
