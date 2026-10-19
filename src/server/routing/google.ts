/**
 * Google adapter: Routes API computeRoutes (the "Directions" successor) with
 * the existing server key GOOGLE_MAPS_SERVER_API_KEY — the same API
 * services/routing.ts already uses for distance/ETA, here with the route
 * polyline and the step-by-step navigation instructions.
 */
import type { ManeuverType, NavRoute, NavStep } from "@/lib/navigation/geometry";
import type { RoutingProvider } from "./types";

interface GoogleStep {
  distanceMeters?: number;
  staticDuration?: string;
  startLocation?: { latLng?: { latitude: number; longitude: number } };
  navigationInstruction?: { maneuver?: string; instructions?: string };
}
interface GoogleResponse {
  routes?: {
    distanceMeters?: number;
    duration?: string;
    polyline?: { encodedPolyline?: string };
    legs?: { steps?: GoogleStep[]; endLocation?: { latLng?: { latitude: number; longitude: number } } }[];
  }[];
}

const seconds = (d: string | undefined) => (d ? Math.round(parseFloat(d)) : 0);

function maneuverOf(m: string | undefined): { maneuver: ManeuverType; modifier: string | null } {
  if (!m) return { maneuver: "other", modifier: null };
  const side = m.includes("LEFT") ? "left" : m.includes("RIGHT") ? "right" : null;
  const slight = m.includes("SLIGHT") ? "slight " : m.includes("SHARP") ? "sharp " : "";
  const modifier = side ? `${slight}${side}` : null;
  if (m === "DEPART") return { maneuver: "depart", modifier: null };
  if (m.startsWith("TURN_")) return { maneuver: "turn", modifier };
  if (m.startsWith("UTURN_")) return { maneuver: "uturn", modifier };
  if (m.startsWith("ROUNDABOUT_")) return { maneuver: "roundabout", modifier };
  if (m.startsWith("FORK_")) return { maneuver: "fork", modifier };
  if (m.startsWith("RAMP_") || m === "MERGE") return { maneuver: "merge", modifier };
  if (m === "STRAIGHT" || m === "NAME_CHANGE") return { maneuver: "continue", modifier: "straight" };
  return { maneuver: "other", modifier };
}

export function parseGoogleRoute(body: GoogleResponse): NavRoute | null {
  const r = body.routes?.[0];
  const polyline = r?.polyline?.encodedPolyline;
  if (!r || !polyline || typeof r.distanceMeters !== "number") return null;
  const steps: NavStep[] = [];
  for (const leg of r.legs ?? []) {
    for (const s of leg.steps ?? []) {
      const loc = s.startLocation?.latLng;
      if (!loc) continue;
      const { maneuver, modifier } = maneuverOf(s.navigationInstruction?.maneuver);
      steps.push({
        instruction: s.navigationInstruction?.instructions?.replace(/\s+/g, " ").trim() || "Continue",
        maneuver,
        modifier,
        distanceMeters: s.distanceMeters ?? 0,
        durationSeconds: seconds(s.staticDuration),
        location: { latitude: loc.latitude, longitude: loc.longitude },
      });
    }
    const end = leg.endLocation?.latLng;
    if (end) {
      steps.push({
        instruction: "You have arrived",
        maneuver: "arrive",
        modifier: null,
        distanceMeters: 0,
        durationSeconds: 0,
        location: { latitude: end.latitude, longitude: end.longitude },
      });
    }
  }
  return { provider: "google", polyline, steps, distanceMeters: r.distanceMeters, durationSeconds: seconds(r.duration) };
}

export const googleRoutingProvider: RoutingProvider = {
  name: "google",
  async route(from, to, options) {
    if (!options.googleApiKey) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await options.fetcher("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        signal: controller.signal,
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": options.googleApiKey,
          "X-Goog-FieldMask": [
            "routes.duration",
            "routes.distanceMeters",
            "routes.polyline.encodedPolyline",
            "routes.legs.endLocation",
            "routes.legs.steps.distanceMeters",
            "routes.legs.steps.staticDuration",
            "routes.legs.steps.startLocation",
            "routes.legs.steps.navigationInstruction",
          ].join(","),
        },
        body: JSON.stringify({
          origin: { location: { latLng: from } },
          destination: { location: { latLng: to } },
          travelMode: "TWO_WHEELER",
          routingPreference: "TRAFFIC_AWARE",
          languageCode: "en-IN",
          polylineEncoding: "ENCODED_POLYLINE",
        }),
      });
      if (!res.ok) throw new Error(`Routes API HTTP ${res.status}`);
      return parseGoogleRoute((await res.json()) as GoogleResponse);
    } finally {
      clearTimeout(timer);
    }
  },
};
