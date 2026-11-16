#!/usr/bin/env bash
# On the owner's Mac (RUNBOOK.md step 15), with the owner's OK: keys for the
# GitHub workflow jobs that will reach the database server (plan §4.6, §5.1).
# Adding these secrets changes nothing that runs today; the Phase 2 tooling PR
# starts using them.
#
# For each job it makes:
#   - a WireGuard key pair. The private key goes straight into a GitHub
#     environment secret and is never shown or saved.
#   - for jobs that take snapshots, an SSH key pair, handled the same way.
# It prints only the PUBLIC keys, as `gk-peer` lines to run on the server.
# Needs: gh (signed in), wg (brew install wireguard-tools). Bash 3.2 is fine.
#
#   scripts/vps-db/mac/make-github-keys.sh            make keys for jobs that have none
#   scripts/vps-db/mac/make-github-keys.sh --rotate   replace all of them
set -euo pipefail

rotate=no
[ "${1:-}" = --rotate ] && rotate=yes
command -v gh >/dev/null || { echo "gh is not installed." >&2; exit 1; }
command -v wg >/dev/null || { echo "wg is not installed: brew install wireguard-tools" >&2; exit 1; }
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# peer                  environment  WireGuard secret              snapshot SSH secret
jobs="
gh-test-db              test         VPS_WG_KEY_TEST_DB            VPS_SSH_KEY_TEST_DB
gh-copy-shops-export    test         VPS_WG_KEY_COPY_SHOPS_EXPORT  -
gh-prod-db              production   VPS_WG_KEY_PROD_DB            VPS_SSH_KEY_PROD_DB
gh-copy-shops           production   VPS_WG_KEY_COPY_SHOPS         VPS_SSH_KEY_COPY_SHOPS
"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
out=""

has_secret() { gh secret list --repo "$repo" --env "$1" --json name -q '.[].name' | grep -qx "$2"; }

# The job list comes in on fd 3, so `gh` and `ssh-keygen` cannot read it from stdin.
while read -r peer env wgname sshname <&3; do
  [ -n "$peer" ] || continue
  if [ "$rotate" = no ] && has_secret "$env" "$wgname"; then
    echo "$peer: $wgname is already set in '$env'; kept (use --rotate to replace)."
  else
    priv=$(wg genkey)
    printf '%s' "$priv" | gh secret set "$wgname" --repo "$repo" --env "$env" >/dev/null
    pub=$(printf '%s' "$priv" | wg pubkey)
    priv=""
    echo "$peer: $wgname set in '$env'."
    out="${out}sudo gk-peer set-wg $peer $pub
"
  fi
  [ "$sshname" != - ] || continue
  if [ "$rotate" = no ] && has_secret "$env" "$sshname"; then
    echo "$peer: $sshname is already set in '$env'; kept."
  else
    ssh-keygen -q -t ed25519 -N '' -C "$peer" -f "$tmp/$peer"
    gh secret set "$sshname" --repo "$repo" --env "$env" < "$tmp/$peer" >/dev/null
    echo "$peer: $sshname set in '$env'."
    out="${out}sudo gk-peer set-ssh $peer $(cat "$tmp/$peer.pub")
"
    rm -f "$tmp/$peer" "$tmp/$peer.pub"
  fi
done 3<<EOF
$jobs
EOF

if [ -n "$out" ]; then
  echo
  echo "Run these on the server (public keys only):"
  printf '%s' "$out"
fi
