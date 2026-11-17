#!/usr/bin/env bash
# Phase 1, step 9 (RUNBOOK.md): PostgreSQL 18 from apt.postgresql.org and the
# two instances (plan §4.1–4.3). Run as root; safe to re-run.
#   18/main     production, port 5432
#   18/staging  staging,    port 5433, capped at 1 vCPU and 2 GB (decision 2)
# The databases and roles come next (50-roles.sh). Until the certificate is
# issued (40-tls.sh), each instance uses a temporary self-signed one.
. "$(dirname "$0")/lib.sh"
need_root

export DEBIAN_FRONTEND=noninteractive
PGDG_KEY=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
PGDG_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8

apt-get -y -q install postgresql-common
# The clusters are made below with fixed names, ports and locale; stop the package making its own.
sed -i -E 's/^#?[[:space:]]*create_main_cluster[[:space:]]*=.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf
grep -q '^create_main_cluster = false' /etc/postgresql-common/createcluster.conf || echo 'create_main_cluster = false' >> /etc/postgresql-common/createcluster.conf

if [ ! -s /etc/apt/sources.list.d/pgdg.list ]; then
  log "Adding apt.postgresql.org"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o "$PGDG_KEY" https://www.postgresql.org/media/keys/ACCC4CF8.asc
  fpr=$(gpg --show-keys --with-colons "$PGDG_KEY" 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}')
  [ "$fpr" = "$PGDG_FINGERPRINT" ] || die "apt.postgresql.org key fingerprint is '$fpr', expected $PGDG_FINGERPRINT."
  # shellcheck source=/dev/null
  . /etc/os-release
  echo "deb [signed-by=$PGDG_KEY] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q
fi
apt-get -y -q install "postgresql-$PG_MAJOR" "postgresql-client-$PG_MAJOR" pgbackrest

configure() {
  use_env "$1"
  case "$GK_ENV" in
    prod)
      MAX_CONNECTIONS=100; SHARED_BUFFERS=1GB; EFFECTIVE_CACHE_SIZE=4GB; WORK_MEM=8MB
      MAINTENANCE_WORK_MEM=256MB; TEMP_FILE_LIMIT=5GB; ARCHIVE_TIMEOUT=300 ;;
    staging)
      MAX_CONNECTIONS=60; SHARED_BUFFERS=256MB; EFFECTIVE_CACHE_SIZE=1GB; WORK_MEM=4MB
      MAINTENANCE_WORK_MEM=64MB; TEMP_FILE_LIMIT=2GB; ARCHIVE_TIMEOUT=600 ;;
  esac

  if ! pg_lsclusters -h | awk '{print $1 "/" $2}' | grep -qx "$PG_MAJOR/$CLUSTER"; then
    log "Creating cluster $PG_MAJOR/$CLUSTER on port $PORT"
    pg_createcluster --port "$PORT" --locale C.UTF-8 --encoding UTF8 --start-conf auto "$PG_MAJOR" "$CLUSTER"
  fi

  install -d -o postgres -g postgres -m 700 "$PGCONF/tls"
  if [ ! -s "$PGCONF/tls/server.crt" ]; then
    # Temporary until 40-tls.sh: TLS is on from the first start.
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$DB_HOSTNAME" \
      -keyout "$PGCONF/tls/server.key" -out "$PGCONF/tls/server.crt" 2>/dev/null
    chown postgres:postgres "$PGCONF/tls/server.key" "$PGCONF/tls/server.crt"
    chmod 600 "$PGCONF/tls/server.key"
  fi

  render "$GK_KIT_DIR/templates/postgresql.conf.tmpl" > "$PGCONF/conf.d/90-gokesari.conf"
  chown postgres:postgres "$PGCONF/conf.d/90-gokesari.conf"
}

configure prod
configure staging

# Staging may not slow production down (plan §3.4 A).
install -d "/etc/systemd/system/postgresql@$PG_MAJOR-staging.service.d"
cat > "/etc/systemd/system/postgresql@$PG_MAJOR-staging.service.d/60-limits.conf" <<'EOF'
# GoKesari: staging gets at most 1 vCPU and 2 GB, and yields disk time to production.
[Service]
CPUQuota=100%
MemoryHigh=1792M
MemoryMax=2G
IOWeight=50
EOF
systemctl daemon-reload

# Spare space to delete in an emergency (plan §6.3).
[ -f /var/lib/postgresql/ballast ] || { fallocate -l 2G /var/lib/postgresql/ballast; chmod 600 /var/lib/postgresql/ballast; }

# pgBackRest is set up in 60-pgbackrest.sh; until then archiving fails and the
# WAL waits in pg_wal (a few MB on empty databases).
for c in main staging; do
  systemctl enable "postgresql@$PG_MAJOR-$c" >/dev/null 2>&1
  systemctl restart "postgresql@$PG_MAJOR-$c"
done

for env in prod staging; do
  use_env "$env"
  pg "$PORT" -d postgres -tAc "select 'Instance $GK_ENV: ' || version()"
  pg "$PORT" -d postgres -tAc "select format('  port %s, checksums %s, encoding %s, collation %s, timezone %s, ssl %s, shared_buffers %s',
    current_setting('port'), current_setting('data_checksums'), pg_encoding_to_char(encoding), datcollate,
    current_setting('timezone'), current_setting('ssl'), current_setting('shared_buffers'))
    from pg_database where datname = 'postgres'"
  bad=$(pg "$PORT" -d postgres -tAc "select string_agg(name || ': ' || coalesce(error, 'not applied'), '; ') from pg_file_settings where error is not null or not applied and sourcefile like '%90-gokesari%'")
  [ -z "$bad" ] || die "Settings problem on $GK_ENV: $bad"
  [ "$(pg "$PORT" -d postgres -tAc "show data_checksums")" = on ] || die "Data checksums are off on $GK_ENV."
done
log "PostgreSQL $PG_MAJOR is running: production on $PROD_PORT, staging on $TEST_PORT. Next: 40-tls.sh."
