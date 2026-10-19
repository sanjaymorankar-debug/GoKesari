/**
 * Header search, on focus (docs/homepage-uiux-2026-10, F2). Public.
 *   GET    → { recent: string[] (signed-in customer's own; [] for guests, whose
 *            recent searches stay in their browser), trending: { q, label }[] }
 *   DELETE → clears the signed-in customer's recent searches
 */
import type { NextRequest } from "next/server";

import { noContent, ok, route } from "@/server/api/handler";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser, requireUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { clearRecentSearches, listRecentSearches, listTrendingSearches } from "@/server/services/search-suggest";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await getCurrentUser();
  enforceRateLimit(user ? `suggest:${user.id}` : clientKey(request, "suggest"), RATE_LIMITS.SEARCH_SUGGEST);
  const [recent, trending] = await Promise.all([
    user ? listRecentSearches(user.id) : Promise.resolve([]),
    listTrendingSearches(await getBoardLang()),
  ]);
  return ok({ recent, trending });
});

export const DELETE = route(async () => {
  const user = await requireUser();
  enforceRateLimit(`search-recent:${user.id}`, RATE_LIMITS.MUTATION);
  await clearRecentSearches(user.id);
  return noContent();
});
