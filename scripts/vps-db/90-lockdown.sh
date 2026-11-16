#!/usr/bin/env bash
# Phase 1, step 20 (RUNBOOK.md): the last build step. SSH only over WireGuard
# and no root login (plan §4.6, §6.4). Run as root, from an SSH login that
# itself comes over WireGuard from owner-mac, so the change cannot cut you off.
#
# Afterwards: admin login is ssh gkadmin@10.66.0.1 (tunnel up) only. If the
# tunnel ever breaks, use hPanel's recovery options (RUNBOOK Part 2, "Locked out").
. "$(dirname "$0")/lib.sh"
need_root
need_config ADMIN_USER

mac_ip=$(peer_field owner-mac 1)
[ -s "$GK_PEERS_DIR/owner-mac.wg.pub" ] || die "owner-mac has no WireGuard key yet (gk-peer set-wg owner-mac …)."
# sudo drops SSH_CONNECTION, so look for the admin's own SSH session over the tunnel instead.
ss -Htn state established '( sport = :22 )' | awk '{print $4}' | grep -q "^$mac_ip:" \
  || die "No SSH login over the tunnel from $mac_ip is open. Log in with ssh $ADMIN_USER@$WG_SERVER_IP and run it from there."
[ -s "/home/$ADMIN_USER/.ssh/authorized_keys" ] || die "$ADMIN_USER has no SSH key."

allow="$ADMIN_USER@$mac_ip"
for name in $(peer_names); do
  [ "$name" != owner-mac ] && peer_has_port "$name" 22 && allow="$allow gksnap@$(peer_field "$name" 1)"
done
# Read before 10-gokesari.conf, so these values win.
cat > /etc/ssh/sshd_config.d/05-gokesari-lockdown.conf <<EOF
# GoKesari database server (scripts/vps-db/90-lockdown.sh): no root login;
# admin from the owner's Mac tunnel only; gksnap from the workflow tunnels only.
PermitRootLogin no
AllowUsers $allow
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl restart ssh

sed -i -E 's/^SSH_MODE=.*/SSH_MODE="wg"/' "$GK_ETC/config.env"
grep -q '^SSH_MODE="wg"' "$GK_ETC/config.env" || echo 'SSH_MODE="wg"' >> "$GK_ETC/config.env"
SSH_MODE=wg "$GK_KIT_DIR/access.sh"
ufw delete limit 22/tcp >/dev/null 2>&1 || true
log "SSH now: $allow. Public port 22 is closed in ufw."
log "Remove the SSH (22) rule from hPanel's VPS firewall too:"
SSH_MODE=wg "$GK_KIT_DIR/access.sh" --hostinger
