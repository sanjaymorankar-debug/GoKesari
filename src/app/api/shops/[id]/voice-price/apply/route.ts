/**
 * Voice price & offer assistant, step 2 — after the owner said yes
 * (docs/smart-shopping-2026-11/FEATURE4_VOICE_PRICE_OFFERS.md):
 *   POST { shopProductId, newPricePaise, offer, expectedPricePaise } → publishes the price (price history kept)
 *   and/or the offer (shop offers, audited). Refused if the price changed since it was shown.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { applySchema, applyVoiceCommand } from "@/server/services/voice-price-assistant";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = ids.parse(await context.params);
  enforceRateLimit(`voice-price-apply:${user.id}`, { limit: 60, windowMs: 10 * 60_000 });
  const input = await parseBody(request, applySchema);
  return ok(await applyVoiceCommand(id, user, input));
});
