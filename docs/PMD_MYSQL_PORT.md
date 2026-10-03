# Porting the Product Master Data platform to MySQL

The rest of GoKesari moved from PostgreSQL to MySQL (see
`MYSQL_MIGRATION_ASSESSMENT.md`). PMD was deliberately left behind: it talks to
postgres.js directly, and its SQL is Postgres-native by design rather than by
accident. This file is the plan for moving it, and the record of what has moved.

**Status: stages 1 and 2 of 5 are done.** The schema exists on MySQL and is
applied by `npm run pmd:migrate`; the driver shim exists and is tested.
**PMD itself does not run on MySQL yet** — `db.ts` still creates a postgres.js
client, and the queries still contain Postgres-only SQL. Stage 3 is what
switches it over.

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

### Stage 2 — the driver seam — **done**

`src/server/pmd/mysql/sql.ts`, tested by
`tests/integration/product-master-shim.test.ts` (19 tests, in CI).

PMD's 232 queries are postgres.js tagged templates and mysql2 has no such API.
Rewriting them all into `query(text, params)` would be a 232-site change with no
behavioural benefit and 232 chances to misplace a parameter, so the shim
provides the part of postgres.js's surface PMD actually uses:

- the tagged template. Its type parameter is the **array** type, not the row
  type — `sql<Foo[]>` yields `Foo[]` — because that is postgres.js's convention
  and all 64 annotated call sites are written that way
- `sql.begin(fn)` and `sql.begin("read only", fn)` — 10 sites
- `sql.json(v)` — 7 sites
- `sql.unsafe(s)` — 4 sites
- `sql.end()` — 11 sites
- `sql.reserve()` — 1 site
- `result.count` — 3 sites
- the four non-template `sql(...)` helper forms — 24 sites
- the three type coercions `db.ts` pins: bigint → number, numeric → number,
  date → `'YYYY-MM-DD'` string (plus `tinyint(1)` → boolean, which postgres.js
  gave for free)

**Three of those the first survey missed, and the typechecker found them when
`db.ts` was swapped over.** They are recorded here because each would have been
a silent wrong answer rather than a crash:

- **`result.count`.** `review.ts` reads it off three bare `UPDATE`s to report
  how many sources, offers and price rows a merge moved. A shim that returned
  only rows would have made all three permanently `0` — a wrong number in an
  API response, with nothing failing. It maps to mysql2's `affectedRows`, and
  because mysql2 enables `CLIENT_FOUND_ROWS` that is the *matched* count, which
  is what PostgreSQL's `UPDATE` count was too (Postgres updates every matched
  row even when the new values are identical). A test pins that reading with a
  deliberately no-op update.
- **The `sql(...)` helpers are four forms, not one.** The survey recorded only
  `sql(array)` for `IN`. PMD also uses `sql("pmd.brand")` for a dynamic
  identifier (15 sites), `sql(columns)` for a bare identifier list, and
  `sql(rows, ...columns)` for postgres.js's insert helper. Dotted names must
  split — `` `pmd`.`brand` ``, not the single identifier `` `pmd.brand` ``.
  An array of strings is `("a","b")` after `IN` and `` `a`, `b` `` after
  `SELECT`, and the call itself cannot tell which: only the SQL around it can.
  postgres.js decides by looking at the text immediately before the
  interpolation, so the shim defers the decision to compile time and does the
  same — and **throws** where the position settles nothing, because guessing
  would emit silently wrong SQL. Identifiers containing a backtick are refused.
- **`.reserve()` is used** — by the review-bridge test, to hold a lock from
  outside the transaction under test and prove a second promotion queues behind
  it. The first survey missed it because it excluded PMD's test files, which
  were already out of CI. The test cannot be written without a second
  connection, so the shim provides it.

There are still no cursors, no streaming and no `LISTEN`/`NOTIFY`.

**Laziness is the load-bearing part.** A postgres.js template does not run when
it is written, it runs when it is awaited, and that is what lets PMD nest them:

```ts
sql`SELECT … WHERE 1=1 ${q ? sql`AND name LIKE ${q}` : sql``}`
```

PMD does this at 8 sites plus two helper fragments, so the shim returns a lazy
`Fragment` rather than a `Promise`: it compiles to text and parameters, splices
any Fragment interpolated into it, and executes only when awaited. The test
asserts a built-but-unawaited `INSERT` does not reach the database.

### Stage 3 — the queries

The residue once the `pmd.` prefix is free, re-counted at the start of stage 3
(the first pass under-counted because it measured before the `pmd.` rewrite and
double-counted some lines): 67 casts, 26 `ON CONFLICT` with 57 `EXCLUDED`
references, 23 `RETURNING`, 21 jsonb operators, 13 `FILTER (WHERE)`, 13
`= ANY`, 6 `unnest`, 3 advisory locks, 3 `ILIKE`, 2 `LATERAL`, 2 `array_agg`, 2
`generate_series`, 2 regex `~`, 1 `nextval`, 1 `interval`, 1 `date_trunc`.

One earlier figure was inflated and is corrected here: the jsonb operator count
was 32, of which 11 were `?|` inside JavaScript **regular expressions**, not
SQL. The real constructs are 9 `jsonb_populate_recordset`, 6 `#>>`, 2
`jsonb_to_recordset`, 2 `jsonb_array_elements_text` and 2 `->>`.

The superseded first-pass numbers were: 28 casts, 10 `ON CONFLICT` with 7
`EXCLUDED`, 6 `RETURNING`, 5 array constructors, 4 `generate_series`, 3
`LATERAL`, 3 `ILIKE`, 3 jsonb operators, 2 `FILTER (WHERE)`, 2 `= ANY`, plus
`claim_job`, `refresh_dashboard` and `ensure_price_history_partitions` as
TypeScript. The helpers written for the application port
(`insertReturning`, `upsertReturning`, `keepExisting`, the counters idiom, the
lock-row idiom) all transfer.

### Stage 4 — retrieval and search ranking (landed)

This was the stage flagged from the start as the one that changes behaviour
rather than spelling, so it was measured rather than asserted. The measurement
is `scripts/pmd/measure-recall.ts` and is repeatable.

**What PostgreSQL was doing.** `WHERE col % $1 ORDER BY similarity(col, $1) DESC
LIMIT k` answered the predicate *and* the ordering from one GIN trigram index,
so the k rows were exactly the k most similar above `pg_trgm.similarity_threshold`.

**What MySQL does instead.** Its full-text index can only narrow, and its
relevance score is not similarity, so the work splits: MySQL retrieves
candidates through an ngram index, and `trigramSimilarity()` in
`normalize/text.ts` ranks them. That function already implemented the same
definition PostgreSQL's `similarity()` uses, so **ordering and scores are
identical by construction** and the only thing that can differ is recall —
which rows the index offers up to be ranked.

`%` could not be left in place under any circumstances: in MySQL it is *modulo*.
It parses, it runs, and on two strings it answers 0, so every predicate using it
would have silently matched nothing.

**Recall, measured over a 5,000-row catalogue** (`top/qual` is the top-k against
how many rows clear the threshold; the columns are candidates retrieved per
wanted row):

| query | top/qual | x10 | x20 | x50 | x200 |
|---|---|---|---|---|---|
| exact phrase | 20/62 | 100% | 100% | 100% | 100% |
| typo ("amull buttar") | 15/15 | 100% | 100% | 100% | 100% |
| transposition ("amul buttre") | 20/43 | 100% | 100% | 100% | 100% |
| misspelt brand ("brittania") | 12/12 | 100% | 100% | 100% | 100% |
| pack size ("500 ml") | 20/27 | 85% | 100% | 100% | 100% |
| brand only ("britannia") | 20/347 | 50% | 80% | 90% | 90% |
| three words | 20/352 | 35% | 90% | 90% | 90% |

Retrieval saturates at **20x**, which is what the code uses; 50x and 200x
recover nothing further. Recall is 100% for every query whose answer is well
defined. The two that stop at 90% are the ones where ~350 rows clear the
threshold for a top-20: there the twenty are chosen among hundreds of near-ties,
so which twenty come back is arbitrary in either engine, and all twenty are
above the threshold either way.

**Two findings that make the difference between this working and not.** Both
were silent, and both were found by measuring rather than by reading:

1. **The obvious query form scores 0% on exactly the typo queries fuzzy search
   exists for.** Asking the index for the terms themselves — `+"amull"
   +"buttar"` — makes the ngram parser look for them as *substrings*, and a
   misspelling is not a substring of the correct spelling. Overall recall was
   47%, with typo and transposition at 0%. Decomposing the query into its own
   ngrams and OR-ing them (`"am" "mu" "ul" ...`) is how an ngram index is meant
   to be asked a fuzzy question: "buttar" shares `bu`, `ut` and `tt` with
   "butter", so the row is retrieved and then ranked exactly. That one change
   took overall recall from 47% to 97%.

2. **InnoDB's stopword list applies to ngrams.** Fifteen of its thirty-five
   default stopwords are exactly two characters — `an as at be by de en in is it
   la of on or to` — and under the ngram parser a token *is* a 2-gram, so each
   of those is dropped from the index. Any word containing one has a hole in its
   gram sequence and stops matching as a phrase. Measured: `"tata"` and
   `"patanjali"` matched **nothing** while `"amul"` worked, so Tata, Patanjali,
   Britannia and Colgate would all have been unfindable with nothing to say why.
   The index is therefore built with `innodb_ft_enable_stopword = OFF`. That is
   a SESSION variable read at build time, not query time, so the migration sets
   it for its own connection and **the deployment needs no server
   configuration** — verified that an index built with it off still matches
   correctly from a connection using the default.

**Why the ngram parser rather than MySQL's default word parser.** The default
parser silently drops every token shorter than `innodb_ft_min_token_size`, which
is 3: `"lg"` and `"hp"` match nothing, not even as `+lg*`, and a catalogue is
full of two-letter brands and units. PostgreSQL's `to_tsvector('simple', …)` had
no minimum. Raising that variable fixes it but is server-level — a restart, a
rebuild of every full-text index, and impossible on shared hosting. The ngram
index needs none of that and additionally matches substrings, which is closer to
trigram behaviour than whole-word matching.

**The one genuine behaviour change** is the keyword strategy's ordering.
`ts_rank` has no MySQL equivalent, so it becomes MySQL's `MATCH … AGAINST`
relevance. That relevance is unbounded (1.337 on a nine-row table) where
`ts_rank` was 0–1, and `products.ts` *adds* it to a per-strategy base — 100 for
an identifier hit, 50 for keyword, 0 for fuzzy — so used raw it would eventually
push a keyword hit past the identifier base and let a name match outrank an exact
barcode match. It is rescaled onto 0–1 by dividing by the largest in the result
set, which is monotonic and so leaves the order within the strategy alone while
keeping the strategy layering intact. Ordering *within* keyword results changes;
ordering *between* strategies does not, and fuzzy ordering does not change at
all.


### Stage 5 — tests and CI

15 `pmd-*.test.ts` files, currently excluded from CI by `npm run test:ci`
because their schema no longer existed on the MySQL side. Restoring them is how
this port proves itself. `tests/helpers/pmd.ts` needs its `TRUNCATE … RESTART
IDENTITY CASCADE` and `ALTER SEQUENCE … RESTART` replaced the same way the
application's `resetDatabase` was — and now also needs to reset `pmd.counters`,
since three keys are allocated from it rather than by AUTO_INCREMENT.

## Running it today

```bash
# PMD shares the application's MySQL server; the database is created if absent
DATABASE_URL='mysql://user:pass@host:3306/gokesari' npm run pmd:migrate
```

`PMD_DATABASE_URL` still overrides the connection if PMD is pointed somewhere
else on purpose. It must name a MySQL server: the runner refuses a
`postgresql://` URL rather than failing later inside the wire protocol.

To re-run the retrieval measurement behind stage 4:

```bash
npx tsx scripts/pmd/measure-recall.ts 'mysql://user:pass@host:3306/scratch'
```

It builds its own 5,000-row catalogue and needs no PostgreSQL server: the
PostgreSQL answer is computed directly, since `trigramSimilarity()` is the same
definition `similarity()` uses.
