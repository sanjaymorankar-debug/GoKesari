/**
 * Product Master Data Platform - DATA_QUALITY_SCORE.
 * Missing data is never scored as zero; components with no basis drop out.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "@/server/pmd/config";
import { computeQuality, qualityGroupFor, type QualityInput } from "@/server/pmd/pipeline/quality";

const cfg = DEFAULT_CONFIG.quality;
const NOW = new Date("2026-09-19T00:00:00Z");

function input(over: Partial<QualityInput> = {}): QualityInput {
  return {
    hasValidGtin: true, hasIsbn: false, hasMpn: false, hasBrand: true, hasModelSkuOrCode: false, hasSourceCodeOnly: false,
    sourceReliabilities: [65], distinctSources: 1, matchConfidence: 100, lastSeenAt: NOW, now: NOW,
    categoryLevel: 3, categoryIsUncategorised: false, categoryCode: "grocery/staples/rice",
    present: { manufacturer: true, netQuantity: true, gst: true, hsn: true, description: true, image: true, color: false, size: false },
    specKeys: new Set(["country_of_origin", "ingredients", "energy_kcal_per_100g", "vegetarian_nonveg", "fssai_number"]),
    ...over,
  };
}

describe("data quality score", () => {
  it("is a 0-100 number and rewards identification, sources and completeness", () => {
    const rich = computeQuality(input(), cfg);
    const bare = computeQuality(
      input({
        hasValidGtin: false, hasBrand: false, sourceReliabilities: [50], matchConfidence: 70,
        categoryIsUncategorised: true, categoryLevel: 0, categoryCode: null,
        present: { manufacturer: false, netQuantity: false, gst: false, hsn: false, description: false, image: false, color: false, size: false },
        specKeys: new Set(),
      }),
      cfg,
    );
    expect(rich.score).toBeGreaterThan(bare.score);
    for (const r of [rich, bare]) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it("ranks identifier strength: GTIN > MPN+brand > model/SKU > source code > none", () => {
    const score = (over: Partial<QualityInput>) => computeQuality(input({ hasValidGtin: false, ...over }), cfg).components.identifier.score;
    expect(computeQuality(input(), cfg).components.identifier.score).toBe(100);
    expect(score({ hasMpn: true, hasBrand: true })).toBe(70);
    expect(score({ hasModelSkuOrCode: true })).toBe(40);
    expect(score({ hasSourceCodeOnly: true })).toBe(15);
    expect(score({})).toBe(0);
  });

  it("does NOT treat an unknown component as zero - it drops out and the rest are renormalised", () => {
    const known = computeQuality(input({ matchConfidence: 0 }), cfg);
    const unknown = computeQuality(input({ matchConfidence: null }), cfg);
    expect(unknown.components.matchConfidence.score).toBeNull();
    expect(unknown.score).toBeGreaterThan(known.score);
    // Renormalised: the weighted mean of the components that DO have a basis.
    let num = 0;
    let den = 0;
    for (const c of Object.values(unknown.components)) if (c.score != null) { num += c.score * c.weight; den += c.weight; }
    expect(unknown.score).toBeCloseTo(num / den, 1);
  });

  it("corroboration grows with independent sources", () => {
    const s = (n: number) => computeQuality(input({ distinctSources: n }), cfg).components.corroboration.score;
    expect([s(1), s(2), s(3), s(4), s(9)]).toEqual([30, 65, 85, 100, 100]);
  });

  it("recency decays with age", () => {
    const at = (days: number) => computeQuality(input({ lastSeenAt: new Date(NOW.getTime() - days * 86_400_000) }), cfg).components.recency.score;
    expect([at(1), at(20), at(60), at(200), at(900)]).toEqual([100, 80, 55, 30, 10]);
  });

  it("expects category-appropriate fields and lists exactly what is missing", () => {
    const food = computeQuality(input({ specKeys: new Set() }), cfg);
    expect(food.missingFields).toEqual(expect.arrayContaining(["ingredients", "nutrition", "fssai_number"]));
    // The same absence is not a defect for a non-food product.
    const tool = computeQuality(input({ categoryCode: "tools/hand-tools", specKeys: new Set() }), cfg);
    expect(tool.missingFields).not.toContain("ingredients");
    expect(tool.missingFields).not.toContain("net_quantity");
    const phone = computeQuality(input({ categoryCode: "electronics/mobiles/smartphones", specKeys: new Set() }), cfg);
    expect(phone.missingFields).toEqual(expect.arrayContaining(["model_number", "key_specs"]));
  });

  it("knows which categories are food-like and pack-sensitive", () => {
    expect(qualityGroupFor("dairy/milk")).toEqual({ group: "FOOD", packSensitive: true });
    expect(qualityGroupFor("electronics/computers")).toEqual({ group: "ELECTRONICS", packSensitive: false });
    expect(qualityGroupFor("apparel/men")).toEqual({ group: "APPAREL", packSensitive: false });
    expect(qualityGroupFor(null)).toEqual({ group: "GENERAL", packSensitive: false });
  });
});
