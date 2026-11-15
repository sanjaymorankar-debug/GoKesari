#!/usr/bin/env bash
# Runs k6 against TEST while watching production (gokesari.com) every 15 s.
# test.gokesari.com and gokesari.com may share one Hostinger account, so a
# heavy test on TEST can slow production: three slow (> 8 s) or failed
# production checks in a row stop k6 straight away.
#
#   scripts/run-guarded.sh <name> <k6 args...>
#   scripts/run-guarded.sh test-load -e PROFILE=load -e PEAK=50 scripts/load.js
set -u
cd "$(dirname "$0")/.."
NAME=$1; shift
RAW=reports/raw
WATCH="$RAW/$NAME-prod-watch.csv"
echo "time,status,seconds" > "$WATCH"

./bin/k6 run --no-usage-report --summary-export "$RAW/$NAME.json" --out "csv=$RAW/$NAME-metrics.csv.gz" "$@" > "$RAW/$NAME.txt" 2>&1 &
K6=$!

bad=0
while kill -0 "$K6" 2>/dev/null; do
  line=$(curl -s -o /dev/null -m 15 -w "%{http_code},%{time_total}" https://gokesari.com/ || echo "000,15")
  echo "$(date +%H:%M:%S),$line" >> "$WATCH"
  code=${line%%,*}; secs=${line##*,}
  if [ "$code" != "200" ] || awk "BEGIN{exit !($secs > 8)}"; then bad=$((bad + 1)); else bad=0; fi
  if [ "$bad" -ge 3 ]; then
    echo "$(date +%H:%M:%S) production degraded (3 checks in a row) - stopping k6" | tee -a "$WATCH"
    kill -INT "$K6"; sleep 5; kill "$K6" 2>/dev/null
    break
  fi
  sleep 15
done
wait "$K6"; code=$?
echo "k6 exit $code" >> "$RAW/$NAME.txt"
exit $code
