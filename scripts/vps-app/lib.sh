# Shared settings and helpers for the GoKesari web-layer kit
# (docs/app-to-vps-2026-11/PLAN.md, sections 3-7). Sourced by every script in
# scripts/vps-app/ and bin/; on the server the kit lives in /opt/gokesari-app,
# next to the database kit in /opt/gokesari-db.
#
# It sources the database kit's lib.sh first, for log/die (IST times), need_root,
# use_env, read_secret and hc_ping, and for the database names in
# /etc/gokesari-db/config.env.
#
# No secrets here or anywhere in the kit. Site settings are typed or piped into
# /etc/sites/<site>.env on the server (gk-site env ...), root only.
#
# GK_APP_ROOT (tests only): a directory that stands in for / for every file the
# kit reads or writes, so the tools can run on a laptop against stubbed commands
# (test/dry-run.sh). Unset on the server.
set -euo pipefail

GK_APP_KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The database kit: installed copy first, else the sibling folder in a checkout.
GK_DB_KIT=${GK_DB_KIT:-/opt/gokesari-db}
[ -r "$GK_DB_KIT/lib.sh" ] || GK_DB_KIT=$GK_APP_KIT_DIR/../vps-db
if [ ! -r "$GK_DB_KIT/lib.sh" ]; then
  echo "ERROR: the database kit's lib.sh is not in /opt/gokesari-db or next to this kit." >&2
  exit 1
fi
# shellcheck source=../vps-db/lib.sh
. "$GK_DB_KIT/lib.sh"

R=${GK_APP_ROOT:-}
# The database kit's secrets (role passwords, healthchecks.io ping key).
GK_SECRETS=$R/etc/gokesari-db/secrets

SITES_ETC_REAL=/etc/sites               # as written into units
SITES_ETC=$R$SITES_ETC_REAL             # <site>.conf, <site>.env, <site>.deploykey (root, 700)
SITES_SRV_REAL=/srv/sites               # as written into units and the Caddy blocks
SITES_SRV=$R$SITES_SRV_REAL
APP_STATE=$R/var/lib/gk-app
ACME_WEBROOT=/var/lib/gk-app/acme       # certbot webroot for db / db-test (20-web-firewall.sh)
CADDY_ETC=$R/etc/caddy
CADDYFILE=$CADDY_ETC/Caddyfile
CADDY_SITES=$CADDY_ETC/sites
CADDY_LOG_DIR=/var/log/caddy
UNIT_DIR=$R/etc/systemd/system
SBIN=$R/usr/local/sbin
LOCK_FILE=$R/run/lock/gk-deploy.lock
LE_RENEWAL=$R/etc/letsencrypt/renewal/gokesari-db.conf
KNOWN_HOSTS=$GK_APP_KIT_DIR/github_known_hosts
PG_SOCKET_DIR=/var/run/postgresql

NODE_MAJOR=24
NODE_BIN=/usr/bin/node

# Builds (plan section 3, "Builds (gk-build)"): one at a time on the server.
BUILD_MEM=5G
# next build needs more than Node's default heap (about 2 GB here): it ran out at 2 GB on
# 17-Nov-2026. Hostinger's builds had a larger NODE_OPTIONS heap. Builds only; the sites keep
# the default.
BUILD_NODE_OPTIONS=--max-old-space-size=3584
BUILD_CPU=150%
BUILD_NICE=10
BUILD_TIMEOUT=${GK_BUILD_TIMEOUT:-20min}
KEEP_RELEASES=5

# Blue/green switch (plan section 3).
HEALTH_PATHS=${GK_HEALTH_PATHS:-"/ /shops /api/shops?limit=1"}
HEALTH_WAIT=${GK_HEALTH_WAIT:-60}       # seconds for the new colour to answer 200 on every path
DRAIN_SECONDS=${GK_DRAIN_SECONDS:-60}   # the old colour keeps running this long after the switch

# Cron preset: docs/crontab.txt (production lines, UTC). <job>|<UTC cron>|<curl --max-time>
CRON_PRESET_GOKESARI="every-minute|* * * * *|55
hourly|17 * * * *|300
daily|30 23 * * *|300"

# Keys `gk-site env paste` never takes from the input (owner, 17-Nov-2026).
# Retired split-era database settings:
ENV_DROP_RETIRED="SELLER_DATABASE_URL DB_SPLIT_MODE PROD_SELLER_DATABASE_URL PROD_CUSTOMER_DATABASE_URL TEST_DATABASE_URL TEST_DATABASE_HOST TEST_DATABASE_NAME TEST_NEON_API_KEY"
# Written by `gk-site env db` instead:
ENV_DROP_DB="DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE"
# Shell and process noise from /proc/<pid>/environ of the Hostinger process.
# NODE_* except NODE_ENV, npm_*, LC_*, LSNODE_*, LSAPI_* and PASSENGER_* are matched by prefix in env_noise.
ENV_DROP_NOISE="PATH HOME PWD OLDPWD SHLVL _ HOSTNAME USER LOGNAME SHELL MAIL LANG LANGUAGE TERM INIT_CWD LS_COLORS PORT TMPDIR"

# log on stderr: for functions whose stdout is captured (their reason for failing).
info() { log "$@" >&2; }

need_root() {
  [ -n "$R" ] && return 0
  [ "$(id -u)" = 0 ] || die "Run this as root (sudo)."
}

valid_site() { [[ "${1:-}" =~ ^[a-z][a-z0-9-]{1,22}[a-z0-9]$ ]] || die "Bad site name '${1:-}': lower-case letters, digits and '-', 3-24 characters."; }
site_conf() { printf '%s/%s.conf' "$SITES_ETC" "$1"; }
site_env() { printf '%s/%s.env' "$SITES_ETC" "$1"; }
site_key() { printf '%s/%s.deploykey' "$SITES_ETC" "$1"; }
site_dir() { printf '%s/%s' "$SITES_SRV" "$1"; }
site_state() { printf '%s/%s/deployed.json' "$SITES_SRV" "$1"; }
site_names() {
  local f
  for f in "$SITES_ETC"/*.conf; do [ -e "$f" ] && basename "$f" .conf; done
  return 0
}

# load_site <name>: the site's settings (SITE_*), written by gk-site add.
load_site() {
  valid_site "$1"
  local conf
  conf=$(site_conf "$1")
  [ -r "$conf" ] || die "No site '$1' (gk-site add first)."
  SITE_NAME="" SITE_USER="" SITE_DOMAINS="" SITE_REPO="" SITE_BRANCH="" SITE_PORT_BLUE="" SITE_PORT_GREEN=""
  SITE_MEM_GB="" SITE_CPU="" SITE_DB_PORT="" SITE_TLS="" SITE_CRON="" SITE_BUILD_CMD=""
  # shellcheck source=/dev/null
  . "$conf"
  [ "$SITE_NAME" = "$1" ] || die "$conf names site '$SITE_NAME', not '$1'."
  SITE_PRIMARY=${SITE_DOMAINS%% *}
}

colour_port() { if [ "$1" = blue ]; then echo "$SITE_PORT_BLUE"; else echo "$SITE_PORT_GREEN"; fi; }
other_colour() { if [ "$1" = blue ]; then echo green; else echo blue; fi; }
unit_of() { printf 'site@%s-%s.service' "$1" "$2"; }

iso_now() { TZ=Asia/Kolkata date '+%Y-%m-%dT%H:%M:%S+05:30'; }

# json_get <file> <key>: one top-level string or number from a small JSON file.
json_get() {
  [ -r "$1" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$2" '.[$k] // empty' "$1"
  else
    node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];if(v!==undefined&&v!==null)console.log(v)' "$1" "$2"
  fi
}

# JSON string: backslash and quote escaped, control characters dropped.
json_str() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$(printf '%s' "$s" | tr -d '\000-\037')"
}

# The one lock for deploys, Caddy edits and site changes on this server
# (plan section 4: one deploy at a time). with_lock wait|nowait
with_lock() {
  install -d -m 755 "$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  if [ "$1" = nowait ]; then
    flock -n 9 || return 1
  else
    flock -n 9 || { log "Another deploy or site change is running; waiting for it (up to 30 min)."; flock -w 1800 9 || die "Still locked after 30 min: $LOCK_FILE."; }
  fi
}

# healthchecks.io: hc_ping (the database kit) for ok|start|fail. hc_log records an
# event without changing the check's state; with ?create=1 it makes a new check that
# stays "new" (no alerts) until its first real ping.
hc_log() {
  local slug=$1 msg=${2:-} key
  if ! has_secret hc-ping-key; then
    log "healthchecks.io not set up yet (gk-db-secret set-healthchecks): $slug log"
    return 0
  fi
  key=$(read_secret hc-ping-key)
  # The URL (it holds the ping key) goes on stdin, not the command line.
  printf 'url = "https://hc-ping.com/%s/%s/log?create=1"\n' "$key" "$slug" \
    | curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${msg:0:10000}" --config - \
    || log "WARNING: could not reach healthchecks.io for $slug"
}

# --- Caddy ------------------------------------------------------------------
# write_caddy_block <upstream port>: the site's block from its settings (load_site
# first). gk-deploy calls it to move the upstream; gk-site tls to change TLS.
# Prints nothing; the caller reloads Caddy.
caddy_block_text() {
  local port=$1 tls_line
  if [ "$SITE_TLS" = internal ]; then
    tls_line="	tls internal   # preview: Caddy's own CA (gk-site tls $SITE_NAME acme after DNS points here)"
  else
    tls_line="	# TLS: automatic Let's Encrypt certificates (gk-site tls $SITE_NAME acme)"
  fi
  cat <<EOF
# Written by gk-site / gk-deploy (scripts/vps-app). Edits here are overwritten.
# Site $SITE_NAME: $SITE_REPO, branch $SITE_BRANCH.
$(printf '%s' "$SITE_DOMAINS" | sed 's/ /, /g') {
$tls_line
	header -Server
	log {
		output file $CADDY_LOG_DIR/site-$SITE_NAME.log {
			roll_size 50MiB
			roll_keep_for 336h
		}
	}
	# Active colour; gk-deploy moves it (blue $SITE_PORT_BLUE, green $SITE_PORT_GREEN).
	reverse_proxy 127.0.0.1:$port
}
EOF
}

write_caddy_block() {
  local f tmp
  install -d -m 755 "$CADDY_SITES"
  f=$CADDY_SITES/$SITE_NAME.caddy
  tmp=$(mktemp "$CADDY_SITES/.tmp.XXXXXX")
  caddy_block_text "$1" > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$f"
}

# reload_caddy: graceful (no dropped connections). Fails if Caddy rejects the
# new configuration; Caddy then keeps running the old one.
reload_caddy() {
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy
  else
    systemctl restart caddy
  fi
}

# The upstream port the site's Caddy block points at now (empty if none).
caddy_upstream_port() {
  local f=$CADDY_SITES/$1.caddy
  [ -r "$f" ] || return 0
  sed -n -E 's/^[[:space:]]*reverse_proxy 127\.0\.0\.1:([0-9]+).*/\1/p' "$f" | head -1
}

# --- cron (UTC hPanel lines -> systemd OnCalendar on the server's IST clock) ---
# expand_cron_field <field> <max>: the numbers a cron field selects.
expand_cron_field() {
  local field=$1 max=$2 part step lo hi i out=() parts=()
  IFS=, read -r -a parts <<< "$field"
  for part in "${parts[@]}"; do
    step=1
    if [[ "$part" == */* ]]; then step=${part#*/}; part=${part%/*}; fi
    [[ "$step" =~ ^[0-9]+$ ]] && [ "$step" -ge 1 ] || return 1
    if [ "$part" = '*' ]; then lo=0; hi=$max
    elif [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then lo=${BASH_REMATCH[1]}; hi=${BASH_REMATCH[2]}
    elif [[ "$part" =~ ^[0-9]+$ ]]; then lo=$part; hi=$part
    else return 1; fi
    [ "$lo" -le "$hi" ] && [ "$hi" -le "$max" ] || return 1
    for ((i = lo; i <= hi; i += step)); do out+=("$i"); done
  done
  printf '%s\n' "${out[@]}" | sort -n -u | tr '\n' ' '
}

# cron_to_oncalendar "<min> <hour> * * *": one OnCalendar= value per line, in IST
# (UTC + 5:30). Day, month and weekday must be '*' (all of GoKesari's lines are).
cron_to_oncalendar() {
  local m h dom mon dow extra mins hours mm hh t lines=() key
  read -r m h dom mon dow extra <<< "$1"
  [ -n "$dow" ] && [ -z "${extra:-}" ] || return 1
  [ "$dom" = '*' ] && [ "$mon" = '*' ] && [ "$dow" = '*' ] || return 1
  if [ "$m" = '*' ] && [ "$h" = '*' ]; then echo '*-*-* *:*:00'; return 0; fi
  mins=$(expand_cron_field "$m" 59) || return 1
  if [ "$h" = '*' ]; then
    # Every hour: only the minute moves (+30).
    local ist=()
    for mm in $mins; do ist+=("$(printf '%02d' $(( (mm + 30) % 60 )))"); done
    echo "*-*-* *:$(printf '%s\n' "${ist[@]}" | sort -u | paste -sd, -):00 Asia/Kolkata"
    return 0
  fi
  hours=$(expand_cron_field "$h" 23) || return 1
  # Each UTC (hour, minute) -> IST; one line per IST minute, listing its hours.
  declare -A by_min=()
  for hh in $hours; do
    for mm in $mins; do
      t=$(( (hh * 60 + mm + 330) % 1440 ))
      key=$(printf '%02d' $(( t % 60 )))
      by_min[$key]+="$(printf '%02d' $(( t / 60 ))) "
    done
  done
  for key in $(printf '%s\n' "${!by_min[@]}" | sort -n); do
    lines+=("*-*-* $(printf '%s\n' ${by_min[$key]} | sort -n -u | paste -sd, -):$key:00 Asia/Kolkata")
  done
  printf '%s\n' "${lines[@]}"
}
