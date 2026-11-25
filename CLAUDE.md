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
has one database (`DATABASE_URL`) with every table in it: `gokesari` for
gokesari.com and `gokesari_test` for test.gokesari.com, on our own server (next
section). There is no postgres_fdw link, no `SELLER_DATABASE_URL` and no
`DB_SPLIT_MODE`. Record: [docs/db-fdw-removal-2026-11/](docs/db-fdw-removal-2026-11/).

The split's leftovers were removed on 16-Nov-2026: the `fdw_old_public` /
`fdw_old_pmd` schemas and the `gk_seller_retired` server are dropped on both
sites, the old seller / customer databases are deleted, and the us-east-2 Neon
projects (`GoKesari-prod`, `GoKesari-test`) are gone. Backups (`pg_dump -Fc`) are
in the owner's `Doc_GoKesari/Devlopment_Trackers/neon_backups/`. Record:
[docs/neon-cost-cut-2026-11/](docs/neon-cost-cut-2026-11/).

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

# Our own server (VPS): databases, website and cron

Since 17-Nov-2026 both sites run entirely on GoKesari's own server **`gk-db-1`**
(Hostinger KVM 4, Mumbai, 189.72.155.162): the databases since 05.52 IST
(staging) / 06.06 IST (production), the website code since 08.18 / 08.34 IST.
Neon and Hostinger's Node.js hosting are no longer used. Records:
[docs/neon-to-vps-2026-11/](docs/neon-to-vps-2026-11/) (databases) and
[docs/app-to-vps-2026-11/](docs/app-to-vps-2026-11/) (website).

| Site | Database (PostgreSQL 18) | Website slot | Deploys from |
|---|---|---|---|
| gokesari.com | port 5432, `gokesari` | `gokesari-prod` (4 GiB, 2 vCPU) | `main` |
| test.gokesari.com | port 5433, `gokesari_test` | `gokesari-staging` (2 GiB, 1 vCPU) | `staging` |

- **Deploys:** the server's `gk-deploy` agent checks each branch every minute,
  builds a new commit (about 5 minutes) and switches to it blue/green, with no
  downtime. One deploy at a time on the whole server. There is no Hostinger
  build any more. Kit and commands: [scripts/vps-app/README.md](scripts/vps-app/README.md).
- **Access:** SSH and the database ports only through WireGuard
  (`gkadmin@10.66.0.1`); GitHub's database workflows have their own WireGuard
  peers. The apps reach their database over the local socket.
- **Cron:** systemd timers on the server (`gk-cron@<site>-<job>`), every minute
  on both sites again (owner, 17-Nov-2026); hPanel has no cron lines.
  Schedule: [docs/crontab.txt](docs/crontab.txt).
- **Backups and alerts:** pgBackRest (point-in-time) plus nightly encrypted
  dumps on the server, which the owner's Mac pulls; no off-site copy (owner
  decision). Alerts by e-mail through healthchecks.io. Restores, alerts and
  keys: [docs/neon-to-vps-2026-11/RUNBOOK.md](docs/neon-to-vps-2026-11/RUNBOOK.md).
- **Kept as fallback until 1-Dec-2026:** the frozen, read-only Neon projects
  and the idle Hostinger Node.js apps (Hostinger may still build `main` /
  `staging` there, but they serve no traffic). Removing them needs the
  owner's OK. The Hostinger plan itself stays: it carries the e-mail
  (support@gokesari.com).
- Don't change the server's limits, firewall, `pg_hba.conf`, backups or alerts,
  and don't add another website to it, without the owner's OK. Any other site
  is planned in its own project's chat (scope rule above).

# Production releases: one at a time, checked after every deploy

On 25 Oct 2026, two sessions merged the same release into `main` 75 s apart.
The two Hostinger deploys overlapped, and gokesari.com stopped answering for
14 minutes ([incident note](docs/gokesari-audit/INCIDENT_2026-10-25_production_hang.md)).
The server's deploy agent now runs one deploy at a time, but releases still go
one at a time. Steps: [DEPLOYMENT.md §3](DEPLOYMENT.md), "One production
release at a time" and "After every production deploy".

- **Before merging anything into `main`** (code or docs), check that no other
  release is in flight:
  - list the open PRs into `main`;
  - look at the latest "Post-deploy check" run;
  - check that gokesari.com serves `main`'s head and no deploy is running:
    `sudo gk-deploy status` on the server, or `/sw.js`'s `VERSION` against
    `git rev-parse origin/main`.
  - If one is running, wait. Never open a second staging → main PR for code
    another one already carries.
  - **Wait for the PR's "Production database" check to be green.** Since
    25-Nov-2026 it migrates production automatically for every PR into
    `main`, before the merge (two outages that day came from code going
    live without its migrations). Never merge while it is red, pending or
    missing; read its summary. A push to `main` runs it again as a safety
    net. By hand, if needed: Actions → "Production database" → `migrate`.
- **After the merge:**
  - the server builds and switches gokesari.com about 5–6 minutes later
    (`/sw.js` then shows the new commit);
  - wait for the **Post-deploy check** workflow to pass, or run
    `scripts/release/post-deploy-check.sh https://gokesari.com` once `/sw.js`
    shows the new commit;
  - only then report the release as done or merge the next one;
  - if the check fails: `sudo gk-deploy restart gokesari-prod` on the server
    (the same release on the other colour, no build), re-run the check, and
    tell the owner. To go back to the previous release:
    `sudo gk-deploy rollback gokesari-prod`. A failed build changes nothing:
    the old release keeps serving.

# Staging: finished PRs go through the staging queue

Do **not** merge into `staging` yourself. Open the PR into `staging` and add
the label **`ready-for-staging`**; the "Staging queue" workflow merges labelled
PRs one at a time and tests each on test.gokesari.com (CI, migration, the
server's deploy, post-deploy check, guest QA) before the next. A fix for a
paused queue gets `staging-fix`. Status: the issue labelled `staging-queue-tracker`. Details:
[docs/staging-queue/README.md](docs/staging-queue/README.md).

After labelling, **stay subscribed to your PR until it is `staging-verified`**
and act on the queue's comments yourself, without asking the owner:
- **`staging-blocked`** (CI red or merge conflict, not merged): fix it on the
  same branch, push, and add `ready-for-staging` again.
- **Migration-number clashes** (only `drizzle/meta/_journal.json` conflicts):
  the queue renumbers the PR's migrations and pushes the merge itself (🔢
  comment), so pull before pushing again. To do it by hand:
  `node scripts/db/renumber-migrations.mjs origin/staging` during the merge.
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
