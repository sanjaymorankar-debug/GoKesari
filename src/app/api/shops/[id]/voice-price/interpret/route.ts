/**
 * Voice price & offer assistant, step 1 (docs/smart-shopping-2026-11/FEATURE4_VOICE_PRICE_OFFERS.md):
 *   POST { text, shopProductId?, barcode? } → what GoKesari understood (product, new price, offer, read-back,
 *   problems). Changes nothing. The shop's owner only; 404 while voice_price_assistant_enabled is off.
 * Speech is turned into text on the phone or in the browser; only the text comes here.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { interpretVoiceCommand } from "@/server/services/voice-price-assistant";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid() });
const body = z.object({
  text: z.string().max(500),
  shopProductId: z.string().uuid().nullish(),
  barcode: z.string().max(40).nullish(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = ids.parse(await context.params);
  enforceRateLimit(`voice-price:${user.id}`, { limit: 120, windowMs: 10 * 60_000 });
  const input = await parseBody(request, body);
  return ok(await interpretVoiceCommand(id, user, input));
});
