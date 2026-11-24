# PAY-SM: payment states RECONCILED and CHARGEBACK

24-Nov-2026. An open-features item that needed no decision from the owner. Until now support has handled
these cases by hand. This change ships **switched off** behind feature flag `payment_settlement_states`.

## What it does

| State | Set when | Set by |
|---|---|---|
| `RECONCILED` | The gateway's own status check (`fetchOrder`) shows the same payment captured for the same amount (to the paisa). | The payments job (`payments-reconcile`, every 5 minutes inside the every-minute cron; `docs/crontab.txt`). |
| `CHARGEBACK` | Cashfree sends a dispute webhook (`DISPUTE_CREATED` / `DISPUTE_UPDATED` / `DISPUTE_CLOSED`) for the payment. | `POST /api/webhooks/payments/cashfree`, the same URL as payment webhooks. |

The transitions are `none → RECONCILED → CHARGEBACK` and `none → CHARGEBACK`. A payment stays `CHARGEBACK`
whatever the dispute's outcome. The outcome (OPEN / WON / LOST / CLOSED) is kept on the dispute row.

## Design

- **Its own column, not `status`.** `payment_intents.settlement_state` is new, and `status` is left alone.
  About 25 places read `status` (refund eligibility, finance reports, health / consult / franchise handlers,
  the payment return page). Folding the new states into `status` would have changed all of them, and a
  refund after reconciling would have lost the RECONCILED marker. With a separate column, turning the flag
  off restores the old behaviour exactly.
- **Migration 0200** (`drizzle/0200_payment_settlement_states.sql`) adds:
  - on `payment_intents`: `settlement_state` (checked), `reconciled_at`, `settlement_checked_at` and
    `settlement_checks`;
  - a partial index over the job's work list;
  - the table `payment_chargebacks`, unique on (gateway, gateway_dispute_id);
  - the flag row, seeded OFF.

  The migration is additive and safe to re-run.
- **Reconcile job** (`src/server/payments/settlement.ts`, `runSettlementReconciliation`):
  - **Which payments it checks:** status CAPTURED, PARTIALLY_REFUNDED or REFUNDED; captured more than
    `checkAfterMinutes` ago and less than `lookbackDays` ago; not checked in the last `recheckMinutes`;
    fewer than `maxChecks` checks so far. At most `batchSize` per run.
  - **Gateway call:** made with no transaction open. The answer is then applied under `SELECT … FOR UPDATE`,
    and the state is checked again under that lock.
  - **When the gateway disagrees** (not captured, a different amount or a different payment id): support
    gets a `payment.attention` alert, once for each distinct answer. When `maxChecks` is reached, one
    "gave up" alert is sent and the job stops asking about that payment.
  - **When the gateway can't be reached:** the try is counted, so one broken payment can't block the queue.
  - **Settings:** rule `paymentSettlement`, defaults 30 min / 360 min / 45 days / 12 checks / 50 per run.
- **Chargeback webhook** (`applyDisputeEvent`):
  - **Checks first:** the signature is verified (HMAC-SHA256 over timestamp + raw body, 5-minute freshness).
    A bad signature gets 401 and is recorded. Duplicates are dropped by event id (Cashfree's
    `x-idempotency-key`, else type + dispute id + status + change time) through the existing
    `payment_webhook_events` unique key.
  - **What's recorded:**
    - amount in integer paise, reason code and text, respond-by deadline, dispute type, Cashfree's status
      word and outcome;
    - the intent is matched on merchant order id, gateway order id or payment id. A dispute on a payment
      that isn't an intent (for example a legacy wallet top-up) is still recorded, with no intent.
  - **Order safety:** a webhook older than the last one applied changes nothing (`DISPUTE_STALE`).
  - **Alerts:** event `payment.chargeback` goes to admins only (`SUPPORT_LEAD`), as notification
    `support.payment_chargeback`. It is sent when the dispute opens and again each time the outcome changes.
- **Audit trail:**
  - every settlement-state change writes a `payment_intent_events` row (so it appears in the order's money
    trail on Admin → Finance) and an audit row `payment.settlement_state_changed`;
  - every dispute write adds an audit row `payment.chargeback_recorded`.
- **Admin view:**
  - the order money trail on `/admin/finance` shows RECONCILED / CHARGEBACK next to each online payment;
  - a new page, Admin → Payments → Chargebacks (`/admin/payments/chargebacks`, FINANCE_VIEW, visible only
    while the flag is on), lists open disputes first, nearest deadline first, and marks overdue ones.

## Flag off (default)

- The reconcile step returns `{ skipped: true, reason: "FLAG_OFF" }` without calling the gateway.
- Dispute webhooks are verified, logged and de-duplicated as before, with outcome `DISPUTE_FLAG_OFF`. They
  change no row and send no alert. Disputes that arrive while the flag is off are **not** replayed when it
  is switched on. Their raw payloads stay in `payment_webhook_events`.

## Not in this change

- **Late-capture auto-refund cap:** the existing code has no placeholder for it. A late capture (money taken
  after an attempt failed or expired) still raises a `payment.attention` alert for a person, as before.
  Per the brief, nothing was added.
- **Settlement-report reconciliation:** checking Cashfree's settlement reports (`/settlements`) is not
  included. RECONCILED rests on the status check, which the brief allows ("settlement or status check").
- **Accounting for a lost chargeback:** no ledger or refund entries are made for the debited amount.
  Finance handles that from the Chargebacks page.
- **Legacy top-up webhook:** `/api/webhooks/cashfree` is unchanged. PAY-2 is merging top-ups into payment
  intents. Cashfree's dispute webhook must point at `/api/webhooks/payments/cashfree`.
- **Unconfirmed field names:** the dispute payload follows Cashfree's published PG 2023-08-01 dispute
  webhook. No live dispute can be raised from this environment, so the field names are unconfirmed, in the
  same way as the link-payment fields in `gateway/cashfree.ts`.

## Switching it on

1. Admin → Feature flags → "Online payments: reconciled and chargeback states", on test.gokesari.com first.
2. In the Cashfree dashboard (Developers → Webhooks), add the dispute events with URL
   `https://<site>/api/webhooks/payments/cashfree`.
3. Within about 30 minutes of a capture, the payment shows RECONCILED in its money trail.

## Tests

- `tests/unit/payment-settlement.test.ts`: the state machine, the gateway comparison, and Cashfree dispute
  parsing (paise, deadline, exact big payment ids, event id).
- `tests/integration/payment-settlement-states.test.ts` (PAYSM-01…09):
  - flag off;
  - reconcile and its idempotency;
  - refunded, fresh and old payments;
  - disagreement alerts and giving up;
  - gateway errors;
  - bad signature;
  - recording, alerting and auditing a chargeback;
  - duplicate, later and stale events;
  - a dispute on a payment that isn't an intent.
