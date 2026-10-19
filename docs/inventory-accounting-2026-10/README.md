# Inventory & Accounting for shop owners (Oct 2026)

One place for a shop owner to manage stock, purchases, sales and GST on
gokesari.com: stock is updated automatically from supplier bills (soft or
paper copy) and from GoKesari orders, the books follow every purchase, sale,
payment and expense, and GST data from the GST portal is reconciled so the
owner always sees current stock and an estimate of the GST to pay.

Entry points: the shop owner's board → **Inventory → Bills & GST**
(`/shop/accounts`), and **Finance → Books, GST & reports / GST payable**.
The module has its own one-screen tile board in the approved "Theme 1 Tile
Board" design, in English, Hindi and Marathi.

> All GST figures are computed estimates from the shop's books — **verify with
> your CA before filing**. GoKesari never files a return.

## 1. What was built

| Part | What | Where |
|---|---|---|
| 1 Inventory | Product master per shop = the existing listings (`shop_products` → master `products`: MRP, HSN, GST rate, unit, barcode/GTIN; shop-level HSN/GST/price overrides stay per shop) | `src/server/accounts/stock.ts` |
| | **Stock ledger** `inv_stock_ledger`: every movement (opening, purchase, sale, sale return, damage / expiry write-off, adjustment, reversal) with date, source document, qty, cost/rate, user. Current stock = sum of the ledger | migration `0076` |
| | **Online orders reduce stock in real time** — database triggers on `shop_products` / `inventory_movements` write the ledger row in the same transaction as checkout, cancellation restock, subscriptions and catalogue edits. Event-driven, no cron, existing order code unchanged | `drizzle/0076_inventory_accounting.sql` |
| | Batch & expiry (per listing, switched on automatically when a bill has batch numbers), expiring-soon list (FEFO), low stock / reorder (existing thresholds), valuation **FIFO or weighted average** per shop | `src/lib/accounts/valuation.ts` |
| | Loose goods: kg / g / L / ml / piece / dozen conversions, Hindi & Marathi unit words, GST UQC codes, owner-saved conversions ("1 case = 24") | `src/lib/accounts/units.ts` |
| 2 Accounting | Purchase register, sales register, supplier & customer ledgers, cash & bank book, expenses, payables / receivables with ageing (0–30, 31–60, 61–90, 90+) | `purchases.ts`, `sales.ts`, `parties.ts`, `money.ts` |
| | Double-entry books (`acc_ledger_entries`, balanced vouchers, append-only) | `books.ts` |
| | GST sales invoice (Rule 46 fields): CGST + SGST inside the state, IGST across states by place of supply; numbered per financial year; PDF | `sales.ts` |
| | Reports: P&L (perpetual COGS), stock summary, day book, purchase / sales registers, GST summary, all entries — Excel, PDF and **Tally-compatible XML** (masters + vouchers) | `reports.ts` |
| 3 GST portal | Link GSTIN once: consent + portal username → OTP from GST system → session token kept **encrypted** | `gst.ts` |
| | **Pluggable GSP adapter** (`GST_RETURNS_PROVIDER`): `none` (default), `mock` (test only), slots for licensed GSPs | `gst-returns-provider.ts` |
| | Pull GSTR-2B / 2A / GSTR-1; **fallback**: upload the GSTR-2B/2A/1 JSON or the GSTR-2B Excel from gst.gov.in | `src/lib/gst/portal-parsers.ts` |
| | Reconciliation by supplier GSTIN + invoice no. + date + amount: matched, amount mismatch, missing in books, missing on portal | `src/lib/accounts/reconcile.ts` |
| | Liability per month or quarter: Output GST − eligible ITC (reconciled only) = net payable for CGST / SGST / IGST / cess, with the legal set-off order (s.49, rule 88A), credit carried forward, due dates (monthly / QRMP) and reminders | `src/lib/accounts/gst-liability.ts` |
| 4 Soft copy | Upload PDF / photo / Excel / e-invoice JSON, **share to the app** (PWA share target), **email forwarding** to a private per-shop address | `capture/`, `inbound.ts`, `share/route.ts` |
| | E-invoice JSON and the **signed e-invoice QR** (IRN) read as the trusted source (RS256 verified when NIC's key is configured) | `src/lib/einvoice/parse.ts`, `qr-decode.ts` |
| | AI extraction (Claude) of supplier, GSTIN, number, date, lines (name, HSN, qty, unit, rate, discount, GST %, amount, batch, expiry, MRP), totals — with per-field confidence; local fallback: Excel tables, PDF text, OCR + rules | `capture/extract*.ts` |
| | Matching each line: remembered supplier mapping → barcode → HSN + name → name; suggestions or "create new product" (reuses the master product when its barcode matches) | `capture/match.ts` |
| | Checks: line maths, GST maths, totals = invoice total, GSTIN format & check digit, duplicate (same supplier + number), e-invoice QR agreement | `src/lib/accounts/bill-draft.ts` |
| 5 Hard copy | In-browser scanner (web + app): edge detection, crop, de-skew (perspective), enhance (colour / grey / B&W), corner adjust, multi-page, blur warning, small JPEGs for slow networks | `src/lib/scan/`, `bill-scanner.tsx` |
| | Printed and handwritten bills in English, Hindi, Marathi (AI reader); per-field confidence, low confidence highlighted amber, errors red | `bill-review.tsx` |
| 6 Review | Side-by-side original + editable table (phone: switch between them); edit any field, add/remove lines, change mapping; nothing touches stock until **Confirm** | `bills/[id]` |
| | Confirm = one DB transaction: stock in at cost + batches, last purchase rate, purchase + lines, supplier ledger, ITC record, supplier mappings, original files linked | `confirmPurchase` |
| | **Post-confirmation correction**: reopen → reversing + corrected entries in stock, books and ITC (never an overwrite); full audit trail (who, when, old → new, reason) in `acc_change_log` | `correctPurchase` |
| | Corrections feed back: the product (and unit conversion) chosen for a supplier's line text is used first next time | `inv_supplier_item_maps` |
| 7 Data & security | 24 new tables, all with `shop_id`, all **seller database** (`src/server/db/split/ownership.ts`); every API call checks the shop (owner, or an admin for support) and every query filters by it | `access.ts` |
| | GST portal tokens encrypted (AES-256-GCM, `INTEGRATION_ENCRYPTION_KEY`); uploaded bills encrypted at rest, in **S3-compatible object storage** (`ACCOUNTS_STORAGE=s3`) or MEDIA_DIR / database, served only through the access-checked file route | `files.ts` |
| | Background reading queue (`inv_bill_captures`: QUEUED → PROCESSING → READY) with progress %, claimed with `SKIP LOCKED`, retried after a restart; in-app + email notification when a bill is ready | `capture/service.ts` |

## 2. Environment (all optional; the module works without them)

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` + `INVOICE_EXTRACTION_PROVIDER=claude` | AI reading of photos / scans / PDFs (Hindi, Marathi, handwriting). Without it: e-invoice, Excel, PDF text and English OCR only. `INVOICE_AI_MODEL` overrides the model |
| `GST_RETURNS_PROVIDER` | `none` (upload files; the default on gokesari.com), `mock` (OTP **575757**; the default where `GSP_PROVIDER=mock`, i.e. test.gokesari.com — refused on the production host), a licensed GSP's adapter once contracted |
| `EINVOICE_QR_PUBLIC_KEY` | NIC IRP public key (PEM) — verifies the e-invoice QR signature |
| `INTEGRATION_ENCRYPTION_KEY` | Already used by Module 2; also encrypts GST portal tokens and stored bills. Must be **base64 of 32 bytes** — generate with `openssl rand -base64 32` (44 characters ending in `=`). Without a valid key GST linking is refused and bills are stored unencrypted |
| `ACCOUNTS_STORAGE=s3`, `ACCOUNTS_S3_ENDPOINT`, `ACCOUNTS_S3_BUCKET`, `ACCOUNTS_S3_REGION`, `ACCOUNTS_S3_ACCESS_KEY_ID`, `ACCOUNTS_S3_SECRET_ACCESS_KEY` | Bills in an S3-compatible bucket (R2, B2, S3, MinIO). Otherwise MEDIA_DIR, otherwise the database |
| `INBOUND_EMAIL_SECRET`, `INBOUND_EMAIL_DOMAIN` | Email forwarding: each shop gets `bills+<id>-<sig>@<domain>`; the mail provider posts to `/api/inbound/bill-email` with the secret as bearer token |

Crons (safety nets, same `CRON_SECRET` as the others). **Since 19 Oct 2026 both run inside the three-line schedule** (`docs/crontab.txt`: bill-captures every 10 min in `every-minute`, gst-reminders in `daily` at 05:00 IST) — do not add the lines below separately:

```
*/10 * * * *  curl -X POST https://<host>/api/cron/bill-captures -H "Authorization: Bearer $CRON_SECRET"
15 3 * * *    curl -X POST https://<host>/api/cron/gst-reminders  -H "Authorization: Bearer $CRON_SECRET"
```

Bills are read right after upload without the cron; the cron only picks up a
read interrupted by a restart. Reminders need the daily cron.

## 3. Database

Migration `0076_inventory_accounting.sql` — additive only (new tables, three
triggers, one opening-balance backfill of current stock). Rollback:
`scripts/rollback-0076.sql`. The backfill makes the ledger equal today's
stock for every listing; from then on `floor(ledger / 1000) =
online_stock / offline_stock` always holds (checked by `ledgerDrift()`, shown
on the stock page if it ever breaks).

## 4. API

`/api/shops/{shopId}/accounts/…` — `settings`, `bills` (+ `/{id}`, `/{id}/status`,
`/{id}/confirm`, `/{id}/retry`, `/{id}/check`, `/manual`), `files/{id}`,
`purchases` (+ `/{id}`, `/{id}/edit`), `sales` (+ `/{id}/pdf`), `parties`,
`ageing`, `payments`, `expenses`, `books/{cash|bank|day}`, `stock`
(+ `/listings`, `/expiring`, `/drift`, `/{id}`, `/{id}/write-off|count|batches`),
`gst/{link|verify|pull|import|recon|liability|imports}`,
`reports/{pnl|stock|daybook|purchases|sales|gst|ledger|tally}?format=json|xlsx|pdf`.
Also `/api/cron/bill-captures`, `/api/cron/gst-reminders`,
`/api/inbound/bill-email`, and the share target `/shop/accounts/share`.

## 5. Mobile apps

The Android and iPhone apps (`mobile/`) show the website, so the whole module
— scanner, upload, review, stock, GST, reports — is in both apps as soon as it
is deployed, with no app update: the scanner uses the camera through the file
picker (`capture="environment"`), which the app already supports (iOS
`NSCameraUsageDescription` is in `app.config.ts`); downloads (Excel, PDF,
Tally XML) use the app's existing download bridge. See the tracker for the one
open native item (receiving a file shared from WhatsApp straight into the
native app).

## 6. Status, tests

Released to gokesari.com on 15 Oct 2026 by #179 (main @acfaa6a, migrations 0076–0078),
after staging testing found and #172 fixed three defects.

- Tracker: `docs/inventory-accounting-2026-10/INVENTORY_ACCOUNTING_TRACKER_2026-10-15.xlsx`,
  and the sheet "Inventory & Accounting" in
  `docs/gokesari-audit/GOKESARI_FEATURE_STATUS_REPORT_2026-10-15.xlsx`
  (owner's folder: `/Users/agtci/Documents/Doc_GoKesari/Devlopment_Trackers`)
- Testing report: `docs/inventory-accounting-2026-10/TESTING_REPORT.md` and
  `INVENTORY_ACCOUNTING_TEST_REPORT_2026-10-15.xlsx`
  (owner's folder: `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking`)
- Live-site scripts: `scripts/test-site/` — `signin.mjs`, `accounts-check.mjs` (test site only),
  `stock-order-check.mjs` (test site only), `prod-smoke.mjs` (read-only, any site)
