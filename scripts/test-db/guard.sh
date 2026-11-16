#!/usr/bin/env bash
# Test-database workflow guard (.github/workflows/test-db.yml). Stops the run
# unless it is clearly aimed at the TEST database:
#   - changes only from the staging branch (so only merged migrations are applied);
#   - the TEST_DATABASE_URL secret must be set;
#   - its host, port and database must equal the TEST_DATABASE_HOST and
#     TEST_DATABASE_NAME repository variables — set by hand once, so a wrong
#     secret (e.g. production's URL pasted by mistake) is caught here.
#     TEST_DATABASE_HOST is "host" or "host:port"; no port means 5432, as in a
#     URL without one. On GoKesari's own database server both databases share
#     one machine and differ by port (production 5432, staging 5433), so there
#     it must be written host:port (db-test.gokesari.com:5433).
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

# Changes only from staging; a read-only run (backup, verify) may start elsewhere
# (a scheduled run always starts on the default branch).
if [ "${READ_ONLY:-false}" != "true" ]; then
  [ "${GITHUB_REF:-}" = "refs/heads/staging" ] || fail "Changes run only from the staging branch (this run is on ${GITHUB_REF:-unknown})."
fi
[ -n "${TEST_DATABASE_URL:-}" ] || fail "Secret TEST_DATABASE_URL is not set (Settings → Secrets and variables → Actions → Secrets)."
[ -n "${EXPECTED_HOST:-}" ] || fail "Variable TEST_DATABASE_HOST is not set (Settings → Secrets and variables → Actions → Variables)."
[ -n "${EXPECTED_DB:-}" ] || fail "Variable TEST_DATABASE_NAME is not set (Settings → Secrets and variables → Actions → Variables)."

expected=$(host_port "$EXPECTED_HOST") || fail "Variable TEST_DATABASE_HOST must be a host name or host:port (it is '$EXPECTED_HOST')."
read -r exp_host exp_port <<< "$expected"
target=$(url_target "$TEST_DATABASE_URL") || fail "TEST_DATABASE_URL is not a URL the guard can read: postgresql://user:password@host[:port]/database, with no ?host=, ?hostaddr= or ?port=. Stopped."
read -r host port db <<< "$target"

[ "$host" = "$exp_host" ] || fail "TEST_DATABASE_URL points at host '$host', not the test host '$exp_host'. Stopped."
[ "$port" = "$exp_port" ] || fail "TEST_DATABASE_URL uses port $port, not the test database's port $exp_port (from TEST_DATABASE_HOST '$EXPECTED_HOST'; write it host:port when the port is not 5432). Stopped."
[ "$db" = "$EXPECTED_DB" ] || fail "TEST_DATABASE_URL points at database '$db', not the test database '$EXPECTED_DB'. Stopped."

# The server must answer, and must be the database we think it is.
live=$(psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select current_database()")
[ "$live" = "$EXPECTED_DB" ] || fail "Connected database is '$live', expected '$EXPECTED_DB'. Stopped."

echo "Target: database '$db' on $host:$port (test.gokesari.com)."
{
  echo "### Target"
  echo "Database \`$db\` on \`$host:$port\` — test.gokesari.com"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
