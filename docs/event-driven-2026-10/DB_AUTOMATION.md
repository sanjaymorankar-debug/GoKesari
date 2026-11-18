# Test database automation (test.gokesari.com)

Everything that touches the test database now runs in GitHub Actions:
workflow **"Test database"** (`.github/workflows/test-db.yml`). Nothing has to
be run from a laptop, and production (gokesari.com) is never touched — the
workflow only ever uses the `TEST_DATABASE_URL` secret, and refuses to run if
that secret points anywhere but the test database you name below.
Production has its own by-hand workflow: [PROD_DB.md](PROD_DB.md).

## One-time setup (on github.com)

Since 17-Nov-2026 (05.52 IST) the test database is on GoKesari's own database
server, `gk-db-1` ([docs/neon-to-vps-2026-11/](../neon-to-vps-2026-11/)):
PostgreSQL 18, port **5433**, database **`gokesari_test`**, public name
`db-test.gokesari.com`. Its PostgreSQL port is closed to GitHub's runners: the
job first joins the server's WireGuard network with a key of its own (peer
`gh-test-db`, 10.66.0.21), which lets it reach only the staging database and
the snapshot command.

The job runs in the **`test`** environment: **sanjaymorankar-debug/GoKesari →
Settings → Environments → test**. (It also sees repository-level values; an
environment value overrides one at repository level.)

1. **Secrets:**
   - `TEST_DATABASE_URL`: the test database's connection string for the app
     role `gokesari_test_app`, host and port `db-test.gokesari.com:5433`,
     database `gokesari_test`. The password is in the password manager. (Not
     the site's own `DATABASE_URL`: since 17-Nov-2026 the site runs on the same
     server and connects over the local Unix socket.)
   - `VPS_WG_KEY_TEST_DB`: this job's WireGuard private key.
   - `VPS_SSH_KEY_TEST_DB`: this job's SSH key for the snapshot command.

   `scripts/vps-db/mac/make-github-keys.sh` puts both keys straight into the
   environment and never shows them
   ([RUNBOOK.md](../neon-to-vps-2026-11/RUNBOOK.md) Part 1, step 15).
2. **Variables** (not secrets — the first two are the safety check):
   - `TEST_DATABASE_HOST` = `db-test.gokesari.com:5433`, **with the port**:
     both of the server's databases share one machine, so the guard compares
     the port too;
   - `TEST_DATABASE_NAME` = `gokesari_test`;
   - `VPS_WG_SERVER_PUBLIC_KEY`: the server's WireGuard public key;
   - `VPS_WG_ENDPOINT`: the server's WireGuard endpoint, `<IP>:51820`;
   - `VPS_SSH_KNOWN_HOSTS`: the server's SSH host key line(s).

The same environment also holds `VPS_WG_KEY_COPY_SHOPS_EXPORT`, for the
export job of "Copy shops to production" (`.github/workflows/copy-shops.yml`).

**Neon (retired, read-only until 1-Dec-2026).** Until 17-Nov-2026 the test
database was on Neon. The workflow still has its Neon path, used only while
`TEST_DATABASE_HOST` ends in `.neon.tech`; it uses the secret
`TEST_NEON_API_KEY` and the variable `TEST_NEON_PROJECT_ID`. They stay until
Neon is deleted, with the owner's OK, then are removed.

Never paste the URL into chat, a commit or an issue — only into the secret.

## What runs, and when

| When | What happens |
|---|---|
| A PR that adds a migration (`drizzle/**`) is merged into `staging` | Back up → migrate → verify |
| `docs/event-driven-2026-10/test-settings.sql` changes on `staging` | Back up → migrate → apply the test settings → verify |
| `docs/shop-wallet-delivery-otp-2026-10/test-settings.sql` changes on `staging` | Back up → migrate → apply the shop wallet settings (rule `shopWallet`, `deliveryOtp`, 1% default commission) → verify |
| `docs/shop-wallet-delivery-otp-2026-10/test-wallet-credits.sql` changes on `staging` | Back up → migrate → apply the shop wallet credits not yet applied (each row once, by its key) → verify |
| `docs/three-modules-2026-10/test-settings.sql` changes on `staging` | Back up → migrate → apply the three-modules settings (rule `selfRegistration` on, `invoicing` on, test amounts for the five fee plans) → verify |
| The workflow itself changes on `staging` | Back up → migrate → verify (settings are not re-applied) |
| Every night 02:17 IST | Back up (once the workflow file is on `main` — GitHub only schedules from the default branch) |
| By hand: Actions → Test database → Run workflow (branch `staging`) | `migrate`, `settings`, `migrate-and-settings`, `shop-wallet-settings`, `shop-wallet-credits`, `three-modules-settings`, `backup`, `verify`, or `rollback-0058` (type `ROLLBACK 0058` to confirm) |

GitHub shows the **Run workflow** button only once the file is on the default
branch (`main`). Until then the automatic runs above cover everything.

Each run's page has a summary: the target database, the backup (snapshot and
restore point), what was migrated, the migration the database is on, the business-rule values and
the commission rates in force.

**The merge that added this workflow** changed the workflow file, so it ran
back up → migrate (0058) → apply test settings → verify on the test database
straight away (a workflow change no longer re-applies the settings). If it ran before the secret
existed, it stops at the guard and changes nothing: open that run and press
**Re-run all jobs** once the setup is done.

## Safety rails

- **Right database only.** The URL's host, port and database name must equal
  `TEST_DATABASE_HOST` / `TEST_DATABASE_NAME`, and the live server is asked
  which database it is before anything runs.
- **Over WireGuard only.** The job joins the server's WireGuard network before
  any step that touches the database, points only the test host name at the
  server's tunnel address (10.66.0.1), so `TEST_DATABASE_URL` and its TLS name
  work unchanged, and closes the tunnel at the end.
- **Merged code only.** Anything that changes the database runs only from
  `staging`; a read-only run (backup, verify) may start from elsewhere.
- **Backup first.** Every change is preceded by a snapshot on the database
  server, named `auto-backup-<UTC date>-run<N>`: the server dumps the test
  database on its own disk and sets a PostgreSQL restore point of the same
  name, so a point-in-time restore can stop just before the run's changes.
  No rows leave the server. The newest 5 snapshots are kept. The job's SSH key
  may run only that one command (`gk-db-snapshot`), for the staging database,
  from the job's own tunnel address. If the snapshot can't be made (no key, a
  host key that does not match `VPS_SSH_KNOWN_HOSTS`, or the server refuses),
  the run stops before any change. The server also backs the database up on
  its own (pgBackRest and a nightly dump; below).
  History: from 04-Nov to 17-Nov-2026 the backup was a Neon branch of the test
  site's branch (secret `TEST_NEON_API_KEY`); before 04-Nov-2026 it was a
  `pg_dump` to a workflow artifact, which moved ~45 MB per run (~1.2 GB a
  month of the test project's data transfer from the nightly run alone).
- **One at a time.** Runs queue rather than overlap, and the migrator takes a
  Postgres lock, so two runs that start at the same moment are safe: one
  applies the migrations, the other finds nothing left to do.
- **The only migrator for the test site.** Builds never migrate — Hostinger's
  did until Blocker #71 (PR previews migrated the real databases before the PR
  merged), and the server's builds since 17-Nov-2026 do not either;
  `MIGRATE_ON_BUILD` in a site's settings has no effect. DEPLOYMENT.md §4.
- **Settings are not re-imposed.** The test settings are applied only when
  that file changes (or you run `settings`), so values you change later in
  Admin → Business rules stay as you set them.

## Restoring a backup

The run's summary names the snapshot and its restore point
(`auto-backup-…`). Besides these, the server keeps its own backups of the
test database:
- **pgBackRest** with continuous WAL archiving: a restore to any moment
  (point-in-time), or to a named restore point;
- a **nightly `pg_dump`**, age-encrypted, which the owner's Mac pulls.

There is no off-site cloud copy (no Cloudflare R2: owner's decision D3). A
session restores on the
server, over WireGuard, following
[RUNBOOK.md, "Restores"](../neon-to-vps-2026-11/RUNBOOK.md#restores). For the
test database use `staging` where the runbook says `prod` (stanza `staging`,
service `postgresql@18-staging`, port 5433, database `gokesari_test`):
- **Look at the old data without touching anything:** a restore drill,
  `sudo gk-db-restore-drill staging --minutes-ago <N>`, restores into a
  scratch instance and removes it at the end.
- **Put the whole database back** to the run's restore point, or to a time:
  pgBackRest point-in-time restore. It is destructive and stops
  test.gokesari.com's database for its duration: ask the owner first.
- **Take back only what is needed:** restore the run's snapshot into a new
  database, compare, and copy back.

Snapshots and backups hold whatever is in the test database (test accounts,
addresses), like the test database itself.

Until 17-Nov-2026 a backup was a Neon branch, restored in the Neon console.
Neon (retired, read-only until 1-Dec-2026) is kept only as a fallback.

## Still manual

- The cron schedule: since 17-Nov-2026 it is systemd timers on the server
  (`gk-site cron gokesari-staging on|off|status`, [docs/crontab.txt](../crontab.txt)),
  not reachable from GitHub. `crontab.test.txt` is history.
- Production. Nothing here touches gokesari.com.
