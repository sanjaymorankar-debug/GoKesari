#!/usr/bin/env bash
# On the owner's Mac, at gate G1, with the owner's OK: makes the admin SSH key
# for the database server and prints its PUBLIC key, for hPanel's "SSH key"
# box at purchase and for ADMIN_SSH_PUBKEY in config.env. A public key is safe
# to share. The private key stays in ~/.ssh on this Mac (protected by FileVault).
#
#   scripts/vps-db/mac/make-admin-key.sh
set -euo pipefail

key="$HOME/.ssh/gokesari_db_admin"
if [ -e "$key" ]; then
  echo "The key already exists, kept: $key"
else
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  # No passphrase: sessions use it unattended. The Mac's disk encryption protects it.
  ssh-keygen -q -t ed25519 -a 100 -N '' -C "gokesari-db-admin $(date +%Y-%m-%d)" -f "$key"
  echo "Made $key"
fi
echo
echo "PUBLIC key (for hPanel and config.env):"
cat "$key.pub"
