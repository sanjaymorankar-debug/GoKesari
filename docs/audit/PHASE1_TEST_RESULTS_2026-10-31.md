# Phase 1 — local test results, 31 Oct 2026

Branch `feat/order-payment-gst-audit` (from `staging` b913cfb5). Local
PostgreSQL 127.0.0.1; whole suite (`tests/unit` + `tests/integration`) on both
database layouts. Not yet run: Playwright QA (tests/qa), test.gokesari.com,
gokesari.com.

| Layout | Files | Tests passed | Failed | Skipped |
|---|---|---|---|---|
| One database (`gk_p1_single`) | 250 | 3089 | 2 | 0 |
| Split, two databases (`gk_p1_core` + `gk_p1_seller`) | 250 | 3080 | 3 | 8 |

Every failure also fails on clean `staging` or is a test-teardown timeout:

| Test | Layout | Cause | On clean staging |
|---|---|---|---|
| unit `product-import-parser` "only a name … empty row" | both | ExcelJS does not write an all-empty row, so no empty row is counted | Fails |
| integration `product-import` "only a name … empty row" | both | Same cause; flaky (passed once, failed once on staging) | Fails (flaky) |
| unit `pmd-sources` "reads skipped sheets through" | split | Streaming .xlsx reader temp-file count | Fails |
| `db-split`, `split-migrate` (file level) | single | `afterAll` timed out closing connections; tests in the file passed | — |
| `migrate-on-build` (file level) | split | `afterAll` timed out dropping its database; passes when run alone | — |

New tests (all pass): `tests/unit/gst-slabs.test.ts` (13),
`tests/unit/product-upload-roundtrip.test.ts` (7), template CSV case in
`tests/integration/product-import.test.ts`.
