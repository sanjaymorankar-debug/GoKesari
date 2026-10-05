/** "This shop is not GST-registered" — a declaration (and optional GST enrolment number) for admin review. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { declareNoGstin } from "@/server/services/seller-verification";

const schema = z.object({
  declaration: z.literal(true, { message: "Please confirm the declaration." }),
  enrolmentNumber: z.string().trim().max(20).optional().nullable(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`seller-verification:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(
    await declareNoGstin({
      shopId: id,
      declarationAccepted: body.declaration,
      enrolmentNumber: body.enrolmentNumber,
      actor: user,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    }),
  );
});
