#!/usr/bin/env bash
# Post-deploy check for a GoKesari site (incident 25 Oct 2026, E-02:
# docs/gokesari-audit/INCIDENT_2026-10-25_production_hang.md). After a deploy
# the site must answer, and keep answering, before the release counts as done.
#
#   scripts/release/post-deploy-check.sh [site] [options]
#     site            default https://gokesari.com
#     --wait  S       seconds to wait before the first round (default 0)
#     --rounds N      healthy rounds in a row needed (default 5)
#     --every S       seconds between rounds (default 60)
#     --deadline S    give up after S seconds of checking (default 900)
#
# A round is healthy when every page below answers 200 within 20 s. The
# defaults need five minutes of answers in a row: on 25 Oct the site came up
# after the restart and then stopped answering a minute later.
#
# It only reads public pages (guest-safe on production) and changes nothing.
# Exit 0 = healthy; 1 = not healthy by the deadline (the remedy is printed);
# 2 = bad arguments.
set -euo pipefail

site="https://gokesari.com"
wait=0 rounds=5 every=60 deadline=900
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) wait="$2"; shift 2 ;;
    --rounds) rounds="$2"; shift 2 ;;
    --every) every="$2"; shift 2 ;;
    --deadline) deadline="$2"; shift 2 ;;
    http*://*) site="${1%/}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

paths=(/ /shops /robots.txt)
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

log() { echo "$(date -u +%H:%M:%S) $*"; }

# One page: the final status after redirects (the host's firewall sometimes
# answers a request itself with a 307 to the same page — E-01) and the time.
probe() {
  curl -sS -L -o /dev/null -m 20 -b "$jar" -c "$jar" \
    -A "GoKesari post-deploy check" -w "%{http_code} %{time_total}\n" "$site$1" 2>/dev/null || echo "000 20"
}

if [ "$wait" -gt 0 ]; then
  log "waiting ${wait}s for the deploy to finish"
  sleep "$wait"
fi

start=$(date +%s) streak=0
while :; do
  ok=1 line=""
  for p in "${paths[@]}"; do
    read -r code secs < <(probe "$p")
    line+=" $p=$code(${secs%.*}s)"
    [ "$code" = 200 ] || ok=0
  done
  if [ "$ok" = 1 ]; then streak=$((streak + 1)); else streak=0; fi
  log "round:$line → healthy rounds in a row: $streak/$rounds"
  if [ "$streak" -ge "$rounds" ]; then
    log "OK: $site answered $rounds rounds in a row."
    echo "✅ $site healthy: $rounds rounds in a row, ${every}s apart ($(date -u +%H:%M) UTC)." >> "$summary"
    exit 0
  fi
  if [ $(( $(date +%s) - start )) -ge "$deadline" ]; then break; fi
  sleep "$every"
done

cat <<EOF | tee -a "$summary"
❌ $site is NOT healthy $((deadline / 60)) minutes after the deploy (last round:$line).

Do this now (DEPLOYMENT.md §3, "After every production deploy"):
1. Restart the Node.js app: hPanel → Websites → $(echo "$site" | sed 's#https\?://##') → Node.js → Restart,
   or from a Claude session with the Hostinger tools: hosting_nodejs_restart-application.
   A restart does not rebuild or change data.
2. Run this check again. If it still fails, read the build log and runtime log
   (hPanel → Node.js, or hosting_nodejs_build-logs / hosting_nodejs_runtime-logs)
   and roll back (DEPLOYMENT.md §9).
3. Record what happened (see docs/gokesari-audit/INCIDENT_2026-10-25_production_hang.md).
EOF
exit 1
