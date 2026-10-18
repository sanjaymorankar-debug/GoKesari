/**
 * batch-2026-10 WS-B — F4.2.2 navigation geometry and provider parsing
 * (pure; no database or network).
 */
import { describe, expect, it } from "vitest";

import {
  decodePolyline,
  encodePolyline,
  formatDistance,
  isOffRoute,
  metersBetween,
  metersToStep,
  nextStepIndex,
  routeProgress,
  type NavStep,
} from "@/lib/navigation/geometry";
import { parseGoogleRoute } from "@/server/routing/google";
import { straightLineNavRoute } from "@/server/routing/mock";
import { osrmInstruction, parseOsrmRoute, type OsrmResponse } from "@/server/routing/osrm";

const A = { latitude: 18.5204, longitude: 73.8567 };
const B = { latitude: 18.5304, longitude: 73.8567 }; // ~1.11 km due north
const metresNorth = (p: typeof A, m: number) => ({ latitude: p.latitude + m / 111_195, longitude: p.longitude });
const metresEast = (p: typeof A, m: number) => ({
  latitude: p.latitude,
  longitude: p.longitude + m / (111_195 * Math.cos((p.latitude * Math.PI) / 180)),
});

describe("polyline", () => {
  it("TC-B26-B-028 decodes Google's reference polyline and round-trips encode/decode", () => {
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(pts).toEqual([
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ]);
    expect(encodePolyline(pts)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    const line = [A, metresNorth(A, 300), metresEast(metresNorth(A, 300), 250)];
    decodePolyline(encodePolyline(line)).forEach((p, i) => {
      expect(p.latitude).toBeCloseTo(line[i].latitude, 5);
      expect(p.longitude).toBeCloseTo(line[i].longitude, 5);
    });
  });
});

describe("off-route detection", () => {
  const line = [A, B];

  it("TC-B26-B-029 a point on the route is ~0 m off; 100 m to the side is ~100 m off", () => {
    expect(routeProgress(metresNorth(A, 500), line).offRouteMeters).toBeLessThan(1);
    const side = metresEast(metresNorth(A, 500), 100);
    expect(routeProgress(side, line).offRouteMeters).toBeGreaterThan(97);
    expect(routeProgress(side, line).offRouteMeters).toBeLessThan(103);
  });

  it("TC-B26-B-030 isOffRoute compares against the threshold; beyond the end counts the distance to the end point", () => {
    const side = metresEast(metresNorth(A, 500), 80);
    expect(isOffRoute(side, line, 60)).toBe(true);
    expect(isOffRoute(side, line, 100)).toBe(false);
    const past = metresNorth(B, 200);
    expect(routeProgress(past, line).offRouteMeters).toBeCloseTo(200, -1);
  });

  it("TC-B26-B-031 progress along the route: travelled and remaining metres add up to the route length", () => {
    const total = metersBetween(A, B);
    const p = routeProgress(metresNorth(A, 400), line);
    expect(p.alongMeters).toBeCloseTo(400, -1);
    expect(p.alongMeters + p.remainingMeters).toBeCloseTo(total, 0);
  });

  it("TC-B26-B-032 the next step is the first manoeuvre still ahead; distance to it shrinks as the rider moves", () => {
    const step = (d: number): NavStep => ({ instruction: "x", maneuver: "turn", modifier: "left", distanceMeters: d, durationSeconds: 0, location: A });
    const steps = [step(300), step(500), step(0)];
    expect(nextStepIndex(steps, 0)).toBe(1);
    expect(nextStepIndex(steps, 290)).toBe(1);
    // Within 5 m of the turn it counts as reached: the next instruction shows.
    expect(nextStepIndex(steps, 296)).toBe(2);
    expect(nextStepIndex(steps, 310)).toBe(2);
    expect(metersToStep(steps, 1, 100)).toBe(200);
    expect(formatDistance(345)).toBe("350 m");
    expect(formatDistance(1234)).toBe("1.2 km");
  });
});

describe("routing adapters (parsing)", () => {
  it("TC-B26-B-033 mock: a straight line with depart / continue / arrive steps and a speed-based ETA", () => {
    const r = straightLineNavRoute(A, B);
    expect(r.provider).toBe("mock");
    expect(decodePolyline(r.polyline).length).toBe(9);
    expect(r.steps.map((s) => s.maneuver)).toEqual(["depart", "continue", "arrive"]);
    expect(r.steps[0].instruction).toBe("Head north");
    expect(r.distanceMeters).toBeCloseTo(1112, -1);
    expect(r.durationSeconds).toBe(Math.round((r.distanceMeters / 1000 / 20) * 3600));
  });

  it("TC-B26-B-034 OSRM: geometry, steps with plain-English instructions, distance and duration", () => {
    const body: OsrmResponse = {
      code: "Ok",
      routes: [
        {
          geometry: encodePolyline([A, B]),
          distance: 1250.4,
          duration: 300.6,
          legs: [
            {
              steps: [
                { distance: 400, duration: 90, name: "FC Road", maneuver: { type: "depart", location: [A.longitude, A.latitude] } },
                { distance: 850, duration: 210, name: "JM Road", maneuver: { type: "turn", modifier: "left", location: [73.86, 18.524] } },
                { distance: 0, duration: 0, name: "", maneuver: { type: "arrive", location: [B.longitude, B.latitude] } },
              ],
            },
          ],
        },
      ],
    };
    const r = parseOsrmRoute(body)!;
    expect(r).toMatchObject({ provider: "osrm", distanceMeters: 1250, durationSeconds: 301 });
    expect(r.steps.map((s) => s.instruction)).toEqual(["Start on FC Road", "Turn left onto JM Road", "You have arrived"]);
    expect(r.steps[1]).toMatchObject({ maneuver: "turn", modifier: "left", location: { latitude: 18.524, longitude: 73.86 } });
    expect(parseOsrmRoute({ code: "NoRoute", routes: [] })).toBeNull();
    expect(osrmInstruction({ distance: 1, duration: 1, maneuver: { type: "roundabout", exit: 2, location: [0, 0] } })).toBe(
      "At the roundabout, take exit 2",
    );
  });

  it("TC-B26-B-035 Google Routes: polyline, navigation instructions, manoeuvres and a final arrive step", () => {
    const r = parseGoogleRoute({
      routes: [
        {
          distanceMeters: 1300,
          duration: "320s",
          polyline: { encodedPolyline: encodePolyline([A, B]) },
          legs: [
            {
              endLocation: { latLng: B },
              steps: [
                { distanceMeters: 500, staticDuration: "120s", startLocation: { latLng: A }, navigationInstruction: { maneuver: "DEPART", instructions: "Head north" } },
                { distanceMeters: 800, staticDuration: "200s", startLocation: { latLng: metresNorth(A, 500) }, navigationInstruction: { maneuver: "TURN_SLIGHT_RIGHT", instructions: "Slight right onto\nMG Road" } },
              ],
            },
          ],
        },
      ],
    })!;
    expect(r).toMatchObject({ provider: "google", distanceMeters: 1300, durationSeconds: 320 });
    expect(r.steps.map((s) => [s.maneuver, s.modifier, s.instruction])).toEqual([
      ["depart", null, "Head north"],
      ["turn", "slight right", "Slight right onto MG Road"],
      ["arrive", null, "You have arrived"],
    ]);
    expect(parseGoogleRoute({ routes: [] })).toBeNull();
  });
});
