#!/usr/bin/env bash
# Phase 1, step 5 (RUNBOOK.md): checks the new VPS before anything is installed.
# Read-only; run as root. Stops at the first thing that is not as ordered at G1.
. "$(dirname "$0")/lib.sh"
need_root

# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "Expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}. Reinstall the OS in hPanel (plain Ubuntu 24.04)."
[ "$(uname -m)" = x86_64 ] || die "Expected x86_64, found $(uname -m)."

mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024 + 0.5}' /proc/meminfo)
cpus=$(nproc)
disk_gb=$(df -BG --output=size / | tail -1 | tr -dc '0-9')
log "CPU: $cpus, memory: ${mem_gb} GB, disk: ${disk_gb} GB"
[ "$cpus" -ge 2 ] && [ "$mem_gb" -ge 7 ] && [ "$disk_gb" -ge 90 ] || die "This is not a KVM 2 (2 vCPU, 8 GB, 100 GB)."

[ "$GK_KIT_DIR" = /opt/gokesari-db ] || log "NOTE: the kit runs from $GK_KIT_DIR, not /opt/gokesari-db. The installed commands expect /opt/gokesari-db."
[ -r "$GK_ETC/config.env" ] || die "$GK_ETC/config.env is missing. Copy config.example.env there and fill it in (RUNBOOK step 4)."
need_config VPS_PUBLIC_IP ADMIN_SSH_PUBKEY
ip -4 -o addr show | grep -qw "$VPS_PUBLIC_IP" || die "VPS_PUBLIC_IP $VPS_PUBLIC_IP is not an address of this server: $(ip -4 -o addr show scope global | awk '{print $4}' | tr '\n' ' ')"
printf '%s\n' "$ADMIN_SSH_PUBKEY" | ssh-keygen -l -f /dev/stdin >/dev/null 2>&1 || die "ADMIN_SSH_PUBKEY is not a valid SSH public key."

if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != yes ]; then
  log "WARNING: the clock is not NTP-synchronised yet. Backups and certificates need the right time; check again after 10-os.sh."
fi
if command -v pg_lsclusters >/dev/null && [ -n "$(pg_lsclusters -h 2>/dev/null)" ]; then
  log "NOTE: PostgreSQL clusters already exist:"; pg_lsclusters
fi
log "Preflight passed: Ubuntu $VERSION_ID, $cpus vCPU, ${mem_gb} GB, ${disk_gb} GB, public IP $VPS_PUBLIC_IP."
