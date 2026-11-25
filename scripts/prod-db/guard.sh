#!/usr/bin/env bash
# Production-database workflow guard (.github/workflows/prod-db.yml). Stops the
# run unless it is clearly a deliberate run against the PRODUCTION database:
#   - main's copy of the workflow: by hand (workflow_dispatch), or automatically
#     for a pull request into main (pull_request_target) or a push to main;
#   - a migrate run by hand carries the typed confirmation MIGRATE PRODUCTION
#     (automatic runs only migrate what the test database already has, checked
#     by tested-on-test.sh and same-as-test.sh);
#   - the PROD_DATABASE_URL secret is set, and its host, port and database equal
#     the PROD_DATABASE_HOST and PROD_DATABASE_NAME repository variables (set by
#     hand once, so a wrong secret is caught here);
#   - the production host and port are not the test database's (TEST_DATABASE_HOST);
#   - the live server says it is that database.
# PROD_DATABASE_HOST and TEST_DATABASE_HOST are "host" or "host:port"; no port
# means 5432, as in a URL without one. On GoKesari's own database server both
# databases share one machine and differ by port (production 5432, staging 5433).
# Prints only the host, port and database name, never the URL (it holds the password).
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
# read those differently, so the guard could not tell where the run would go.
url_target() {
  node -e '
    try {
      const u = new URL(process.argv[1]);
      if (["host", "hostaddr", "port"].some((k) => u.searchParams.has(k))) process.exit(2);
      console.log(u.hostname, u.port || "5432", decodeURIComponent(u.pathname.replace(/^\//, "")));
    } catch { process.exit(1); }
  ' "$1" 2>/dev/null
}

case "${GITHUB_EVENT_NAME:-}" in
  workflow_dispatch) by_hand=yes ;;
  pull_request_target|push) by_hand=no ;;
  *) fail "Production runs by hand, or for a pull request into / push to main (this run came from '${GITHUB_EVENT_NAME:-unknown}')." ;;
esac
[ "${GITHUB_REF:-}" = "refs/heads/main" ] || fail "Production runs only from the main branch (this run is on ${GITHUB_REF:-unknown})."

case "${ACTION:-}" in
  verify) ;;
  migrate)
    if [ "$by_hand" = yes ]; then
      [ "${CONFIRM:-}" = "MIGRATE PRODUCTION" ] || fail "To migrate production, run again with confirm = MIGRATE PRODUCTION."
    fi ;;
  *) fail "Unknown action '${ACTION:-}'." ;;
esac

where="Settings → Environments → production (or Secrets and variables → Actions)"
[ -n "${PROD_DATABASE_URL:-}" ] || fail "Secret PROD_DATABASE_URL is not set ($where → Secrets)."
[ -n "${EXPECTED_HOST:-}" ] || fail "Variable PROD_DATABASE_HOST is not set ($where → Variables)."
[ -n "${EXPECTED_DB:-}" ] || fail "Variable PROD_DATABASE_NAME is not set ($where → Variables)."

expected=$(host_port "$EXPECTED_HOST") || fail "Variable PROD_DATABASE_HOST must be a host name or host:port (it is '$EXPECTED_HOST')."
read -r exp_host exp_port <<< "$expected"
target=$(url_target "$PROD_DATABASE_URL") || fail "PROD_DATABASE_URL is not a URL the guard can read: postgresql://user:password@host[:port]/database, with no ?host=, ?hostaddr= or ?port=. Stopped."
read -r host port db <<< "$target"

[ "$host" = "$exp_host" ] || fail "PROD_DATABASE_URL points at host '$host', not the production host '$exp_host'. Stopped."
[ "$port" = "$exp_port" ] || fail "PROD_DATABASE_URL uses port $port, not the production database's port $exp_port (from PROD_DATABASE_HOST '$EXPECTED_HOST'; write it host:port when the port is not 5432). Stopped."
[ "$db" = "$EXPECTED_DB" ] || fail "PROD_DATABASE_URL points at database '$db', not the production database '$EXPECTED_DB'. Stopped."
# The same host and port is the same database server, whatever the database name: refused.
if [ -n "${TEST_HOST:-}" ]; then
  test_target=$(host_port "$TEST_HOST") || fail "Variable TEST_DATABASE_HOST must be a host name or host:port (it is '$TEST_HOST')."
  read -r test_host test_port <<< "$test_target"
  if [ "$host" = "$test_host" ] && [ "$port" = "$test_port" ]; then
    fail "PROD_DATABASE_HOST is the test database's host and port ($test_host:$test_port). Production and test must be different databases. Stopped."
  fi
fi

# The server must answer, and must be the database we think it is.
live=$(psql "$PROD_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select current_database()")
[ "$live" = "$EXPECTED_DB" ] || fail "Connected database is '$live', expected '$EXPECTED_DB'. Stopped."

echo "Target: database '$db' on $host:$port (gokesari.com PRODUCTION) — action: $ACTION."
{
  echo "### Target — PRODUCTION"
  echo "Database \`$db\` on \`$host:$port\` — gokesari.com · action **$ACTION**"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
