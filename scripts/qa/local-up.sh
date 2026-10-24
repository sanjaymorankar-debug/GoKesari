#!/usr/bin/env bash
# Brings up a local GoKesari for the QA suite: a PostgreSQL database with the
# migrations and reference data, the local mail catcher, a production server
# (`next start`) on PORT, and the QA test data (scripts/qa/seed-local.ts).
#
#   bash scripts/qa/local-up.sh [PORT=3000] [DB=gk_qa]
#
# Needs a built app (`npx next build --webpack`) and a local PostgreSQL that
# user postgres/postgres can reach on localhost:5432. Prints the environment
# to source before running the suite. Local use only — never a site's database.
set -euo pipefail

PORT="${1:-3000}"
DB="${2:-gk_qa}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="test-results/qa"
mkdir -p "$OUT"
ENV_FILE="$OUT/local-$PORT.env"

export PGPASSWORD="${PGPASSWORD:-postgres}"
PGURL="postgresql://postgres:${PGPASSWORD}@localhost:5432"

if ! psql "$PGURL/postgres" -tAc "select 1" >/dev/null 2>&1; then
  (service postgresql start || sudo service postgresql start) >/dev/null 2>&1 || true
  sleep 3
fi

cat > "$ENV_FILE" <<EOF
export DATABASE_URL=$PGURL/$DB
export E2E_DATABASE_URL=$PGURL/$DB
export E2E_BASE_URL=http://localhost:$PORT
export AUTH_SECRET=qa-local-secret-not-used-anywhere-else
export AUTH_URL=http://localhost:$PORT
export AUTH_TRUST_HOST=true
export CRON_SECRET=qa-local-cron-secret
export APP_TIMEZONE=Asia/Kolkata
export AUTH_EMAIL_FROM=qa@gokesari.local
export AUTH_EMAIL_SERVER=smtp://localhost:2525
EOF
# The cloud container's browser build differs from Playwright's default; elsewhere Playwright finds its own.
if [ -z "${CHROMIUM_PATH:-}" ] && [ -x /opt/pw-browsers/chromium ]; then echo "export CHROMIUM_PATH=/opt/pw-browsers/chromium" >> "$ENV_FILE"; fi
[ -n "${CHROMIUM_PATH:-}" ] && echo "export CHROMIUM_PATH=$CHROMIUM_PATH" >> "$ENV_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"

if [ "$(psql "$PGURL/postgres" -tAc "select 1 from pg_database where datname = '$DB'")" != "1" ]; then
  psql "$PGURL/postgres" -qc "create database $DB" >/dev/null
  npm run -s db:migrate >/dev/null
  npm run -s db:seed >/dev/null
  echo "local-up: database $DB created, migrated and seeded"
fi

if ! (echo > /dev/tcp/127.0.0.1/2525) 2>/dev/null; then
  nohup node scripts/qa/smtp-sink.mjs 2525 "$OUT/mail" > "$OUT/smtp-sink.log" 2>&1 &
  sleep 1
fi

if ! curl -s -o /dev/null "http://localhost:$PORT/"; then
  [ -d .next ] || { echo "local-up: build the app first: npx next build --webpack"; exit 1; }
  nohup npx next start -p "$PORT" > "$OUT/server-$PORT.log" 2>&1 &
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 1; done
fi

npx tsx scripts/qa/seed-local.ts --base-url "http://localhost:$PORT"
echo "local-up: ready on http://localhost:$PORT — source $ENV_FILE"
