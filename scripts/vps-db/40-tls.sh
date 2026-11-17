#!/usr/bin/env bash
# Phase 1, step 11 (RUNBOOK.md): Let's Encrypt certificate for both host names
# (plan §4.6). Run as root; safe to re-run. Needs the DNS A records for
# db.gokesari.com and db-test.gokesari.com pointing at this server (step 10).
#
# Issuing accepts Let's Encrypt's subscriber agreement (part of the owner's G2 OK).
# Port 80 is opened in ufw only while certbot runs; hPanel's VPS firewall keeps
# 80/tcp open, and nothing listens there otherwise. Renewal is certbot's own
# timer; gk-cert-deploy copies each new certificate to both instances.
# Once the web layer is installed (scripts/vps-app/20-web-firewall.sh), Caddy holds
# port 80 and certbot uses its webroot instead (no standalone server, no ufw hooks).
. "$(dirname "$0")/lib.sh"
need_root
need_config VPS_PUBLIC_IP DB_HOST_PROD DB_HOST_TEST

for name in "$DB_HOST_PROD" "$DB_HOST_TEST"; do
  got=$(getent ahostsv4 "$name" | awk 'NR==1 {print $1}')
  [ "$got" = "$VPS_PUBLIC_IP" ] || die "DNS: $name points at '${got:-nothing}', not $VPS_PUBLIC_IP. Add the A record (RUNBOOK step 10) and wait a few minutes."
done

if [ -n "$LETSENCRYPT_EMAIL" ]; then email=(-m "$LETSENCRYPT_EMAIL"); else email=(--register-unsafely-without-email); fi
if [ -f /etc/caddy/acme.caddy ]; then
  # The web layer (scripts/vps-app/20-web-firewall.sh) holds port 80: Caddy serves the
  # challenge files from this webroot, so certbot neither binds 80 nor touches ufw.
  how=(--webroot -w /var/lib/gk-app/acme)
else
  how=(--standalone --pre-hook "ufw allow 80/tcp" --post-hook "ufw delete allow 80/tcp")
fi
certbot certonly "${how[@]}" --non-interactive --agree-tos "${email[@]}" \
  --cert-name gokesari-db -d "$DB_HOST_PROD" -d "$DB_HOST_TEST" \
  --deploy-hook /usr/local/sbin/gk-cert-deploy --keep-until-expiring

# The deploy hook runs only when a certificate is issued; run it again so a re-run also installs it.
RENEWED_LINEAGE=/etc/letsencrypt/live/gokesari-db gk-cert-deploy
systemctl enable --now certbot.timer >/dev/null 2>&1 || true
certbot renew --dry-run --cert-name gokesari-db >/dev/null && log "Renewal dry run passed."
for env in prod staging; do
  use_env "$env"
  log "$DB_HOSTNAME:$PORT presents: $(openssl s_client -starttls postgres -connect "127.0.0.1:$PORT" -servername "$DB_HOSTNAME" </dev/null 2>/dev/null \
    | openssl x509 -noout -subject -enddate 2>/dev/null | tr '\n' ' ')"
done
