# Data-source configuration guide

How the platform knows what it may collect, from where, and how a new source is added. The live list of every source — with status and legal basis — is the generated [source register](./SOURCE_REGISTER.md).

## The rule

**Collect only what you have a right to collect, by a route that respects the source.** In order of preference:

1. Official APIs
2. Licensed feeds
3. Public datasets
4. Public product pages *where the terms and robots.txt permit it*
5. Manufacturer data
6. Government / public databases

The platform never: solves or bypasses CAPTCHA, evades anti-bot systems, works around authentication or paywalls, ignores `robots.txt`, spoofs its identity, rotates proxies, collects personal customer data, or copies content a source prohibits copying. This is enforced in code, not left to discipline:

| Guard | Where |
|---|---|
| A source must be `ACTIVE` **and** enabled to run; the runner refuses anything else | `pipeline/run.ts` (`SourceNotEnabledError`) |
| The database refuses `enabled = true` on a non-`ACTIVE` source | `source_enabled_requires_active` CHECK |
| Every HTTP request goes through one client: robots.txt fetched and **fail-closed**, re-checked on every redirect, per-host rate limit, identifying User-Agent with a company contact, bounded downloads | `sources/http.ts`, `sources/robots.ts` |
| Personal data (contributor usernames, proof references) removed **before** anything is stored or logged | `SourceAdapter.sanitize()` |
| Credentials are named, never stored | `pmd.source.auth_env_var` holds the *name* of an environment variable |
| A legal basis is mandatory for **every** source, including blocked ones | `SourceDefinition.legalBasis` |

Marketplaces (Amazon India, Flipkart, Myntra, Meesho, …) are registered as **`BLOCKED_NEEDS_AGREEMENT`** with the lawful route written next to each — an affiliate / product-advertising API, a seller or partner feed, a data agreement. They cannot run until a person changes the entry to `ACTIVE` after that agreement exists.

## Status lifecycle

```
PLANNED ──(route identified, connector not built)
BLOCKED_NEEDS_AGREEMENT ──(agreement / licence / official API obtained + connector)──► ACTIVE
BLOCKED_TECHNICAL ──(no automated lawful route today: CAPTCHA, login, no API)
ACTIVE ──(problem, or terms changed)──► DISABLED
```

Only `ACTIVE` **and enabled** runs — two separate keys:

1. **`status`** comes from the registry (`registry.ts`). Changing it is a code change, reviewed like any other; the next run (or `npm run pmd:seed`) writes it to `pmd.source` because the fingerprint of the definitions no longer matches. A hand edit of a registry-owned column is left alone until the definitions next change (or `pmd:seed -- --force`).
2. **`enabled`** belongs to the database. A brand-new `ACTIVE` source starts enabled; a source that *becomes* `ACTIVE` later starts **disabled** and stays so until a steward turns it on deliberately (`UPDATE pmd.source SET enabled = true WHERE source_key = '…'`). A steward's "disabled" survives every re-seed, and a source that stops being `ACTIVE` is disabled automatically.

## What describes a source

`src/server/pmd/sources/registry.ts` — one `SourceDefinition` per source (stored in `pmd.source`):

| Field | Meaning |
|---|---|
| `key`, `name` | Stable identifier and display name |
| `kind` | `MARKETPLACE`, `BRAND_MANUFACTURER`, `GOVERNMENT`, `OPEN_DATA`, `LICENSED_FEED`, `GS1`, `DISTRIBUTOR`, `INTERNAL` — sets default trust |
| `accessMethod` | `OFFICIAL_API`, `LICENSED_FEED`, `OPEN_DATASET`, `MANUFACTURER_FEED`, `PERMITTED_PUBLIC_PAGE`, `INTERNAL_DB`, `MANUAL_UPLOAD`, `NONE` |
| `status` | See above |
| `legalBasis` | **Why we may collect this** — required, in words, for every source |
| `licenseName`, `termsUrl`, `robotsPolicy` | Licence, terms page, what robots.txt says |
| `apiEndpoint`, `authEnvVar` | Endpoint; name of the env var with credentials |
| `collectionFrequency`, `rateLimitPerMin`, `retryMax` | Cadence and politeness |
| `parserKey`, `fieldMapping` | Which parser, and the column mapping for feeds |
| `reliability`, `specPrecedence` | Trust (0–100) and who wins a specification conflict (**lower wins**) |
| `notes` | Anything a successor needs |

### Default trust by kind

| Kind | Reliability | Spec precedence |
|---|---|---|
| Brand / manufacturer | 95 | 10 |
| GS1 | 95 | 12 |
| Government | 90 | 15 |
| Licensed feed | 80 | 30 |
| Distributor | 70 | 40 |
| Internal | 65 | 45 |
| Marketplace | 65 | 50 |
| Open data | 55 | 60 |

Reliability feeds the quality score; precedence decides which source's value the master shows when two disagree (the loser is kept, and a conflict is recorded). Override per source in its registry entry.

## Adding a source, step by step

1. **Establish the right.** Get the agreement, licence, API key or written permission. Note where the terms are. If you cannot, register it `BLOCKED_NEEDS_AGREEMENT` with the route written down, and stop.
2. **Add the registry entry** (`registry.ts`). For a partner file feed, copy `partner_feed` — *one source per partner* — and put the agreement reference in `notes`. Status `ACTIVE` only if the right exists today.
3. **Choose the adapter.**
   * **A file feed (CSV)** needs no code — write a mapping (below).
   * **An API or dataset** needs an adapter (below).
4. **Check without a database:** `npm run pmd:import-feed -- --check …` reports how many rows would load, GTIN/brand/category/price coverage, and the first problems.
5. **Pilot on a local database** (`local-pg.ps1`, see the [deployment guide](./DEPLOYMENT.md)). Read `pmd.import_error`, then the dashboard and `npm run pmd:checks`.
6. **Extend the category map** until the important categories are covered; unmapped categories stay `NULL` (the platform never guesses).
7. **Enable and schedule** — `npm run pmd:seed`; if the source was not new, enable it (`UPDATE pmd.source SET enabled = true …`, see above); then run the command from your scheduler.

## A CSV feed, by configuration

Files: [`examples/partner-feed.sample.csv`](./examples/partner-feed.sample.csv), [`.mapping.json`](./examples/partner-feed.mapping.json), [`.categories.json`](./examples/partner-feed.categories.json). An automated test runs this exact example, so it cannot drift from the code.

**Mapping** — platform field → feed column (anything unmapped is ignored):

```json
{
  "sourceProductId": "SKU",          "name": "Title",        "brand": "Brand",
  "gtin": "EAN",                     "quantityText": "Pack", "categories": "Category",
  "gstRate": "GST",                  "hsnCode": "HSN",       "images": "Image URL",
  "offer.price": "Sale Price",       "offer.mrp": "MRP",     "offer.sellerName": "Seller",
  "offer.stock": "Stock",
  "attribute.ram_gb": "RAM (GB)",    "attribute.storage_gb": "Storage (GB)"
}
```

| Mapping key | Meaning |
|---|---|
| `sourceProductId` | **Required.** The feed's own id for the row (SKU, ASIN, …) |
| `name`, `brand`, `manufacturer`, `description`, `shortDescription`, `model`, `mpn`, `sku`, `productCode`, `variant`, `color`, `size`, `material`, `shape`, `countryOfOrigin`, `availability`, `sourceUrl` | Scalars |
| `gtin`, `isbn` | Identifiers (EAN-8/13, UPC-A, GTIN-14, ISBN-10/13; check digits are verified) |
| `quantityText`, `netWeightText`, `grossWeightText`, `dimensionsText` | Free text like `1 kg`, `6 x 200 ml`, `10 x 5 x 3 cm` — parsed to a canonical form |
| `gstRate`, `hsnCode`, `cess` | Tax: `18%`, `0.18` and `18` are all 18 %; HSN must be 4/6/8 digits |
| `categories`, `images`, `keywords` | Lists — one cell, values separated by `|` (`--list-separator` to change) |
| `offer.price`, `offer.mrp`, `offer.sellerId`, `offer.sellerName`, `offer.sellerLocation`, `offer.sellerRating`, `offer.currency`, `offer.stock`, `offer.deliveryInformation`, `offer.url`, `offer.collectedAt`, `offer.taxInclusive` | The seller's offer. Prices like `Rs. 1,299.00` are understood; `offer.stock` text ("in stock", "only 3 left", "sold out") is normalised |
| `attribute.<key>` | A category-specific fact, keyed by the attribute registry (`ram_gb`, `net_weight_g`, `ingredients`, …; 84 are defined, with type, unit and group). A key the registry does not know is **registered automatically** in group `OTHER`, with a type inferred from its value — so a misspelt key creates a new attribute instead of failing. Review `pmd.attribute_definition` after onboarding a feed |

**What a mapping value can be.** Besides a plain column name:

| Form | Example | Meaning |
|---|---|---|
| `=constant` | `"brand": "=Sunrise Dairy"` | The same text on every row - for a fact the file never repeats (one brand per catalogue) |
| `{template}` | `"quantityText": "{Net Content} {UoM\|unece}"` | Cells joined into text. `\|unece` turns a UN/ECE unit code (`GRM`, `KGM`, `MLT`, `LTR`, `H87`, `CMT`, ...) into `g`, `kg`, `ml`, `l`, `pcs`, `cm`. A template whose cells are all empty is missing, not `" "` |

A mapping key the platform does not know (`"gtn"`) is an **error**, with the closest valid key suggested - a typo must not silently import nothing.

**Excel files.** `--file catalogue.xlsx` is read by streaming (memory stays flat for large catalogues); `--sheet <name|number>` picks the sheet (default: the first *visible* one) and `--header-row <n>` says where the headings are when a title block sits above them. Blank padding rows are ignored; dates, formulas, rich text and hyperlinks become plain text. Legacy `.xls` is not supported - ask the supplier for `.xlsx` or `.csv`. If the streaming reader cannot cope with a file's internal layout it falls back to reading the workbook in memory (slower, heavier, still correct).

**Numeric barcodes.** Excel stores a barcode column as numbers and drops leading zeros. A 10-11 digit value that becomes a valid 12-digit UPC-A when zero-padded is restored (the original stays in the stored raw record); anything shorter is left alone rather than guessed. `--no-restore-zeros` turns it off.

**Registry `feed` settings.** A registry entry may carry `feed: { format, sheet, headerRow, delimiter, listSeparator, categoryMap, restoreGtinZeros, fullSnapshot }` so a supplier's file is read the same way every time; command-line flags override it.

**Checking before an agreement is final.** `--check` reads a file and writes nothing, so it works for a source that is still `BLOCKED_NEEDS_AGREEMENT` or `PLANNED` - that is how a mapping is prepared while the paperwork is signed. A real load needs an `ACTIVE`, enabled source. The check reports how many rows would load and the coverage of GTIN, brand, category, price, **MRP, GST, HSN and manufacturer** - the fields open data could not supply.

**Category map** — the feed's exact category text → a standard category code. Codes are the slug paths in the [taxonomy](./DATA_DICTIONARY.md#8-category_master) (`GET /api/product-master/categories` lists them). The tool refuses a map that names a code that does not exist.

**Every row is accounted for.** A row with no id, or with the wrong number of cells, is not loaded — it is written to `IMPORT_ERRORS` (`NO_SOURCE_ID`, `ROW_WIDTH`) with its file row number. A feed never loses a row silently.

**`--full-snapshot`** declares that the file lists everything the source sells. Only then (with `--mode INCREMENTAL` or `INITIAL_FULL`) may the run conclude that an unlisted offer is *no longer current* — which sets the product `TEMPORARILY_UNAVAILABLE`, **never** `DISCONTINUED`. A partial file must not use it.

## An API or dataset adapter, by code

Implement `SourceAdapter` (`sources/adapter.ts`). It is the only place source specifics may live; the engine never learns a field name or URL shape.

```ts
interface SourceAdapter {
  definition: SourceDefinition;          // the registry entry
  collectionMethod: string;              // recorded on every source row, e.g. "OFFICIAL_API"
  createsProducts: boolean;              // may it create masters, or only enrich / price existing ones?
  supportsFullSnapshot: boolean;         // does one run list everything?
  categoryMapper: CategoryMapper;        // source category -> standard category
  extract(ctx): AsyncIterable<RawRecord>;    // STREAM it; never buffer a whole source
  parse(raw): StagedProduct;                 // pure; throw ParseError for an unusable record
  sanitize?(payload): payload;               // strip personal data BEFORE storage
}
```

Rules for adapters:

* All HTTP through `PoliteHttpClient` (robots, rate limit, retry, byte cap, identifying User-Agent). Never `fetch` directly.
* `extract` is an async generator that honours `ctx.limit` and stops early; huge dumps are streamed and the transfer aborted when the limit is reached.
* `parse` is pure and never touches the database. Use `ParseError(code, message, "WARNING")` for a record skipped on purpose (policy), `"ERROR"` for one that should have worked.
* Drop what you must not keep. The Open Prices adapter, for example, never stores contributor usernames or proof images, skips per-kilogram prices (not a pack price), and treats a shelf price as **not** proof of stock.
* Write the mapping table (source field → platform field) in [SOURCE_FIELD_MAPPING.md](./SOURCE_FIELD_MAPPING.md) and add tests: the fixtures in `tests/unit/pmd-sources.test.ts` and `tests/integration/pmd-pipeline.test.ts` show the pattern.
* Respect the licence in what you *export*: open-data sources are ODbL — the Excel export carries the required attribution on `RUN_SUMMARY`, and images are linked, never copied.

## Sources that exist today

| Working adapter | Route | Licence |
|---|---|---|
| Open Food Facts, Open Beauty Facts, Open Products Facts, Open Pet Food Facts | The projects' official **bulk data dumps** (their robots.txt allows `/data/`; the live `/api` is disallowed for generic crawlers, so it is never used) | ODbL 1.0 (database), DbCL 1.0 (contents); images CC BY-SA, linked only |
| Open Prices | The project's public REST API (empty robots.txt), polite client | ODbL / DbCL |
| Mapped CSV / Excel feed (`partner_feed`, `manual_import`, `gs1_india`, `brand_manufacturer_feeds`) | A file you obtained lawfully | Yours to state in the registry entry |

The two chosen as the first non-food sources - **GS1 India** and **manufacturer catalogues** - have connectors ready and are covered in [GS1_AND_MANUFACTURERS.md](./GS1_AND_MANUFACTURERS.md).

Everything else in the [register](./SOURCE_REGISTER.md) is blocked or planned, with its route.
