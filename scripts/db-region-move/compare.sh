#!/usr/bin/env bash
# Proves a copy made by copy.sh is complete (the region move, Neon → Neon,
# docs/db-region-move-2026-10/PLAN.md; the move to GoKesari's own database server,
# Neon → VPS, docs/neon-to-vps-2026-11/PLAN.md §8). Compares the old and the new
# database:
#   - the exact row count of every table (foreign tables too: on the core
#     database they read through each side's own seller link);
#   - the last value of every sequence;
#   - how many indexes, constraints, triggers, functions, views and foreign
#     tables each schema has, and the extensions;
#   - with CHECKSUM=yes, the contents of every table: an md5 of its rows, each
#     row's text taken in a fixed order (byte order of the rows' md5s), read
#     with fixed output settings (UTC, ISO dates) so both servers write a row
#     alike. It reads every row of every table: seconds for GoKesari's sizes.
#
#   OLD_URL=<old database> NEW_URL=<new database> scripts/db-region-move/compare.sh
#   CHECKSUM=yes OLD_URL=… NEW_URL=… scripts/db-region-move/compare.sh
#
# Optional: FOREIGN=no skips counting foreign tables (e.g. before relink.sh).
# Exits 1 and prints the differences when anything differs. Only reads.
# The databases' names may differ (copy.sh ALLOW_RENAME=yes). Runs with macOS bash 3.2.
set -euo pipefail

fail() { echo "ERROR: $1" >&2; exit 1; }

[ -n "${OLD_URL:-}" ] || fail "OLD_URL is not set."
[ -n "${NEW_URL:-}" ] || fail "NEW_URL is not set."
OLD_URL=$(printf '%s' "$OLD_URL" | tr -d '\r\n')
NEW_URL=$(printf '%s' "$NEW_URL" | tr -d '\r\n')
kinds="'r','p'"
[ "${FOREIGN:-yes}" = "no" ] || kinds="'r','p','f'"
checksum=${CHECKSUM:-no}
case "$checksum" in yes|no) ;; *) fail "CHECKSUM must be yes or no (it is '$checksum')." ;; esac

SKIP="n.nspname not in ('pg_catalog','information_schema','neon_auth') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp%'"

# CHECKSUM=yes: one md5 per table with rows of its own (plain tables and partitions,
# so every row is read once). Each row's text is md5'd, the md5s are joined in byte
# order (collation "C", the same on every server) and md5'd again: the order rows
# are stored in does not matter, their contents do.
CHECKSUM_SQL="
\\set QUIET on
set timezone = 'UTC'; set datestyle = 'ISO, YMD'; set intervalstyle = 'postgres';
set extra_float_digits = 1; set bytea_output = 'hex';
select coalesce(string_agg(format('select %L as t, (select md5(coalesce(string_agg(md5(gk_row::text), %L order by md5(gk_row::text) collate \"C\"), %L)) from %I.%I gk_row) as h',
                                  n.nspname || '.' || c.relname, '', '', n.nspname, c.relname), ' union all '),
                'select null::text as t, null::text as h where false') as sums_sql
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r' and $SKIP
   and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
\\gset
select 'checksum', t, h from (:sums_sql) x order by 2;"
[ "$checksum" = yes ] || CHECKSUM_SQL=""

report() {
  # One statement for all the counts: a far database costs a round trip per statement.
  psql "$1" -X -v ON_ERROR_STOP=1 -tA -F' ' <<SQL
select coalesce(string_agg(format('select %L as t, count(*) as n from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname), ' union all '),
                'select null::text as t, 0::bigint as n where false') as rows_sql
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ($kinds) and $SKIP
   and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
\gset
select 'rows', t, n from (:rows_sql) x order by 2;
$CHECKSUM_SQL
select 'sequence', schemaname || '.' || sequencename, coalesce(last_value::text, '-')
  from pg_sequences where schemaname not in ('neon_auth') order by 2;
-- Objects an extension owns (e.g. pg_stat_statements, only in the new project) are left out.
select 'objects', n.nspname || ' ' || k.kind, count(*) from (
        select 'pg_class'::regclass as cls, oid, relnamespace as ns,
               case relkind when 'i' then 'indexes' when 'I' then 'indexes' when 'v' then 'views' when 'm' then 'matviews'
                            when 'f' then 'foreign-tables' when 'S' then 'sequences' else 'tables' end as kind
          from pg_class where relkind in ('r','p','i','I','v','m','f','S')
        union all select 'pg_constraint'::regclass, oid, connamespace, 'constraints-' || contype::text from pg_constraint
        union all select 'pg_trigger'::regclass, t.oid, c.relnamespace, 'triggers'
                    from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal
        union all select 'pg_proc'::regclass, oid, pronamespace, 'functions' from pg_proc
       ) k join pg_namespace n on n.oid = k.ns
 where $SKIP
   and not exists (select 1 from pg_depend d where d.classid = k.cls and d.objid = k.oid and d.deptype = 'e')
 group by 2 order by 2;
select 'extension', extname, extversion from pg_extension where extname <> 'pg_stat_statements' order by 2;
select 'foreign-server', srvname, coalesce((select option_value from pg_options_to_table(srvoptions) where option_name = 'dbname'), '-')
  from pg_foreign_server order by 2;
SQL
}

where() { node -e 'const u = new URL(process.argv[1]); console.log(`${decodeURIComponent(u.pathname.slice(1))} on ${u.hostname}`)' "$1"; }
work=$(mktemp -d "${TMPDIR:-/tmp}/region-compare.XXXXXX")
# bash 3.2 (macOS) can stop on an error with status 0; an exit before the end always counts as a failure.
finished=no
trap 'status=$?; rm -rf "$work"; [ "$finished" = yes ] || exit $(( status ? status : 1 ))' EXIT

echo "Old: $(where "$OLD_URL")"
echo "New: $(where "$NEW_URL")"
report "$OLD_URL" > "$work/old" || fail "Could not read the old database."
report "$NEW_URL" > "$work/new" || fail "Could not read the new database."

tables=$(grep -c '^rows ' "$work/old" || true)
rows=$(awk '$1 == "rows" { s += $3 } END { print s + 0 }' "$work/old")
sequences=$(grep -c '^sequence ' "$work/old" || true)
sums=""
if [ "$checksum" = yes ]; then
  sums="; the contents of all $(grep -c '^checksum ' "$work/old" || true) tables with rows of their own match (checksums)"
fi
if diff -u --label old --label new "$work/old" "$work/new" > "$work/diff"; then
  echo "SAME: $tables tables ($rows rows), $sequences sequences, every schema's objects and the extensions match$sums."
  finished=yes
else
  echo "DIFFERENT (- old, + new):"
  grep -E '^[-+][^-+]' "$work/diff"
  exit 1
fi
