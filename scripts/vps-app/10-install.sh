#!/usr/bin/env bash
# Gate H1, step 1 (docs/app-to-vps-2026-11/PLAN.md section 7, B1): the web layer's
# software and folders. Run as root on the server; safe to re-run. Changes no site.
#   - Node.js 24 from NodeSource (major pinned), Caddy from its official apt repository,
#     git and jq
#   - /etc/caddy/Caddyfile: global options, then /etc/caddy/acme.caddy and
#     /etc/caddy/sites/*.caddy (one per site, written by gk-site)
#   - /srv/sites, /etc/sites (root, 700), /var/lib/gk-app
#   - the kit's commands in /usr/local/sbin, the systemd templates and timers
#     (timers left OFF: README, H1 step 9)
# Ports 80/443 stay closed in ufw until 20-web-firewall.sh.
. "$(dirname "$0")/lib.sh"
need_root

export DEBIAN_FRONTEND=noninteractive
[ "$GK_APP_KIT_DIR" = /opt/gokesari-app ] || log "NOTE: the kit runs from $GK_APP_KIT_DIR, not /opt/gokesari-app. The installed commands expect /opt/gokesari-app."

# apt key check: print the fingerprint, and compare it when one is given
# (NODESOURCE_FINGERPRINT / CADDY_FINGERPRINT in the environment).
add_key() { # add_key <name> <url> <keyring> <expected fingerprint or empty>
  local tmp fpr
  tmp=$(mktemp "${TMPDIR:-/tmp}/gk-key.XXXXXX")
  curl -fsSL "$2" -o "$tmp"
  fpr=$(gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}')
  [ -n "$fpr" ] || die "$1: the key from $2 is not an OpenPGP key."
  if [ -n "$4" ] && [ "$fpr" != "$4" ]; then die "$1 key fingerprint is $fpr, expected $4."; fi
  log "$1 signing key fingerprint: $fpr (compare with the one the project publishes)."
  gpg --dearmor < "$tmp" > "$3.new"
  chmod 644 "$3.new"
  mv "$3.new" "$3"
  rm -f "$tmp"
}

log "Packages"
apt-get update -q
apt-get -y -q install curl ca-certificates gnupg git jq debian-keyring debian-archive-keyring apt-transport-https
install -d -m 755 "$R/etc/apt/keyrings" "$R/etc/apt/sources.list.d" "$R/etc/apt/preferences.d" "$R/usr/share/keyrings"

if [ ! -s "$R"/etc/apt/sources.list.d/nodesource.list ]; then
  log "Adding NodeSource (Node.js $NODE_MAJOR)"
  add_key NodeSource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "$R"/etc/apt/keyrings/nodesource.gpg "${NODESOURCE_FINGERPRINT:-}"
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
    > "$R"/etc/apt/sources.list.d/nodesource.list
fi
# Ubuntu's own nodejs is older; NodeSource's wins, and only its $NODE_MAJOR.x line exists there.
cat > "$R"/etc/apt/preferences.d/60-nodesource <<'EOF'
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF

if [ ! -s "$R"/etc/apt/sources.list.d/caddy-stable.list ]; then
  log "Adding Caddy's apt repository"
  add_key Caddy https://dl.cloudsmith.io/public/caddy/stable/gpg.key "$R"/usr/share/keyrings/caddy-stable-archive-keyring.gpg "${CADDY_FINGERPRINT:-}"
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > "$R"/etc/apt/sources.list.d/caddy-stable.list
fi
apt-get update -q
apt-get -y -q install nodejs caddy
node_v=$(node -v)
[[ "$node_v" == "v$NODE_MAJOR."* ]] || die "Node is $node_v, not $NODE_MAJOR.x. Check apt-cache policy nodejs."
[ -n "$R" ] || [ "$(command -v node)" = "$NODE_BIN" ] || die "node is at $(command -v node), not $NODE_BIN (the units start $NODE_BIN)."
log "Node $node_v, npm $(npm -v), $(caddy version | awk '{print "Caddy", $1}'), $(git --version)"

log "Folders"
install -d -m 755 "$SITES_SRV" "$APP_STATE" "$R$ACME_WEBROOT"
install -d -m 700 "$SITES_ETC"
install -d -m 755 "$CADDY_SITES"

log "Caddy"
[ -f "$CADDY_ETC/Caddyfile.dist" ] || cp "$CADDYFILE" "$CADDY_ETC/Caddyfile.dist" 2>/dev/null || true
if [ -n "$LETSENCRYPT_EMAIL" ]; then email_line="	email $LETSENCRYPT_EMAIL"; else email_line="	# email: none (LETSENCRYPT_EMAIL is empty in /etc/gokesari-db/config.env)"; fi
cat > "$CADDYFILE.new" <<EOF
# Written by scripts/vps-app/10-install.sh. Edits here are overwritten.
# Sites: /etc/caddy/sites/<site>.caddy (gk-site). Certificate challenges for the
# database host names: /etc/caddy/acme.caddy (20-web-firewall.sh).
{
	# Admin API on this machine only; caddy reload and gk-deploy use it.
	admin localhost:2019
$email_line
	# Caddy's internal CA (sites in preview) is not added to this server's trust store.
	skip_install_trust
	log {
		output file $CADDY_LOG_DIR/caddy.log {
			roll_size 20MiB
			roll_keep_for 336h
		}
		level INFO
	}
	servers {
		protocols h1 h2 h3
	}
}

import /etc/caddy/acme.caddy
import /etc/caddy/sites/*.caddy
EOF
mv "$CADDYFILE.new" "$CADDYFILE"
chmod 644 "$CADDYFILE"
if [ ! -f "$CADDY_ETC/acme.caddy" ]; then
  printf '# Written by 20-web-firewall.sh (certificate challenges for db / db-test). Empty until then.\n' > "$CADDY_ETC/acme.caddy"
  chmod 644 "$CADDY_ETC/acme.caddy"
fi
install -d -m 755 -o caddy -g caddy "$R$CADDY_LOG_DIR"
# As Caddy's own user, so any file it opens while checking (logs, storage) stays Caddy's.
runuser -u caddy -- caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 \
  || { runuser -u caddy -- caddy validate --config "$CADDYFILE" --adapter caddyfile; die "Caddy rejects $CADDYFILE."; }
systemctl enable caddy >/dev/null 2>&1
reload_caddy

log "Kit commands in /usr/local/sbin"
install -d -m 755 "$SBIN" "$UNIT_DIR"
for f in "$GK_APP_KIT_DIR"/bin/gk-*; do
  chmod 755 "$f"
  ln -sfn "$f" "$SBIN/$(basename "$f")"
done

log "systemd templates and timers"
for f in site@.service gk-cron@.service gk-cron@.timer gk-deploy.service gk-deploy.timer gk-app-health.service gk-app-health.timer; do
  install -m 644 "$GK_APP_KIT_DIR/templates/$f" "$UNIT_DIR/$f"
done
install -d -m 755 "$R/etc/systemd/journald.conf.d"
printf '[Journal]\n# Site and kit logs: 14 days (plan section 6).\nMaxRetentionSec=14day\n' > "$R/etc/systemd/journald.conf.d/61-gk-app.conf"
systemctl daemon-reload
systemctl restart systemd-journald

log "Web layer installed. Next: 20-web-firewall.sh (ports 80/443, the db certificate's renewal through Caddy)."
log "The deploy and health timers are OFF until the first deploys: systemctl enable --now gk-deploy.timer gk-app-health.timer"
