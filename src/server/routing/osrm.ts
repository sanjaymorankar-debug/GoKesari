/**
 * OSRM adapter (any OSRM-compatible HTTP API: a self-hosted OSRM, the public
 * demo server, or an OSRM-compatible gateway). Base URL from rule
 * riderNavigation.osrmBaseUrl. Uses the route service with full overview
 * geometry (polyline, precision 5) and steps.
 */
import type { LatLng, ManeuverType, NavRoute, NavStep } from "@/lib/navigation/geometry";
import type { RoutingProvider } from "./types";

export interface OsrmStep {
  distance: number;
  duration: number;
  name?: string;
  maneuver: { type: string; modifier?: string; location: [number, number]; exit?: number };
}
export interface OsrmResponse {
  code?: string;
  routes?: { geometry: string; distance: number; duration: number; legs?: { steps?: OsrmStep[] }[] }[];
}

const TYPE_MAP: Record<string, ManeuverType> = {
  depart: "depart",
  arrive: "arrive",
  turn: "turn",
  "end of road": "turn",
  continue: "continue",
  "new name": "continue",
  notification: "continue",
  merge: "merge",
  "on ramp": "merge",
  "off ramp": "merge",
  fork: "fork",
  roundabout: "roundabout",
  rotary: "roundabout",
  "roundabout turn": "roundabout",
  "exit roundabout": "roundabout",
  "exit rotary": "roundabout",
};

/** Plain-English instruction for one OSRM step (OSRM itself returns no text). */
export function osrmInstruction(step: OsrmStep): string {
  const { type, modifier, exit } = step.maneuver;
  const onto = step.name ? ` onto ${step.name}` : "";
  const dir = modifier ?? "";
  switch (type) {
    case "depart":
      return step.name ? `Start on ${step.name}` : "Start";
    case "arrive":
      return "You have arrived";
    case "turn":
      return dir === "uturn" ? `Make a U-turn${onto}` : dir === "straight" ? `Go straight${onto}` : `Turn ${dir}${onto}`;
    case "end of road":
      return `At the end of the road, turn ${dir}${onto}`;
    case "merge":
      return `Merge ${dir}${onto}`.replace("  ", " ");
    case "on ramp":
      return `Take the ramp ${dir}${onto}`.replace("  ", " ");
    case "off ramp":
      return `Take the exit ${dir}${onto}`.replace("  ", " ");
    case "fork":
      return `Keep ${dir} at the fork${onto}`;
    case "roundabout":
    case "rotary":
    case "roundabout turn":
      return exit ? `At the roundabout, take exit ${exit}${onto}` : `Go through the roundabout${onto}`;
    case "exit roundabout":
    case "exit rotary":
      return `Exit the roundabout${onto}`;
    default:
      return dir ? `Continue ${dir}${onto}` : `Continue${onto}`;
  }
}

export function parseOsrmRoute(body: OsrmResponse): NavRoute | null {
  const r = body.routes?.[0];
  if (body.code !== "Ok" || !r || typeof r.geometry !== "string") return null;
  const steps: NavStep[] = (r.legs ?? []).flatMap((leg) =>
    (leg.steps ?? []).map((s) => {
      const location: LatLng = { latitude: s.maneuver.location[1], longitude: s.maneuver.location[0] };
      const maneuver: ManeuverType = s.maneuver.modifier === "uturn" ? "uturn" : (TYPE_MAP[s.maneuver.type] ?? "other");
      return {
        instruction: osrmInstruction(s),
        maneuver,
        modifier: s.maneuver.modifier ?? null,
        distanceMeters: Math.round(s.distance),
        durationSeconds: Math.round(s.duration),
        location,
      };
    }),
  );
  return {
    provider: "osrm",
    polyline: r.geometry,
    steps,
    distanceMeters: Math.round(r.distance),
    durationSeconds: Math.round(r.duration),
  };
}

export const osrmRoutingProvider: RoutingProvider = {
  name: "osrm",
  async route(from, to, options) {
    const base = (options.osrmBaseUrl ?? "").replace(/\/$/, "");
    if (!base) return null;
    const url =
      `${base}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}` +
      `?overview=full&geometries=polyline&steps=true`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await options.fetcher(url, { method: "GET", signal: controller.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
      return parseOsrmRoute((await res.json()) as OsrmResponse);
    } finally {
      clearTimeout(timer);
    }
  },
};
