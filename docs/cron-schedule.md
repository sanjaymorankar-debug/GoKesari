# Cron schedule — three entry points

*Owner decision 19 Oct 2026 (decision-log D-O04): event-based first, as agreed on 8 Oct.
Updated 24-Nov-2026: job list checked against `src/server/cron/schedule.ts` on `staging`;
since 17-Nov-2026 the jobs run as systemd timers on our own server, not as hPanel cron lines.*

Every action and notification in GoKesari is started by its event — an order
placed, accepted or delivered, a payment webhook, a document uploaded. A timer
is needed only where **no event happens**: a deadline passes, a send failed
and must be retried, a payment gateway never answered, a send is scheduled for
later, the nightly subscription orders, and the payouts.

Instead of one crontab line per job (19 lines across the earlier docs), the
site has **three entry points**. Each runs its jobs at their own cadence, in
order of urgency, and one job failing never stops the others. The code is in
`src/server/cron/schedule.ts`; the schedule is [`crontab.txt`](crontab.txt).
Most jobs are a no-op while their feature's rule or flag is off.

| Entry point | When (IST) | Jobs it runs |
|---|---|---|
| `/api/cron/every-minute` | every minute | **every minute:** `timeout-sweep` (shop not accepting in time, rider offers / broadcast / retries, no rider found, return pickups, shop-open alerts), `consult-holds` (consultant appointment times held for a payment that never came are released — docs/consult-booking-2026-11), `notification-retry` (failed sends, scheduled notices such as registration reminders, shop WhatsApp order alerts still queued), `broadcast-dispatch` (scheduled announcements), `integration-sync` (off while inventory sync is descoped), `pmd-ingest` (next batches of a large product import)<br>**every 5 min:** `payments-reconcile` (payments whose webhook never came, gateway refunds), `operator-onboarding` (registration-fee links that failed or expired), `document-emails` (invoice e-mails that failed), `franchise` (docs/franchise: holds released, areas expired, expiry reminders from 10:00 IST, the 09:00 IST digest, last month's ratings and recurring commission on the 1st from 02:00 IST — each send logged once), `dealer-scheme-launches` (docs/dealer-platform: scheme versions scheduled to launch are published)<br>**every 10 min:** `bill-captures` (supplier bills interrupted by a restart)<br>**every 15 min:** `push-receipts` (Expo delivery receipts) |
| `/api/cron/hourly` | every hour at :47 | `risk-rules` (cross-order patterns), `dispute-escalation`, `aftercare` (help-desk acknowledge / resolve deadlines, auto-close, refund retries), `payout-retries` (failed shop transfers; only with payouts on), `rider-monthly-payout` (docs/gig-bank-payouts-2026-10: **the 5th, first run from 09:00 IST**: pays riders what is unpaid for the previous month, once; resumes a stopped run; retries failed rider transfers; a no-op while flag `rider_monthly_payout_enabled` is off), `dealer-payout-retries` (failed dealer commission transfers whose backoff has passed; a no-op while `dealerAutoPayout` is off), `rbac-v2` (docs/rbac: scheduled rate activations, change-request reminders / expiry, ticket SLA; no-ops while the flags are off), `auth-housekeeping` (expired sign-in codes and session revocations) |
| `/api/cron/daily` | 05:00 | `daily-orders` (subscription orders), `seller-verification` (document upkeep, expiry, lapse, retention purges), `gst-reminders`, `payout-cycle` (**weekly shop payout: acts on Saturday morning**; on a Sunday it closes a Saturday cycle a failed run missed), `finance-weekly` (**Mondays only**: rider payouts, reconciliation, and shop settlements while automated payouts are off), `dealer-territory-daily` (territory dealers: unpaid territories expire and, after the grace days, release their pincodes; renewals reminded; today's rating — docs/dealer-programme/TERRITORY_DEALER.md), `dealer-monthly-payout` (**payout day only, default the 5th**: closes the previous month once, drafts dealer payouts and statements), `dealer-tiered-daily` (TIERED model: shops past their TRADING window lapse), `dealer-team-report-daily` and, **Mondays**, `dealer-team-report-weekly` (dealer team reports), `purchase-list-reminders` ("time to reorder" — docs/purchase-lists-2026-10), `shop-document-follow-up` (live shops missing documents: reminders, then suspension — docs/shop-documents-2026-10), `billing-daily` (docs/billing: compliance reminders, invoice catch-up, books posting, statements, credit-note IRNs; a no-op while `billing_v2` is off), `smart-list-photo-retention` and `photo-listing-purge` (docs/smart-shopping-2026-11: photos deleted after `smartShopping.photoRetentionDays`) |

Changes from the earlier separate lines (19 Oct 2026): GST reminders now go at 05:00 IST
(was 08:45), the Monday finance week at 05:00 IST (was 02:30), and the payout
cycle at 05:00 IST on Saturday (was a separate daily line at 06:10).

## On the server (since 17-Nov-2026)

The three calls are systemd timers on `gk-db-1`, the same on both sites
(`gk-cron@gokesari-prod-<job>.timer`, `gk-cron@gokesari-staging-<job>.timer`),
every minute on both sites (owner, 17-Nov-2026). Kit and commands:
[scripts/vps-app/README.md](../scripts/vps-app/README.md), "Cron".

- `gk-site cron <site> on|off|status` switches or shows a site's three timers.
- Each run is `gk-cron-call`, as the site's user: the env file supplies
  `CRON_SECRET` (never on a command line), `flock -n` skips a run while the
  previous one is still going, and curl calls the serving colour on 127.0.0.1
  with the site's Host header.
- Check once by hand: `curl -X GET https://<host>/api/cron/every-minute -H "Authorization: Bearer $CRON_SECRET"`
  answers `{"status":"ready"}`; the site's log shows `[cron:every-minute]` each minute.

## One run at a time

Each entry point runs only one copy at a time: a call that arrives while the
previous run is still going answers `{"skipped":true,"reason":"ALREADY_RUNNING"}`
straight away (`src/server/cron/single-run.ts`). A run older than 10 minutes
(every-minute), 50 minutes (hourly) or 6 hours (daily) is taken as hung, and the
next call runs anyway. This was added on 29 Oct 2026, when Hostinger's limit of
120 processes per account was reached ([docs/process-limit-2026-10/](process-limit-2026-10/README.md));
the server has no such limit, but the guard stays.

The old per-job routes (`/api/cron/timeout-sweep`, `/api/cron/payout-cycle`,
`/api/cron/daily-orders`, …) still answer, for a manual run or a backfill
(`docs/event-driven-2026-10/ROLLBACK.md`). Don't schedule them next to the
three entry points: each job would then run twice.

## Shop payouts every Saturday

Rule `payouts` defaults to a 7-day cycle from Saturday 17 Oct 2026, so the
daily run on Saturday 05:00 IST closes the Saturday-to-Saturday week and drafts
its payout batch for an administrator to approve. It needs **Admin → Settings →
`payouts` → enabled** (provider `BANK_FILE` works without any keys). While it is
off, shops are still settled by the old Monday finance week.

## History

- 19-Oct-2026: three hPanel cron lines per site replaced the per-job lines.
- 16-Nov-2026: staging's every-minute line ran only every 6 hours, to cut Neon compute.
- 17-Nov-2026: moved to systemd timers on `gk-db-1`; staging back to every minute
  (decision D7); hPanel's GoKesari cron lines removed on both sites.
