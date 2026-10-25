/** D-95: the stock and cart quantity rules shared by the forms, the product card and the server. */
import { describe, expect, it } from "vitest";

import {
  cartQuantityProblem,
  cartQuantityStep,
  formatStock,
  milliToStockUnits,
  quantityToMilli,
  roundStock,
  stockQuantityProblem,
} from "@/lib/stock-quantity";

const looseKg = { kind: "LOOSE" as const, unit: "kg", unitSizeMilli: 1000 };
const packaged = { kind: "PACKAGED" as const, unit: "pack", unitSizeMilli: 1000 };

describe("stock figures", () => {
  it("a loose good keeps up to three decimals; a packaged one is whole", () => {
    expect(stockQuantityProblem(2.5, "LOOSE")).toBeNull();
    expect(stockQuantityProblem(0.125, "LOOSE")).toBeNull();
    expect(stockQuantityProblem(2.0005, "LOOSE")).toMatch(/at most 3 decimals/);
    expect(stockQuantityProblem(2.5, "PACKAGED")).toMatch(/whole number for a packaged product/);
    expect(stockQuantityProblem(37, "PACKAGED")).toBeNull();
    expect(stockQuantityProblem(-1, "LOOSE")).toMatch(/from 0 to/);
    expect(stockQuantityProblem(1_000_001, "PACKAGED")).toMatch(/from 0 to/);
  });

  it("rounds and prints as the database keeps them", () => {
    expect(roundStock(0.1 + 0.2)).toBe(0.3);
    expect(formatStock(2.5)).toBe("2.5");
    expect(formatStock(100)).toBe("100");
  });
});

describe("cart quantities", () => {
  it("a loose 1 kg listing sells 250 g as 0.25; a packaged one only whole units from 1 to 99", () => {
    expect(cartQuantityProblem(0.25, looseKg)).toBeNull();
    expect(cartQuantityProblem(1.5, looseKg)).toBeNull();
    expect(cartQuantityProblem(0, looseKg)).not.toBeNull();
    expect(cartQuantityProblem(0.0001, looseKg)).not.toBeNull();
    expect(cartQuantityProblem(99.5, looseKg)).not.toBeNull();
    expect(cartQuantityProblem(0.25, packaged)).toBe("Quantity must be a whole number from 1 to 99.");
    expect(cartQuantityProblem(0, packaged, { allowZero: true })).toBeNull();
    expect(cartQuantityProblem(3, packaged)).toBeNull();
  });

  it("refuses a part of a unit that is not a whole milli of the product's unit", () => {
    // 0.001 of a 250 g step is 0.25 g in milli-g = 250 — fine; 0.001 of 0.5 milli is not.
    expect(cartQuantityProblem(0.001, { kind: "LOOSE", unitSizeMilli: 250 })).not.toBeNull();
    expect(cartQuantityProblem(0.004, { kind: "LOOSE", unitSizeMilli: 250 })).toBeNull();
  });

  it("steps 250 g / 250 ml where the listing's unit allows, else one unit", () => {
    expect(cartQuantityStep(looseKg)).toBe(0.25);
    expect(cartQuantityStep({ kind: "LOOSE", unit: "kg", unitSizeMilli: 500 })).toBe(0.5);
    expect(cartQuantityStep({ kind: "LOOSE", unit: "kg", unitSizeMilli: 250 })).toBe(1);
    expect(cartQuantityStep({ kind: "LOOSE", unit: "L", unitSizeMilli: 2000 })).toBe(0.125);
    expect(cartQuantityStep({ kind: "LOOSE", unit: "g", unitSizeMilli: 500_000 })).toBe(0.5);
    expect(cartQuantityStep({ kind: "LOOSE", unit: "piece", unitSizeMilli: 1000 })).toBe(1);
    expect(cartQuantityStep(packaged)).toBe(1);
  });

  it("converts between a cart quantity, an order line's milli and stock units", () => {
    expect(quantityToMilli(0.25, 1000)).toBe(250);
    expect(quantityToMilli(3, 500)).toBe(1500);
    expect(milliToStockUnits(250, 1000, "LOOSE")).toBe(0.25);
    expect(milliToStockUnits(1500, 1000, "PACKAGED")).toBe(2); // rounds, as cancellations always did
    expect(milliToStockUnits(1500, 1000, "PACKAGED", "floor")).toBe(1);
    expect(milliToStockUnits(500, 1000, "PACKAGED", "ceil")).toBe(1);
    expect(milliToStockUnits(500, 1000, "LOOSE", "ceil")).toBe(0.5);
  });
});
