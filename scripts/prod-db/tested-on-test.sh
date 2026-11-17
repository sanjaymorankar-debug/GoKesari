#!/usr/bin/env bash
# Production-database workflow: refuses to migrate production with anything the
# TEST database does not already have. Every migration in the release's journal
# must already be applied on test (migrations are applied in order, so comparing
# the newest is enough). Read-only on the test database.
# Usage: tested-on-test.sh <path to the release's drizzle/meta/_journal.json>
#
# TEST_DATABASE_URL must be the test database: its host and port equal
# TEST_HOST (TEST_DATABASE_HOST, "host" or "host:port"; no port means 5432), and
# its host and port are not production's (EXPECTED_HOST, PROD_DATABASE_HOST). On
# GoKesari's own database server both databases share one machine and differ by
# port, so the host name alone is not enough.
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }

# "host" or "host:port" → "host port" (5432 when no port is given).
host_port() {
  local h=$1 p=5432
  case "$h" in *:*) p=${h##*:}; h=${h%:*} ;; esac
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  [ -n "$h" ] || return 1
  echo "$h $p"
}

# Host, port (5432 when the URL gives none) and database of a postgresql:// URL.
# Host or port given as ?host= / ?hostaddr= / ?port= is refused: psql and postgres.js
# read those differently, so the check could not tell which server would answer.
url_target() {
  node -e '
    try {
      const u = new URL(process.argv[1]);
      if (["host", "hostaddr", "port"].some((k) => u.searchParams.has(k))) process.exit(2);
      console.log(u.hostname, u.port || "5432", decodeURIComponent(u.pathname.replace(/^\//, "")));
    } catch { process.exit(1); }
  ' "$1" 2>/dev/null
}

journal=${1:?usage: tested-on-test.sh <journal.json>}
[ -n "${TEST_DATABASE_URL:-}" ] || fail "Secret TEST_DATABASE_URL is not set, so the release cannot be checked against the test database. Stopped."

# The URL must really be the test database (same check as the test workflow's guard).
target=$(url_target "$TEST_DATABASE_URL") || fail "TEST_DATABASE_URL is not a URL this check can read: postgresql://user:password@host[:port]/database, with no ?host=, ?hostaddr= or ?port=. Stopped."
read -r host port _db <<< "$target"
if [ -n "${TEST_HOST:-}" ]; then
  expected=$(host_port "$TEST_HOST") || fail "Variable TEST_DATABASE_HOST must be a host name or host:port (it is '$TEST_HOST')."
  read -r test_host test_port <<< "$expected"
  [ "$host" = "$test_host" ] || fail "TEST_DATABASE_URL points at '$host', not the test host '$test_host'. Stopped."
  [ "$port" = "$test_port" ] || fail "TEST_DATABASE_URL uses port $port, not the test database's port $test_port (from TEST_DATABASE_HOST '$TEST_HOST'). Stopped."
fi
# Production compared with itself would prove nothing: the same host and port is refused.
if [ -n "${EXPECTED_HOST:-}" ]; then
  prod=$(host_port "$EXPECTED_HOST") || fail "Variable PROD_DATABASE_HOST must be a host name or host:port (it is '$EXPECTED_HOST')."
  read -r prod_host prod_port <<< "$prod"
  if [ "$host" = "$prod_host" ] && [ "$port" = "$prod_port" ]; then
    fail "TEST_DATABASE_URL points at the production database server ($prod_host:$prod_port), not the test database. Stopped."
  fi
fi

release=$(node -e 'const e = require(require("path").resolve(process.argv[1])).entries.at(-1); console.log(e.when + " " + e.tag)' "$journal")
release_when=${release%% *}
release_tag=${release#* }

on_test=$(psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select case when to_regclass('drizzle.__drizzle_migrations') is null then 0
  else (select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations) end")

if [ "$on_test" -lt "$release_when" ]; then
  fail "The release's newest migration ($release_tag) is not on the test database yet (test is on $on_test). Migrate and check test first. Stopped."
fi

echo "Tested on test first: the test database has $release_tag (newest there: $on_test)." | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
