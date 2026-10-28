# Onboarding wizard step 1 — test results (28 Oct 2026)

Branch `claude/onboarding-wizard-step1` (rebased onto staging after dealer step 7; migration renumbered 0108 → 0111 (staging took 0108–0110)).
Local PostgreSQL 18 (Postgres.app), mock KYC vendor. Run by Claude.

## New tests — `tests/integration/onboarding-wizard-step1.test.ts`

| Layout | Result |
|---|---|
| One database | **23 / 23 passed** |
| Two databases (seller tables through postgres_fdw) | **23 / 23 passed** |

| # | Case | Result |
|---|---|---|
| 1 | GSTIN verified → PAN inside it checked in the background (owner types only the GSTIN); shop name = GST trade name, legal name, constitution, address, state, PIN filled; provider references kept | Pass |
| 2 | No full GSTIN or PAN stored or returned; audit entry masked (first run caught the GST record's PAN stored in clear — fixed: only "PAN linked yes/no" is kept) | Pass |
| 3 | Proprietor: PAN holder becomes the owner name | Pass |
| 4 | Built-in mock vendor (staging) end to end | Pass |
| 5 | GSTIN not found → FAILED, message, PAN not checked, cannot continue | Pass |
| 6 | Cancelled GSTIN → FAILED, nothing filled in | Pass |
| 7 | GST record names another PAN → review, no PAN check, may continue | Pass |
| 8 | Malformed GSTIN / no consent → refused, no paid call | Pass |
| 9 | GSTIN of a live shop → 409 DUPLICATE_SHOP before any paid call | Pass |
| 10 | GSTIN of a rejected shop → allowed | Pass |
| 11 | PAN name ≠ GST names → PAN in review, may continue | Pass |
| 12 | Inactive PAN → FAILED, cannot continue | Pass |
| 13 | GST source down → PENDING, may continue; repeat within 30 s joins; later repeat re-checks | Pass |
| 14 | PAN source down → PAN PENDING; resubmit re-checks only the PAN | Pass |
| 15 | Same verified GSTIN again → no paid call | Pass |
| 16 | A different GSTIN replaces the first and everything learned from it | Pass |
| 17 | Hourly limit of paid checks (10) | Pass |
| 18 | No GSTIN: PAN + declaration verified, may continue | Pass |
| 19 | No GSTIN without the declaration → refused, no paid call | Pass |
| 20 | Switching GSTIN → PAN-only route clears the GSTIN and its data | Pass |
| 21 | Open draft resumed by its owner only | Pass |
| 22 | Two tabs at once → one draft | Pass |
| 23 | Unknown user refused | Pass |

## Full suite

| Layout | Passed | Failed | Notes |
|---|---|---|---|
| One database | 2,809 | 2 tests + 1 file hook | All pre-existing: same failures on unchanged staging 22a74db |
| Two databases | 2,800 (8 skipped) | 3 tests + 1 file hook | Same causes as below |

Failures, none from this change:

- `migrate-on-build` (one database) and `split-migrate` (two databases): every test passes — including rolling back through 0111 and re-applying it, and running 0111 on the seller side — but the clean-up hook (closing / dropping the scratch database) times out on this local PostgreSQL 18. Same on unchanged staging.
- `product-import-parser` and `product-import` (`PUZZLES.xlsm`): the empty row is not counted as skipped. Same on unchanged staging.
- `pmd-sources` streaming .xlsx reader: intermittent — passed when re-run alone.

CI (`test` and `test-split` jobs) runs on its own PostgreSQL and is the deciding check once the branch is pushed.
