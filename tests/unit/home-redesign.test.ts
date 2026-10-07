/**
 * Home / Shops redesign — the pure rules behind the new screens.
 */
import { describe, expect, it } from "vitest";

import { locationAreaName, shortLocationLabel } from "@/lib/location";
import { displayShopName, isNewShop } from "@/lib/shop-display";
import { shopHoursLabel } from "@/lib/shop-hours";
import { parseShopSort } from "@/lib/shop-sort";

describe("displayShopName", () => {
  it("capitalises words typed entirely in lower case", () => {
    expect(displayShopName("Asmy super market")).toBe("Asmy Super Market");
    expect(displayShopName("  anand   dairy & bakery ")).toBe("Anand Dairy & Bakery");
  });

  it("leaves a deliberate spelling alone", () => {
    expect(displayShopName("DMart Express")).toBe("DMart Express");
    expect(displayShopName("eBazaar")).toBe("eBazaar");
    expect(displayShopName("ASMY Mart")).toBe("ASMY Mart");
  });
});

describe("location labels", () => {
  it("drops a saved address's own name for the header pill", () => {
    expect(shortLocationLabel({ label: "Home — Kharadi, Pune, 411014" })).toBe("Kharadi, Pune, 411014");
    expect(shortLocationLabel({ label: "PIN 411014" })).toBe("PIN 411014");
  });

  it("names the area only when the location has one", () => {
    expect(locationAreaName({ label: "Home — Kharadi, Pune, 411014", source: "ADDRESS" })).toBe("Kharadi");
    expect(locationAreaName({ label: "PIN 411014", source: "PINCODE" })).toBeNull();
    expect(locationAreaName({ label: "Current location", source: "DEVICE" })).toBeNull();
  });
});

describe("shopHoursLabel", () => {
  const everyDay = (open: string, close: string) =>
    [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open, close }));
  // 2026-10-07 is a Wednesday. 09:30 UTC = 15:00 IST; 17:30 UTC = 23:00 IST.
  const afternoon = new Date("2026-10-07T09:30:00Z");
  const lateNight = new Date("2026-10-07T17:30:00Z");

  it("says when an open shop closes, in IST", () => {
    expect(shopHoursLabel({ openingHours: everyDay("08:00", "22:00") }, afternoon)).toBe("Open till 10 PM");
    expect(shopHoursLabel({ openingHours: everyDay("08:00", "21:30") }, afternoon)).toBe("Open till 9:30 PM");
  });

  it("says when a closed shop next opens", () => {
    expect(shopHoursLabel({ openingHours: everyDay("08:00", "22:00") }, lateNight)).toBe(
      "Closed · opens Thu 8:00 AM",
    );
  });

  it("treats unset hours as always open", () => {
    expect(shopHoursLabel({ openingHours: [] }, lateNight)).toBe("Open");
  });
});

describe("isNewShop", () => {
  const now = new Date("2026-10-07T00:00:00Z");
  it("is true for the first 30 days only", () => {
    expect(isNewShop(new Date("2026-09-20T00:00:00Z"), now)).toBe(true);
    expect(isNewShop(new Date("2026-08-01T00:00:00Z"), now)).toBe(false);
    expect(isNewShop(null, now)).toBe(false);
  });
});

describe("parseShopSort", () => {
  it("defaults to nearest with a location and name without one", () => {
    expect(parseShopSort(undefined, true)).toBe("nearest");
    expect(parseShopSort(undefined, false)).toBe("name");
    expect(parseShopSort("nearest", false)).toBe("name");
    expect(parseShopSort("rating", false)).toBe("rating");
    expect(parseShopSort("bogus", true)).toBe("nearest");
  });
});
