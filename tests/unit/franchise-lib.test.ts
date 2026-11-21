import { describe, expect, it } from "vitest";

import {
  allocationExpiry,
  boundaryContains,
  compareZoneIds,
  crore,
  formatIst,
  istInstant,
  launchState,
  payoutDate,
  pointInPolygon,
  polygonsFromGeoJson,
  reminderDue,
  renewalOpen,
  renewedExpiry,
  ringsOverlap,
  rupees,
  tailEndAt,
  validateBoundary,
  zoneBadge,
  type LatLng,
} from "@/lib/franchise";

describe("franchise — crore figures", () => {
  it("Indian grouping of ₹ Cr (hundredths)", () => {
    expect(crore(314880)).toBe("3,148.80");
    expect(crore(30165480)).toBe("3,01,654.80");
  });
});

describe("franchise — money (brief §0.6)", () => {
  it("Indian digit grouping", () => {
    expect(rupees(15_000_000)).toBe("₹1,50,000");
    expect(rupees(45_000_000)).toBe("₹4,50,000");
    expect(rupees(25_050)).toBe("₹250.50");
  });
});

describe("franchise — zone ids sort naturally (brief §4.2)", () => {
  it("1A, 1B, 2A … 10 … 66-1 … 70", () => {
    expect(["70", "10", "2A", "1B", "66-1", "1A", "66", "11C"].sort(compareZoneIds)).toEqual(["1A", "1B", "2A", "10", "11C", "66", "66-1", "70"]);
  });
});

describe("franchise — validity in IST (brief §4.5 step 7, §9)", () => {
  const at = istInstant("2026-11-20", 14, 0);
  it("expiry = activation + 12 months − 1 day, 23:59:59 IST", () => {
    const exp = allocationExpiry(at, 12);
    expect(formatIst(exp)).toBe("19-Nov-2027, 23.59 IST");
    expect(exp.toISOString()).toBe("2027-11-19T18:29:59.000Z");
  });
  it("a payment just after midnight IST counts on the IST date", () => {
    expect(formatIst(allocationExpiry(new Date("2026-11-30T18:45:00Z"), 12), false)).toBe("30-Nov-2027"); // 1-Dec 00.15 IST
  });
  it("month ends clamp (31 Jan → 30 Jan next year; 29 Feb → 27 Feb)", () => {
    expect(formatIst(allocationExpiry(istInstant("2027-01-31", 9), 12), false)).toBe("30-Jan-2028");
    expect(formatIst(allocationExpiry(istInstant("2028-02-29", 9), 12), false)).toBe("27-Feb-2029");
  });
  it("renewal extends from the current expiry by 12 months", () => {
    expect(formatIst(renewedExpiry(allocationExpiry(at, 12), 12))).toBe("19-Nov-2028, 23.59 IST");
  });
  it("renewal window: 30 days before expiry up to 23:59:59 IST on the expiry day", () => {
    const exp = allocationExpiry(at, 12);
    expect(renewalOpen(exp, istInstant("2027-10-19", 10), 30)).toBe(false); // 31 days before
    expect(renewalOpen(exp, istInstant("2027-10-20", 0, 0, 1), 30)).toBe(true); // 30 days before
    expect(renewalOpen(exp, istInstant("2027-11-19", 23, 59, 58), 30)).toBe(true);
    expect(renewalOpen(exp, istInstant("2027-11-20", 0, 0, 0), 30)).toBe(false); // after the expiry moment
  });
});

describe("franchise — expiry reminders (brief §9.1)", () => {
  const exp = allocationExpiry(istInstant("2026-11-20", 14), 12); // 19-Nov-2027
  const on = (d: string) => reminderDue(exp, istInstant(d, 10));
  it("30 days, 15 days, then daily from 14 days to the expiry day", () => {
    expect(on("2027-10-20")).toEqual({ kind: "D30", daysLeft: 30 });
    expect(on("2027-10-21")).toBeNull();
    expect(on("2027-11-03")).toBeNull(); // 16 days
    expect(on("2027-11-04")).toEqual({ kind: "D15", daysLeft: 15 });
    expect(on("2027-11-05")).toEqual({ kind: "DAILY", daysLeft: 14 });
    expect(on("2027-11-19")).toEqual({ kind: "DAILY", daysLeft: 0 });
    expect(on("2027-11-20")).toBeNull();
  });
  it("exactly 17 reminders per area", () => {
    let n = 0;
    for (let d = 0; d < 60; d++) if (reminderDue(exp, new Date(istInstant("2027-10-01", 10).getTime() + d * 86_400_000))) n++;
    expect(n).toBe(17);
  });
});

describe("franchise — 3-year tail (brief §9.5)", () => {
  const start = istInstant("2026-11-20", 14);
  const exp = allocationExpiry(start, 12);
  it("fixed_end_of_year_3: end of year 3 from the first activation", () => {
    expect(formatIst(tailEndAt({ chainStartAt: start, expiresAt: exp, mode: "fixed_end_of_year_3", tailYears: 3 }), false)).toBe("19-Nov-2029");
  });
  it("fixed_end_of_year_3 never ends before the allocation itself (renewed into year 4)", () => {
    const late = allocationExpiry(start, 48);
    expect(tailEndAt({ chainStartAt: start, expiresAt: late, mode: "fixed_end_of_year_3", tailYears: 3 }).getTime()).toBe(late.getTime());
  });
  it("years_after_lapse: N years after the expiry", () => {
    expect(formatIst(tailEndAt({ chainStartAt: start, expiresAt: exp, mode: "years_after_lapse", tailYears: 2 }), false)).toBe("19-Nov-2029");
    expect(formatIst(tailEndAt({ chainStartAt: start, expiresAt: allocationExpiry(start, 24), mode: "years_after_lapse", tailYears: 2 }), false)).toBe("19-Nov-2030");
  });
});

describe("franchise — launch offer (brief §3.1)", () => {
  const base = { maxOwners: 25, maxAreas: 25 };
  it("first_limit_reached closes on whichever comes first", () => {
    expect(launchState({ ...base, owners: 10, areas: 24, closeRule: "first_limit_reached" })).toMatchObject({ open: true, placesLeft: 1 });
    expect(launchState({ ...base, owners: 10, areas: 25, closeRule: "first_limit_reached" })).toMatchObject({ open: false, placesLeft: 0 });
    expect(launchState({ ...base, owners: 25, areas: 25, closeRule: "first_limit_reached" }).open).toBe(false);
  });
  it("owners_only / areas_only", () => {
    expect(launchState({ ...base, owners: 10, areas: 40, closeRule: "owners_only" })).toMatchObject({ open: true, placesLeft: 15 });
    expect(launchState({ ...base, owners: 25, areas: 3, closeRule: "owners_only" }).open).toBe(false);
    expect(launchState({ ...base, owners: 30, areas: 3, closeRule: "areas_only" })).toMatchObject({ open: true, placesLeft: 22 });
  });
  it("once closed it stays closed", () => {
    expect(launchState({ ...base, owners: 0, areas: 0, closeRule: "first_limit_reached", closedAt: new Date() })).toMatchObject({ open: false, placesLeft: 0 });
  });
});

describe("franchise — zone badge (final brief §5.6)", () => {
  it("Available with slots, 1 slot left, Sold Out when full; every other status shows itself", () => {
    expect(zoneBadge("AVAILABLE", 2, 0)).toBe("AVAILABLE");
    expect(zoneBadge("AVAILABLE", 2, 1)).toBe("ONE_LEFT");
    expect(zoneBadge("AVAILABLE", 2, 2)).toBe("SOLD_OUT");
    expect(zoneBadge("AVAILABLE", 1, 0)).toBe("AVAILABLE");
    for (const s of ["COMING_SOON", "RESERVED", "ON_HOLD", "SOLD_OUT", "INACTIVE"] as const) expect(zoneBadge(s, 2, 0)).toBe(s);
  });
});

describe("franchise — geometry and the 5 km rule (brief §6)", () => {
  // A ~2 km square around Shivajinagar.
  const ref: LatLng = [18.53, 73.85];
  const square: LatLng[] = [
    [18.52, 73.84],
    [18.52, 73.86],
    [18.54, 73.86],
    [18.54, 73.84],
  ];
  it("point in polygon, edge counts inside", () => {
    expect(pointInPolygon([18.53, 73.85], square)).toBe(true);
    expect(pointInPolygon([18.55, 73.85], square)).toBe(false);
    expect(pointInPolygon([18.52, 73.85], square)).toBe(true);
  });
  it("a valid polygon inside 5 km passes", () => {
    expect(validateBoundary({ shape: "POLYGON", polygon: square, ref }, 5)).toMatchObject({ ok: true });
  });
  it("a point farther than 5 km fails", () => {
    const far: LatLng[] = [...square.slice(0, 3), [18.6, 73.84]];
    const r = validateBoundary({ shape: "POLYGON", polygon: far, ref }, 5);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/limit is 5 km/);
  });
  it("crossing edges (a bow tie) fail", () => {
    const bow: LatLng[] = [square[0], square[2], square[1], square[3]];
    expect(validateBoundary({ shape: "POLYGON", polygon: bow, ref }, 5).errors.join(" ")).toMatch(/cross/);
  });
  it("circle radius above 5 km fails; inside passes", () => {
    expect(validateBoundary({ shape: "CIRCLE", center: ref, radiusM: 6000, ref }, 5).ok).toBe(false);
    expect(validateBoundary({ shape: "CIRCLE", center: ref, radiusM: 3000, ref }, 5).ok).toBe(true);
    expect(boundaryContains({ shape: "CIRCLE", center: ref, radiusM: 3000 }, [18.54, 73.85])).toBe(true);
  });
  it("overlap: crossing, contained; touching edges do not overlap", () => {
    const shifted = square.map(([a, b]) => [a + 0.01, b + 0.01] as LatLng);
    const inside = [
      [18.525, 73.845],
      [18.525, 73.855],
      [18.535, 73.855],
    ] as LatLng[];
    const neighbour = square.map(([a, b]) => [a, b + 0.02] as LatLng);
    expect(ringsOverlap(square, shifted)).toBe(true);
    expect(ringsOverlap(square, inside)).toBe(true);
    expect(ringsOverlap(square, neighbour)).toBe(false);
  });
  it("GeoJSON [lng, lat] is read as [lat, lng] with the zone id", () => {
    const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: { zone_id: "9b" }, geometry: { type: "Polygon", coordinates: [[[73.84, 18.52], [73.86, 18.52], [73.86, 18.54], [73.84, 18.52]]] } }] };
    expect(polygonsFromGeoJson(fc)).toEqual([{ zoneId: "9B", polygon: [[18.52, 73.84], [18.52, 73.86], [18.54, 73.86]] }]);
  });
});

describe("franchise — payout day (brief §8.4)", () => {
  it("the 5th, or the next working day", () => {
    expect(payoutDate("2026-12", 5, [])).toBe("2026-12-05"); // Saturday is a working day
    expect(payoutDate("2027-09", 5, [])).toBe("2027-09-06"); // Sunday → Monday
    expect(payoutDate("2026-12", 5, ["2026-12-05"])).toBe("2026-12-07"); // holiday Sat → Sun skipped → Mon
  });
});
