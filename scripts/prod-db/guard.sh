#!/usr/bin/env bash
# Production-database workflow guard (.github/workflows/prod-db.yml). Stops the
# run unless it is clearly a deliberate run against the PRODUCTION database:
#   - started by hand (workflow_dispatch) on the main branch;
#   - a migrate run carries the typed confirmation MIGRATE PRODUCTION;
#   - the PROD_DATABASE_URL secret is set, and its host and database equal the
#     PROD_DATABASE_HOST and PROD_DATABASE_NAME repository variables (set by
#     hand once, so a wrong secret is caught here);
#   - the production host is not the test host;
#   - the live server says it is that database.
# Prints only the host and database name, never the URL (it holds the password).
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }

[ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ] || fail "Production runs only by hand (this run came from '${GITHUB_EVENT_NAME:-unknown}')."
[ "${GITHUB_REF:-}" = "refs/heads/main" ] || fail "Production runs only from the main branch (this run is on ${GITHUB_REF:-unknown})."

case "${ACTION:-}" in
  verify) ;;
  migrate)
    [ "${CONFIRM:-}" = "MIGRATE PRODUCTION" ] || fail "To migrate production, run again with confirm = MIGRATE PRODUCTION." ;;
  *) fail "Unknown action '${ACTION:-}'." ;;
esac

where="Settings → Secrets and variables → Actions"
[ -n "${PROD_DATABASE_URL:-}" ] || fail "Secret PROD_DATABASE_URL is not set ($where → Secrets)."
[ -n "${EXPECTED_HOST:-}" ] || fail "Variable PROD_DATABASE_HOST is not set ($where → Variables)."
[ -n "${EXPECTED_DB:-}" ] || fail "Variable PROD_DATABASE_NAME is not set ($where → Variables)."

read -r host db < <(node -e '
  const u = new URL(process.argv[1]);
  console.log(u.hostname, decodeURIComponent(u.pathname.replace(/^\//, "")));
' "$PROD_DATABASE_URL")

[ "$host" = "$EXPECTED_HOST" ] || fail "PROD_DATABASE_URL points at host '$host', not the production host '$EXPECTED_HOST'. Stopped."
[ "$db" = "$EXPECTED_DB" ] || fail "PROD_DATABASE_URL points at database '$db', not the production database '$EXPECTED_DB'. Stopped."
if [ -n "${TEST_HOST:-}" ] && [ "$host" = "$TEST_HOST" ]; then
  fail "PROD_DATABASE_HOST is the test database's host ($TEST_HOST). Production and test must be different databases. Stopped."
fi

# The server must answer, and must be the database we think it is.
live=$(psql "$PROD_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select current_database()")
[ "$live" = "$EXPECTED_DB" ] || fail "Connected database is '$live', expected '$EXPECTED_DB'. Stopped."

echo "Target: database '$db' on $host (gokesari.com PRODUCTION) — action: $ACTION."
{
  echo "### Target — PRODUCTION"
  echo "Database \`$db\` on \`$host\` — gokesari.com · action **$ACTION**"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
