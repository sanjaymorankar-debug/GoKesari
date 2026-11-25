/** docs/guest-checkout-2026-11: the combined timeline across a purchase's shop orders. */
import { describe, expect, it } from "vitest";

import { buildGroupTimeline, stageOf } from "@/server/guest-checkout/timeline";

const t = (min: number) => new Date(Date.UTC(2026, 10, 23, 10, min));

describe("buildGroupTimeline", () => {
  it("puts the purchase at its slowest live shop order and counts each step", () => {
    const tl = buildGroupTimeline(
      [
        { id: "a", shopName: "Dairy One", status: "OUT_FOR_DELIVERY", statusLabel: "Out for delivery" },
        { id: "b", shopName: "Kirana Two", status: "PREPARING", statusLabel: "Being packed" },
      ],
      [],
    );
    expect(tl.overall.stage).toBe("PACKING");
    expect(tl.stages.find((s) => s.stage === "ON_THE_WAY")).toMatchObject({ reached: 1, of: 2 });
    expect(tl.stages.find((s) => s.stage === "PLACED")).toMatchObject({ reached: 2, of: 2 });
    expect(tl.shops.map((s) => s.stage)).toEqual(["ON_THE_WAY", "PACKING"]);
  });

  it("says partly delivered while one shop has delivered and another has not", () => {
    const tl = buildGroupTimeline(
      [
        { id: "a", shopName: "A", status: "DELIVERED", statusLabel: "Delivered" },
        { id: "b", shopName: "B", status: "ACCEPTED", statusLabel: "Accepted" },
      ],
      [],
    );
    expect(tl.overall.label).toBe("Partly delivered — 1 of 2 shops");
    expect(tl.overall.delivered).toBe(1);
  });

  it("leaves cancelled shop orders out of the progress, and calls an all-cancelled purchase cancelled", () => {
    const some = buildGroupTimeline(
      [
        { id: "a", shopName: "A", status: "DELIVERED", statusLabel: "Delivered" },
        { id: "b", shopName: "B", status: "CANCELLED", statusLabel: "Cancelled" },
      ],
      [],
    );
    expect(some.overall).toMatchObject({ stage: "DELIVERED", stopped: 1, label: "Delivered (some items cancelled)" });
    const all = buildGroupTimeline([{ id: "a", shopName: "A", status: "REFUNDED", statusLabel: "Refunded" }], []);
    expect(all.overall).toMatchObject({ stage: "STOPPED", label: "Cancelled" });
  });

  it("merges every shop's status changes in time order and drops events of other orders", () => {
    const tl = buildGroupTimeline(
      [
        { id: "a", shopName: "A", status: "CONFIRMED", statusLabel: "Confirmed" },
        { id: "b", shopName: "B", status: "CONFIRMED", statusLabel: "Confirmed" },
      ],
      [
        { orderId: "b", status: "CONFIRMED", at: t(5) },
        { orderId: "a", status: "PENDING", at: t(1) },
        { orderId: "zzz", status: "DELIVERED", at: t(2) },
        { orderId: "a", status: "CONFIRMED", at: t(3) },
      ],
      (s) => `L:${s}`,
    );
    expect(tl.events.map((e) => `${e.shopName}:${e.statusLabel}`)).toEqual(["A:L:PENDING", "A:L:CONFIRMED", "B:L:CONFIRMED"]);
  });

  it("maps statuses to steps", () => {
    expect(stageOf("WALLET_INSUFFICIENT")).toBe("PLACED");
    expect(stageOf("READY")).toBe("PACKING");
    expect(stageOf("PICKED_UP")).toBe("ON_THE_WAY");
    expect(stageOf("CANCELLED")).toBeNull();
  });
});
