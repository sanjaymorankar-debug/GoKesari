import { describe, expect, it } from "vitest";

import { categoriseProduct, matchKeywords } from "@/server/services/product-categorisation";

const cat = (name: string, extra: Parameters<typeof categoriseProduct>[0] extends infer P ? Partial<P> : never = {}) =>
  categoriseProduct({ name, ...extra }).category;

describe("one-time product categorisation rules", () => {
  it.each([
    ["Cow Milk", "Dairy"],
    ["Fresh Paneer", "Dairy"],
    ["Cow Ghee", "Dairy"],
    ["Masala Buttermilk", "Dairy"],
    ["Chocolate Milk", "Dairy"],
    ["White Bread", "Bakery"],
    ["Milk Bread", "Bakery"],
    ["Butter Cookies", "Bakery"],
    ["Veg Puff", "Bakery"],
    ["Basmati Rice 5 kg", "Grocery"],
    ["Toor Dal", "Grocery"],
    ["Peanut Butter Crunchy", "Grocery"],
    ["Parle-G Biscuits", "Snacks & Beverages"],
    ["Potato Chips Salted", "Snacks & Beverages"],
    ["Colgate Toothpaste 200 g", "Personal Care"],
    ["Ponds Cold Cream", "Personal Care"],
    ["Surf Excel Detergent Powder", "Household"],
    ["Classmate Notebook 200 pages", "Stationery"],
    ["USB-C Charger 20W", "Electronics"],
    ["Farm Eggs (12)", "Meat, Fish & Eggs"],
    ["Kaju Katli", "Sweets"],
    ["Onion", "Fruits & Vegetables"],
  ])("%s → %s", (name, expected) => {
    expect(cat(name)).toBe(expected);
  });

  it("uses the old category, brand and description when the name alone is unclear", () => {
    expect(cat("A2 Gir", { oldCategoryName: "Milk", oldDepartment: "DAIRY" })).toBe("Dairy");
    expect(cat("Taaza 1 L", { brand: "Amul", description: "Homogenised toned milk" })).toBe("Dairy");
  });

  it("ignores an old category that is only a shop-type label", () => {
    // "Grocery / Kirana Store" says nothing about what the product is.
    expect(cat("Parle-G Biscuits", { oldCategoryName: "Grocery / Kirana Store", oldDepartment: "GROCERY_KIRANA" })).toBe(
      "Snacks & Beverages",
    );
  });

  it("falls back to General when nothing fits or the evidence is ambiguous", () => {
    expect(cat("Mystery Thing")).toBe("General");
    expect(cat("Gift Voucher Pack", { oldDepartment: "GIFT_SHOP" })).toBe("General");
    const r = categoriseProduct({ name: "Assorted", oldDepartment: "DAIRY" });
    expect(r.confident).toBe(false);
    expect(r.reason).toMatch(/too little evidence/);
  });

  it("matches longest phrases first and never reuses a matched span", () => {
    expect(matchKeywords("peanut butter").map((h) => h.keyword)).toEqual(["peanut butter"]);
    expect(matchKeywords("salted cashews").map((h) => h.keyword)).not.toContain("led");
  });
});

describe("evidence hygiene", () => {
  it("ignores the de-duplication suffix 0038 added to old category names, and spots brands in names", () => {
    expect(cat("Parle-G", { oldCategoryName: "biscuits (Grocery Kirana)", oldDepartment: "GROCERY_KIRANA" })).toBe(
      "Snacks & Beverages",
    );
  });
});

describe("specialist shop types", () => {
  it.each([
    ["Shirts", "Clothing Store", "CLOTHING_STORE", "Clothing"],
    ["sandals", "Footwear Store", "FOOTWEAR_STORE", "Footwear"],
    ["Eyeglasses", "Optical Store", "OPTICAL_STORE", "Optical"],
    ["lubricants", "Automobile Spare Parts Shop", "AUTO_SPARE_PARTS", "Automotive"],
    ["groceries", "Online Store / E-commerce", "ONLINE_STORE", "Grocery"],
  ])("%s (%s) → %s", (name, oldCategoryName, oldDepartment, expected) => {
    expect(cat(name, { oldCategoryName, oldDepartment })).toBe(expected);
  });

  it("still sends genuinely mixed goods to General", () => {
    expect(cat("Mixed consumer goods", { oldCategoryName: "General Trading Store", oldDepartment: "GENERAL_TRADING" })).toBe("General");
  });
});
