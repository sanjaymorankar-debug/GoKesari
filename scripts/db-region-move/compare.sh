#!/usr/bin/env bash
# Database region move (docs/db-region-move-2026-10/PLAN.md): proves a copy is
# complete. Compares the old and the new database:
#   - the exact row count of every table (foreign tables too: on the core
#     database they read through each side's own seller link);
#   - the last value of every sequence;
#   - how many indexes, constraints, triggers, functions, views and foreign
#     tables each schema has, and the extensions.
#
#   OLD_URL=<old database> NEW_URL=<new database> scripts/db-region-move/compare.sh
#
# Optional: FOREIGN=no skips counting foreign tables (e.g. before relink.sh).
# Exits 1 and prints the differences when anything differs. Only reads.
set -euo pipefail

fail() { echo "ERROR: $1" >&2; exit 1; }

[ -n "${OLD_URL:-}" ] || fail "OLD_URL is not set."
[ -n "${NEW_URL:-}" ] || fail "NEW_URL is not set."
OLD_URL=$(printf '%s' "$OLD_URL" | tr -d '\r\n')
NEW_URL=$(printf '%s' "$NEW_URL" | tr -d '\r\n')
kinds="'r','p'"
[ "${FOREIGN:-yes}" = "no" ] || kinds="'r','p','f'"

SKIP="n.nspname not in ('pg_catalog','information_schema','neon_auth') and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp%'"

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
if diff -u --label old --label new "$work/old" "$work/new" > "$work/diff"; then
  echo "SAME: $tables tables ($rows rows), $sequences sequences, every schema's objects and the extensions match."
  finished=yes
else
  echo "DIFFERENT (- old, + new):"
  grep -E '^[-+][^-+]' "$work/diff"
  exit 1
fi
