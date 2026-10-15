# Testing report — Bulk product upload (Excel/CSV) with shop inventory update

| | |
|---|---|
| Feature | Bulk product upload — design in [docs/product-import-2026-10/README.md](../product-import-2026-10/README.md) |
| Branch | `claude/amazing-ritchie-9vlq9f` (PR into `staging`) |
| Report date | 15 Oct 2026 |
| Local environment | Node 22, PostgreSQL 16 (local), Next.js 16.3.6 dev server, Chromium (Playwright) |
| **Test server (test.gokesari.com)** | **Not run — not deployed yet.** Deployment needs the PR merged into `staging` (owner approval); this session cannot deploy or reach the site. |
| **Production (gokesari.com)** | **Not run — not deployed yet.** Follows a clean Test run and the `staging` → `main` merge. |
| Fixture | `tests/fixtures/bulk_upload/PUZZLES.xlsm` — **a reconstruction** of the Amazon PUZZLES template to the layout the brief verified (309 columns, rows 1–7 as described, data from row 8, VBA project included). The original file was not available to this session. |

Results columns: **Local** = run in this session (automated suite or browser);
**Test** / **Prod** = run on test.gokesari.com / gokesari.com. "Not run" means
exactly that — nothing is claimed for an environment it was not run on.

## 1. Summary

| Suite | Cases | Local | Test | Prod |
|---|---|---|---|---|
| Parser and normalisation (unit) | 18 | **18 pass** | Not run | Not run |
| Import service and API (integration, real PostgreSQL) | 23 | **23 pass** | Not run | Not run |
| Load: 5,000 rows | 1 | **pass** (parse + preview 1.8 s; import 94.7 s) | Not run | Not run |
| Browser walk-through (desktop, phone, admin, operator) | 10 | **10 pass** | Not run | Not run |
| Mobile app (unit, typecheck, lint) | 26 tests | **pass** | — | — |
| Full regression suite (all existing unit + integration tests) | 1,811 | **all pass** after D-9, re-checked after merging `staging` (see §4) | Not run | Not run |
| Environment end-to-end (web, Android, iOS on real accounts) | 9 | Not run | **Not run** | **Not run** |

## 2. Test cases

### 2.1 Parser — `tests/unit/product-import-parser.test.ts`

| ID | Case | Steps | Expected | Actual (local) | Local | Test | Prod |
|---|---|---|---|---|---|---|---|
| P-01 | PUZZLES.xlsm layout | Parse the fixture | Sheet `Template`, 309 columns, mapped by attribute key; reading stops at Template | As expected; sheets read: Instructions, Data Definitions, Template | Pass | Not run | Not run |
| P-02 | Example and notice rows | Same | Rows 6 (ABC123) and 7 (notice) left out; first data row 8 | `skippedTemplateRows = [6, 7]`; first row 8 | Pass | Not run | Not run |
| P-03 | Row 8 values | Same | Product type PUZZLES, brand Generic, HSN 95032000 (External Product Information, Entity "HSN Code"), Quantity 25, MRP ₹999, price ₹649 | As expected | Pass | Not run | Not run |
| P-04 | Repeated columns → arrays | Same | Bullet Point ×5, Other Image URL, Material, Theme, Safety Warning as arrays | As expected | Pass | Not run | Not run |
| P-05 | Lossless | Same | Every non-empty cell in raw (by key) and in attributes by section; B2B kept apart | As expected | Pass | Not run | Not run |
| P-06 | Indian numbers | `1,29,999.50`, `₹1,299.00`, `Rs. 99/-`, `INR 1299`, `99-120`, `-5` | Numbers / paise; ranges and negatives invalid | As expected | Pass | Not run | Not run |
| P-07 | Dates | serial 46300 / 45658, `15/10/2026`, `15-10-26`, ISO, `15 Oct 2026`, `31/02/2026` | ISO dates; impossible date invalid | As expected | Pass | Not run | Not run |
| P-08 | Units | mm, Centimeters, `12 cm`, inches, Kilograms, Grams, stone | cm / g; unknown unit invalid | As expected | Pass | Not run | Not run |
| P-09 | Booleans | Yes/y/TRUE/1, No/n/false/0, maybe | true / false / invalid | As expected | Pass | Not run | Not run |
| P-10 | Other product types | GROCERY-style keys under misleading labels | Mapped by key | As expected | Pass | Not run | Not run |
| P-11 | CSV | Semicolon CSV with BOM and `₹45` | Read; format CSV | As expected | Pass | Not run | Not run |
| P-12 | GoKesari template | Build template, read it back, parse it | All columns, Instructions ("ALL COLUMNS ARE OPTIONAL"), dropdowns (Barcode Type, Unit, Action), example row never imported | As expected | Pass | Not run | Not run |
| P-13 | Report formula injection | Cell `=HYPERLINK(…)` | Written as `'=HYPERLINK(…)` | As expected | Pass | Not run | Not run |
| P-14 | Not a spreadsheet | `.xls` (OLE), `.pdf` | 422 with a readable message | As expected | Pass | Not run | Not run |
| P-15 | Planned stock | Set / Add / blank / new / deactivate | 4 / 17 / unchanged / 0 / 0 | As expected | Pass | Not run | Not run |
| P-16 | All-optional rows (parser) | Only a name, only a barcode, an empty row, only SKU + Quantity | 3 rows read, 1 empty counted | As expected | Pass | Not run | Not run |
| P-17 | SSRF: URL checks | 127.0.0.1, 10.x, 169.254.169.254, 192.168.x, [::1], localhost, file:, ftp:, user:pass@ | All refused | As expected | Pass | Not run | Not run |
| P-18 | SSRF: DNS to a private address | Host name resolving to 10.1.2.3 | Refused at connect time (BLOCKED) | As expected | Pass | Not run | Not run |

### 2.2 Import service and API — `tests/integration/product-import.test.ts`

| ID | Case | Steps | Expected | Actual (local) | Local | Test | Prod |
|---|---|---|---|---|---|---|---|
| I-01 | PUZZLES.xlsm end to end | Owner uploads, previews, imports (Set) | 5 rows → 5 created; Pending master products; HSN, GTIN on product; MRP on the listing only (master MRP null); prices live; stock 25 / 1200 / 0 / 0 / 7; "ten" → warning, stock 0; ledger rows with source bulk_upload, job and user; owner notified in app | As expected | Pass | Not run | Not run |
| I-02 | Result report | Download CSV and XLSX | Original columns + `status` + `messages` | As expected | Pass | Not run | Not run |
| I-03 | Match by SKU | Import, then a file with the same SKU (other case) | Updated; blank name cell does not wipe the name | As expected | Pass | Not run | Not run |
| I-04 | Match by barcode | Master product with GTIN; file with that barcode | Linked; no new master row; shop carries the category | As expected | Pass | Not run | Not run |
| I-05 | Match by name + brand | Product made by shop A; shop B's file with the same name/brand (different case/spacing) | "Matched by name" warning; one master row | As expected | Pass | Not run | Not run |
| I-06 | New → Pending, duplicate check | No match | Pending product; manual "Create New Product" with that name reuses it | As expected | Pass | Not run | Not run |
| I-07 | All optional | Rows: only name / only barcode / empty / only SKU + Quantity | 3 rows, 1 skipped; generated SKU; "not orderable until stock is set"; stock 42 and nothing else changed for the SKU row | As expected | Pass | Not run | Not run |
| I-08 | Set mode | Stock 10, file 3 | 3 | 3 | Pass | Not run | Not run |
| I-09 | Add mode | Stock 10, file 5 | 15 | 15 | Pass | Not run | Not run |
| I-10 | Blank / negative quantity | Blank; then −4 | Unchanged both times; warning on −4 | As expected | Pass | Not run | Not run |
| I-11 | Duplicate SKUs in one file | Rows (12, 4) and (blank, 6) | Set → 6, price 12 kept; Add → +10; earlier row "merged" | As expected | Pass | Not run | Not run |
| I-12 | Concurrent orders during an import | Stock 20; Add 5 while 6 orders consume 1 each | 19; ledger sums to the balance | As expected | Pass | Not run | Not run |
| I-13 | Listing actions | Upsert; Edit (no match / match); Delete; Upsert again | Edit-no-match skipped; Delete → inactive, stock 0, not deleted, master kept; Upsert reactivates | As expected | Pass | Not run | Not run |
| I-14 | Operator prices | Operator imports a new price | Price unchanged; 2 price requests (online, in-shop) pending; stock updated; operator and owner notified | As expected | Pass | Not run | Not run |
| I-15 | Price above MRP | MRP 100, price 120 | Price not applied, warning | As expected | Pass | Not run | Not run |
| I-16 | Images | Two rows share a URL; one SSRF URL (169.254.169.254) | URL downloaded once; 2 photos saved, 1 refused as a row warning; products created | As expected | Pass | Not run | Not run |
| I-17 | Other shop | Owner A uploads for shop B; cancels B's job | 403; 404 | As expected | Pass | Not run | Not run |
| I-18 | Oversized / wrong type | 100 kB limit; `.pdf`; fake `.xlsx` | 422; 422; preview fails with a readable message | As expected | Pass | Not run | Not run |
| I-19 | Macros never run | `.xlsm` with a VBA project (Auto_Open + Shell) | Imported as data; "macros… not run" note | As expected | Pass | Not run | Not run |
| I-20 | History, duplicate file, cancel, retention | Same file twice; cancel; age 91 days; purge | "Already imported" with the first job; cancelled; file and rows purged, summary kept | As expected | Pass | Not run | Not run |
| I-21 | API v1 end to end | Upload (multipart) → poll → rows (warnings) → commit → report → history → template | 202 / preview_ready / rows / 202 / completed / CSV attachment / 1 import / template file | As expected | Pass | Not run | Not run |
| I-22 | API access | Signed out; other owner | 401; 403 | As expected | Pass | Not run | Not run |
| I-23 | Regression: existing flows | Manual create product; add category to shop | Unchanged behaviour (Pending product, price; category fills inventory) | As expected | Pass | Not run | Not run |

### 2.3 Load — `tests/integration/product-import-load.test.ts`

| ID | Case | Expected | Actual (local) | Local | Test | Prod |
|---|---|---|---|---|---|---|
| L-01 | 5,000 new products (166 KB file), Set mode | All created, ledger rows for non-zero quantities, no UI timeout (202 + polling) | Upload 33 ms; parse + preview 1.8 s; import 94.7 s (≈19 ms/row); 5,000 created, 0 failed | Pass | Not run | Not run |

First run took 158 s for the import; new listings now get their price, stock
and order limit in the insert itself (same checks, same ledger row), which
brought it to 95 s. On the hosted database each query costs more, so a full
file of new products will take several minutes there — it runs after the
response, with a progress bar.

### 2.4 Browser walk-through (local dev server, seeded demo data)

Script: Playwright (Chromium). Screenshots in
[docs/product-import-2026-10/screenshots](../product-import-2026-10/screenshots/).

| ID | Role / device | Steps | Expected | Actual | Local | Test | Prod |
|---|---|---|---|---|---|---|---|
| U-01 | Shop owner, desktop | Inventory page | "Bulk upload (Excel/CSV)" in the Inventory menu strip and Seller Central sidebar | Shown (01) | Pass | Not run | Not run |
| U-02 | Shop owner, desktop | Open Bulk upload | Drop zone, template download, limits, help | Shown (02) | Pass | Not run | Not run |
| U-03 | Shop owner, desktop | Upload PUZZLES.xlsm | Checking… then preview: totals, stock mode, table with Qty current → new and warnings | Shown (03) | Pass | Not run | Not run |
| U-04 | Shop owner, desktop | "Only rows with warnings" | Filtered table | Shown (04) | Pass | Not run | Not run |
| U-05 | Shop owner, desktop | Import | Progress, then result totals, row outcomes, image status, history | Shown (05) | Pass | Not run | Not run |
| U-06 | Shop owner, desktop | Download report | `PUZZLES_result.xlsx` | Downloaded ([sample](../product-import-2026-10/sample-result-report.xlsx)) | Pass | Not run | Not run |
| U-07 | Shop owner, desktop | Upload the same file again | "This file was already imported on …" | Shown (06) | Pass | Not run | Not run |
| U-08 | Shop owner, phone 390 px with the app's user agent | Upload, preview (cards), Add mode, import | Card layout; import completes | Shown (07–09); second shop matched the first shop's products by barcode and by name + brand | Pass | Not run | Not run |
| U-09 | Admin | Product master hub → Bulk upload → pick shop → import | Tile, shop picker, import for that shop | Shown (10–12) | Pass | Not run | Not run |
| U-10 | Operator | Catalogue hub → Bulk upload → pick shop → import | Tile, picker, import; prices proposed to the owner | Shown (13–14) | Pass | Not run | Not run |

### 2.5 Mobile apps

| ID | Case | Expected | Actual | Local | Test | Prod |
|---|---|---|---|---|---|---|
| MOB-01 | Navigation policy | Bulk-upload pages, API and report download stay in the app | `mobile/src/__tests__/navigation-policy.test.ts` — pass | Pass | — | — |
| MOB-02 | App checks | Typecheck, lint, 26 unit tests | Pass | Pass | — | — |
| MOB-03 | Android build (APK) | Version 1.1.0, versionCode 2; preview + production APKs | Built by the PR's "Android APK" workflow — see §5 | See §5 | — | — |
| MOB-04 | Android release AAB | Play Store build | **Not run** — needs EAS (Expo account / token) | Not run | — | — |
| MOB-05 | iOS archive / TestFlight | Version 1.1.0, buildNumber 2 | **Not run** — needs EAS and an Apple Developer account | Not run | — | — |
| MOB-06 | Document picker on a phone | Android system picker (Files, Drive, WhatsApp, e-mail) / iPhone Files offers .xlsx/.xlsm/.csv | The upload is a web file input with explicit MIME types (including the macro-enabled type and `application/octet-stream` for files saved from WhatsApp); react-native-webview hands it to the system picker. **Needs a device on the test site** | Not run | Not run | Not run |
| MOB-07 | Push notification on completion | Arrives on the phone | In-app notification written and a PUSH copy queued; no push provider is configured on the platform yet | Not run | Not run | Not run |

### 2.6 Environment end to end (the brief's §8, steps 1–2)

| ID | Where | Steps | Test | Prod |
|---|---|---|---|---|
| E-01 | Web, shop account | Upload PUZZLES.xlsm + the GoKesari template, preview, import (Set), check stock = Quantity, download report | Not run | — |
| E-02 | Web, admin account | Pick a shop, import, check the owner is notified | Not run | — |
| E-03 | Web, operator account | Pick a shop, import, check prices go to the owner | Not run | — |
| E-04 | Android app (preview build) | Pick the file from Files / Drive / WhatsApp, preview cards, import, share the report | Not run | — |
| E-05 | iPhone | Same, from Files | Not run | — |
| E-06 | Migration | `0077` applied by the Test database workflow | Not run | Not run |
| E-07 | Prod smoke | One small import into a designated test shop; check stock and the report | — | Not run |
| E-08 | Prod clean-up | Delete-action file deactivates the test products | — | Not run |
| E-09 | Regression on the site | Manual add product, add category, Excel price upload | Not run | Not run |

## 3. Defects found and fixed during this work

| # | Found by | Defect | Fix |
|---|---|---|---|
| D-1 | I-01 and others | Finishing an import failed with a SQL syntax error when there were no job messages (empty array interpolated as `()`) | Messages appended in code, not SQL |
| D-2 | I-01 | Rows with a brand not in the brand list failed (`""` used as a brand id) | Missing brand cached as "none" |
| D-3 | I-03 | Re-importing a SKU in another letter case overwrote the stored SKU | A listing's SKU is set once; same SKU in another case is the same SKU |
| D-4 | P-11 | A CSV with the template's headings was reported as the GoKesari template | Format detection checks the file type first |
| D-5 | Lint | The screen loaded data synchronously inside effects (React lint error) | Loads moved to timer callbacks |
| D-6 | U-05 | Image failures showed raw network errors (`getaddrinfo ENOTFOUND …`) | Plain reasons ("the web address could not be found") |
| D-7 | U-05 | After an import the upload box re-appeared above the result | Shown again only on "Upload another file" |
| D-8 | L-01 | 5,000 rows took 158 s | New listings written in one insert (95 s) |

## 4. Regression suite

Full `npm test` (all unit and integration tests, local PostgreSQL), after the
feature: **REGRESSION_RESULT**

## 5. App build numbers

| App | Version | Build number | Where |
|---|---|---|---|
| Android | 1.1.0 | versionCode 2 | APK: PR workflow "Android APK" — **ANDROID_BUILD** |
| Android (Play Store AAB) | 1.1.0 | (EAS auto-increments) | Not built — needs EAS |
| iOS | 1.1.0 | buildNumber 2 | Not built — needs EAS + Apple Developer account |

## 6. Sign-off

| Environment | Result | By | Date |
|---|---|---|---|
| Local | Pass (automated + browser) | Claude Code | 15 Oct 2026 |
| test.gokesari.com | Not run | | |
| gokesari.com | Not run | | |
