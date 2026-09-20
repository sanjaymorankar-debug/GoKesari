/**
 * Product Master Data Platform - category taxonomy and source-category mapping.
 */
import { describe, expect, it } from "vitest";

import { ATTRIBUTE_DEFINITIONS, getAttributeDefinition, toAttributeKey } from "@/server/pmd/taxonomy/attributes";
import { getCategoryByCode, getTaxonomy, parseTaxonomy, slugify, UNCATEGORISED_CODE } from "@/server/pmd/taxonomy/categories";
import { chainMappers, createCategoryMapper, normalizeSourceCategory } from "@/server/pmd/taxonomy/mapper";

describe("category taxonomy", () => {
  const rows = getTaxonomy();

  it("goes five levels deep and every node's level matches its path", () => {
    expect(Math.max(...rows.map((r) => r.level))).toBe(5);
    for (const r of rows) {
      expect(r.pathNames).toHaveLength(r.level);
      expect(r.code.split("/")).toHaveLength(r.level);
    }
  });

  it("contains the brief's grocery example", () => {
    const leaf = getCategoryByCode("grocery/staples/rice/basmati-rice/premium-basmati-rice");
    expect(leaf?.pathNames).toEqual(["Grocery", "Staples", "Rice", "Basmati Rice", "Premium Basmati Rice"]);
    expect(leaf?.level).toBe(5);
  });

  it("contains the brief's electronics example", () => {
    const leaf = getCategoryByCode("electronics/computers/laptops/gaming-laptops/15-inch-gaming-laptop");
    expect(leaf?.pathNames).toEqual(["Electronics", "Computers", "Laptops", "Gaming Laptops", "15-inch Gaming Laptop"]);
  });

  it("covers every pilot category family", () => {
    const l1 = new Set(rows.filter((r) => r.level === 1).map((r) => r.slug));
    for (const s of [
      "grocery", "food", "beverages", "dairy", "electronics", "apparel", "home-and-kitchen", "beauty",
      "personal-care", "stationery", "toys", "automotive", "tools",
    ]) expect(l1, s).toContain(s);
    expect(getCategoryByCode("electronics/mobiles")).toBeDefined();
    expect(getCategoryByCode("electronics/computers")).toBeDefined();
  });

  it("has unique codes, parents before children, and a catch-all", () => {
    expect(new Set(rows.map((r) => r.code)).size).toBe(rows.length);
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.parentCode) expect(seen.has(r.parentCode), r.code).toBe(true);
      seen.add(r.code);
    }
    expect(getCategoryByCode(UNCATEGORISED_CODE)).toBeDefined();
  });

  it("children inherit the department of their top-level ancestor unless a branch overrides it", () => {
    expect(getCategoryByCode("dairy/milk/toned-milk")?.department).toBe("DAIRY");
    expect(getCategoryByCode("electronics/mobiles/smartphones")?.department).toBe("MOBILE_PHONE_STORE");
    expect(getCategoryByCode("electronics/televisions".replace("televisions", "tvs-and-audio"))?.department).toBe("ELECTRONICS_STORE");
  });

  it("rejects malformed outlines", () => {
    expect(() => parseTaxonomy("A\n    B")).toThrow(/skipped a level/);
    expect(() => parseTaxonomy("A\n B")).toThrow(/odd indentation/);
    expect(() => parseTaxonomy("A\n  B\n  B")).toThrow(/duplicate/);
    expect(() => parseTaxonomy("A\n  B\n    C\n      D\n        E\n          F")).toThrow(/more than 5 levels/);
  });

  it("slugifies consistently", () => {
    expect(slugify("Home & Kitchen")).toBe("home-and-kitchen");
    expect(slugify("Men's Footwear")).toBe("mens-footwear");
    expect(slugify("Wheat Flour (Atta)")).toBe("wheat-flour-atta");
  });
});

describe("category mapper", () => {
  const mapper = createCategoryMapper({
    tags: {
      "en:beverages": "beverages",
      "en:milks": "dairy/milk",
      "en:toned-milks": "dairy/milk/toned-milk",
    },
    keywords: [[/\bbasmati\b/, "grocery/staples/rice/basmati-rice"]],
  });

  it("normalises source category tags", () => {
    expect(normalizeSourceCategory("en:extra-virgin-olive-oils")).toBe("extra virgin olive oils");
  });

  it("maps a tag and reports it as a TAG match with high confidence", () => {
    expect(mapper.map(["en:milks"], "x")).toMatchObject({ code: "dairy/milk", via: "TAG", confidence: 90 });
  });

  it("the deepest mapped tag wins", () => {
    expect(mapper.map(["en:beverages", "en:milks", "en:toned-milks"], "x")?.code).toBe("dairy/milk/toned-milk");
  });

  it("falls back to name keywords with lower confidence", () => {
    expect(mapper.map(["en:unknown"], "Daawat Basmati Rice")).toMatchObject({ code: "grocery/staples/rice/basmati-rice", via: "KEYWORD", confidence: 55 });
  });

  it("returns null when nothing maps - the caller files it as Uncategorised, not a guess", () => {
    expect(mapper.map(["en:whatever"], "Mystery")).toBeNull();
  });

  it("chains mappers in order", () => {
    const a = createCategoryMapper({ tags: {}, keywords: [] });
    expect(chainMappers(a, mapper).map(["en:milks"], "")?.code).toBe("dairy/milk");
  });
});

describe("attribute registry", () => {
  it("defines the food, electronics and apparel fields the brief lists", () => {
    const has = (k: string) => expect(getAttributeDefinition(k), k).toBeDefined();
    ["fssai_number", "ingredients", "allergen_information", "energy_kcal_per_100g", "protein_g_per_100g",
      "carbohydrates_g_per_100g", "total_fat_g_per_100g", "saturated_fat_g_per_100g", "trans_fat_g_per_100g",
      "sugar_g_per_100g", "sodium_mg_per_100g", "dietary_fiber_g_per_100g", "serving_size", "vegetarian_nonveg",
      "organic", "vegan", "shelf_life", "storage_instructions", "preparation_instructions"].forEach(has);
    ["processor", "ram_gb", "storage_gb", "display_size_in", "display_type", "resolution", "refresh_rate_hz",
      "operating_system", "battery_capacity_mah", "camera", "connectivity", "wifi", "bluetooth", "ports",
      "power_w", "warranty", "warranty_period_months"].forEach(has);
    ["gender", "age_group", "clothing_type", "fabric", "pattern", "fit", "sleeve_type", "neck_type",
      "occasion", "season", "wash_care"].forEach(has);
  });

  it("has unique keys in snake_case", () => {
    const keys = ATTRIBUTE_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("turns arbitrary source labels into safe keys", () => {
    expect(toAttributeKey("Display Size (in)")).toBe("display_size_in");
    expect(toAttributeKey("  --Wi-Fi 6E!! ")).toBe("wi_fi_6e");
  });
});
