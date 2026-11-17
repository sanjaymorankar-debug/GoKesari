#!/usr/bin/env bash
# Does the DATABASE_URL that `gk-site env db` writes work with the app's own database
# code? A throwaway PostgreSQL (socket only, no TCP), the pg_hba.conf line that
# scripts/vps-db/access.sh writes for the app role, then src/server/db and
# src/server/pmd/db with that env file (test/db-socket.ts, through tsx).
#
#   bash scripts/vps-app/test/db-socket.sh <env file from the dry run>
#     (GK_TEST_ENV_OUT=<file> bash scripts/vps-app/test/dry-run.sh makes one)
#
# Needs PostgreSQL's initdb / pg_ctl / psql (PG_BIN; on a Mac, Postgres.app) and the
# repository's node_modules (npm ci). Everything is made in a temporary folder and removed.
set -euo pipefail
ENVFILE=${1:?usage: db-socket.sh <env file>}
PG_BIN=${PG_BIN:-/Applications/Postgres.app/Contents/Versions/latest/bin}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
D=$(mktemp -d "${TMPDIR:-/tmp}/gk-pg.XXXXXX")
mkdir -p "$D/s"
"$PG_BIN/initdb" -D "$D/data" -U postgres --auth=trust -E UTF8 --locale=C >/dev/null
cat >> "$D/data/postgresql.conf" <<EOF
listen_addresses = ''
unix_socket_directories = '$D/s'
port = 5433
password_encryption = scram-sha-256
EOF
{
  echo "local    all       postgres                              trust"
  # The line access.sh writes for the staging instance:
  printf 'local    %-9s %-18s                    scram-sha-256\n' gokesari_test gokesari_test_app
} > "$D/data/pg_hba.conf"
"$PG_BIN/pg_ctl" -D "$D/data" -l "$D/log" -w start >/dev/null
trap '"$PG_BIN/pg_ctl" -D "$D/data" -m fast stop >/dev/null; rm -rf "$D"' EXIT
pw=$(set -a; . "$ENVFILE"; printf '%s' "$PGPASSWORD")
"$PG_BIN/psql" -X -q -h "$D/s" -p 5433 -U postgres -d postgres -v ON_ERROR_STOP=1 -v pw="$pw" <<'EOF'
create role gokesari_test_app login password :'pw';
create database gokesari_test owner gokesari_test_app;
EOF
q() { "$PG_BIN/psql" -X -tA -h "$D/s" -p 5433 -U postgres -d postgres -c "$1"; }
echo "pg_hba.conf errors: $(q "select count(*) from pg_hba_file_rules where error is not null")"
echo "pg_hba.conf rule for the app: $(q "select type || ' ' || array_to_string(database, ',') || ' ' || array_to_string(user_name, ',') || ' ' || auth_method from pg_hba_file_rules where 'gokesari_test_app' = any(user_name)")"
cd "$REPO"
(
  set -a; . "$ENVFILE"; set +a
  export PGHOST=$D/s   # stands in for /var/run/postgresql
  echo "env file: DATABASE_URL, PGHOST, PGPORT=$PGPORT, PGUSER=$PGUSER, PGPASSWORD (not shown)"
  node_modules/.bin/tsx scripts/vps-app/test/db-socket.ts
)
