# Cron schedule — three lines (19 Oct 2026)

*Owner decision 19 Oct 2026 (decision-log D-O04): event-based first, as agreed on 8 Oct.*

Every action and notification in GoKesari is started by its event — an order
placed, accepted or delivered, a payment webhook, a document uploaded. A timer
is needed only where **no event happens**: a deadline passes, a send failed
and must be retried, a payment gateway never answered, a send is scheduled for
later, the nightly subscription orders, and the Saturday payout. The hosting
has no background worker, so a scheduler has to wake the site for these.

Instead of one crontab line per job (19 lines across the earlier docs), the
site has **three entry points**. Each runs its jobs at their own cadence, in
order of urgency, and one job failing never stops the others. The code is in
`src/server/cron/schedule.ts`; the crontab is [`crontab.txt`](crontab.txt).

| Line (UTC) | Route | Jobs it runs |
|---|---|---|
| `* * * * *` every minute | `/api/cron/every-minute` | **every minute:** `timeout-sweep` (shop not accepting in time, rider offers / broadcast / retries, no rider found, return pickups, shop-open alerts), `notification-retry`, `broadcast-dispatch` (scheduled announcements), `integration-sync` (off while inventory sync is descoped), `pmd-ingest` (next batches of a large product import)<br>**every 5 min:** `payments-reconcile` (payments whose webhook never came, gateway refunds), `operator-onboarding` (registration-fee links that failed or expired), `document-emails` (invoice e-mails that failed)<br>**every 10 min:** `bill-captures` (supplier bills interrupted by a restart)<br>**every 15 min:** `push-receipts` (Expo delivery receipts) |
| `17 * * * *` hourly | `/api/cron/hourly` | `risk-rules` (cross-order patterns), `dispute-escalation`, `aftercare` (help-desk acknowledge / resolve deadlines, auto-close, refund retries), `payout-retries` (failed transfers; only with payouts on), `auth-housekeeping` (expired sign-in codes) |
| `30 23 * * *` daily, 05:00 IST | `/api/cron/daily` | `daily-orders` (subscription orders), `seller-verification` (document upkeep, expiry, lapse, retention purges), `gst-reminders`, `payout-cycle` (**weekly shop payout: acts on Saturday morning**; a no-op on other days), `finance-weekly` (**Mondays only**: rider payouts, reconciliation, and shop settlements while automated payouts are off), `purchase-list-reminders` ("time to reorder" for customers' weekly / monthly lists that are due again — docs/purchase-lists-2026-10) |

Changes from the earlier separate lines: GST reminders now go at 05:00 IST
(was 08:45), the Monday finance week at 05:00 IST (was 02:30), and the payout
cycle at 05:00 IST on Saturday (was a separate daily line at 06:10). Every
other job keeps its cadence.

## One run at a time (29 Oct 2026)

Hostinger counts every process on the account against one limit of 120, and it
reported the account reaching it. So each entry point runs only one copy at a
time: a call that arrives while the previous run is still going answers
`{"skipped":true,"reason":"ALREADY_RUNNING"}` straight away
(`src/server/cron/single-run.ts`). A run older than 10 minutes (every-minute),
50 minutes (hourly) or 6 hours (daily) is taken as hung, and the next call runs
anyway. On the host side each crontab line wraps its curl in `flock -n` with a
`--max-time`, so curls never stack up either ([`crontab.txt`](crontab.txt)).

## Install (owner)

1. On test.gokesari.com, replace every GoKesari line in the Hostinger crontab
   with the three lines in [`crontab.txt`](crontab.txt).
2. If your `$HOME/gokesari-cron/run.sh` has a list of allowed job names (the
   reference `docs/event-driven-2026-10/run.sh.example` does), add
   `every-minute`, `hourly` and `daily` to it — or use the plain `curl` lines
   at the bottom of `crontab.txt`.
3. Check once: `curl -X GET https://<host>/api/cron/every-minute -H "Authorization: Bearer $CRON_SECRET"`
   answers `{"status":"ready"}`; the logs show `[cron:every-minute]` each minute.
4. Then do the same on gokesari.com.

The old per-job routes (`/api/cron/timeout-sweep`, `/api/cron/payout-cycle`, …)
stay, for a manual run or to go back to the old crontab
(`docs/event-driven-2026-10/ROLLBACK.md`).

## Shop payouts every Saturday

Rule `payouts` defaults to a 7-day cycle from Saturday 17 Oct 2026, so the
daily run on Saturday 05:00 IST closes the Saturday-to-Saturday week and drafts
its payout batch for an administrator to approve. It needs **Admin → Settings →
`payouts` → enabled** (provider `BANK_FILE` works without any keys). While it is
off, shops are still settled by the old Monday finance week.
