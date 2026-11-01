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

## Staging run — test.gokesari.com, 31 Oct – 1 Nov 2026 (after #313)

Run `docs/testing/qa-runs/2026-10-31-staging-opg-phase1-release.json`: guest + signed-in tiers, desktop and mobile. #312 and #314 (DigiLocker) deployed to the site during the run.

**New Phase 1 checks** (`tests/qa/signed-in/sellers-product-upload.spec.ts`):

| Case | Result | Seen |
|---|---|---|
| TC-OPG-001 CSV template | Pass | 40 columns incl. GST %, Goods Type; example row |
| TC-OPG-002 GST % / Goods Type drop-downs | Pass | GST list 0 … 40; Packaged, Loose |
| TC-OPG-003 Download my catalogue | Pass | E2E bakery: 126 listings; Excel and CSV share the upload header |
| TC-OPG-004 Catalogue export refused to others | Pass | customer 403, signed out 401 |
| TC-OPG-005 Preview checks | Pass | above MRP, GST 7%, loose in pcs each flagged |
| TC-OPG-006 Only rows to fix | Pass | 3 rows; job cancelled afterwards |
| TC-OPG-007 … 010 | Manual | need a cess listing, a composition shop, a failed delivery, an RTO on the site; covered by unit / integration tests |

**Regression:** 688 rows / 435 cases: pass 264, fail 58, blocked 351, skipped 15.

- **Already failing on the 24 Oct staging baseline** (not caused by this release):
  - COD-001/002;
  - PAY-007/017 (no delivery slot);
  - FUL-001…004;
  - ORD-007/012;
  - SPI-006/008;
  - DEL-020;
  - FIN-010;
  - FLD-051/056/123;
  - ONB-029;
  - DISC-004/005;
  - CART-018.
- **Different from the baseline, each explained:**
  - **E-13 (test data):** the customer test account also holds SHOP_OWNER. This breaks RBAC-003, RBAC-012 and SEC-004.
  - **E-14 (test fixed):** the HDFC return route is a public redirect by design. SEC-001 and RBAC-002 pass on re-test.
  - **D-109 (open, Low):** the packing slip of an unknown order answers 200.
  - **COD-003/012 (test data):** the account already has 2 COD orders on the way.
  - **LIST-*, DISC-017, LOC-006, FLD-021:** were blocked on the baseline and now run into the same delivery-slot and location data gaps.
- **Areas changed by #313:** no failure in invoices, GST, product upload, refund steps, returns, reassign or the delivery-code guard.
