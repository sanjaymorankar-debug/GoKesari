# Pilot report — validation before scale-up

*Steps 1–8 of the brief's sequence are complete. Step 9 — large-scale ingestion — has **not** been started and needs an explicit go-ahead.*

## Verdict

| | |
|---|---|
| **Works, on real data** | Collection from five permitted open-data sources → normalisation → matching → master → offers and price history → quality scoring → Excel export, end to end, with all eleven integrity invariants holding |
| **Proven at scale (reads)** | Every hot query stays index-backed and fast at **1,000,000** masters (identifier lookup 0.1 ms, candidate retrieval 8 ms, search ~20 ms, paging 2 ms at any depth) |
| **Not proven / not ready** | **The write path at scale.** The loader manages ~60 new records/s on a local database and is round-trip-bound over a network — a 10-million-product load is not practical until it is reworked or co-located |
| **Limited by data, not by software** | Only food, beauty and household items have real data. Mobiles, computers, apparel, automotive and tools need licensed / partner / manufacturer feeds. GST, HSN and MRP are absent from every open-data record |
| **Recommendation** | Go on to a **controlled next step** — one licensed feed for a non-food category, plus the loader work below — **not** to large-scale ingestion yet. Details in *Recommended before scale-up* |

## 1. What was run, and where

| | |
|---|---|
| Database | PostgreSQL 16 on the developer machine, a **throwaway cluster** (`scripts/pmd/local-pg.ps1`, port 54329, outside the repository). **Nothing was written to any hosted or shared database** |
| Data | Real, lawfully collected open data. Synthetic fixtures were used only by automated tests and by the scale benchmark, and are labelled as such |
| Code | Migration `0015`, the `pmd` library, API, dashboard, scripts — all uncommitted on branch `feature/product-master-platform` |
| Date | Samples retrieved 2026-09-19 |

## 2. Sources used and on what basis

| Source | Route | Basis | Rows |
|---|---|---|---|
| Open Food Facts | Official bulk CSV dump, streamed, filtered to India; the transfer aborted at the row limit (229 MB read of a 1.3 GB file; 910,196 rows scanned to find 1,000 Indian products) | ODbL 1.0 / DbCL 1.0; robots.txt allows `/data/` | 1,000 |
| Open Beauty Facts | Official dump (62,230 rows scanned) | same | 1,000 |
| Open Products Facts | Official dump (41,133 scanned — whole India set) | same | 620 |
| Open Pet Food Facts | Official dump (15,136 scanned — whole India set) | same | 86 |
| Open Prices | Public REST API, polite client (robots.txt empty). All 395 INR observations the API reported at retrieval | ODbL 1.0 | 394 read |

The live product API of these projects is **disallowed** for generic crawlers by their robots.txt, so it is never used — only the sanctioned dumps. Contributor usernames and proof images are removed before storage (verified by tests). No marketplace was touched: none has an agreed route.

## 3. Results

### 3.1 The five runs

| Source | Read | Created | Linked | Unchanged | Offers | Price changes | Queued | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| open_food_facts | 1,000 | 664 | 3 | – | – | – | 14 | 333 |
| open_beauty_facts | 1,000 | 704 | 0 | – | – | – | 3 | 296 |
| open_products_facts | 620 | 451 | 0 | – | – | – | 2 | 169 |
| open_pet_food_facts | 86 | 52 | 0 | – | – | – | 0 | 34 |
| open_prices | 394 | 309 | 36 | 23 | 367 | 7 | 5 | 23 |
| **Total** | **3,100** | **2,180** | **39** | | **367** | **7** | **24** | **855** |

Every run ended `PARTIAL` (some records rejected, none fatal) — as designed. Each took a few seconds on the local database. The pilot was run twice — once before and once after the defect described in §8 was fixed, on a database rebuilt from scratch — and produced **identical** results, so it is reproducible.

### 3.2 What is in the database

| | |
|---|---:|
| Master products (all ACTIVE) | **2,180** |
| Source records | 2,222 (2,144 masters seen by one source, **36 by two**) |
| Brands / spellings kept as aliases | 876 / 884 |
| Manufacturers | **14** |
| Identifiers | 2,224 (1,807 EAN-13 + 55 EAN-8 + 1 GTIN-14 valid GTINs; 44 ISBN-13; 44 in-store barcodes; **273 codes with a wrong check digit, kept as source codes**) |
| Specification rows (per source) | 3,070 across 81 defined attributes |
| Images (URLs only) | 2,469 |
| Offers / price-history rows | 352 (192 stores) / 359 (352 first sightings + **7 real price changes**), 2023-11-23 → 2026-09-15 |
| Product families | 53, covering 113 masters (pack-size / variant siblings, kept separate) |
| Raw records staged (sanitised) | 2,283 |
| Conflicts | 0 (see §4.5) |

### 3.3 Data completeness (real)

| Field | Products | Share |
|---|---:|---:|
| Valid GTIN | 1,863 | 85 % |
| Brand | 1,536 | 70 % |
| Standard category | 957 | **44 %** |
| Manufacturer | 14 | **0.6 %** |
| GST rate / HSN / MRP | **0** | **0 %** |

Quality score (0–100): mean **60.8**, range 32.8 – 77.5. 1,805 products score 60–80, 215 score 40–60, 160 score 20–40. Nothing scores above 80 because no source here is a manufacturer, GS1 or government feed and nothing carries tax or MRP — which is the honest answer, not a defect.

Category depth reached: level 1 – 94 products, level 2 – 277, level 3 – 545, level 4 – 41.

## 4. What the real data taught us

1. **28 % of open-data rows have no usable product name** — 855 of 3,100 (a third of the food rows): 816 rejected as `NO_NAME`, plus 39 with no name and no known product to attach to. They are logged, not invented.
2. **Barcodes are unreliable.** Roughly a fifth of Open Food Facts codes are 8-digit; many fail their check digit (280 warnings) and are kept only as *source codes*, never as identity. Crowd-sourced GTINs are also sometimes wrong for the product — three records claimed a barcode already held by a product with a different brand or pack and were **held for a person** rather than merged.
3. **Brand ≠ company.** Contributors type sentences into the brand field: *"Axe is sold by Unilever"*, *"Brooke Bond is sold by Hindustan Unilever Ltd. (HUL)"*, *"Denver is sold by Vanesa Care Pvt. Ltd"*, *"COMPANY NAME:- PAPER MASTERS"*, plus bare company names (*"HUL"*, *"KRBL limited"*). The `brand-looks-like-company` check found **25** such brands. This is why only 14 manufacturers exist. A simple rule — split *"<brand> is sold by <company>"* into brand + manufacturer — would fix a recurring pattern; it is on the recommended list, deliberately **not** applied here so the pilot shows the raw problem.
4. **Category coverage is limited by tags, not by the mapper.** 56 % of products carry no category tag that maps to the taxonomy. Unmapped stays NULL rather than a confident wrong category.
5. **No real conflicts.** The five sources barely overlap on specifications (Open Prices carries none), so the conflict logic — proven by tests with synthetic fixtures — never fired on real data. This is a limit of the pilot, not evidence about the logic.
6. **Crowd-sourced prices can contradict each other.** Open Prices holds observations for one store on the same day that disagree. The platform never lets an older observation replace a newer one and flags a price five times away from the recent level, but it cannot tell which shelf label was right — only a second source can.
7. **Status stays UNKNOWN.** No open source says whether an item is in stock (a shelf price does not prove it), so all 2,180 products are `UNKNOWN` with basis `NO_OFFERS` (1,835) or `NO_STOCK_SIGNAL` (345). Correct, and unhelpful for shoppers until a stock-bearing source exists.

## 5. Deduplication on real data

| Outcome | Count |
|---|---:|
| Linked automatically by identical GTIN (Open Prices ↔ Open Food Facts) — `EXACT_MATCH` | **36** |
| Linked automatically, high confidence (rule L3: same brand, identical name, identical pack — e.g. *Pringles 165 g*) | 3 |
| New master created and a possible duplicate queued for a person | 20 source records (21 candidate pairs) |
| Held: a GTIN collision that contradicts brand or pack | 3 |
| A similar-looking candidate was found and judged a *different product* → new master | 278 source records |
| Pack-size / variant siblings grouped in families (kept as separate products) | 113 masters in 53 families |
| **Pending review, in total** | **24 candidate pairs (1.1 % of masters)** |

What the queue holds: 20 fuzzy matches — in the highest-scoring dozen, almost all *identical names* (*"Eggs"*, *"maggi"* / *"Maggi"*, *"Surf Excel"*) where the pack, or the brand, is unknown on one side; 1 structured match with a **different category** (*More Fresh whole wheat bread*); 3 GTIN collisions. Nothing in the queue was merged automatically — the cautious behaviour the brief asks for. Its price is workload: at this rate a 10-million-product master would raise on the order of **100,000** review items, which is a staffing decision to make *before* scale-up (and a reason to tune with evidence).

Three pairs share brand, name and pack yet are separate masters, and appear on the `same-name-different-master` list for a person to judge: two because their **barcodes differ** (*Ready to Mix Hand Wash 9 g*, *LACTO CALAMINE 30 ml* — the matcher correctly keeps different barcodes apart), and one because the two records file under different categories (*More Fresh whole-wheat bread 400 g*, which is also in the review queue).

## 6. Automated checks

`npm run pmd:checks` on the pilot database:

```
PASS  unique-active-gtin · unique-master-id · gtin-check-digit · no-orphan-children · one-preferred-spec
PASS  sources-traceable · missing-is-null-not-zero · no-price-on-master · history-covers-offers
PASS  no-discontinued-by-pipeline · merged-have-target                       (11 / 11 invariants, 0 violations)
QUEUE possible-duplicate-pairs 24 · same-name-different-master 3 · open-conflicts 0
QUEUE held-source-records 3 · brand-looks-like-company 25
```

## 7. Excel export

`GOKESARI_PRODUCT_MASTER.xlsx` (≈1.4 MB), generated from the pilot database by `npm run pmd:export`; it refuses to run when an invariant fails.

| Sheet | Rows | | Sheet | Rows |
|---|---:|---|---|---:|
| PRODUCT_MASTER | 2,180 | | CATEGORY_MASTER | 410 |
| PRODUCT_SPECIFICATIONS | 3,070 | | CATEGORY_MAPPING | 1,045 |
| PRODUCT_SOURCE | 2,222 | | PRODUCT_ATTRIBUTE_CONFLICT | 0 |
| PRODUCT_SELLER | 352 | | DATA_DICTIONARY | 221 |
| PRODUCT_PRICE_HISTORY | 359 | | DATA_QUALITY | 2,180 |
| BRAND_MASTER | 876 | | IMPORT_ERRORS | 1,156 |
| MANUFACTURER_MASTER | 14 | | RUN_SUMMARY (extra) | 41 |

Verified by reading the file back: 14 sheets in the specified order, one Excel table per sheet, frozen header and leading columns, **no merged cells**, ODbL attribution on RUN_SUMMARY. **Not verified:** opening it in desktop Excel — the checks read the file with the same library that wrote it, so a rendering quirk specific to Excel would not have been caught. Open it once and look.

The structure the brief recommends — Product Master + Specifications + Seller Offers + Price History + Sources — is followed exactly: prices appear only on PRODUCT_SELLER and PRODUCT_PRICE_HISTORY, so one product is never repeated once per seller.

## Scale benchmark: 1,000,000 synthetic masters

`scripts/pmd/bench.ts` on a throwaway database, same laptop. **Synthetic data proves index behaviour and throughput; it says nothing about data quality.** One million rows were inserted with all indexes present (161.7 s), then measured (median of repeated runs).

| Operation | Median | Plan |
|---|---:|---|
| GTIN lookup | 0.1 ms | index (unique) |
| Brand-scoped trigram candidate retrieval | 8.3 ms | bitmap on GIN |
| Sibling lookup (brand + identical name) | 0.2 ms | index |
| Keyword search over all 1M | 19.6 ms | GIN full-text |
| Fuzzy search over all 1M | 15.6 ms | GIN trigram |
| List page 1 / page at 900,000 (keyset) | 2.3 / 2.2 ms | primary key |
| Dashboard snapshot refresh | 5.4 s | full aggregates, run after a batch |

Table 289 MB + indexes 487 MB (a floor for real data; see the [database design](./DATABASE_DESIGN.md#scale)).

### Throughput, and what it means for 10 million

The real pipeline, with the 1M master present (3,000 records each):

| Run | Rate | SQL statements per record |
|---|---:|---:|
| New records (match + create + offer + history) | **62 /s** | 39 |
| Same records again (unchanged shortcut) | 340 /s | 14 |
| Price change on all (history rows) | 144 /s | 22 |
| One dry-run match, worst case (no brand → trigram on the whole master) | 119 ms | – |

Statement counts were measured from the server log. The benchmark was run before the reference-sync fix in §8; that fix removes a *fixed* cost per run (~1,600 statements, ≈0.3 s locally) and does not change the per-record figures. Reading it:

* **Single worker, local database:** 10 M new records ≈ **45 hours**; a 10 M daily re-scan of unchanged records ≈ 8 hours. Parallel workers should help (advisory locks are per brand) but **parallel scaling was not measured**.
* **Over a network it is worse.** 39 sequential round trips at, say, 20 ms each is ≈ 0.8 s per new record — about **one record per second per connection**. Run from a laptop against a hosted database, a 10 M load would take months. Workers must sit next to the database (sub-millisecond round trips) or the loader must change.
* **Why:** each record is its own transaction with a per-brand lock — chosen deliberately so one bad record can never poison another and two workers can never mint one GTIN twice. Correct, but chatty.
* **Cheap fixes identified, none implemented yet:** fold the per-attribute "preferred" updates (2 statements per specification) into one; combine the lock and the similarity-threshold setting into one round trip; pipeline independent statements inside a transaction; and — for the initial load — a **bulk path**: `COPY` into an unlogged staging table, set-based exact-GTIN matching and insertion, and only the residue through the per-record matcher.

## 8. Tests

One local PostgreSQL 16, the whole repository suite in a single run: **39 files, 603 tests, all passing** — the application's existing 26 files / 296 tests (unchanged, still green with the `pmd` schema present) plus the new **13 files / 307 tests**.

| New suite | Files | Tests | Covers |
|---|---:|---:|---|
| Unit | 6 | 180 | Normalisation (70), matching (37), sources / HTTP / robots / CSV feed (43), taxonomy and category mapping (17), quality score (7), generated-document drift and link checks (6) |
| Integration (real PostgreSQL) | 7 | 127 | Pipeline: collection, dedup, incremental, status, conflicts, errors, governance, queue, reference data (52) · API and permissions (28) · review queue, catalogue bridge and automated checks (18) · Excel export (14) · CSV feed onboarding (6) · dashboard (5) · privacy (4) |

Every area in the brief's test list — collection, parsing, normalisation, deduplication, matching, category mapping, validation, Excel export, incremental updates, error handling — has tests; the map is in [SRS §7](./SRS.md#7-test-suite-coverage-of-the-briefs-list-deliverable-j). Type-check (`tsc --noEmit`) is clean; ESLint reports **0 errors** (two warnings remain in an existing file, `src/app/api/shop-products/[id]/route.ts`, that this work did not touch). `npm run pmd:test` runs just the new suites.

### A defect the full run found — and what changed

Running the **whole** suite (the application's existing tests plus the new ones) against one local database, after many earlier runs, failed with `nextval: reached maximum value of sequence "source_source_id_seq" (32767)`. The cause was in the platform, not the tests:

* `ensureReferenceData()` runs at the start of **every** ingestion run (and every call of the import API). It re-upserted 41 sources, 410 categories, 81 attributes and ~1,045 category mappings — about **1,600 statements each time**.
* `INSERT … ON CONFLICT DO UPDATE` evaluates the identity default before it notices the conflict, so each call **consumed 41 values of a `smallint` sequence** even though every row already existed. After about 800 runs no run — and no import — could start. In production that is a matter of months of daily runs.
* Separately, ~1,600 statements per call would take 30+ seconds over a network, enough to time out `POST /products/import` against a hosted database.

Fixed by (1) storing a fingerprint of the reference definitions in a new one-row table, `pmd.reference_state`, and syncing only when it differs — **2 statements** when nothing changed (measured: 2 ms, against 309 ms locally for the full sync); (2) `UPDATE`-ing rows that exist and inserting only genuinely new ones, so a re-sync consumes no identity values. Regression tests assert that repeated syncs leave the sequences untouched, that an unchanged database is not rewritten, and that a steward's "disabled" source survives a re-sync. Migration `0015` was edited in place (it had not been applied anywhere shared) and the local databases were rebuilt from scratch, which also proves the migration applies cleanly from empty.

The same lesson applies to any future `INSERT … ON CONFLICT` on an identity column: the per-record product, offer and source upserts use `bigint` identities, where the effect is only gaps in the numbering, but it is worth knowing.

## 9. The brief's 18 acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Products collected from multiple permitted sources | **Met** for open data and file feeds; marketplaces **pending agreements** | 5 real sources + a config-only feed adapter; 41 sources registered, 26 blocked with their route written down |
| 2 | Normalised into a common schema | **Met** | 2,180 masters from 5 differently-shaped sources; unit tests on every rule |
| 3 | Duplicates detected | **Met** | 36 exact cross-source links, 3 high-confidence links, 24 queued for review |
| 4 | Same product, different sellers, not duplicated | **Met** | 352 offers on 345 masters across 192 stores; feed test: one master, two sellers |
| 5 | Different pack sizes stay separate | **Met** | Hard conflict in unit tests; 53 families / 113 masters on real data |
| 6 | Different variants stay separate | **Met** | Colour/model/size/variant conflicts in unit and integration tests; on real data, same-titled products with different barcodes (e.g. two hand-wash fragrances) are kept apart |
| 7 | Specifications preserved | **Met** | 3,070 rows, per source, typed and unit-normalised |
| 8 | Source information preserved | **Met** | Method, dates, match status/score/rule on every source row; sanitised raw payload kept |
| 9 | Price history preserved | **Met** at pilot scale | 359 rows incl. 7 real changes. Real history exists only for the open-prices source |
| 10 | Attributes traceable to source | **Met** | Specification per source, `field_sources`, change log |
| 11 | Missing data clearly identified | **Met** | NULL / `NOT_AVAILABLE`, per-product missing list, dashboard tiles; GST/HSN/MRP shown as 100 % missing |
| 12 | Conflicting data flagged | **Met in logic and tests; not exercised by real data** | Synthetic multi-source fixtures; 0 conflicts in the pilot |
| 13 | Excel export works | **Met**, with the caveat in §7 | 14-sheet workbook regenerated and read back; not opened in desktop Excel |
| 14 | PostgreSQL storage works | **Met** on local PostgreSQL 16 | Not yet applied to a hosted database |
| 15 | Incremental updates work | **Met** | Unchanged shortcut, price changes, older-observation back-fill, "not seen" only from complete snapshots; measured |
| 16 | New sources through adapters | **Met** | Adapter interface; a CSV feed onboarded by mapping alone (under test) |
| 17 | No prohibited access mechanisms | **Met** | Registry gate + database constraint; robots.txt fail-closed; no circumvention code exists |
| 18 | Scales beyond the initial dataset | **Partly** | Reads measured to 1M and index-backed; **write path not ready for 10M** |

## 10. Category coverage against the 15 requested

| Depth of real data | Categories |
|---|---|
| **Populated** (≥ 20 products) | Grocery (171) · Food (211) · Beverages (61) · Dairy (31) · Home & Kitchen (28) · Beauty (75) · Personal Care (233) · Stationery (21) |
| **Token** (< 20) | Electronics (18, of which Mobiles 4 and Computers 2) · Apparel (5) · Toys (1) |
| **None** | Automotive · Tools |

So 8 of 15 are covered, 5 barely, 2 not at all. No lawful open source exists for the rest; that gap closes only with licensed, partner or manufacturer data. Three categories the brief did not list were also populated by the open data: Health & Wellness (48), Books (37) and Pet Supplies (17).

## 11. Known limitations

* **Not verified:** a production build (`next build` — CI runs it; the repository drive has ~80 MB free, so it could not be run here; type-check and lint are clean), rendering the dashboard in a browser (same reason; the page is verified by rendering its component tree in tests), and opening the workbook in desktop Excel (Excel is installed, but its automation interface is not registered on this machine, so it could not be driven from a script). Do these once.
* Not applied to Neon or any hosted database.
* The 373 products already in the marketplace catalogue are **not** linked to master records: they have no barcodes to match on, and the `gokesari_catalogue` source that would import them is registered as planned, not built. New promotions adopt an existing catalogue product by GTIN, so this only matters for the generic legacy rows.
* **Not built:** product browser/detail/edit screens, a promote button, a scheduler/worker, alerting.
* The API's brief-listed `/offers` and `/price-history` are nested under a product (documented).
* Attribute keys unknown to the registry are **auto-registered** in group `OTHER`; a misspelt key in a feed creates a new attribute instead of failing.
* `enabled` on a source is changed with one SQL statement — deliberate friction, but no screen for it yet.
* An existing app helper (`normalizeGtin`, `src/server/services/product-master.ts`) does not zero-pad, so a UPC-A and its EAN-13 form of one item are not unique-index-equal in the *catalogue*. The bridge compensates by matching all written forms; the underlying gap is out of this scope and is reported here.
* The two remaining lint warnings are in an existing file this work did not touch.

## 12. Recommended before scale-up

In order. The first four are prerequisites for step 9; the rest can run in parallel.

1. **Decide the first lawful non-food source** (a partner/affiliate feed, distributor list or manufacturer catalogue; GS1 India for barcodes and brand owners) and onboard it with the feed tool. This is the single biggest lever on coverage, tax data and MRP.
2. **Rework or co-locate the loader.** Cut statements per record, pipeline where independent, add the bulk initial-load path, and **measure parallel workers** — then re-run the benchmark against a staging database in the same region.
3. **Apply `0015` to a hosted staging branch** and run `npm run pmd:test` there.
4. **Staff the review queue** and decide the target queue rate; tune thresholds with evidence from step 1's data.
5. Add the *"<brand> is sold by <company>"* rule and a maintained brand-alias table; re-run this pilot to show the improvement.
6. Source GST/HSN: the CBIC HSN master and category-level defaults (registered as `cbic_gst_hsn`, planned) — without them no product can be invoiced from the master alone.
7. Product browser + promote button + source enable screen; a scheduler and alerting on `pmd:checks`.
8. A short visual pass of the dashboard and the workbook.

## 13. Reproduce

```powershell
# local database, once
./scripts/pmd/local-pg.ps1 init
$env:DATABASE_URL = 'postgresql://pmd_admin@127.0.0.1:54329/gokesari_pmd'
npm run db:migrate                                   # applies 0000..0015 to that database only

# real data, politely fetched (needs network), then the pilot
foreach ($v in 'food','beauty','products','petfood') { npm run pmd:fetch-sample -- --variant $v --limit 1000 }
npm run pmd:fetch-prices
$env:PMD_DATABASE_URL = $env:DATABASE_URL
npm run pmd:pilot -- --reset
npm run pmd:checks
npm run pmd:export

# scale benchmark, on its own throwaway database (create and migrate it first)
$env:PMD_DATABASE_URL = 'postgresql://pmd_admin@127.0.0.1:54329/gokesari_pmd_bench'
npm run pmd:bench -- --products 1000000 --records 3000
```

Open data changes daily, so counts will differ from this report's on a re-run; the shape of the findings will not.
