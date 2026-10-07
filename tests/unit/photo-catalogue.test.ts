import { describe, expect, it } from "vitest";

import { buildPricePatch, needsPhoto, needsPrice, tagPrice } from "@/lib/photo-catalogue";

const tile = (over: Partial<Parameters<typeof needsPhoto>[0]> = {}) => ({
  liveImageUrl: null,
  pendingCount: 0,
  onlinePricePaise: null,
  offlinePricePaise: null,
  ...over,
});

describe("photo catalogue filters", () => {
  it("needs a photo only when customers see none and none is waiting for review", () => {
    expect(needsPhoto(tile())).toBe(true);
    expect(needsPhoto(tile({ liveImageUrl: "/api/images/1" }))).toBe(false);
    expect(needsPhoto(tile({ pendingCount: 1 }))).toBe(false);
  });

  it("needs a price only when neither channel has one", () => {
    expect(needsPrice(tile())).toBe(true);
    expect(needsPrice(tile({ onlinePricePaise: 7000 }))).toBe(false);
    expect(needsPrice(tile({ offlinePricePaise: 6500 }))).toBe(false);
  });

  it("tags the online price first, else the in-shop one", () => {
    expect(tagPrice(tile({ onlinePricePaise: 7000, offlinePricePaise: 6500 }))).toEqual({ pricePaise: 7000, channel: "online" });
    expect(tagPrice(tile({ offlinePricePaise: 6500 }))).toEqual({ pricePaise: 6500, channel: "in shop" });
    expect(tagPrice(tile())).toBeNull();
  });
});

describe("buildPricePatch", () => {
  const priced = { onlinePricePaise: 7000, offlinePricePaise: 6500 };

  it("sends only the prices that changed", () => {
    expect(buildPricePatch(priced, { online: "70", offline: "65" })).toEqual({ patch: {} });
    expect(buildPricePatch(priced, { online: "72.5", offline: "65" })).toEqual({ patch: { onlinePricePaise: 7250 } });
    expect(buildPricePatch(priced, { online: " 70 ", offline: "60" })).toEqual({ patch: { offlinePricePaise: 6000 } });
  });

  it("puts a channel on sale when it gets its first price", () => {
    expect(buildPricePatch({ onlinePricePaise: null, offlinePricePaise: null }, { online: "45", offline: "" })).toEqual({
      patch: { onlinePricePaise: 4500, onlineSaleEnabled: true },
    });
    expect(buildPricePatch({ onlinePricePaise: 7000, offlinePricePaise: null }, { online: "70", offline: "68" })).toEqual({
      patch: { offlinePricePaise: 6800, offlineSaleEnabled: true },
    });
  });

  it("leaves an unpriced channel alone when its box is empty", () => {
    expect(buildPricePatch({ onlinePricePaise: 7000, offlinePricePaise: null }, { online: "75", offline: "  " })).toEqual({
      patch: { onlinePricePaise: 7500 },
    });
  });

  it("never removes a price from an empty box", () => {
    const result = buildPricePatch(priced, { online: "", offline: "65" });
    expect(result).toEqual({ error: "Enter the online price. To stop selling online, use Edit on My Shop." });
    expect(buildPricePatch(priced, { online: "70", offline: "" })).toEqual({
      error: "Enter the in-shop price. To stop selling in the shop, use Edit on My Shop.",
    });
  });

  it("refuses zero, negative and non-numeric prices", () => {
    for (const bad of ["0", "-5", "abc", "Infinity"]) {
      expect(buildPricePatch(priced, { online: bad, offline: "65" })).toEqual({
        error: "The online price must be a number greater than 0.",
      });
    }
  });
});
