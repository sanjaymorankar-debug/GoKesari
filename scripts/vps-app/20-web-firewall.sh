#!/usr/bin/env bash
# Gate H1, step 2 (docs/app-to-vps-2026-11/PLAN.md section 7, B2): open the web
# ports and move the database certificate's renewal onto Caddy. Run as root after
# 10-install.sh; safe to re-run.
#
#   1. ufw: allow 80/tcp, 443/tcp and 443/udp (HTTP/3) from anywhere. Rules are only
#      added, never deleted (as in the database kit's access.sh).
#   2. /etc/caddy/acme.caddy: plain-HTTP site for db.gokesari.com and db-test.gokesari.com
#      that serves only /.well-known/acme-challenge/* from /var/lib/gk-app/acme and answers
#      404 to everything else (no redirect).
#   3. certbot's gokesari-db certificate: authenticator standalone -> webroot (that folder).
#      Until now certbot bound port 80 itself and its pre/post hooks opened and closed
#      80/tcp in ufw; Caddy holds port 80 now, so those hooks go. The deploy hook that
#      installs the certificate into PostgreSQL (gk-cert-deploy) stays.
#   4. certbot renew --cert-name gokesari-db --dry-run.
#   5. Prints the rules for Hostinger's VPS firewall (the session adds them by API).
. "$(dirname "$0")/lib.sh"
need_root
need_config DB_HOST_PROD DB_HOST_TEST

log "ufw: web ports"
for rule in "allow 80/tcp" "allow 443/tcp" "allow 443/udp"; do
  # shellcheck disable=SC2086
  ufw $rule >/dev/null
done

log "Caddy: certificate challenges for $DB_HOST_PROD and $DB_HOST_TEST"
install -d -m 755 "$APP_STATE" "$R$ACME_WEBROOT"
cat > "$CADDY_ETC/acme.caddy.new" <<EOF
# Written by scripts/vps-app/20-web-firewall.sh. Edits here are overwritten.
# certbot renews the database certificate (gokesari-db) with its webroot here; the
# database host names serve nothing else over HTTP and have no HTTPS site.
http://$DB_HOST_PROD, http://$DB_HOST_TEST {
	handle /.well-known/acme-challenge/* {
		root * $ACME_WEBROOT
		file_server
	}
	handle {
		respond 404
	}
}
EOF
chmod 644 "$CADDY_ETC/acme.caddy.new"
cp -p "$CADDY_ETC/acme.caddy" "$APP_STATE/acme.caddy.before" 2>/dev/null || true
mv "$CADDY_ETC/acme.caddy.new" "$CADDY_ETC/acme.caddy"
if ! reload_caddy; then
  [ -f "$APP_STATE/acme.caddy.before" ] && cp -p "$APP_STATE/acme.caddy.before" "$CADDY_ETC/acme.caddy"
  reload_caddy || true
  die "Caddy refused acme.caddy; the previous one is back."
fi

# Caddy answers the challenge path from the webroot (on this machine, as Let's Encrypt would ask).
probe=gk-selftest-$$
install -d -m 755 "$R$ACME_WEBROOT/.well-known/acme-challenge"
echo "$probe" > "$R$ACME_WEBROOT/.well-known/acme-challenge/$probe"
chmod 644 "$R$ACME_WEBROOT/.well-known/acme-challenge/$probe"
got=$(curl -fsS --max-time 10 -H "Host: $DB_HOST_PROD" "http://127.0.0.1/.well-known/acme-challenge/$probe" 2>/dev/null || true)
rm -f "$R$ACME_WEBROOT/.well-known/acme-challenge/$probe"
[ "$got" = "$probe" ] || die "Caddy does not serve $ACME_WEBROOT/.well-known/acme-challenge/ for $DB_HOST_PROD (got '${got:0:60}'). Nothing in certbot was changed."
log "Caddy serves the challenge folder for $DB_HOST_PROD and $DB_HOST_TEST."

log "certbot: gokesari-db renews through the webroot"
[ -f "$LE_RENEWAL" ] || die "No $LE_RENEWAL: issue the certificate first (scripts/vps-db/40-tls.sh)."
install -d -m 700 "$APP_STATE/certbot-before"
backup=$APP_STATE/certbot-before/gokesari-db.conf.$(date +%Y%m%d-%H%M%S)
cp -p "$LE_RENEWAL" "$backup"
awk -v webroot="$ACME_WEBROOT" -v d1="$DB_HOST_PROD" -v d2="$DB_HOST_TEST" '
  /^\[\[webroot_map\]\]/ { skip = 1; next }          # rewritten below
  /^\[/                  { skip = 0 }
  skip                   { next }
  /^\[renewalparams\]/   { print; print "authenticator = webroot"; print "webroot_path = " webroot ","; inparams = 1; next }
  /^\[/                  { inparams = 0 }
  inparams && /^[[:space:]]*(authenticator|webroot_path|pre_hook|post_hook|http01_port|http01_address)[[:space:]]*=/ { next }
  { print }
  END { print "[[webroot_map]]"; print d1 " = " webroot; print d2 " = " webroot }
' "$backup" > "$LE_RENEWAL.new"
grep -q '^authenticator = webroot$' "$LE_RENEWAL.new" || die "Could not rewrite $LE_RENEWAL (no [renewalparams] section?). Unchanged; copy at $backup."
chmod 600 "$LE_RENEWAL.new"
mv "$LE_RENEWAL.new" "$LE_RENEWAL"
if grep -Eq '^(renew_hook|deploy_hook) *= *.*gk-cert-deploy' "$LE_RENEWAL"; then
  log "The deploy hook (gk-cert-deploy, certificate into PostgreSQL) is kept."
else
  log "WARNING: no gk-cert-deploy deploy hook in $LE_RENEWAL; a renewed certificate would not reach PostgreSQL. Check scripts/vps-db/40-tls.sh."
fi

if certbot renew --cert-name gokesari-db --dry-run >"$APP_STATE/certbot-dry-run.log" 2>&1; then
  log "certbot renew --dry-run passed through Caddy's webroot."
else
  tail -20 "$APP_STATE/certbot-dry-run.log" >&2
  die "certbot's dry run failed (log $APP_STATE/certbot-dry-run.log). The old settings are in $backup, but they bind port 80 themselves and cannot work while Caddy holds it. The certificate itself is unchanged; fix this before it is due (certbot certificates)."
fi

echo
echo "Hostinger VPS firewall (hPanel → VPS → Security → Firewall): add these accept rules."
printf '%-7s %-5s %-6s %-6s %s\n' Action Proto Port Source Why
printf '%-7s %-5s %-6s %-6s %s\n' Accept TCP 443 Any "HTTPS (Caddy)"
printf '%-7s %-5s %-6s %-6s %s\n' Accept UDP 443 Any "HTTP/3 (Caddy)"
printf '%-7s %-5s %-6s %-6s %s\n' Accept TCP 80 Any "HTTP: redirects and certificate challenges (already there)"
