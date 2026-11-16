#!/usr/bin/env bash
# On the owner's Mac: copies one of the server's secrets to the Mac's clipboard
# without showing it, for pasting into the password manager, hPanel or GitHub.
# Clear the clipboard afterwards (copy anything else).
#
#   scripts/vps-db/mac/copy-secret.sh <name>                     e.g. gokesari_app, pgbackrest-cipher-pass
#   scripts/vps-db/mac/copy-secret.sh url <prod|staging> [app|ro] [require|verify-full]
#       the connection URL with its password; verify-full for the app's DATABASE_URL in hPanel
#
# GK_DB_SSH_HOST: the server (default 10.66.0.1, through the tunnel; before
# WireGuard is set up, use its public IP address).
set -euo pipefail

host=${GK_DB_SSH_HOST:-10.66.0.1}
key="$HOME/.ssh/gokesari_db_admin"
ok() { echo "$1" | grep -Eq '^[a-z0-9_-]{1,64}$' || { echo "Bad argument '$1'." >&2; exit 1; }; }

if [ "${1:-}" = url ]; then
  ok "${2:-}"; ok "${3:-app}"; ok "${4:-require}"
  remote="sudo gk-db-secret url $2 ${3:-app} ${4:-require}"
else
  ok "${1:-}"
  remote="sudo gk-db-secret show $1"
fi
value=$(ssh -i "$key" -o IdentitiesOnly=yes "gkadmin@$host" "$remote")
[ -n "$value" ] || { echo "Nothing came back." >&2; exit 1; }
printf '%s' "$value" | pbcopy
echo "Copied to the clipboard (${#value} characters, not shown). Paste it where it belongs, then copy something else to clear it."
