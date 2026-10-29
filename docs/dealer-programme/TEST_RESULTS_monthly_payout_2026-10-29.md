# Dealer commission monthly payout — test results (29 Oct 2026)

Branch `claude/dealer-monthly-payout`, based on staging 745086e, staging 45cb376 merged in. Migration 0115 (renumbered: staging took 0113 for the onboarding wizard and 0114 for the all-India states). Local PostgreSQL 18
(Postgres.app). Run by Claude.

## New tests — `tests/integration/dealer-monthly-payout.test.ts`

| Layout | Result |
|---|---|
| One database | **12 / 12 passed** |
| Two databases (seller tables through postgres_fdw) | **12 / 12 passed** |

| # | Case | Result |
|---|---|---|
| 1 | Months: previous month, IST month bounds, labels | Pass |
| 2 | Before the 5th nothing; on the 5th a DRAFT payout of September's approved commission (only approved — an earned entry waits); statement notice to the dealer (2 shops, ₹200 earned, ₹100 payout, link to the month); a second run and an admin close change nothing; audited | Pass |
| 3 | A missed run catches up later in the month | Pass |
| 4a | Approve-at-close is **on by default** (owner, 29 Oct 2026): a fresh settings row and the built-in fallback both have it on | Pass |
| 4 | Approve-at-close on: September's earned entry approved and paid; held and above-cap entries not; an October entry waits | Pass |
| 5 | Approved commission left from an earlier month is paid with this one; the statement lists the payout's entries | Pass |
| 6 | A reversal owed back (after an earlier payout) is carried forward — no negative payout; the statement shows it | Pass |
| 7 | A cancelled monthly draft's entries go into the next month's payout | Pass |
| 8 | Dealer programme off → nothing | Pass |
| 9 | Statement: the month's registrations and entries only, another dealer's shop never shown; CSV download for the dealer's own month; bad month → 422 | Pass |
| 10 | Paying a monthly draft records the UTR and tells the dealer ("Commission paid") as before | Pass |
| 11 | Admin "close now"; operator refused (route 403 and service); a month not over refused (409); payout day 29 refused, 7 accepted | Pass |

## Related tests

All dealer-programme tests (steps 1–8), cron schedule and safety net, split ownership, migration
journal: **142 / 142 on each layout**. The cron-schedule test was updated for the new daily job
`dealer-monthly-payout` (it lists every job).

The full suite was not run locally for this branch; CI's `test` and `test-split` jobs run it on the PR.

## Re-run after the default change (29 Oct 2026)

Owner decision: approve-at-close on by default (migration column default, schema default and the
fallback settings). Payout tests that rely on the old default set it off explicitly, as before.
`dealer-monthly-payout`, `dealer-step5-commission`, `dealer-step6-dashboard`, split ownership and
migration journal: **40 / 40 on two databases**; with `migrate-on-build` added, **46 / 46 on one
database**.

## After merging staging (onboarding wizard 0113, all-India states 0114) — migration renumbered to 0115

Staging f501049 (all-India dealer programme, seller-verification fixes) merged in. Every dealer
test (steps 1–8 and the monthly payout), onboarding wizard step 2, seller-verification flows, cron
schedule, split ownership, migration journal: **176 / 176 on each layout**. `migrate-on-build`
(rolls back through 0115, 0114 and 0113 and re-applies): **6 / 6** (one earlier run timed out in
the known clean-up hook; passed when re-run).

## After merging staging 5f134ad (India states moved to when 1793161250000)

0115 now has `when` 1793161300000, after 0114_india_states. Staging's databases already ran an
earlier copy of 0115 (from this branch's Hostinger preview build), so it will run there again:
running the file a second time on a migrated database works (every statement is IF NOT EXISTS /
DROP IF EXISTS; the approval default is set again). Every dealer test, wizard step 2, cron schedule,
split ownership, migration journal: **158 / 158 on each layout**; `migrate-on-build` **6 / 6**
(one earlier run timed out in the known clean-up hook; passed when re-run).

## Not covered here

- The real email delivery (the notification outbox sends it; the queued notice is checked).
- A run on test.gokesari.com: after merge, "Close <month> now" on Admin → Dealers → Commission.
