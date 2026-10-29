# Dealer Programme across India — staging test pass, 29 Oct 2026

- **Site:** test.gokesari.com only. Production was not touched.
- **When:** 29 Oct 2026, about 10:55–11:10 IST.
- **Production:** released on 29 Oct in "Release 29 Oct (3)" (`88d288b`, by the release session), flags off; post-deploy check passed 07:42 UTC.
- **Build on staging:** `5f134ad` (all-India dealer programme + seller-verification fixes, merged
  with staging at `f2756b6`). Migration `0114_india_states` (seller database).
- **Tester:** Claude, API calls and headless Chrome with the saved staging admin, operator and
  customer sessions.
- **Evidence:** `test-results/qa/all-india/` (git-ignored, on the owner's Mac).

## Summary

| Area | PASS | FAIL | Not run on staging |
|---|---|---|---|
| States and districts | 3 | 0 | 0 |
| Add dealer (admin) and code generation | 7 | 0 | 0 |
| Flags by state | 3 | 0 | 0 |
| Screens | 2 | 0 | 0 |
| PAN / GST / Udyam verification fixes | 0 | 0 | 5 (covered by tests, see §E) |
| **Total** | **15** | **0** | **5** |

One defect was found and fixed during the pass (§A, D-4).

## A. Defect found and fixed: D-4, migration 0114 skipped on staging

First run (on `f501049`): every non-Maharashtra state was refused with "Choose the state".
The staging seller and core databases had only Maharashtra.

- **Cause:** the staging databases already had migration rows with `when` 1793161100000 and
  1793161200000 from the dealer monthly-payout branch (draft PR #271). That branch is not on
  staging. Its Hostinger preview builds run the migrations at build time against the staging
  databases. Drizzle applies only migrations newer than the last recorded one, so
  `0114_india_states` (when 1793161100000) was skipped with no error.
- **Fix:** `5f134ad` moves 0114's `when` to 1793161250000. The migration is idempotent
  (`ON CONFLICT DO NOTHING`). The payout branch moved its 0115 to 1793161300000.
- **Check:** after the Test database workflow on `5f134ad`, the staging seller database has
  36 states and 85 PIN prefixes.
- **Still open (process):** preview builds of any open PR can apply that PR's migrations to the
  staging databases. Branch `claude/peaceful-pascal-jai8w2` also carries a
  `0114_shop_document_promise` (when 1793161100000) and must be renumbered before it lands. On
  29 Oct the staging seller database's latest migration row was already 1793161400000, newer
  than anything on staging.

## B. States and districts

| # | Case | Result |
|---|---|---|
| S1 | `GET /api/geo-areas?state=MH` lists Maharashtra's districts | PASS |
| S7 | `GET /api/geo-areas?state=KA` lists Mysuru after it was added (code `KA-MYS`, short code `MYS`, parent `KA`) | PASS |
| — | Staging seller database: 36 STATE areas, 85 PIN prefixes | PASS |

## C. Add dealer (Admin → Dealers → Add dealer)

| # | Case | Result |
|---|---|---|
| S2 | Karnataka + new district "Mysuru" → approved, code `GKS-KA-MYS-GVERY9` | PASS |
| S3 | Karnataka + "mysuru" again → existing district reused, new unique code `GKS-KA-MYS-P2U885` | PASS |
| S4 | Tamil Nadu, whole state → `GKS-TN-FGXFW9` | PASS |
| S8 | Maharashtra, existing district Nashik → `GKS-MH-NSK-68TJ88` | PASS |
| S5 | Operator tries to add a dealer → 403 | PASS |
| S6 | Unknown state `ZZ` → 422 "Choose the state." | PASS |
| S9 | Karnataka with a Maharashtra district → 422 "Choose a district of that state." | PASS |

Test dealers left on staging: "QA Karnataka Test Dealer", "QA Karnataka Test Dealer 2",
"QA Tamil Nadu Test Dealer", "QA Nashik Test Dealer" (no sign-in accounts).

## D. Flags by state

| # | Case | Result |
|---|---|---|
| F1 | `dealer_programme_enabled` set to `KA` (whole state) + `MH-PUN` → saved and audited | PASS |
| F2 | Unknown code `ZZ` → 422 "Unknown state or district: ZZ." | PASS |
| F3 | Dealer application offers Karnataka, Mysuru, Maharashtra and the Pune areas | PASS |

`dealer_programme_enabled` on staging is left as **KA + MH-PUN**; the other three flags are
**MH-PUN** only.

## E. Screens

| # | Case | Result |
|---|---|---|
| U1 | Admin → Dealers → Add dealer: Karnataka lists Mysuru, "Whole state" and "+ Add a new district…"; the new-district name field appears (`admin-add-dealer.png`) | PASS |
| U2 | Dealer application at phone width (390 px): state picker, "Karnataka (whole state)", "Mysuru (whole district)" (`dealer-apply-state.png`) | PASS |

## F. PAN / GST / Udyam verification fixes

Not run on staging: each case needs a new shop going through the government checks in a
particular order, which the staging sandbox cannot set up on demand. They are covered by
integration tests that ran locally and in CI on both database layouts
(`tests/integration/dealer-step4-*.test.ts`, "verification review fixes (29 Oct)"):

1. GSTIN verified first, then a PAN that is not the GSTIN's PAN → manual review, `pan_gstin_mismatch`.
2. A reviewer cannot approve a row that is still being checked or is already verified, or a
   row that changed after they opened it.
3. A reviewer's approval survives the periodic re-check; a cancelled source undoes it.
4. The state comes from any Indian PIN code, or from the shop's state when the PIN is unknown.
5. Saving or approving the last licence (FSSAI) re-runs the shop's approval check.

## G. Tests before the push

- Fresh database from every migration: dealer, wizard, licence and verification suites
  1,090 / 1,092; full suite 2,919 / 2,922. The failures are the three Excel-file tests that also
  fail on this Mac without these changes; one database-split suite timed out locally during
  setup (local slowness).
- CI passed on `f501049`, `5f134ad` and `dc4718f` (including the two-database layout; the `dc4718f` test job took 60 min, twice the usual, but passed). The Test database workflow passed on `f501049` and `5f134ad`.
