# Test results — Excel product upload template flow (08-Nov-2026)

| | |
|---|---|
| Brief | Owner, 08-Nov-2026 11.11 IST: verify and fix the Excel Product Upload Template flow end to end |
| Branch | `feat/product-upload-template-2026-11` (from `staging` a69f60a8) |
| Design | [README §10](README.md#10-08-nov-2026-mandatory-columns-row-errors-and-the-new-template), decisions PU-01 to PU-05 in [decision-log](../decision-log.md) |
| Environment | Local only: Node 24, PostgreSQL 18 (scratch server), Next.js dev server, built-in browser (desktop 800 px and phone 375 px) |
| test.gokesari.com | **Not run** — not deployed yet |
| gokesari.com | **Not run** — not released |

All times IST.

## 1. Summary

| Suite | Cases | Local result |
|---|---|---|
| New unit tests `tests/unit/product-upload-template-2026-11.test.ts` (TC-PT-01…05) | 15 | **15 pass** |
| Updated unit tests (parser, round trip) | 25 | **25 pass** (incl. the empty-row case that already failed on staging before this change — fixed) |
| Integration `tests/integration/product-import.test.ts` (real PostgreSQL) | 27 | **27 pass** (5 new, 5 rewritten for the new rules) |
| Load: 5,000 rows | 1 | **pass** within budget |
| Full regression suite (273 files) | 3,403 | **3,399 pass**, 4 fail — none caused by this change (§4) |
| Typecheck, lint (changed files) | — | **clean** (one existing unrelated error: `@zxing/browser` not installed in the local `node_modules`) |
| Browser walk-through (§3) | 12 | **12 pass** |

## 2. Brief vs result

| Brief item | Result | Evidence |
|---|---|---|
| 1. Download button on the Products / Inventory screen, no scrolling | Pass — "Download GoKesari template", CSV, "Download my current products", CSV on the upload card; phone: button at y 634–678 of 812 | §3 B-01, B-11 |
| Valid .xlsx | Pass — 200, `application/vnd…sheet`, ZIP signature, every XML part well-formed, sheet elements in schema order | B-02 |
| Opens in Excel / Google Sheets / LibreOffice without repair | **Not checked by hand** — Excel cannot be opened from this session; a copy is in `template-2026-11-08/` to open | — |
| Header frozen and bold; mandatory headings marked | Pass | TC-PT-01 |
| Columns: Name, Category, Sub-category, Brand, Unit / Pack Size, MRP, Selling Price, Stock Qty, SKU / Barcode, HSN, GST %, Description, Image URL, Loose Item (Y/N) | Pass — all present, mandatory four first | TC-PT-01 |
| Instructions sheet: each column, mandatory or not, allowed values, example | Pass | TC-PT-01 |
| Dropdowns Category, Sub-category (master data), GST %, Loose Item | Pass — Category / Sub-category from the live master via a hidden Lists sheet | TC-PT-01, B-02 |
| 2–3 sample rows, ignored on upload | Pass — 3 rows, never imported | TC-PT-01 |
| "Download my current products" with hidden / locked Product ID | Pass — hidden, locked column; re-upload matches it | TC-PT-01, integration "catalogue download…" |
| 2. Accepts .xlsx / .xlsm / .csv, rejects others with a message | Pass (existing; .xls refused with a message) | parser "refuses files…", integration "refuses an oversized file…" |
| Size and row limit shown | Pass — "up to 10 MB and 5,000 rows" | B-01 |
| Preview: new, updated, errors | Pass — Errors count added | B-04 |
| Row-level errors "Row N: column reason" | Pass — e.g. `Row 6: Selling Price ₹550.00 > MRP ₹500.00` | B-05, integration |
| Error report .xlsx with Error column | Pass — before and after import | B-06, TC-PT-05 |
| Partial import | Pass — 1 imported, 7 rejected | B-07 |
| Mandatory Name, Category, MRP (not loose), Stock Qty | Pass — on every row (PU-01) | TC-PT-02 |
| Numeric / negative checks; Selling ≤ MRP | Pass — row rejected (PU-02) | TC-PT-02 |
| Trim, Hindi / Marathi, ₹ / Rs. / 1,299.00 | Pass | TC-PT-03 |
| Duplicates: in file and against the shop (SKU / Product ID / barcode / Name + Pack Size) → update | Pass; **bug fixed**: Devanagari names all had the same match key and could update the wrong product | TC-PT-04, integration |
| Blank rows, extra / reordered columns, sample rows | Pass; **bug fixed**: blank .xlsx rows were not counted | TC-PT-03, parser |
| 3. Only the uploading shop | Pass — no other shop got the listing | B-08 |
| Shop MRP only; master not overwritten | Pass — listing MRP ₹28, master MRP empty | B-08 |
| New products Pending approval, shop sells at once | Pass (existing) | B-08 |
| Loose goods with empty price | Pass | TC-PT-02 |
| Transaction / batch safety | Pass (existing: batches of 200, row savepoints) | integration |
| Visible at once in shop list, shop page, search, apps | Pass — shop page and search; the apps show the website | B-09 |
| Upload history with user, file, IST time, counts | Pass (existing; times in IST) | B-04 |
| Re-upload idempotent | Pass — 0 created, 1 updated; identical file flagged "already imported" | B-10, integration |
| 4. No JS errors, no 4xx / 5xx, no server errors | Pass — server log clean; all import requests 2xx | B-12 |
| Edge cases: empty / header-only file, 1 row, 5,000 rows, special characters, formulas | Pass | TC-PT-03, load |
| Merged cells, Google-Sheets-saved file, slow network, session expiry mid-upload | **Not tested** this round | — |

## 3. Browser walk-through (local, 08-Nov-2026 11.38–11.44 IST)

Shop owner "Kesari Dairy Farm" (seed data), `/shop/product-import`.

| ID | Step | Result |
|---|---|---|
| B-01 | Open the screen | Mandatory line and four download buttons visible without scrolling |
| B-02 | Download template / current products | 200, .xlsx, 15 KB / 15.6 KB |
| B-03 | Upload a CSV: 8 rows (milk, बासमती तांदूळ, साखर loose, no name, price > MRP, unknown category, no qty, blank row, MRP "abc" + GST 7%) | 202, preview ready |
| B-04 | Preview counts | 8 rows · 1 new · 7 errors · 1 with warnings |
| B-05 | Row errors | Each with "Row N: …" (Rice, Sugar, Tea are not categories in the local seed master — correctly rejected) |
| B-06 | Download rows with errors (Excel) | 200, `…_problems_result.xlsx` |
| B-07 | Import 1 row | Completed: created 1, failed 7 |
| B-08 | Database | Sub-category "Toned Milk", variant "500 ml", stock 40, price ₹27, shop MRP ₹28, master MRP empty, Pending approval, only this shop, ledger row `bulk_upload` |
| B-09 | Customer shop page and search | Product present on both |
| B-10 | Same row uploaded twice more | created 0, updated 1 each; the second flagged as already imported |
| B-11 | Phone width 375 px | No sideways scroll; download button on the first screen (the existing "Get the app" banner covers it until dismissed) |
| B-12 | Console / network / server log | No server errors; product-import requests all 2xx. Console shows only local-environment noise (sign-in redirect to https://localhost) |

Fixed after the walk-through: a rejected row showed the fallback category and "new → unchanged" quantity; "Import 1 rows".

## 4. Full regression suite

Run 08-Nov-2026 11.47–12.26 IST on its own database (single-database layout, the only layout since DS-01/DS-02 of 04-Nov-2026):
**273 files, 3,403 tests: 3,399 pass, 4 fail.**

| Failing test | Cause | Same on unchanged staging? |
|---|---|---|
| `product-import-load` — 5,000 rows | The run started before this test was updated: its file names category "Snacks", which the empty test database lacks, so every row is now (correctly) rejected. The updated test creates the category and **passes** when run on its own. | n/a |
| `migrate-on-build` × 3 | Connection timeouts to the local scratch PostgreSQL (`CONNECT_TIMEOUT 127.0.0.1:55532`) | **Yes — the same 3 fail on `staging` a69f60a8** in this environment |

CI on GitHub (fresh PostgreSQL service) is the deciding run once the branch is pushed.

## 5. Not done / open

- test.gokesari.com and gokesari.com: not deployed; nothing is claimed there.
- Opening the template in Excel, Google Sheets and LibreOffice by hand.
- Android / iOS app on a real phone (the apps show the same web screen).
- Merged cells, a file saved by Google Sheets, slow network, session expiry mid-upload: not tested this round.
