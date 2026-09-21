/**
 * Product matching: are two records the same real-world product?
 *
 * Pure and deterministic - no database, no clock - so every rule is unit-testable.
 * Candidate retrieval (finding *which* masters to compare) lives in engine.ts.
 *
 * The four levels of the brief:
 *   L1  exact identifier   GTIN/ISBN (+ brand compatible), or MPN + brand
 *   L2  strong             brand + model, variants consistent
 *   L3  structured         brand + identical core name + identical pack size
 *   L4  fuzzy              weighted similarity, with a coverage penalty
 *
 * Two principles override the arithmetic:
 *
 *   HARD CONFLICTS. A different pack size, pack count, colour, size, variant,
 *   model, MPN, brand or GTIN means "different product" whatever the names look
 *   like. 500 g and 1 kg of the same biscuit are two products in one family.
 *
 *   NO AUTO-MERGE ON GUESSWORK. Anything that rests on missing evidence (unknown
 *   brand, unknown pack, one side has extra words) is capped below the auto-merge
 *   threshold so a person decides. Identifiers are strong but not infallible:
 *   a GTIN match that contradicts the brand or pack is a NEEDS_REVIEW, not a merge.
 */
import type { MatchConfig } from "../config";
import { stem, tokenize, tokensEquivalent, trigramSimilarity } from "../normalize/text";
import type {
  MatchRelation,
  MatchResult,
  MatchStatus,
  MatchSubject,
  NormalizedProduct,
} from "../types";

/** Categories where a missing pack size makes two listings indistinguishable (a 100 g and a 500 g pack). */
const PACK_SENSITIVE_L1 = new Set([
  "grocery", "food", "beverages", "dairy", "health-and-wellness", "beauty", "personal-care", "pet-supplies",
]);

const PACK_TOLERANCE = 0.005;
const DIMENSION_TOLERANCE = 0.05;

/* ------------------------------------------------------------- subjects */

export function categoryL1FromCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const first = code.split("/")[0];
  return first && first !== "uncategorised" ? first : null;
}

export function subjectFromNormalized(n: NormalizedProduct): MatchSubject {
  return {
    brandKey: n.brand?.key ?? null,
    gtin14: n.gtin?.usableForMatching ? n.gtin.gtin14 : null,
    isbn13: n.isbn13,
    mpnKey: n.mpn?.key ?? null,
    modelKey: n.model?.key ?? null,
    coreName: n.coreName,
    variant: n.variant ? tokenize(n.variant).join(" ") : null,
    colorKey: n.color?.key ?? null,
    sizeKey: n.size?.key ?? null,
    pack: n.quantity ? { unitValue: n.quantity.unitValue, unit: n.quantity.unit, multiplier: n.quantity.multiplier } : null,
    categoryL1: categoryL1FromCode(n.categoryCode),
    dimensionsMm: n.dimensionsMm,
  };
}

/* ---------------------------------------------------------- comparisons */

export interface NameComparison {
  /** 0-1 blended similarity. */
  score: number;
  dice: number;
  trigram: number;
  onlyA: string[];
  onlyB: string[];
}

export function compareNames(a: string, b: string): NameComparison {
  const ta = tokenize(a).map(stem);
  const tb = tokenize(b).map(stem);
  if (ta.length === 0 || tb.length === 0) {
    return { score: 0, dice: 0, trigram: 0, onlyA: ta, onlyB: tb };
  }
  const remaining = [...tb];
  const onlyA: string[] = [];
  let matches = 0;
  for (const t of ta) {
    let idx = remaining.indexOf(t);
    if (idx < 0) idx = remaining.findIndex((r) => tokensEquivalent(t, r));
    if (idx >= 0) {
      matches++;
      remaining.splice(idx, 1);
    } else onlyA.push(t);
  }
  const dice = (2 * matches) / (ta.length + tb.length);
  const trigram = trigramSimilarity(a, b);
  return { score: 0.6 * dice + 0.4 * trigram, dice, trigram, onlyA, onlyB: remaining };
}

type PackComparison = "EQUAL" | "DIFFERENT_SIZE" | "DIFFERENT_COUNT" | "UNKNOWN";

function comparePack(a: MatchSubject["pack"], b: MatchSubject["pack"]): PackComparison {
  if (!a || !b) return "UNKNOWN";
  if (a.unit !== b.unit) return "DIFFERENT_SIZE";
  const rel = Math.abs(a.unitValue - b.unitValue) / Math.max(a.unitValue, b.unitValue);
  if (rel > PACK_TOLERANCE) return "DIFFERENT_SIZE";
  // Same size per unit but a different number of units: "2 x 500 g" vs "500 g".
  return a.multiplier === b.multiplier ? "EQUAL" : "DIFFERENT_COUNT";
}

/** 1 equal, 0.7 one contains the other, 0 different, null when either side is missing. */
function compareLooseKey(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  if (a === b) return 1;
  const ta = new Set(a.split(" "));
  const tb = new Set(b.split(" "));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return [...small].every((t) => big.has(t)) ? 0.7 : 0;
}

function dimensionsDiffer(a: MatchSubject["dimensionsMm"], b: MatchSubject["dimensionsMm"]): boolean {
  if (!a || !b) return false;
  const pairs: Array<[number, number]> = [
    [a.length, b.length],
    [a.width, b.width],
    [a.height, b.height],
  ];
  return pairs.some(([x, y]) => Math.abs(x - y) / Math.max(x, y) > DIMENSION_TOLERANCE);
}

/* ---------------------------------------------------------------- score */

const VARIANT_CONFLICTS = ["COLOR_DIFFERENT", "SIZE_DIFFERENT", "VARIANT_DIFFERENT", "MODEL_DIFFERENT", "MPN_DIFFERENT"];
const PACK_CONFLICTS = ["PACK_SIZE_DIFFERENT", "PACK_COUNT_DIFFERENT"];

function statusFor(score: number, cfg: MatchConfig): MatchStatus {
  if (score >= cfg.autoMergeThreshold) return "HIGH_CONFIDENCE";
  if (score >= cfg.possibleThreshold) return "POSSIBLE_MATCH";
  return "DIFFERENT_PRODUCT";
}

function classifyRelation(
  status: MatchStatus,
  hard: string[],
  brandCompatible: boolean,
  brandEqual: boolean,
  name: NameComparison,
): MatchRelation {
  if (hard.length === 0) {
    return status === "DIFFERENT_PRODUCT" ? "UNRELATED" : "SAME_PRODUCT";
  }
  const namesClose = name.dice >= 0.85 && name.onlyA.length === 0 && name.onlyB.length === 0;
  // Two distinct SKUs always have different GTINs, so that fact alone says nothing about *how*
  // they differ. Classify on the remaining conflicts.
  const meaningful = hard.filter((c) => c !== "GTIN_DIFFERENT");
  if (brandCompatible && namesClose) {
    if (meaningful.some((c) => VARIANT_CONFLICTS.includes(c))) return "SAME_FAMILY_DIFFERENT_VARIANT";
    if (meaningful.length > 0 && meaningful.every((c) => PACK_CONFLICTS.includes(c))) return "SAME_FAMILY_DIFFERENT_PACK";
    // Same brand, same name, same pack - only the GTIN differs: a distinct SKU of the same line.
    if (meaningful.length === 0) return "SAME_FAMILY_DIFFERENT_VARIANT";
  }
  if (brandEqual && name.dice >= 0.34) return "SAME_BRAND_DIFFERENT_PRODUCT";
  return "UNRELATED";
}

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function scoreMatch(a: MatchSubject, b: MatchSubject, cfg: MatchConfig): MatchResult {
  const notes: string[] = [];
  const hard: string[] = [];
  const components: Record<string, number | null> = {};

  /* ---- identifiers ------------------------------------------------- */
  const gtinBoth = !!(a.gtin14 && b.gtin14);
  const gtinEqual = gtinBoth && a.gtin14 === b.gtin14;
  const isbnEqual = !!(a.isbn13 && b.isbn13 && a.isbn13 === b.isbn13);
  const identifierEqual = gtinEqual || isbnEqual;
  if (gtinBoth && !gtinEqual) hard.push("GTIN_DIFFERENT");

  /* ---- brand ------------------------------------------------------- */
  let brand: number | null = null;
  let brandCompatible = true;
  if (a.brandKey && b.brandKey) {
    if (a.brandKey === b.brandKey) brand = 1;
    else if (trigramSimilarity(a.brandKey, b.brandKey) >= 0.8) {
      brand = 0.6;
      notes.push("BRAND_SIMILAR");
    } else {
      brand = 0;
      brandCompatible = false;
      hard.push("BRAND_DIFFERENT");
    }
  } else notes.push("BRAND_UNKNOWN");
  const brandEqual = brand === 1;
  components.brand = brand;

  /* ---- MPN / model ------------------------------------------------- */
  const mpnEqual = !!(a.mpnKey && b.mpnKey && a.mpnKey === b.mpnKey);
  if (a.mpnKey && b.mpnKey && !mpnEqual) hard.push("MPN_DIFFERENT");

  let model: number | null = null;
  if (a.modelKey && b.modelKey) {
    if (a.modelKey === b.modelKey) model = 1;
    else {
      const [s, l] = a.modelKey.length <= b.modelKey.length ? [a.modelKey, b.modelKey] : [b.modelKey, a.modelKey];
      if (s.length >= 5 && l.startsWith(s)) {
        model = 0.7; // "SM-S918B" vs "SM-S918B/DS": a regional/SIM variant - a person should look.
        notes.push("MODEL_SUFFIX_DIFFERS");
      } else {
        model = 0;
        hard.push("MODEL_DIFFERENT");
      }
    }
  }
  components.model = mpnEqual ? 1 : model;

  /* ---- pack -------------------------------------------------------- */
  const pack = comparePack(a.pack, b.pack);
  if (pack === "DIFFERENT_SIZE") hard.push("PACK_SIZE_DIFFERENT");
  if (pack === "DIFFERENT_COUNT") hard.push("PACK_COUNT_DIFFERENT");
  components.pack = pack === "EQUAL" ? 1 : pack === "UNKNOWN" ? null : 0;

  const l1 = a.categoryL1 ?? b.categoryL1;
  const packMatters = (l1 != null && PACK_SENSITIVE_L1.has(l1)) || !!a.pack || !!b.pack;
  const packUnknownRisk = pack === "UNKNOWN" && packMatters;
  if (packUnknownRisk) notes.push("PACK_UNKNOWN");

  /* ---- variant: colour, size, free-text variant -------------------- */
  const color = compareLooseKey(a.colorKey, b.colorKey);
  const size = compareLooseKey(a.sizeKey, b.sizeKey);
  const variantText = compareLooseKey(a.variant, b.variant);
  if (color === 0) hard.push("COLOR_DIFFERENT");
  if (size === 0) hard.push("SIZE_DIFFERENT");
  if (variantText === 0) hard.push("VARIANT_DIFFERENT");
  if (dimensionsDiffer(a.dimensionsMm, b.dimensionsMm)) hard.push("DIMENSIONS_DIFFERENT");
  // Present on one side only: cannot tell which variant this is.
  if (!!a.colorKey !== !!b.colorKey) notes.push("COLOR_ONE_SIDED");
  if (!!a.sizeKey !== !!b.sizeKey) notes.push("SIZE_ONE_SIDED");
  const variantParts = [color, size, variantText].filter((v): v is number => v != null);
  const variant = variantParts.length ? variantParts.reduce((x, y) => x + y, 0) / variantParts.length : null;
  components.variant = variant;

  /* ---- category ---------------------------------------------------- */
  let category: number | null = null;
  if (a.categoryL1 && b.categoryL1) {
    category = a.categoryL1 === b.categoryL1 ? 1 : 0;
    if (category === 0) notes.push("CATEGORY_DIFFERENT");
  }
  components.category = category;

  /* ---- name -------------------------------------------------------- */
  // A core name can be empty: a product named only by its brand ("Coca-Cola 500 ml").
  // Two such products under the same brand are the same name; one empty and one not means
  // the other side carries a distinguishing word ("Coca-Cola" vs "Coca-Cola Zero").
  const aEmpty = a.coreName.length === 0;
  const bEmpty = b.coreName.length === 0;
  let name: NameComparison;
  let identicalName: boolean;
  let nameScore: number;
  if (aEmpty && bEmpty) {
    identicalName = brandEqual;
    name = { score: brandEqual ? 1 : 0, dice: brandEqual ? 1 : 0, trigram: brandEqual ? 1 : 0, onlyA: [], onlyB: [] };
    nameScore = name.score;
    components.name = brandEqual ? 1 : null;
  } else if (aEmpty || bEmpty) {
    identicalName = false;
    const extra = tokenize(aEmpty ? b.coreName : a.coreName).map(stem);
    name = { score: 0.25, dice: 0, trigram: 0, onlyA: aEmpty ? [] : extra, onlyB: aEmpty ? extra : [] };
    nameScore = name.score;
    components.name = round2(nameScore);
  } else {
    name = compareNames(a.coreName, b.coreName);
    identicalName = a.coreName === b.coreName;
    nameScore = identicalName ? 1 : name.score;
    components.name = round2(nameScore);
  }
  const bothSidesExtra = name.onlyA.length > 0 && name.onlyB.length > 0;
  const oneSideExtra = !bothSidesExtra && (name.onlyA.length > 0 || name.onlyB.length > 0);
  if (bothSidesExtra) notes.push("DISTINCT_TOKENS");
  else if (oneSideExtra) notes.push("EXTRA_TOKENS");

  const finish = (score: number, status: MatchStatus, rule: string): MatchResult => ({
    score: round2(clamp(score)),
    status,
    relation: classifyRelation(status, hard, brandCompatible, brandEqual, name),
    rule,
    components,
    hardConflicts: hard,
    notes,
  });

  /* ================= decision ======================================= */

  // L1 - the identifier says "same". A contradiction elsewhere makes it a review, never a silent merge.
  if (identifierEqual) {
    if (hard.length === 0) return finish(100, "EXACT_MATCH", gtinEqual ? "L1_GTIN_BRAND" : "L1_ISBN");
    return finish(Math.min(60, cfg.possibleThreshold - 1), "NEEDS_REVIEW", "L1_GTIN_COLLISION");
  }

  // Different valid GTINs: two products (or a data error a person can fix).
  if (hard.length) {
    // Same MPN under different brands is a relabel or a mistake - surface it instead of dismissing it.
    if (mpnEqual && hard.length === 1 && hard[0] === "BRAND_DIFFERENT") {
      return finish(Math.min(60, cfg.possibleThreshold - 1), "NEEDS_REVIEW", "L1_MPN_BRAND_MISMATCH");
    }
    const base = 100 * (0.4 * nameScore) ; // a conflicted pair never scores above 40
    return finish(Math.min(base, 40), "DIFFERENT_PRODUCT", "HARD_CONFLICT");
  }

  // L1 - MPN + brand.
  if (mpnEqual && brandEqual) return finish(99, "EXACT_MATCH", "L1_MPN_BRAND");

  /**
   * Notes that forbid an automatic merge. When the rule rests on an identifier (brand + model)
   * rather than on the wording, a single extra word ("5G") is not evidence of a different product.
   */
  const blockers = (identifierRule: boolean) =>
    ["BRAND_UNKNOWN", "BRAND_SIMILAR", "PACK_UNKNOWN", "DISTINCT_TOKENS", "MODEL_SUFFIX_DIFFERS",
      "COLOR_ONE_SIDED", "SIZE_ONE_SIDED", "CATEGORY_DIFFERENT", ...(identifierRule ? [] : ["EXTRA_TOKENS"])];
  const noAutoMerge = (identifierRule: boolean) => notes.some((n) => blockers(identifierRule).includes(n));

  const finalise = (score: number, rule: string, identifierRule = false): MatchResult => {
    let s = score;
    let status = statusFor(s, cfg);
    if (bothSidesExtra && !identifierRule) {
      // Each side has a word the other lacks ("butter" vs "cashew"): likely different products.
      s = Math.min(s, cfg.possibleThreshold - 1);
      status = "DIFFERENT_PRODUCT";
    } else if (noAutoMerge(identifierRule) && status === "HIGH_CONFIDENCE") {
      s = Math.min(s, cfg.autoMergeThreshold - 1);
      status = statusFor(s, cfg);
      if (status === "HIGH_CONFIDENCE") status = "POSSIBLE_MATCH";
    }
    // Near-identical names under grey-band brand evidence: too close to call.
    if (notes.includes("BRAND_SIMILAR") && status === "POSSIBLE_MATCH" && name.dice >= 0.85) status = "NEEDS_REVIEW";
    return finish(s, status, rule);
  };

  // L2 - brand + model, variants consistent.
  if (brandEqual && components.model === 1) {
    return finalise(94 + (identicalName ? 2 : 0) + (variant === 1 ? 1 : 0), "L2_BRAND_MODEL", true);
  }

  // L3 - brand + identical core name + identical pack.
  if (brandEqual && identicalName && pack === "EQUAL") {
    return finalise(94 + (variant === 1 ? 2 : 0) + (category === 1 ? 2 : 0), "L3_STRUCTURED");
  }

  // L4 - fuzzy. Weighted average over the evidence that exists, penalised for how little there is.
  const w = cfg.weights;
  const parts: Array<[number | null, number]> = [
    [components.name, w.name],
    [brand, w.brand],
    [components.model, w.model],
    [components.pack, w.pack],
    [variant, w.variant],
    [category, w.category],
  ];
  const availWeight = parts.reduce((s, [v, wt]) => (v == null ? s : s + wt), 0);
  if (components.name == null || availWeight === 0) return finish(0, "DIFFERENT_PRODUCT", "L4_NO_EVIDENCE");
  const base = parts.reduce((s, [v, wt]) => (v == null ? s : s + wt * v), 0) / availWeight;
  const coverage = availWeight / (w.name + w.brand + w.model + w.pack + w.variant + w.category);
  return finalise(100 * base * (0.55 + 0.45 * coverage), "L4_FUZZY");
}

/* --------------------------------------------------------------- decide */

export interface ScoredCandidate {
  productId: number;
  result: MatchResult;
}

export type MatchAction = "LINK" | "CREATE" | "CREATE_AND_QUEUE" | "HOLD";

export interface MatchDecision {
  action: MatchAction;
  /** The candidate linked to (LINK) or the strongest candidate seen (others). */
  best: ScoredCandidate | null;
  /** Candidates a person should review (POSSIBLE_MATCH / NEEDS_REVIEW at or above the floor). */
  queue: ScoredCandidate[];
  /** For CREATE*: the master whose family the new product belongs to (a pack size or variant sibling). */
  familyOf: ScoredCandidate | null;
  reason: string;
}

export function decide(scored: ScoredCandidate[], cfg: MatchConfig): MatchDecision {
  const sorted = [...scored].sort((x, y) => y.result.score - x.result.score || x.productId - y.productId);
  const best = sorted[0] ?? null;
  const queue = sorted
    .filter((c) => (c.result.status === "POSSIBLE_MATCH" || c.result.status === "NEEDS_REVIEW") && c.result.score >= cfg.reviewFloor)
    .slice(0, 5);
  const familyOf = sorted.find((c) => c.result.relation.startsWith("SAME_FAMILY")) ?? null;

  if (!best) return { action: "CREATE", best: null, queue: [], familyOf: null, reason: "NO_CANDIDATES" };

  const linkable = (c: ScoredCandidate) =>
    (c.result.status === "EXACT_MATCH" || c.result.status === "HIGH_CONFIDENCE") &&
    c.result.score >= cfg.autoMergeThreshold &&
    c.result.hardConflicts.length === 0;

  if (linkable(best)) {
    const rival = sorted[1];
    // Two masters equally good: picking one arbitrarily would be a guess.
    if (rival && linkable(rival) && Math.abs(rival.result.score - best.result.score) < 1) {
      return { action: "HOLD", best, queue: [best, rival], familyOf: null, reason: "AMBIGUOUS_CANDIDATES" };
    }
    return { action: "LINK", best, queue: [], familyOf: null, reason: best.result.rule };
  }

  // A GTIN collision cannot become a new master: the GTIN is unique. A person resolves it.
  if (best.result.rule === "L1_GTIN_COLLISION") {
    return { action: "HOLD", best, queue: [best], familyOf: null, reason: "GTIN_COLLISION" };
  }

  return {
    action: queue.length ? "CREATE_AND_QUEUE" : "CREATE",
    best,
    queue,
    familyOf,
    reason: queue.length ? "POSSIBLE_DUPLICATE" : "NO_MATCH",
  };
}
