# Event-driven workflows — cron only as a safety net (test.gokesari.com)

**Scope:** test site only (`staging` branch → test.gokesari.com). Production
(gokesari.com, `main`) is not touched. Migration: **0058** (additive).

| File | What it is |
|---|---|
| [TEST_CHECKLIST.md](TEST_CHECKLIST.md) | Every event: what to do, the status that results, who is notified |
| [ROLLBACK.md](ROLLBACK.md) | Re-enabling the old cron jobs, and the deeper undo levels |
| [crontab.test.txt](crontab.test.txt) | The new crontab: Phase A (during testing) and Phase B (final) |
| [crontab.previous.txt](crontab.previous.txt) | The old block, for rollback |
| [run.sh.example](run.sh.example) | Reference `run.sh` (test-only guard, lock, log) |
| [test-settings.sql](test-settings.sql) | X = 30, Y = 30, N = 4, SLA = 24 h and the new switches, for the test DB |

## What changed

Before, most state changes already happened in the request — but who heard
about them was patchy, several steps waited for a minute cron, and the crons
mixed "do the work" with "catch what fell through". Now:

1. **One event layer.** `emitEvent(type, payload)` (`src/server/events/emit.ts`)
   is called by the service that changes state, **inside the same
   transaction**. In that request it
   - checks the move against the single state-machine registry
     (`src/lib/state-machines.ts`: order, delivery, seller document, dispute)
     and rejects an illegal transition (HTTP 409, whole change rolled back);
   - writes a `domain_events` row (the business-event audit log; `audit_logs`
     is unchanged);
   - notifies every stakeholder the catalogue names
     (`src/server/events/catalog.ts` — the one place that says who hears
     what): the in-app notification immediately, each email queued in
     `notification_deliveries` and sent right after commit;
   - is **idempotent**: a repeated click fails the state-machine check and
     notifies nobody; sweeps and retries pass an `idempotencyKey` (unique), and
     every notification carries a dedupe key derived from the event.
2. **Outbox.** `notification_deliveries` already was a transactional outbox
   (every send is a row with `attempts`, `max_attempts`, backoff, `DEAD`), so it
   is reused rather than adding a second `notification_outbox` table. New: a
   message given up on after N attempts alerts support in the app (once per
   run, never an alert about an alert).
3. **Real-time flows** — see the checklist for the full matrix:
   - *Shop acceptance:* accept → customer told at once. Reject → cancelled,
     reason sent to the customer, full refund including the delivery fee.
   - *Delivery:* rider offered / accepted / declined (next rider offered
     immediately) / picked up / started / delivered / failed — each updates
     both statuses and notifies the customer **and the shop** at once.
   - *Seller verification:* checked in the seller's own request; verified →
     seller told; manual review → seller told what is pending and support gets
     a review link; approve / reject / **ask for more info** → seller and the
     other reviewers told; optional auto-approval of the shop once every
     mandatory document is verified and the fee is paid.
   - *Disputes:* case number at once, linked to the order, with reason and
     photos; shop and support told; customer, shop and support can comment
     (support can leave internal notes); the shop can propose a resolution;
     every update notifies the other parties.
   - *Risk:* the per-order rules run at placement (`HIGH_VALUE_OUTLIER`) and on
     a failed payment (`TOPUP_FAILURES`); the hourly job stays as the
     cross-order pattern scan. New flags alert support.
4. **Cron is the safety net only** — `timeout-sweep` and `notification-retry`
   every minute; risk scan and dispute SLA hourly; daily-orders and
   seller-verification (document upkeep + stuck-review reminder) daily;
   finance weekly. See `crontab.test.txt`.

## Live tracking: 5-second polling, not SSE or WebSockets

**Chosen: polling every 5 seconds** (configurable: rule `tracking`).

- **Hosting.** test.gokesari.com runs on Hostinger's managed Node.js web-app
  hosting behind its proxy/CDN. Nothing in this repo or its deploy docs
  establishes that WebSockets are supported there, so they are out. Server-Sent
  Events need one long-lived HTTP response per viewer; proxies and CDNs commonly
  buffer or time those out, and a held-open request also ties up the Node
  process for its whole life. Polling has none of these failure modes.
- **It is what already works.** `GET /api/tracking/{orderId}` already exists,
  already enforces who may see what, and its road ETA is cached per ~100 m —
  so a 5-second poll is a cheap indexed read.
- **The data only changes every 5 s anyway.** The rider's phone posts every
  5 s, so a push channel would not show the rider any sooner.
- **Cost stays bounded.** The poll (and the one Google Maps JavaScript load for
  the map) starts only when the customer presses **Track delivery**, and stops
  when the order is delivered or cancelled.

**Privacy.** The rider's location is posted to
`POST /api/delivery-orders/{id}/location` (authenticated; only the rider holding
that delivery; `403` otherwise) and shown only from the start of the drop
until it is delivered or cancelled — to the order's customer, its shop and
support. After that the endpoint stores nothing and tells the phone to stop.
Only the rider's latest position is kept (on their own record — nearest-rider
matching needs it while they are online); no trail of any trip is stored.

## Configuration (Admin → Business rules)

All values are editable without a deploy; `test-settings.sql` sets them on
the test database.

| Value | Rule key | Code default | Test value |
|---|---|---|---|
| **X** — minutes for a shop to accept | `shopAcceptance.acceptMinutes` (+ `enabled`) | 30 (rule off) | 30, on |
| What happens at X | `shopAcceptance.onTimeout` | `CANCEL` | `CANCEL` (or `ESCALATE`) |
| **Y** — minutes with no rider before support is alerted | `dispatch.alertSupportAfterMinutes` | 30 | 30 |
| **N** — send attempts before a message is dead | `notifications.maxAttempts` | 4 | 4 |
| **Dispute SLA** — hours without a reply before escalation | `disputes.responseSlaHours` | 24 | 24 |
| Auto-approve a fully verified shop | `sellerVerification.autoApproveShop` | off | on |
| Classification given on auto-approval | `sellerVerification.autoApproveClassification` | `GREEN` | `GREEN` |
| Stuck-in-review reminder after | `sellerVerification.manualReviewReminderHours` | 24 | 24 |
| Rider ping / map refresh | `tracking.riderPingSeconds` / `buyerPollSeconds` | 5 / 5 | 5 / 5 |

Switches that change outcomes for real customers or sellers (acceptance
timeout, auto-approval) stay **off by default in code**, so nothing changes on
production when this is eventually promoted until the same settings are made
there on purpose.

## Deploying to test

1. Back up the test database:
   `pg_dump "$TEST_DATABASE_URL" -Fc -f gokesari_test_pre_0058_$(date +%F_%H%M).dump`
2. Migrate it to 0058 — `DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate`,
   or set `MIGRATE_ON_BUILD=true` on test.gokesari.com before the deploy
   (DEPLOYMENT.md §4). Expect one new migration, newest `1791444892056`.
3. Merge the PR into **`staging`** (Hostinger redeploys test.gokesari.com).
4. Run `test-settings.sql` against the **test** database.
5. Crontab → **Phase A** of `crontab.test.txt` (new jobs alongside the old).
   If your `run.sh` already POSTs `/api/cron/<job>`, it needs no change.
6. Work through `TEST_CHECKLIST.md`.
7. All green → crontab **Phase B** (old polling jobs removed).

## Decisions taken (flag any you want changed)

- **Rider dispatch starts when the shop marks the order READY (packed), not at
  accept.** Starting at accept would send riders to shops before orders are
  packed, and the rider flow (pickup code, ASSIGNED) assumes a packed order.
  The customer and the shop are told the moment the search starts.
- **The customer is not told when a rider declines** — only the shop is; the
  customer hears when a rider accepts. A customer cancelling an order the shop
  has not yet accepted still does not notify the shop (existing decision D10).
- **Shops propose resolutions only after support has triaged the case** (the
  existing dispute lifecycle). Before that they reply in the conversation.
  Money decisions (refunds) stay with support.
- **"Support" = operators and administrators; "support lead" = administrators**
  (there is no separate support role). Escalated disputes go to administrators.
- **Auto-approved shops get classification GREEN** unless they already have
  one (configurable; operators can change it later).
- **Notifications are in the app and by email.** SMS / WhatsApp / push plug in
  through the existing channel framework once a provider is chosen.
- **seller-verification stays a daily job**: the submission check is now
  real-time, but expiry warnings, GSTIN re-checks, vendor-outage retries,
  suspension on lapse and DPDP erasure depend on time passing; the daily job
  now also sends the stuck-in-review reminder.

## Code map

| Area | Files |
|---|---|
| Event layer | `src/server/events/{emit,catalog,recipients}.ts`, `src/lib/state-machines.ts`, `drizzle/0058_event_layer.sql` |
| Orders / delivery | `src/server/services/{orders,delivery-assignment,shop-acceptance}.ts` |
| Tracking | `src/app/api/delivery-orders/[id]/location`, `src/app/api/tracking/[orderId]`, `src/lib/tracking.ts`, `src/components/{live-tracking-map,delivery-partner-dashboard}.tsx` |
| Notifications | `src/server/services/notifications.ts`, `src/server/notifications/{types,templates}.ts` |
| Seller verification | `src/server/services/{seller-verification,seller-verification-jobs,shops,shop-onboarding,shop-payments}.ts` |
| Disputes | `src/server/services/disputes.ts`, `src/app/api/disputes/**`, `src/app/disputes/[id]`, `src/app/orders/[id]/dispute`, `src/app/shop/disputes`, `src/components/dispute-case.tsx` |
| Risk | `src/server/services/risk.ts` |
| Cron | `src/app/api/cron/{timeout-sweep,notification-retry}` (new); old routes kept for rollback |
| Tests | `tests/integration/{event-layer,seller-verification-events,dispute-events,risk-events,cron-safety-net}.test.ts`, `tests/unit/tracking.test.ts` |
