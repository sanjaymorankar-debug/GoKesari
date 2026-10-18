# Product data sources — GS1 India, manufacturers, Open Food Facts

*batch-2026-10, WS-D — F9.1.2 (PMD-002) and F9.1.4 (PMD-006 / PMD-007). Written 18 Oct 2026.*

GoKesari's product master (`pmd` schema, see [product-master/README.md](./product-master/README.md)) can now be
fed from three sources through one thin `ProductDataSource` interface
(`src/server/pmd/data-sources/`), which wraps the existing pipeline `SourceAdapter` — nothing in the pipeline changed.
Every import lands in **staging** (`pmd.product_master` records not yet promoted), is **de-duplicated by GTIN-14**
(the existing identifier normalisation and check-digit validation, then the match engine), and reaches the
marketplace catalogue only when a person presses **Promote**.

| Source | How it reaches GoKesari | Switch (Admin → Settings) | Default | Status today |
|---|---|---|---|---|
| Manufacturer self-upload (primary) | `/manufacturer` portal: CSV / Excel template upload; or `POST /api/pmd/v1/manufacturer/products` with an API key | `pmdSources.manufacturerPortalEnabled` | on | Ready. An admin creates the manufacturer account at `/admin/product-browser/manufacturers` |
| GS1 India DataKart | Barcode look-up at `/admin/product-browser/sources` (`POST /api/pmd/sources/lookup`) | `pmdSources.gs1Enabled` | **off** | **Mock** until a subscription / API agreement is signed and `GS1_DATAKART_BASE_URL` + `GS1_DATAKART_API_KEY` are set |
| Open Food Facts | Barcode look-up for packaged food (same screen) | `pmdSources.openFoodFactsEnabled` | **off** | Ready; attribution stored with every record |

---

## 1. GS1 India — how to get data access

### What GS1 India offers

* **DataKart (base).** GS1 India's product-data repository. Base access is **included with the GS1 India barcode
  subscription** — a brand owner that holds GS1 India barcodes can list and view its own products there. It is a
  web service for the brand owner, not an API for a third party like GoKesari.
* **DataKart Premium.** The **real-time / automated data-exchange** service. It is a separate subscription:
  a **one-time registration fee (by annual turnover)** plus a **1-year or 3-year subscription fee, with 18% GST**
  on top, and the applicant **must already be a GS1 India subscriber**.
  Sources: [DataKart Premium service (PDF)](https://www.gs1india.org/wp-content/uploads/DataKart-Premium-Service-new.pdf),
  [DataKart Premium page](https://gs1india.org/datakart/datakart-premium).
* **GS1 India Solution Provider.** A third party (a marketplace or software company such as GoKesari) gets
  **API access as a registered GS1 India Solution Provider, under an agreement** with GS1 India. Product data is
  delivered **through a secured API in XML or JSON**, and **only for products whose brand owners have not
  restricted sharing**. **Integration is at the provider's own cost.**
  Source: [Terms & Conditions for registering as a GS1 India Solution Provider (PDF)](https://www.gs1india.org/wp-content/themes/gs1/assets/images/Terms-Conditions-for-Registering-as-GS1-India-Solution-Provider.pdf).

### Cost

GS1 India publishes **no API price list**. DataKart Premium's fees depend on turnover (registration) and term
(1 or 3 years), plus 18% GST; the Solution Provider route is priced in the agreement. **Contact GS1 India for a
quote** (gs1india.org → Contact / DataKart). Budget separately for our own integration work (the API is at our cost).

### Licence terms to expect (from the documents above)

* Data is for the purpose stated in the agreement; redistribution beyond it needs GS1 India's consent.
* Brand owners can restrict sharing; those GTINs will simply not be returned (our importer treats them as "not found").
* GS1 can audit use and end access under the agreement; keep the API key secret and rotate it if exposed.
* GTIN prefixes and check digits are public knowledge — GoKesari validates them without GS1 data.

### Steps for the owner

1. **Decide the route.** For automated look-ups by GoKesari for any brand: **GS1 India Solution Provider**.
   (DataKart Premium fits a brand owner automating its *own* data.)
2. **Apply** to GS1 India as a Solution Provider (company details, GST, PAN, intended use: "marketplace catalogue
   enrichment for retail shops"); sign the agreement; pay the fees quoted.
3. **Receive** the API base URL, credentials and the API specification (attribute names, rate limits).
4. **Give the developer** the specification so `DataKartApiClient.fetchByGtins` / `gs1RecordToStaged`
   (`src/server/pmd/data-sources/gs1-datakart.ts`) match the real response — today they follow GDSN-style names.
5. **Set the secrets** on the server: `GS1_DATAKART_BASE_URL`, `GS1_DATAKART_API_KEY`.
6. **Switch on** `pmdSources.gs1Enabled` in Admin → Settings. Look-ups then go to GS1 (source `gs1_datakart`,
   kind GS1, highest precedence for specifications, MRP trusted for promotion).

Until step 5 the look-up answers from a **mock** (`MockGs1DataKartClient`) with realistic records for a few test
GTINs, filed under the separate source **`gs1_datakart_mock`** so test data can never pass for GS1 data. In
production (`NODE_ENV=production`) the mock never runs: without keys the source reports "unavailable".

**What we need from the owner:** the decision and signature of the GS1 India agreement, the fee, and the two
secrets above. Nothing else blocks the feature.

---

## 2. Manufacturer self-upload portal (primary source)

* **Accounts.** An admin (permission `pmd:manufacturer:manage`) creates the manufacturer at
  `/admin/product-browser/manufacturers` (name, brands) and links the people who will upload (by their sign-in email).
  Tables `pmd_manufacturer_accounts`, `pmd_manufacturer_members` (seller database). Each account's records are filed
  under its own source `mfr_<slug>` (kind BRAND_MANUFACTURER — the highest precedence for specifications, tax and MRP).
* **Template.** `GET /api/pmd/manufacturer/template?format=xlsx|csv`: GTIN, Item Code, Product Name, Brand,
  Manufacturer, Category, Pack Size, MRP, GST %, HSN, Short Description, Description, Image URLs, Country of Origin,
  Ingredients, Shelf Life. GTIN / Product Name / Brand are required.
* **Validation per row** (before anything is staged): GTIN format and **check digit**, restricted (in-store)
  ranges, MRP, GST rate, HSN (4/6/8 digits), image addresses (http/https, no private or local hosts). A GTIN repeated
  in the same file is flagged `DUPLICATE_GTIN_IN_FILE`. Refused rows are listed in the **error file** (CSV) with
  their reason and the row as uploaded.
* **API key.** `/manufacturer/keys`: a key (`gkm_…`) is shown **once**; only its SHA-256 is stored; it can be
  revoked at once; each key is rate limited (`pmdSources.apiRequestsPerMinute`) and every use is audited.
  `POST /api/pmd/v1/manufacturer/products` with `Authorization: Bearer <key>`, JSON `{ "products": [...] }` (keys as
  the template headings or `gtin`, `name`, `brand`, `mrp`, …) or `text/csv`. 401 for a missing / unknown / revoked
  key. Progress: `GET /api/pmd/v1/manufacturer/jobs/{id}`.

---

## 3. Open Food Facts (optional)

* **Off by default** (`pmdSources.openFoodFactsEnabled`). When off, a look-up is refused before any request leaves.
* One barcode per request to the product read API (`/api/v2/product/{barcode}.json`) with an identifying
  User-Agent, capped by `pmdSources.offRequestsPerMinute`. The bulk route remains the official data dump
  (`src/server/pmd/sources/adapters/open-facts.ts`, unchanged); both use the same field mapping, and contributor
  names are stripped before storage.
* **Licence:** the database is under the **Open Database License (ODbL 1.0)**, its contents under DbCL 1.0, and
  **product images under CC BY-SA**. **Attribution is required.** Sources:
  [Open Food Facts terms of use](https://world.openfoodfacts.org/terms-of-use),
  [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
  GoKesari stores the attribution text (`pmdSources.offAttribution`) **with every imported record**
  (`pmd_record_attributions`) and shows it in the product browser. A database derived from OFF data and shared
  publicly must stay under the ODbL (share-alike); images, if shown to customers, need the CC BY-SA credit.
* Crowd-sourced data: lower reliability than manufacturer or GS1 data; it never overrides them.

---

## 4. Large imports, images, browser and promotion (F9.1.4)

* **Jobs** (`pmd_ingest_jobs`, input rows in `pmd_ingest_job_rows`): a file is parsed, validated and staged once;
  the worker then loads `pmdSources.ingestBatchSize` rows per batch through the existing pipeline and **checkpoints**
  (row outcomes + cursor in one transaction). An interrupted job **resumes from its last committed batch**; a batch
  that ran but did not checkpoint is re-run and the pipeline sees its records as unchanged. Worker: cron
  `POST /api/cron/pmd-ingest` every minute (`pmdSources.ingestBatchesPerTick` batches per job per tick) plus an
  immediate kick when a job is created. Leases stop two workers taking the same job.
* **Progress UI** polls `GET /api/pmd/jobs/{id}` (`/admin/product-browser/jobs/{id}`, `/manufacturer/jobs/{id}`);
  validation report by error code; **error file** `GET /api/pmd/jobs/{id}/errors`.
* **Images:** each record's image URLs (up to `pmdSources.imagesPerRow`) are fetched with the SSRF-safe fetcher of
  the shop bulk upload, resized with sharp to `pmdSources.imageMaxEdgePx` (WebP) and kept in the **ObjectStore**:
  the platform store by default (database, or `MEDIA_DIR` on disk), or an S3-compatible bucket when
  `objectStore.s3Enabled` is on and `OBJECT_STORE_ENDPOINT`, `OBJECT_STORE_BUCKET`, `OBJECT_STORE_REGION`,
  `OBJECT_STORE_ACCESS_KEY_ID`, `OBJECT_STORE_SECRET_ACCESS_KEY` are set (scaffold — verify on staging first).
* **Product browser** (`/admin/product-browser`, admin and operator): search / filter / sort across staging and
  master, side-by-side duplicate merge (the existing review merge and merge log), audited **bulk edit**
  (category, HSN, GST, brand; MRP on catalogue products through the master-MRP service), and the **Promote** button
  (single and bulk, permission `pmd:promote`) through the same audited catalogue bridge that `scripts/pmd/promote.ts`
  uses. A shop's own price changes still apply only to that shop (`mrp-governance.ts` unchanged).
* **Throughput (measured 18 Oct 2026, local PostgreSQL 16, `scripts/pmd/bench-ingest.ts --rows 100000 --batch 1000`,
  500 brands, distinct names):** parse + validate + stage 100,000 rows: **16.8 s** (~5,900 rows/s); full load through the
  pipeline: **749 s** (~133 records/s on average — 450/s at the start, ~100/s at the end as each brand's catalogue grows,
  because every new record is fuzzy-matched against its brand's existing products). A manufacturer uploading tens of
  thousands of SKUs of ONE brand is the slowest case (all records are candidates of each other); split such files or run
  the worker more often. The test `TC-B26-D-026` checks the 100k parse/validate/stage path within 60 s plus one loaded batch.
