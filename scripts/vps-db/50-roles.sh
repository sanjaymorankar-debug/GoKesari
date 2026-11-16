#!/usr/bin/env bash
# Phase 1, step 12 (RUNBOOK.md): roles, empty databases and extensions on both
# instances (plan §4.4–4.5). Run as root; safe to re-run. Passwords are made
# on the server (gk-db-secret gen) and set as SCRAM hashes, so no plain password
# is ever sent in SQL or can land in a log.
#
#   <app role>  owns the database and everything in it (like neondb_owner today); TLS logins only
#   <ro role>   pg_read_all_data, 5 connections; the owner's own queries
#   monitor     pg_monitor, local socket only (the health check, as root)
#   gksnap      pg_read_all_data + pg_create_restore_point, local socket only (gk-db-snapshot)
. "$(dirname "$0")/lib.sh"
need_root

# OS user for the snapshot command: its SSH keys are written by gk-peer.
if ! id gksnap >/dev/null 2>&1; then
  useradd --system --home-dir "$GK_STATE/gksnap" --create-home --shell /bin/bash gksnap
fi
install -d -m 750 -o gksnap -g gksnap "$GK_STATE/snapshots" "$GK_STATE/snapshots/prod" "$GK_STATE/snapshots/staging"
gk-peer apply

scram() { # scram <secret name> -> SCRAM-SHA-256 verifier for that password
  python3 - "$(secret_file "$1")" <<'PY'
import base64, hashlib, hmac, os, sys
pw = open(sys.argv[1]).read().strip().encode()
salt, it = os.urandom(16), 4096
salted = hashlib.pbkdf2_hmac("sha256", pw, salt, it)
client = hmac.new(salted, b"Client Key", "sha256").digest()
stored = hashlib.sha256(client).digest()
server = hmac.new(salted, b"Server Key", "sha256").digest()
b64 = lambda b: base64.b64encode(b).decode()
print(f"SCRAM-SHA-256${it}:{b64(salt)}${b64(stored)}:{b64(server)}")
PY
}

setup() {
  use_env "$1"
  log "Roles and database on $GK_ENV (port $PORT)"
  gk-db-secret gen "$APP_ROLE" >/dev/null
  gk-db-secret gen "$RO_ROLE" >/dev/null

  pg "$PORT" -d postgres <<SQL
select format('create role %I', r) from unnest(array['$APP_ROLE', '$RO_ROLE', 'monitor', 'gksnap']) r
 where not exists (select 1 from pg_roles where rolname = r) \gexec
alter role "$APP_ROLE" login nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit $APP_CONN_LIMIT;
alter role "$RO_ROLE"  login nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 5;
alter role monitor     login nosuperuser nocreatedb nocreaterole noreplication connection limit 3;
alter role gksnap      login nosuperuser nocreatedb nocreaterole noreplication connection limit 2;
alter role "$APP_ROLE" password '$(scram "$APP_ROLE")';
alter role "$RO_ROLE"  password '$(scram "$RO_ROLE")';
grant pg_read_all_data to "$RO_ROLE", gksnap;
grant pg_monitor to monitor;
select format('create database %I owner %I template template0 encoding %L locale_provider libc locale %L', '$DB', '$APP_ROLE', 'UTF8', 'C.UTF-8')
 where not exists (select 1 from pg_database where datname = '$DB') \gexec
revoke all on database "$DB" from public;
grant connect, temporary on database "$DB" to "$APP_ROLE";
grant connect on database "$DB" to "$RO_ROLE", gksnap;
SQL

  # Extensions before the copy (plan §4.4): copy.sh does not copy them.
  pg "$PORT" -d "$DB" <<SQL
create extension if not exists pg_trgm;
create extension if not exists btree_gin;
create extension if not exists pg_stat_statements;
grant execute on function pg_catalog.pg_create_restore_point(text) to gksnap;
SQL
  pg "$PORT" -d "$DB" -tAc "select '  ' || current_database() || ' owner ' || pg_get_userbyid(datdba) || ', collation ' || datcollate || ', extensions: ' || (select string_agg(extname, ', ' order by extname) from pg_extension) from pg_database where datname = current_database()"
}

setup prod
setup staging
"$GK_KIT_DIR/access.sh"
log "Roles and databases ready. Next: 60-pgbackrest.sh."
