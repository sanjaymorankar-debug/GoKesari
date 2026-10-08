# Rollback — event layer (test.gokesari.com)

Four levels, smallest first. Each one stands on its own; go only as far as the
problem needs. Production (gokesari.com) is never involved: this release goes to
the `staging` branch / test site only.

## 1. Cron only — re-enable the old polling jobs (minutes, no deploy)

The old cron endpoints were **not removed**: `/api/cron/shop-acceptance`,
`/api/cron/delivery-dispatch` and `/api/cron/notifications` are still in the
code and still do what they did. `seller-verification` was never removed.

1. `crontab -e` on the test host.
2. Replace the block with [`crontab.previous.txt`](crontab.previous.txt) (or your
   own saved copy from `crontab -l` before the change — that is the source of
   truth).
3. Check wiring without side effects:
   ```bash
   for job in shop-acceptance delivery-dispatch notifications; do
     curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://test.gokesari.com/api/cron/$job; echo
   done   # each prints {"status":"ready"}
   ```
4. Watch `$HOME/gokesari-cron/logs/*.log` for a minute.

It is safe to run the old and new jobs together (Phase A in
[`crontab.test.txt`](crontab.test.txt) does exactly that): they are the same
row-locked, idempotent sweeps. So if you are unsure, **add** the old lines back
rather than swapping.

## 2. Behaviour — switch individual features back (seconds, no deploy)

Admin → Business rules → "Restore default", or SQL on the **test** database:

| To undo | Do |
|---|---|
| Shop acceptance timeout | `shopAcceptance` → `{"enabled": false}` (orders wait for the shop, as before NEW-007) |
| Escalate instead of cancel | `shopAcceptance.onTimeout` → `"CANCEL"` |
| Rider "no-accept" support alert | `dispatch.alertSupportAfterMinutes` → `720` (effectively off) |
| Dead-letter support alert | `notifications.alertSupportOnDead` → `false` |
| Dispute SLA escalation | `disputes.responseSlaHours` → `0` (the 48 h age trigger is unaffected) |
| Shop auto-approval | `sellerVerification.autoApproveShop` → `false` (an admin approves, as before) |

```sql
-- Restore every rule this release touched to its code default (test DB only):
DELETE FROM platform_settings
WHERE key IN ('shopAcceptance', 'dispatch', 'notifications', 'disputes', 'sellerVerification', 'tracking');
```
Careful: that DELETE also drops overrides that existed **before** this release
(e.g. `shopAcceptance` was switched on in the items A–E runbook, and `dispatch`
may hold `busyRidersAsFallback`). Prefer editing the one key.

## 3. Code — go back to the previous build

The release is one PR into `staging`. Revert its merge commit on `staging`
(`git revert -m 1 <merge-sha>`, then push), and Hostinger redeploys
test.gokesari.com. Do level 1 first: the previous build has no
`/api/cron/timeout-sweep` or `/api/cron/notification-retry`, so the new cron
lines would start failing with 404 (harmless, but noisy).

The previous build ignores the new tables and columns, so the database can stay
on 0058 — level 4 is optional.

## 4. Database — remove migration 0058 (only after level 3)

0058 is additive: three new tables (`domain_events`, `dispute_comments`,
`dispute_attachments`) and four nullable columns. No existing row was changed.

1. Back up: `pg_dump "$TEST_DATABASE_URL" -Fc -f gokesari_test_pre_rollback_0058_$(date +%F_%H%M).dump`
2. `psql "$TEST_DATABASE_URL" -f scripts/rollback-0058.sql`
3. `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791444892056;` (the 0058 row)

This deletes the event log and every dispute comment and photo link written
since the release. Dispute photos stay in `stored_images` unless you also run
the optional DELETE in the script.

## What rollback does not undo

- Notifications already sent stay sent.
- Shops approved automatically stay approved (find them:
  `select entity_id from audit_logs where action = 'shop.auto_approved'`).
- Orders cancelled by the acceptance timeout stay cancelled and refunded — the
  same as before this release with the rule on.
