# Billing, GST, accounting & sync — audit of the codebase

Audit date: **01-Nov-2026** (IST), branch `feat/billing-v2-phase1` from `staging` at `2f221d1d`.
Measured against the build prompt "GoKesari Billing, GST, Accounting & Inventory Sync Module" (1 Nov 2026), gaps G1–G17.
Status: **Exists** / **Partial** / **Missing** at the start of the work; the last column says what phase 1 of this branch changed.
Decisions taken along the way: [DECISIONS.md](DECISIONS.md). Blockers needing the owner: [BLOCKERS.md](BLOCKERS.md).

## Summary

GoKesari already has a large part of the module, built in batch-2026-10 (WS-E), Module 2 (inventory & accounting, migration 0076) and the integrations work (0069). Rates are dated data with admin screens; invoices, credit notes, GSTR-1 export, e-invoice/e-way bill (mock GSP), TCS/TDS at payout, GoKesari's own fee invoices, a shop book-keeping module (counter sales, purchases with OCR, stock with FIFO/weighted average), and Tally/Zoho/Odoo connectors all exist.

The biggest gaps:
1. **No money-flow record** (who received the customer's money) — TCS/TDS ignore it. *Phase 1: built.*
2. **No s.9(5) delivery-fee GST** and no GoKesari invoice for the delivery fee; the 1 Nov 2026 rate change (18% → 5%) is not in the data. *Phase 1: rates and per-order decision built; the invoice is phase 2.*
3. **No Enrolment-ID / PAN-only shop type; no inter-state checkout guard.** *Phase 1: type stored, guard logic built and tested; checkout wiring is phase 2.*
4. **No real GSP** — only an in-process mock, refused on production. Every live GST portal feature (§9) waits on a GSP contract.
5. **Invoice numbering default (LEGACY) is 25 characters**, above the 16 allowed by Rule 46 and the e-invoice schema; GST16 exists but is not the seeded default. Invoices cannot be cancelled (no status).
6. **No customer B2B GSTIN at checkout**; cancellation before packing gets no invoice and so no credit note; credit notes are pro-rata, not by returned line.
7. **Accounting is not fed by online orders, wallet or settlement**; no Contra/Journal/Stock Journal, no balance sheet, no per-shop chart of accounts.
8. **Sync engine is switched off** (rule `inventorySync`), has no conflict queue, no master push, and no Busy/Marg/Tally-Excel/.tsf/Zoho-CSV/Odoo-CSV file paths; no public REST API.
9. **Mobile apps are an Expo WebView wrapper** — web features reach them at once, but offline POS, Bluetooth thermal printing and native scanning need native work and a store release.

## §2 Tax master and product master (G7)

| Requirement | Status | Evidence | Gap | Phase 1 |
|---|---|---|---|---|
| 2.1 HSN/SAC master with rate, cess, UQC, dates | Partial | `hsn_tax_rates` (prefix, rate_bp, cess_bp, description, effective_from/to; 0070); admin `/admin/gst-config`; `hsnFallbackRate` `src/server/gst/rules.ts:58` | Fallback by prefix only; no UQC, no SAC flag; not seeded ("filled by the CA") | — |
| 2.2 Product fields | Partial | `products.hsnCode/gstRateBp/mrpPaise/barcode`; `shop_products.hsnCode/gstRateBp/cessBp`; master rate change audited (`gst/product-rates.ts`); batches/expiry `inv_batches`; opening stock (OPENING movement) | No UQC; no tax-inclusive flag (online prices always inclusive); shop-level override has no reason/audit; rate not derived from HSN first | — |
| 2.3 Unit → UQC mapping, block export | Partial | Hard-coded `uqcFor()` `integrations/canonical.ts:120` (falls back to NOS); `lib/accounts/units.ts:48` | No per-shop mapping table, no export block, no fix-it list | — |
| 2.4 One tax engine | Partial | Logic spread over `services/invoices.ts` (`buildSnapshot`, `splitInclusive`, `lineTax`), `invoicing/place-of-supply.ts`, `payouts/cycle.ts` | No single module | **Built**: `src/server/tax/engine.ts` (document kind, supply type, B2B, line tax, inter-state guard, TCS, TDS scope, s.9(5)); 35 unit tests, every branch. Not yet called by invoice issuing (D3). |

## §3 Shop GST status (G5)

| Requirement | Status | Evidence | Gap | Phase 1 |
|---|---|---|---|---|
| 3.1 Regular / Composition / Enrolment ID / PAN-only | Partial | `gstStatusEnum` (`schema.ts`); KYC GSTIN verification (gridlines, sandbox-co) in `services/seller-verification.ts`; Enrolment ID only as an unverified detail in `declareNoGstin` | No Enrolment-ID or PAN-only type | **Built**: `shops.gst_registration_type`, `gst_enrolment_id` (0125), backfilled from `gst_status`. Capture step in onboarding: phase 2. |
| 3.2 Legal/trade name, state, status, re-verify, pause | Partial | `legalBusinessName`, `gstTradeName`, `gstVerifiedAt`; `gstin_lookups`; monthly re-check `seller-verification-jobs.ts` (`gstRecheckDays` 30) suspends a lapsed GSTIN | No portal status / state code on shops; no re-check on GSTR sync | **Built**: `gst_portal_status`, `gst_state_code`, `gst_portal_checked_at` (0125); engine pauses non-ACTIVE (`supplyBlock`). Writing them from the re-check: phase 2. |
| 3.3 Intra-state-only guard; TCS by type | Missing / Partial | `UNREGISTERED_SELLER_RULES.interStateAllowed` read only by `payouts/cycle.ts:293` | No checkout block | **Built** in engine (`supplyBlock`, tested); checkout wiring phase 2. TCS by type: engine `tcsFor`. |
| 3.4 Auto-approval incl. GST status | Exists (partial) | `services/gov-auto-approval.ts`, flag `gov_verification_auto_approval_enabled` | Doesn't read the new type | phase 2 |
| 3.5 PAN-only professionals | Missing | — | — | **Switch built**: rule `billing.panOnlyServiceRule` (HOLD default, D10); enforcement phase 2 |

## §4 Customer billing documents (G8, G9)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| 4.1 Document types | Partial | `tax_invoices.kind` TAX_INVOICE / BILL_OF_SUPPLY; `credit_notes`; counter sales `acc_sales_invoices` | No debit note, receipt voucher, refund voucher, delivery challan, estimate |
| 4.2 Numbering ≤16, gapless, never changed | Partial | `invoice_counters`, `credit_note_counters` per shop per FY inside the issuing transaction (`services/invoices.ts:389-404`); `formatDocumentNumber` | **Seeded default LEGACY = 25 characters (> 16)**; only two series; no cancellation status |
| 4.3 Mandatory fields | Partial | `invoiceTextLines` `services/invoices.ts:506-592` | UQC not printed; POS shown by name not code; no ECO GSTIN; no digital signature; buyer GSTIN only from a buying shop |
| 4.4 B2B checkout with live GSTIN check | Missing | Only shop-to-shop orders (`orders.buyerShopId`) | No customer GSTIN field; `checkGstin` reusable |
| 4.5 Credit note on every refund, by returned line | Partial | `issueCreditNoteForRefund` `gst/credit-notes.ts:77`; `creditNoteOnOrderReversal` | Invoice only at DELIVERED → cancellation before packing has no invoice/credit note; credit pro-rata over all lines; restock only informs external software |
| 4.6 PDF A4 + 80 mm, WhatsApp/email, UPI QR, IRN QR, JSON | Partial | A4 text PDF (`lib/pdf.ts`), email, B2C QR / signed IRN QR (`invoicing/delivery.ts`) | No thermal, WhatsApp, UPI QR, public JSON |
| 4.7 POS in the same series, offline | Partial | Counter sales `accounts/sales.ts` (web) | Separate series ("S" prefix); no offline/sync |

## §5 GoKesari as ECO (G1–G4, G6, G16, G17)

| Requirement | Status | Evidence | Gap | Phase 1 |
|---|---|---|---|---|
| 5.1 Money-flow record | Missing | `orders.paymentMethod`; COD collector inferred in `services/cod.ts:133` into `financial_adjustments` only | No per-order record; TCS/TDS ignore it | **Built**: `order_money_flows` (0126) + rule `billing.collectorByMode`, written at DELIVERED under `billing_v2` (`src/server/tax/money-flow.ts`) |
| 5.2 Delivery GST s.9(5) | Missing | `GST_S95_LOCAL_DELIVERY` seeded disabled at 18%, read nowhere | No 5% from 1 Nov 2026; no rider GST status; no GoKesari delivery invoice | **Built**: rider `gst_registered`/`gstin`; dated rows 18% → 31 Oct, 5% from 1 Nov (D11); per-order liability and amount recorded under `delivery_9_5`. Invoice + GSTR-1 entry: phase 2 |
| 5.3 Restaurant s.9(5) | Partial | `GST_S95_RESTAURANT` (disabled), informational payout line, skips TCS (`cycle.ts:296`) | No deemed-supplier invoice / GST to customer | engine: `tcsFor(deemedSupplier)` |
| 5.4 TCS s.52, GSTR-8 | Partial | 0.5% dated row; per-order TCS at payout, split, reversed on returns (`cycle.ts:300-313`); `buildTcsReport` | Ignores who collected; no B2B/B2C split, amendments, GSP push, filing status, due alerts, per-shop certificate, ONDC | engine `tcsFor` + per-order `tcs_applicable`; payout use under `tcs_engine`: phase 3 |
| 5.5 TDS s.393 | Partial | 0.1% / 5% no PAN / ₹5 lakh individual-HUF exemption (`cycle.ts:316-353`); `buildTdsReport` | Base excludes GST by default (CA); running total per shop not per PAN; no Aadhaar; payout-only timing; no Form 140 quarterly export or certificates | engine `tdsApplies` + per-order `tds_applicable`; rest phase 3 |
| 5.6 Settlement ledger, fee invoices, wallet statement | Partial | `order_financials`, `payout_cycle_lines`, statements; immutable shop wallet; `platform-invoices/service.ts` (commission, delivery, platform, registration, billing mgmt @18%, CN/DN) | Fee invoices weekly per cycle, not monthly consolidated; no managed-service / support / dealer fee types; no receipt voucher for top-ups; no monthly wallet statement | phase 2 |
| 5.7 GoKesari's own returns | Partial | `buildPlatformGstr1` download | No 9(5) supplies, 3B, GSTR-8 filing, IMS, own e-invoice, compliance calendar | phase 3 |

## §6 Shop accounting and inventory

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Chart of accounts, Tally groups | Partial | Fixed `BOOK_ACCOUNTS` `src/lib/accounts/constants.ts:59-77`; Tally names only in export map `accounts/reports.ts:279-296` | No per-shop chart, groups or user ledgers |
| Ledgers incl. TCS/TDS receivable, commission, delivery expense | Partial | Parties `acc_parties`; GST in/out accounts | No TCS/TDS receivable, commission or delivery expense ledgers |
| Voucher types | Partial | PURCHASE, SALE, PAYMENT, RECEIPT, EXPENSE, WRITE_OFF, OPENING, REVERSAL | No sales/purchase return, Contra, Journal, Stock Journal |
| Auto-post every event | Partial | `postVoucher` `books.ts:38-73` for counter sales, purchases, payments, expenses, openings | Online invoices, credit notes, wallet and settlement post nothing |
| Reports | Partial | Day Book, party ledger, P&L, ageing, cash book, GST registers exist; `trialBalance()` unused | No Balance Sheet; no TCS/TDS credit report; TB not exposed |
| Stock items, batches, expiry, valuation | Exists | `shop_products`, `inv_batches`, `inv_settings.valuation_method` (FIFO/weighted) | — |
| Stock groups, godowns, transfers | Missing | Only ONLINE/OFFLINE channel | — |
| Reserve → deduct on dispatch → restock | Partial | Triggers write SALE at checkout (0076), SALE_RETURN on cancel (0078), return restock | No reserve/dispatch split |
| Movement / ageing reports | Partial | Stock summary with low-stock, per-item ledger, expiry list | No period movement, no ageing |
| Purchases: OCR with review | Exists | `capture/extract.ts`, `inv_bill_captures`, `confirmPurchase` | — |
| Fetch supplier e-invoices via GSP | Missing | GSP interface has no fetch | — |
| 2B/IMS match accept/reject/pending | Partial | `runReconciliation` `accounts/gst.ts:237` (matched/mismatch/missing) | No owner actions, no IMS |

## §7 Canonical model and sync engine (G12)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Canonical model | Partial | `integrations/canonical.ts` (Item, Party, Line, Invoice, CreditNote, StockAdjustment) | No Company, Ledger, Ledger Group, Stock Group, Unit, Godown, Batch, generic Voucher, Opening Balance |
| Connectors via canonical only | Exists | Adapter interface `integrations/types.ts:55-91` | Tally XML report bypasses it |
| Sync log fields | Partial | `integration_sync_log`, `integration_jobs`, `integration_item_links` | No last_hash, no direction, no per-entity record |
| Masters before vouchers | Missing | Job kinds PUSH_INVOICE / PUSH_CREDIT_NOTE / PULL_ITEMS / TEST_CONNECTION | No master push |
| Idempotent upsert on external key | Exists | `idempotency_key`; Tally voucher type + number in FY | Tally key uses FY range, not date |
| Conflict queue | Missing | Fixed precedence `pull.ts:11-17` | — |
| Validation before export | Partial | Errors at push time | No pre-export fix list; UQC silently NOS |
| Queue, backoff, dead-letter, dashboard | Exists | `jobs.ts` (backoff, 8 attempts, DEAD + retry), sweep, `/shop/settings/integrations`, `/admin/integrations` | **Whole engine off** (rule `inventorySync`, "descoped") |

## §8 Connectors (G13–G15)

| Tool | File path (phase 1) | Live path (phase 2) |
|---|---|---|
| TallyPrime | Partial — Tally XML export of vouchers + party masters (`accounts/reports.ts:317-372`). Missing: Excel import layout, `.tsf` templates, import of Tally files | Exists, limited — Windows connector `connector/tally` (localhost:9000, per-shop token): pulls items, pushes sales + credit notes |
| Zoho Books | Missing (API only) | Exists for invoices / credit notes / items (REST v3, OAuth, India fields); no bills, contacts |
| Busy | Missing | Missing (not yet listed as a blocker) |
| Marg ERP | Missing | — |
| Vyapar, myBillBook | Partial — item import + generic Excel/CSV export, not the tools' own templates | — |
| Odoo | Missing (no CSV) | Exists (JSON-2 API) |
| Generic | Partial — item import + Excel/CSV export; no canonical JSON / template pack | Missing — no public OAuth2 REST API (only a product-master OpenAPI) |
| MTR-style B2B/B2C report | Partial — sales register without HSN/rate/cess/B2B flag/ECO GSTIN; GSTR-1 export | — |
| Settlement report per order | Partial — per payout cycle | — |
| TCS report per shop, scheduled | Partial — admin-wide only | — |
| Template pack; help pages EN/HI/MR | Missing | — |

## §9 GST connectivity per shop

GSP: `GSP_PROVIDER` accepts only `mock` (`src/lib/env.ts:191`), refused on production (`env.ts:421`); two adapter interfaces (`gst/gsp/types.ts`, `accounts/gst-returns-provider.ts`); Masters India / ClearTax / IRIS / Vayana are placeholders answering NOT_CONFIGURED.

| Requirement | Status | Gap |
|---|---|---|
| 1 Connect GSTIN (OTP) | Partial — `accounts/gst.ts:60-121`, `/shop/accounts/gst` | No enable-API-access guide; no pre-expiry prompt |
| 2 GSTIN validation / search | Partial — `/api/gst/gstin/validate` (mock) | Not used for buyer/supplier GSTINs |
| 3 GSTR-1 / IFF | Partial — `gst/gstr1.ts` b2b, b2cl, b2cs, cdnr/cdnur, Table 12, 13; JSON + Excel | No exports, nil/exempt, **Table 14 (ECO)**, IFF, save/file/EVC |
| 4 GSTR-2B and IMS | Partial — pull (mock) / upload, reconciliation | No IMS actions |
| 5 GSTR-3B | Partial — liability estimate `gst.ts:421` | No 3B tables, TCS credit, filing |
| 6 Cash/credit/liability ledgers | Missing | — |
| 7 E-invoice | Partial — generate/store IRN, ack, signed QR (`gst/einvoice.ts`) | AATO is self-declared; **no IRN cancel**; 30-day limit not enforced; credit notes get no IRN |
| 8 E-way bill | Partial — generate (`einvoice.ts:185-242`) | No Part B update/extend, cancel unused, no auto distance |
| 9 CMP-08 / GSTR-4 | Missing | — |
| 10 Return calendar, reminders, GSP call log | Partial — due dates + `sendGstReminders` (in-app + email) | No WhatsApp, no per-period filing status, no full GSP call log |
| 11 Manual fallback | Exists — upload 2B/2A/1, download GSTR-1 | — |

## §10 Security, privacy, audit

| Requirement | Status | Gap |
|---|---|---|
| Encryption, masking, audited reveal | Partial — AES-256-GCM `lib/pan-crypto.ts` (PAN, bank, rider IDs); `integrations/credentials.ts`; `revealPanForAdmin` audited | No GSP token/credential store (no GSP); no key versioning |
| Role isolation | Partial — books: owner + SYSTEM_CONFIG only (`accounts/access.ts`) | Operators can retry sync and generate IRN / e-way bills (not read-only) |
| Immutable audit log | Partial — `audit_logs` append-only trigger (0018); invoice, credit note, rate, GST config, GSTIN lookup, e-invoice, payout, integration actions | No invoice cancel, filings, per-GSP-call log |
| ≥ 8-year retention, DPDP | Partial — tax documents `onDelete: restrict`; consents | No written 8-year policy; no buyer-GSTIN consent |
| Rate limits / retries | Partial — KYC, e-invoice sweeps | No GSP rate limiter |

## §11 UI

| Area | Status | Gap |
|---|---|---|
| Tile Board layout | Partial — role boards and accounts hub | GST/returns/admin tax pages scroll |
| Shop: billing, POS, documents | Partial — `/shop/accounts/sales/new`, `/shop/finance` | No POS screen |
| Shop: inventory, accounts | Exists | — |
| Shop: GST | Partial — `/shop/accounts/gst`, `/reconcile`, `/shop/gst-returns` | IMS, filing |
| Shop: sync | Partial — hidden while `inventorySync` is off; no conflicts view | — |
| Shop: statements | Partial — payout statements, fee invoices, wallet | No TCS/TDS certificates |
| Admin: tax config, flags, sync health | Exists — `/admin/gst-config`, `/admin/statutory`, `/admin/feature-flags`, `/admin/integrations` | — |
| Admin: GSP config, own returns dashboard, compliance calendar | Missing / Partial (GSTR-1/TCS/TDS CSV) | — |
| Operator read-only | Partial | Can act on sync / IRN |
| Customer: download invoices / credit notes | Exists | — |
| Customer: add GSTIN for B2B | Missing | — |

## §13 Testing

Existing: `tests/integration/gst-compliance.test.ts`, `inventory-accounting.test.ts`, `batch-e-invoices/-platform/-payouts.test.ts`, `cancellation-before-packing.test.ts`, unit parsers and `tally-connector`; QA Playwright TC-FIN-028..032, TC-OPG-001..010. CI: `test` and blocking `test-split` jobs; `post-deploy.yml` checks the site answers. No GSP sandbox; no tests for IRN cancel, e-way bill, session expiry, offline POS; no `TESTING_REPORT.md`.

Phase 1 adds `tests/unit/tax-engine.test.ts` (scenarios 1–4, 6, 7 at engine level) and `tests/integration/billing-money-flow.test.ts` (scenarios 3, 4, 7 end to end), run on both database layouts.

## §14 Mobile apps

Expo SDK 57 / React Native 0.86 WebView wrapper (`mobile/`, v1.6.0): every web page is in the app. Exists: bill photo OCR, downloads + `expo-print`, web camera scanning, version check (`/api/app/version`) that sends users to the store / APK. Missing: offline POS (offline screen only), Bluetooth thermal printing, native scanner, over-the-air native updates (no expo-updates), EVC filing.

## §15 Product tracker

Trackers exist: `docs/gokesari-audit/GOKESARI_FEATURE_STATUS_REPORT_<date>.xlsx` (Feature Register, Process Flow Tree, PR Register, Blockers & Decisions), `docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx`, `test-cases.xlsx`. None has gap id, Test/Prod environment or web/Android/iOS columns — the billing tracker adds them (`docs/billing/BILLING_TRACKER_2026-11-01.xlsx`).
