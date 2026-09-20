/**
 * Source category -> standard category.
 *
 * Two rule kinds, in this order:
 *   1. TAG rules   exact match on a normalised source category ("en:milks" -> dairy/milk).
 *                  When several tags of one product map, the deepest standard
 *                  category wins: "en:beverages" is less informative than "en:teas".
 *   2. KEYWORD rules  a regex over the product name, used only when no tag mapped.
 *
 * The result carries a confidence so weak keyword guesses are never mistaken for
 * a verified mapping, and unmapped products fall to "uncategorised/unmapped"
 * rather than being forced into a wrong branch.
 */
import { normalizeText } from "../normalize/text";
import { getCategoryByCode } from "./categories";

export interface CategoryMatch {
  code: string;
  confidence: number;
  matchedOn: string;
  via: "TAG" | "KEYWORD";
}

export interface CategoryRules {
  /** source key -> { normalised source category -> standard category code } */
  tags: Record<string, string>;
  keywords: ReadonlyArray<readonly [RegExp, string]>;
}

export interface CategoryMapper {
  map(categories: readonly string[], productName: string): CategoryMatch | null;
}

/** "en:extra-virgin-olive-oils" -> "extra virgin olive oils". */
export function normalizeSourceCategory(raw: string): string {
  return normalizeText(raw.replace(/^[a-z]{2}:/i, ""));
}

const TAG_CONFIDENCE = 90;
const KEYWORD_CONFIDENCE = 55;

export function createCategoryMapper(rules: CategoryRules): CategoryMapper {
  const tagIndex = new Map<string, string>();
  for (const [k, v] of Object.entries(rules.tags)) tagIndex.set(normalizeSourceCategory(k), v);

  return {
    map(categories, productName) {
      let best: CategoryMatch | null = null;
      let bestLevel = 0;
      for (const raw of categories) {
        const key = normalizeSourceCategory(raw);
        const code = tagIndex.get(key);
        if (!code) continue;
        const level = getCategoryByCode(code)?.level ?? 0;
        if (level > bestLevel) {
          bestLevel = level;
          best = { code, confidence: TAG_CONFIDENCE, matchedOn: key, via: "TAG" };
        }
      }
      if (best) return best;

      const name = normalizeText(productName);
      for (const [re, code] of rules.keywords) {
        if (re.test(name)) return { code, confidence: KEYWORD_CONFIDENCE, matchedOn: re.source, via: "KEYWORD" };
      }
      return null;
    },
  };
}

/** Combines mappers; the first one that returns a match wins. */
export function chainMappers(...mappers: CategoryMapper[]): CategoryMapper {
  return {
    map(categories, name) {
      for (const m of mappers) {
        const r = m.map(categories, name);
        if (r) return r;
      }
      return null;
    },
  };
}

export const NULL_MAPPER: CategoryMapper = { map: () => null };
