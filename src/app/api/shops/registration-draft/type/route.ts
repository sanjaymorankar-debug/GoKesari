/** Owner, 25-Nov-2026: POST { shopType } — the shop type, right after GST / PAN; it decides the licences asked. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { wizardActor } from "@/server/registration/wizard-actor";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { saveDraftShopType } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.object({ shopType: z.string().trim().min(1).max(60) });

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await saveDraftShopType({ actor: user, shopType: body.shopType }));
});
