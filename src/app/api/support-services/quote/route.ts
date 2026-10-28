/** GET ?shopId=&serviceKey=&quantity= — the price before submitting (owner or the shop's dealer). docs/dealer-programme. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { AppError } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { quoteSupportService, requesterFor, supportServicesOn } from "@/server/services/support-services";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const params = request.nextUrl.searchParams;
  const shopId = z.string().uuid().parse(params.get("shopId"));
  if (!(await supportServicesOn(shopId))) throw new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE" });
  await requesterFor(shopId, user);
  return ok({ quote: await quoteSupportService(shopId, String(params.get("serviceKey") ?? ""), Number(params.get("quantity") ?? 1)) });
});
