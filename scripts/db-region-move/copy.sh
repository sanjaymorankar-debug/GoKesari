#!/usr/bin/env bash
# Database region move (docs/db-region-move-2026-10/PLAN.md): copies ONE
# database into an empty database in the new Neon project.
#
#   SRC_URL=<old database> DST_URL=<new, empty database> scripts/db-region-move/copy.sh
#
# Optional:
#   REQUIRE_FROZEN=yes  stop unless the source is read-only (the real move;
#                       leave unset for a rehearsal copy of a live database)
#   JOBS=8              parallel restore jobs
#
# The source is only read. The target must hold no tables yet (drop and
# recreate the database to start again). Extensions are not copied: create
# them in the target first (plan step A3). The neon_auth schema is Neon's own
# and not used by the app; it is left out. URLs come from the environment so
# the passwords stay out of the process list; only host and database are printed.
set -euo pipefail

fail() { echo "ERROR: $1" >&2; exit 1; }

[ -n "${SRC_URL:-}" ] || fail "SRC_URL is not set."
[ -n "${DST_URL:-}" ] || fail "DST_URL is not set."
# A secret saved with a trailing newline breaks libpq's URL parsing.
SRC_URL=$(printf '%s' "$SRC_URL" | tr -d '\r\n')
DST_URL=$(printf '%s' "$DST_URL" | tr -d '\r\n')
JOBS="${JOBS:-8}"

describe() { psql "$1" -X -v ON_ERROR_STOP=1 -tAc "select current_database(), current_setting('server_version_num')::int / 10000, current_setting('default_transaction_read_only'), (select system_identifier from pg_control_system())"; }
extensions() { psql "$1" -X -v ON_ERROR_STOP=1 -tAc "select extname from pg_extension where extname <> 'plpgsql' order by 1"; }
where() { node -e 'const u = new URL(process.argv[1]); console.log(`${decodeURIComponent(u.pathname.slice(1))} on ${u.hostname}`)' "$1"; }

src_where=$(where "$SRC_URL")
dst_where=$(where "$DST_URL")

src_info=$(describe "$SRC_URL") || fail "Cannot connect to the source ($src_where)."
dst_info=$(describe "$DST_URL") || fail "Cannot connect to the target ($dst_where)."
IFS='|' read -r src_db src_major src_ro src_cluster <<< "$src_info"
IFS='|' read -r dst_db dst_major dst_ro dst_cluster <<< "$dst_info"
# Compared by the server's own identity: two Neon endpoints can share a proxy host name.
[ "$src_cluster" != "$dst_cluster" ] || fail "Source and target are on the same server ($src_where, $dst_where). The target must be in the new project."
client_major=$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')

echo "Source: $src_where (PostgreSQL $src_major, read-only: $src_ro)"
echo "Target: $dst_where (PostgreSQL $dst_major)"
[ "$src_major" = "$dst_major" ] || fail "Source is PostgreSQL $src_major, target $dst_major. Create the target with the same major version."
[ "$client_major" -ge "$src_major" ] || fail "pg_dump is version $client_major; it must be at least $src_major."
[ "$src_db" = "$dst_db" ] || fail "Database names differ ('$src_db' → '$dst_db'). The plan keeps every name; create '$src_db' in the new project."
[ "$dst_ro" = "off" ] || fail "The target is read-only. Lift that before copying into it."

if [ "$src_ro" != "on" ]; then
  [ "${REQUIRE_FROZEN:-}" != "yes" ] || fail "The source is not read-only. Freeze it first (plan step C2)."
  echo "NOTE: the source is not read-only. This is a rehearsal copy; rows written meanwhile will be missing."
fi

used=$(psql "$DST_URL" -X -v ON_ERROR_STOP=1 -tAc "
  select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r','p','f','v','m','S')
     and n.nspname not in ('pg_catalog','information_schema','neon_auth') and n.nspname not like 'pg\_toast%'
     and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')")
[ "$used" = "0" ] || fail "The target already holds $used tables, views or sequences. Drop and recreate '$dst_db' to start again."

src_ext=$(extensions "$SRC_URL")
missing=$(comm -23 <(echo "$src_ext") <(extensions "$DST_URL") | paste -sd ' ' -)
[ -z "$missing" ] || fail "Extensions missing in the target: $missing (plan step A3)."
# The target has its own copies (created by its owner); the dump must not try to recreate or comment on them.
exclude_ext=()
while read -r ext; do [ -n "$ext" ] && exclude_ext+=("--exclude-extension=$ext"); done <<< "$src_ext"

work=$(mktemp -d "${TMPDIR:-/tmp}/region-move.XXXXXX")
# bash 3.2 (macOS) can stop on an error with status 0; an exit before the end always counts as a failure.
finished=no
trap 'status=$?; rm -rf "$work"; [ "$finished" = yes ] || exit $(( status ? status : 1 ))' EXIT
start=$(date +%s)

echo "Dumping…"
pg_dump "$SRC_URL" --format=custom --no-owner --no-privileges --exclude-schema=neon_auth \
  ${exclude_ext[@]+"${exclude_ext[@]}"} --file="$work/db.dump"
dumped=$(date +%s)
echo "  $(( $(stat -f %z "$work/db.dump" 2>/dev/null || stat -c %s "$work/db.dump") / 1024 )) KiB in $((dumped - start)) s"

echo "Restoring ($JOBS jobs)…"
pg_restore --dbname="$DST_URL" --jobs="$JOBS" --no-owner --no-privileges --exit-on-error "$work/db.dump"
restored=$(date +%s)
echo "  done in $((restored - dumped)) s"

# pg_restore leaves the planner without statistics; the first queries would be slow.
echo "Analyzing…"
psql "$DST_URL" -X -v ON_ERROR_STOP=1 -qc "analyze"
echo "Copied $src_where → $dst_where in $(( $(date +%s) - start )) s."
echo "Next: relink.sh (core database only), then compare.sh."
finished=yes
