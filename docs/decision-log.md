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
