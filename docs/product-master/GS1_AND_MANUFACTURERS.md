# GS1 India and manufacturer catalogues — onboarding playbook

The pilot ran on open data, which cannot supply the fields a marketplace needs to invoice and label a product: **GST rate, HSN code and MRP were missing on 100 % of products, only 14 of 2,180 had a manufacturer, and 8 of the 15 requested categories had real data.** These two sources are chosen to close that gap.

| | GS1 India | Manufacturer catalogues |
|---|---|---|
| What it is | The barcode authority: which brand owner holds a GTIN, plus the description and net content they registered | The brand's own product file — names, packs, specifications, tax, MRP |
| Best for | Identity (is this GTIN real, whose is it), brand owner, net content, classification (GPC) | Depth for one brand: specifications, ingredients, HSN/GST, MRP, images |
| Precedence | 12 (reliability 95) | **10** (reliability 95) — the highest of any source |
| Typical shape | A licensed export (CSV / Excel) or an API under a data agreement | An Excel workbook or CSV sent by the brand |
| Registry entry | `gs1_india` — `BLOCKED_NEEDS_AGREEMENT` | `brand_manufacturer_feeds` — `PLANNED` template; **one source per brand** |
| Status of the connector | **Built and tested**; mapping is a template to align to the real file | **Built and tested** (`.xlsx` and `.csv`) |
| What is missing | The licence, and a sample of the real export | The brand's permission, and its file |

**The connectors are ready; the data is not here yet.** Nothing can be collected from either source until an agreement exists — the platform enforces that (a source runs only when `ACTIVE` and enabled). Everything below is what to do to get there safely.

## GS1 India

### 1. Get the right to use the data

Confirm with GS1 India, in writing, before anything is loaded (service names and terms change — do not rely on this page for them):

- Which service delivers product records to you (membership benefit, a data-sharing agreement, a subscription) and in what form: **file export, or API with credentials**.
- May you **store** the records in your own database, **use them to populate a marketplace catalogue**, and **show them to shops and customers**?
- Any limits: number of records, refresh frequency, retention, derived data, attribution, fees.
- Whether an export may be **automated** (scheduled downloads) or must be manual. Never automate a login-protected web portal to get around this — that would be exactly the circumvention this platform forbids.

Record the answers in the registry entry's `legalBasis` (the licence name and agreement reference) — that text is shown on every source record's provenance.

### 2. Align the mapping to the real file

Ask for a **sample of about 100 rows** including a multipack and an item with dimensions. Then, with no database and no agreement needed yet:

```bash
npm run pmd:import-feed -- --check --source gs1_india --file gs1-sample.csv --category-map gs1-gpc.json
```

The check reports how many rows would load and the coverage of GTIN, brand, category, **MRP, GST, HSN, manufacturer**. Edit `GS1_MAPPING` in `src/server/pmd/sources/registry.ts` until the numbers are right and `INFO`/`WARNING` issues make sense. The shipped column names are a template for a typical GS1 export (`GTIN`, `Product Description`, `Brand Name`, `Brand Owner Name`, `Net Content` + `Net Content UoM`, `GPC Brick Code`, …); a **mapping key the platform does not know is an error with a suggestion**, so typos do not go unnoticed. Net content and unit codes combine with a template: `{Net Content} {Net Content UoM|unece}` turns `500` + `GRM` into `500 g`.

### 3. Map GS1's classification to yours

GS1 files products under GPC (Global Product Classification) bricks. Create a small JSON — GPC code (or title) → standard category code — for the bricks that appear in your data:

```json
{ "10000159": "grocery/staples/rice", "10000165": "dairy/ghee" }
```

(illustrative codes — use the ones in your file). Unmapped bricks stay `NULL` rather than a confident guess; the check tells you the share left unmapped. Put the finished table in the registry entry's `feed.categoryMap` so every run uses it. The GPC code and name are also kept on the product as specifications.

### 4. Turn it on

1. Set `status: "ACTIVE"` in the registry entry (a reviewed change) and put the agreement reference in `legalBasis`.
2. `npm run pmd:seed`, then enable the source: `UPDATE pmd.source SET enabled = true WHERE source_key = 'gs1_india';` (deliberate second key — see the data-source guide).
3. **Pilot first**, on the local database: `npm run pmd:import-feed -- --source gs1_india --file gs1-sample.csv --mode IMPORT`, then `npm run pmd:checks` and look at the review queue.
4. Only then a full file, `--mode INITIAL_FULL --full-snapshot` if the file lists everything GS1 holds for you (never for a partial file).

### What to expect

- **GS1 outranks open data and marketplaces** for name, brand owner, tax and net content; the values it replaces are kept and any disagreement between equally authoritative sources is recorded, not overwritten.
- Products open data already knew **by barcode are enriched, not duplicated** (an exact-GTIN match); the review queue only gains genuinely ambiguous pairs.
- **MRP arrives as the brand owner's offer with no selling price.** When a product is later promoted to the marketplace catalogue, a GS1 / manufacturer MRP is accepted but starts as *pending verification*.
- Barcodes that lost their leading zero in Excel are restored when unambiguous; the original text stays in the stored raw record.
- **No GS1 API adapter exists yet.** If GS1 India offers an API under your agreement, send its documentation: an adapter (extract / parse / sanitise, through the polite client) is a small addition, and the same mapping and precedence apply.

## Manufacturer catalogues

### 1. Ask for the file — and for permission

Ask each brand for its product catalogue as `.xlsx` or `.csv` **and for written permission to use it** in the Gokesari product master and marketplace catalogue (and separately for its images — the platform only links to images, never copies them). Useful columns to request:

| Essential | Valuable |
|---|---|
| Item code, barcode (EAN/UPC), product name, brand, pack size, category, MRP, GST %, HSN | Description, ingredients, shelf life, country of origin, marketed-by / manufacturer details, dimensions and weight, image URLs, variants (colour/size), FSSAI licence number |

### 2. Register one source per brand

Copy the template entry `brand_manufacturer_feeds` in `registry.ts`; key it `mfr_<brand>`:

```ts
{
  key: "mfr_sunrise_dairy",
  name: "Sunrise Dairy - product catalogue",
  kind: "BRAND_MANUFACTURER",
  accessMethod: "MANUFACTURER_FEED",
  status: "ACTIVE",            // only once the written permission exists; otherwise PLANNED
  legalBasis: "Catalogue workbook supplied by Sunrise Dairy Co-operative Ltd under <reference> for use in the Gokesari product master.",
  collectionFrequency: "monthly",
  parserKey: "tabular_feed",
  fieldMapping: { ...MANUFACTURER_CATALOGUE_MAPPING, brand: "=Sunrise Dairy" },
  feed: { format: "xlsx", sheet: "Catalogue", headerRow: 2, categoryMap: { "Toned Milk": "dairy/milk/toned-milk" } },
  notes: "Contact, agreement reference, refresh arrangement.",
}
```

`MANUFACTURER_CATALOGUE_MAPPING` is the template (`Item Code`, `Barcode (EAN)`, `Product Name`, `Brand`, `Marketed By`, `Pack Size`, `Category`, `GST %`, `HSN`, `MRP`, …). Change the column names to the brand's, use `=constant` for a fact the sheet never repeats, and `{template}` to join columns.

### 3. Check, pilot, load

```bash
npm run pmd:import-feed -- --check --source mfr_sunrise_dairy --file sunrise.xlsx      # no database
PMD_DATABASE_URL=… npm run pmd:import-feed -- --source mfr_sunrise_dairy --file sunrise.xlsx --mode IMPORT
```

Worked examples: [`examples/manufacturer-catalogue.sample.csv`](./examples/manufacturer-catalogue.sample.csv), [`examples/gs1-india.sample.csv`](./examples/gs1-india.sample.csv) with [`gs1-india.categories.json`](./examples/gs1-india.categories.json). Both are fictional and exercised by tests (the Excel path against a generated workbook).

### Things worth knowing

- Excel **numeric barcode cells** lose leading zeros; the importer restores an unambiguous UPC-A and leaves anything shorter alone.
- **Multiple sheets:** the first *visible* sheet is used unless `feed.sheet` / `--sheet` says otherwise. A **title block** above the headings needs `headerRow`.
- **Merged cells and multi-row headings** are not interpreted — ask the brand for a flat table, or flatten it once.
- **Updates:** a re-run of the same file is a no-op (unchanged records only touch `last_seen`); a changed MRP or name is applied by precedence and written to the change log. Use `fullSnapshot` only when the file lists the brand's whole range; then a product missing from a later file becomes `TEMPORARILY_UNAVAILABLE`, never `DISCONTINUED`.
- A manufacturer MRP is **not** a selling price. It is stored as the brand's offer (no price); shops still set their own.

## After the first real load — the checklist

- [ ] `npm run pmd:checks`: all 11 invariants pass.
- [ ] Coverage moved: compare GST / HSN / MRP / manufacturer percentages with the pilot's 0 % / 0 % / 0 % / 0.6 %.
- [ ] Review queue size is what you can staff (the pilot queued ~1 pair per 90 records).
- [ ] `brand-looks-like-company` did not grow — a brand file should improve brand/manufacturer hygiene, not worsen it.
- [ ] Spot-check ten products against the supplier's own sheet (name, pack, GST, MRP).
- [ ] The legal basis and agreement reference are in the registry entry.

## Limits of this release

The GS1 and manufacturer mappings are **templates validated against synthetic files** that follow the GS1 data model and typical catalogue layouts — not against a real GS1 India export or a real brand's workbook, which do not exist in this environment. Expect to adjust column names and the category map on first contact with real files; the `--check` mode exists for exactly that. Legacy `.xls` is unsupported; there is no GS1 API adapter yet.
