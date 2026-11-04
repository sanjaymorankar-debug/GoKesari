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

# One database (the seller / customer split is gone)

The two-database layout of 19 Oct 2026 was removed in Nov 2026: test.gokesari.com
moved back on 02-Nov and gokesari.com on 04-Nov-2026 (owner's request). Each site
has one database (`DATABASE_URL`, `neondb`) with every table in it; there is no
postgres_fdw link, no `SELLER_DATABASE_URL` and no `DB_SPLIT_MODE`. Record:
[docs/db-fdw-removal-2026-11/](docs/db-fdw-removal-2026-11/).

- Write ordinary single-database code; do not reintroduce the split rules
  (`-- split:` migration headers, `upsertRow` instead of `ON CONFLICT`,
  touched gate rows, 40001 re-runs). `upsertRow` (`src/server/db/upsert.ts`)
  stays for its existing callers.
- Seller and customer tables still have **no foreign keys between them** (the
  cut-over did not add them): keep checking those links in the service and
  deleting dependants explicitly.
- Keep external side effects (payment gateway, SMS, e-mail, push, uploads) out
  of `db.transaction` — do them after commit or through an idempotent outbox.
- Product master: use `await appSql()` (`src/server/pmd/db.ts`).

# Production releases: one at a time, checked after every deploy

On 25 Oct 2026, two sessions merged the same release into `main` 75 s apart.
The two Hostinger deploys overlapped, and gokesari.com stopped answering for
14 minutes ([incident note](docs/gokesari-audit/INCIDENT_2026-10-25_production_hang.md)).
Steps: [DEPLOYMENT.md §3](DEPLOYMENT.md), "One production release at a time"
and "After every production deploy".

- **Before merging anything into `main`** (code or docs), check that no other
  release is in flight:
  - list the open PRs into `main`;
  - look at the latest "Post-deploy check" run and the latest Hostinger build
    for gokesari.com.
  - If one is running, wait. Never open a second staging → main PR for code
    another one already carries.
- **After the merge:**
  - wait for the **Post-deploy check** workflow to pass, or run
    `scripts/release/post-deploy-check.sh https://gokesari.com`;
  - only then report the release as done or merge the next one;
  - if the check fails, restart the Node.js app (hPanel, or
    `hosting_nodejs_restart-application`), re-run the check, and tell the owner.

# Staging: finished PRs go through the staging queue

Do **not** merge into `staging` yourself. Open the PR into `staging` and add
the label **`ready-for-staging`**; the "Staging queue" workflow merges labelled
PRs one at a time and tests each on test.gokesari.com (CI, migration, deploy,
post-deploy check, guest QA) before the next. A fix for a paused queue gets
`staging-fix`. Status: the issue labelled `staging-queue-tracker`. Details:
[docs/staging-queue/README.md](docs/staging-queue/README.md).

After labelling, **stay subscribed to your PR until it is `staging-verified`**
and act on the queue's comments yourself, without asking the owner:
- **`staging-blocked`** (CI red or merge conflict, not merged): fix it on the
  same branch, push, and add `ready-for-staging` again.
- **`staging-failed`** (merged, then failed on test.gokesari.com; the queue is
  paused): branch from `origin/staging`, reproduce from the comment and the
  run's `staging-queue-qa-*` artifact, fix, test locally, and open a new PR
  into `staging` titled `Fix #<n>: …` labelled **`staging-fix`** — don't merge
  it. Stay on it the same way until it is verified; the queue then resumes.
- Any session may pick up a failure whose owning session has ended (the
  "Staging queue paused" issue names the PR).

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
- **Shop registration-fee tests** (owner decision, 29 Oct 2026): while
  test.gokesari.com runs `PAYMENT_GATEWAY=SANDBOX`, pay the fee on the app's
  built-in test payment page (`/orders/pay/sandbox/…`, "Pay (success)"); no
  card or UPI details are entered there.

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
