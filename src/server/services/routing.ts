/**
 * Road routing and travel-time estimates (feature F4).
 *
 * getRoute() returns road distance and travel time from the configured
 * provider (rule "routing": Google Routes API with the existing server key,
 * or an OSRM server), and falls back to the original calculation —
 * straight-line distance at ASSUMED_AVERAGE_SPEED_KMH — when routing is off,
 * the call fails, times out or returns nothing. It never throws.
 *
 * Results are cached per ~100 m start/end cell for `cacheSeconds`, so a
 * tracking page polling every few seconds costs at most one call a minute,
 * and every real call is logged in maps_api_call_log (service ROUTES).
 */
import { getEnv } from "@/lib/env";
import { haversineDistanceKm } from "@/lib/geo/haversine";
import { db } from "@/server/db";
import { mapsApiCallLog } from "@/server/db/schema";
import { getRule } from "./settings";

/** Same constant the straight-line estimates have always used (delivery-feasibility.ts, lib/tracking.ts). */
export const ASSUMED_AVERAGE_SPEED_KMH = 20;

export interface Point {
  latitude: number;
  longitude: number;
}

export interface RouteEstimate {
  distanceKm: number;
  durationSeconds: number;
  source: "ROAD" | "STRAIGHT_LINE";
}

export function straightLineRoute(from: Point, to: Point): RouteEstimate {
  const km = haversineDistanceKm(from, to);
  // Unrounded, so callers using it get exactly the numbers the original formula gave.
  return { distanceKm: km, durationSeconds: (km / ASSUMED_AVERAGE_SPEED_KMH) * 3600, source: "STRAIGHT_LINE" };
}

type Fetcher = typeof fetch;
let fetcherOverride: Fetcher | null = null;
/** Tests only. */
export function setRoutingFetchForTests(f: Fetcher | null): void {
  fetcherOverride = f;
  cache.clear();
}

const cache = new Map<string, { at: number; value: RouteEstimate }>();
const cell = (p: Point) => `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`;

async function withTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await (fetcherOverride ?? fetch)(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function googleRoute(from: Point, to: Point, timeoutMs: number): Promise<RouteEstimate | null> {
  const key = getEnv().GOOGLE_MAPS_SERVER_API_KEY;
  if (!key) return null;
  const res = await withTimeout(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      body: JSON.stringify({
        origin: { location: { latLng: from } },
        destination: { location: { latLng: to } },
        travelMode: "TWO_WHEELER",
        routingPreference: "TRAFFIC_AWARE",
      }),
    },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`Routes API HTTP ${res.status}`);
  const body = (await res.json()) as { routes?: { distanceMeters?: number; duration?: string }[] };
  const r = body.routes?.[0];
  if (!r || typeof r.distanceMeters !== "number" || !r.duration) return null;
  return { distanceKm: r.distanceMeters / 1000, durationSeconds: Math.round(parseFloat(r.duration)), source: "ROAD" };
}

async function osrmRoute(from: Point, to: Point, baseUrl: string, timeoutMs: number): Promise<RouteEstimate | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
  const res = await withTimeout(url, { method: "GET" }, timeoutMs);
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; routes?: { distance: number; duration: number }[] };
  const r = body.routes?.[0];
  if (body.code !== "Ok" || !r) return null;
  return { distanceKm: r.distance / 1000, durationSeconds: Math.round(r.duration), source: "ROAD" };
}

/**
 * Road distance and travel time from `from` to `to`, or the straight-line
 * estimate when routing is off or unavailable. Never throws.
 */
export async function getRoute(
  from: Point,
  to: Point,
  context: { purpose: string; entityType?: string; entityId?: string },
): Promise<RouteEstimate> {
  const fallback = straightLineRoute(from, to);
  let rule;
  try {
    rule = await getRule("routing");
  } catch {
    return fallback;
  }
  if (!rule.enabled) return fallback;

  const key = `${rule.provider}:${cell(from)}>${cell(to)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < rule.cacheSeconds * 1000) return hit.value;

  const startedAt = Date.now();
  let result: RouteEstimate | null = null;
  let errorMessage: string | null = null;
  try {
    result =
      rule.provider === "google"
        ? await googleRoute(from, to, rule.timeoutMs)
        : await osrmRoute(from, to, rule.osrmBaseUrl, rule.timeoutMs);
    if (!result) errorMessage = rule.provider === "google" && !getEnv().GOOGLE_MAPS_SERVER_API_KEY ? "No server API key" : "No route returned";
  } catch (error) {
    errorMessage = (error as Error).name === "AbortError" ? `Timed out after ${rule.timeoutMs} ms` : (error as Error).message;
  }
  if (!(rule.provider === "google" && !getEnv().GOOGLE_MAPS_SERVER_API_KEY)) {
    await db
      .insert(mapsApiCallLog)
      .values({
        service: "ROUTES",
        purpose: context.purpose,
        entityType: context.entityType ?? null,
        entityId: context.entityId ?? null,
        success: result !== null,
        responseTimeMs: Date.now() - startedAt,
        errorMessage: errorMessage?.slice(0, 300) ?? null,
      })
      .catch((err) => console.error("[routing] failed to record API call log", err));
  }
  if (!result) return fallback;
  if (rule.cacheSeconds > 0) {
    if (cache.size > 5000) cache.clear();
    cache.set(key, { at: Date.now(), value: result });
  }
  return result;
}
