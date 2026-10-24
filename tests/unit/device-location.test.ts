/**
 * Finding the shopper's position in the browser (owner request, 24 Oct 2026:
 * "user location is not detected") — lib/device-location.ts with a fake
 * geolocation, permissions and fetch: the quick network fix, the GPS retry,
 * a refusal that is final, the pages that detect by themselves, and the
 * wording for every failure in all three languages.
 */
import { describe, expect, it, vi } from "vitest";

import {
  GPS_FIX,
  QUICK_FIX,
  findDevicePosition,
  isDiscoveryPath,
  locationPermission,
  saveDevicePosition,
  type LocationEnv,
} from "@/lib/device-location";
import { LANGUAGES } from "@/lib/board/i18n";
import { cleanAddress } from "@/lib/geo/nearby";
import { LOCATION_PROBLEM_TEXT } from "@/lib/home-i18n";
import { locationAreaName, parseLocation, shortLocationLabel } from "@/lib/location";

type Answer = { coords: { latitude: number; longitude: number; accuracy: number } } | { code: number };

/** A geolocation that gives the answers in turn, and records the options it was asked with. */
function fakeGeo(...answers: Answer[]) {
  const asked: PositionOptions[] = [];
  const geolocation = {
    getCurrentPosition: (ok: PositionCallback, fail?: PositionErrorCallback | null, options?: PositionOptions) => {
      asked.push(options ?? {});
      const answer = answers.shift() ?? { code: 2 };
      if ("coords" in answer) ok(answer as unknown as GeolocationPosition);
      else fail?.(answer as GeolocationPositionError);
    },
  };
  return { asked, env: { geolocation, isSecureContext: true } satisfies LocationEnv };
}

const KHARADI = { coords: { latitude: 18.5515, longitude: 73.9348, accuracy: 24.6 } };

describe("findDevicePosition", () => {
  it("takes the quick network fix when there is one", async () => {
    const { asked, env } = fakeGeo(KHARADI);
    expect(await findDevicePosition(env)).toEqual({ ok: true, position: { latitude: 18.5515, longitude: 73.9348, accuracyM: 25 } });
    expect(asked).toEqual([QUICK_FIX]);
  });

  it("tries GPS once more when the quick fix times out or finds nothing", async () => {
    const slow = fakeGeo({ code: 3 }, KHARADI);
    expect(await findDevicePosition(slow.env)).toMatchObject({ ok: true });
    expect(slow.asked).toEqual([QUICK_FIX, GPS_FIX]);

    const off = fakeGeo({ code: 2 }, { code: 2 });
    expect(await findDevicePosition(off.env)).toEqual({ ok: false, problem: "UNAVAILABLE" });
    expect(off.asked).toHaveLength(2);

    const stillSlow = fakeGeo({ code: 3 }, { code: 3 });
    expect(await findDevicePosition(stillSlow.env)).toEqual({ ok: false, problem: "TIMEOUT" });
  });

  it("a refusal is final: not asked again", async () => {
    const { asked, env } = fakeGeo({ code: 1 }, KHARADI);
    expect(await findDevicePosition(env)).toEqual({ ok: false, problem: "DENIED" });
    expect(asked).toHaveLength(1);
  });

  it("no secure page, no geolocation, or a position at 0,0: a clear problem, never a wrong place", async () => {
    expect(await findDevicePosition({ geolocation: fakeGeo(KHARADI).env.geolocation, isSecureContext: false })).toEqual({ ok: false, problem: "INSECURE" });
    expect(await findDevicePosition({ geolocation: null, isSecureContext: true })).toEqual({ ok: false, problem: "UNSUPPORTED" });
    const nowhere = { coords: { latitude: 0, longitude: 0, accuracy: 10 } };
    expect(await findDevicePosition(fakeGeo(nowhere, nowhere).env)).toEqual({ ok: false, problem: "UNAVAILABLE" });
    const throwing = { getCurrentPosition: () => { throw new Error("blocked by policy"); } };
    expect(await findDevicePosition({ geolocation: throwing, isSecureContext: true })).toEqual({ ok: false, problem: "UNAVAILABLE" });
  });
});

describe("locationPermission", () => {
  it("reads the browser's answer, and says 'unknown' where it cannot", async () => {
    const env = (state: PermissionState | Error): LocationEnv => ({
      geolocation: null,
      isSecureContext: true,
      permissions: { query: async () => { if (state instanceof Error) throw state; return { state } as PermissionStatus; } },
    });
    expect(await locationPermission(env("granted"))).toBe("granted");
    expect(await locationPermission(env("denied"))).toBe("denied");
    expect(await locationPermission(env(new TypeError("geolocation is not a valid permission name")))).toBe("unknown");
    expect(await locationPermission({ geolocation: null, isSecureContext: true, permissions: null })).toBe("unknown");
  });
});

describe("saveDevicePosition", () => {
  it("posts the position (with ifUnset for the automatic detection) and reads whether it was saved", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ label: "PIN 411001", saved: false }), { status: 200 }));
    expect(await saveDevicePosition({ latitude: 18.5, longitude: 73.9 }, { ifUnset: true }, fetchImpl)).toEqual({ saved: false, label: "PIN 411001" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/location");
    expect(JSON.parse(init.body as string)).toEqual({ latitude: 18.5, longitude: 73.9, ifUnset: true });

    const plain = vi.fn(async () => new Response(JSON.stringify({ label: "Kharadi, Pune", saved: true }), { status: 200 }));
    expect(await saveDevicePosition({ latitude: 18.5, longitude: 73.9 }, {}, plain)).toEqual({ saved: true, label: "Kharadi, Pune" });
    expect(JSON.parse((plain.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ latitude: 18.5, longitude: 73.9 });
  });

  it("passes the server's message on when it refuses", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "Too many requests." } }), { status: 429 });
    await expect(saveDevicePosition({ latitude: 18.5, longitude: 73.9 }, {}, fetchImpl)).rejects.toThrow("Too many requests.");
  });
});

describe("where the location is found by itself", () => {
  it("home, shops, a shop, search and categories — not the Nearby screen (it asks itself) or account pages", () => {
    for (const path of ["/", "/shops", "/shops/kharadi-dairy-1a2b", "/search", "/search/compare", "/category/dairy"]) {
      expect(isDiscoveryPath(path), path).toBe(true);
    }
    for (const path of ["/shops/nearby", "/cart", "/orders", "/profile/addresses", "/signin", "/admin", "/shop", "/searching", null]) {
      expect(isDiscoveryPath(path), String(path)).toBe(false);
    }
  });
});

describe("wording", () => {
  it("every failure has its own words in English, Hindi and Marathi", () => {
    for (const [problem, text] of Object.entries(LOCATION_PROBLEM_TEXT)) {
      for (const lang of LANGUAGES) expect(text[lang], `${problem} ${lang}`).toMatch(/\S/);
    }
    expect(new Set(Object.values(LOCATION_PROBLEM_TEXT)).size).toBe(5);
  });
});

describe("the exact address as the location text", () => {
  it("drops a plus code in front and ', India' at the end; a bare plus code alone is no address", () => {
    expect(cleanAddress("HWX3+JW, Eon Free Zone, Kharadi, Pune, Maharashtra 411014, India")).toBe("Eon Free Zone, Kharadi, Pune, Maharashtra 411014");
    expect(cleanAddress("12, Lane 5, Kharadi, Pune, Maharashtra 411014, India")).toBe("12, Lane 5, Kharadi, Pune, Maharashtra 411014");
    expect(cleanAddress("Gateway of India, Apollo Bandar, Colaba, Mumbai, Maharashtra 400001, India")).toBe("Gateway of India, Apollo Bandar, Colaba, Mumbai, Maharashtra 400001");
    expect(cleanAddress("HWX3+JW")).toBeNull();
    expect(cleanAddress("")).toBeNull();
    expect(cleanAddress(null)).toBeNull();
  });

  it("fits the 120 characters a location label keeps, cut at a comma", () => {
    const long = "Building 4, Phase 2, Some Very Long Technology Park Name, Near The Big Landmark Junction, Kharadi, Pune, Maharashtra 411014, India";
    const short = cleanAddress(long)!;
    expect(short.length).toBeLessThanOrEqual(120);
    expect(short).toBe("Building 4, Phase 2, Some Very Long Technology Park Name, Near The Big Landmark Junction, Kharadi, Pune");
  });

  it("headings use the saved area, not the building; older cookies without an area still read", () => {
    const exact = { label: "Eon Free Zone, Kharadi, Pune, Maharashtra 411014", source: "DEVICE" as const, area: "Kharadi" };
    expect(locationAreaName(exact)).toBe("Kharadi");
    expect(shortLocationLabel(exact)).toBe("Eon Free Zone, Kharadi, Pune, Maharashtra 411014");
    const old = parseLocation(JSON.stringify({ label: "Kharadi, Pune", pincode: null, latitude: 18.5515, longitude: 73.9348, source: "DEVICE", addressId: null }));
    expect(old).toMatchObject({ label: "Kharadi, Pune", societyId: null });
    expect(locationAreaName(old!)).toBe("Kharadi");
  });
});
