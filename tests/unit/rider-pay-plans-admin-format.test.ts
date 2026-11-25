import { describe, expect, it } from "vitest";

import {
  formatIstDateTime,
  formToBody,
  istInputToUtcIso,
  kmToMetresOrNull,
  multiplierToBp,
  nextSlab,
  parseKmList,
  rupeesToPaiseOrNull,
  surgeState,
  termsToForm,
  utcToIstInput,
} from "@/components/admin/rider-pay-plans/format";
import { toPlanRow } from "@/components/admin/rider-pay-plans/serialize";
import { planProblems, PUNE_PILOT_PLAN } from "@/lib/rider-pay-plan";

describe("rider pay plans admin: IST dates", () => {
  it("formats an instant as DD-Mmm-YYYY hh.mm IST", () => {
    expect(formatIstDateTime("2026-11-25T04:00:00.000Z")).toBe("25-Nov-2026 09.30 IST");
    expect(formatIstDateTime(new Date("2026-12-31T20:00:00Z"))).toBe("01-Jan-2027 01.30 IST");
    expect(formatIstDateTime(null)).toBe("—");
    expect(formatIstDateTime("not a date")).toBe("—");
  });

  it("reads a datetime-local value as IST and converts to UTC (and back)", () => {
    expect(istInputToUtcIso("2026-11-26T09:30")).toBe("2026-11-26T04:00:00.000Z");
    expect(istInputToUtcIso("2026-11-26T02:00")).toBe("2026-11-25T20:30:00.000Z");
    expect(istInputToUtcIso("")).toBeNull();
    expect(istInputToUtcIso("tomorrow")).toBeNull();
    expect(utcToIstInput(new Date("2026-11-26T04:00:00Z"))).toBe("2026-11-26T09:30");
  });
});

describe("rider pay plans admin: units", () => {
  it("converts rupees to paise and km to metres", () => {
    expect(rupeesToPaiseOrNull("12.5")).toBe(1250);
    expect(rupeesToPaiseOrNull("₹1,200")).toBe(120000);
    expect(rupeesToPaiseOrNull("0.1")).toBe(10);
    expect(rupeesToPaiseOrNull("")).toBeNull();
    expect(rupeesToPaiseOrNull("-1")).toBeNull();
    expect(kmToMetresOrNull("2.5")).toBe(2500);
    expect(kmToMetresOrNull("abc")).toBeNull();
  });

  it("turns a multiplier into basis points", () => {
    expect(multiplierToBp("1.3")).toBe(13000);
    expect(multiplierToBp("×1.25")).toBe(12500);
    expect(multiplierToBp("")).toBeNull();
    expect(multiplierToBp("0")).toBeNull();
  });

  it("parses a list of km and reports what is not a distance", () => {
    expect(parseKmList("1.5, 2 3")).toEqual({ km: [1.5, 2, 3], bad: [] });
    expect(parseKmList("1, x")).toEqual({ km: [1], bad: ["x"] });
    expect(parseKmList("")).toEqual({ km: [], bad: [] });
  });
});

describe("rider pay plans admin: form", () => {
  it("round-trips the Pune pilot numbers through the form unchanged", () => {
    const form = termsToForm(PUNE_PILOT_PLAN, { name: "Pune pilot", scopeType: "CITY", city: "Pune" });
    expect(form.slabs[3]).toEqual({ fromKm: "10", toKm: "", ratePerKm: "12" });
    const { body, errors } = formToBody(form);
    expect(errors).toEqual([]);
    const { id: _id, version: _v, ...terms } = { id: null, version: null, ...PUNE_PILOT_PLAN };
    void [_id, _v];
    expect(body).toEqual({ ...terms, name: "Pune pilot", scopeType: "CITY", city: "Pune", zoneId: null, note: null });
    expect(planProblems(body)).toEqual([]);
  });

  it("reports fields that are not numbers and missing scope details", () => {
    const form = { ...termsToForm(PUNE_PILOT_PLAN), name: "", scopeType: "ZONE" as const, baseFee: "abc" };
    const { errors } = formToBody(form);
    expect(errors).toContain("Base fee: enter an amount in rupees.");
    expect(errors).toContain("Give the plan a name.");
    expect(errors).toContain("Choose the zone this plan is for.");
  });

  it("treats blank 'to km', long distance and cap as open", () => {
    const form = { ...termsToForm(PUNE_PILOT_PLAN), name: "x", longDistanceKm: "", maxPerOrder: "" };
    const { body } = formToBody(form);
    expect(body.longDistanceM).toBeNull();
    expect(body.maxPerOrderPaise).toBeNull();
    expect(body.slabs[body.slabs.length - 1].toM).toBeNull();
  });

  it("starts a new slab where the last one ends", () => {
    const form = { ...termsToForm(PUNE_PILOT_PLAN), slabs: [{ fromKm: "2", toKm: "5", ratePerKm: "6" }] };
    expect(nextSlab(form)).toEqual({ fromKm: "5", toKm: "", ratePerKm: "6" });
  });
});

describe("rider pay plans admin: surges and serialising", () => {
  const now = new Date("2026-11-25T10:00:00Z");
  it("labels a surge live, scheduled or ended", () => {
    expect(surgeState({ startsAt: "2026-11-25T09:00:00Z", endsAt: "2026-11-25T12:00:00Z", endedAt: null }, now)).toBe("live");
    expect(surgeState({ startsAt: "2026-11-25T11:00:00Z", endsAt: "2026-11-25T12:00:00Z", endedAt: null }, now)).toBe("scheduled");
    expect(surgeState({ startsAt: "2026-11-25T08:00:00Z", endsAt: "2026-11-25T09:00:00Z", endedAt: null }, now)).toBe("ended");
    expect(surgeState({ startsAt: "2026-11-25T09:00:00Z", endsAt: "2026-11-25T12:00:00Z", endedAt: "2026-11-25T09:30:00Z" }, now)).toBe("ended");
  });

  it("marks a simulator run current only when made after the last edit", () => {
    const base = {
      ...PUNE_PILOT_PLAN,
      id: "p1",
      planKey: "k1",
      version: 2,
      name: "Pune",
      scopeType: "CITY",
      city: "Pune",
      zoneId: null,
      status: "DRAFT",
      effectiveFrom: null,
      publishedAt: null,
      note: null,
      simulation: { days: 7 },
      updatedAt: new Date("2026-11-25T10:00:00Z"),
    };
    expect(toPlanRow({ ...base, simulatedAt: new Date("2026-11-25T10:05:00Z") }).simulationCurrent).toBe(true);
    expect(toPlanRow({ ...base, simulatedAt: new Date("2026-11-25T09:55:00Z") }).simulationCurrent).toBe(false);
    expect(toPlanRow({ ...base, simulation: null, simulatedAt: null }).simulationCurrent).toBe(false);
    expect(toPlanRow({ ...base, simulatedAt: null }).label).toBe("Pune v2");
  });
});
