# Decision log — GoKesari build & integrate batch (18 Oct 2026)

Every assumption made during the batch, so the owner can overrule any of them.
Ground rule applied throughout: **additive only** — new tables, new rules
(feature flags) and provider interfaces; existing behaviour stays the default.

Format: **ID — decision.** *Why.* (Where.)

## Run and process

- **D-001 — The batch was built in the `GoKesari` repository** (gokesari.com /
  test.gokesari.com), not in `bkesari`. *`bkesari/README.md` records that the
  two brands are deliberately separate since 8 Oct.* (repo attached to the session)
- **D-002 — Work branches from `staging`** (identical tree to `main` at the
  start) and goes `feature → staging (test.gokesari.com) → main (gokesari.com)`.
  *The repo's documented promotion path (DEPLOYMENT.md §3).*
- **D-003 — Six parallel workstreams (A–F) on reserved migration slots
  0079–0084 and marked sections in the shared registries.** *Lets each area be
  built and tested in isolation and merged cleanly.* (scaffolding commit)
- **D-004 — Every new configurable value is a rule in `src/server/config/rules.ts`**
  (admin-editable at Admin → Settings, audited), never a constant. *Ground rule 5;
  the existing mechanism already gives admin editing, validation and audit.*
- **D-005 — New provider-backed features default to OFF** (rule flag `enabled:
  false` or provider = sandbox/mock). Production stays OFF until the owner's keys
  exist; staging can switch them on through `docs/batch-2026-10/test-settings.sql`.
- **D-006 — Payment contract defined before the build:** `PaymentGateway`
  (`src/server/payments/gateway/types.ts`) and payment intents
  (`src/server/payments/intents.ts`) with state machine
  `CREATED → PENDING → AUTHORIZED → CAPTURED → PARTIALLY_REFUNDED → REFUNDED`,
  plus `FAILED`, `EXPIRED`. *Refunds (F6.2.3) and the registration fee
  (F8.4.2) depend on it.*

## F14.2.1 — empty `PROD_DATABASE_URL` (PLT-009)

- **D-010 — Diagnosis from the run logs, not assumed.** Run #7 (13 Oct): the
  secret was empty. Run #8 (15 Oct): the secret was visible (masked `***`), but
  `vars.PROD_DATABASE_HOST` / `vars.PROD_DATABASE_NAME` were empty. Meanwhile
  "Database split" — whose job declares `environment: production` — saw every
  production secret (runs #19, #20 succeeded). Conclusion: checklist item (a) —
  the values are kept on the **production environment**, and `prod-db.yml`'s job
  had no `environment:`. Items (b)–(g) checked and ruled out (see
  `scripts/prod-db/preflight.sh` header).
- **D-011 — Fix: the job declares `environment: production`** (repository-level
  values remain visible; environment values override them) and a new
  **preflight** step reports which required secrets/variables are visible
  (`set` / `EMPTY`, never the value) with the checklist, failing fast before the
  guard. The guard's host/database checks are unchanged.
- **D-012 — The production migration itself runs after the release reaches
  `main`** ("Production database" → `migrate`, confirm `MIGRATE PRODUCTION`),
  because the workflow only runs from `main` by design.

## F14.2.4 — seller / customer split (PLT-015)

- **D-015 — Split secrets are visible to Actions** (production environment;
  run #19 PASS: 190 tables, 486/486 rows, checksums equal, no broken links).
- **D-016 — The cut-over (`DB_SPLIT_MODE=split` on gokesari.com) was NOT done.**
  *README §5 phases 2 (replication) and 3 (moving service areas) are separate
  releases; switching now would let the seller copy go stale. It is an
  irreversible production change in a Hostinger setting this environment can't
  reach.* Runbook: `docs/db-split-2026-10/CUTOVER_2026-10-18.md`.

## Statutory rates (looked up 18 Oct 2026 — CA must confirm before production)

- **D-020 — GST TCS (s.52 CGST Act): 0.5%** of net taxable supplies
  (CGST 0.25% + SGST/UTGST 0.25%, or IGST 0.5%), Notification 15/2024-Central
  Tax dated 10 Jul 2024 (was 1% under Notification 52/2018).
  Source: https://gstcouncil.gov.in/sites/default/files/2024-09/central-tax-15-2024-11072024.pdf
- **D-021 — Income-tax TDS on e-commerce participants (old s.194-O): 0.1%** of
  gross sales from 1 Oct 2024 (Finance (No. 2) Act 2024; was 1%); 5% without
  PAN/Aadhaar; individual/HUF participants ≤ ₹5 lakh a year with PAN/Aadhaar
  exempt. From 1 Apr 2026 the Income-tax Act, 2025 consolidates TDS in
  **s.393** (194-O maps to s.393(1)). Secondary sources only
  (e.g. https://taxguru.in/income-tax/section-194-o-amendment-lower-tds-rate-e-commerce-payments.html ,
  https://blog.tdsman.com/2026/07/tds-on-e-commerce-transactions-section-3931-194o/);
  the label is configurable.
- **D-022 — GST on restaurant services through an ECO (s.9(5)): 5%** paid by
  the ECO — disabled until food-service shops are onboarded.
- **D-023 — Local delivery services through an ECO by unregistered suppliers
  (s.9(5)) at 18% from 22 Sep 2025** (Notifications 15/2025 and 17/2025-Central
  Tax (Rate)) — added as a dated setting, **disabled**, CA to confirm whether
  GoKesari's delivery model falls under it.
  Source: https://www.ey.com/en_in/technical/alerts-hub/2025/09/cbic-issues-notifications-giving-effect-to-the-recommendations-made
- **D-024 — All statutory rows are seeded with `confirmedByCa = false`**, shown
  prominently in Admin.

## Consumer protection

- **D-030 — Help-desk SLAs: acknowledge within 48 hours, resolve within one
  month** — Consumer Protection (E-Commerce) Rules, 2020, Rule 4 (grievance
  officer; acknowledgement within 48 hours; redressal within one month of
  receipt). Configurable. Secondary-source check:
  https://mondaq.com/india/dodd-frank-consumer-protection-act/985606/the-consumer-protection-e-commerce-rules-2020 —
  counsel to confirm against the gazette text.

## Testing

- **D-040 — Integration tests run on a local PostgreSQL 16** (one database per
  workstream), the same engine CI uses. Each new case is named
  `TC-B26-<WS>-NNN` and counted in the test report.
- **D-041 — Signed-in journeys on test.gokesari.com use the existing staging
  test accounts** (`sanjaymorankar+gk-lc14` customer, `gk-shop`, `gk-rider`,
  `gk-admin`, `gk-ops`), signed in through the normal email code read from the
  owner's mailbox — **with the owner's go-ahead (18 Oct)**. Sessions are saved
  only in the git-ignored `.e2e-auth/` of the build machine and expire in 30
  days. Production uses no real payments.

<!-- Workstream decisions (A–F) are appended below. -->

## WS-B — rider broadcast offers, QR pickup, navigation (F3.3.2, F4.1.3, F4.2.2)

- **D-B01 — Broadcast starts after the shorter of `dispatchBroadcast.singleOfferSeconds` and `dispatch.offerTtlSeconds`**; the single offer's row goes OFFERED → REJECTED and that rider joins the broadcast (not counted against the per-step cap). Radii 2 → 4 → 6 km by default, `stepSeconds` 60.
- **D-B02 — First accept wins by a conditional UPDATE of the broadcast row OPEN → TAKEN** inside the winner's transaction; losers' recipient rows become TAKEN_BY_OTHER and they get "Offer taken". Proven by a concurrent two-rider test.
- **D-B03 — After the last step the broadcast expires and the normal search continues**; society-exclusive rules, the busy-rider fallback and each rider's own radius still apply. Batched trip offers keep the single-offer flow.
- **D-B04 — With `dispatchBroadcast.enabled` off the rider text and behaviour are byte-identical to before.**
- **D-B05 — Pickup QR = order + token id + HMAC-SHA256 (128-bit), secret `PICKUP_QR_SECRET`** (falls back to `AUTH_SECRET` outside production). Only a hash of the nonce is stored; the QR is valid only for READY/ASSIGNED orders and only for the rider holding the accepted delivery; it is spent inside the pickup transaction, so a failed pickup does not burn it. Every scan is logged with GPS.
- **D-B06 — QR drawn server-side as SVG (`qrcode`, moved to dependencies); scanned in the browser with `jsQR`** (works in the app's WebView once camera permission is granted — WS-F).
- **D-B07 — Navigation providers: mock (default), Google (Routes, existing server key), OSRM** (own server recommended; the public demo is rate-limited). Without a Google key the map is a plain SVG route drawing (OSM tiles are blocked by the site's CSP `img-src`). Provider failure → straight-line route. Leg 2 (to the customer) is shown only after pickup.
- **D-B08 — No new npm dependency.** The legacy `delivery-dispatch` cron (kept for rollback) does not run the broadcast step; `timeout-sweep` does.
- **D-B09 — F4.2.6 signature capture not built** (DEFERRED-PHASE-2).

## WS-E — invoices, payouts, platform invoice, statutory (F9.2.6, F10.2.4, F10.2.5)

- **D-E01 — Statutory values live in a dated table `statutory_rates`**; payout maths uses the row in force on each supply's date. Seeded (all `confirmedByCa = false`): TCS 1% → 0.5% from 2024-07-10; TDS 194-O 1% → 0.1% from 2024-10-01, label s.393 from 2026-04-01, 5% without PAN, individual/HUF ≤ ₹5 lakh/FY exempt (TDS from the order that crosses it); s.9(5) restaurant and local-delivery rows disabled; unregistered sellers: no TCS, TDS applies; GST on GoKesari fees 18%.
- **D-E02 — TCS base = the tax invoice's taxable value** (gross where no invoice); returns reverse it. TDS base excludes GST (configurable). A shop with a GSTIN counts as GST-registered.
- **D-E03 — Commission is the taxable value; 18% GST is added on top.** GST on fees is deducted from a payout only when platform invoicing is on and the tax profile is complete. Registration fees are invoiced as GST-inclusive, already paid.
- **D-E04 — Commission already taken from the shop wallet shows as a zero line**; "± wallet entries" is an optional top-up of the shop wallet from the payout (`payouts.walletTopUpTargetPaise`, default 0).
- **D-E05 — Shops with no verified bank account, net ≤ 0 or below `minPayoutPaise` are held and carried to the next cycle.** A success webhook without a UTR stays in progress for finance.
- **D-E06 — Default payout provider is BANK_FILE** (generic NEFT/RTGS CSV + "mark paid with UTR"); the bank's exact template must be confirmed. RTGS from ₹2 lakh.
- **D-E07 — With `payouts.enabled` on, the weekly shop settlement is refused** (both the cron and the function) so a shop can never be paid twice; rider payouts stay weekly.
- **D-E08 — Place of supply = delivery-address state, then a PIN-code prefix lookup (unclear prefixes → unknown), then the shop's state with a note on the invoice.**
- **D-E09 — B2C invoice QR is a key:value text payload** (invoice no., date, GSTINs, value, tax) because the shop's UPI ID is not held; the e-invoice signed QR is drawn when present.
- **D-E10 — Credit note for a cancellation/reversal is issued when an order reaches REFUNDED** (flag `invoiceDelivery.creditNoteOnCancellation`), capped at what earlier refund notes have not already credited (no double credit).
- **D-E11 — Platform invoice series `GKP/<FY>/<n>`, credit `GKC`, debit `GKD`** (≤ 16 characters, unique per FY); SAC codes per fee type are defaults for the CA to confirm. PANs are masked in the TDS report.
- **D-E12 — RazorpayX / Cashfree Payouts request formats are coded from public docs and marked unverified** (no keys or network here). GSTR-8 and the TDS return are summaries, not portal-upload files.

## WS-D — Operator-Limited, product data sources, ingestion (F8.4.2, F9.1.2, F9.1.4, F9.2.6 inventory part)

- **D-D01 — `OPERATOR_LIMITED` is a real role** (enum value, own permission array, label), not a scoped grant: it reuses the role switcher, Admin → privileges and the permission matrix, and every existing `"OPERATOR"` check denies it by default.
- **D-D02 — Scope = `shops.onboarded_by_user_id`.** An Operator-Limited user sees only shops they onboarded; another operator's shop returns 404 and writes an audit row. Duplicate-shop errors are scrubbed of the other shop's id/number.
- **D-D03 — Owner consent by email OTP** (new OTP purpose `SHOP_ONBOARDING_CONSENT`, same hashing/limits; valid `operatorLimited.consentValidMinutes` = 60). The operator never sets the fee or registration date. An owner email with no account gets one, marked verified (the OTP proved it).
- **D-D04 — Registration fee through the payment-intent contract** (link emailed, expiry 72 h, or pay in session). The capture handler writes the fee ledger row (method `ONLINE`) inside the capture transaction; auto-approval runs just after commit (inside it would deadlock on the shop row), with a cron sweep as the safety net. Not paid / expired → the shop stays pending admin approval.
- **D-D05 — Operator-Limited has no finance, payout, settings or other-operators' access**; every action is audited (`OPLTD_*`).
- **D-D06 — Manufacturer portal = public-schema tables in the seller DB**, one source `mfr_<slug>` per account; API keys stored hashed, shown once, revocable, rate-limited and audited.
- **D-D07 — GS1 DataKart = mock** (source `gs1_datakart_mock`, never runs in production) until an agreement; **Open Food Facts behind a flag, off**, with ODbL attribution stored per record.
- **D-D08 — Staging = `pmd.product_master` records not yet linked to the catalogue; master = promoted.** Browser promotion uses `minQuality` 0 because a person chose the record. Bulk-edit MRP goes through the existing master-MRP service (shop-level MRP edits still apply to that shop only).
- **D-D09 — Ingestion: input staged once as rows, then batches through the existing pipeline with a checkpoint per batch**, driven by a cron worker plus a kick on creation. A crash re-runs at most one batch (idempotent). Benchmark (local): 100k rows staged in 16.8 s; full load 749 s (~133 rows/s; slower for one huge single-brand file because of fuzzy matching — matcher unchanged).
- **D-D10 — Images: SSRF-safe fetch + `sharp` resize into an `ObjectStore` interface** — existing DB/local blob store by default, S3-compatible adapter behind `objectStore.s3Enabled` (off, unverified against a real bucket).
- **D-D11 — Inventory sync descoped: rule `inventorySync.enabled` defaults OFF** and stops the sync cron, auto-dispatch, connector routes and the connect screen; no code deleted. (On gokesari.com it only ever ran on mock providers.) The one existing accounting test switches it on explicitly.

## WS-F — notifications, push, broadcasts, deep links, mobile (F13.1.2, F3.3.2 broadcast part, F15.2.3)

- **D-F01 — Push goes through the existing outbox** (`notification_deliveries`) with one Expo ticket per device: Expo busy/unreachable → retry (attempts logged); any device accepted → SENT; every device unregistered → SKIPPED and those tokens deactivated; receipts checked by the `push-receipts` cron.
- **D-F02 — Rule `push.enabled` defaults OFF** (PUSH deliveries skipped exactly as before); provider `mock` (writes to Admin → Test messages, refused on gokesari.com) or `expo`. Push defaults on only for people with an active device and only in the rule's categories; a person's own setting always wins.
- **D-F03 — Broadcasts: everyone gets the in-app notification; push and email follow each person's new "Announcements" category** (email off unless they switch it on). "Send now" writes the first chunks in the request, the `broadcast-dispatch` cron the rest; re-runs never send twice.
- **D-F04 — Audiences:** customers (incl. society admins and customer grants), shop owners, riders (anyone with a rider profile); city/PIN from saved addresses (customers, riders) or shop location (owners). Expired broadcasts are hidden from the centre and unread count, not deleted.
- **D-F05 — `.well-known` files are now always served**, host-aware (gokesari.com → `com.gokesari.app`, test.gokesari.com → `com.gokesari.app.preview`), with the literal placeholders `REPLACE_WITH_SHA256_SIGNING_FINGERPRINT` / `REPLACE_WITH_APPLE_TEAM_ID` until the env is set — verification simply fails until then, links still open the web page.
- **D-F06 — Mobile app 1.2.0:** `expo-notifications` / `expo-device` added at SDK 57 versions with npm (`expo install` could not reach Expo); push token requested by the site after sign-in; notification taps open their page; camera allowed inside the WebView for QR (Android `CAMERA`; iOS auto-granted for the site's own pages — Android cannot restrict it to our pages, the system prompt still applies); Cashfree/Razorpay/PhonePe stay in-app; incoming links routed in-app only for the site's own pages.
- **D-F07 — Signing out does not unregister the device immediately**; pushes stop when someone else signs in on it or Expo reports the app removed.
- **D-F08 — WhatsApp and SMS: Phase-2 stub adapters only** (existing mock/none), no vendor.

## WS-C — after-packing cancellation, refunds, help desk (F6.1.3, F6.2.3, F6.3.3)

- **D-C01 — After pickup (PICKED_UP / OUT_FOR_DELIVERY) the D10 goods-only refund is unchanged**; the after-packing fee applies only to READY / ASSIGNED and is never stacked on the retained delivery fee.
- **D-C02 — The fee is taken only from money actually paid** (an unpaid COD order is charged nothing). A percentage fee is a share of the goods, capped; a lower admin cap set later applies at quote time to existing shop overrides. Defaults: ₹20 flat, 10% capped at ₹50, shop override allowed up to ₹100 / 20%.
- **D-C03 — The fee goes to the shop**, recorded in `order_charges` and the finance ledger as an ADJUSTMENT, paid to the shop in the next settlement as a pending SHOP_ADJUSTMENT. **GST on this fee is not computed** — CA to advise.
- **D-C04 — `cancelOrder` takes the new refund path only when the fee applies, the customer chose a refund method, or the order was paid ONLINE**; every other cancellation runs the original wallet refund unchanged (verified in review: `planCancellationRefund` returns null).
- **D-C05 — An order counts as paid online when it has no wallet debit and has a captured payment intent.** Original-method refunds are sent to the gateway after the cancel commits; the hourly `aftercare` job retries; after the last attempt, or a gateway failure, the money goes to the wallet (`refundChoice.fallbackToWallet`).
- **D-C06 — Wallet- and COD-paid orders always refund to the wallet** (no choice shown); the wallet refund is instant.
- **D-C07 — Ticket SLA clocks do not pause** while awaiting the customer or the shop; any move out of OPEN or an assignment counts as the acknowledgement; CLOSED only follows RESOLVED. Defaults 48 h / 30 days are also the maximum the setting allows (Rule 4); auto-close resolved tickets after 7 days, reopen within 14.
- **D-C08 — A shop owner sees a ticket only while it awaits the shop**; internal notes and staff-only files are support-only; anyone without access gets "not found".
- **D-C09 — A new grievance also opens a linked support ticket** (`helpdesk.ticketForGrievances`); the ticket status is mirrored onto the grievance; `GRV-` numbers are unchanged. The Grievance Redressal page keeps its IT Rules 2021 24 h / 15-day wording and adds the Rule 4 48 h / one-month commitment.
- **D-C10 — Grievance Officer details are a rule (`grievanceOfficer`)** defaulting to today's `LEGAL_ENTITY` values; an empty field falls back to the constant.
- **D-C11 — Ticket attachments (photos/PDF, 5 MB, 10 per ticket) are stored in the database row** — the existing blob store only accepts webp/zip/csv.

## WS-A — OTP, reference prices, online payment (F1.1.2, F1.4.3, F1.7.3, F1.8.4)

- **D-A01 — OTP defaults: 6 digits, 5-minute expiry (was 10), 5 attempts, 60 s resend cooldown**, limits per email, per user and per IP counted in the database (shared across instances) on top of the in-process limiter; codes HMAC-hashed; every request/verify/failure audited; expired codes purged hourly (`auth-housekeeping`, rule `otpHousekeeping`).
- **D-A02 — Every code goes through the `OtpProvider` for its channel.** Email is the active channel. SMS needs both the `SMS_PROVIDER` environment and the new `otp.smsEnabled` rule; that rule defaults **on** so the existing SMS sign-in for mobile-only shops (mock on the test site) keeps working — it can now be switched off. A `SmsOtpProvider` Phase-2 stub documents where a real vendor plugs in.
- **D-A03 — Online reference prices are dropped by a code constant** (`src/lib/price-references-drop.ts`), deliberately not an admin setting, so they cannot be switched back on by mistake: no customer/shop display, public API answers 404, admin menu entry removed (page explains the drop), the offline Open Prices CLI refuses to run without `--i-understand-dropped`. PR #23 code kept, isolated, no runtime external calls.
- **D-A04 — Provider chosen by `PAYMENT_GATEWAY` (SANDBOX default | CASHFREE | RAZORPAY | PHONEPE)**; card data never reaches GoKesari (hosted checkout / SDK session only). Razorpay and PhonePe are scaffolds with their unverified parts marked; Cashfree reuses the existing keys.
- **D-A05 — The sandbox keeps its state in the database**, so several staging instances agree; it is refused on production unless explicitly allowed (`onlinePayments.allowSandboxInProduction`, default false).
- **D-A06 — Payment state machine** `CREATED → PENDING → AUTHORIZED → CAPTURED → PARTIALLY_REFUNDED → REFUNDED`, plus `FAILED`, `EXPIRED`, enforced for every move. Webhooks: signature checked (401 and recorded when wrong), deduplicated by (gateway, event id), then the gateway's own order status is fetched before anything changes, under a row lock.
- **D-A07 — An order paid online is created PENDING and becomes CONFIRMED ("placed/paid") only on CAPTURED**; FAILED/EXPIRED → PAYMENT_FAILED with the stock put back. The attempt's key derives from the order's checkout key (`pay:<checkoutKey>:<n>`), so a retry or double click can never charge twice. WALLET and COD checkout are unchanged.
- **D-A08 — A multi-shop online cart always gets an order group and one ORDER_GROUP payment** (even with `parentOrders` off). Online payment is for personal orders only (B2B stays wallet).
- **D-A09 — Stuck attempts are reconciled every 5 minutes** (`payments-reconcile`) after `reconcileAfterMinutes` (10), up to 48 checks. A Cashfree order whose latest attempt failed is treated as FAILED; if the customer pays it later anyway, support is alerted (`payment.attention`) rather than refunding automatically.
- **D-A10 — `cancelOrder` refuses while a payment attempt is still open.**

## Integration of the six workstreams (lead)

- **D-I01 — One refund path for online-paid orders.** A and C each added one; C's runs first and owns the customer's refund record and timeline, and calls A's gateway refund. The original method is offered whenever `onlinePayments` is on and is the default for gateway money; the wallet is the customer's alternative. A's path remains only as a fallback C never reaches for paid orders.
- **D-I02 — The refund is sent to the gateway as soon as the cancellation commits, for every caller** (shop, operator, customer); the 5-minute payments job also runs C's refund sweep, so the order and timeline follow the gateway within minutes. Both sides move an order REFUND_PENDING → REFUNDED only from REFUND_PENDING, so they cannot double-transition.
- **D-I03 — Multi-shop online orders are refunded from their ORDER_GROUP payment** (partial refunds of the group payment); test TC-B26-C-057.
- **D-I04 — D's shop-owner consent OTP keeps its own email wording through A's provider** (`OtpMessage.rendered`).
- **D-I05 — Shared-list merge conflicts (env, audit actions, permissions, state machines, event subjects, mobile link paths) were resolved as unions** — every workstream's entries kept.
- **D-I06 — Rollback scripts `scripts/rollback-0079 … 0084.sql`** were generated from the migrations and verified on a migrated database, in reverse order.

## Release and production testing (lead)

- **D-R01 — Production migrations run through `MIGRATE_ON_BUILD=true` on gokesari.com** (set by the owner on 9 Oct): the release merge into `main` applies 0079–0084 before the new code goes live. All six are additive, so the running code is unaffected. Restore point: the UTC time of the release merge is recorded in the test report; Neon can restore to it. The "Production database" workflow's read-only `verify` then confirms the state — and is the first run of the F14.2.1 fix, which only takes effect once it is on `main`.
- **D-R02 — The production order lifecycle was not run.** On 14 Oct the owner chose a full production order with a real payment and will provide a production shop with delivery on, its owner's sign-in, an approved rider and confirmation of the live Cashfree keys. Placing an order at a real shop would notify a real shop owner. Production testing is therefore the production-safe subset that needs none of that: public smoke and read-only pages, every new screen refusing a signed-out visitor, webhooks and crons refusing unauthenticated calls, deep-link files, and the Production database `verify`.
- **D-R03 — Staging found one defect in the batch (fixed in #192):** test.gokesari.com runs a production build, so `NODE_ENV` checks treated it as gokesari.com and refused the sandbox gateway, its webhook secret, the GS1 mock and the default pickup-QR key. Now decided by the site's host (`AUTH_URL`), like the existing bank-account and push checks, failing safe on gokesari.com.
- **D-R04 — A barcode look-up no longer holds the request until its import finishes (S-035, 504 on staging).** The GS1 look-up on test.gokesari.com answered "504 Gateway Time-out" although its import succeeded minutes later. The look-up now waits for its import job up to 20 seconds (`LOOKUP_WAIT_MS`); a longer job carries on in the background like any import, and the reply carries its progress and a link to it. The GS1 mock no longer lists image addresses on a host that does not exist, so it never makes the server try to download them.
