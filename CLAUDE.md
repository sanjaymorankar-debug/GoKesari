@AGENTS.md

# Scope of this project's chats: GoKesari only

Chats and sessions for this repository are for **GoKesari (gokesari.com and
test.gokesari.com) only**. The following projects must **not** be discussed,
planned, reviewed or developed here — not even a small change:

- **Ladwani** (Mi Ladwani)
- **Education** (the `edu` project)
- **ATIP** (`ATIP-DEV`)
- **Bkesari** — bkesari.com, any `*.bkesari.com` site, `bkesari-platform`

If a request touches any of them, even by mistake (a pasted error, a file, a
question, a repo that happens to be attached to the session), do not act on
it. Reply briefly that this chat is for GoKesari only and ask the user to
continue in that project's own chat window. Where a request mixes GoKesari with
one of these, do only the GoKesari part and say which part was left out and
where to take it.

# Two databases: every change follows the seller / customer split

Owner decision, 19 Oct 2026: GoKesari runs on **two physically separate
databases**. The site's own database (`DATABASE_URL`) holds customers, orders
and everything after an order, wallets, vouchers and the platform tables; the
**seller database** (`SELLER_DATABASE_URL`) holds the seller tables (shops,
KYC and documents, catalogue incl. the `pmd` product master, inventory,
pricing, shop wallet, payouts) and the site reaches them through postgres_fdw
foreign tables of the same names. Design, the list of differences and the
switch runbook: [docs/db-split-2026-10/CODE_SPLIT_PLAN.md](docs/db-split-2026-10/CODE_SPLIT_PLAN.md).

Every change — feature, fix, migration, test — must work on **both** layouts
(one database, and the two-database split). Rules:

- **New table:** classify it in `src/server/db/split/ownership.ts` (seller or
  customer); a unit test fails otherwise.
- **Migration:** first line `-- split: seller`, `-- split: core` or
  `-- split: both` (a unit test enforces it). No foreign key and no cascade
  between a seller table and a customer table — check the link in the service
  (`src/server/db/split/integrity.ts`) and delete dependants explicitly.
- **Writes to seller tables:** no `ON CONFLICT … DO UPDATE` and no
  `ON CONFLICT (target)` — use `upsertRow` (`src/server/db/split/upsert.ts`),
  or `onConflictDoNothing()` without a target when the table has one unique key.
- **No session settings** (`set_config`, GUCs) that seller-side triggers must
  see; leave a row instead (e.g. `inv_ledger_marks`).
- **Errors:** don't rely on `constraint_name` for seller tables (also match the
  index name in the message); a savepoint that swallows errors must rethrow
  40001 (`isSerializationFailure`).
- **Transactions** run at READ COMMITTED on the core (never SERIALIZABLE: its
  check can fail at COMMIT after postgres_fdw has already committed the seller
  side, leaving a transaction half applied); the seller side runs at
  REPEATABLE READ. On the split layout a transaction is re-run from the start
  on 40001 / 40P01. A seller row locked only as a gate — the transaction then
  counts or checks *other* seller rows, as a referral code's last slot or the
  stock ledger does — must be touched right after the lock with
  `touchSellerRow` (`src/server/db/split/gate.ts`). Keep external side effects (payment gateway,
  SMS, e-mail, push, uploads) out of `db.transaction` — do them after commit or
  through an idempotent outbox / idempotency key. Where an outside call must
  happen under the transaction's lock, use `transactionOnce`
  (`src/server/db/index.ts`), which never re-runs. Anything a transaction
  collects in memory (lists, caches) must be kept only once it commits.
- **Product master:** use `await appSql()` (`src/server/pmd/db.ts`); never
  connect pmd code to `DATABASE_URL` directly.
- **Tests:** CI job `test-split` (the whole suite on the two-database layout)
  is blocking. Locally: `npx tsx scripts/db-split/test-layout.ts --core <url>
  --seller <url>`, then `TEST_DATABASE_URL=<core> DB_SPLIT_MODE=split
  SELLER_DATABASE_URL=<seller> npm test`.
- **Sites:** a site moves only through the "Database split" workflow
  (`switch-check` → `switch`; undo with `switch-back`). test.gokesari.com first;
  gokesari.com only in an owner-approved window. Hostinger needs
  `DB_SPLIT_MODE=split` and `SELLER_DATABASE_URL` (test: `gokesari_seller`;
  production: the database named `PROD_SELLER_DATABASE_URL`). The site's own
  database stays the customer database; the separate `*_CUSTOMER_*` databases
  are not used.

# Payment testing on staging: Cashfree sandbox test data

For any payment test on test.gokesari.com (staging), use Cashfree **sandbox**
test data only. The full list is in
[docs/testing/cashfree-sandbox-test-data.md](docs/testing/cashfree-sandbox-test-data.md).
Quick reference:
- **Cards:** OTP **111000** for every test card. Proven on staging: Visa
  4111 1111 1111 1111 (exp 12/30, CVV 123) and debit 4706 1312 1121 2123.
  Cashfree's own list (exp 03/2028, CVV 123, name Test) is in the doc.
- **UPI:** testsuccess@gocash (success) and testfailure@gocash (failure).
- **Net banking:** bank code 3003 is proven on staging; Cashfree also lists
  TEST Bank 3333 / TESTR.
- **Running a payment:** this session cannot reach Cashfree, so the pay step
  runs through the "Sandbox payment" GitHub workflow
  (`.github/workflows/sandbox-pay.yml`).

Never use real cards, UPI IDs or bank accounts on staging. Never use test data
or sandbox keys on gokesari.com (production). Keys come from the environment,
never from code.

# Where GoKesari reports are saved (standard)

Every GoKesari development report and test result goes to the owner's folders
on their Mac:

| What | Folder |
|---|---|
| Feature development reports and status trackers (e.g. `GOKESARI_FEATURE_STATUS_REPORT_<date>.xlsx`, feature / process-flow / PR status, open-features lists) | `/Users/agtci/Documents/Doc_GoKesari/Devlopment_Trackers` |
| Test results and test-case tracking (test-case workbooks, regression matrices, test-run results such as `TEST_RESULTS.md`, QA sign-off sheets) | `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking` |

Keep the folder names exactly as written (`Devlopment_Trackers` is spelled that
way on purpose).

- **Session on the owner's Mac** (the folder exists): save the file there.
  For a status report, write a new dated file (`..._<YYYY-MM-DD>.xlsx`). For
  test results, update the existing tracker for that feature or run, and
  create a new file only for a new run. Also keep the repository copy under
  `docs/` when the work is committed. Say the full path in the reply.
- **Cloud session** (the `/Users/agtci/...` folder does not exist): save the
  file in the repository as usual (status reports in `docs/gokesari-audit/`,
  test results next to the feature's docs). Send it to the owner as a file,
  and say which of the two Mac folders it belongs in so they can save it
  there. Never report a file as saved to the Mac folder when it was not.
