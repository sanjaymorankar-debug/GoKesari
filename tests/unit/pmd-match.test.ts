/**
 * Product Master Data Platform - matching & deduplication rules.
 *
 * Encodes the brief's acceptance criteria as executable cases:
 *   - same product from different sellers is one product           (identifiers)
 *   - different pack sizes stay separate                            (hard conflict)
 *   - different variants stay separate                              (hard conflict)
 *   - similar-sounding products are not merged on name alone        (caps)
 *   - nothing below the threshold is ever auto-merged               (decide)
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, resolveConfig } from "@/server/pmd/config";
import { normalizeStaged } from "@/server/pmd/normalize";
import { compareNames, decide, scoreMatch, subjectFromNormalized, type ScoredCandidate } from "@/server/pmd/match/score";
import { NULL_MAPPER } from "@/server/pmd/taxonomy/mapper";
import type { MatchResult, StagedProduct } from "@/server/pmd/types";

const cfg = DEFAULT_CONFIG.match;
const ctx = { categoryMapper: NULL_MAPPER, now: new Date("2026-09-19T00:00:00Z") };

function subject(staged: Partial<StagedProduct> & { name: string }, categoryCode?: string) {
  const n = normalizeStaged({ sourceProductId: "t", ...staged }, ctx);
  const s = subjectFromNormalized(n);
  return categoryCode ? { ...s, categoryL1: categoryCode.split("/")[0] } : s;
}

const GTIN_A = "8901058895780"; // valid EAN-13 (check digit 0)
const GTIN_B = "4006381333931"; // a different valid EAN-13

describe("Level 1 - exact identifier", () => {
  it("same GTIN, same brand -> EXACT_MATCH 100", () => {
    const r = scoreMatch(
      subject({ name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN_A }),
      subject({ name: "AMUL PASTEURISED BUTTER, 500g", brand: "Amul India", gtin: GTIN_A }),
      cfg,
    );
    expect(r).toMatchObject({ status: "EXACT_MATCH", score: 100, rule: "L1_GTIN_BRAND", relation: "SAME_PRODUCT" });
    expect(r.hardConflicts).toEqual([]);
  });

  it("a GTIN written as UPC-A and as EAN-13 is still the same identity", () => {
    const r = scoreMatch(
      subject({ name: "Kleenex Tissue", brand: "Kleenex", gtin: "036000291452" }),
      subject({ name: "Kleenex Facial Tissue", brand: "Kleenex", gtin: "0036000291452" }),
      cfg,
    );
    expect(r.status).toBe("EXACT_MATCH");
  });

  it("same GTIN with the brand missing on one side is still exact (the GTIN is globally unique)", () => {
    const r = scoreMatch(
      subject({ name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN_A }),
      subject({ name: "Butter 500 g", gtin: GTIN_A }),
      cfg,
    );
    expect(r.status).toBe("EXACT_MATCH");
  });

  it("same GTIN but a contradicting brand is a review, never a silent merge", () => {
    const r = scoreMatch(
      subject({ name: "Butter 500 g", brand: "Amul", gtin: GTIN_A }),
      subject({ name: "Butter 500 g", brand: "Britannia", gtin: GTIN_A }),
      cfg,
    );
    expect(r).toMatchObject({ status: "NEEDS_REVIEW", rule: "L1_GTIN_COLLISION" });
    expect(r.hardConflicts).toContain("BRAND_DIFFERENT");
    expect(r.score).toBeLessThan(cfg.possibleThreshold);
  });

  it("same GTIN but a different pack size is a review (crowdsourced barcode errors are common)", () => {
    const r = scoreMatch(
      subject({ name: "Amul Butter 100 g", brand: "Amul", gtin: GTIN_A }),
      subject({ name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN_A }),
      cfg,
    );
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.hardConflicts).toContain("PACK_SIZE_DIFFERENT");
  });

  it("an invalid or in-store code cannot drive a match", () => {
    const a = subject({ name: "Loose Item", brand: "Shop", gtin: "8901058895781" });
    const b = subject({ name: "Loose Item", brand: "Shop", gtin: "8901058895781" });
    expect(a.gtin14).toBeNull();
    expect(scoreMatch(a, b, cfg).rule).not.toBe("L1_GTIN_BRAND");
    expect(subject({ name: "x", gtin: "2000000000008" }).gtin14).toBeNull();
  });

  it("MPN + brand -> EXACT_MATCH", () => {
    const r = scoreMatch(
      subject({ name: "Galaxy S23 Ultra 256GB", brand: "Samsung", mpn: "SM-S918BZKDINU" }),
      subject({ name: "Samsung Galaxy S23 Ultra (256 GB)", brand: "Samsung India", mpn: "SM S918BZKDINU" }),
      cfg,
    );
    expect(r).toMatchObject({ status: "EXACT_MATCH", rule: "L1_MPN_BRAND" });
  });

  it("the same MPN under different brands is surfaced, not dismissed", () => {
    const r = scoreMatch(
      subject({ name: "Adapter", brand: "Anker", mpn: "A2143" }),
      subject({ name: "Adapter", brand: "Ugreen", mpn: "A2143" }),
      cfg,
    );
    expect(r).toMatchObject({ status: "NEEDS_REVIEW", rule: "L1_MPN_BRAND_MISMATCH" });
  });
});

describe("hard conflicts: pack sizes, variants, brands never merge", () => {
  it("different pack sizes of one product are separate products in one family", () => {
    const r = scoreMatch(
      subject({ name: "Amul Butter 100 g", brand: "Amul", gtin: GTIN_A }),
      subject({ name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN_B }),
      cfg,
    );
    expect(r.status).toBe("DIFFERENT_PRODUCT");
    expect(r.relation).toBe("SAME_FAMILY_DIFFERENT_PACK");
    expect(r.hardConflicts).toEqual(expect.arrayContaining(["PACK_SIZE_DIFFERENT", "GTIN_DIFFERENT"]));
    expect(r.score).toBeLessThanOrEqual(40);
  });

  it("the same pack size expressed differently is NOT a conflict (500 g = 0.5 kg)", () => {
    const r = scoreMatch(
      subject({ name: "Aashirvaad Atta 500 g", brand: "Aashirvaad" }),
      subject({ name: "Aashirvaad Atta 0.5 kg", brand: "Aashirvaad" }),
      cfg,
    );
    expect(r.hardConflicts).toEqual([]);
    expect(r).toMatchObject({ status: "HIGH_CONFIDENCE", rule: "L3_STRUCTURED" });
  });

  it("a multipack is a different pack from its single (2 x 500 g != 500 g, and != 1 kg)", () => {
    const single = scoreMatch(subject({ name: "Tata Salt 500 g", brand: "Tata" }), subject({ name: "Tata Salt 2 x 500 g", brand: "Tata" }), cfg);
    expect(single.hardConflicts).toContain("PACK_COUNT_DIFFERENT");
    expect(single.status).toBe("DIFFERENT_PRODUCT");
    const kilo = scoreMatch(subject({ name: "Tata Salt 1 kg", brand: "Tata" }), subject({ name: "Tata Salt 2 x 500 g", brand: "Tata" }), cfg);
    expect(kilo.status).toBe("DIFFERENT_PRODUCT");
  });

  it("different colours of one model are different variants", () => {
    const r = scoreMatch(
      subject({ name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", color: "Phantom Black" }),
      subject({ name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", color: "Cream" }),
      cfg,
    );
    expect(r.status).toBe("DIFFERENT_PRODUCT");
    expect(r.hardConflicts).toContain("COLOR_DIFFERENT");
    expect(r.relation).toBe("SAME_FAMILY_DIFFERENT_VARIANT");
  });

  it("different sizes of one garment are different variants", () => {
    const r = scoreMatch(
      subject({ name: "Slim Fit Jeans", brand: "Levis", size: "32", color: "Blue" }),
      subject({ name: "Slim Fit Jeans", brand: "Levis", size: "34", color: "Blue" }),
      cfg,
    );
    expect(r.hardConflicts).toContain("SIZE_DIFFERENT");
    expect(r.status).toBe("DIFFERENT_PRODUCT");
  });

  it("different models are different products", () => {
    const r = scoreMatch(
      subject({ name: "Galaxy Phone", brand: "Samsung", model: "SM-S911B" }),
      subject({ name: "Galaxy Phone", brand: "Samsung", model: "SM-S916B" }),
      cfg,
    );
    expect(r.hardConflicts).toContain("MODEL_DIFFERENT");
  });

  it("different brands never merge, whatever the name", () => {
    const r = scoreMatch(
      subject({ name: "Cream Biscuits 100 g", brand: "Parle" }),
      subject({ name: "Cream Biscuits 100 g", brand: "Britannia" }),
      cfg,
    );
    expect(r.status).toBe("DIFFERENT_PRODUCT");
    expect(r.hardConflicts).toContain("BRAND_DIFFERENT");
  });

  it("different valid GTINs are different products", () => {
    const r = scoreMatch(
      subject({ name: "Maggi Noodles 70 g", brand: "Maggi", gtin: GTIN_A }),
      subject({ name: "Maggi Noodles 70 g", brand: "Maggi", gtin: GTIN_B }),
      cfg,
    );
    expect(r.hardConflicts).toContain("GTIN_DIFFERENT");
    expect(r.status).toBe("DIFFERENT_PRODUCT");
  });
});

describe("Level 2 / 3 - strong and structured matches", () => {
  it("brand + model + same colour -> HIGH_CONFIDENCE", () => {
    const r = scoreMatch(
      subject({ name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", color: "Cream" }),
      subject({ name: "Samsung Galaxy S23 5G", brand: "Samsung", model: "SM S911B", color: "Cream" }),
      cfg,
    );
    expect(r).toMatchObject({ status: "HIGH_CONFIDENCE", rule: "L2_BRAND_MODEL" });
    expect(r.score).toBeGreaterThanOrEqual(cfg.autoMergeThreshold);
  });

  it("colour known on only one side cannot be auto-merged", () => {
    const r = scoreMatch(
      subject({ name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", color: "Cream" }),
      subject({ name: "Galaxy S23", brand: "Samsung", model: "SM-S911B" }),
      cfg,
    );
    expect(r.status).toBe("POSSIBLE_MATCH");
    expect(r.notes).toContain("COLOR_ONE_SIDED");
    expect(r.score).toBeLessThan(cfg.autoMergeThreshold);
  });

  it("brand + identical core name + identical pack -> HIGH_CONFIDENCE (L3)", () => {
    const r = scoreMatch(
      subject({ name: "Britannia Good Day Butter Cookies 100 g", brand: "Britannia" }),
      subject({ name: "Good Day Butter Cookies - 100g (Britannia)", brand: "Britannia Industries" }),
      cfg,
    );
    expect(r).toMatchObject({ status: "HIGH_CONFIDENCE", rule: "L3_STRUCTURED" });
  });

  it("a product named only by its brand still matches itself", () => {
    const r = scoreMatch(
      subject({ name: "Coca-Cola 500 ml", brand: "Coca-Cola" }),
      subject({ name: "Coca Cola 500ml", brand: "Coca Cola" }),
      cfg,
    );
    expect(r.status).toBe("HIGH_CONFIDENCE");
  });
});

describe("Level 4 - fuzzy: similar names are not enough", () => {
  it("each side has a distinguishing word (butter vs cashew) -> different products", () => {
    const r = scoreMatch(
      subject({ name: "Good Day Butter Cookies 100 g", brand: "Britannia" }),
      subject({ name: "Good Day Cashew Cookies 100 g", brand: "Britannia" }),
      cfg,
    );
    expect(r.status).toBe("DIFFERENT_PRODUCT");
    expect(r.notes).toContain("DISTINCT_TOKENS");
  });

  it("one side has an extra word (Coca-Cola vs Coca-Cola Zero) -> never auto-merged", () => {
    const r = scoreMatch(
      subject({ name: "Coca-Cola 500 ml", brand: "Coca-Cola" }),
      subject({ name: "Coca-Cola Zero 500 ml", brand: "Coca-Cola" }),
      cfg,
    );
    expect(r.status).not.toBe("HIGH_CONFIDENCE");
    expect(r.status).not.toBe("EXACT_MATCH");
    expect(r.score).toBeLessThan(cfg.autoMergeThreshold);
  });

  it("a spelling variant (Taaza / Taza) is queued for review, not auto-merged", () => {
    const r = scoreMatch(
      subject({ name: "Amul Taaza Toned Milk 1 L", brand: "Amul" }),
      subject({ name: "Amul Taza Toned Milk 1 L", brand: "Amul" }),
      cfg,
    );
    expect(r.status).toBe("POSSIBLE_MATCH");
    expect(r.score).toBeLessThan(cfg.autoMergeThreshold);
    expect(r.score).toBeGreaterThanOrEqual(cfg.possibleThreshold);
  });

  it("unknown brand on both sides caps the match at POSSIBLE", () => {
    const r = scoreMatch(subject({ name: "Toned Milk 1 L" }), subject({ name: "Toned Milk 1 L" }), cfg);
    expect(r.status).toBe("POSSIBLE_MATCH");
    expect(r.notes).toContain("BRAND_UNKNOWN");
  });

  it("packaged goods with no pack size on either side cannot be auto-merged", () => {
    const r = scoreMatch(
      subject({ name: "Amul Butter", brand: "Amul" }, "dairy/butter-and-margarine"),
      subject({ name: "Amul Butter", brand: "Amul" }, "dairy/butter-and-margarine"),
      cfg,
    );
    expect(r.status).not.toBe("HIGH_CONFIDENCE");
    expect(r.notes).toContain("PACK_UNKNOWN");
  });

  it("no evidence at all is DIFFERENT_PRODUCT, not a coin flip", () => {
    const r = scoreMatch(subject({ name: "Rice" }), subject({ name: "Laptop Stand" }), cfg);
    expect(r.status).toBe("DIFFERENT_PRODUCT");
    expect(r.score).toBeLessThan(cfg.possibleThreshold);
  });

  it("compareNames tolerates transliteration but distinguishes real words", () => {
    expect(compareNames("taaza toned milk", "taza toned milk").dice).toBe(1);
    expect(compareNames("green yogurt", "greek yogurt").dice).toBe(1); // fuzzy => must stay below auto-merge (see L4 rules)
    expect(compareNames("butter cookies", "cashew cookies").onlyA).toEqual(["butter"]);
  });

  it("green vs greek yogurt: fuzzy-equal tokens still cannot auto-merge", () => {
    const r = scoreMatch(
      subject({ name: "Epigamia Green Yogurt 90 g", brand: "Epigamia" }),
      subject({ name: "Epigamia Greek Yogurt 90 g", brand: "Epigamia" }),
      cfg,
    );
    expect(r.status).not.toBe("HIGH_CONFIDENCE");
    expect(r.rule).not.toBe("L3_STRUCTURED");
  });
});

describe("configurable thresholds", () => {
  it("raising the auto-merge threshold turns a HIGH_CONFIDENCE pair into a review", () => {
    const a = subject({ name: "Britannia Good Day Butter Cookies 100 g", brand: "Britannia" });
    const b = subject({ name: "Good Day Butter Cookies 100 g", brand: "Britannia" });
    expect(scoreMatch(a, b, cfg).status).toBe("HIGH_CONFIDENCE");
    const strict = resolveConfig({ match: { autoMergeThreshold: 99, possibleThreshold: 70, reviewFloor: 55 } }).match;
    expect(scoreMatch(a, b, strict).status).toBe("POSSIBLE_MATCH");
  });

  it("rejects inconsistent configuration", () => {
    expect(() => resolveConfig({ match: { autoMergeThreshold: 60, possibleThreshold: 70 } })).toThrow(/thresholds/);
    expect(() => resolveConfig({ match: { weights: { name: 0.9, brand: 0.9, model: 0, pack: 0, variant: 0, category: 0 } } })).toThrow(/sum to 1/);
  });
});

/* ------------------------------------------------------------- decide() */

function cand(productId: number, partial: Partial<MatchResult>): ScoredCandidate {
  return {
    productId,
    result: {
      score: 50, status: "DIFFERENT_PRODUCT", relation: "UNRELATED", rule: "L4_FUZZY",
      components: {}, hardConflicts: [], notes: [], ...partial,
    },
  };
}

describe("decide - never merges below the threshold", () => {
  it("links only when EXACT/HIGH, at or above the threshold, with no hard conflicts", () => {
    expect(decide([cand(1, { status: "EXACT_MATCH", score: 100 })], cfg)).toMatchObject({ action: "LINK" });
    expect(decide([cand(1, { status: "HIGH_CONFIDENCE", score: 94 })], cfg)).toMatchObject({ action: "LINK" });
    expect(decide([cand(1, { status: "HIGH_CONFIDENCE", score: 91 })], cfg).action).not.toBe("LINK");
    expect(decide([cand(1, { status: "HIGH_CONFIDENCE", score: 95, hardConflicts: ["PACK_SIZE_DIFFERENT"] })], cfg).action).not.toBe("LINK");
  });

  it("creates a new master with no candidates", () => {
    expect(decide([], cfg)).toMatchObject({ action: "CREATE", reason: "NO_CANDIDATES" });
  });

  it("possible duplicates create a new master AND queue the candidate for review", () => {
    const d = decide([cand(7, { status: "POSSIBLE_MATCH", score: 80 })], cfg);
    expect(d.action).toBe("CREATE_AND_QUEUE");
    expect(d.queue.map((q) => q.productId)).toEqual([7]);
  });

  it("candidates below the review floor are not queued", () => {
    const d = decide([cand(7, { status: "POSSIBLE_MATCH", score: 50 })], cfg);
    expect(d.action).toBe("CREATE");
    expect(d.queue).toEqual([]);
  });

  it("a GTIN collision is held for a person - it cannot become a second master", () => {
    const d = decide([cand(3, { status: "NEEDS_REVIEW", score: 60, rule: "L1_GTIN_COLLISION", hardConflicts: ["BRAND_DIFFERENT"] })], cfg);
    expect(d).toMatchObject({ action: "HOLD", reason: "GTIN_COLLISION" });
  });

  it("two equally good masters are ambiguous - held, not picked arbitrarily", () => {
    const d = decide([cand(1, { status: "HIGH_CONFIDENCE", score: 96 }), cand(2, { status: "HIGH_CONFIDENCE", score: 96 })], cfg);
    expect(d).toMatchObject({ action: "HOLD", reason: "AMBIGUOUS_CANDIDATES" });
  });

  it("a pack-size sibling puts the new product in the same family", () => {
    const d = decide([cand(5, { status: "DIFFERENT_PRODUCT", score: 38, relation: "SAME_FAMILY_DIFFERENT_PACK", hardConflicts: ["PACK_SIZE_DIFFERENT"] })], cfg);
    expect(d.action).toBe("CREATE");
    expect(d.familyOf?.productId).toBe(5);
  });
});
