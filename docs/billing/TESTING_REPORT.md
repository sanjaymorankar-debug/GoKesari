# Billing v2 — testing report

Build prompt §13. Updated **01-Nov-2026** (IST). All eight phases: audit, money flow and tax engine (1), documents and checkout (2), ECO compliance — TCS, TDS, GSTR-8, statements (3), books, journals, reports (4), canonical model, sync engine, file connectors (5), GST portal through the GSP (6), live connectors and public API (7), offline counter POS (8).

## Local (developer Mac, Postgres.app 18)

| Item | Value |
|---|---|
| Branch | `feat/billing-v2-phase1` (PR #321 into `staging`), from `staging` `2f221d1d` |
| Commits | phase 1 `d6eac68f`, 2 `8d84ac4c`, 3 `8d1a52ad`, 4 `7641bce2`, 5 `2e558d50`, 6 `e83a51f0`, 7 `bef125a3`, 8 `5489b76a`, scenario 17 test `3c3dfba8` |
| Migrations | 0125–0134 (seller: 0125, 0128, 0130, 0131, 0134; core: 0126, 0127, 0129, 0132, 0133), each with `scripts/rollback-01xx.sql` |
| Layouts | single database, and the two-database split (core + seller, built with `scripts/db-split/test-layout.ts`) |
| Typecheck / lint | `tsc --noEmit`: no new errors (pre-existing errors in `scripts/backfill-delivery-partner-kyc.ts` and `src/server/pmd/sources/xlsx.ts` are on `staging` too); `eslint` clean on every changed file |
| GSP / IRP | the built-in mock GSP (no GSP contract yet — BLOCKERS B1) |

### Must-cover scenarios (§13)

| # | Scenario | Tests | Single | Split |
|---|---|---|---|---|
| 1 | Intra-state B2C (CGST+SGST); inter-state B2B (IGST) with buyer GSTIN | `tax-engine` "whole bill 1a, 1b", "line tax"; `billing-documents` "B2B GSTIN at checkout and the invoice" | Pass | Pass |
| 2 | Composition → bill of supply; inter-state blocked | `tax-engine` "2", "order guard"; `billing-documents` "checkout guard"; `billing-gsp` "CMP-08" | Pass | Pass |
| 3 | Enrolment-ID → no TCS, intra-state only, still in GSTR-8 | `tax-engine` "3", "TCS"; `billing-money-flow` "an Enrolment-ID shop"; `billing-compliance` "GSTR-8 … Enrolment-ID suppliers with no TCS" | Pass | Pass |
| 4 | Delivery GST 31 Oct 18% / 1 Nov 5% without ITC in GoKesari's GSTIN; registered rider → none | `tax-engine` "delivery fee s.9(5)"; `billing-money-flow` (2 tests); `billing-documents` "GoKesari's s.9(5) delivery-fee invoice"; `billing-compliance` "Table 15 and 3.1.1(i)" | Pass | Pass |
| 5 | Cancellation before packing → full refund, stock restored; partial return → credit note | `cancellation-before-packing` (existing); `billing-documents` "credits the returned lines only". No credit note before packing: no invoice exists yet (DECISIONS D17) | Pass | Pass |
| 6 | TCS 0.5% on net after returns; GSTR-8 JSON validates | `tax-engine` "TCS s.52"; `billing-compliance` "TCS follows the money-flow record", "GSTR-8 … validates; filed once" | Pass | Pass |
| 7 | TDS 0.1%; ₹5 lakh exemption with PAN; 5% without PAN | `tax-engine` "TDS s.393 scope"; `billing-compliance` "two shops of one individual share the yearly limit"; existing payout TDS tests | Pass | Pass |
| 8 | Wallet deductions → GoKesari tax invoice → shop's 2B / IMS flow | `billing-compliance` "the shop's statements"; `billing-gsp` "IMS and the cash ledger"; `billing-books` "posts … the payout's fees and taxes" (fee invoices per payout cycle, D20) | Pass | Pass |
| 9 | Tally Excel + `.tsf` + XML; round trip; re-export does not duplicate | `billing-sync` "Tally: exports XML + Excel + mapping; the XML reads back the same; re-export reports unchanged"; `billing-live` "Tally connector: two-way books" | Pass | Pass |
| 10 | Tally / Busy / Vyapar / myBillBook files → masters, vouchers, stock | `billing-sync` "imports from Busy, Vyapar, myBillBook and Tally Excel" (4 tools) | Pass | Pass |
| 11 | Zoho Books and Odoo push and pull | existing `accounting-integration` (mocked APIs); `billing-live` "each connector flag switches on its own provider". Against the vendors' sandboxes: not run (B6) | Pass (mocked) | Pass (mocked) |
| 12 | Same voucher edited in GoKesari and Tally → conflict queue | `billing-sync` "conflicts" | Pass | Pass |
| 13 | GSTR-1 (Tables 12, 13, 14) validates; 2B pull and IMS; GSTR-3B | `gst-compliance` (existing + ECO rows); `billing-documents` "GSTR-1 counts it as cancelled"; `billing-gsp` "GSTR-1 on the portal", "GSTR-3B … IFF", "IMS" | Pass (mock GSP) | Pass (mock GSP) |
| 14 | IRN generate and cancel; e-way bill generate and cancel | `billing-gsp` "e-invoice and e-way bill" (3 tests); existing e-invoice tests | Pass (mock IRP) | Pass (mock IRP) |
| 15 | GST session expiry → re-link prompt; GSP down → retry and manual fallback | `billing-gsp` "session expiry and GSP down" (2 tests) | Pass | Pass |
| 16 | Offline POS → sync without number gaps or duplicates | `billing-pos` (3 tests: out-of-order and repeated / parallel sync, removed item, price and stock warnings, API) | Pass | Pass |
| 17 | Shop A cannot read shop B; dealer cannot see accounts | `billing-security` (another owner, dealer, operator, limited operator, customer, rider refused on 6 billing endpoints; public-API token sees only its shop) | Pass | Pass |

Also covered: flags off → nothing changes (every billing test file has an "off" case), immutable issued documents (database triggers), shop documents (credit / debit notes, vouchers, challan, estimate), thermal receipt / JSON / UPI QR / WhatsApp, books posting and reversal, journals / contra / stock journal, marketplace tax report, compliance calendar and reminders, public REST API with OAuth2 scopes and revocation, daily billing cron.

### Full suite (every test file, both layouts)

FULL_RUN_RESULTS

### Defects

| # | Found | Status |
|---|---|---|
| T1 | `TC-B26-E-045` asserted the 0083 seed of `GST_S95_LOCAL_DELIVERY`; 0126 re-dates it | Fixed: asserts 18% to 31 Oct 2026, 5% from 1 Nov 2026 |
| T2 | `product-import-parser` "PUZZLES.xlsm … only a name, only a barcode …" and `product-import` "all fields optional" fail | **Pre-existing**: fail the same way on a clean `staging` checkout; outside billing |
| T3 | A GSTIN verified after 0125 would have stayed UNREGISTERED in the engine | Fixed: `effectiveRegistrationType` falls back to `gst_status` |
| T4 | The new immutable-invoice trigger broke two old tests that rewrite issued invoices | Fixed: those tests switch the trigger off around the rewrite only (D18) |
| T5 | `dealer-step1-flags-geo` hard-coded 8 feature flags | Fixed: uses `FEATURE_FLAG_KEYS` |
| T6 | Production answers only the every-minute / hourly / daily cron routes, so a separate billing cron would never run | Fixed: billing work runs inside the daily job (`billing-daily`, D30) |
| T7 | The test site's basic auth would have blocked the bearer-token APIs | Fixed: `/api/connector/v1/` and `/api/public/v1/` exempt (D29) |
| T8 | Sync fingerprints differed between export and import (one hashed the whole record) | Fixed: shared party / item / voucher fingerprints |
| T9 | The mock IRP refuses 25-character LEGACY invoice numbers | Open as **B4**: e-invoicing needs GST16 numbering on the shop |
| T10 | Two parallel syncs of one offline bill both reported CREATED (one invoice issued) | Fixed before commit: the result says which call issued it |

## Test (test.gokesari.com)

Not run yet — the branch is not merged to `staging`. Plan after the merge: migrations 0125–0134 apply on build; post-deploy check; then with `billing_v2` (and the other flags as needed) on for the staging test shop: deliver a prepaid and a COD order, check the money-flow record and the s.9(5) delivery invoice; issue a counter bill and an offline POS bill; export the Tally pack; open GST returns on the mock GSP; run the QA suite; switch the flags back off. Payments only with Cashfree sandbox data.

## Prod (gokesari.com)

Not deployed. Waits for: the CA's answers (BLOCKERS B2, B3), a staging pass, and an owner-approved release window (B8). Flags stay OFF after the production deploy, so the deploy itself changes nothing for shops.

## Mobile

The Android and iOS apps are a WebView over the website: every billing screen, including the offline POS once open, reaches them with the web deploy. Bluetooth thermal printing, a native scanner and opening the POS with no network at all need a store release (B7).

## Sign-off

| Environment | Status |
|---|---|
| Local | Pass for phases 1–8 (pre-existing failures outside billing listed above) |
| Test | Not started |
| Prod | Not started |
