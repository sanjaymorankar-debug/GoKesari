#!/usr/bin/env bash
# Phase 1, step 14 (RUNBOOK.md): pgBackRest with two repositories, this disk
# and Cloudflare R2 (plan §5.1). Run as root; safe to re-run.
#
# Before running it:
#   1. the owner has typed the R2 write key: ssh -t … sudo gk-db-secret set-r2
#   2. sudo gk-db-secret cipher, and the passphrase is in the password manager.
#      Without that passphrase the R2 copies can never be read. Pass
#      --cipher-saved to confirm it is saved.
. "$(dirname "$0")/lib.sh"
need_root
need_config R2_ACCOUNT_ID R2_BUCKET

has_secret r2-access-key-id && has_secret r2-secret-access-key || die "The R2 key is not set. The owner runs: ssh -t <admin> sudo gk-db-secret set-r2 (RUNBOOK step 13)."
has_secret pgbackrest-cipher-pass || die "No pgBackRest passphrase yet. Run: sudo gk-db-secret cipher, save it in the password manager, then re-run with --cipher-saved."
[ "${1:-}" = --cipher-saved ] || die "Confirm the pgBackRest passphrase is in the owner's password manager, then re-run with --cipher-saved."

install -d -m 750 -o postgres -g postgres /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest
install -d -m 750 -o root -g postgres /etc/pgbackrest /etc/pgbackrest/conf.d
render "$GK_KIT_DIR/templates/pgbackrest.conf.tmpl" > "$PGBR_CONF.new"
chown root:postgres "$PGBR_CONF.new"
chmod 640 "$PGBR_CONF.new"
mv "$PGBR_CONF.new" "$PGBR_CONF"
gk-db-secret sync

for stanza in prod staging; do
  log "Stanza $stanza"
  runuser -u postgres -- pgbackrest --stanza="$stanza" stanza-create
  # check: forces a WAL switch and waits for it to reach both repositories.
  runuser -u postgres -- pgbackrest --stanza="$stanza" check
done

gk-db-backup prod full
gk-db-backup staging full
runuser -u postgres -- pgbackrest info
log "pgBackRest ready: first full backups are in both repositories. Next: 70-schedules.sh."
