/**
 * The owner of a shop that owes its registration fee asks to pay it later (0229; docs/fee-pay-later-2026-11;
 * flag shop_fee_pay_later_enabled):  POST { shopId, note? } → { request }
 * The request goes to the administrators (Admin → Shops → Pay-later requests). Owner only.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requestShopFeePayLater } from "@/server/services/fee-pay-later";

export const dynamic = "force-dynamic";

const schema = z.object({ shopId: z.string().uuid(), note: z.string().trim().max(500).nullish() });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`fee-pay-later:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok({ request: await requestShopFeePayLater(body.shopId, { id: user.id }, body.note ?? null) });
});
