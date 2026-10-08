#!/usr/bin/env bash
# Test-database workflow guard (.github/workflows/test-db.yml). Stops the run
# unless it is clearly aimed at the TEST database:
#   - changes only from the staging branch (so only merged migrations are applied);
#   - the TEST_DATABASE_URL secret must be set;
#   - its host and database must equal the TEST_DATABASE_HOST and
#     TEST_DATABASE_NAME repository variables — set by hand once, so a wrong
#     secret (e.g. production's URL pasted by mistake) is caught here.
# Prints only the host and database name, never the URL (it holds the password).
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }

# Changes only from staging; a read-only run (backup, verify) may start elsewhere
# (a scheduled run always starts on the default branch).
if [ "${READ_ONLY:-false}" != "true" ]; then
  [ "${GITHUB_REF:-}" = "refs/heads/staging" ] || fail "Changes run only from the staging branch (this run is on ${GITHUB_REF:-unknown})."
fi
[ -n "${TEST_DATABASE_URL:-}" ] || fail "Secret TEST_DATABASE_URL is not set (Settings → Secrets and variables → Actions → Secrets)."
[ -n "${EXPECTED_HOST:-}" ] || fail "Variable TEST_DATABASE_HOST is not set (Settings → Secrets and variables → Actions → Variables)."
[ -n "${EXPECTED_DB:-}" ] || fail "Variable TEST_DATABASE_NAME is not set (Settings → Secrets and variables → Actions → Variables)."

read -r host db < <(node -e '
  const u = new URL(process.argv[1]);
  console.log(u.hostname, decodeURIComponent(u.pathname.replace(/^\//, "")));
' "$TEST_DATABASE_URL")

[ "$host" = "$EXPECTED_HOST" ] || fail "TEST_DATABASE_URL points at host '$host', not the test host '$EXPECTED_HOST'. Stopped."
[ "$db" = "$EXPECTED_DB" ] || fail "TEST_DATABASE_URL points at database '$db', not the test database '$EXPECTED_DB'. Stopped."

# The server must answer, and must be the database we think it is.
live=$(psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select current_database()")
[ "$live" = "$EXPECTED_DB" ] || fail "Connected database is '$live', expected '$EXPECTED_DB'. Stopped."

echo "Target: database '$db' on $host (test.gokesari.com)."
{
  echo "### Target"
  echo "Database \`$db\` on \`$host\` — test.gokesari.com"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
