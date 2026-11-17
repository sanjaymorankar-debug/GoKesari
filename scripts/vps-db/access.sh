#!/usr/bin/env bash
# Who may reach what (plan §4.6), from config.env and the peer table in lib.sh:
# the ufw firewall and each instance's pg_hba.conf / pg_ident.conf.
# Run as root; safe to re-run, and run it again after changing APP_IPS_* or SSH_MODE.
#
#   access.sh               apply
#   access.sh --hostinger   print the matching rules for hPanel's VPS firewall
#
# ufw rules are only added here, never deleted: rules no longer wanted are
# listed at the end for a person to remove (`ufw status numbered`, `ufw delete N`).
. "$(dirname "$0")/lib.sh"
need_root

ips_ok() { local ip; for ip in "$@"; do [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "'$ip' is not an IPv4 address (APP_IPS_*)."; done; }
# shellcheck disable=SC2086
ips_ok $APP_IPS_PROD $APP_IPS_STAGING
case "$SSH_MODE" in public|wg) ;; *) die "SSH_MODE must be public or wg." ;; esac
# The web layer (scripts/vps-app) is installed: Caddy holds 80/443 for good.
web_layer() { [ -f /etc/caddy/acme.caddy ]; }

if [ "${1:-}" = --hostinger ]; then
  echo "hPanel → VPS → Security → Firewall: accept these, drop the rest."
  printf '%-7s %-5s %-6s %-18s %s\n' Action Proto Port Source Why
  printf '%-7s %-5s %-6s %-18s %s\n' Accept UDP "$WG_PORT" Any "WireGuard"
  if web_layer; then
    printf '%-7s %-5s %-6s %-18s %s\n' Accept TCP 80 Any "HTTP (Caddy): redirects, certificate challenges"
    printf '%-7s %-5s %-6s %-18s %s\n' Accept TCP 443 Any "HTTPS (Caddy)"
    printf '%-7s %-5s %-6s %-18s %s\n' Accept UDP 443 Any "HTTP/3 (Caddy)"
  else
    printf '%-7s %-5s %-6s %-18s %s\n' Accept TCP 80 Any "Let's Encrypt renewals (ufw keeps it shut otherwise)"
  fi
  [ "$SSH_MODE" = wg ] || printf '%-7s %-5s %-6s %-18s %s\n' Accept TCP 22 Any "SSH while building (removed at 90-lockdown.sh)"
  for ip in $APP_IPS_PROD; do printf '%-7s %-5s %-6s %-18s %s\n' Accept TCP "$PROD_PORT" "$ip" "gokesari.com → production"; done
  for ip in $APP_IPS_STAGING; do printf '%-7s %-5s %-6s %-18s %s\n' Accept TCP "$TEST_PORT" "$ip" "test.gokesari.com → staging"; done
  exit 0
fi

# --- ufw ---------------------------------------------------------------------
want=("allow $WG_PORT/udp")
[ "$SSH_MODE" = public ] && want+=("limit 22/tcp")
for name in $(peer_names); do
  for port in $(peer_field "$name" 2 | tr ',' ' '); do
    want+=("allow in on wg0 from $(peer_field "$name" 1) to any port $port proto tcp")
  done
done
for ip in $APP_IPS_PROD; do want+=("allow from $ip to any port $PROD_PORT proto tcp"); done
for ip in $APP_IPS_STAGING; do want+=("allow from $ip to any port $TEST_PORT proto tcp"); done
# Caddy (scripts/vps-app/20-web-firewall.sh): the sites, and the db certificate's renewals.
web_layer && want+=("allow 80/tcp" "allow 443/tcp" "allow 443/udp")

ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw logging low >/dev/null
for rule in "${want[@]}"; do
  # shellcheck disable=SC2086
  ufw $rule >/dev/null
done
ufw --force enable >/dev/null
log "Firewall: ${#want[@]} rules applied (SSH: $SSH_MODE)."

extra=$(ufw show added | sed -n 's/^ufw //p' | while read -r line; do
  keep=no
  for rule in "${want[@]}"; do [ "$line" = "$rule" ] && keep=yes; done
  # certbot opens 80/tcp for a minute during renewals.
  [ "$line" = "allow 80/tcp" ] && keep=yes
  [ "$keep" = yes ] || echo "  ufw delete $line"
done)
if [ -n "$extra" ]; then
  log "These ufw rules are not in config.env any more. Check, then remove them:"
  printf '%s\n' "$extra"
fi

# --- pg_hba.conf / pg_ident.conf ----------------------------------------------
write_hba() {
  use_env "$1"
  [ -d "$PGCONF" ] || return 0
  local port name ip
  port=$PORT
  {
    echo "# Written by scripts/vps-db/access.sh from /etc/gokesari-db/config.env and lib.sh."
    echo "# Edits here are overwritten. Plan §4.6."
    echo "# TYPE   DATABASE  USER               ADDRESS            METHOD"
    echo "local    all       postgres                              peer"
    echo "local    all       monitor                               peer map=gk_monitor"
    printf 'local    %-9s gksnap                                peer\n' "$DB"
    echo "# The site on this server (scripts/vps-app, gk-site env db): Unix socket, password"
    printf 'local    %-9s %-18s                    scram-sha-256\n' "$DB" "$APP_ROLE"
    echo "# App server(s) on Hostinger: TLS and password only"
    for ip in $APP_IPS; do
      printf 'hostssl  %-9s %-18s %-18s scram-sha-256\n' "$DB" "$APP_ROLE" "$ip/32"
    done
    echo "# WireGuard peers that may reach port $port"
    for name in $(peer_names); do
      peer_has_port "$name" "$port" || continue
      ip=$(peer_field "$name" 1)
      # A production job reaching staging (gh-prod-db, tested-on-test.sh) may only read.
      if [ "$name" != owner-mac ] && [ "$port" = 5433 ] && peer_has_port "$name" 5432; then
        printf 'hostssl  %-9s %-18s %-18s scram-sha-256   # %s (read-only)\n' "$DB" "$RO_ROLE" "$ip/32" "$name"
        continue
      fi
      printf 'hostssl  %-9s %-18s %-18s scram-sha-256   # %s\n' "$DB" "$APP_ROLE" "$ip/32" "$name"
      [ "$name" = owner-mac ] && printf 'hostssl  %-9s %-18s %-18s scram-sha-256   # %s\n' "$DB" "$RO_ROLE" "$ip/32" "$name"
    done
    echo "# Nothing else: no plain 'host' lines, no superuser over the network."
  } > "$PGCONF/pg_hba.conf.new"
  printf '# Written by scripts/vps-db/access.sh.\n# MAPNAME    SYSTEM-USER  PG-USER\ngk_monitor   root         monitor\n' > "$PGCONF/pg_ident.conf.new"
  chown postgres:postgres "$PGCONF/pg_hba.conf.new" "$PGCONF/pg_ident.conf.new"
  chmod 640 "$PGCONF/pg_hba.conf.new" "$PGCONF/pg_ident.conf.new"
  mv "$PGCONF/pg_hba.conf.new" "$PGCONF/pg_hba.conf"
  mv "$PGCONF/pg_ident.conf.new" "$PGCONF/pg_ident.conf"
  if pg_ctlcluster "$PG_MAJOR" "$CLUSTER" status >/dev/null 2>&1; then
    pg_ctlcluster "$PG_MAJOR" "$CLUSTER" reload
    bad=$(pg "$PORT" -d postgres -tAc "select string_agg(line_number || ': ' || error, '; ') from pg_hba_file_rules where error is not null")
    [ -z "$bad" ] || die "pg_hba.conf on $GK_ENV has errors: $bad"
  fi
  log "pg_hba.conf on $GK_ENV: app server(s): ${APP_IPS:-none yet}."
}
write_hba prod
write_hba staging
