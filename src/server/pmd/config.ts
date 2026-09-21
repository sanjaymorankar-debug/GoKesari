/**
 * Product Master Data Platform - tunables.
 *
 * Everything a data steward might reasonably want to change lives here, not in
 * the algorithms: match thresholds, scoring weights, source-kind defaults,
 * GST slabs, quality weights. `resolveConfig()` merges overrides (CLI flags,
 * tests) over the defaults, so no algorithm ever reads a magic number.
 */
import type { SourceKind } from "./types";

export interface MatchConfig {
  /** Auto-link only at or above this score (and never with a hard conflict). 0-100. */
  autoMergeThreshold: number;
  /** At or above this, a pair is a POSSIBLE_MATCH (queued for review, never merged). */
  possibleThreshold: number;
  /** Candidates scoring below this are not even recorded in the review queue. */
  reviewFloor: number;
  /** pg_trgm similarity used to retrieve fuzzy candidates from the database. */
  trigramThreshold: number;
  /** Max candidates scored per incoming record. */
  maxCandidates: number;
  /** Fuzzy-score weights (must sum to 1). Identifier evidence is handled by rules, not weights. */
  weights: {
    name: number;
    brand: number;
    model: number;
    pack: number;
    variant: number;
    category: number;
  };
}

export interface QualityConfig {
  /** Weights must sum to 1. */
  weights: {
    identifier: number;
    sourceReliability: number;
    corroboration: number;
    completeness: number;
    matchConfidence: number;
    recency: number;
  };
  /** [max age in days, score 0-100], ascending; older than the last band gets `staleScore`. */
  recencyBands: ReadonlyArray<readonly [number, number]>;
  staleScore: number;
  /** distinct corroborating sources -> score */
  corroboration: ReadonlyArray<readonly [number, number]>;
}

export interface PmdConfig {
  match: MatchConfig;
  quality: QualityConfig;
  /** Records processed per database transaction. Bounds memory and lock time. */
  batchSize: number;
  /** Bounded parallelism when a source supports it. */
  concurrency: number;
}

export const DEFAULT_CONFIG: PmdConfig = {
  match: {
    autoMergeThreshold: 92,
    possibleThreshold: 70,
    reviewFloor: 55,
    trigramThreshold: 0.35,
    maxCandidates: 15,
    weights: { name: 0.4, brand: 0.2, model: 0.1, pack: 0.15, variant: 0.1, category: 0.05 },
  },
  quality: {
    weights: {
      identifier: 0.25,
      sourceReliability: 0.15,
      corroboration: 0.15,
      completeness: 0.25,
      matchConfidence: 0.1,
      recency: 0.1,
    },
    recencyBands: [
      [7, 100],
      [30, 80],
      [90, 55],
      [365, 30],
    ],
    staleScore: 10,
    corroboration: [
      [1, 30],
      [2, 65],
      [3, 85],
      [4, 100],
    ],
  },
  batchSize: 500,
  concurrency: 1,
};

/** Recursive partial so a caller can override a single weight without restating the tree. */
export type PmdConfigOverrides = {
  [K in keyof PmdConfig]?: PmdConfig[K] extends object ? Partial<PmdConfig[K]> : PmdConfig[K];
} & { match?: Partial<MatchConfig> };

export function resolveConfig(overrides: PmdConfigOverrides = {}): PmdConfig {
  const merged: PmdConfig = {
    ...DEFAULT_CONFIG,
    ...(overrides as Partial<PmdConfig>),
    match: {
      ...DEFAULT_CONFIG.match,
      ...overrides.match,
      weights: { ...DEFAULT_CONFIG.match.weights, ...overrides.match?.weights },
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      ...(overrides.quality as Partial<QualityConfig> | undefined),
      weights: {
        ...DEFAULT_CONFIG.quality.weights,
        ...(overrides.quality as Partial<QualityConfig> | undefined)?.weights,
      },
    },
  };
  assertConfig(merged);
  return merged;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function assertConfig(c: PmdConfig): void {
  const mw = sum(Object.values(c.match.weights));
  if (Math.abs(mw - 1) > 1e-6) throw new Error(`match.weights must sum to 1 (got ${mw})`);
  const qw = sum(Object.values(c.quality.weights));
  if (Math.abs(qw - 1) > 1e-6) throw new Error(`quality.weights must sum to 1 (got ${qw})`);
  const { autoMergeThreshold: a, possibleThreshold: p, reviewFloor: r } = c.match;
  if (!(0 <= r && r <= p && p <= a && a <= 100)) {
    throw new Error("match thresholds must satisfy 0 <= reviewFloor <= possibleThreshold <= autoMergeThreshold <= 100");
  }
  if (c.batchSize < 1) throw new Error("batchSize must be >= 1");
}

/* ------------------------------------------------------------------ sources */

/**
 * Default trust by source kind. Reliability feeds the quality score; specPrecedence
 * decides who wins when sources disagree on a technical specification (lower wins).
 * Per-source overrides live on the source row / registry entry.
 */
export const SOURCE_KIND_DEFAULTS: Record<SourceKind, { reliability: number; specPrecedence: number }> = {
  BRAND_MANUFACTURER: { reliability: 95, specPrecedence: 10 },
  GS1: { reliability: 95, specPrecedence: 12 },
  GOVERNMENT: { reliability: 90, specPrecedence: 15 },
  LICENSED_FEED: { reliability: 80, specPrecedence: 30 },
  DISTRIBUTOR: { reliability: 70, specPrecedence: 40 },
  INTERNAL: { reliability: 65, specPrecedence: 45 },
  MARKETPLACE: { reliability: 65, specPrecedence: 50 },
  OPEN_DATA: { reliability: 55, specPrecedence: 60 },
};

/* --------------------------------------------------------------------- GST */

/**
 * GST rate slabs, in basis points. CURRENT slabs follow the September-2025
 * rationalisation (5% / 18% standard, 40% for demerit goods, plus the special
 * low rates). LEGACY slabs (12%, 28%) still appear in older source data and are
 * accepted but flagged, not rejected. Keep this table data-driven: rates change.
 */
export const GST_SLABS_BP: Record<"CURRENT" | "LEGACY", readonly number[]> = {
  CURRENT: [0, 25, 100, 150, 300, 500, 1800, 4000],
  LEGACY: [1200, 2800],
};

/** Highest HSN chapter for goods; 98/99 are service/SAC territory. */
export const HSN_MAX_GOODS_CHAPTER = 97;
