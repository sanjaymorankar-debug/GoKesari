#!/usr/bin/env bash
# On the owner's Mac, weekly (plan §5.1, layer 4): copies the newest encrypted
# nightly dump of each database from the server into a folder on the Mac. They
# open only with the owner's age private key:
#   age -d -i <key file> -o prod.dump prod-YYYY-MM-DD.dump.age
#
#   scripts/vps-db/mac/pull-dumps.sh [folder]
# Default folder: ~/Documents/Doc_GoKesari/Devlopment_Trackers/db_backups
set -euo pipefail

host=${GK_DB_SSH_HOST:-10.66.0.1}
key="$HOME/.ssh/gokesari_db_admin"
dest=${1:-"$HOME/Documents/Doc_GoKesari/Devlopment_Trackers/db_backups"}
mkdir -p "$dest"
ssh_() { ssh -i "$key" -o IdentitiesOnly=yes "gkadmin@$host" "$@"; }

for env in prod staging; do
  f=$(ssh_ "sudo sh -c 'ls -1t /var/lib/gokesari-db/dumps/$env/*.dump.age 2>/dev/null | head -1'")
  if [ -z "$f" ]; then echo "$env: no encrypted dump on the server yet."; continue; fi
  ssh_ "sudo cat '$f'" > "$dest/.part"
  mv "$dest/.part" "$dest/$(basename "$f")"
  echo "$env: $(basename "$f") ($(du -h "$dest/$(basename "$f")" | cut -f1)) → $dest"
done
