# Hostinger process-limit work — status

## Step 0 audit (from the repo)
- Cron routes: `src/app/api/cron/*` — daily-orders, delivery-dispatch, dispute-escalation, finance-weekly, notification-retry, notifications, risk-rules, seller-verification, shop-acceptance, timeout-sweep.
- In-app schedulers (`node-cron`, `setInterval`, `instrumentation.ts` jobs): **none**. `instrumentation.ts` only logs request errors.
- Callers are external (hPanel Cron Jobs / crontab, see `docs/event-driven-2026-10/crontab.test.txt`). **Not verifiable from the repo:** hPanel entries on prod and test, cron-job.org, GitHub Actions, access-log IPs. Those must be deleted by hand (list below).

## Done in this change (staging branch, uncommitted)
| Item | Status | Notes |
|---|---|---|
| A. Dispute status/SLA/audit schema | Done (pre-existing) | `order_disputes` (status, level, escalated_at, awaiting_response_since), `dispute_events`. No migration needed. |
| A. Escalate on next touch | Done | `escalateOnTouch()` in `services/disputes.ts`; runs on dispute view, comment, status change, and queue load. Row-locked, so no double escalation. Off with `DISPUTE_ESCALATE_ON_TOUCH=false`. |
| A. Queue shows overdue first | Done (pre-existing) | Escalated (L2) cases sort to the top. No "SLA breached" badge added yet. |
| A. Admin "Run escalation sweep now" | Done | `POST /api/admin/escalation-sweep`, button on /admin/disputes. |
| B. Risk rules at event time | Partial (pre-existing) | Per-order rules already run at placement and failed payment. Not yet: cancel, refund, dispute, shop registration, counters. |
| C. Cron routes neutralised | Done | `src/proxy.ts`: 410 unless `CRON_ROUTES_ENABLED=true`; then `x-cron-secret` (or Bearer) constant-time check, 401 before any DB work. |
| C2. One cron run at a time | Done (29 Oct) | `src/server/cron/single-run.ts` skips an overlapping every-minute / hourly / daily call; `docs/crontab.txt` lines use `flock -n` and `curl --max-time`. |
| C. Delete external schedulers | **Not started — manual** | Remove crontab/hPanel entries on both domains first; the old jobs now get 410. |
| D1. Prefetch off | Done | `prefetch={false}` on Links in cards, grids, footer, shop/search/category pages. Header nav untouched. |
| D2. ISR for / , /shops, categories | **Not started** | Pages read the user and saved location server-side; needs moving those to client components first. |
| D3. /api/shops caching | Done | 60 s in-memory cache + `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` for anonymous calls. Client SWR/dedupe not done. |
| D4–D5. Cart client render, debounce, rounding | Not started | |
| D6. Images | Done | `images.unoptimized: true`. |
| D7. Neon pooling / indexes | Not started | |
| D8. Test-site protection | Done | `TEST_SITE_BASIC_AUTH=user:pass` env turns on basic auth + noindex; robots.txt disallows all on `test.*`. |
| D9. Prod robots + API rate limit | Done | robots disallows /api/, /cart, /search; `API_RATE_LIMIT_PER_MIN` (default 240) in proxy. |
| E. Measurements, Hostinger metrics, Prod tests | Not started | Needs deploy and hPanel access. |
| Mobile apps | Not started | No mobile app code in this repo. |

## Verification so far
- `tsc --noEmit`: no errors in `src/`. Pre-existing errors only in `scripts/backfill-delivery-partner-kyc.ts` and the stray nested `GoKesari/` folder.
- Vitest: could not run — `TEST_DATABASE_URL` is not set here. No tests written for the new code yet.
- Not built, not deployed.

## Env flags to set on Hostinger
`CRON_ROUTES_ENABLED` (unset = off), `DISPUTE_ESCALATE_ON_TOUCH`, `TEST_SITE_BASIC_AUTH` (test only), `API_RATE_LIMIT_PER_MIN`.
