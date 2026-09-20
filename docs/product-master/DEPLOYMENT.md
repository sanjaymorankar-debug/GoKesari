# Deployment guide

## What is deployed

| Piece | Where | Needs |
|---|---|---|
| Schema `pmd` | The application's PostgreSQL (`drizzle/0015_product_master_platform.sql`) | PostgreSQL 16, permission to `CREATE SCHEMA` and `CREATE EXTENSION pg_trgm` |
| API + dashboard | The Next.js app (`/api/product-master/*`, `/admin/product-master`) | Nothing new — they use the app's existing `DATABASE_URL` |
| Collection tools | `scripts/pmd/*` (run from a shell) | Node 20+, `PMD_DATABASE_URL` |

There is no new service, queue, cache or daemon. Collection runs are started by a person or a scheduler calling a CLI; the `pmd.job` queue table exists for a future worker but nothing consumes it yet.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `DATABASE_URL` | App, `npm run db:migrate` | The application database. The API and dashboard read it through the app's connection settings |
| `PMD_DATABASE_URL` | `scripts/pmd/*` only | The database a collection tool writes to. **Never falls back to `DATABASE_URL`**, so a tool can not write to the application database by accident |
| `PMD_ALLOW_REMOTE` | `scripts/pmd/*` | Set to `1` to let a tool write to a non-local host. Without it, anything but `localhost`/`127.0.0.1` is refused |
| `PMD_HTTP_USER_AGENT` | HTTP client | Default `GokesariProductMaster/0.1 (+https://gokesari.com)`. It must identify the platform and give a way to reach the company — **not a personal address** |

The tools deliberately do not load the application's `.env` (it holds hosted-database and payment credentials they have no business reading).

## Order of rollout

Never go straight to a shared database. Validate at each step before the next.

1. **Local pilot** (done — see the [pilot report](./PILOT_REPORT.md)). A disposable PostgreSQL on your machine.
2. **Staging** — a copy of the production database (with Neon: a *branch*). Apply the migration, run the tests, run a small collection.
3. **Production** — apply the migration, seed reference data, then start the first (small) collection.

### 1. Local pilot database

```powershell
./scripts/pmd/local-pg.ps1 init          # once: creates a throwaway cluster on 127.0.0.1:54329, outside the repo
$env:DATABASE_URL = 'postgresql://pmd_admin@127.0.0.1:54329/gokesari_pmd'
npm run db:migrate                        # applies 0000..0015 to the local database only
```

`local-pg.ps1` also offers `start`, `stop`, `status`, `url`, and `reset` (destroys and recreates the cluster). It needs an installed PostgreSQL 16 and no administrator rights. It keeps its data in `%LOCALAPPDATA%\GokesariPmd`, which needs a few GB free — the repository drive is not used.

### 2–3. Apply the migration to a shared database

Take a backup or a branch first. Then, with `DATABASE_URL` pointing at the target:

```bash
npm run db:migrate
```

`db:migrate` applies every pending file in `drizzle/` in order and records each one; on a database that is current through `0014`, `0015` is the only pending file. Prefer it to pasting SQL by hand: a hand-applied migration has no bookkeeping row, so a later `db:migrate` would try to apply `0015` again and stop at `schema "pmd" already exists`.

Verify:

```sql
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pmd' AND table_type = 'BASE TABLE';  -- 136 = 27 tables + 109 price-history partitions
SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';
```

Then install the reference data (source register, taxonomy, attribute registry, category mappings). It is idempotent and writes no product data:

```bash
PMD_ALLOW_REMOTE=1 PMD_DATABASE_URL='postgresql://…' npm run pmd:seed
```

Expect: `synced` and then `sources 41 (7 enabled, 26 blocked)  categories 410  attributes 84  category mappings 1045`. Running it again prints `current` — the database is only touched when the definitions in code differ from what it last received (a stored fingerprint), which is also why every ingestion run can call it at its start for the price of two statements. `--force` re-syncs regardless, e.g. after you repair a reference table by hand.

> **Not verified against Neon.** The pilot ran on a local PostgreSQL 16. `pg_trgm` is a supported Neon extension and the migration uses only standard features, but no `pmd` object has been created in any hosted database. Apply it to a branch first, run `npm run pmd:test` against that branch (`TEST_DATABASE_URL`), and only then to production.

### Rollback

`scripts/pmd/rollback-0015.sql` drops **only** the `pmd` schema and removes the migration's bookkeeping row. It is destructive — everything collected is lost — so take a backup first. Nothing in the existing `public` schema depends on `pmd` except `pmd.catalogue_link`, which lives inside it; products already *promoted* to the marketplace catalogue stay in `public.products`.

## Permissions after deploy

The four permissions are in the app's code (`src/server/authz/permissions.ts`); nothing to configure. Operators get `pmd:view`, `pmd:review`, `pmd:promote`; administrators also `pmd:import`. The **Product Master** link appears in the header for those roles.

## Running a collection

```bash
# an open-data pilot (samples fetched politely from the official dumps / API, kept outside the repo)
for v in food beauty products petfood; do npm run pmd:fetch-sample -- --variant $v --limit 1000; done
npm run pmd:fetch-prices
PMD_DATABASE_URL=… npm run pmd:pilot -- --reset      # --reset empties the pmd tables of THAT database first

# a licensed / partner CSV feed (see the data-source guide)
npm run pmd:import-feed -- --check --source partner_feed --file feed.csv --mapping feed.mapping.json
PMD_DATABASE_URL=… npm run pmd:import-feed -- --source partner_feed --file feed.csv --mapping feed.mapping.json

# afterwards: quality checks and the Excel master
PMD_DATABASE_URL=… npm run pmd:checks
PMD_DATABASE_URL=… npm run pmd:export
```

(`VAR=value command` is bash syntax; in PowerShell set `$env:PMD_DATABASE_URL = '…'` first.)

**Where to run it.** The loader handles unchanged and brand-new records in batches (~35 statements per new record before, ~1 per unchanged record now) and the rest one transaction per record. On a local database with 1M masters that is ~190 new and ~7,300 unchanged records/s; price changes and possible duplicates still cost ~20-100 statements each, so latency matters for them. Use `--workers` (with a connection pool of workers + 1). **Run large loads from a machine in the same region as the database**, not from a laptop. See [the pilot report](./PILOT_REPORT.md#throughput-and-what-it-means-for-10-million) before planning any large load.

## Scheduling

No scheduler is installed. Once a source is approved for routine collection, run its command from your platform's scheduler (cron, a CI schedule, a cloud job). Guidance:

| Mode | When | Effect |
|---|---|---|
| `INITIAL_FULL` | First load of a source | Everything is new |
| `INCREMENTAL` | Daily / per the source's frequency | Unchanged records only touch `last_seen`; only changes write history; a *complete* snapshot may mark offers no longer listed |
| `IMPORT` | Operator uploads | No "not seen" conclusions, ever |

Refresh the dashboard by running any run (it refreshes at the end) or `SELECT pmd.refresh_dashboard();`.

## Backups, monitoring, capacity

* **Backup** with the rest of the database. `pmd` is ordinary tables in the same cluster; `raw_record` and `price_history` are the big ones.
* **Watch:** `npm run pmd:checks` (11 invariants that must be zero — wire it to alerting), the dashboard's *import errors* and *awaiting review* tiles, and run status in `pmd.ingestion_run`.
* **Capacity:** plan storage from the [database design](./DATABASE_DESIGN.md#scale) numbers as a floor. Price history grows with *changes*, not with runs.
* **Retention:** decide how long `raw_record` payloads and `price_history` partitions are kept; both can be trimmed without touching the master.

## Before any large-scale ingestion

The brief's own gate: proceed **only after successful validation**. This release delivers the pilot; the large-scale step has **not** been started. What should be true first is listed in the pilot report under *Recommended before scale-up*: a lawful source agreed for each category to be loaded, the loader's round-trip cost reduced or workers co-located with the database, and a person assigned to work the review queue.
