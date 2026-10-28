# Dealer commission monthly payout — test results (29 Oct 2026)

Branch `claude/dealer-monthly-payout`, based on staging 745086e. Migration 0113. Local PostgreSQL 18
(Postgres.app). Run by Claude.

## New tests — `tests/integration/dealer-monthly-payout.test.ts`

| Layout | Result |
|---|---|
| One database | **11 / 11 passed** |
| Two databases (seller tables through postgres_fdw) | **11 / 11 passed** |

| # | Case | Result |
|---|---|---|
| 1 | Months: previous month, IST month bounds, labels | Pass |
| 2 | Before the 5th nothing; on the 5th a DRAFT payout of September's approved commission (only approved — an earned entry waits); statement notice to the dealer (2 shops, ₹200 earned, ₹100 payout, link to the month); a second run and an admin close change nothing; audited | Pass |
| 3 | A missed run catches up later in the month | Pass |
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

## Not covered here

- The real email delivery (the notification outbox sends it; the queued notice is checked).
- A run on test.gokesari.com: after merge, "Close <month> now" on Admin → Dealers → Commission.
