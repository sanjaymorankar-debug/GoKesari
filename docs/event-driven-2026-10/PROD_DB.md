# Production database (gokesari.com) — by hand only

Workflow **"Production database"** (`.github/workflows/prod-db.yml`). It
never runs on its own: there is no push or schedule trigger. You start it,
from `main`, and choose one of two actions:

| Action | What it does |
|---|---|
| `verify` | Read-only. Shows which migrations production has, and which of the release's (`staging` by default) it still lacks |
| `migrate` | Applies the release's migrations to production. Needs `confirm` = `MIGRATE PRODUCTION` |

## Safety rails

- **By hand, from `main` only.** A run started on any other branch is skipped
  and, if forced, refused by the guard. Only the reviewed copy of the
  workflow on `main` can touch production.
- **Typed confirmation** for `migrate`: `MIGRATE PRODUCTION`, exactly.
- **Right database only.** The URL's host, port and database name must equal
  the `PROD_DATABASE_HOST` / `PROD_DATABASE_NAME` variables, the live server
  is asked which database it is, and the run stops if the production host and
  port are the test database's.
- **Tested on test first.** `migrate` refuses any migration the test database
  does not already have.
- **No production data leaves the database server.** No `pg_dump` to GitHub,
  no artifact. Before migrating, the run asks the server (over SSH, through
  WireGuard) for a snapshot — a dump kept on the server, the newest 5 — and a
  PostgreSQL restore point of the same name, `prod-db-migrate-<date>-run<N>`.
  Its summary names both; the run stops before migrating if they can't be
  made. A point-in-time restore can then stop just before the migration
  (below). Until 17-Nov-2026, on Neon, the run recorded only the time and WAL
  position for Neon's restore; that path stays in the workflow only while
  `PROD_DATABASE_HOST` ends in `.neon.tech`.
- **Over WireGuard only.** The server's PostgreSQL ports are closed to
  GitHub's runners. The job joins the server's WireGuard network (peer
  `gh-prod-db`, 10.66.0.23) before any step that touches a database. That
  peer reaches production, the snapshot command, and the test database
  read-only (as `gokesari_test_ro`, for the tested-on-test check).
- **The password goes only where it is needed.** The production URL is given to
  the guard, the state checks and the migrate step only. The package install
  runs without it, and without package install scripts.
- **One at a time.** Production runs queue, and the migrator takes a Postgres
  lock. It is the only migrator for production: builds never migrate —
  Hostinger's did until Blocker #71, and the server's builds since
  17-Nov-2026 do not either (DEPLOYMENT.md §4).

**Accepted risk (GitHub Free, private repository).** The server's values
(`PROD_DATABASE_URL`, the WireGuard and SSH keys) are in the `production`
environment, but on GitHub Free an environment can't be limited to `main` or
need an approval: any workflow on any branch can still use it, so anyone with
write access to this repository could reach the production database. Give
write access only to people you would trust with that password. On GitHub Pro
the environment can be limited to `main`. The repository-level
`PROD_DATABASE_URL`, `PROD_SELLER_DATABASE_URL`, `PROD_CUSTOMER_DATABASE_URL`
and the `TEST_*` equivalents are Neon-era leftovers that no workflow on the
server path reads; they go when Neon is deleted (from 1-Dec-2026, owner's OK).

## One-time setup

Since 17-Nov-2026 (06.06 IST) production is on GoKesari's own database
server, `gk-db-1` ([docs/neon-to-vps-2026-11/](../neon-to-vps-2026-11/)):
PostgreSQL 18, port **5432**, database **`gokesari`**, public name
`db.gokesari.com`. The site runs on the same server and connects over the
local Unix socket, so its `DATABASE_URL` is not the URL GitHub uses.

The job runs in the **`production`** environment: **Settings → Environments →
production**. (It also sees repository-level values; an environment value
overrides one at repository level.)

1. **Secrets:**
   - `PROD_DATABASE_URL`: production's connection string for the app role
     `gokesari_app`, host `db.gokesari.com` (port 5432), database `gokesari`.
     The password is in the password manager.
   - `TEST_DATABASE_URL`: the test database's connection string for the
     **read-only** role `gokesari_test_ro`, host and port
     `db-test.gokesari.com:5433`, database `gokesari_test`. `migrate` reads
     it to check the release was migrated there first; the server lets this
     job into the test database only as that role.
   - `VPS_WG_KEY_PROD_DB`: this job's WireGuard private key.
   - `VPS_SSH_KEY_PROD_DB`: this job's SSH key for the snapshot command.

   `scripts/vps-db/mac/make-github-keys.sh` puts both keys straight into the
   environment and never shows them
   ([RUNBOOK.md](../neon-to-vps-2026-11/RUNBOOK.md) Part 1, step 15).
2. **Variables:**
   - `PROD_DATABASE_HOST` = `db.gokesari.com` (port 5432, so no `:port`);
   - `PROD_DATABASE_NAME` = `gokesari`;
   - `TEST_DATABASE_HOST` = `db-test.gokesari.com:5433`, **with the port**:
     both databases share one machine, and the guards compare the port;
   - `VPS_WG_SERVER_PUBLIC_KEY`: the server's WireGuard public key;
   - `VPS_WG_ENDPOINT`: the server's WireGuard endpoint, `<IP>:51820`;
   - `VPS_SSH_KNOWN_HOSTS`: the server's SSH host key line(s).
3. "Copy shops to production" (`.github/workflows/copy-shops.yml`) uses the
   same environment with keys of its own: `VPS_WG_KEY_COPY_SHOPS` and
   `VPS_SSH_KEY_COPY_SHOPS`.

Neon (retired, read-only until 1-Dec-2026): until 17-Nov-2026 these values
pointed at Neon. Neon-era secrets stay until Neon is deleted, with the
owner's OK, then are removed.

Never paste the production URL into chat, a commit or an issue — only into
the secret.

## Getting the workflow onto `main` (once)

GitHub shows **Run workflow** only once the file is on `main`, and production
must be migrated *before* the release code reaches `main`. So the workflow
goes to `main` ahead of the first release that uses it:

- a small pull request into `main` that adds only `.github/workflows/prod-db.yml`,
  `scripts/prod-db/` and this file. Merging it redeploys gokesari.com with
  the application code unchanged. Ask Claude to prepare it when you are ready.

Until then, production is migrated by hand (`npm run db:migrate`, with a
backup). Hostinger's build no longer migrates (Blocker #71; DEPLOYMENT.md §4).

## Releasing staging → main (every release that adds migrations)

1. **Test is green:** the test checklist passes, and the latest "Test
   database" run is green (so test already has the migrations).
2. **Backup: nothing to do by hand.** The `migrate` run in step 4 asks the
   database server for a snapshot and a restore point before it changes
   anything, and stops if it can't. The server also backs production up on
   its own (pgBackRest, continuous; a nightly dump). (Until 17-Nov-2026 this
   step was a Neon branch made by hand in the Neon console.)
3. **Actions → Production database → Run workflow** → branch `main`,
   action `verify`, source `staging`. The summary lists what production lacks.
4. **Run workflow** again → action `migrate`, source `staging`, confirm
   `MIGRATE PRODUCTION`. Green means production now has every migration in
   staging; the summary shows the restore point and "Not yet on production:
   none".
5. **Merge `staging` into `main`** (pull request). The server's deploy agent
   builds and switches gokesari.com (about 5–6 minutes; Hostinger did this
   until 17-Nov-2026), and the new code finds its tables.
6. Smoke-test gokesari.com.

Why migrate first: migrations here are additive (new tables and nullable
columns), so the code already live ignores them; merging first would run the
new code against the old schema until someone migrated. Do not merge further
migrations into `staging` between steps 4 and 5 — if one lands, run step 4
again. A migration that drops or renames something needs its own plan; do not
use this order for it.

## Undo

- **Code:** revert the release merge on `main` (the server's deploy agent
  builds and switches to it). The older code runs on the newer schema,
  because the migrations are additive.
- **Database, to before the migration.** A session does it on the server,
  over WireGuard, following
  [RUNBOOK.md, "Restores"](../neon-to-vps-2026-11/RUNBOOK.md#restores):
  - **pgBackRest point-in-time restore** to the run's restore point
    (`prod-db-migrate-…`, in the run's "Restore point" summary), or to a time.
    Destructive: it needs the **owner's OK**, and gokesari.com goes
    read-only, then down, for about 15–30 minutes; or
  - **from the run's snapshot:** restore it into a new database, compare,
    and copy back only what is needed; or
  - remove single migrations with their scripts,
    `scripts/rollback-00NN.sql`, newest first, then delete their rows from
    `drizzle.__drizzle_migrations`.
- **To look at the data as it was, without touching production:**
  `sudo gk-db-restore-drill prod --minutes-ago <N>` restores it into a scratch
  instance on the server and removes it at the end (same section).
- Rolling the database back loses whatever customers wrote to the new tables
  since the release.
- Until 17-Nov-2026 the undo was Neon's restore in the Neon console. Neon
  (retired, read-only until 1-Dec-2026) is kept only as a fallback; it does
  not have anything written since the switch.
