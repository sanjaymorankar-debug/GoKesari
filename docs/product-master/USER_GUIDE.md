# User guide

For the people who look after the product master: **operators** and **administrators**. Shop owners and customers do not use it — shops keep choosing products from the marketplace catalogue, which the master feeds.

## What you have

| You want to… | Use | Needs |
|---|---|---|
| See how healthy the data is | **Product Master** in the header → `/admin/product-master` | Operator / Admin |
| Decide whether two records are the same product | The **review queue** on that page | Operator / Admin (`pmd:review`) |
| Find a product | `GET /api/product-master/products/search?q=…` (there is no browse screen yet) | Operator / Admin |
| Put a product where shops can pick it | `POST /api/product-master/products/{id}/promote` (no button yet) | Operator / Admin (`pmd:promote`) |
| Check nothing is broken | `npm run pmd:checks` | Shell access |
| Get the Excel master | `npm run pmd:export` | Shell access |
| Load more data | [Data-source guide](./DATA_SOURCES.md) | Shell access; Admin for the API import |

> **What is not built yet:** a product browser/editor screen and a promote button. Today those go through the API (see the [API guide](./API.md)). The dashboard and the review queue are screens.

## Vocabulary

| Term | Meaning |
|---|---|
| **Master product** | One real-world product: *Amul Butter 500 g*. Has an id `GKS-PROD-000000123`. **It has no price.** |
| **Source** | Where a fact came from (Open Food Facts, a partner feed…). Every fact remembers its source |
| **Offer** | One seller's current price/stock for a product. The same butter at five shops = one master product, five offers |
| **Price history** | Every time an offer's price, MRP or stock changed, with the date |
| **Family** | Pack sizes and variants of one line (Amul Butter 100 g, 500 g). **Different products** that are grouped, never merged |
| **Conflict** | Two sources disagree about a fact. Both are kept; the more authoritative one is shown |
| **Quality score** | 0–100, how complete and trustworthy a record is |
| **Held record** | A source record that could not be placed automatically and waits for a person |

**Missing data is never zero.** In the app and API a missing value is *null*; in Excel a missing text is `NOT_AVAILABLE` and a missing number is blank. A `0` always means zero.

## The dashboard

`/admin/product-master` shows a snapshot refreshed after every collection run (its time is on the page; it is not live per request).

| Tile | What it counts | What to do when it is high |
|---|---|---|
| Total products | Active master records | — |
| New / Updated (last 7 days) | Masters created / changed recently | A run that created nothing when you expected more: check *Recent collection runs* |
| Average quality score | Mean of the 0–100 scores | See *Quality score* below |
| Duplicates merged | Masters retired into a survivor | — |
| **Possible duplicates**, **Awaiting manual review** | Pairs the matcher would not merge on its own | Work the queue below |
| **Conflicting specifications** | Facts where equally trustworthy sources disagree and a person must choose | Resolve at the source, or decide which source wins |
| **Missing GTIN / brand / manufacturer / category / MRP / GST / HSN** | Products lacking each | Usually a source gap — add a better source, or a category mapping. Not an error |
| **Import errors** | Records not loaded, and repaired/suspicious values | `pmd.import_error` (or the IMPORT_ERRORS sheet) lists each with its reason |
| Source records, Current seller offers, Price observations | Volumes | — |

Below the tiles: products by marketplace/source, by category and by brand, the review queue, and the last runs (source, mode, status, read / created / linked / queued / errors).

## Working the review queue

Each row is a pair: **the incoming record** (from a source) and **the existing master** it might be. It shows the score, the rule that produced it, and any *hard conflicts* (pack size, colour, model, brand, GTIN…).

Decide with the three buttons:

| Button | Choose it when | Effect |
|---|---|---|
| **Same product** | It is the same item, sold by another source or under another spelling | The younger master is retired into the older one. Sources, offers, the whole price history, identifiers and every source's specifications move to the survivor. Nothing is deleted; the merge is logged |
| **Different product** | It only looks similar | Recorded, so the pair is not raised again |
| **Same family** | Same product line, different pack size or variant | Both stay separate products, grouped in one family |

Rules of thumb:

* A **pack-size or colour hard conflict** almost always means *Different* or *Same family* — never *Same product*.
* A **GTIN collision** (two records claim the same barcode but disagree about brand or pack) is usually a wrong barcode at a source. The record is *held*, unlinked, until you decide.
* When unsure, choose **Different product**. A wrongly separated pair costs one extra row; a wrong merge mixes two products' prices.
* Decisions are attributed to you and audited.

## Finding a product

`GET /api/product-master/products/search?q=amul taaza 1 l` looks up, in order: exact identifiers (GTIN/EAN/UPC/ISBN, MPN, model, SKU), then all keywords across brand + name + variant + model, then fuzzy matches that forgive typos. Filters: `brand`, `category`, `manufacturer`, `status`, `minQuality`. `GET …/products/{id}` returns everything about one product: identifiers, every source's specifications (the preferred value is marked), sources, images, conflicts, the quality breakdown and any catalogue link.

## Getting a product to the shops

`POST /api/product-master/products/{id}/promote` copies a master into the marketplace catalogue so a shop owner can pick it.

* It must be **active**, have a **standard category**, and a **quality score of at least 40** (adjustable per call).
* If the catalogue already has that product (matched by GTIN in *any* written form), it is **adopted**, not duplicated.
* **No marketplace price is copied.** The shop sets its own price. An MRP is taken only from a manufacturer, GS1 or government source, and starts as *pending verification*.
* Every promotion is audited.

## Quality score

Six parts, each 0–100, weighted:

| Part | Weight | High when |
|---|---|---|
| Identifier | 25 % | A valid GTIN/ISBN scores 100; MPN + brand 70; only a model/SKU 40; only a code that failed its check digit 15; nothing 0 |
| Completeness | 25 % | Most of the fields that this *kind* of product should have are present |
| Source reliability | 15 % | The best source that speaks about it: manufacturer, GS1, government > licensed feed > marketplace > open data |
| Corroboration | 15 % | More independent sources know it (1 source 30, 2 → 65, 3 → 85, 4+ → 100) |
| Match confidence | 10 % | How sure we are that the records linked to it are one product (lower while a possible duplicate is queued against it) |
| Recency | 10 % | Seen in the last week 100, month 80, quarter 55, year 30, older 10 |

A part that cannot be *judged* (for example, no match confidence recorded) is left out and the rest are re-weighted — an unknown input never counts as zero. Scores are a triage tool, not a verdict; the *components* on the product record show why.

## Automated checks

```bash
PMD_DATABASE_URL=postgresql://… npm run pmd:checks
```

**Eleven invariants must be zero** — if any is not, stop and investigate (the Excel export refuses to run):

`unique-active-gtin` · `unique-master-id` · `gtin-check-digit` · `no-orphan-children` · `one-preferred-spec` · `sources-traceable` · `missing-is-null-not-zero` · `no-price-on-master` · `history-covers-offers` · `no-discontinued-by-pipeline` · `merged-have-target`

**Five stewardship queues** are work, not failures:

| Queue | Meaning | Action |
|---|---|---|
| `possible-duplicate-pairs` | Pending review items | Work the review queue |
| `same-name-different-master` | Two masters with the same brand, core name and pack that the matcher kept apart — almost always because their **barcodes differ** | Look at the two: often distinct SKUs a source titled identically (two fragrances of one hand wash), sometimes a duplicate entry with a wrong barcode. Merge only if it is the same item |
| `open-conflicts` | Equally trustworthy sources disagree | Decide, or fix the source |
| `held-source-records` | Records waiting for a person | Review queue |
| `brand-looks-like-company` | A "brand" that reads like a legal entity (HUL, "… Pvt Ltd") — a manufacturer filed as a brand | Add a brand alias / manufacturer link |

## The Excel master

```bash
PMD_DATABASE_URL=postgresql://… npm run pmd:export -- --label "PILOT - open data only"
```

Writes `GOKESARI_PRODUCT_MASTER.xlsx` (to `%LOCALAPPDATA%\GokesariPmd\out` unless `--out`). It is **read-only** to the database, refuses to run if an invariant fails, and splits into part files beyond ~50,000 products (a worksheet holds 1,048,576 rows; PostgreSQL is the store, Excel is for reading).

Thirteen sheets in fixed order — PRODUCT_MASTER, PRODUCT_SPECIFICATIONS, PRODUCT_SOURCE, PRODUCT_SELLER, PRODUCT_PRICE_HISTORY, BRAND_MASTER, MANUFACTURER_MASTER, CATEGORY_MASTER, CATEGORY_MAPPING, PRODUCT_ATTRIBUTE_CONFLICT, DATA_DICTIONARY, DATA_QUALITY, IMPORT_ERRORS — then **RUN_SUMMARY** (when, what scope, row counts, and the licence attribution). Every sheet has a frozen header, filters and an Excel table; there are no merged cells. Enumerated columns have drop-down validation; missing required cells are highlighted; prices show as rupees, percentages as percentages. Field meanings: [data dictionary](./DATA_DICTIONARY.md).

Prices are **not** on PRODUCT_MASTER (its `REFERENCE_*` columns are derived from current offers). Use PRODUCT_SELLER for who sells what at what price and PRODUCT_PRICE_HISTORY for how it changed. Do not join them back into one wide sheet — that is what makes the same product appear ten times.

**Licence:** the open-data sources are under the Open Database Licence. If you share the workbook outside the company, keep RUN_SUMMARY's attribution and the share-alike terms.

## Troubleshooting

| You see | Because | What to do |
|---|---|---|
| A product's status is **UNKNOWN** | No source has said whether it is in stock (open data never does) | Nothing — UNKNOWN is honest. It changes when a source reports stock |
| A product is **TEMPORARILY_UNAVAILABLE** | Every source that listed it, in a *complete* snapshot, stopped listing it | Normal. A product is never marked **DISCONTINUED** automatically — only a person or the manufacturer can |
| No price on a product | Open data rarely carries prices; Open Prices covers only what people photographed | Add a licensed/partner feed |
| Two pack sizes are separate products | By design | They share a family |
| The same product twice | The matcher was cautious (different spelling, missing brand) | Review queue, or *same-name-different-master* in the checks |
| A brand called "HUL" / "Unilever" | Crowdsourced data mixes brand and company | `brand-looks-like-company` list; add an alias |
| "The product master schema is not installed" | Migration `0015` has not been applied to this database | [Deployment guide](./DEPLOYMENT.md) |
| A source will not run | It is blocked, planned or disabled — by design | [Source register](./SOURCE_REGISTER.md) shows why and what would unblock it |
