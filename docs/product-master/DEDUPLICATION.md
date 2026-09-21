# Deduplication and matching engine

Implemented in `src/server/pmd/match/score.ts` (pure, unit-tested) and `match/engine.ts` (candidate retrieval). Thresholds and weights live in `src/server/pmd/config.ts`.

## Principle

**One product = one master record**, while sellers, offers and prices stay separate. Names alone never merge two products, and nothing below the confidence threshold is merged automatically.

## Relationships the engine distinguishes

| Situation | What happens |
|---|---|
| Exactly the same product | Linked to one master (`EXACT_MATCH` / `HIGH_CONFIDENCE`) |
| Same product, different seller | One master, one more **offer** row |
| Different pack size | Separate master, same **family**; hard conflict `PACK_SIZE_DIFFERENT` |
| Different multipack (`2 × 500 g` vs `1 kg`) | Separate; `PACK_COUNT_DIFFERENT` (same total is not the same pack) |
| Different variant (colour, size, model, MPN, flavour word) | Separate; `COLOR_DIFFERENT`, `SIZE_DIFFERENT`, `MODEL_DIFFERENT`, … |
| Same brand or family, different product | Separate |
| Possibly the same (spelling variant, missing brand, extra word) | **New master + review item**, never merged |

## Candidate retrieval (blocking)

Only masters that share a strong signal are scored. Every query is index-backed:

1. **Identifier** — GTIN/ISBN (unique index).
2. **MPN** and **model**, scoped to the brand when known.
3. **Siblings** — same brand + identical core name (btree).
4. **Fuzzy** — same brand + trigram similarity on the core name (GIN, `pg_trgm`).
5. **No brand** — trigram on `search_text` with a stricter threshold.

## The four levels

| Level | Rule | Result |
|---|---|---|
| **L1** exact identifier | Same valid GTIN/ISBN and no contradicting fact (brand may be missing on one side) | `EXACT_MATCH`, score 100 |
| **L1** | Same MPN and same brand | `EXACT_MATCH`, 99 |
| **L2** strong | Same brand + same model, variants consistent | `HIGH_CONFIDENCE` ≥ 94 |
| **L3** structured | Same brand + **identical** core name + identical pack | `HIGH_CONFIDENCE` ≥ 94 |
| **L4** fuzzy | Weighted similarity (below), penalised for missing evidence | `POSSIBLE_MATCH` or lower — never auto-merged unless every cap is clear and the score reaches the threshold |

### L4 scoring

Weights (configurable): name 0.40 · brand 0.20 · model 0.10 · pack 0.15 · variant 0.10 · category 0.05.
`score = 100 × (Σ wᵢsᵢ / Σ wᵢ over available components) × (0.55 + 0.45 × coverage)` — a pair with little evidence cannot reach the merge threshold even if what it has is identical.
Name similarity is `0.6 × token-Dice (spelling-tolerant) + 0.4 × trigram similarity`, computed on the *core name* (brand and pack tokens removed).

Status bands (configurable): score ≥ 92 → `HIGH_CONFIDENCE`; ≥ 70 → `POSSIBLE_MATCH`; below → `DIFFERENT_PRODUCT`. `NEEDS_REVIEW` is assigned by rule, not by score: a GTIN collision, the same MPN under two brands, or near-identical names under a similar-but-not-equal brand.

## Hard conflicts (forbid a merge whatever the score)

`GTIN_DIFFERENT` · `BRAND_DIFFERENT` (unless the names are near-identical spellings) · `PACK_SIZE_DIFFERENT` · `PACK_COUNT_DIFFERENT` · `COLOR_DIFFERENT` · `SIZE_DIFFERENT` · `VARIANT_DIFFERENT` · `MODEL_DIFFERENT` · `MPN_DIFFERENT` · `DIMENSIONS_DIFFERENT`. A conflicted pair scores ≤ 40.

## Caps (never auto-merge on guesswork)

`BRAND_UNKNOWN` · `PACK_UNKNOWN` (for packaged goods) · `EXTRA_TOKENS` (one side has a distinguishing word: "Coca-Cola" vs "Coca-Cola Zero") · `DISTINCT_TOKENS` (each side has a word the other lacks: "butter" vs "cashew" → different products) · `COLOR_ONE_SIDED` / `SIZE_ONE_SIDED` · `CATEGORY_DIFFERENT` · `BRAND_SIMILAR` · `MODEL_SUFFIX_DIFFERS`. For an identifier-based rule (L2), one extra word ("5G") is not a cap.

Fuzzy token equality ("taaza"/"taza") is used to *score*, but the L3 rule requires **exact** core-name equality — because the same tolerance would also equate "green"/"greek" and "salted"/"malted", and those must not auto-merge.

## Identifier hygiene

Valid check digit required. In-store (`02x`, `04x`, `2xx`), coupon and serial ranges are stored but never used to match. Placeholder names ("Loading…", "1") are treated as no name.

## Decision policy

| Best candidate | Action |
|---|---|
| `EXACT_MATCH` or `HIGH_CONFIDENCE` ≥ auto-merge threshold (92), no hard conflict | **LINK** (an `AUTO_LINKED` audit row records score, rule, components) |
| Two candidates equally good (< 1 point apart) | **HOLD** — ambiguous, a person picks |
| GTIN collision (same GTIN, contradicting brand/pack) | **HOLD** — the GTIN is unique, so no second master can exist; the source record waits, unlinked |
| `POSSIBLE_MATCH` / `NEEDS_REVIEW` ≥ review floor (55) | **CREATE + QUEUE** — new master, pending review item |
| Otherwise | **CREATE** (joins a family if pack/variant siblings exist) |

## Review and merge

A person decides each queue item: **same product** (merge), **different**, or **same family**. A merge retires the *younger* master by pointer (`record_status = MERGED`, `merged_into_product_id`); sources, offers, the entire price history, identifiers and every source's specification move to the survivor; conflicts are re-resolved; the merge is written to `product_merge_log` and the change log. Nothing is deleted. A held (unlinked) record confirmed as the same product is attached and is enriched on its source's next run.

## Thresholds you can change

`autoMergeThreshold` (92), `possibleThreshold` (70), `reviewFloor` (55), `trigramThreshold` (0.35), `maxCandidates` (15), and the six weights. Invalid combinations (weights not summing to 1; thresholds out of order) are rejected at start-up.
