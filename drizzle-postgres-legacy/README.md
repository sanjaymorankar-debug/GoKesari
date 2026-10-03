# Postgres migrations (historical)

These 37 migrations built the schema while GoKesari ran on PostgreSQL. They are
kept because they are the schema's history and because exporting data out of an
existing Postgres database needs to know what shape that database is in.

**They cannot be applied.** The app runs on MySQL (`drizzle/`), and these use
Postgres-only DDL throughout: `uuid` columns with `gen_random_uuid()`,
`timestamptz`, `jsonb`, `uuid[]`, `CREATE TYPE … AS ENUM`, `CREATE SEQUENCE`,
and partial (`WHERE`-clause) unique indexes.

`drizzle/` holds a single MySQL baseline generated from `src/server/db/schema.ts`
rather than a translation of these files, because the journal in
`drizzle/meta/_journal.json` tracks applied migrations per dialect and a MySQL
database has none of this history to replay.

See `docs/MYSQL_MIGRATION_ASSESSMENT.md` for what each Postgres construct became.
