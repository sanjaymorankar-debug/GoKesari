/**
 * Wallet checkout (requirements §22, §23).
 *
 * The client sends only a request id and an optional address. Every monetary
 * value is recomputed server-side; nothing about price or total is trusted from
 * the request.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { forbidden } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { checkout } from "@/server/services/orders";

const schema = z.object({
  /** Stable per attempt — resubmitting the same id will not charge twice. */
  requestId: z.string().min(8).max(64),
  addressId: z.string().uuid().nullish(),
  notes: z.string().max(500).nullish(),
  /** shopId -> requested window. Re-validated against live feasibility server-side. */
  deliveryWindows: z.record(z.string().uuid(), z.enum(["EXPRESS_30", "STANDARD_60", "SCHEDULED"])).optional(),
  /** Personal orders and business (B2B) orders are separate flows. */
  orderType: z.enum(["PERSONAL", "B2B"]).optional(),
  buyerShopId: z.string().uuid().nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.ORDER_PLACE);
  enforceRateLimit(`checkout:${user.id}`, RATE_LIMITS.CHECKOUT);

  const body = await parseBody(request, schema);
  if (body.orderType === "B2B" && !can(user.role, PERMISSIONS.ORDER_PLACE_B2B)) {
    throw forbidden("Your account cannot place business orders.");
  }
  const result = await checkout({
    userId: user.id,
    actorRole: user.role,
    orderType: body.orderType,
    buyerShopId: body.buyerShopId ?? null,
    requestId: body.requestId,
    addressId: body.addressId ?? null,
    notes: body.notes ?? null,
    deliveryWindows: body.deliveryWindows,
  });

  return ok(
    {
      orders: result.orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        shopId: o.shopId,
        totalPaise: o.totalPaise,
        status: o.status,
        orderType: o.orderType,
        buyerShopId: o.buyerShopId,
        deliveryWindow: o.deliveryWindow,
        promisedByAt: o.promisedByAt,
      })),
      deduplicated: result.deduplicated,
    },
    201,
  );
});
