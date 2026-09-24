/**
 * Downloadable price-list template (§9), pre-filled with the shop's catalogue.
 *
 * Returns a real .xlsx rather than CSV so the operator edits the same shape of
 * file the parser expects.
 */
import { NextResponse, type NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { buildTemplate } from "@/server/services/excel";

export const GET = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const { user } = await requireShopAccess(id, {
      anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
    });
    enforceRateLimit(`price-template:${user.id}`, RATE_LIMITS.MUTATION);

    const type =
      new URL(request.url).searchParams.get("type") === "goods"
        ? "GOODS"
        : "PRICES";
    const buffer = await buildTemplate(id, undefined, type);
    const label = type === "GOODS" ? "product-list" : "price-list";

    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${label}-${id.slice(0, 8)}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  },
);
