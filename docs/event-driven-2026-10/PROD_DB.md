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
- **Right database only.** The URL's host and database name must equal the
  `PROD_DATABASE_HOST` / `PROD_DATABASE_NAME` variables, the live server is
  asked which database it is, and the run stops if the production host is the
  test database's host.
- **Tested on test first.** `migrate` refuses any migration the test database
  does not already have.
- **No production data leaves the database.** No `pg_dump`, no artifact.
  Before migrating, the run records a restore point (time and WAL position) in
  its summary; Neon can restore the database to that moment (below).
- **The password goes only where it is needed.** The production URL is given to
  the guard, the state checks and the migrate step only. The package install
  runs without it, and without package install scripts.
- **One at a time.** Production runs queue; the migrator takes the same
  Postgres lock as Hostinger's `MIGRATE_ON_BUILD`, so the two cannot collide.

**Accepted risk (GitHub Free, private repository).** Without environments,
`PROD_DATABASE_URL` is a repository secret: any workflow on any branch can
read it, so anyone with write access to this repository could reach the
production database. Give write access only to people you would trust with
that password. On GitHub Pro the secret can move into a `production`
environment limited to `main`.

## One-time setup

1. **Rotate the production password first** (Neon → the production project →
   Roles → reset the password). Put the new connection string in hPanel →
   gokesari.com's `DATABASE_URL` (Deployments → Redeploy → "Settings and
   redeploy" — never "Change repository").
2. **GitHub → Settings → Secrets and variables → Actions:**
   - *Secrets* tab → **New repository secret**: `PROD_DATABASE_URL` = that
     connection string.
   - *Variables* tab → **New repository variable**, twice:
     `PROD_DATABASE_HOST` = the host part of the URL (`ep-….neon.tech`),
     `PROD_DATABASE_NAME` = the database name at the end of it.
3. The test values must be at repository level too (`TEST_DATABASE_URL`,
   `TEST_DATABASE_HOST`, `TEST_DATABASE_NAME`): `migrate` reads the test
   database to check the release was migrated there first.

Never paste the production URL into chat, a commit or an issue — only into
the secret.

## Getting the workflow onto `main` (once)

GitHub shows **Run workflow** only once the file is on `main`, and production
must be migrated *before* the release code reaches `main`. So the workflow
goes to `main` ahead of the first release that uses it:

- a small pull request into `main` that adds only `.github/workflows/prod-db.yml`,
  `scripts/prod-db/` and this file. Merging it redeploys gokesari.com with
  the application code unchanged. Ask Claude to prepare it when you are ready.

Until then, production is migrated as before (by hand, or with
`MIGRATE_ON_BUILD`).

## Releasing staging → main (every release that adds migrations)

1. **Test is green:** the test checklist passes, and the latest "Test
   database" run is green (so test already has the migrations).
2. **Snapshot (recommended):** Neon console → the production project →
   **Branches** → **Create branch** from the production branch at the current
   point in time, named e.g. `pre-release-2026-10-15`. Instant and free; it
   keeps a full copy until you delete it.
3. **Actions → Production database → Run workflow** → branch `main`,
   action `verify`, source `staging`. The summary lists what production lacks.
4. **Run workflow** again → action `migrate`, source `staging`, confirm
   `MIGRATE PRODUCTION`. Green means production now has every migration in
   staging; the summary shows the restore point and "Not yet on production:
   none".
5. **Merge `staging` into `main`** (pull request). Hostinger deploys
   gokesari.com, and the new code finds its tables.
6. Smoke-test gokesari.com.

Why migrate first: migrations here are additive (new tables and nullable
columns), so the code already live ignores them; merging first would run the
new code against the old schema until someone migrated. Do not merge further
migrations into `staging` between steps 4 and 5 — if one lands, run step 4
again. A migration that drops or renames something needs its own plan; do not
use this order for it.

## Undo

- **Code:** revert the release merge on `main` (Hostinger redeploys). The
  older code runs on the newer schema, because the migrations are additive.
- **Database, to before the migration:**
  - from the snapshot branch of step 2 (Neon → Branches → that branch →
    restore it onto the production branch); or
  - Neon's restore to a point in time — the time in the run's "Restore point".
    This works only inside your Neon plan's restore window, which on the free
    plan is short: use it the same day, or rely on the snapshot.
  - Or remove single migrations with their scripts,
    `scripts/rollback-00NN.sql`, newest first, then delete their rows from
    `drizzle.__drizzle_migrations`.
- Rolling the database back loses whatever customers wrote to the new tables
  since the release.
