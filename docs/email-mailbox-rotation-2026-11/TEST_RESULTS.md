# E-mail mailbox rotation — test results (21-Nov-2026)

Feature: GoKesari sends every e-mail (sign-in codes, notifications, invoices) from a pool of
Hostinger mailboxes in turn — `code1@gokesari.com` … `code10@gokesari.com`, each up to 90 e-mails
in a rolling 24 hours, then the next one; `support@gokesari.com` last.
PR: https://github.com/sanjaymorankar-debug/GoKesari/pull/451 (migration 0158, table `email_mailbox_sends`).

| # | Test | Where | Result | When (IST) |
|---|---|---|---|---|
| 1 | Unit: pool settings parsed, order kept, duplicates and unusable entries skipped, no password in logs | Local | Pass | 21-Nov 09.43 |
| 2 | Unit: cap of 90 per mailbox, refused mailbox paused 1 hour, server refusals read correctly (limit / wrong password / connection / bad message) | Local | Pass | 21-Nov 09.43 |
| 3 | Integration: fills code1 → code2 → main mailbox, then stops when all are full | Local DB | Pass | 21-Nov 09.43 |
| 4 | Integration: rolling 24 h — a send older than 24 h no longer counts | Local DB | Pass | 21-Nov 09.43 |
| 5 | Integration: Hostinger limit or wrong password → next mailbox at once, first one paused 1 h | Local DB | Pass | 21-Nov 09.43 |
| 6 | Integration: connection problem → next mailbox, no pause; bad recipient → not resent | Local DB | Pass | 21-Nov 09.43 |
| 7 | Integration: counts older than 2 days deleted by the hourly clean-up | Local DB | Pass | 21-Nov 09.43 |
| 8 | Regression after merging staging (franchise #446): all unit tests + OTP, sign-in, cron suites — 100 files / 1,302 tests | Local DB (159 migrations) | Pass | 21-Nov 10.40 |
| 9 | All 10 mailboxes sign in with the saved password (sign-in only, nothing sent) | gokesari.com server settings | Pass (10/10) | 21-Nov 10.32 |
| 10 | Same check | test.gokesari.com server settings | Pass (10/10) | 21-Nov 10.32 |
| 11 | Staging queue: CI, migration 0158, deploy, site up, guest QA | test.gokesari.com | Pass (`staging-verified`) | 21-Nov 12.12 |
| 12 | Sign-in code requested for testing@gokesari.com → sent from code1@gokesari.com (recorded in `email_mailbox_sends`) | test.gokesari.com | Pass | 21-Nov 12.13 |
| 13 | That code delivered to testing@gokesari.com INBOX (Hostinger mail log) | Hostinger | Pass | 21-Nov 12.13 |
| 14 | Production release #455 (migration 0158 applied 12.19, merged 12.51, post-deploy check 5/5 passed 12.57) | gokesari.com | Pass | 21-Nov 12.57 |
| 15 | First live e-mail after the release sent from code1@gokesari.com (`email_mailbox_sends` on the production database) | gokesari.com | Pass | 21-Nov 13.00 |

Settings (both sites, owner's "one combined pool"): `EMAIL_POOL` = code1 … code10 in the same order;
`EMAIL_POOL_PASSWORD` entered by the owner 21-Nov 10.20 IST; cap 90 (default).
