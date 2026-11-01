# Billing v2 — testing report

Build prompt §13. Updated **01-Nov-2026** (IST). Phase 1 only (audit, money flow, tax engine, shop GST status, s.9(5) rates, flags).

## Local (developer Mac, Postgres.app 18)

| Item | Value |
|---|---|
| Branch / commit | `feat/billing-v2-phase1` (the commit that adds this report: `git log -1 -- docs/billing/TESTING_REPORT.md`) (from `staging` `2f221d1d`) |
| Layouts | single database (`gk_bill_single`) and two-database split (`gk_bill_core` + `gk_bill_seller`, built with `scripts/db-split/test-layout.ts`) |
| Typecheck / lint | `tsc --noEmit`: no new errors (the pre-existing errors in `scripts/backfill-delivery-partner-kyc.ts` and `src/server/pmd/sources/xlsx.ts` are on `staging` too); `eslint` clean on every changed file |

### New tests

| Scenario (§13) | Test | Single | Split |
|---|---|---|---|
| 1 Intra-state B2C (CGST+SGST), inter-state B2B (IGST) | `tests/unit/tax-engine.test.ts` "whole bill 1a, 1b" | Pass | Pass |
| 2 Composition → bill of supply, inter-state blocked | unit "whole bill 2", "order guard" | Pass | Pass |
| 3 Enrolment-ID → no TCS, intra-state only | unit "TCS", "order guard"; `tests/integration/billing-money-flow.test.ts` "an Enrolment-ID shop" | Pass | Pass |
| 4 Delivery GST 31 Oct 18% / 1 Nov 5% / registered rider | unit "delivery fee s.9(5)"; integration "s.9(5) delivery GST", "a GST-registered delivery partner" | Pass | Pass |
| 6 TCS 0.5% on net after returns | unit "TCS s.52" (GSTR-8 schema: phase 3) | Pass | Pass |
| 7 TDS scope (rate / ₹5 lakh / no-PAN maths: existing payout tests) | unit "TDS s.393 scope" | Pass | Pass |
| 5.1 Money flow: prepaid via GoKesari partner; COD by the shop's own delivery; CA switch | integration (6 tests) | Pass | Pass |
| Flag off → nothing recorded | integration "records nothing while billing_v2 is off" | Pass | Pass |

Not yet covered (later phases): 5, 8–17.

### Regression (existing suites touched by the change)

`batch-e-invoices`, `batch-e-payouts`, `batch-e-platform`, `cancellation-before-packing`, `fulfilment-options`, `gst-compliance`, `migrate-on-build`, `orders-status-route`, `gig-worker-orders`, and all of `tests/unit`.

| Layout | Result |
|---|---|
| Single | 85 files, 1,087 tests: 1,085 passed, 2 failed (T1 fixed and re-run: `batch-e-platform` 10/10 pass; T2 pre-existing) |
| Split | 85 files, 1,087 tests: 1,085 passed, 2 failed (same T1 → fixed, re-run 10/10 pass; same T2) |

### Defects

| # | Found | Status |
|---|---|---|
| T1 | `TC-B26-E-045` asserted the 0083 seed of `GST_S95_LOCAL_DELIVERY` (disabled, 18%, open-ended); 0126 deliberately re-dates it | Fixed: test now asserts 18% to 31 Oct 2026 and 5% from 1 Nov 2026 |
| T2 | `tests/unit/product-import-parser.test.ts` "PUZZLES.xlsm … only a name, only a barcode …" fails | **Pre-existing**: fails identically on a clean `origin/staging` checkout; not touched by this work. Open, outside billing scope |
| T3 | A GSTIN verified after migration 0125 would have stayed UNREGISTERED in the engine (verification writes `gst_status`, not the new column) | Fixed before commit: `effectiveRegistrationType` falls back to `gst_status` (unit + integration tests) |

## Test (test.gokesari.com)

Not run yet — the branch is not merged to `staging`. Plan: after merge, migrations 0125/0126 apply on build; then with `billing_v2` (and `delivery_9_5`) on for the staging test shop, deliver a prepaid order and a COD order and check `order_money_flows`; check the Feature flags screen lists the 11 flags; switch flags back off.

## Prod (gokesari.com)

Not deployed. Waits for: the CA's answers (BLOCKERS.md B2, B3), a staging pass, and an owner-approved release window (B8). Flags stay OFF after the production deploy.

## Mobile

No native change in phase 1. The apps are a WebView over the website, so the admin flag screen change reaches them with the web deploy.

## Sign-off

| Environment | Status |
|---|---|
| Local | Pass for phase 1 (one pre-existing failure outside billing, T2) |
| Test | Not started |
| Prod | Not started |
