/** F7: order-level coupons (admin only; audited). GET → all with use counts. POST → create. */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { listCoupons, saveCoupon } from "@/server/services/coupons";
import { couponSchema } from "./schema";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireRole("ADMIN");
  return ok({ coupons: await listCoupons() });
});

export const POST = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  return ok(await saveCoupon(await parseBody(request, couponSchema), admin), 201);
});
