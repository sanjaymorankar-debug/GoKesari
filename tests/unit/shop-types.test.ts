import { describe, expect, it } from "vitest";

import {
  FOOD_SHOP_TYPE_KEYS,
  humanizeShopTypeKey,
  isFoodBusinessShopType,
  registerCustomShopTypes,
  SHOP_TYPE_KEY_PATTERN,
  SHOP_TYPES,
  shopTypeLabel,
} from "@/lib/shop-types";

describe("shop types", () => {
  it("includes the types the owner asked for (27 Oct 2026)", () => {
    const keys = SHOP_TYPES.map((t) => t.key as string);
    for (const k of ["FIRECRACKER_SHOP", "TENT_HOUSE", "EVENT_MANAGEMENT", "CONSULTANT", "DOCTOR_CLINIC", "SUPER_SPECIALITY_CLINIC", "HARDWARE_STORE"]) {
      expect(keys, k).toContain(k);
    }
  });

  it("has unique keys and labels, and every key matches the key pattern", () => {
    const keys = SHOP_TYPES.map((t) => t.key as string);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(SHOP_TYPES.map((t) => t.label.toLowerCase())).size).toBe(keys.length);
    for (const k of keys) expect(SHOP_TYPE_KEY_PATTERN.test(k), k).toBe(true);
  });

  it("none of the new types is a food business", () => {
    for (const k of ["FIRECRACKER_SHOP", "TENT_HOUSE", "EVENT_MANAGEMENT", "CONSULTANT", "DOCTOR_CLINIC", "SUPER_SPECIALITY_CLINIC"]) {
      expect(isFoodBusinessShopType(k), k).toBe(false);
    }
    expect(FOOD_SHOP_TYPE_KEYS.length).toBeGreaterThan(0);
  });

  it("labels and food flag of a staff-added type come from the registry, and fall back to the key", () => {
    expect(shopTypeLabel("CLOUD_KITCHEN")).toBe("Cloud Kitchen");
    expect(humanizeShopTypeKey("TENT_HOUSE")).toBe("Tent House");
    registerCustomShopTypes([{ key: "CLOUD_KITCHEN", label: "Cloud kitchen (delivery only)", standardGoods: [], isFood: true }]);
    expect(shopTypeLabel("CLOUD_KITCHEN")).toBe("Cloud kitchen (delivery only)");
    expect(isFoodBusinessShopType("CLOUD_KITCHEN")).toBe(true);
    registerCustomShopTypes([]);
    expect(isFoodBusinessShopType("CLOUD_KITCHEN")).toBe(false);
    expect(shopTypeLabel("DAIRY")).toBe("Dairy Shop");
  });
});
