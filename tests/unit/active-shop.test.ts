import { describe, expect, it } from "vitest";

import { ACTIVE_SHOP_COOKIE, pickActiveShop } from "@/lib/seller/active-shop";

// listShopsForOwner returns the newest shop first.
const shops = [
  { id: "newest", name: "E2E Referral shop (pending)" },
  { id: "bakery", name: "E2E Four Features Bakery" },
  { id: "stationery", name: "E2E Four Features Stationery" },
];

describe("pickActiveShop — which of an owner's shops Seller Central shows", () => {
  it("shows the newest shop when nothing is chosen (the old behaviour)", () => {
    expect(pickActiveShop(shops).id).toBe("newest");
    expect(pickActiveShop(shops, null, null).id).toBe("newest");
  });

  it("shows the shop chosen in the switcher", () => {
    expect(pickActiveShop(shops, undefined, "bakery").id).toBe("bakery");
  });

  it("a ?shop= link wins over the remembered choice", () => {
    expect(pickActiveShop(shops, "stationery", "bakery").id).toBe("stationery");
  });

  it("ignores ids that are not one of the owner's shops", () => {
    expect(pickActiveShop(shops, "someone-elses-shop", "also-not-mine").id).toBe("newest");
    expect(pickActiveShop(shops, "someone-elses-shop", "bakery").id).toBe("bakery");
  });

  it("an owner with one shop always gets it", () => {
    expect(pickActiveShop([shops[1]], undefined, "newest").id).toBe("bakery");
  });

  it("no shops: nothing to show (the pages redirect before using it)", () => {
    expect(pickActiveShop([] as { id: string }[], "bakery", "bakery")).toBeUndefined();
  });

  it("uses its own cookie name", () => {
    expect(ACTIVE_SHOP_COOKIE).toBe("gk_shop");
  });
});
