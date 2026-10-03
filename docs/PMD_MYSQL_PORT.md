# Porting the Product Master Data platform to MySQL

The rest of GoKesari moved from PostgreSQL to MySQL (see
`MYSQL_MIGRATION_ASSESSMENT.md`). PMD was deliberately left behind: it talks to
postgres.js directly, and its SQL is Postgres-native by design rather than by
accident. This file is the plan for moving it, and the record of what has moved.

**Status: stage 1 of 5 is done.** The schema exists on MySQL and is applied by
`npm run pmd:migrate`. **PMD itself does not run on MySQL yet** — every
repository function still issues postgres.js tagged templates. Nothing is
wired up until stage 2.

---

## What makes this different from the application port

Measured on this tree:

| | |
|---|---|
| `src/server/pmd/**` | 44 files, 10,336 lines |
| `sql` templates across PMD, its API routes, scripts and tests | 232 |
| Postgres-specific constructs in those templates | 279 |
| …of which the `pmd.` schema prefix | **196** |
| PMD schema objects | 27 tables, 2 views, 3 sequences, 4 functions, 5 triggers, 41 indexes, 2 extensions |

Two findings from the survey changed the shape of the work:

**1. `pmd` can stay spelled `pmd`.** PostgreSQL had a *schema* named `pmd`
inside the application's database. MySQL has no schema-within-a-database — but
`database.table` is the same two-part name, so a MySQL **database** called
`pmd` leaves all 196 references working verbatim. That removes 70% of the
findings without touching a line of application code. It does mean PMD must
live on the same server as the application database, because
`pmd.catalogue_link` has foreign keys into `products` and `users`.

**2. The matcher's decisions do not depend on the database.** `match/engine.ts`
retrieves candidates through six *blocking* strategies and `match/score.ts` —
423 lines, zero SQL — decides. Only strategies 5 and 6 use trigram similarity.
So porting changes the **recall** of two retrieval queries, not how any match is
scored or decided. That is measurable, and it is a far smaller claim than
"matching behaviour changes".

---

## Stages

### Stage 1 — schema — **done**

`drizzle-pmd/0000_product_master_platform.sql` (904 lines), applied by
`npm run pmd:migrate` (`src/server/pmd/mysql/migrate.ts`), which creates the
`pmd` database, substitutes `@APP_DB@` with the application database from the
connection URL, and records what it has applied.

Verified on MySQL 8.0 under `STRICT_ALL_TABLES`: 0 errors, 29 tables, 2 views,
50 foreign keys, 63 check constraints, 105 indexes, 8 generated columns,
2 partitions, and the 2 cross-database foreign keys resolving and enforcing.
Re-running is a no-op.

What the translation had to do:

| PostgreSQL | MySQL | Why |
|---|---|---|
| 3 sequences feeding generated `*_code` columns | `pmd.counters` + app allocation | MySQL **refuses** a generated column that refers to an `AUTO_INCREMENT` column (errno 3109), and `manufacturer_code`, `brand_code` and `master_product_id` are generated from exactly those ids |
| 5 `touch_updated_at()` triggers | `ON UPDATE CURRENT_TIMESTAMP(3)` | the column attribute does the whole job |
| 8 partial indexes (`WHERE …`) | 4 generated columns + `UNIQUE`, 4 plain indexes | a `UNIQUE` admits any number of NULLs, so a column that is NULL when the predicate is false reproduces a partial unique index exactly; partial *non*-unique indexes just become full ones, which is a superset |
| `UNIQUE (COALESCE(brand_id,0), family_key)` and `md5(a‖b)` indexes | generated columns | MySQL 8 would take a functional index, MariaDB would not; a generated column works on both |
| `text` where indexed | `varchar(n)` | MySQL cannot index `TEXT` without a prefix length |
| `timestamptz` | `datetime(3)` | no zone-aware type; `(3)` because whole seconds break "latest row wins" ordering |
| `text[]`, `integer[]`, `jsonb` | `json` | |
| `gstin ~ '…'`, `num_nonnulls(…)`, `cardinality(…)` in CHECKs | `REGEXP_LIKE`, additive `IS NOT NULL`, `JSON_LENGTH` | all deterministic, so all legal in a MySQL CHECK — verified firing |
| `PARTITION BY RANGE (collected_at)` + DEFAULT partition | `RANGE COLUMNS (collected_at)` + `MAXVALUE` | pruning verified with `EXPLAIN` |
| `USING brin (collected_at)` | dropped | no BRIN; partition pruning serves the same access pattern |
| `pg_advisory_xact_lock` | `pmd.advisory_lock` row + `FOR UPDATE` | `GET_LOCK` is session-scoped and would outlive the transaction |
| `pg_trgm` / `btree_gin` extensions, `to_tsvector` index | **not yet** | stage 4 |

#### Decision taken: `price_history` keeps partitioning, loses its foreign keys

MySQL refuses foreign keys on a partitioned table outright (errno 1506,
"Foreign keys are not yet supported in conjunction with partitioning"), so this
table could keep its range partitioning or its three foreign keys, not both.

Partitioning was kept. It is the reason the table has this shape — the original
comment says "range-partitioned by month so 100M+ rows stay prunable and old
months can be archived" — and pruning is verified working. The cost is that
`product_id`, `offer_id` and `source_id` are no longer enforced by the database
on this one table; the loader resolves all three from the master immediately
before inserting, so the integrity is now its responsibility.

Reversing this is a one-line change if referential integrity on the price feed
matters more than archival: drop the `PARTITION BY` clause and restore the
three `REFERENCES`.

### Stage 2 — the driver seam — next

PMD's 232 queries are postgres.js tagged templates, and mysql2 has no such API.
Rewriting all of them into `conn.query(sql, params)` would be a 232-site change
with no behavioural benefit, so instead a small shim provides a postgres.js-
shaped `sql` over mysql2. The surface PMD actually uses is narrow — the survey
found no cursors, no streaming, no `LISTEN`/`NOTIFY`, no `.reserve()`:

- the tagged template itself, resolving to an array of rows
- `sql.begin(fn)` and `sql.begin("read only", fn)` — 10 sites
- `sql.json(v)` — 7 sites
- `sql.unsafe(s)` — 4 sites
- `sql.end()` — 11 sites
- `sql(array)` for list expansion — 3 sites
- the three type coercions `db.ts` pins today: bigint → number, numeric →
  number, date → `'YYYY-MM-DD'` string

### Stage 3 — the queries

The residue once the `pmd.` prefix is free: 28 casts, 10 `ON CONFLICT` with 7
`EXCLUDED`, 6 `RETURNING`, 5 array constructors, 4 `generate_series`, 3
`LATERAL`, 3 `ILIKE`, 3 jsonb operators, 2 `FILTER (WHERE)`, 2 `= ANY`, plus
`claim_job`, `refresh_dashboard` and `ensure_price_history_partitions` as
TypeScript. The helpers written for the application port
(`insertReturning`, `upsertReturning`, `keepExisting`, the counters idiom, the
lock-row idiom) all transfer.

### Stage 4 — retrieval and search: the one product-visible change

Two queries use the trigram `%` operator against GIN indexes, with a threshold
set per probe, and one uses `ts_rank`. MySQL has neither trigram indexes nor a
similarity operator, so this stage has to pick a replacement and **measure it**
rather than assert it:

- **Candidate retrieval** (`match/engine.ts` strategies 5 and 6). Because
  scoring is app-side, the question is purely recall: does the replacement
  surface the same masters? That can be answered by running both retrievals over
  the same corpus and comparing candidate sets. Options are MySQL 8's `ngram`
  full-text parser (character trigrams, so closest to `pg_trgm`, but MySQL-only
  and `ngram_token_size` is a server start-up setting), a trigram table the
  application maintains (exact Jaccard similarity, portable, costs rows), or a
  word-level `FULLTEXT` index (cheapest, weakest on typos).
- **Product search** (`services/products.ts`). `ts_rank` ordering has no MySQL
  equivalent, so **result ordering will change**. This is the one part of the
  port a person should sign off on, and it should be shown before/after on real
  queries rather than described.

### Stage 5 — tests and CI

15 `pmd-*.test.ts` files, currently excluded from CI by `npm run test:ci`
because their schema no longer exists on the MySQL side. Restoring them is how
this port proves itself. `tests/helpers/pmd.ts` needs its `TRUNCATE … RESTART
IDENTITY CASCADE` and `ALTER SEQUENCE … RESTART` replaced the same way the
application's `resetDatabase` was.

---

## Running it today

```bash
# PMD shares the application's MySQL server; the database is created if absent
DATABASE_URL='mysql://user:pass@host:3306/gokesari' npm run pmd:migrate
```

`PMD_DATABASE_URL` still overrides the connection if PMD is pointed somewhere
else on purpose. It must name a MySQL server: the runner refuses a
`postgresql://` URL rather than failing later inside the wire protocol.
