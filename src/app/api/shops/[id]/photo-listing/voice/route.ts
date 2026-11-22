/**
 * Price, stock and selling unit from the owner's spoken (browser speech-to-text) or typed sentence:
 * POST { text } → the parsed values and a read-back in English, Hindi and Marathi. A deterministic reader
 * first; AI (VOICE_PARSE) only for what it could not find. No server speech-to-text: the browser's Web
 * Speech API turns speech into text.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { parseSpokenPriceStock } from "@/server/services/shop-photo-listing";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid() });
const body = z.object({ text: z.string().max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = ids.parse(await context.params);
  const user = await requireUser();
  enforceRateLimit(`photo-listing-voice:${user.id}`, { limit: 60, windowMs: 10 * 60_000 });
  const { text } = await parseBody(request, body);
  return ok(await parseSpokenPriceStock(id, user, text));
});
