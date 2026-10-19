/**
 * Header search suggestions (docs/homepage-uiux-2026-10, F2). Public.
 *   GET ?q=<at least 2 characters> → { query, products[], shops[], categories[] }
 * Products sold near the visitor's chosen location, and nearby shops, come
 * first. Read-only; nothing about the visitor is stored here (a submitted
 * search is recorded by the /search page).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { serializeLocation, type CustomerLocation } from "@/lib/location";
import { ok, parseQuery, route } from "@/server/api/handler";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { serviceableShopIds } from "@/server/services/serviceability";
import { SUGGEST_MAX_CHARS, suggest } from "@/server/services/search-suggest";

export const dynamic = "force-dynamic";

const querySchema = z.object({ q: z.string().max(200).default("") });

/** Shops serving a location, kept for a minute: a visitor typing asks several times in a row. */
const nearbyCache = new Map<string, { at: number; ids: Map<string, number | null> }>();
const NEARBY_TTL_MS = 60_000;

async function nearbyFor(location: CustomerLocation): Promise<Map<string, number | null>> {
  const key = serializeLocation(location);
  const now = Date.now();
  const hit = nearbyCache.get(key);
  if (hit && now - hit.at < NEARBY_TTL_MS) return hit.ids;
  const ids = await serviceableShopIds(location);
  if (nearbyCache.size > 500) nearbyCache.clear();
  nearbyCache.set(key, { at: now, ids });
  return ids;
}

export const GET = route(async (request: NextRequest) => {
  const user = await getCurrentUser();
  enforceRateLimit(user ? `suggest:${user.id}` : clientKey(request, "suggest"), RATE_LIMITS.SEARCH_SUGGEST);
  const { q } = parseQuery(request, querySchema);
  const location = await getCustomerLocation(user?.id).catch(() => null);
  const nearby = location ? await nearbyFor(location).catch(() => undefined) : undefined;
  const result = await suggest(q.slice(0, SUGGEST_MAX_CHARS), { lang: await getBoardLang(), nearby });
  const response = ok(result);
  response.headers.set("Cache-Control", "private, max-age=30");
  return response;
});
