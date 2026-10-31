# Test results — rider bank account, withdrawals, monthly payout

31 Oct 2026 · branch `feat/gig-bank-payouts`, PR #309 into staging · migration 0123 (written as 0121, renumbered after #306 and #307 merged) ·
docs: [README.md](README.md), [FINDINGS.md](FINDINGS.md)

## Environment

| Item | Value |
|---|---|
| Where | Owner's Mac, local only. **Not yet run on test.gokesari.com or gokesari.com** (the branch is not pushed; see "Not done") |
| Database | PostgreSQL 18.6 (Postgres.app), throwaway server in the temp folder; every migration 0000–0121 applied from empty |
| Layouts | single database (`gk_core`), and the two-database split built with `scripts/db-split/test-layout.ts` (`gks_core` + `gks_seller`, `DB_SPLIT_MODE=split`) |
| Payout provider | SANDBOX (deterministic; signed webhooks through `/api/webhooks/payouts/sandbox`) |
| UI | `next dev` on localhost:3900 with a seeded admin and an approved rider (verified account, ₹1,317 earnings), built-in browser, desktop and 375 px phone width |
| Payments | No real money, no Cashfree call. Sandbox outcomes by paise: …98 always fails, …99 fails once |

## Results summary

| Suite | Single database | Split layout |
|---|---|---|
| New unit tests `tests/unit/rider-wallet-rules.test.ts` (TDS, limits, payout time, months, FY) | 20 / 20 pass | n/a (no database) |
| Guard unit tests (split ownership, migration journal, templates) | 23 / 23 pass | n/a |
| New integration `tests/integration/rider-bank-payouts.test.ts` | 13 / 13 pass | 13 / 13 pass |
| Regression: bank accounts, shop payouts (batch E), bank refunds | 33 / 33 pass | 29 / 29 pass (bank accounts + batch E) |
| `tests/integration/migrate-on-build.test.ts` (rewinds to 0055 with every rollback script) | 7 / 7 pass after adding `rollback-0123.sql` to its rewind (see D1) | 7 / 7 pass |
| Full suite | FULL_SINGLE | FULL_SPLIT |
| Type check (`tsc --noEmit`), ESLint on changed files | clean | — |

## Test cases (brief §5.3 minimum)

| ID | Case | How | Result |
|---|---|---|---|
| TC-RB-01 | Customer adds and verifies a bank account | integration: PUT /api/bank-account → ₹1 verification (simulator) → VERIFIED; number masked, stored encrypted | Pass |
| TC-RB-02 | Delivery partner adds and verifies a bank account | same, as a delivery partner | Pass |
| TC-RB-03 | Changing a rider's verified account needs an emailed code; wrong code refused; one code = one change; customers never asked | integration | Pass |
| TC-RB-04 | Removing a rider's account needs a code; not while a payment is on its way | integration | Pass |
| TC-RB-05 | Withdrawal succeeds: quote shows fee, TDS, settlement; code required; wrong code withdraws nothing; payout PAID with UTR; finance ledger RIDER_PAYOUT; rest of balance stays | integration + UI (₹500 of ₹1,317: paid, UTR SBXN…, balance ₹817) | Pass |
| TC-RB-06 | Withdrawal fails and is reversed: amount back in balance, payout CANCELLED, rider notified | integration (…98 paise) | Pass |
| TC-RB-07 | Partial withdrawal that fails gives back exactly what was taken | integration | Pass |
| TC-RB-08 | Limits: below ₹100, above ₹10,000, above balance, daily ₹10,000; not approved; unverified account; customer refused | integration + unit | Pass |
| TC-RB-09 | COD cash owed lowers what can be withdrawn | integration | Pass |
| TC-RB-10 | Monthly run on the 5th: eligible paid by NEFT; below minimum, missing KYC, unverified account carried forward with reason and notification | integration | Pass |
| TC-RB-11 | Duplicate-run protection: second hourly call and admin "run now" create nothing | integration + UI ("Run now", batch row) | Pass |
| TC-RB-12 | Run interrupted after a payment was committed but not sent, then re-run: unsent one sent once, others paid, run COMPLETED, resumed count 2 | integration | Pass |
| TC-RB-13 | Retries then manual review: …99 succeeds on retry 1; …98 fails 3 retries → needs review → finance "Return to balance" | integration | Pass |
| TC-RB-14 | TDS s.194C: ₹35,000 → 1% with PAN (₹350), 20% without (₹7,000) | integration + unit (annual catch-up) | Pass |
| TC-RB-15 | Earnings after the month's end wait for the next run | integration | Pass |
| TC-RB-16 | No double payment with the weekly batch after a withdrawal | integration | Pass |
| TC-RB-17 | Flags off: every new route 404, bank account unchanged, monthly run skipped | integration | Pass |
| TC-RB-18 | Admin view permission: rider gets 403 | integration | Pass |
| TC-RB-19 | Screens: wallet, withdraw, statement, admin runs; no console errors; phone width 375 px without sideways scroll | UI, built-in browser | Pass |
| TC-RB-20 | Regression of existing wallet, order and payment flows | full suite | FULL_REGRESSION |

## Defects found

| ID | Defect | Status |
|---|---|---|
| D1 | `migrate-on-build` could not rewind to 0055: the new `rider_bank_transfers` points at `bank_accounts` | Fixed — the test now runs `scripts/rollback-0123.sql` first (also proves the rollback script) |
| D2 | Code e-mail read "You asked to a withdrawal of …" | Fixed — "Use this code to confirm a withdrawal of …" |
| D3 | After a partial withdrawal the wallet card said "Earnings ₹0.00, adjustments ₹817.00" (confusing) | Fixed — line removed; the balance alone is shown |
| D4 | Admin month picker stretched full width | Fixed |
| P1 | `tests/unit/pmd-sources.test.ts` and `tests/unit/product-import-parser.test.ts` (one case each, Excel parsing) and the matching `product-import` integration case fail | **Not from this change**: the same cases fail on untouched `staging` in this checkout (shared `node_modules`). Left as is |

## Evidence

Screenshots in `docs/gig-bank-payouts-2026-10/evidence/`: `01-wallet.jpg`,
`02-withdraw-quote.jpg`, `03-withdraw-paid.jpg`, `04-statement.jpg`,
`05-wallet-phone.jpg`, `06-admin-run.jpg`.

Dev server log of the code e-mail (local, console mail):
`subject=342037 — confirm a withdrawal of ₹500.00 …`, then
`POST /api/gig/wallet/withdrawals 200`, and the sandbox webhook applied
(transfer SUCCESS, UTR SBXN036922966010).

## Not done (needs the owner)

- **Test server (test.gokesari.com):** needs the branch pushed, a PR into
  `staging`, the "Test database" workflow (migration 0123), the three flags on
  for the test, then the QA run. Not started — waiting for the go-ahead.
- **Production smoke test:** needs Cashfree Payouts keys on gokesari.com and
  rule `riderPayouts.provider = CASHFREE`; then small real amounts (₹100) to a
  test rider's own account. Claude does not move real money: the owner runs it.
- **Android / iPhone:** the apps show the website, so nothing to build; not
  opened on a phone in this run.
