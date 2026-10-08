# Module 2 — accounting / inventory integration and GST

Part of [PLAN.md](PLAN.md). Test environment first (test.gokesari.com).

## What a shop owner can do

**Shop settings → Accounting software** (`/shop/settings/integrations`):

- Choose the software: **TallyPrime**, **Odoo 19+**, **Zoho Books (India)**,
  **myBillBook**, **Vyapar**, or **other software (Excel/CSV)**. One
  connection per shop; switching means disconnecting first.
- Connect it:
  - **Tally**: enter the company name and ledger names, press **New connector
    token**, install the GoKesari Connector on the shop computer with that
    token (`connector/tally/README.md`).
  - **Odoo**: address, database and an API key (Odoo → Preferences → Account
    Security → New API Key).
  - **Zoho Books**: press **Connect Zoho Books** and allow access on Zoho's
    own page. GoKesari never sees the Zoho password.
  - **myBillBook / Vyapar / other**: nothing to connect; sync is by file.
- Choose what syncs: invoices, credit notes, stock, price (online and
  in-shop, or online only), HSN and GST rate.
- See status in plain words: connected / paused / needs attention, connector
  online, last read and sent, waiting / retrying / failed counts, and the
  last problem with its fix.
- **Sync now**, **Test connection**, **Pause / Resume**, **Disconnect**.
- **Match items** (`…/mapping`): items from the software that GoKesari could
  not match for certain, with up to three suggestions; search and pick,
  ignore, or unmatch. A match applies stock, price and tax at once.
- **Sync log** (`…/sync`): failed entries first with **Retry now**, entries
  being retried automatically (with the next try time), entries waiting, and
  a plain-language log.
- File sync: upload the item export → confirm the columns (GoKesari guesses
  and remembers) → apply. Download **new invoices / credit notes / stock
  movement** (Excel) to import into the software — only what was not
  downloaded before — or any date range again (CSV).
- **GST returns** (`/shop/gst-returns`): the month's GSTR-1-ready file (JSON
  for the GST offline tool, and Excel), with totals and warnings to check.
  Declare whether e-invoicing applies (turnover band).
- On an invoice (`/invoices/{id}`): the IRN once generated, a **Generate /
  Retry e-invoice** button where it applies, an e-way bill form when the
  value rules require one, and the credit notes against the invoice.

## How sync works (event-driven)

```
order DELIVERED (delivery OTP) ─▶ invoice issued ─▶ PUSH_INVOICE job ─┐ same transaction
refund / return after delivery ─▶ credit note    ─▶ PUSH_CREDIT_NOTE ─┘ (savepoint)
                                                     │
              API software (Odoo, Zoho): run just after commit
              Tally: the connector's long-poll picks it up within a second
              File software: waits as "ready to download"
```

- **Outbox** (`integration_jobs`): one row per thing to send, unique
  `idempotency_key` (`push-invoice:<invoiceId>:<connectionId>`), so queuing
  twice is a no-op.
- **No duplicates in the software**: every push looks up GoKesari's document
  number first and creates only when it is not there (Odoo `ref`, Zoho
  `reference_number`, Tally voucher number). A retry after a lost reply finds
  the document. Tally jobs always restart at the lookup.
- **Retry**: temporary problems (network, rate limit, Tally closed) retry
  after 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h. After 8 attempts, or
  at once when the owner must fix something (wrong key, missing ledger,
  unmatched item), the entry is **failed**: the owner is notified
  (`shop.integration_sync_failed`) and sees it with a **Retry** button.
- **Claiming**: `FOR UPDATE SKIP LOCKED` and a 3-minute lease; a crashed
  runner's job is taken again after the lease.
- **Safety net** (`/api/cron/integration-sync`, every minute, like the other
  sweeps): runs retries that came due, re-queues a push whose hook failed,
  warns once a day when a Tally connector is offline with entries waiting,
  retries e-invoices that failed while the GSP was down. Nothing is sent on a
  schedule.
- **Pull** (items, stock, price/MRP, HSN, tax rate): on **Sync now**, on
  connecting, on the connector's start and when it sees Tally's items change
  (checked on the shop PC every 2 minutes, uploaded only when changed), and on
  an Odoo/Zoho change webhook.

### Conflict rules

- **Stock and price**: the shop's software wins. Matched listings take its
  values through the same `updateShopProduct` as the owner's own edits
  (price history, stock ledger, audit).
- **Online orders**: GoKesari wins. Online stock = the software's stock −
  units in open online orders and delivered orders whose invoice has not
  reached the software yet, so a pull never resells goods sold online.
- **MRP**: a pulled price above the verified master MRP is **not applied**;
  stock still is, and the item shows the problem. An MRP that differs from
  GoKesari's is reported, never written to the master.
- **Loose goods** start with an empty price (unchanged rule); the first
  pulled price puts them on sale, as when the owner types it.
- **New listings**: a matched product the shop does not list yet is added —
  only when the shop already carries its category (adding a category would
  fill the whole category).
- **HSN / GST rate** from the software are stored on the shop's listing
  (`shop_products.hsn_code`, `gst_rate_bp`) and used on that shop's invoices
  only; the master is untouched.

### Matching

Barcode/GTIN, then GoKesari product code (SKU), then name similarity
(PostgreSQL `pg_trgm`): an almost identical name among the shop's own
products (≥ 0.9, clearly ahead of the next) is matched; anything else is
only *suggested* for the owner to confirm. Manual matches and "ignore" are
never overwritten by later pulls.

## Adapters

| Software | How | Pull | Push | Duplicate check |
|---|---|---|---|---|
| TallyPrime | GoKesari Connector on the shop PC ↔ Tally XML on `localhost:9000` | Stock items (name, aliases/part no., unit, closing stock, rate, MRP, HSN, GST rate) | Sales voucher (Invoice view, inventory + CGST/SGST/IGST ledgers); Credit Note voucher (with stock back only for returns) | Voucher lookup by number before create |
| Odoo 19+ | JSON-2 `POST /json/2/<model>/<method>`, bearer API key, `X-Odoo-Database` | `product.product`, sale taxes | `account.move` out_invoice / out_refund (posted), `stock.quant` adjustment | `ref` lookup |
| Zoho Books | REST v3, OAuth 2.0, India DC (`accounts.zoho.in`, `www.zohoapis.in`) | `/items` | `/invoices`, `/creditnotes` (marked sent/open; inventory items lose stock) | `reference_number` lookup; "already exists" = found |
| myBillBook, Vyapar | Excel/CSV, column presets (**unconfirmed**, pending P1) | Item export upload | Invoice / credit note / stock-movement download | Exported entries marked; "new" never repeats |
| Other | Excel/CSV, no preset | same | same | same |

The Tally connector (`connector/tally/`) is a Node program with no
dependencies, built into one `.exe` by `.github/workflows/connector-tally.yml`
and installed as a Windows service (WinSW). It makes only outbound HTTPS
calls; Tally's port is never exposed. GoKesari builds and reads all Tally
XML, so the connector rarely needs an update.

## GST

| Phase | What | Where |
|---|---|---|
| 1 | GSTIN validation through the GSP (legal/trade name, status, state, type), cached in `gstin_lookups` | `POST /api/gst/gstin/validate`; Module 3 profile completion |
| 1 | Invoice gaps for Rule 46: seller state and place of supply as name + code, reverse charge "No", authorised signatory line, IRN printed when generated; the GST unit code (UQC) recorded on each line for returns and e-invoices | Invoice page and PDF |
| 1 | Credit notes on refunds/returns after delivery, own series per shop per FY, PDF | `GET /api/credit-notes/{id}/pdf` |
| 2 | E-invoice (IRN + signed QR) for B2B invoices of shops that declared turnover above the threshold, when the rule is switched on | automatic after delivery; `POST /api/invoices/{id}/einvoice` |
| 2 | E-way bill when the value rules say so (by hand: needs distance/vehicle) | `POST /api/invoices/{id}/eway-bill` |
| 3 | GSTR-1-ready monthly export (b2b, b2cl, b2cs, cdnr, cdnur, HSN B2B/B2C, documents issued), JSON + Excel. **Nothing is filed.** | `/shop/gst-returns` |

- **GSP**: provider-agnostic `GspProvider` (`src/server/gst/gsp/`). Only the
  **mock** exists until a GSP is chosen (P3). The mock checks GSTIN check
  digits, computes the IRN as the IRP does (sha256 of GSTIN + FY + type +
  number) and refuses numbers over 16 characters.
- **Thresholds are data** (`gst_rules`, dated; `/admin/gst-config`):
  `documentNumbering` (LEGACY now; GST16 `GK2627-000001` needed before
  e-invoicing), `einvoice` (off; ₹5 crore; B2B only), `einvoiceReportingWindow`
  (30 days above ₹10 crore), `b2clThreshold` (₹2.5 lakh to 31 Jul 2024, ₹1
  lakh from 1 Aug 2024), `ewayBill` (off; ₹50,000, per-state intra limits),
  `gsp` (mock). A change applies from a date; issued documents keep their
  date's rule. Fallback GST rates by HSN (`hsn_tax_rates`) are empty for the
  CA to fill.
- Invoice numbers are now unique **per shop** (GST requires uniqueness per
  supplier; GST16 numbers repeat across shops by design).

## Security

- Secrets (Odoo API key, Zoho refresh token) are encrypted with AES-256-GCM
  (`INTEGRATION_ENCRYPTION_KEY`, `v1:` key version) and never returned by any
  API; the screen only knows whether one is saved. No key on the server → no
  secret can be saved.
- Owner only for changes; operators see status, log and items and may retry
  (support); admins may also change a connection. Shop staff (Module 1) have
  no access. Every change is audited (`INTEGRATION_*`).
- Connector tokens: shown once, stored as sha256, bound to one shop and one
  connection, revocable; at most 5 per shop. A token never sees another
  shop's jobs (tested).
- Change webhooks need the shop's own secret (stored hashed, compared in
  constant time).
- The Odoo address must be HTTPS and resolve to public addresses (no calls
  into GoKesari's own network), redirects refused.
- Zoho sign-in state is signed and bound to the shop, the user and the
  browser (cookie nonce); accounts outside Zoho's India data centre are
  refused.

## API

| Method & path | Who | Purpose |
|---|---|---|
| `GET · PUT /api/shops/{id}/integration` | view · owner | Software list and current connection (no secrets) · connect / change settings / pause |
| `POST …/integration/test` · `/sync` · `/disconnect` | owner, support · owner | Test · pull now · disconnect |
| `GET · POST …/integration/tokens`, `DELETE …/tokens/{tokenId}` | owner | Connector tokens (token shown once) |
| `POST …/integration/webhook` | owner | New change-webhook address (shown once) |
| `GET …/integration/items` · `PATCH …/items/{linkId}` · `POST …/items/auto-match` · `GET …/items/search?q=` | owner, support | Mapping screen |
| `GET · POST …/integration/imports`, `GET · DELETE …/imports/{importId}`, `PUT …/{importId}/mapping`, `POST …/{importId}/apply` | owner, support | File sync: upload, columns, apply (202) |
| `GET …/integration/exports?kind=&scope=new\|range&from=&to=&format=` | owner, support | File sync downloads |
| `GET …/integration/jobs?status=` · `POST …/jobs/{jobId}/retry` · `GET …/integration/log` | owner, support | Sync entries, retry, log |
| `GET /api/integrations/zoho/connect?shopId=` · `GET /api/integrations/zoho/callback` | owner | Zoho OAuth |
| `POST /api/integrations/webhooks/{provider}/{integrationId}?key=` | the software | Items changed → pull |
| `POST /api/connector/v1/hello` · `GET /api/connector/v1/jobs?wait=25` · `POST …/jobs/{jobId}/result` · `POST …/items` | connector token | Tally connector |
| `POST /api/gst/gstin/validate` | shop owners, operations | GSTIN check (30/hour) |
| `GET /api/credit-notes/{id}/pdf` | as the invoice | Credit note PDF |
| `POST /api/invoices/{id}/einvoice` · `/eway-bill` | owner, operations | Generate / retry |
| `GET /api/shops/{id}/gst/gstr1?period=YYYY-MM&format=json\|xlsx` | owner, operations | GSTR-1-ready file (recorded in `gst_return_exports`) |
| `PUT /api/shops/{id}/gst/einvoice-declaration` | owner, operations | Turnover band / e-invoice applicable |
| `GET · PUT /api/admin/gst-config`, `GET · PUT /api/admin/hsn-tax-rates`, `PATCH …/{rateId}` | admin | GST rules and fallback rates |
| `GET /api/admin/integrations?provider=&problem=&q=` | operations | All shops' sync health |
| `POST /api/cron/integration-sync` | cron secret | Safety net |

## Database

- **0062_integrations**: `shop_integrations` (one live per shop),
  `integration_connector_tokens`, `integration_item_links`,
  `integration_jobs`, `integration_sync_log`, `integration_imports`,
  `integration_column_mappings`; `shop_products` + `hsn_code`, `gst_rate_bp`,
  `cess_bp`, `external_synced_at`.
- **0063_gst_compliance**: `gst_rules` (seeded), `hsn_tax_rates` (empty),
  `credit_notes`, `credit_note_counters`, `einvoice_records`, `eway_bills`,
  `gstin_lookups`, `gst_return_exports`; `shops` + `einvoice_applicable`,
  `declared_turnover_band`, `turnover_declared_at/by`; invoice-number unique
  index becomes per shop.
- Both additive. Rollback: `scripts/rollback-0063.sql` (refuses while credit
  notes, IRNs or e-way bills exist — tax documents), then
  `scripts/rollback-0062.sql`; delete the rows from
  `drizzle.__drizzle_migrations`.

## Configuration

| Variable | Where | Value |
|---|---|---|
| `INTEGRATION_ENCRYPTION_KEY` | test and production, different values | `openssl rand -base64 32`. Back it up: losing it means every Odoo/Zoho shop reconnects |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` | per site | api-console.zoho.in → Server-based app, redirect URI `https://<site>/api/integrations/zoho/callback` |
| `GSP_PROVIDER`, `GSP_ENV` | per site | `mock` / `sandbox` until a GSP is chosen; production refuses mock |
| `INTEGRATION_AUTODISPATCH` | tests only | `off` |

New permissions: `integration:manage:own` (shop owners),
`integration:view:any` (operators), `integration:manage:any` and
`gst-config:manage` (admins).

## Tests

- `tests/integration/accounting-integration.test.ts` (17): encrypted,
  write-only secrets; who may change a connection; one live connection;
  SSRF guard; invoice queued once on delivery (forced issue), safety net
  does not duplicate; **network failure → backoff → retry → sent, and a lost
  reply does not create a second invoice**; refused key → failed at once,
  owner told, Retry after the fix; **DEAD after the last attempt, owner told
  once**; Tally lookup → create through the connector routes and a retry
  after a lost reply finding the voucher; **connector isolation between
  shops**, revoked/disconnected tokens; balanced Tally voucher; pull by
  barcode with open orders kept out of online stock; price above MRP not
  applied; name match only suggested, manual match applies and puts a loose
  item on sale; ignored stays ignored; file import with presets and
  "download new" exactly once; change webhook secret and debounce; refund →
  credit note + push, once per refund.
- `tests/integration/gst-compliance.test.ts` (11): GST16/LEGACY numbering and
  the dated rule; credit-note allocation, cap and idempotency; GSTIN format
  and mock lookup with cache; e-invoice conditions, IRN, duplicate handling,
  IRN on the PDF, the 16-character failure; GSTR-1 sections, netting of
  credit notes, HSN split, document counts, totals adding up, download
  permissions; GST rule dating.
- `tests/unit/tally-connector.test.ts` (2): the connector program against a
  fake GoKesari and Tally.
- `migrate-on-build.test.ts` now rolls back and re-applies 0056–0063.

## Deployment — test.gokesari.com

1. Generate a key: `openssl rand -base64 32`. hPanel → the test app →
   Environment variables: `INTEGRATION_ENCRYPTION_KEY=<key>`,
   `GSP_PROVIDER=mock`, `GSP_ENV=sandbox`. Store the key in the password
   manager.
2. (Zoho, optional now) api-console.zoho.in → *Server-based Applications* →
   redirect URI `https://test.gokesari.com/api/integrations/zoho/callback`;
   set `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`.
3. Merge into `staging`. The "Test database" workflow backs up and applies
   0062 and 0063; check it is green.
4. Add the cron line next to the others:
   `* * * * * curl -fsS -X POST https://test.gokesari.com/api/cron/integration-sync -H "Authorization: Bearer $CRON_SECRET"`
   and check `GET` on the same URL answers `{"status":"ready"}`.
5. Admin → **Business rules** → `invoicing.enabled = true` (shops with a
   connection get invoices regardless).
6. Smoke test:
   - A test shop → **Accounting software** → **Other software (Excel/CSV)** →
     upload an item export with a known barcode → columns guessed → Apply →
     the listing's stock/price change; an item priced above its verified MRP
     shows the problem.
   - Deliver a test order (rider OTP) → **Download new invoices** → the
     invoice is in the file; download again → empty.
   - Refund part of it (Finance → refund) → the invoice page lists the
     credit note; its PDF opens.
   - **Tally** (needs a Windows PC with TallyPrime, educational mode is
     fine): run the connector workflow (Actions → *Tally connector build* →
     Run), install the artifact with a token from the test shop → **Connector
     online** → deliver an order → the Sales voucher appears in Tally with
     the GoKesari number; close Tally, deliver another → the sync log says
     "Tally is not open", reopen → it is sent.
   - **Odoo** (a free Odoo 19 trial database): connect with an API key →
     Test → Sync now → items appear on **Match items**.
   - `/shop/gst-returns` → previous month → JSON downloads; check it in the
     GST offline tool.
   - `/admin/integrations` as operator; `/admin/gst-config` as admin.

## Deployment — production (gokesari.com), later

Do not start before the test smoke test passes and a GSP is chosen for
GSTIN validation (production refuses the mock GSP; GSTIN checks show
"unavailable" until then, nothing else depends on it).

1. A **different** `INTEGRATION_ENCRYPTION_KEY` for production; back it up.
2. Zoho: a production redirect URI on the same Zoho client (or a separate
   client) — `https://gokesari.com/api/integrations/zoho/callback`.
3. Back up the database; apply 0062 and 0063 (`npm run db:migrate` or the
   production database workflow) **before** deploying the code (additive;
   the current build runs on the migrated database).
4. Deploy; add the cron line for `https://gokesari.com/api/cron/integration-sync`.
5. Code-sign the connector `.exe` (P6) before giving it to shops.
6. Decide with the CA before switching `documentNumbering` to GST16 (start
   of a financial year) and before switching on `einvoice` / `ewayBill`.
7. Rollback: previous build; then the rollback scripts as above (0063 will
   refuse while credit notes exist — keep the tables in that case).

## Open questions and pending actions

See PLAN.md §9 and "Pending actions": P1 (myBillBook/Vyapar sample
exports), P3 (GSP), P6 (code signing), P7 (CA questions: TCS/GSTR-8,
Section 9(5), unregistered sellers, GSTR-1 Table 14 / e-commerce GSTIN,
delivery fee supplier, credit-note time limits). None of the e-commerce
operator obligations are implemented.

## Assumptions

- A refund amount is credited against the goods on the invoice, in
  proportion to the lines; a refund of only the delivery fee (not on the
  shop's invoice) cannot be told apart from the refund amount alone.
- Cancellations before delivery have no invoice and need no credit note.
- Tally: GoKesari's online customers post to one party ledger (default
  "GoKesari Online Customers"); B2B buyers' GSTIN goes on the voucher.
  Unmatched items stop the voucher by default (setting: post without stock).
- Odoo: the invoice does not move stock in Odoo, so stock is adjusted with
  `stock.quant` when a stock location is set.
- Zoho: inventory-tracked items lose stock when the invoice is marked sent.
- E-way bills are generated by hand (distance and vehicle are not recorded
  for local deliveries).
- The GSTR-1 export covers only GoKesari sales; the shop's other sales are
  in its own books.
