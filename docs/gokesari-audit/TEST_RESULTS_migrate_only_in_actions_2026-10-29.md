# Migrations only in GitHub Actions (Blocker #71) — test results (29 Oct 2026)

Branch `claude/migrate-only-in-actions`, based on staging dc4718f. Local PostgreSQL 18. Run by Claude.

`scripts/migrate-on-build.mjs` now applies migrations only when `MIGRATE_ON_BUILD=true` **and**
`GITHUB_ACTIONS=true` (the "Test database" and "Production database" workflows). Every Hostinger
build, deploy or PR preview, logs `skipped` and exits 0.

| Case | One database | Two databases |
|---|---|---|
| `MIGRATE_ON_BUILD` unset / false / other → skipped, nothing applied | Pass | Pass |
| **Outside GitHub Actions** (`GITHUB_ACTIONS` "", "false", "1") with `MIGRATE_ON_BUILD=true` → skipped, exit 0, nothing applied; even without `DATABASE_URL` the build goes on | Pass | Pass |
| Inside GitHub Actions without `DATABASE_URL` → build stopped | Pass | Pass |
| **Inside GitHub Actions** → migrates an empty database, then a no-op | Pass | Pass |
| Two runs at once → each migration applied once | Pass | Pass |
| A database on 0055 brought up to date with the rollback scripts | Pass | Pass |
| A failed migration stops the run and leaves the database as it was | Pass | Pass |

`migrate-on-build`, `split-migrate`, `migration-journal`: **15 / 15 on each layout**.

A run as on Hostinger (`MIGRATE_ON_BUILD=true`, no `GITHUB_ACTIONS`) printed
`[migrate-on-build] skipped: not running in GitHub Actions …` and exited 0.

Workflows checked: `test-db.yml` and `prod-db.yml` run the script on GitHub's runners (where
`GITHUB_ACTIONS=true`) with `MIGRATE_ON_BUILD=true`, so they still migrate. `ci.yml` runs
`npm run build` without `MIGRATE_ON_BUILD` (skipped, as before) and migrates its own test database
with `npm run db:migrate`, which this change does not touch.

Not covered here: a real Hostinger build. After the owner removes `MIGRATE_ON_BUILD` in hPanel and
this is merged, the next preview's build log should show `[migrate-on-build] skipped`.
