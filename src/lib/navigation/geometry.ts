/**
 * Route geometry for in-app rider navigation (F4.2.2 — batch-2026-10 WS-B):
 * Google/OSRM encoded polylines, distance from a point to the route (off-route
 * detection), progress along it and which step is next. Pure functions — used
 * by the server's routing adapters and by the rider's navigation screen.
 */
import { haversineDistanceKm } from "@/lib/geo/haversine";

export interface LatLng {
  latitude: number;
  longitude: number;
}

export type ManeuverType =
  | "depart"
  | "turn"
  | "continue"
  | "merge"
  | "fork"
  | "roundabout"
  | "uturn"
  | "arrive"
  | "other";

export interface NavStep {
  instruction: string;
  maneuver: ManeuverType;
  /** left / right / slight left / straight … when the provider says. */
  modifier: string | null;
  distanceMeters: number;
  durationSeconds: number;
  /** Where the manoeuvre happens (start of the step). */
  location: LatLng;
}

export interface NavRoute {
  /** mock and straight_line are the synthetic fallback (no routing service involved). */
  provider: "mock" | "google" | "osrm" | "straight_line";
  /** Encoded polyline, precision 5 (Google's format, also OSRM's default). */
  polyline: string;
  steps: NavStep[];
  distanceMeters: number;
  durationSeconds: number;
}

export const metersBetween = (a: LatLng, b: LatLng): number => haversineDistanceKm(a, b) * 1000;

/** Decodes an encoded polyline (Google algorithm). */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= encoded.length) return points;
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push({ latitude: lat / factor, longitude: lng / factor });
  }
  return points;
}

/** Encodes points as a polyline (Google algorithm). */
export function encodePolyline(points: readonly LatLng[], precision = 5): string {
  const factor = 10 ** precision;
  let out = "";
  let prevLat = 0;
  let prevLng = 0;
  const encodeValue = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = "";
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return chunk + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.latitude * factor);
    const lng = Math.round(p.longitude * factor);
    out += encodeValue(lat - prevLat) + encodeValue(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

/** Local flat projection (metres) around `origin` — accurate enough over a city ride. */
function toXY(p: LatLng, origin: LatLng): { x: number; y: number } {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  return {
    x: (p.longitude - origin.longitude) * rad * R * Math.cos(origin.latitude * rad),
    y: (p.latitude - origin.latitude) * rad * R,
  };
}

/** Shortest distance (m) from `p` to the segment a–b, and how far along it (0..1) the nearest point is. */
export function distanceToSegmentMeters(p: LatLng, a: LatLng, b: LatLng): { meters: number; t: number } {
  const A = toXY(a, p);
  const B = toXY(b, p);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / len2));
  const x = A.x + t * dx;
  const y = A.y + t * dy;
  return { meters: Math.hypot(x, y), t };
}

export interface RouteProgress {
  /** Distance from the route line (m). */
  offRouteMeters: number;
  /** Distance travelled along the route to the nearest point (m). */
  alongMeters: number;
  /** Distance still to go along the route (m). */
  remainingMeters: number;
  segmentIndex: number;
}

/** Where `p` is relative to the route line. */
export function routeProgress(p: LatLng, line: readonly LatLng[]): RouteProgress {
  if (line.length === 0) return { offRouteMeters: Infinity, alongMeters: 0, remainingMeters: 0, segmentIndex: 0 };
  if (line.length === 1) {
    const d = metersBetween(p, line[0]);
    return { offRouteMeters: d, alongMeters: 0, remainingMeters: 0, segmentIndex: 0 };
  }
  const segLengths: number[] = [];
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const len = metersBetween(line[i], line[i + 1]);
    segLengths.push(len);
    total += len;
  }
  let best = { meters: Infinity, along: 0, index: 0 };
  let before = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const { meters, t } = distanceToSegmentMeters(p, line[i], line[i + 1]);
    if (meters < best.meters) best = { meters, along: before + t * segLengths[i], index: i };
    before += segLengths[i];
  }
  return { offRouteMeters: best.meters, alongMeters: best.along, remainingMeters: Math.max(0, total - best.along), segmentIndex: best.index };
}

/** True when `p` is further than `thresholdMeters` from the route line. */
export function isOffRoute(p: LatLng, line: readonly LatLng[], thresholdMeters: number): boolean {
  return routeProgress(p, line).offRouteMeters > thresholdMeters;
}

/**
 * The step the rider is working towards: the first one whose manoeuvre point
 * is still ahead of how far they have come along the route.
 */
export function nextStepIndex(steps: readonly NavStep[], alongMeters: number): number {
  let start = 0;
  for (let i = 0; i < steps.length; i++) {
    if (start > alongMeters + 5) return i;
    start += steps[i].distanceMeters;
  }
  return Math.max(0, steps.length - 1);
}

/** Distance from the rider's progress to the start of step `index` (m). */
export function metersToStep(steps: readonly NavStep[], index: number, alongMeters: number): number {
  let start = 0;
  for (let i = 0; i < index; i++) start += steps[i].distanceMeters;
  return Math.max(0, start - alongMeters);
}

/** "350 m" / "1.2 km". */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Initial compass bearing a → b, degrees 0..360. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b.longitude - a.longitude) * rad) * Math.cos(b.latitude * rad);
  const x =
    Math.cos(a.latitude * rad) * Math.sin(b.latitude * rad) -
    Math.sin(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.cos((b.longitude - a.longitude) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
export const compassWord = (deg: number): string => COMPASS[Math.round(deg / 45) % 8];
