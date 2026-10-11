#!/usr/bin/env bash
# "Copy shops to production" guard (.github/workflows/copy-shops.yml), for the
# job that writes to PRODUCTION. Stops the run unless:
#   - it was started by hand (workflow_dispatch) on the main branch;
#   - a copy run carries the typed confirmation COPY SHOPS TO PRODUCTION;
#   - PROD_DATABASE_URL is visible to this job (a repository secret, or a
#     secret of the "production" environment the job runs in);
#   - when the PROD_DATABASE_HOST / PROD_DATABASE_NAME variables are set, the
#     URL's host and database equal them;
#   - the production host is not the test host, and the server answers.
# Prints only the host and database name, never the URL (it holds the password).
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }

[ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ] || fail "This runs only by hand (this run came from '${GITHUB_EVENT_NAME:-unknown}')."
[ "${GITHUB_REF:-}" = "refs/heads/main" ] || fail "This runs only from the main branch (this run is on ${GITHUB_REF:-unknown})."

case "${MODE:-}" in
  plan) ;;
  copy) [ "${CONFIRM:-}" = "COPY SHOPS TO PRODUCTION" ] || fail "To save to production, run again with confirm = COPY SHOPS TO PRODUCTION." ;;
  *) fail "Unknown mode '${MODE:-}'." ;;
esac

[ -n "${PROD_DATABASE_URL:-}" ] || fail "PROD_DATABASE_URL is not visible to this job. Add it under Settings → Secrets and variables → Actions → Repository secrets (or as a secret of the 'production' environment). A secret saved only in the 'test' environment cannot be seen here."

read -r host db < <(node -e '
  const u = new URL(process.argv[1]);
  console.log(u.hostname, decodeURIComponent(u.pathname.replace(/^\//, "")));
' "$PROD_DATABASE_URL")

if [ -n "${EXPECTED_HOST:-}" ]; then
  [ "$host" = "$EXPECTED_HOST" ] || fail "PROD_DATABASE_URL points at host '$host', not the production host '$EXPECTED_HOST'. Stopped."
fi
if [ -n "${EXPECTED_DB:-}" ]; then
  [ "$db" = "$EXPECTED_DB" ] || fail "PROD_DATABASE_URL points at database '$db', not the production database '$EXPECTED_DB'. Stopped."
fi
if [ -n "${TEST_HOST:-}" ] && [ "$host" = "$TEST_HOST" ]; then
  fail "PROD_DATABASE_URL points at the test database's host ($TEST_HOST). Stopped."
fi

live=$(psql "$PROD_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select current_database()")
[ "$live" = "$db" ] || fail "Connected database is '$live', expected '$db'. Stopped."

checked="checked against PROD_DATABASE_HOST / PROD_DATABASE_NAME"
[ -n "${EXPECTED_HOST:-}" ] && [ -n "${EXPECTED_DB:-}" ] || checked="**not checked**: set the PROD_DATABASE_HOST and PROD_DATABASE_NAME variables, and check this is gokesari.com's database before running copy"
echo "Target: database '$db' on $host (gokesari.com PRODUCTION) — mode: $MODE."
{
  echo "### Target — PRODUCTION"
  echo "Database \`$db\` on \`$host\` — gokesari.com · mode **$MODE** · $checked"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
