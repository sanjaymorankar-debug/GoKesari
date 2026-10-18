/**
 * Turn-by-turn routing provider contract (F4.2.2 — batch-2026-10 WS-B).
 * Additive to services/routing.ts (distance/ETA only, unchanged): these
 * adapters also return the route line and the steps a rider follows.
 * Adapters: mock (straight line + synthetic steps — tests/offline), google
 * (Routes API, GOOGLE_MAPS_SERVER_API_KEY), osrm (any OSRM-compatible HTTP
 * API). Chosen by rule riderNavigation.provider.
 */
import type { LatLng, NavRoute } from "@/lib/navigation/geometry";

export type { LatLng, NavRoute, NavStep } from "@/lib/navigation/geometry";

export interface RoutingRequestOptions {
  timeoutMs: number;
  /** Injected fetch (tests stub it; production uses global fetch). */
  fetcher: typeof fetch;
  /** OSRM base URL (rule riderNavigation.osrmBaseUrl). */
  osrmBaseUrl?: string;
  /** Google Routes API key (env GOOGLE_MAPS_SERVER_API_KEY). */
  googleApiKey?: string;
}

export interface RoutingProvider {
  readonly name: "mock" | "google" | "osrm";
  /** The route from → to, or null when the provider has none. May throw on a transport error. */
  route(from: LatLng, to: LatLng, options: RoutingRequestOptions): Promise<NavRoute | null>;
}
