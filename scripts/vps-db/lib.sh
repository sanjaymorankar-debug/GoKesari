# Shared settings and helpers for the GoKesari database server kit
# (docs/neon-to-vps-2026-11/PLAN.md, RUNBOOK.md). Sourced by every script in
# scripts/vps-db/ and bin/; on the server the kit lives in /opt/gokesari-db.
#
# No secrets here or anywhere in the kit. Passwords and keys are made or typed
# on the server (bin/gk-db-secret) into /etc/gokesari-db/secrets (root only),
# and the owner keeps a copy in the password manager.
set -euo pipefail

GK_KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The kit resolves its own files above; work from / so `runuser -u postgres` never warns about the caller's directory.
cd /

GK_ETC=/etc/gokesari-db
GK_SECRETS=$GK_ETC/secrets
GK_PEERS_DIR=$GK_ETC/peers
GK_STATE=/var/lib/gokesari-db
PG_MAJOR=18
PG_BIN=/usr/lib/postgresql/$PG_MAJOR/bin
PG_SOCKET=/var/run/postgresql
PGBR_CONF=/etc/pgbackrest/pgbackrest.conf
PGBR_SECRETS=/etc/pgbackrest/conf.d/secrets.conf

# Fixed by the plan (§4.2, §4.6): changing them means changing the plan.
PROD_PORT=5432
TEST_PORT=5433
WG_PORT=51820
WG_SERVER_IP=10.66.0.1
WG_NET=10.66.0.0/24

# Defaults for config.env (decision 6: recommended names).
VPS_PUBLIC_IP=""
DB_HOST_PROD=db.gokesari.com
DB_HOST_TEST=db-test.gokesari.com
PROD_DB=gokesari
TEST_DB=gokesari_test
PROD_APP_ROLE=gokesari_app
TEST_APP_ROLE=gokesari_test_app
PROD_RO_ROLE=gokesari_ro
TEST_RO_ROLE=gokesari_test_ro
APP_IPS_PROD=""
APP_IPS_STAGING=""
SSH_MODE=public
ADMIN_USER=gkadmin
ADMIN_SSH_PUBKEY=""
LETSENCRYPT_EMAIL=""
R2_ACCOUNT_ID=""
R2_BUCKET=gokesari-db-backups
DUMP_AGE_RECIPIENT=""
ALERT_DESTINATION=""
APP_LIVE_PROD=no
APP_LIVE_STAGING=no
# shellcheck source=/dev/null
if [ -r "$GK_ETC/config.env" ]; then . "$GK_ETC/config.env"; fi

# WireGuard peers: name, tunnel address, TCP ports it may reach on the server.
# One key per workflow job, so two jobs never share a tunnel (plan §4.6).
# Port 22 is for the restricted snapshot command (gksnap), except on owner-mac,
# where it is the admin login. 5432 = production, 5433 = staging.
GK_PEERS="
owner-mac             10.66.0.10  22,5432,5433
gh-test-db            10.66.0.21  22,5433
gh-copy-shops-export  10.66.0.22  5433
gh-prod-db            10.66.0.23  22,5432
gh-copy-shops         10.66.0.24  22,5432
"

ist() { TZ=Asia/Kolkata date '+%d-%b-%Y %H.%M IST'; }
log() { printf '%s  %s\n' "$(ist)" "$*"; }
die() { printf '%s  ERROR: %s\n' "$(ist)" "$*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "Run this as root (sudo)."; }

need_config() {
  local v
  for v in "$@"; do
    [ -n "${!v:-}" ] || die "$v is empty in $GK_ETC/config.env (see config.example.env)."
  done
}

# Off-site copies in Cloudflare R2 only once R2_ACCOUNT_ID is set (decision 3:
# "VPS only" from 16-Nov-2026; R2 can be added later by re-running 60-pgbackrest.sh).
r2_enabled() { [ -n "$R2_ACCOUNT_ID" ]; }
# pgBackRest repositories in use: 1 = this disk, 2 = Cloudflare R2.
pgbr_repos() { if r2_enabled; then echo "1 2"; else echo 1; fi; }
pgbr_where() { if r2_enabled; then echo "this disk and R2"; else echo "this disk (no R2)"; fi; }

# use_env prod|staging: sets the names for one instance.
use_env() {
  case "$1" in
    prod|production|main)
      GK_ENV=prod; CLUSTER=main; PORT=$PROD_PORT; DB=$PROD_DB
      APP_ROLE=$PROD_APP_ROLE; RO_ROLE=$PROD_RO_ROLE; DB_HOSTNAME=$DB_HOST_PROD
      APP_IPS=$APP_IPS_PROD; APP_LIVE=$APP_LIVE_PROD; STANZA=prod
      APP_CONN_LIMIT=60 ;;
    staging|test)
      GK_ENV=staging; CLUSTER=staging; PORT=$TEST_PORT; DB=$TEST_DB
      APP_ROLE=$TEST_APP_ROLE; RO_ROLE=$TEST_RO_ROLE; DB_HOSTNAME=$DB_HOST_TEST
      APP_IPS=$APP_IPS_STAGING; APP_LIVE=$APP_LIVE_STAGING; STANZA=staging
      APP_CONN_LIMIT=40 ;;
    *) die "Unknown environment '$1': use prod or staging." ;;
  esac
  PGDATA=/var/lib/postgresql/$PG_MAJOR/$CLUSTER
  PGCONF=/etc/postgresql/$PG_MAJOR/$CLUSTER
}

# Peer table helpers. peer_field <name> <1=ip|2=ports>
peer_names() { printf '%s\n' "$GK_PEERS" | awk 'NF==3 {print $1}'; }
peer_field() { printf '%s\n' "$GK_PEERS" | awk -v n="$1" -v f="$2" 'NF==3 && $1==n {print $(f+1)}'; }
peer_has_port() { case ",$(peer_field "$1" 2)," in *",$2,"*) return 0 ;; *) return 1 ;; esac; }
is_peer() { [ -n "$(peer_field "$1" 1)" ]; }

# psql as the postgres superuser over the local socket.
pg() { local port=$1; shift; runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -h "$PG_SOCKET" -p "$port" "$@"; }

secret_file() { printf '%s/%s' "$GK_SECRETS" "$1"; }
has_secret() { [ -s "$(secret_file "$1")" ]; }
read_secret() { has_secret "$1" || die "Secret '$1' is not set (gk-db-secret list)."; tr -d '\r\n' < "$(secret_file "$1")"; }

# Replace @KEY@ placeholders in a template with the values of the shell variables of the same name.
render() {
  local tmpl=$1 out key
  out=$(cat "$tmpl")
  for key in $(grep -o '@[A-Z0-9_]*@' "$tmpl" | sort -u | tr -d '@'); do
    [ -n "${!key+x}" ] || die "render $tmpl: $key is not set."
    out=${out//@$key@/${!key}}
  done
  printf '%s\n' "$out"
}

# healthchecks.io ping (plan §6.1). hc_ping <slug> [start|fail|ok] [message]
# Checks are created on first ping (?create=1); set each one's period and
# grace in healthchecks.io as RUNBOOK.md lists. Without a ping key this only logs.
hc_ping() {
  local slug=$1 kind=${2:-ok} msg=${3:-} key url
  if ! has_secret hc-ping-key; then
    log "healthchecks.io not set up yet (gk-db-secret set-healthchecks): $slug $kind"
    return 0
  fi
  key=$(read_secret hc-ping-key)
  url="https://hc-ping.com/$key/$slug"
  case "$kind" in start) url="$url/start" ;; fail) url="$url/fail" ;; esac
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${msg:0:10000}" "$url?create=1" \
    || log "WARNING: could not reach healthchecks.io for $slug"
}
