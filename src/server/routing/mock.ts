/**
 * Mock routing adapter: a straight line split into a few points, with
 * synthetic "head <direction>" / "continue" / "arrive" steps, timed at the
 * app's assumed average speed. Used in tests, offline, and as the fallback
 * whenever a real provider fails — so navigation always has something to show.
 */
import { bearingDegrees, compassWord, encodePolyline, metersBetween, type LatLng, type NavRoute } from "@/lib/navigation/geometry";
import type { RoutingProvider } from "./types";

/** Same constant as services/routing.ts (straight-line estimates). */
const ASSUMED_AVERAGE_SPEED_KMH = 20;
const POINTS = 8;

export function straightLineNavRoute(from: LatLng, to: LatLng, provider: NavRoute["provider"] = "mock"): NavRoute {
  const points: LatLng[] = [];
  for (let i = 0; i <= POINTS; i++) {
    const t = i / POINTS;
    points.push({
      latitude: from.latitude + (to.latitude - from.latitude) * t,
      longitude: from.longitude + (to.longitude - from.longitude) * t,
    });
  }
  const distanceMeters = Math.round(metersBetween(from, to));
  const seconds = (m: number) => Math.round((m / 1000 / ASSUMED_AVERAGE_SPEED_KMH) * 3600);
  const half = Math.round(distanceMeters / 2);
  const heading = compassWord(bearingDegrees(from, to));
  const mid = points[Math.floor(POINTS / 2)];
  return {
    provider,
    polyline: encodePolyline(points),
    distanceMeters,
    durationSeconds: seconds(distanceMeters),
    steps: [
      { instruction: `Head ${heading}`, maneuver: "depart", modifier: null, distanceMeters: half, durationSeconds: seconds(half), location: from },
      {
        instruction: `Continue ${heading}`,
        maneuver: "continue",
        modifier: "straight",
        distanceMeters: distanceMeters - half,
        durationSeconds: seconds(distanceMeters - half),
        location: mid,
      },
      { instruction: "You have arrived", maneuver: "arrive", modifier: null, distanceMeters: 0, durationSeconds: 0, location: to },
    ],
  };
}

export const mockRoutingProvider: RoutingProvider = {
  name: "mock",
  async route(from, to) {
    return straightLineNavRoute(from, to, "mock");
  },
};
