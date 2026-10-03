# What the MySQL port requires of the server

GoKesari ran on PostgreSQL. The port to MySQL (`src/server/db/schema.ts`,
`drizzle/`) leans on features that are **not** present in every MySQL build, and
on two server settings that are wrong by default. A server that misses any of
these does not fail at startup — several of them fail silently, returning no
rows or truncated text — so check them before pointing a tier at a database.

See `MYSQL_MIGRATION_ASSESSMENT.md` for what each Postgres construct became.

## 1. Engine and version

| Need | MySQL | MariaDB | Used by |
|---|---|---|---|
| `CHECK` constraints enforced | 8.0.16+ | 10.2.1+ | 82 constraints in the schema |
| Generated (`VIRTUAL`) columns, indexed | 5.7+ | 5.2+ | the 8 columns replacing Postgres partial unique indexes |
| Window functions (`ROW_NUMBER`, `COUNT() OVER`) | 8.0+ | 10.2+ | the median in `services/analytics.ts` |
| Common table expressions | 8.0+ | 10.2+ | `services/risk.ts`, `services/analytics.ts` |
| `JSON_CONTAINS` / `JSON_LENGTH` / `JSON_ARRAY_APPEND` | 5.7+ | 10.2+ | the columns that were `uuid[]` and `jsonb` |
| `REGEXP_REPLACE` | 8.0+ | 10.0+ | `services/societies.ts` |
| `SIGNAL SQLSTATE` in a trigger | 5.5+ | 5.5+ | the append-only guard on `audit_logs` |

**Minimum: MySQL 8.0.16, or MariaDB 10.3.** On MySQL 5.7 or MariaDB 10.1 the
`CHECK` constraints are parsed and then *ignored*, which is the dangerous
failure: the schema loads and the invariants simply are not enforced.

`LATERAL` is deliberately not used anywhere, even though MySQL 8.0.14+ has it,
because MariaDB has no support for it at all. The four places that had it are
now correlated subqueries.

### The two engines are not interchangeable here

Two things this schema does are accepted by MariaDB and **rejected by MySQL**,
so MariaDB alone is not a sufficient test:

- **Generated columns are `VIRTUAL`, not `STORED`.** MySQL refuses a foreign key
  with `ON DELETE CASCADE` on any column that a *stored* generated column is
  built from (`ER_CANNOT_ADD_FOREIGN`, errno 1215), and five of these eight are
  built from exactly such a column. For a *virtual* column only
  `ON UPDATE CASCADE` is disallowed, which nothing here uses. MariaDB accepts
  both forms. Verified on MySQL 8.0 and MariaDB 10.11: the unique index still
  rejects a duplicate, non-matching rows stay unconstrained, and the cascade
  still deletes.
- **An over-long index prefix** is an error on MySQL and, outside strict mode,
  a silently truncated index on MariaDB.

CI therefore runs **MySQL 8.4** (`.github/workflows/ci.yml`), which is the
stricter of the two.

## 2. The time zone tables must be loaded

Daily and weekly reporting converts stored UTC timestamps into the app's local
zone with `CONVERT_TZ(..., '+00:00', 'Asia/Kolkata')` — see
`services/dashboards.ts`, `analytics.ts`, `finance.ts`, `delivery-earnings.ts`.

`CONVERT_TZ` with a *named* zone returns **NULL** when the `mysql.time_zone*`
tables are empty, and a NULL comparison matches nothing. Every "today" figure
would read zero, with no error anywhere.

```bash
mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root mysql    # once per server
```

Verify, on each tier:

```sql
SELECT CONVERT_TZ('2026-01-01 00:00:00', '+00:00', 'Asia/Kolkata');
-- 2026-01-01 05:30:00   (NULL means the tables are not loaded)
```

On a managed instance that will not run `mysql_tzinfo_to_sql` (some hosts
disallow writes to `mysql.*`), set `APP_TIMEZONE` to a fixed offset — `+05:30`
is exactly equivalent for India, which has no daylight saving — rather than
leaving the conversions returning NULL.

## 3. Collation: `utf8mb4_unicode_ci`

Create every database with it:

```sql
CREATE DATABASE gokesari CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Two things depend on the collation being case-**insensitive**, because Postgres
did them explicitly and the port dropped the explicit form:

- `ILIKE` became `LIKE` at 31 call sites. Under a `_bin` or `_cs` collation
  every one of those searches silently becomes case-sensitive.
- `UNIQUE (lower(name))` became a plain `UNIQUE (name)`. Under a case-sensitive
  collation both "Dairy" and "dairy" would be accepted.

## 4. Session settings (set by the application)

`src/server/db/index.ts` sets these on every pooled connection. They matter if
you ever query the database by another route:

- `time_zone = '+00:00'`. The driver reads and writes `DATETIME` as UTC; without
  this the server's own `NOW()` and `CURRENT_TIMESTAMP` — the default on 125
  columns — would be in the server's zone, 5h30m out on a machine set to IST.
- `group_concat_max_len = 16777216`. `GROUP_CONCAT` replaced `string_agg`; at
  the 1024-byte default MySQL truncates the result and only raises a warning.

Also run the server in a strict `sql_mode` (`STRICT_ALL_TABLES`). Without it
MySQL accepts an over-long index prefix by silently truncating it, which is how
a 768-character prefix index on a `TEXT` column slipped through an earlier
iteration of this schema.

## 5. What is still on PostgreSQL

`src/server/pmd/**` (44 files) talks to postgres.js directly and is **not**
ported: it pins Postgres type OIDs, uses a `pmd.` schema namespace, sequences,
`generate_series` and `ts_rank` full-text ranking. Moving it is a redesign with
a visible change to product search ordering, not a translation — see
`MYSQL_MIGRATION_ASSESSMENT.md` §2.2.

It used to read `DATABASE_URL`, which now points at MySQL, so it was given its
own **`PMD_DATABASE_URL`** (optional, in `src/lib/env.ts`). Point that at the
retained PostgreSQL database to keep the product-master features working; leave
it unset and anything touching PMD raises an error naming this file rather than
failing inside the Postgres wire protocol.

`scripts/pmd/*` and `tests/**/pmd-*.test.ts` likewise need a PostgreSQL URL, and
the PMD tests are excluded from the MySQL test run:

```bash
npx vitest run --exclude 'tests/**/pmd-*.test.ts'
```
