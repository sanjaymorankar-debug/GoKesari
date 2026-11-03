# Billing v2 — testing report

Build prompt §13. Updated **01-Nov-2026** (IST). All eight phases: audit, money flow and tax engine (1), documents and checkout (2), ECO compliance — TCS, TDS, GSTR-8, statements (3), books, journals, reports (4), canonical model, sync engine, file connectors (5), GST portal through the GSP (6), live connectors and public API (7), offline counter POS (8).

## Local (developer Mac, Postgres.app 18)

| Item | Value |
|---|---|
| Branch | `feat/billing-v2-phase1` (PR #321 into `staging`), from `staging` `2f221d1d`, brought up to `staging` `909de492` (security updates, PR #320) |
| Commits | phase 1 `d6eac68f`, 2 `8d84ac4c`, 3 `8d1a52ad`, 4 `7641bce2`, 5 `2e558d50`, 6 `e83a51f0`, 7 `bef125a3`, 8 `5489b76a`, scenario 17 test `3c3dfba8`, gap closure (restaurant s.9(5), settlement status, GST type, HSN import) `bf6d71be`, connector guides `1435bdfc`, merge of `staging` `fc9aa17d`, final test fixes (this report's commit) |
| Migrations | 0125–0135 (seller: 0125, 0128, 0130, 0131, 0134; core: 0126, 0127, 0129, 0132, 0133, 0135), each with `scripts/rollback-01xx.sql` |
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

Also covered: flags off → nothing changes (every billing test file has an "off" case), immutable issued documents (database triggers), shop documents (credit / debit notes, vouchers, challan, estimate), thermal receipt / JSON / UPI QR / WhatsApp, books posting and reversal, journals / contra / stock journal, marketplace tax report, compliance calendar and reminders, public REST API with OAuth2 scopes and revocation, daily billing cron. Gap closure (`billing-restaurant`, `billing-money-flow`, `billing-compliance`): restaurant food under s.9(5) — GoKesari's invoice for the food, the restaurant's bill of supply at the net price, no TCS, GSTR-1 Table 14(b) and 15, GSTR-3B 3.1.1(i), the 5% withheld from the payout, books balanced; money-flow settlement status from paid payouts; the shop's Enrolment-ID / PAN-only declaration; HSN rates imported from CSV.

### Full suite (every test file, both layouts)

Run on `fc9aa17d` (all phases, merged with `staging`) plus the T11 fix, 01-Nov-2026 12.17–13.34 IST, on databases of its own: 265 test files, 3,253 tests per layout.

| Layout | Passed | Failed | Skipped |
|---|---|---|---|
| Single database | 3,248 | 5 | 0 |
| Split (core + seller) | 3,240 | 5 | 8 (`db-split`: single-layout only, by design) |

| Failed | Why | Result |
|---|---|---|
| `product-import-parser` PUZZLES.xlsm, `product-import` "all fields optional" (both layouts) | Pre-existing (T2): fail the same way on a clean `staging` checkout; outside billing | Not billing |
| `migrate-on-build` (3 tests), and the after-all hooks of `db-split` and `split-migrate` | The developer Mac's Postgres.app stopped trusting the test's child processes mid-run (server log 12.44 and 12.53 IST: *Postgres.app failed to verify "trust" authentication*, *canceling authentication due to timeout* — its permission dialog went unanswered). Environment, not code | Re-run of the four files that create scratch databases (`migrate-on-build`, `db-split`, `split-migrate`, `db-split-switch`), 13.36–13.39 IST: single **26 / 26 passed**; split **18 passed, 8 skipped** |

Every billing test file passes on both layouts. Also: `npm run typecheck` clean; `eslint src tests` 0 errors (7 warnings, none in billing files); `npm run build` passes (CI's environment variables). The blocking CI jobs `test` and `test-split` run the whole suite again on GitHub's Postgres after the push.

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
| T11 | `migrate-on-build` "two migrations started at once" stopped with *out of shared memory*: before the test it dropped the fully migrated schema in one transaction, and with 0125–0135 that needs more locks than Postgres's default lock table (`max_locks_per_transaction` 64; CI uses the same default). Building the schema from scratch takes 6,982 locks on `staging`'s 0124 and 7,159 with 0135 | Fixed: the test starts from a new scratch database instead. The migrations themselves are unchanged and apply in one transaction as before |
| T12 | `restaurant` test left `GST_S95_RESTAURANT` switched on for the next test files | Fixed: the test restores the statutory row before and after |

## Test (test.gokesari.com)

| Item | Value |
|---|---|
| Merge | PR #321 into `staging` 01-Nov-2026 14.36 IST, merge commit `3a0ebcc5`; CI `test`, `test-split` and `build` passed on `9ca2385a` first; no other release in flight |
| Deploy | Hostinger build of `3a0ebcc5` for test.gokesari.com completed 14.41 IST |
| Migrations | "Test database" workflow (run 41291657062): split layout, **11 migrations applied (0125–0135)**, 0 repairs, 144 recorded; backup and verify passed, 14.46 IST. Staging gap (code live before its migrations): about 5 minutes, as DEPLOYMENT.md expects |
| Post-deploy check | `scripts/release/post-deploy-check.sh https://test.gokesari.com`: 5 healthy rounds in a row, 14.46–14.50 IST |

### Billing test on staging, 01-Nov-2026 14.55–16.53 IST

The five flags billing_v2, tcs_engine, tds_engine, delivery_9_5 and tally_connector were switched on for Pune (MH-PUN) only, 14.56–15.27 IST, for the E2E shop "E2E Four Features Bakery" (PIN 411005, not GST-registered), then restored. Before and after, all 11 billing flags were off for every district (0 differences). Evidence: `test-results/qa/billing-v2-staging-2026-11-01/` (log, screenshots, PDFs, JSON).

| Step | Result |
|---|---|
| Flags off → billing pages and APIs not available | Pass (`pos/items` 404; `/shop/accounts/pos` → `/shop/accounts`) |
| Shop screens: `/shop/accounts` and its 17 sections, desktop and phone | Pass |
| Counter bill S2627-00002, 80 mm receipt, UPI QR (sandbox VPA `testsuccess@gocash`), JSON | Pass; findings D-113, D-114, D-115 |
| Estimate ES2627-000001 | Pass |
| POS online (S2627-00003) and offline: saved on the device, synced as S2627-00004, two re-sends → duplicate, no gap | Pass |
| Prepaid order DB-20261101-4NGI5U (Cashfree sandbox, "Pay (success)"), delivered | Pass: shop's bill of supply BKS-000021/2026-27/000019 (A4, 80 mm, JSON); GoKesari's s.9(5) invoice GKS/2627/000001 (in GSTR-1 Table 15); money-flow row in `/admin/compliance`; findings D-112, D-116, D-117 |
| COD order | Blocked: the test customer has 2 old open COD orders (limit 2) — staging data (E-16) |
| Tally export | Fail: refused until 126 items get HSN and GST rate, though the shop is not GST-registered (D-111) |
| Reports: trial balance, balance sheet, stock, MTR, TCS/TDS credit, P&L | Pass (books balanced at ₹3,852) |
| GSTR-1 on the mock GSP | Blocked: the E2E shop has no GSTIN (the page says so, 422) |
| Statements: wallet, settlement, TCS/TDS (PDF and CSV) | Pass |
| Security: signed out 401; customer, rider-role user, operator 403; owner and admin 200 | Pass (rider and limited-operator accounts had no saved session) |
| District limit: billing_v2 set to Mysuru (KA-MYS) only, Pune shop still opened the POS | **Fail (D-110, High)** |
| Regression with flags off (guest + signed-in, desktop + phone, 15.28–16.43 IST): 435 cases, pass 258, fail 56, blocked 359, skipped 15 (31-Oct: 264 / 58 / 351 / 15) | No failure caused by billing v2 behaviour; new fails are staging data (E-16, E-17) and two sweeps that listed the bearer-token API (by design, D29) and the DigiLocker mock (E-15) |

Defects found, and what was done:

| # | Severity | Found | Fix |
|---|---|---|---|
| D-110 | High | Billing flags ignored their district list: every check asked "on anywhere", so a pilot switch-on would have started TCS / TDS / s.9(5) for every shop in India | New `isFeatureEnabledForShop` / `requireFeatureForShop` / `enabledFeatureKeysForShop` (the shop's PIN → district): the accounts API, every `/shop/accounts` page, the shop's menus, money flow, s.9(5), payout TCS / TDS (per shop), books posting, statements notices, order checkout, invoices, credit notes, public API, Tally connector, e-invoice and e-way bill routes |
| D-111 | High | Tally export refused a shop outside GST until every item had HSN and GST rate | HSN, GST rate and UQC are asked of a GST-registered shop only; unbalanced vouchers and unknown ledgers still block |
| D-112 | Medium | The customer could not reach GoKesari's s.9(5) invoice | "Delivery fee invoice (GoKesari)" / "Food invoice (GoKesari)" links on My orders and the order page |
| D-113 | Medium | A shop outside GST: counter bill page and A4 PDF said "Tax invoice", the receipt "Bill of supply"; the customer's link said "Tax invoice" | One rule (`counterBillKind`) for the page, A4 PDF, receipt and MTR; the customer's link names the issued document |
| D-114 | Medium | No screen field for the shop's UPI id | "UPI id for receipts" under Accounts → Settings (billing v2) |
| D-115 | Low | No WhatsApp share; receipt and JSON not linked | "80 mm receipt", "JSON" and "Share on WhatsApp" on the counter bill and the order's invoice page |
| D-116 | Low | A bill of supply said the ECO collects TCS under s.52 and "Prices are inclusive of GST" | Those notes on tax invoices only |
| D-117 | Low (pre-existing, 6 Oct) | "Paid by customer (GoKesari wallet)" for an online payment | "online payment" / "GoKesari wallet" / "cash on delivery" |

Not code: E-15 (QA sweeps now list `/api/public/v1/` as token-protected and the DigiLocker mock as a test-site stand-in), E-16 (staging data: COD limit, drained wallet, stale orders, rider and limited-operator sessions), E-17 (SD-01 shop state, SD-05 connection drop).

### Fixes on staging, 01-Nov-2026

| Item | Value |
|---|---|
| Merge | PR #323 into `staging` 22.27 IST, merge commit `41ef27cc`; CI `test`, `test-split` and `scope` passed on `9169ed1d` (`test` after one re-run: a rider-withdrawal test that waits for an e-mailed code, in code the PR does not touch, failed once and passed on the re-run and in `test-split`) |
| Deploy | Hostinger build of `41ef27cc` for test.gokesari.com completed 22.32 IST; no migrations |
| Post-deploy check | test.gokesari.com: 3 healthy rounds in a row, 22.34–22.35 IST |
| Retest of D-110 to D-117 on staging | Run 02-Nov-2026 11.17–11.44 IST, after the production release (the owner asked for the release first): all pass, see below |

### Retest on staging, 02-Nov-2026 11.17–11.44 IST

test.gokesari.com on `41ef27cc`. The same five flags were switched on for Mysuru (KA-MYS) only, then for Pune (MH-PUN) only, then restored: 19 flags compared before and after, 0 differences, all 11 billing flags off. Evidence: `test-results/qa/billing-v2-staging-retest-2026-11-02/` (log, 50 screenshots, 39 files); collected run `docs/testing/qa-runs/2026-11-02-staging-billing-v2-retest.json`.

| # | Result |
|---|---|
| D-110 | Pass. Flags on for KA-MYS only: the Pune shop gets 404 on all 7 billing APIs tried; POS, documents, journals, statements and sync pages go to `/shop/accounts`; no billing tiles, menu item, UPI field or bill links on desktop or phone. Flags on for MH-PUN: all served |
| D-111 | Pass. Export check: 0 fixes needed (was 254); the Tally zip downloads from the screen and the API; 6 vouchers, all balanced |
| D-112 | Pass. "Delivery fee invoice (GoKesari)" on the order page and My orders opens GKS/2627/000001 and GKS/2627/000002 (PDF, 200). customer2 404, shop 404, signed out 401, operations 200 (by design) |
| D-113 | Pass. S2627-00001 (cancelled) to -00004: "Bill of supply" on the page (desktop and phone), A4 PDF, 80 mm receipt, MTR rows and the customer's link |
| D-114 | Pass. "UPI id for receipts" saved as `testsuccess@gocash` puts a UPI QR on the receipt (`upi://pay?pa=testsuccess%40gocash…`); cleared afterwards |
| D-115 | Pass. "80 mm receipt", "JSON" (200) and "Share on WhatsApp" (wa.me link naming the document) on the counter bill and the order invoice pages; none on the cancelled bill |
| D-116 | Pass. New prepaid order DB-20261102-ERAAO8 (₹85, built-in sandbox "Pay (success)", delivered 11.38 IST): its bill of supply BKS-000021/2026-27/000020 has neither the s.52 clause nor "Prices are inclusive of GST". BKS-…/000019 keeps its old notes (notes are fixed at issue, by design) |
| D-117 | Pass. Both orders: "Paid by customer (online payment) Rs. 85.00" |
| E-15 | Pass. TC-SEC-001, TC-RBAC-002, TC-AUTH-033 (desktop, 7 rows): 211 pages, 397 write endpoints, 11 public writes and 26 cron endpoints refused |

New defects:

PR #326 (D-118, D-119, D-120): CI `test`, `test-split` and `scope` green on 7c4bf638; merged into staging 02-Nov-2026 22.40 IST (8fe24140); new build live on test.gokesari.com 22.45 IST; post-deploy check 3/3 22.45–22.47 IST. Spot check (guest): API 401 and 404 answers now carry `Cache-Control: private, no-store`. Signed-in retest: all three pass (below).

| # | Severity | Found | Status |
|---|---|---|---|
| D-118 | Medium (not billing-specific) | API error answers carry no `Cache-Control`; Hostinger's CDN (`server: hcdn`) kept a 404 for about 10–20 s and gave it to the next caller, so the customer briefly got 404 on their own invoice after customer2's refused request. 200 answers are not cached; 401 / 403 were not reused. gokesari.com's 404s also come without `Cache-Control` (checked 02-Nov-2026 as a guest) | Fixed in PR #326 (to staging): every API error answer says `Cache-Control: private, no-store`. Merged to staging 22.40 IST (8fe24140), live 22.45 IST; retest passed 02-Nov-2026 23.04–23.14 IST |
| D-119 | Low | A bill of supply still says "Invoice total (inclusive of tax)" with CGST / SGST rows in the PDF, and "Total (tax inclusive)" on the page | Fixed in PR #326: a bill of supply shows Item, HSN, Qty, Amount and "Total" (A4 PDF, 80 mm receipt, page). Merged to staging 22.40 IST (8fe24140), live 22.45 IST; retest passed 02-Nov-2026 23.04–23.14 IST |
| D-120 | Medium (older than billing v2) | Found while fixing D-119 (code, 02-Nov-2026): a shop outside GST can put a GST rate on a counter bill, a POS bill or a shop document, so its "Bill of supply" charges GST (an unregistered person may not collect tax, s.32 CGST Act). Counter-bill creation is not behind the billing_v2 flag | Fixed in PR #326: counter bills, POS bills and shop documents of such a shop go at 0% and print no tax rows; a note on an older taxed bill still reverses its GST. Merged to staging 22.40 IST (8fe24140), live 22.45 IST; retest passed 02-Nov-2026 23.04–23.14 IST |

### Retest of D-118 to D-120 on staging, 02-Nov-2026 22.59–23.16 IST

test.gokesari.com at 8fe24140. Evidence: `test-results/qa/billing-v2-staging-retest-d118-d120-2026-11-02/` (log.jsonl, files/, shots/; desktop and phone). Run: `docs/testing/qa-runs/2026-11-02-staging-d118-d120-retest.json`.

| # | Result |
|---|---|
| D-118 | Pass. Three invoice URLs (GoKesari's delivery-fee invoice PDF, the bill of supply's PDF and JSON), three rounds each, no pauses (23.04.09–23.04.45): customer 200 → customer2 404 → customer again 0.3–1.4 s later 200 → signed out 401. All 36 answers `Cache-Control: private, no-store`; no `age` header, no cache hit |
| D-119 | Pass. BKS-000021/2026-27/000020: A4, 80 mm and the page (desktop, phone) read "Bill of supply" with Item, HSN, Qty, Amount and "Total Rs. 60.00"; no "inclusive of tax", CGST, SGST, IGST, Taxable, Intra-state, Reverse charge or @0%. GoKesari's tax invoice GKS/2627/000001 still shows its CGST / SGST rows (staging has no order tax invoice from a GST-registered shop to compare) |
| D-120 | Pass (E2E Four Features Bakery, outside GST). Sale form: no GST % field, no "Prices include GST", "Create bill of supply". Counter bill sent at 5% (S2627-00005): ₹50.00, tax 0, no tax rows on page / A4 / 80 mm. With billing_v2 on for MH-PUN (23.10–23.14): POS list 0%, POS total "Total", POS bill sent at 5% (S2627-00006) ₹60.00 tax 0; document form without GST %; estimate at 18% (ES2627-000002) ₹100.00 tax 0. Older bill S2627-00001 (carried IGST) keeps its rows; S2627-00002..04 print without zero tax rows. S2627-00005, S2627-00006 and ES2627-000002 cancelled ("QA D-120 retest"); flags back with 0 differences |

Not checkable on staging: a credit / debit note against a bill that carried GST (the only one, S2627-00001, is cancelled; covered by the integration test).

New defect:

| # | Severity | Found | Status |
|---|---|---|---|
| D-121 | Low (older than PR #326) | Operations' order list (`/admin/orders`) and the shop's order list (`/shop/orders`, Done) label the link to a bill of supply "Tax invoice" (`order-monitoring-table.tsx:158`, `shop-order-manager.tsx:287`); the customer's order page already says "Bill of supply" | Fixed in PR #328 (to staging, 21169956): both lists label the link by the issued kind. Retest passed on staging 03-Nov-2026 06.33–06.36 IST (below) |

### Retest of D-121 on staging, 03-Nov-2026 06.33–06.36 IST

PR #328 (D-121): CI `test`, `test-split` and `scope` green on 21169956; merged into staging 03-Nov-2026 06.21 IST (2e47fa60); new build (`yCAHWAcv6OLthMXeyQ4Fe`) live on test.gokesari.com 06.25.56 IST; post-deploy check 3/3 healthy rounds, 06.25–06.27 IST.

test.gokesari.com at 2e47fa60, saved operations and shop-owner sessions (desktop 1366 px and phone 390 px). Evidence: `test-results/qa/billing-v2-staging-retest-d121-2026-11-03/` (log.jsonl, shots/, retest-d121.mjs). Run: `docs/testing/qa-runs/2026-11-03-staging-d121-retest.json`.

| # | Result |
|---|---|
| D-121 | Pass. `/admin/orders?status=DELIVERED` (desktop, phone): 20 links, all "Bill of supply", DB-20261102-ERAAO8 included; `/admin/orders` (all statuses): 2 links, both "Bill of supply". E2E Four Features Bakery's `/shop/orders` Done tab (desktop, phone; page 2): DB-20261102-ERAAO8 "Bill of supply". Each of the 20 links followed once as operations: every one opens a document whose page says "Bill of supply" (DB-20261102-ERAAO8 → BKS-000021/2026-27/000020), so no label disagrees with its document. On the old build (06.25 IST) the same rows read "Tax invoice" |

Not checkable on staging: a "Tax invoice" label, because no delivered order on staging has a tax invoice (every shop is outside GST); the unit test covers it, and the "Invoice" label for a delivered order not invoiced yet. A plain "Invoice" link issues the invoice when opened, so the retest followed only links that already name a document. Nothing was created or changed on staging.

Seen during the run, not a defect: refunded test orders kept arriving at the top of the bakery's Done tab (17 pages), which moved the order to page 2. Between 06.29 and 06.35 IST the operations pages took about 30 s to finish loading in the test browser, though the page itself arrived in under 1 s; at 06.38 IST every page loaded in 0.4–1.0 s.

## Prod (gokesari.com)

| Item | Value |
|---|---|
| Owner's instruction | "push all code to main" (01-Nov-2026 22.3x IST), then "Yes, migrate and merge" |
| In flight before | none: no other PR into main, last Post-deploy check (b8531a5a) passed, last Hostinger build of gokesari.com completed |
| Migrations | "Production database" workflow `migrate`, source `staging` (run 41330029033), 01-Nov-2026 22.39–22.41 IST: split layout, **11 migrations applied (0125–0135)**, 0 repairs, 136 recorded, none missing. Restore point 17:09:58 UTC, LSN `0/19BDDA10` (Neon → Restore, PROD_DB.md). Applied before the merge, as DEPLOYMENT.md requires: the old code ran on the new schema overnight (the migrations only add) |
| Merge | PR #324 (`staging` → `main`) 02-Nov-2026 08.27 IST, merge commit `85a12aa6`; CI `test`, `test-split`, `build` and `scope` passed on `41ef27cc` |
| Deploy | gokesari.com serves the new build from 08.32 IST (a new route, `/api/invoices/<id>/json`, answers 401 instead of 404) |
| Post-deploy check | `scripts/release/post-deploy-check.sh https://gokesari.com`: 5 healthy rounds in a row, 08.32–08.36 IST; "Post-deploy check" workflow run 41380443658 passed |
| Flags | All billing flags off: `POST /api/public/v1/oauth/token` → 404 "This feature is not available." The release changes nothing for shops and customers until a flag is switched on, which waits for the CA's answers (BLOCKERS B2, B3) |

## Mobile

The Android and iOS apps are a WebView over the website: every billing screen, including the offline POS once open, reaches them with the web deploy. Bluetooth thermal printing, a native scanner and opening the POS with no network at all need a store release (B7).

## Sign-off

| Environment | Status |
|---|---|
| Local | Pass for phases 1–8 and the gap closure, both layouts (full run 01-Nov-2026 12.17–13.34 IST; pre-existing and environment failures listed above) |
| Test | Pass. Staging test 01-Nov-2026 found D-110 to D-117; fixed (PR #323) and all retested as passing on 02-Nov-2026 11.17–11.44 IST. D-118 (Medium), D-119 (Low) and D-120 (Medium) fixed in PR #326 and retested as passing on staging 02-Nov-2026 22.59–23.16 IST. D-121 (Low) fixed in PR #328 and retested as passing on staging 03-Nov-2026 06.33–06.36 IST |
| Prod | Released 02-Nov-2026 08.32 IST with every billing flag off; migrations 0125–0135 applied; post-deploy check passed. Switching billing on waits for the CA (B2, B3); D-118, D-119 and D-120 (PR #326) and D-121 (PR #328), all passed on staging, should be released to gokesari.com first |
