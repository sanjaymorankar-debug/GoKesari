#!/usr/bin/env bash
# Phase 1, step 6 (RUNBOOK.md): base system for the database server. Run as
# root; safe to re-run. It does not touch PostgreSQL.
#   - updates and the packages the kit needs; time zone IST; host name
#   - the admin user (key only, password-less sudo) and the kit's commands
#   - SSH: keys only (root still by key until 90-lockdown.sh)
#   - automatic security updates, never PostgreSQL, never an automatic reboot
#   - 2 GB swap, journal capped at 500 MB, fail2ban for SSH
#   - firewall in build mode (access.sh)
. "$(dirname "$0")/lib.sh"
need_root
need_config ADMIN_USER ADMIN_SSH_PUBKEY
printf '%s\n' "$ADMIN_SSH_PUBKEY" | ssh-keygen -l -f /dev/stdin >/dev/null 2>&1 || die "ADMIN_SSH_PUBKEY is not a valid SSH public key."

export DEBIAN_FRONTEND=noninteractive
log "Updating the system"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ufw fail2ban python3-systemd unattended-upgrades wireguard-tools certbot \
  age rclone curl ca-certificates gnupg python3 openssl

timedatectl set-timezone Asia/Kolkata
timedatectl set-ntp true
hostnamectl set-hostname gk-db-1

log "Admin user $ADMIN_USER"
id "$ADMIN_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "GoKesari admin" "$ADMIN_USER"
usermod -aG sudo "$ADMIN_USER"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
printf '%s\n' "$ADMIN_SSH_PUBKEY" > "/home/$ADMIN_USER/.ssh/authorized_keys"
chown "$ADMIN_USER:$ADMIN_USER" "/home/$ADMIN_USER/.ssh/authorized_keys"
chmod 600 "/home/$ADMIN_USER/.ssh/authorized_keys"
# Sessions run the kit over SSH with no one to type a password; the login itself is key-only.
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$ADMIN_USER" > /etc/sudoers.d/90-gokesari-admin
chmod 440 /etc/sudoers.d/90-gokesari-admin
visudo -cf /etc/sudoers.d/90-gokesari-admin >/dev/null

log "Kit commands in /usr/local/sbin"
install -d -m 755 "$GK_ETC" "$GK_STATE"
install -d -m 700 "$GK_SECRETS" "$GK_PEERS_DIR"
for f in "$GK_KIT_DIR"/bin/gk-*; do
  chmod 755 "$f"
  ln -sfn "$f" "/usr/local/sbin/$(basename "$f")"
done

log "SSH: keys only"
# Read before cloud-init's 50-cloud-init.conf, so these values win.
cat > /etc/ssh/sshd_config.d/10-gokesari.conf <<'EOF'
# GoKesari database server (scripts/vps-db/10-os.sh). 90-lockdown.sh adds
# 05-gokesari-lockdown.conf: no root login, and SSH only over WireGuard.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 20
ClientAliveInterval 60
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl restart ssh

log "Automatic security updates (no PostgreSQL, no reboot)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# PostgreSQL comes from apt.postgresql.org, which unattended-upgrades does not
# use anyway; the list below keeps it that way if origins are ever widened.
# Minor releases are applied by hand in the monthly window (plan §6.2).
cat > /etc/apt/apt.conf.d/52gokesari-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Package-Blacklist { "postgresql-"; "libpq"; "pgbackrest"; };
EOF

if ! swapon --show=NAME --noheadings | grep -q .; then
  log "2 GB swap file"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
printf 'vm.swappiness = 10\n' > /etc/sysctl.d/60-gokesari.conf
sysctl -q --system

install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/60-gokesari.conf
systemctl restart systemd-journald

# SSH only: PostgreSQL is reachable from allow-listed addresses alone (access.sh),
# so a PostgreSQL jail could only ever ban the app server itself.
cat > /etc/fail2ban/jail.d/60-gokesari.conf <<EOF
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 $WG_NET
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
backend = systemd
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

"$GK_KIT_DIR/access.sh"
log "Base system done. Next: log in as $ADMIN_USER in a NEW terminal before closing this one (RUNBOOK step 7)."
