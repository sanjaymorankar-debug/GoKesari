# Software Requirements Specification — Product Master Data Platform

| | |
|---|---|
| Related | [BRD](./BRD.md) · [PRD](./PRD.md) · [SAD](./SAD.md) · [Database design](./DATABASE_DESIGN.md) · [API](./API.md) |
| Conventions | "shall" = mandatory. **V** = verification: the automated test file(s) that prove it (all under `tests/`), or **M** for measurement/inspection. Status is as of the pilot |

## 1. Purpose and scope

Specifies the behaviour of the Product Master Data Platform: the `pmd` PostgreSQL schema, the pipeline that fills it, the API and screens that expose it, the export, and the tooling around them. Business intent is in the [BRD](./BRD.md); design is in the [SAD](./SAD.md).

## 2. Definitions

**Master product** — one real-world product. **Staged product** — a source record in the platform's common vocabulary. **Offer** — one seller's current price/stock for a product. **GTIN-14** — the canonical form of EAN-8/UPC-A/EAN-13/GTIN-14. **Hard conflict** — a fact (pack size, colour, model, brand, GTIN…) that forbids treating two records as one product.

## 3. Functional requirements

### 3.1 Sources and adapters

| ID | Requirement | V |
|---|---|---|
| FR-SRC-01 | The platform shall keep a register of sources with kind, access method, status, legal basis, licence, terms, robots policy, credentials *name*, frequency, rate limit, parser, field mapping and trust weights | `unit/pmd-*`, `integration/pmd-pipeline` (reference data) |
| FR-SRC-02 | The register shall contain every source named in the brief (21 marketplaces, GS1, FSSAI, GST, BIS, Legal Metrology, brand/manufacturer, distributors, open data…) each with a legal basis | `integration/pmd-pipeline`, `unit/pmd-docs` |
| FR-SRC-03 | A source shall run only if its status is `ACTIVE` and it is enabled; the database shall refuse `enabled` on a non-`ACTIVE` source | `integration/pmd-pipeline` |
| FR-SRC-04 | A new source shall be addable by an adapter implementing one interface (`extract`, `parse`, optional `sanitize`) and a registry entry, without changes to the core pipeline | `integration/pmd-pipeline`, `integration/pmd-feed` |
| FR-SRC-05 | A licensed/partner CSV feed shall be onboardable by a mapping file and a category map alone, with a no-database check mode | `unit/pmd-sources`, `integration/pmd-feed` |
| FR-SRC-06 | A row of a file feed that has no id or the wrong number of cells shall be recorded as an error, never dropped silently | `unit/pmd-sources`, `integration/pmd-feed` |
| FR-SRC-07 | An adapter declared `createsProducts: false` shall price or enrich known products only and shall reject, not create, an unmatched record | `integration/pmd-pipeline` |
| FR-SRC-08 | Adapters shall remove personal data (contributor identities, proof references) before anything is stored or logged — in the staged payload **and** in the excerpt kept with an error | `integration/pmd-privacy` |
| FR-SRC-09 | Reference data (sources, taxonomy, attributes, shipped mappings) shall be synced to the database only when its definitions differ from what the database last received; a sync shall not consume identity values; a steward's "disabled" source shall survive it | `integration/pmd-pipeline` (reference data) |
| FR-SRC-10 | A supplier catalogue in Excel (`.xlsx`) shall be readable by streaming, with sheet and heading-row selection, blank rows ignored, and dates/formulas/rich text/hyperlinks converted to text; it shall fall back to an in-memory read only when the streaming reader cannot handle the file layout | `unit/pmd-sources` |
| FR-SRC-11 | A feed mapping value shall be a column, a `=constant` or a `{template}` (with UN/ECE unit codes translated); a mapping key the platform does not know shall be rejected with the closest valid key | `unit/pmd-sources` |
| FR-SRC-12 | Leading zeros Excel strips from a numeric UPC-A shall be restored only when unambiguous (10-11 digits with a valid check digit once padded); shorter codes shall never be guessed | `unit/pmd-sources`, `integration/pmd-supplier-feeds` |
| FR-SRC-13 | GS1 and manufacturer data shall outrank marketplace and open data for name, tax and specifications, and arrive with brand owner, HSN, GST and MRP intact; the real `gs1_india` entry shall stay blocked until an agreement exists | `integration/pmd-supplier-feeds` |

### 3.2 Compliance of collection

| ID | Requirement | V |
|---|---|---|
| FR-LEG-01 | All HTTP collection shall go through one client that fetches and obeys `robots.txt`, **fails closed** when it cannot, and re-checks on every redirect | `unit/pmd-sources` |
| FR-LEG-02 | The client shall rate-limit per host, retry with backoff and jitter, honour `Retry-After`, cap download size and use an idle (not total) timeout for streams | `unit/pmd-sources` |
| FR-LEG-03 | The User-Agent shall identify the platform with a company contact; no personal address | M (inspection: `scripts/pmd/lib.ts`; overridable by `PMD_HTTP_USER_AGENT`) |
| FR-LEG-04 | The platform shall contain no CAPTCHA solving, authentication bypass, proxy rotation, header spoofing or paywall circumvention | M (code inspection; there is none) |
| FR-LEG-05 | Open-data exports shall carry the required licence attribution; images shall be referenced, never copied | `integration/pmd-export` |

### 3.3 Extract, parse, normalise

| ID | Requirement | V |
|---|---|---|
| FR-ETL-01 | The pipeline shall run extract → parse → normalise → match → validate → load per source, with modes PILOT, INITIAL_FULL, INCREMENTAL, IMPORT, BACKFILL, and log each run (counters, status, times) | `integration/pmd-pipeline` |
| FR-ETL-02 | Extraction shall stream; a run shall stop early at its limit (a 1.3 GB dump is never loaded) | `unit/pmd-sources`, M |
| FR-NRM-01 | Pack sizes shall normalise (`1 kg` = `1000 g` = `1,000 grams`), multipacks keep size and count, the original text is kept | `unit/pmd-normalize` |
| FR-NRM-02 | GTIN shall normalise to GTIN-14, verify the check digit, and mark restricted-circulation ranges unusable for matching; an invalid code shall be kept as a source code, never as identity | `unit/pmd-normalize`, `integration/pmd-pipeline` |
| FR-NRM-03 | Brand spellings (`Samsung`, `SAMSUNG`, `Samsung India`, `Samsung India Pvt. Ltd.`) shall resolve to one brand with every spelling kept as an alias | `unit/pmd-normalize`, `integration/pmd-pipeline` |
| FR-NRM-04 | GST, HSN and cess shall be validated (basis points; 4/6/8-digit HSN; legacy slabs flagged, not rejected) | `unit/pmd-normalize` |
| FR-NRM-05 | Source categories shall map to the standard 5-level taxonomy; unmapped shall be NULL, never guessed; manual mappings override shipped rules | `unit/pmd-taxonomy`, `integration/pmd-pipeline` |
| FR-NRM-06 | Missing values shall be NULL (never `0` or `''`); a placeholder name ("Loading…", "1") shall count as no name | `unit/pmd-normalize`, `integration/pmd-pipeline` |
| FR-NRM-07 | Normalisation shall never throw for a bad field; it shall return issues (ERROR / WARNING / INFO) | `unit/pmd-normalize` |

### 3.4 Matching and deduplication

| ID | Requirement | V |
|---|---|---|
| FR-MAT-01 | The engine shall implement four levels: exact identifier, strong (brand+model / MPN), structured (brand + identical core name + pack), fuzzy weighted similarity; score 0–100; statuses EXACT_MATCH, HIGH_CONFIDENCE, POSSIBLE_MATCH, DIFFERENT_PRODUCT, NEEDS_REVIEW | `unit/pmd-match` |
| FR-MAT-02 | Candidate retrieval shall be index-backed blocking (GTIN, MPN/model within brand, brand+name, trigram), never all-pairs | `integration/pmd-pipeline`, M (query plans) |
| FR-MAT-03 | Different pack sizes, pack counts, colours, sizes, variants, models, MPNs, brands (not spelling variants) or dimensions shall be hard conflicts that forbid a merge | `unit/pmd-match`, `integration/pmd-pipeline` |
| FR-MAT-04 | Nothing below the configurable threshold shall be merged automatically; thresholds and weights shall be configuration and validated | `unit/pmd-match` |
| FR-MAT-05 | A GTIN that contradicts brand or pack shall hold the record for a person; two equally good candidates shall hold the record | `unit/pmd-match`, `integration/pmd-pipeline` |
| FR-MAT-06 | Pack-size and variant siblings shall be grouped into a family without being merged | `integration/pmd-pipeline` |
| FR-MAT-07 | A person shall resolve a review item as same product, different product or same family; a merge shall retire the younger master by pointer, move sources, offers, price history, identifiers and specifications, and be logged; nothing is deleted | `integration/pmd-review-bridge` |
| FR-MAT-08 | A decided review item shall not be re-opened by later runs | `integration/pmd-review-bridge` |
| FR-MAT-09 | Concurrent workers shall not create two masters for one GTIN | `integration/pmd-pipeline` |

### 3.5 Master data, specifications, conflicts

| ID | Requirement | V |
|---|---|---|
| FR-MST-01 | Each master shall have a generated unique id `GKS-PROD-#########`; brands `GKS-BRND-…`, manufacturers `GKS-MFR-…` | `integration/pmd-pipeline` |
| FR-MST-02 | The master shall hold no price, MRP or discount | `integration/pmd-pipeline` (invariant `no-price-on-master`) |
| FR-MST-03 | Category-specific facts shall be stored per product × attribute × source (EAV), exactly one preferred per attribute, projected to master columns where defined | `integration/pmd-pipeline` |
| FR-MST-04 | When sources disagree the platform shall never overwrite silently: it shall record a conflict, prefer the higher-precedence source (manufacturer > GS1 > government > licensed > distributor > internal > marketplace > open data), and leave equal-authority disagreements OPEN without flipping the value in force | `integration/pmd-pipeline` |
| FR-MST-05 | Every attribute shall be traceable to its source, collection method and date | `integration/pmd-pipeline` |
| FR-MST-06 | Every field change shall be versioned in a change log | `integration/pmd-pipeline` |

### 3.6 Offers, price history, status

| ID | Requirement | V |
|---|---|---|
| FR-OFF-01 | Each (listing, seller) shall be one offer; the same product from many sellers shall be one master with many offers | `integration/pmd-pipeline`, `integration/pmd-feed` |
| FR-OFF-02 | Price history shall be append-only: a row on first sighting and on every change of price, MRP or stock; a later identical observation shall write nothing | `integration/pmd-pipeline` |
| FR-OFF-03 | An older observation than the current one shall back-fill history but never roll the current price back | `integration/pmd-pipeline` |
| FR-OFF-04 | A price 5× away from the recent level shall be flagged (kept, warned) | `integration/pmd-pipeline` |
| FR-OFF-05 | Product status shall derive from offers; `DISCONTINUED` shall never be set by the pipeline; a product absent from one marketplace shall not be discontinued | `integration/pmd-pipeline` |
| FR-OFF-06 | Only a *complete* snapshot may conclude "not seen", and then only mark offers not current | `integration/pmd-pipeline` |
| FR-OFF-07 | An unchanged record shall cost only a `last_seen` update (incremental fast path) | `integration/pmd-pipeline`, M |

### 3.7 Quality and governance

| ID | Requirement | V |
|---|---|---|
| FR-QLT-01 | Each product shall carry a 0–100 score from six weighted components (identifier, source reliability, corroboration, completeness, match confidence, recency); components that cannot be judged shall be excluded and the rest renormalised, never counted as zero | `unit/pmd-quality` |
| FR-QLT-02 | Eleven invariants shall be checkable by SQL and five stewardship queues listed | `integration/pmd-review-bridge` |
| FR-QLT-03 | Errors shall be logged per record with stage, severity, code and (sanitised) excerpt; the run shall continue past them; a run with errors is `PARTIAL` | `integration/pmd-pipeline` |
| FR-GOV-01 | Human actions (promote, review decision, import) shall be audited with actor and role; a promotion's audit row shall be written in the same transaction as its effect | `integration/pmd-review-bridge`, `integration/pmd-api` |
| FR-GOV-02 | Access shall be by the four permissions `pmd:view`, `pmd:review`, `pmd:promote`, `pmd:import` in the application's role matrix | `integration/pmd-api` |

### 3.8 Catalogue integration

| ID | Requirement | V |
|---|---|---|
| FR-CAT-01 | A master shall be promotable to the marketplace catalogue if ACTIVE, categorised and above a quality floor; an existing catalogue product with the same GTIN in any written form (UPC-A/EAN-13/GTIN-14) shall be adopted, not duplicated | `integration/pmd-review-bridge` |
| FR-CAT-02 | Marketplace prices shall never be copied; an MRP shall be taken only from a manufacturer, GS1 or government source and start as pending verification | `integration/pmd-review-bridge` |
| FR-CAT-03 | The link between master and catalogue shall be one table; nothing in `public` shall be altered | `integration/pmd-review-bridge`, M |

### 3.9 API, dashboard, export

| ID | Requirement | V |
|---|---|---|
| FR-API-01 | The API shall provide the endpoints in [API.md](./API.md) with permission checks, strict input validation and the application's error envelope; identifiers in URLs shall be master ids | `integration/pmd-api`, `unit/pmd-docs` (contract vs routes) |
| FR-API-02 | Search shall support exact identifiers, keywords and typo-tolerant fuzzy search and shall be safe against SQL/tsquery injection | `integration/pmd-api` |
| FR-API-03 | List endpoints shall be keyset-paginated | `integration/pmd-api`, M |
| FR-DSH-01 | A dashboard shall show totals, new/updated, duplicates, review load, conflicts, missing-field counts, errors, volumes, breakdowns and recent runs from a snapshot refreshed after each run; it shall degrade to a clear message when the schema is absent | `integration/pmd-dashboard` |
| FR-EXP-01 | The Excel export shall produce the 13 specified sheets in order (+ RUN_SUMMARY), with frozen panes, filters, Excel tables, data validation, formats, conditional highlighting and no merged cells | `integration/pmd-export` |
| FR-EXP-02 | Missing text shall show `NOT_AVAILABLE`, missing numbers/dates blank, never `0`; money as rupees; percentages as percentages | `integration/pmd-export` |
| FR-EXP-03 | The export shall refuse to run against a database that violates an invariant, and split into range-partitioned files beyond a worksheet's capacity | `integration/pmd-export` |
| FR-EXP-04 | The DATA_DICTIONARY sheet and documentation shall be generated from the same model as the export | `integration/pmd-export`, `unit/pmd-docs` |

## 4. Non-functional requirements

| ID | Requirement | Target | Result |
|---|---|---|---|
| NFR-PERF-01 | Identifier lookup at 1M masters | < 5 ms | **0.1 ms** median (M) |
| NFR-PERF-02 | Candidate retrieval for matching at 1M | < 50 ms | **8 ms** median |
| NFR-PERF-03 | Keyword / fuzzy search over 1M | < 100 ms | **20 ms / 16 ms** |
| NFR-PERF-04 | List page cost independent of depth | constant | **2.3 ms at page 1, 2.2 ms at page 900,000** |
| NFR-PERF-05 | Every hot query uses an index | no sequential scans | **All four EXPLAINed plans index-backed** |
| NFR-PERF-06 | Loader throughput | Sufficient for a 10M initial load in days | **Partly.** ~190 new records/s on a local DB with 1M present (~15 h single-worker for 10M), ~7,300/s unchanged; price-change path not yet batched. Measurements in the [pilot report](./PILOT_REPORT.md) |
| NFR-SCL-01 | Design shall scale to 10M products | index-backed access, partitioned history | Designed; **measured to 1M reads only** |
| NFR-SEC-01 | Least privilege: four permissions; shops and customers have no access | — | Verified (`integration/pmd-api`) |
| NFR-SEC-02 | CLI tools shall not write to an application database by accident | explicit target, local-only by default | `PMD_DATABASE_URL` required; non-local refused without `PMD_ALLOW_REMOTE=1`; `.env` not loaded |
| NFR-SEC-03 | No secrets or personal data stored | — | Credentials by name only; contributor data stripped |
| NFR-REL-01 | A bad record shall not stop a run or poison other records | per-record transaction | Verified (`integration/pmd-pipeline`) |
| NFR-REL-02 | Transient database errors shall be retried | backoff | Implemented (deadlock, serialisation, connection) |
| NFR-REL-03 | Reruns shall be idempotent | second run of the same data changes nothing | Verified (`integration/pmd-pipeline`, `integration/pmd-feed`) |
| NFR-MNT-01 | Thresholds, weights, slabs and trust are configuration, not code constants | one config module | `src/server/pmd/config.ts`, validated |
| NFR-MNT-02 | Generated documents shall not drift | test fails on drift | `unit/pmd-docs` (data dictionary, source register, OpenAPI vs routes) |
| NFR-CMP-01 | Migration shall be additive and reversible | rollback script | `0015` + `rollback-0015.sql` |
| NFR-OBS-01 | Runs, errors, changes and merges shall be queryable | tables | `ingestion_run`, `import_error`, `product_change_log`, `product_merge_log` |

## 5. External interfaces

* **HTTP API** — [API.md](./API.md), [openapi.yaml](./openapi.yaml).
* **CLI** — `npm run pmd:seed | pmd:fetch-sample | pmd:fetch-prices | pmd:pilot | pmd:import-feed | pmd:checks | pmd:export | pmd:bench | pmd:docs | pmd:test`; see the [deployment guide](./DEPLOYMENT.md).
* **Files** — CSV feeds in; `.xlsx` out.
* **Database** — PostgreSQL 16 with `pg_trgm`; schema `pmd`; one foreign-key bridge to `public.products` and `public.users`.

## 6. Traceability to the brief's acceptance criteria

| # | Criterion (brief §34) | Requirements | Evidence |
|---|---|---|---|
| 1 | Collected from multiple permitted sources | FR-SRC-01..06, FR-LEG-* | [Pilot report](./PILOT_REPORT.md) |
| 2 | Normalised into a common schema | FR-NRM-* | " |
| 3 | Duplicates detected | FR-MAT-01..06 | " |
| 4 | Same product, different sellers, not duplicated | FR-OFF-01, FR-MAT-01 | " |
| 5 | Different pack sizes separate | FR-MAT-03, FR-MAT-06 | " |
| 6 | Different variants separate | FR-MAT-03 | " |
| 7 | Specifications preserved | FR-MST-03 | " |
| 8 | Source information preserved | FR-MST-05, FR-ETL-01 | " |
| 9 | Price history preserved | FR-OFF-02, FR-OFF-03 | " |
| 10 | Attributes traceable to source | FR-MST-05, FR-MST-06 | " |
| 11 | Missing data identified | FR-NRM-06, FR-QLT-01, FR-EXP-02 | " |
| 12 | Conflicting data flagged | FR-MST-04 | " |
| 13 | Excel export works | FR-EXP-* | " |
| 14 | PostgreSQL storage works | all | " |
| 15 | Incremental updates work | FR-OFF-02, FR-OFF-06, FR-OFF-07 | " |
| 16 | New sources through adapters | FR-SRC-04, FR-SRC-05 | " |
| 17 | No prohibited access mechanisms | FR-LEG-* | " |
| 18 | Scales beyond the initial dataset | NFR-SCL-01, NFR-PERF-* | " |

## 7. Test suite coverage of the brief's list (deliverable J)

| Brief's area | Where |
|---|---|
| Product collection | `integration/pmd-pipeline` (*collection → master creation*), `integration/pmd-feed`, adapters in `unit/pmd-sources` |
| Parsing | `unit/pmd-sources` (delimited parser, CSV feed), `unit/pmd-normalize` (quantities, identifiers) |
| Normalization | `unit/pmd-normalize` |
| Deduplication | `integration/pmd-pipeline` (*deduplication across sources and sellers*), `integration/pmd-review-bridge` |
| Matching | `unit/pmd-match` |
| Category mapping | `unit/pmd-taxonomy`, `integration/pmd-pipeline` |
| Data validation | `unit/pmd-normalize` (`normalizeStaged`), `integration/pmd-api` (*validate and match*) |
| Excel export | `integration/pmd-export` |
| Incremental updates | `integration/pmd-pipeline` (*incremental updates and price history*, *availability and status*) |
| Error handling | `integration/pmd-pipeline` (*errors, warnings and data-collection log*), HTTP failures in `unit/pmd-sources` |

Run them with `npm run pmd:test` (needs a local `TEST_DATABASE_URL`; never point it at a hosted database).
