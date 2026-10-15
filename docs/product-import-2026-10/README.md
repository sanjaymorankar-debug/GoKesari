# Bulk product upload (Excel / CSV) — with shop inventory update

Status, 15 Oct 2026: **built and tested locally (web, API, mobile app code);
waiting for the merge to `staging` to reach test.gokesari.com.** Nothing is
deployed yet — see [§9](#9-deployment-and-whats-open).

One more way to load products. The existing **manual add**, **add by
category** and the **Excel price upload** are untouched. A shop owner — or an
operator / admin for any shop — uploads one spreadsheet holding many products;
the rows create or update the shop's listings and **set the shop's stock to
the file's Quantity**.

| Document | What it is |
|---|---|
| this README | What was built, how it works, files and migration, decisions, deployment, open items |
| [../testing/bulk-product-upload-test-report.md](../testing/bulk-product-upload-test-report.md) | Test report: cases, expected vs actual, Test / Prod results, screenshots, defects, build numbers |
| [screenshots/](screenshots/) | Key screens (desktop, phone, admin, operator) from the local run |
| [sample-result-report.xlsx](sample-result-report.xlsx) | The result report the PUZZLES import produced |

## 1. What the user sees

| Who | Where | Tile |
|---|---|---|
| Shop owner | Seller Central → Catalogue → **Inventory → Bulk upload (Excel/CSV)** — `/shop/product-import` | Theme 1 Tile Board entry in the Inventory menu (board, menu strip and Seller Central sidebar) |
| Admin | Product master → more → **Bulk upload (Excel/CSV)** — `/admin/product-import` | Hub tile, with a **shop picker** |
| Operator | Catalogue → **Bulk upload (Excel/CSV)** — `/admin/product-import` | Hub tile, with a **shop picker** |
| Android / iPhone app | The same screens inside the app (the app shows the website) | Same tiles |

Flow: **upload** (drag-and-drop or file picker; `.xlsm`, `.xlsx`, `.csv`, up
to 10 MB and 5,000 rows) → the file is **checked in the background** (progress
shown; nothing written) → **preview**: totals (rows, new products, updates,
deactivations, skipped, rows with warnings), a paginated table (Row #, SKU,
Name, Brand, Category, MRP, Price, Qty current → new, Action, Warnings), an
"only rows with warnings" filter and the **stock mode** — *Set stock to file
quantity* (default) or *Add file quantity to current stock* → **Import**
(progress bar) → **result** with the same table filtered by outcome and the
**result report** (XLSX or CSV: the original rows plus `status` and
`messages`) → **history** of past imports (date, user, shop, file, counts,
status, report link). An identical file uploaded again shows "This file was
already imported on <date>. Import it again?". The **GoKesari simple template**
and a short help panel ("Amazon Seller Central inventory files are supported
directly") are on the upload card. On phones the table becomes cards.

## 2. Input files

**Amazon Seller Central inventory templates** (any product type — PUZZLES,
TOYS, GROCERY…; `src/server/product-import/`):

- Sheet: `Template`, else the first sheet with a product heading (SKU, Item
  Name…), else the first sheet. Sheets after `Template` are never opened.
- Headings are found **by content** in the first 15 rows: the label row (two
  known labels, or SKU / Item Name on its own), the attribute-key row under it,
  and the section-header row above it (the `settings=…` row is ignored).
  Amazon's **example row** (SKU `ABC123`) and the **notice row** (one cell,
  "prefilled" / "do not delete") are left out wherever they are.
- Columns are mapped **by attribute key first, label second**. Keys are
  canonicalised: `[marketplace_id=…]` and `[language_tag=…]` removed, `#n`
  removed (kept as the occurrence), `[audience=ALL]` / `[audience=B2B]` kept.
  Rules live in one table (`fields.ts`), not per product type.
- Repeated columns (`#1`–`#5`, Other Image URL ×8, Recommended Browse Nodes,
  Material, Theme, Bullet Point, Safety Warning, Special Features, Included
  Components, Educational Objective…) become **arrays**.
- **Every non-empty cell of every row is kept**: in the job row
  (`product_import_rows.raw_json`, keyed by attribute key), on the listing
  (`shop_listing_details.attributes`, grouped by section header) and, for a
  product the upload creates, on the product (`product_attributes`).
- `.xlsm` files are read **as data only**: ExcelJS parses the sheet XML; the
  VBA project is never read, let alone run (the preview says so when a file
  has macros). Formulas are not evaluated; Excel's saved value is used.

**GoKesari simple template** (`GoKesari_Product_Upload_Template.xlsx`,
`GET /api/v1/product-imports/template`): one heading row (SKU, Product Name,
Brand, Manufacturer, Category, Barcode Type, Barcode, HSN Code, GST %, MRP,
Selling Price, Sale Price, Sale Start, Sale End, Quantity, Unit, Pack Size,
Color, Size, Material, Description, Highlight 1–5, Keywords, Main Image URL,
Image URL 2–5, Weight (g), Length/Width/Height (cm), Country of Origin, Max
Order Qty, Action), dropdowns on Barcode Type, Unit and Action, an
**Instructions** sheet that starts "ALL COLUMNS ARE OPTIONAL", and one example
row marked **"EXAMPLE – delete this row"** that is never imported.

**CSV** with the same labels (comma, semicolon, tab or pipe; UTF-8, BOM ok).

**Values**: text trimmed; Indian numbers (`1,29,999.50`, `₹1299`, `Rs. 99/-`);
dates as Excel serial numbers, `dd/mm/yyyy`, `dd-mm-yy`, ISO or `15 Oct 2026`;
Yes/No/True/False/Y/N; lengths to **cm**, weights to **g** (mm, m, in, ft,
mg, kg, lb, oz, and spelled-out names). A value that cannot be read is kept as
written and becomes a **warning** — never an error.

## 3. Field mapping

| From the file | Into GoKesari |
|---|---|
| SKU | the shop's SKU for the listing (`shop_listing_details.seller_sku`, unique per shop, case-insensitive). Blank → `GK-<first 8 of shop id>-<seq>` + warning |
| Product Type | category hint; kept in attributes |
| Listing Action | row action (§4) |
| Parentage, Parent SKU, Variation Theme | kept in attributes (variant grouping data; see open items) |
| Item Name / Product Name | product name |
| Item Highlight | product description when there is no description |
| Brand, Manufacturer, Model, Part Number, Sub Brand | brand (linked to the brand list when the name matches; otherwise kept with the product's attributes), manufacturer name; the rest in attributes |
| Product Id Type + Product Id | `products.gtin` when it is a valid GTIN (EAN/UPC/GTIN/ISBN); otherwise `products.barcode`; ASIN kept apart; GTIN Exempt = no barcode. Primary master match key |
| Recommended Browse Nodes ×5 / Category | category: the text after the last `>` matched to a GoKesari category by name (singular/plural tolerant); no match → **General** (the system's uncategorised category) + warning |
| Product Description, Bullet Points, Keyword | product description, specifications (bullets), keywords in attributes |
| Main / Other / (Swatch) Image URLs | listing photos, downloaded after the import (§6) |
| Color, Size, Style | product variant (`Size / Color / Style`); all of them also in attributes |
| Material, Shape, Theme, Gender, Age range, Pieces, Items, Unit Count (+ type) | attributes; Unit / Unit Count Type → the product's unit |
| Item weight / dimensions; package dimensions / weight | normalised to g / cm, in the product's attributes (`_dimensions`) |
| External Product Information where Entity = "HSN Code"; HSN Code | **`products.hsn_code`** (new products) |
| Product Tax Code; GST % | tax code in attributes; GST % → `products.gst_rate_bp` (new products) |
| Maximum Retail Price (ALL) / MRP | **MRP for this shop** (`shop_listing_details.mrp_paise`) — never the master MRP |
| Your Price (ALL) / Selling Price | the shop's selling price (online and in-shop, as the inventory page sets it) |
| Sale Price + Sale Start + Sale End | stored on the listing (`sale_price_paise`, `sale_starts_on`, `sale_ends_on`) — see open items |
| B2B price, MRP, quantity tiers | `shop_listing_details.attributes.b2b` (no B2B pricing exists in GoKesari yet) |
| **Quantity (IN) / Quantity** | **shop stock** (§5) |
| Handling Time, Restock Date, Inventory Always Available | listing lead time, restock date, always-available flag |
| Maximum Order Quantity | `shop_products.maximum_order_quantity` |
| Item Condition, Offer Condition Note | condition (default **New** for a new listing), note |
| Gift wrap / gift message | gift flags |
| Country of Origin, Manufacturer / Packer / Importer contact | country of origin on the product; contacts in attributes (Legal Metrology) |
| Safety warnings, batteries, hazmat, dangerous goods, SDS URL, compliance media… | `attributes.compliance` (every compliance column, generically) |

Master fields are written **only when the upload creates the product**. For a
product that already exists in the catalogue, the master is never changed by a
shop's file (catalogue governance); the file's values for that shop go on the
listing and its attributes.

## 4. Matching and row actions

For each row, within the selected shop:

1. **SKU** — the shop's SKU (or the GoKesari product code, `P00012`) → update
   that listing.
2. **Barcode** in the master catalogue → link the shop to that product (a new
   listing, or the existing one).
3. **Name + Brand (+ Size / Color)**, exact after normalisation, one match
   only → link it, with a "matched by name" warning. Pending products count;
   Rejected ones do not.
4. **Nothing** → a new master product with status **Pending approval** (the
   existing duplicate check sees it: `findSimilarProducts` and this matcher
   both include Pending), plus a listing the shop can sell straight away.

Rows of the same file see each other: a product created by row 8 is matched
by a later row with the same barcode.

| Listing Action | What happens |
|---|---|
| blank / Create or Replace / Upsert | create or update; blank cells change nothing. A listing an earlier Delete deactivated is activated again |
| Edit (Partial Update) / Edit | update an existing listing only; no match → warning, row skipped |
| Delete | **soft-deactivate**: hidden from customers (`is_active = false`), stock 0 (ledger row). Never a hard delete; the master product is never touched |

## 5. Inventory

- Mode **Set** (default): stock = the file's Quantity. Mode **Add**: stock +=
  the file's Quantity. Chosen on the preview.
- Blank Quantity: an existing listing's stock is unchanged; a new listing has
  stock 0 and the warning "not orderable until stock is set".
- Negative or non-numeric Quantity: warning, stock unchanged.
- The same SKU on several rows: merged into the last row (the last row wins
  for each field that has a value), quantities follow the mode (Set: last,
  Add: total); the earlier rows show "merged into row N".
- **Ledger**: every change writes `inventory_movements` (previous, new, delta,
  `source = 'bulk_upload'`, `import_job_id`, `created_by`, timestamp). The
  table already existed; `source` and `import_job_id` were added (nullable).
- **Concurrency**: each listing's row is locked (`SELECT … FOR UPDATE`) before
  its stock changes, and Add computes in SQL (`online_stock + n`). An order
  placed meanwhile waits for the row and then decrements the new value, so
  nothing is lost (tested with six concurrent orders during an Add import).
- The file's Quantity sets the **online** stock (what customers order
  against); in-shop (offline) stock is not changed.

## 6. Images

After the import commits, the rows' image URLs are downloaded **in the
background**: http/https only, no credentials in the address, every resolved
address must be public (checked by the socket's own DNS lookup, so DNS
rebinding cannot slip through), redirects re-checked (max 3), content type
JPEG/PNG/WebP, 5 MB and 15 s per image, each distinct URL downloaded once.
The bytes then go through the existing photo pipeline (type from the bytes,
EXIF stripped, three WebP sizes) and storage, as listing photos subject to the
existing photo moderation. A failed image is a warning on its row; the product
stays. Images are added only to listings with no photos of their own yet, so
re-importing a file never duplicates photos.

## 7. API (v1, shared by the website and the apps)

| Method | Path | |
|---|---|---|
| POST | `/api/v1/shops/{shopId}/product-imports` | multipart `file` → 202 `{ jobId, job, duplicateOf }` |
| GET | `/api/v1/shops/{shopId}/product-imports` | history |
| GET | `/api/v1/product-imports/{jobId}` | status + summary (poll) |
| GET | `/api/v1/product-imports/{jobId}/rows?status=&page=&pageSize=` | preview / result rows (`status`: all, warnings, ready, skipped, created, updated, deactivated, failed) |
| POST | `/api/v1/product-imports/{jobId}/commit` | `{ inventoryMode: "SET" \| "ADD" }` → 202 |
| POST | `/api/v1/product-imports/{jobId}/cancel` | before the import |
| GET | `/api/v1/product-imports/{jobId}/report?format=xlsx\|csv` | result report |
| GET | `/api/v1/product-imports/template` | GoKesari simple template |
| GET | `/api/v1/product-imports/shops?q=` | admin / operator shop picker |

**Authorisation**: a shop owner (permission `excel-upload:own`) for their own
shops only; operators and admins (`excel-upload:any`) for any shop; another
owner's job is "not found". Shop staff (photo/description helpers) are not
included — stock and prices are the owner's. **Operators' prices** follow the
existing rule: they become price requests for the owner to approve; stock and
listings still update. Every upload, commit, completion, cancellation and
report download is in the **audit log** (`product_import.*`), and new products
/ listings carry `via: bulk_upload`.

Background work uses Next.js `after()` (the media-import pattern): the upload
and the commit answer 202 at once; parsing and importing run after the
response. Rows are written **200 at a time** (rule `productImport.batchSize`),
each batch in its own transaction, each row in its own savepoint — a failing
row is marked failed with its reason and nothing else is rolled back. An
import with no progress for 5 minutes (a restarted server) can be resumed by
committing again; finished rows are skipped. A check whose background task was
lost is restarted when the screen polls.

**Notifications**: event `shop.product_import_finished` (event layer — written
in the commit's transaction, sent right after it; no cron) to the shop owner
and, when someone else ran the import, to that operator/admin: in-app, plus a
PUSH delivery queued in the outbox (a push provider is not configured yet, so
it is recorded as skipped until one is — see open items). Opens the import.

## 8. Files and migration

| Area | Files |
|---|---|
| Migration (additive) | `drizzle/0076_product_bulk_import.sql` (+ journal), rollback `scripts/rollback-0076.sql` |
| Schema | `src/server/db/schema.ts`: `productImportJobs`, `productImportRows`, `shopListingDetails`, `productAttributes`; `inventoryMovements.source`, `.importJobId` |
| Seller DB ownership | `src/server/db/split/ownership.ts` — all four tables in **gokesari_seller** |
| Shared vocabulary | `src/lib/product-import.ts` |
| Parser | `src/server/product-import/{grid,columns,fields,normalise,parse}.ts` |
| Matching | `src/server/product-import/matcher.ts` |
| Images | `src/server/product-import/image-fetch.ts` |
| Template / report | `src/server/product-import/workbooks.ts` |
| Service | `src/server/services/product-import.ts` |
| API | `src/app/api/v1/shops/[shopId]/product-imports/route.ts`, `src/app/api/v1/product-imports/**` |
| Screens | `src/app/shop/product-import/page.tsx`, `src/app/admin/product-import/page.tsx`, `src/components/product-import-panel.tsx`, `src/components/product-import-shop-picker.tsx` |
| Tiles | `src/lib/board/menus.ts` (shop Inventory, admin Product master, operator Catalogue) |
| Rule | `src/server/config/rules.ts` → `productImport` (Admin → Business rules): enabled, maxFileBytes (10 MB), maxRows (5,000), batchSize (200), retentionDays (90), imageMaxBytes (5 MB), imageTimeoutMs, maxImagesPerRow |
| Retention | `purgeOldProductImports()` from the daily `/api/cron/seller-verification` sweep: files and staged rows deleted after 90 days; the job summary stays in the history |
| Events / notifications / audit | `src/server/events/catalog.ts`, `src/server/notifications/{types,templates}.ts`, `src/server/services/audit.ts` |
| Mobile | `mobile/app.config.ts` (1.1.0, versionCode/buildNumber 2), `mobile/README.md`, `mobile/src/__tests__/navigation-policy.test.ts` |
| Tests | `tests/unit/product-import-parser.test.ts`, `tests/integration/product-import.test.ts`, `tests/integration/product-import-load.test.ts`, `tests/helpers/amazon-template.ts`, `tests/fixtures/bulk_upload/PUZZLES.xlsm`, `scripts/product-import/write-puzzles-fixture.ts` |

**Migration 0076** (additive and backward compatible): four new tables, two
nullable columns on `inventory_movements`, one sequence, indexes. No existing
column changes. The previous release runs unchanged on the new schema, so the
migration can run before the deploy (as `MIGRATE_ON_BUILD` does).

## 9. Deployment and what's open

**Deployment** follows the repository's flow: this branch → PR into
`staging` → test.gokesari.com (the "Test database" workflow migrates on the
merge) → end-to-end tests there → `staging` merged into `main` (the human
approval gate) → gokesari.com. Production smoke test: one small import into a
designated test shop, check stock and the report, then deactivate the test
products with a Delete file. None of these steps could be run from this
session: merging and deploying are the owner's approval, and this session
cannot reach test.gokesari.com or gokesari.com.

**Decisions taken** (recorded in the tracker, "Bulk Product Upload" sheet):

1. *"MRP for this shop"* — GoKesari has no shop-level MRP and the master MRP is
   operations-only. The file's MRP is stored on the listing
   (`shop_listing_details.mrp_paise`); a selling price above it (or above an
   enforced catalogue MRP) is not applied, with a warning.
2. *"Uncategorised"* — the existing system category **General** is the
   fallback ("products that do not clearly fit another category").
3. *Pending* — every product an upload creates is Pending approval, whoever
   uploads (the brief's rule), while the shop sells it at once.
4. *Operators' prices* — proposed to the owner (existing price-approval rule);
   admins' and owners' apply at once.
5. *Stock* — the file's Quantity is the **online** stock.
6. *Auto SKU* — `GK-<first 8 characters of the shop id>-<5-digit sequence>`.
7. *Images* — only for listings with no photos yet; existing photo moderation
   applies.
8. *Brands* — linked when the name matches the brand list; a new brand is not
   added to the brand master by a shop's file (kept in attributes).
9. *Existing master products* are never changed by a file (only new ones get
   the file's master fields).
10. *The PUZZLES.xlsm fixture is a reconstruction* to the layout the brief
    verified (the original file was not attached to this session — not on
    disk, Drive or e-mail). Replace it with the real file; the tests check the
    layout, not reconstruction details.

**Open items**

- **Deploy to test.gokesari.com and gokesari.com, and the environment tests
  there** (web, Android, iOS; real shop, admin and operator accounts) — need
  the PR merged to `staging`, then `main`.
- **Android release AAB / iOS TestFlight build** — the PR's "Android APK"
  workflow builds installable preview and production APKs (version 1.1.0,
  versionCode 2); the Play Store AAB and the iPhone build run on EAS (Expo
  account, `EXPO_TOKEN`, Apple Developer account) — not available here.
- **Push notifications** — the outbox records a PUSH copy; no push provider is
  chosen yet (existing gap, same for every notification).
- **Sale price / dates** are stored but not yet applied at checkout (the
  storefront has no per-listing scheduled-price engine; adding one would
  change existing price code).
- **Variants** (parent/child SKUs) are kept in attributes; GoKesari has no
  variant-group model to map them to.
- **5,000-row timing** — ~95 s locally for 5,000 new products (≈19 ms/row,
  parse/preview ~2 s). On the hosted database each query costs more; the work
  runs after the response so the screen never times out, but expect several
  minutes for a full 5,000-row file of new products.
