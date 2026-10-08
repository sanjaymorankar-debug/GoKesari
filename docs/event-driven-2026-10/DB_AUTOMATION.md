# Test database automation (test.gokesari.com)

Everything that touches the test database now runs in GitHub Actions:
workflow **"Test database"** (`.github/workflows/test-db.yml`). Nothing has to
be run from a laptop, and production (gokesari.com) is never touched — the
workflow only ever uses the `TEST_DATABASE_URL` secret, and refuses to run if
that secret points anywhere but the test database you name below.

## One-time setup (about 3 minutes, on github.com)

Repository **sanjaymorankar-debug/GoKesari → Settings → Environments → New
environment** → name it `test` (exactly). Then, inside `test`:

1. **Environment secrets → Add secret**
   - Name: `TEST_DATABASE_URL`
   - Value: the test database's connection string — the same value as
     `DATABASE_URL` in hPanel for **test.gokesari.com**.
   - ⚠ The password shared in chat earlier should be rotated first (Neon →
     Roles → `neondb_owner` → Reset password); use the new connection string
     here and in hPanel.
2. **Environment variables → Add variable** (not secret — these are the
   safety check):
   - `TEST_DATABASE_HOST` = the host part of that URL, e.g.
     `ep-…-….c-5.us-east-2.aws.neon.tech`
   - `TEST_DATABASE_NAME` = the database name at the end of the URL, e.g.
     `neondb`
3. Optional: **Required reviewers** → add yourself, so every database run
   waits for your click. Without it, runs start on their own.

Never paste the URL into chat, a commit or an issue — only into the secret.

## What runs, and when

| When | What happens |
|---|---|
| A PR that adds a migration (`drizzle/**`) is merged into `staging` | Back up → migrate → verify |
| `docs/event-driven-2026-10/test-settings.sql` or the workflow changes on `staging` | Back up → migrate → apply the test settings → verify |
| Every night 02:17 IST | Back up (once the workflow file is on `main` — GitHub only schedules from the default branch) |
| By hand: Actions → Test database → Run workflow (branch `staging`) | `migrate`, `settings`, `migrate-and-settings`, `backup`, `verify`, or `rollback-0058` (type `ROLLBACK 0058` to confirm) |

GitHub shows the **Run workflow** button only once the file is on the default
branch (`main`). Until then the automatic runs above cover everything.

Each run's page has a summary: the target database, the backup file, what was
migrated, the migration the database is on, and the business-rule values.

**The merge that adds this workflow** changes the workflow file, so it runs
back up → migrate (0058) → apply test settings → verify on the test database
straight away — do the one-time setup first. If it ran before the secret
existed, it stops at the guard and changes nothing: open that run and press
**Re-run all jobs** once the setup is done.

## Safety rails

- **Right database only.** The URL's host and database name must equal
  `TEST_DATABASE_HOST` / `TEST_DATABASE_NAME`, and the live server is asked
  which database it is before anything runs.
- **Merged code only.** Anything that changes the database runs only from
  `staging`; a read-only run (backup, verify) may start from elsewhere.
- **Backup first.** Every change is preceded by a `pg_dump` (custom format),
  kept 14 days as a workflow artifact. A backup under 1 KiB stops the run
  before any change.
- **One at a time.** Runs queue rather than overlap, and both migration
  runners — this workflow and Hostinger's `MIGRATE_ON_BUILD` — take the same
  Postgres lock, so they can safely start at the same moment: one applies the
  migrations, the other finds nothing left to do. Keeping `MIGRATE_ON_BUILD`
  on as well is therefore fine.
- **Settings are not re-imposed.** The test settings are applied only when
  that file changes (or you run `settings`), so values you change later in
  Admin → Business rules stay as you set them.

## Restoring a backup

Download the `.dump` from the run's **Artifacts**, then (any machine with the
PostgreSQL 16+ client):

```bash
read -s TEST_DATABASE_URL && export TEST_DATABASE_URL
pg_restore --clean --if-exists --no-owner --no-privileges -d "$TEST_DATABASE_URL" gokesari_test_<date>_run<N>.dump
```

Backups contain whatever is in the test database (test accounts, addresses).
They are visible to everyone with access to this repository's Actions.

## Still manual

- The crontab on the test host (Phase A → Phase B in `crontab.test.txt`) —
  the host's cron is not reachable from GitHub.
- Production. Nothing here touches gokesari.com.
