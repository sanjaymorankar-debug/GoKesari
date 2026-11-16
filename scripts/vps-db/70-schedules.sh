#!/usr/bin/env bash
# Phase 1, step 16 (RUNBOOK.md): systemd timers for the health check, the
# nightly dumps and backups, and the certificate check (plan §5.1, §6.1).
# Run as root; safe to re-run. Times are IST, away from the app's 05.00 IST
# daily cron and the Sunday 03.00–03.30 IST reboot window (plan §6.2).
. "$(dirname "$0")/lib.sh"
need_root

unit() { # unit <name> <OnCalendar> <command> <description>
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$4
After=postgresql.service

[Service]
Type=oneshot
ExecStart=$3
Nice=10
EOF
  cat > "/etc/systemd/system/$1.timer" <<EOF
[Unit]
Description=$4 (schedule)

[Timer]
OnCalendar=$2
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

unit gk-db-health          '*:0/5'                          '/usr/local/sbin/gk-db-health'                'GoKesari DB health check'
unit gk-db-cert-check      '*-*-* 09:00:00 Asia/Kolkata'    '/usr/local/sbin/gk-db-health --cert'         'GoKesari DB certificate check'
unit gk-db-dump-prod       '*-*-* 02:15:00 Asia/Kolkata'    '/usr/local/sbin/gk-db-dump prod'             'GoKesari production nightly dump'
unit gk-db-backup-prod     '*-*-* 02:30:00 Asia/Kolkata'    '/usr/local/sbin/gk-db-backup prod auto'      'GoKesari production pgBackRest backup'
unit gk-db-dump-staging    '*-*-* 02:45:00 Asia/Kolkata'    '/usr/local/sbin/gk-db-dump staging'          'GoKesari staging nightly dump'
unit gk-db-backup-staging  '*-*-* 02:50:00 Asia/Kolkata'    '/usr/local/sbin/gk-db-backup staging auto'   'GoKesari staging pgBackRest backup'

systemctl daemon-reload
for t in health cert-check dump-prod backup-prod dump-staging backup-staging; do
  systemctl enable --now "gk-db-$t.timer" >/dev/null 2>&1
done
systemctl list-timers 'gk-db-*' --no-pager
log "Schedules installed. healthchecks.io checks to set up: RUNBOOK.md step 17."
