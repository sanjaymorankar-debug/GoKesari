/**
 * Turn-by-turn routes for rider navigation (F4.2.2 — batch-2026-10 WS-B).
 * Picks the adapter named by rule riderNavigation.provider, caches routes
 * between nearby points (~100 m cells) for `cacheSeconds`, logs every real
 * provider call in maps_api_call_log (service ROUTES, purpose
 * "rider_navigation"), and falls back to the straight-line route whenever the
 * provider fails, times out or has no route. Never throws.
 */
import { getEnv } from "@/lib/env";
import type { LatLng, NavRoute } from "@/lib/navigation/geometry";
import { db } from "@/server/db";
import { mapsApiCallLog } from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { googleRoutingProvider } from "./google";
import { mockRoutingProvider, straightLineNavRoute } from "./mock";
import { osrmRoutingProvider } from "./osrm";
import type { RoutingProvider } from "./types";

export type { RoutingProvider } from "./types";
export { straightLineNavRoute } from "./mock";

export const ROUTING_PROVIDERS: Record<RoutingProvider["name"], RoutingProvider> = {
  mock: mockRoutingProvider,
  google: googleRoutingProvider,
  osrm: osrmRoutingProvider,
};

let fetcherOverride: typeof fetch | null = null;
const cache = new Map<string, { at: number; value: NavRoute }>();

/** Tests only: stub the HTTP calls of the real adapters (and clear the cache). */
export function setNavigationFetchForTests(f: typeof fetch | null): void {
  fetcherOverride = f;
  cache.clear();
}

const cell = (p: LatLng) => `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`;

export async function getNavigationRoute(
  from: LatLng,
  to: LatLng,
  context: { entityType?: string; entityId?: string } = {},
): Promise<NavRoute> {
  let rule;
  try {
    rule = await getRule("riderNavigation");
  } catch {
    return straightLineNavRoute(from, to, "straight_line");
  }
  const provider = ROUTING_PROVIDERS[rule.provider];
  if (provider.name === "mock") return provider.route(from, to, { timeoutMs: rule.timeoutMs, fetcher: fetch }) as Promise<NavRoute>;

  const key = `${provider.name}:${cell(from)}>${cell(to)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < rule.cacheSeconds * 1000) return hit.value;

  const googleApiKey = getEnv().GOOGLE_MAPS_SERVER_API_KEY;
  const startedAt = Date.now();
  let result: NavRoute | null = null;
  let errorMessage: string | null = null;
  try {
    result = await provider.route(from, to, {
      timeoutMs: rule.timeoutMs,
      fetcher: fetcherOverride ?? fetch,
      osrmBaseUrl: rule.osrmBaseUrl,
      googleApiKey,
    });
    if (!result) errorMessage = provider.name === "google" && !googleApiKey ? "No server API key" : "No route returned";
  } catch (error) {
    errorMessage = (error as Error).name === "AbortError" ? `Timed out after ${rule.timeoutMs} ms` : (error as Error).message;
  }
  if (!(provider.name === "google" && !googleApiKey)) {
    await db
      .insert(mapsApiCallLog)
      .values({
        service: "ROUTES",
        purpose: "rider_navigation",
        entityType: context.entityType ?? null,
        entityId: context.entityId ?? null,
        success: result !== null,
        responseTimeMs: Date.now() - startedAt,
        errorMessage: errorMessage?.slice(0, 300) ?? null,
      })
      .catch((err) => console.error("[routing:navigation] failed to record API call log", err));
  }
  if (!result) return straightLineNavRoute(from, to, "straight_line");
  if (rule.cacheSeconds > 0) {
    if (cache.size > 2000) cache.clear();
    cache.set(key, { at: Date.now(), value: result });
  }
  return result;
}
