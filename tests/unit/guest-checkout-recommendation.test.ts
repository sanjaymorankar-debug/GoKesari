/** docs/guest-checkout-2026-11: "Best shop for this cart" — items, ranking and the suggestion. */
import { describe, expect, it } from "vitest";

import { lineToWishItem, pickRecommendation, rankShopsForCart, type RecommendationLine } from "@/server/guest-checkout/recommendation";
import type { ShopQuote, ShopItemQuote } from "@/server/services/smart-list/compare";

function item(itemId: string, over: Partial<ShopItemQuote> = {}): ShopItemQuote {
  return {
    itemId,
    status: "AVAILABLE",
    shopProductId: `${itemId}-sp`,
    productId: `${itemId}-p`,
    productName: itemId,
    cartQuantity: 1,
    packNote: null,
    unitPricePaise: 1000,
    linePaise: 1000,
    stockLeft: null,
    ...over,
  };
}

function quote(shopId: string, over: Partial<ShopQuote> & { fee?: number | null } = {}): ShopQuote {
  const { fee = 0, ...rest } = over;
  const items = rest.items ?? [item("l1"), item("l2")];
  const itemsPaise = items.reduce((n, i) => n + (i.linePaise ?? 0), 0);
  return {
    shopId,
    shopName: shopId,
    shopSlug: shopId,
    area: null,
    distanceKm: 1,
    rating: null,
    ratingCount: 0,
    available: items.length,
    total: items.length,
    missing: [],
    itemsPaise,
    priceOnConfirmation: 0,
    deliveryOptions: [{ key: "PICKUP", feePaise: 0, etaMinutes: 20 }, ...(fee === null ? [] : [{ key: "SHOP_DELIVERY" as const, feePaise: fee, etaMinutes: 30 }])],
    cheapestTotalPaise: itemsPaise,
    items,
    ...rest,
  };
}

const lines: RecommendationLine[] = [
  { lineId: "l1", shopProductId: "old-1", shopId: "current", quantity: 1, lineTotalPaise: 1500, purchasable: true },
  { lineId: "l2", shopProductId: "old-2", shopId: "current", quantity: 1, lineTotalPaise: 1500, purchasable: true },
];

describe("lineToWishItem", () => {
  it("turns packs into the same amount in base units", () => {
    const w = lineToWishItem(
      { lineId: "x", shopProductId: "sp", shopId: "s", quantity: 2, lineTotalPaise: 0, purchasable: true },
      { productId: "p", name: "Atta", kind: "PACKAGED", unit: "kg", unitSizeMilli: 5000 },
    );
    expect(w).toMatchObject({ id: "x", productId: "p", quantityAmount: 10_000, quantityUnit: "g" });
  });
});

describe("rankShopsForCart", () => {
  it("keeps only shops that deliver here, then ranks availability → price → distance", () => {
    const ranked = rankShopsForCart([
      quote("pickup-only", { fee: null }),
      quote("partial", { items: [item("l1", { linePaise: 100 }), item("l2", { status: "MISSING", linePaise: null })], fee: 0 }),
      quote("far-cheap", { fee: 0, distanceKm: 3 }),
      quote("near-cheap", { fee: 0, distanceKm: 1 }),
      quote("dear", { fee: 500 }),
    ]);
    expect(ranked.map((r) => r.shopId)).toEqual(["near-cheap", "far-cheap", "dear", "partial"]);
    expect(ranked[0]).toMatchObject({ complete: true, totalPaise: 2000 });
    expect(ranked.at(-1)?.complete).toBe(false);
  });

  it("does not count price-on-confirmation items as available", () => {
    const [r] = rankShopsForCart([quote("s", { items: [item("l1"), item("l2", { status: "PRICE_ON_CONFIRMATION", linePaise: null })] })]);
    expect(r).toMatchObject({ available: 1, complete: false });
  });
});

describe("pickRecommendation", () => {
  it("suggests a complete, cheaper shop with the moves", () => {
    const quotes = [quote("better", { fee: 0 })];
    const rec = pickRecommendation(lines, 3000, rankShopsForCart(quotes), quotes);
    expect(rec).toMatchObject({ savingsPaise: 1000, completesCart: false });
    expect(rec?.moves.map((m) => [m.lineId, m.toShopProductId])).toEqual([
      ["l1", "l1-sp"],
      ["l2", "l2-sp"],
    ]);
  });

  it("says nothing when no shop is cheaper and the cart is complete, or the best shop is the cart's own", () => {
    const dear = [quote("dear", { fee: 2000 })];
    expect(pickRecommendation(lines, 3000, rankShopsForCart(dear), dear)).toBeNull();
    const same = [quote("current", { fee: 0 })];
    expect(pickRecommendation(lines, 3000, rankShopsForCart(same), same)).toBeNull();
  });

  it("suggests a complete shop even at the same price when the cart has items it cannot buy", () => {
    const broken = [lines[0], { ...lines[1], purchasable: false, lineTotalPaise: 0 }];
    const q = [quote("complete", { fee: 1000 })];
    const rec = pickRecommendation(broken, 1500, rankShopsForCart(q), q);
    expect(rec).toMatchObject({ completesCart: true, savingsPaise: 0 });
  });

  it("never suggests an incomplete shop", () => {
    const q = [quote("partial", { items: [item("l1", { linePaise: 1 }), item("l2", { status: "MISSING", linePaise: null })] })];
    expect(pickRecommendation(lines, 3000, rankShopsForCart(q), q)).toBeNull();
  });
});
