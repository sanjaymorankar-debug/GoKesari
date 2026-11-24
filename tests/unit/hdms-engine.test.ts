/** Pure parts of delivery management (docs/hdms-2026-11): pricing, ranking, geometry, masking, booking machine. */
import { describe, expect, it } from "vitest";

import { canMoveBooking, maskPhone } from "@/server/delivery/bookings";
import { haversineMeters, parsePoint, pointInPolygon } from "@/server/delivery/geo";
import { isPeak, istClock, priceDelivery } from "@/server/delivery/pricing";
import { redactPayload } from "@/server/delivery/webhooks";
import { pickZone, zoneContains, zoneIsOpen } from "@/server/delivery/zones";

import { etaBandMinutes, partnerRejection, rankCandidates, type Candidate } from "@/server/delivery/allocation";

const base = {
  id: "r1",
  commercialModel: "CUSTOMER_PAYS" as const,
  minFeePaise: 2000,
  baseKm: "2",
  perKmPaise: 800,
  freeWeightGrams: 5000,
  perKgPaise: 500,
  expressSurchargePaise: 1000,
  peakSurchargePaise: 1000,
  peakWindows: [{ from: "18:00", to: "21:00" }],
  freeAbovePaise: null,
  shopSharePercent: 50,
  gokesariSubsidyPaise: 0,
  promoDiscountPaise: 0,
  maxFeePaise: null,
};
const offPeak = new Date("2026-11-23T06:30:00Z"); // 12:00 IST
const peak = new Date("2026-11-23T13:30:00Z"); // 19:00 IST

describe("pricing engine", () => {
  it("minimum fee within the base distance", () => {
    const p = priceDelivery(base, { distanceM: 1500, weightGrams: 1000, basketPaise: 20000, express: false, at: offPeak });
    expect(p.totalFeePaise).toBe(2000);
    expect(p.customerPaise).toBe(2000);
  });
  it("distance, weight, express and peak add up", () => {
    const p = priceDelivery(base, { distanceM: 5000, weightGrams: 7200, basketPaise: 20000, express: true, at: peak });
    // 2000 + 3 km × 800 + 3 kg × 500 + 1000 + 1000
    expect(p.totalFeePaise).toBe(2000 + 2400 + 1500 + 1000 + 1000);
  });
  it("caps at the maximum and applies the promotion", () => {
    const p = priceDelivery({ ...base, maxFeePaise: 4000, promoDiscountPaise: 500 }, { distanceM: 10_000, weightGrams: 0, basketPaise: 0, express: false, at: offPeak });
    expect(p.totalFeePaise).toBe(3500);
  });
  it("shop pays", () => {
    const p = priceDelivery({ ...base, commercialModel: "SHOP_PAYS" }, { distanceM: 1000, weightGrams: 0, basketPaise: 0, express: false, at: offPeak });
    expect([p.customerPaise, p.shopPaise, p.gokesariPaise]).toEqual([0, 2000, 0]);
  });
  it("shared 30% shop", () => {
    const p = priceDelivery({ ...base, commercialModel: "SHARED", shopSharePercent: 30 }, { distanceM: 1000, weightGrams: 0, basketPaise: 0, express: false, at: offPeak });
    expect([p.customerPaise, p.shopPaise]).toEqual([1400, 600]);
  });
  it("GoKesari sponsored, fully and capped", () => {
    const full = priceDelivery({ ...base, commercialModel: "GOKESARI_SPONSORED" }, { distanceM: 1000, weightGrams: 0, basketPaise: 0, express: false, at: offPeak });
    expect([full.customerPaise, full.gokesariPaise]).toEqual([0, 2000]);
    const capped = priceDelivery({ ...base, commercialModel: "GOKESARI_SPONSORED", gokesariSubsidyPaise: 1500 }, { distanceM: 1000, weightGrams: 0, basketPaise: 0, express: false, at: offPeak });
    expect([capped.customerPaise, capped.gokesariPaise]).toEqual([500, 1500]);
  });
  it("free above basket value", () => {
    const rule = { ...base, commercialModel: "FREE_ABOVE_BASKET" as const, freeAbovePaise: 49900 };
    expect(priceDelivery(rule, { distanceM: 1000, weightGrams: 0, basketPaise: 50000, express: false, at: offPeak }).customerPaise).toBe(0);
    expect(priceDelivery(rule, { distanceM: 1000, weightGrams: 0, basketPaise: 40000, express: false, at: offPeak }).customerPaise).toBe(2000);
  });
  it("peak windows in IST, including across midnight", () => {
    expect(istClock(peak)).toBe("19:00");
    expect(isPeak(peak, [{ from: "18:00", to: "21:00" }])).toBe(true);
    expect(isPeak(offPeak, [{ from: "18:00", to: "21:00" }])).toBe(false);
    expect(isPeak(new Date("2026-11-23T18:00:00Z"), [{ from: "22:00", to: "02:00" }])).toBe(true); // 23:30 IST
  });
});

describe("allocation scoring", () => {
  const c = (code: string, fee: number, eta: number, rel: number): Candidate => ({ channel: "EXTERNAL", providerCode: code, serviceable: true, feePaise: fee, etaMinutes: eta, reliabilityX100: rel, reason: null, score: null });
  it("does not choose on price alone", () => {
    const ranked = rankCandidates([c("CHEAP_SLOW", 3000, 60, 7000), c("FAST", 3300, 20, 9500)], { fee: 40, eta: 40, reliability: 20 });
    expect(ranked[0].providerCode).toBe("FAST");
  });
  it("price wins when weighted only on price", () => {
    const ranked = rankCandidates([c("CHEAP_SLOW", 3000, 60, 7000), c("FAST", 3300, 20, 9500)], { fee: 1, eta: 0, reliability: 0 });
    expect(ranked[0].providerCode).toBe("CHEAP_SLOW");
  });
  it("drops unserviceable candidates", () => {
    expect(rankCandidates([{ ...c("X", 1, 1, 1), serviceable: false }], { fee: 1, eta: 1, reliability: 1 })).toEqual([]);
  });
  it("partner filters: refrigeration, weight, distance, reliability, max minutes", () => {
    const req = { weightGrams: 3000, refrigeration: false, fragile: false, perishable: false, maxDeliveryMinutes: null, itemCount: 1 };
    const p = { capabilities: { maxWeightKg: 10, maxDistanceKm: 10, refrigerated: false }, reliabilityX100: 9000 };
    expect(partnerRejection(p, { serviceable: true, etaMinutes: 30 }, req, 4000, 60)).toBeNull();
    expect(partnerRejection(p, { serviceable: true }, { ...req, refrigeration: true }, 4000, 60)).toMatch(/refrigerated/);
    expect(partnerRejection(p, { serviceable: true }, { ...req, weightGrams: 12_000 }, 4000, 60)).toMatch(/Heavier/);
    expect(partnerRejection(p, { serviceable: true }, req, 12_000, 60)).toMatch(/Farther/);
    expect(partnerRejection({ ...p, reliabilityX100: 5000 }, { serviceable: true }, req, 4000, 60)).toMatch(/Reliability/);
    expect(partnerRejection(p, { serviceable: true, etaMinutes: 50 }, { ...req, maxDeliveryMinutes: 40 }, 4000, 60)).toMatch(/ETA/);
  });
  it("ETA bands (Pune targets)", () => {
    const bands = [
      { upToKm: 2, minMinutes: 20, maxMinutes: 35 },
      { upToKm: 4, minMinutes: 30, maxMinutes: 45 },
      { upToKm: 6, minMinutes: 40, maxMinutes: 60 },
    ];
    expect(etaBandMinutes(1500, bands)).toEqual({ min: 20, max: 35 });
    expect(etaBandMinutes(3500, bands)).toEqual({ min: 30, max: 45 });
    expect(etaBandMinutes(5900, bands)).toEqual({ min: 40, max: 60 });
    expect(etaBandMinutes(8000, bands)).toBeNull();
  });
});

describe("zones and geometry", () => {
  const baner = { centerLat: "18.559", centerLng: "73.7868", radiusM: 3000, polygon: null };
  it("circle and polygon containment", () => {
    expect(zoneContains(baner, { lat: 18.566, lng: 73.792 })).toBe(true);
    expect(zoneContains(baner, { lat: 18.5167, lng: 73.8415 })).toBe(false); // Deccan
    const square: [number, number][] = [[18.5, 73.8], [18.5, 73.9], [18.6, 73.9], [18.6, 73.8]];
    expect(pointInPolygon({ lat: 18.55, lng: 73.85 }, square)).toBe(true);
    expect(pointInPolygon({ lat: 18.65, lng: 73.85 }, square)).toBe(false);
  });
  it("picks the nearest containing zone and respects suspension", () => {
    const z = (code: string, lat: number, lng: number) => ({ id: code, code, name: code, city: "Pune", centerLat: String(lat), centerLng: String(lng), radiusM: 3000, polygon: null, maxDeliveryKm: "6", status: "ACTIVE" as const, suspendedReason: null, suspendedUntil: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date() });
    const zones = [z("BANER", 18.559, 73.7868), z("BALEWADI", 18.577, 73.779)];
    expect(pickZone(zones, { lat: 18.575, lng: 73.78 })?.code).toBe("BALEWADI");
    expect(zoneIsOpen({ status: "SUSPENDED", suspendedUntil: new Date(Date.now() - 1000) })).toBe(true);
    expect(zoneIsOpen({ status: "SUSPENDED", suspendedUntil: null })).toBe(false);
  });
  it("haversine and point parsing", () => {
    expect(haversineMeters({ lat: 18.559, lng: 73.7868 }, { lat: 18.5167, lng: 73.8415 })).toBeGreaterThan(7000);
    expect(parsePoint("0", "0")).toBeNull();
    expect(parsePoint(null, "73")).toBeNull();
    expect(parsePoint("18.5", "73.8")).toEqual({ lat: 18.5, lng: 73.8 });
  });
});

describe("booking machine and privacy", () => {
  it("allowed and refused moves", () => {
    expect(canMoveBooking("ASSIGNED", "PICKED_UP")).toBe(true);
    expect(canMoveBooking("PICKED_UP", "ASSIGNED")).toBe(false);
    expect(canMoveBooking("DELIVERED", "FAILED")).toBe(false);
    expect(canMoveBooking("PICKED_UP", "CANCELLED")).toBe(false);
  });
  it("masks rider phones and redacts personal fields in webhook logs", () => {
    expect(maskPhone("+919812345678")).toBe("+91 98XXXXXX78");
    expect(maskPhone("12")).toBeNull();
    expect(redactPayload({ events: [{ id: "1", riderPhone: "+91981", customerName: "A", status: "X" }] })).toEqual({
      events: [{ id: "1", riderPhone: "[redacted]", customerName: "[redacted]", status: "X" }],
    });
  });
});
