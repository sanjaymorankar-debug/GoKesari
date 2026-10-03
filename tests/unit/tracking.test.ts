/**
 * Order tracking (GS-042 / NAV-004).
 *
 * `isTrackableOrderStatus` decides whether a page mounts the tracking panel at
 * all, so it is the thing standing between "one poll for the order in flight"
 * and "one poll per row on the screen". It is pure, so it is tested here rather
 * than through the API.
 *
 * The stage cases below pin the behaviour the panel's copy depends on: an order
 * only reaches IN_PROGRESS once the rider has actually picked it up, and a
 * location fix recorded before that pickup is never shown.
 */
import { describe, expect, it } from "vitest";

import { buildOrderTracking, isTrackableOrderStatus } from "@/lib/tracking";
import type { OrderStatus } from "@/server/db/schema";

const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const NEARBY = { latitude: 18.5304, longitude: 73.8567 }; // ~1.1 km north

describe("isTrackableOrderStatus", () => {
  it("is true while the order is on its way to the customer", () => {
    const trackable: OrderStatus[] = [
      "PENDING",
      "CONFIRMED",
      "ACCEPTED",
      "PREPARING",
      "READY",
      "ASSIGNED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
    ];
    for (const status of trackable) {
      expect(isTrackableOrderStatus(status), status).toBe(true);
    }
  });

  it("is false once the order has finished or stalled", () => {
    const untrackable: OrderStatus[] = [
      "DELIVERED",
      "CANCELLED",
      "RETURNED",
      "DISPUTED",
      "REFUND_PENDING",
      "REFUNDED",
      "FAILED",
      "PAYMENT_FAILED",
      "WALLET_INSUFFICIENT",
    ];
    for (const status of untrackable) {
      expect(isTrackableOrderStatus(status), status).toBe(false);
    }
  });

  it("treats an unrecognised status as not trackable rather than throwing", () => {
    // UI rows carry the status as a plain string; a value from an older
    // deployment must not crash the page.
    expect(isTrackableOrderStatus("SOMETHING_ELSE")).toBe(false);
  });
});

describe("buildOrderTracking", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const pickedUpAt = new Date("2026-10-02T11:50:00Z");

  it("reports distance and an ETA once the rider is carrying the order", () => {
    const tracking = buildOrderTracking({
      orderId: "o1",
      orderStatus: "OUT_FOR_DELIVERY",
      shopDispatchesRiders: true,
      delivery: { status: "PICKED_UP", pickedUpAt },
      riderFix: { ...NEARBY, recordedAt: new Date("2026-10-02T11:58:00Z") },
      destination: PUNE,
      now,
    });

    expect(tracking.stage).toBe("IN_PROGRESS");
    expect(tracking.riderLocation).not.toBeNull();
    expect(tracking.distanceToDestinationKm).toBeGreaterThan(0);
    expect(tracking.etaMinutes).toBeGreaterThan(0);
  });

  it("withholds a fix recorded before pickup", () => {
    const tracking = buildOrderTracking({
      orderId: "o2",
      orderStatus: "OUT_FOR_DELIVERY",
      shopDispatchesRiders: true,
      delivery: { status: "PICKED_UP", pickedUpAt },
      riderFix: { ...NEARBY, recordedAt: new Date("2026-10-02T11:40:00Z") },
      destination: PUNE,
      now,
    });

    expect(tracking.stage).toBe("IN_PROGRESS");
    expect(tracking.riderLocation).toBeNull();
    expect(tracking.etaMinutes).toBeNull();
  });

  it("withholds a stale fix", () => {
    const tracking = buildOrderTracking({
      orderId: "o3",
      orderStatus: "OUT_FOR_DELIVERY",
      shopDispatchesRiders: true,
      delivery: { status: "PICKED_UP", pickedUpAt },
      riderFix: { ...NEARBY, recordedAt: new Date("2026-10-02T11:51:00Z") }, // 9 min old
      destination: PUNE,
      now,
    });

    expect(tracking.riderLocation).not.toBeNull();
    expect(tracking.distanceToDestinationKm).toBeNull();
    expect(tracking.etaMinutes).toBeNull();
  });

  it("is awaiting pickup while a rider holds the job but has not collected it", () => {
    const tracking = buildOrderTracking({
      orderId: "o4",
      orderStatus: "ASSIGNED",
      shopDispatchesRiders: true,
      delivery: { status: "ACCEPTED", pickedUpAt: null },
      riderFix: { ...NEARBY, recordedAt: new Date("2026-10-02T11:59:00Z") },
      destination: PUNE,
      now,
    });

    expect(tracking.stage).toBe("AWAITING_PICKUP");
    expect(tracking.riderLocation).toBeNull();
  });

  it("ends tracking on a delivered order", () => {
    const tracking = buildOrderTracking({
      orderId: "o5",
      orderStatus: "DELIVERED",
      shopDispatchesRiders: true,
      delivery: { status: "DELIVERED", pickedUpAt },
      riderFix: { ...NEARBY, recordedAt: new Date("2026-10-02T11:59:00Z") },
      destination: PUNE,
      now,
    });

    expect(tracking.stage).toBe("ENDED");
    expect(tracking.riderLocation).toBeNull();
  });
});
