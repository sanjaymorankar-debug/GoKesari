/** docs/guest-cart-2026-11: the browser cart's rules (limits, TTL, add / set). */
import { describe, expect, it } from "vitest";

import {
  addGuestCartLine,
  emptyGuestCart,
  GUEST_CART_MAX_LINES,
  GUEST_CART_TTL_MS,
  guestCartItemCount,
  parseGuestCart,
  setGuestCartLine,
} from "@/lib/guest-cart";
import { MAX_CART_LINE_QUANTITY } from "@/lib/stock-quantity";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = 1_800_000_000_000;

describe("parseGuestCart", () => {
  it("returns an empty cart for nothing stored, bad JSON or a wrong shape", () => {
    for (const raw of [null, "", "{", "[]", '{"lines":"x","updatedAt":1}', '{"lines":[]}']) {
      expect(parseGuestCart(raw, NOW).lines).toEqual([]);
    }
  });

  it("forgets a cart untouched for more than 7 days", () => {
    const raw = JSON.stringify({ lines: [{ shopProductId: id(1), quantity: 2 }], updatedAt: NOW - GUEST_CART_TTL_MS - 1 });
    expect(parseGuestCart(raw, NOW).lines).toEqual([]);
    const fresh = JSON.stringify({ lines: [{ shopProductId: id(1), quantity: 2 }], updatedAt: NOW - GUEST_CART_TTL_MS + 1000 });
    expect(parseGuestCart(fresh, NOW).lines).toEqual([{ shopProductId: id(1), quantity: 2 }]);
  });

  it("drops malformed and repeated lines, caps quantity and keeps at most 50 lines", () => {
    const lines = [
      { shopProductId: "not-a-uuid", quantity: 1 },
      { shopProductId: id(1), quantity: -1 },
      { shopProductId: id(2), quantity: 500 },
      { shopProductId: id(2), quantity: 1 },
      ...Array.from({ length: 60 }, (_, i) => ({ shopProductId: id(100 + i), quantity: 1 })),
    ];
    const cart = parseGuestCart(JSON.stringify({ lines, updatedAt: NOW }), NOW);
    expect(cart.lines).toHaveLength(GUEST_CART_MAX_LINES);
    expect(cart.lines[0]).toEqual({ shopProductId: id(2), quantity: MAX_CART_LINE_QUANTITY });
    expect(cart.lines.filter((l) => l.shopProductId === id(2))).toHaveLength(1);
  });
});

describe("addGuestCartLine / setGuestCartLine", () => {
  it("adds a new line, then adds to it up to the per-line maximum", () => {
    let change = addGuestCartLine(emptyGuestCart(NOW), id(1), 2, NOW);
    expect(change.ok && change.cart.lines).toEqual([{ shopProductId: id(1), quantity: 2 }]);
    change = addGuestCartLine(change.ok ? change.cart : emptyGuestCart(NOW), id(1), 98, NOW + 5);
    expect(change.ok && change.cart.lines).toEqual([{ shopProductId: id(1), quantity: MAX_CART_LINE_QUANTITY }]);
    expect(change.ok && change.cart.updatedAt).toBe(NOW + 5);
  });

  it("refuses a 51st different item but still adds to one already in the cart", () => {
    const full = { lines: Array.from({ length: GUEST_CART_MAX_LINES }, (_, i) => ({ shopProductId: id(i), quantity: 1 })), updatedAt: NOW };
    expect(addGuestCartLine(full, id(999), 1, NOW)).toEqual({ ok: false, reason: "FULL" });
    const more = addGuestCartLine(full, id(3), 1, NOW);
    expect(more.ok && more.cart.lines[3].quantity).toBe(2);
  });

  it("refuses a bad quantity or id", () => {
    expect(addGuestCartLine(emptyGuestCart(NOW), id(1), 0, NOW).ok).toBe(false);
    expect(addGuestCartLine(emptyGuestCart(NOW), id(1), Number.NaN, NOW).ok).toBe(false);
    expect(addGuestCartLine(emptyGuestCart(NOW), "x", 1, NOW).ok).toBe(false);
  });

  it("sets a quantity, and 0 removes the line", () => {
    const cart = { lines: [{ shopProductId: id(1), quantity: 1 }, { shopProductId: id(2), quantity: 0.25 }], updatedAt: NOW };
    expect(setGuestCartLine(cart, id(1), 4, NOW).lines[0].quantity).toBe(4);
    expect(setGuestCartLine(cart, id(1), 0, NOW).lines).toEqual([{ shopProductId: id(2), quantity: 0.25 }]);
    expect(setGuestCartLine(cart, id(1), -2, NOW)).toBe(cart);
  });

  it("counts items for the badge: whole quantities, a part-unit line once", () => {
    expect(guestCartItemCount({ lines: [{ shopProductId: id(1), quantity: 3 }, { shopProductId: id(2), quantity: 0.25 }], updatedAt: NOW })).toBe(4);
  });
});
