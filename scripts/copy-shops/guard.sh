#!/usr/bin/env bash
# "Copy shops to production" guard (.github/workflows/copy-shops.yml), for the
# job that writes to PRODUCTION. Stops the run unless:
#   - it was started by hand (workflow_dispatch) on the main branch;
#   - a copy run carries the typed confirmation COPY SHOPS TO PRODUCTION;
#   - PROD_DATABASE_URL is visible to this job (a repository secret, or a
#     secret of the "production" environment the job runs in);
#   - when the PROD_DATABASE_HOST / PROD_DATABASE_NAME variables are set, the
#     URL's host, port and database equal them. PROD_DATABASE_HOST is "host" or
#     "host:port"; no port means 5432, as in a URL without one;
#   - PROD_DATABASE_HOST is set whenever the URL is not a Neon host: the job
#     reaches GoKesari's own database server only over WireGuard, and the
#     workflow decides that from this variable;
#   - the production host and port are not the test database's (TEST_HOST: the
#     test environment's TEST_DATABASE_HOST, "host" or "host:port"). On
#     GoKesari's own database server both databases share one machine and
#     differ by port (production 5432, staging 5433);
#   - the server answers, and is that database.
# A URL that gives the host or port as ?host=, ?hostaddr= or ?port= is refused.
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

[ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ] || fail "This runs only by hand (this run came from '${GITHUB_EVENT_NAME:-unknown}')."
[ "${GITHUB_REF:-}" = "refs/heads/main" ] || fail "This runs only from the main branch (this run is on ${GITHUB_REF:-unknown})."

case "${MODE:-}" in
  plan) ;;
  copy) [ "${CONFIRM:-}" = "COPY SHOPS TO PRODUCTION" ] || fail "To save to production, run again with confirm = COPY SHOPS TO PRODUCTION." ;;
  *) fail "Unknown mode '${MODE:-}'." ;;
esac

[ -n "${PROD_DATABASE_URL:-}" ] || fail "PROD_DATABASE_URL is not visible to this job. Add it under Settings → Secrets and variables → Actions → Repository secrets (or as a secret of the 'production' environment). A secret saved only in the 'test' environment cannot be seen here."

target=$(url_target "$PROD_DATABASE_URL") || fail "PROD_DATABASE_URL is not a URL the guard can read: postgresql://user:password@host[:port]/database, with no ?host=, ?hostaddr= or ?port=. Stopped."
read -r host port db <<< "$target"

if [ -n "${EXPECTED_HOST:-}" ]; then
  expected=$(host_port "$EXPECTED_HOST") || fail "Variable PROD_DATABASE_HOST must be a host name or host:port (it is '$EXPECTED_HOST')."
  read -r exp_host exp_port <<< "$expected"
  [ "$host" = "$exp_host" ] || fail "PROD_DATABASE_URL points at host '$host', not the production host '$exp_host'. Stopped."
  [ "$port" = "$exp_port" ] || fail "PROD_DATABASE_URL uses port $port, not the production database's port $exp_port (from PROD_DATABASE_HOST '$EXPECTED_HOST'; write it host:port when the port is not 5432). Stopped."
else
  case "$host" in
    *.neon.tech) ;;
    *) fail "Variable PROD_DATABASE_HOST is not set, and PROD_DATABASE_URL is not a Neon host ('$host'). GoKesari's own database server is reached over WireGuard, which this workflow sets up from PROD_DATABASE_HOST: set it (Settings → Environments → production → Variables). Stopped." ;;
  esac
fi
if [ -n "${EXPECTED_DB:-}" ]; then
  [ "$db" = "$EXPECTED_DB" ] || fail "PROD_DATABASE_URL points at database '$db', not the production database '$EXPECTED_DB'. Stopped."
fi
# The same host and port is the same database server, whatever the database name: refused.
if [ -n "${TEST_HOST:-}" ]; then
  test_target=$(host_port "$TEST_HOST") || fail "The test database's host (TEST_DATABASE_HOST, from the export job) must be a host name or host:port (it is '$TEST_HOST')."
  read -r test_host test_port <<< "$test_target"
  if [ "$host" = "$test_host" ] && [ "$port" = "$test_port" ]; then
    fail "PROD_DATABASE_URL points at the test database's host and port ($test_host:$test_port). Stopped."
  fi
fi

live=$(psql "$PROD_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select current_database()")
[ "$live" = "$db" ] || fail "Connected database is '$live', expected '$db'. Stopped."

checked="checked against PROD_DATABASE_HOST / PROD_DATABASE_NAME"
[ -n "${EXPECTED_HOST:-}" ] && [ -n "${EXPECTED_DB:-}" ] || checked="**not checked**: set the PROD_DATABASE_HOST and PROD_DATABASE_NAME variables, and check this is gokesari.com's database before running copy"
echo "Target: database '$db' on $host:$port (gokesari.com PRODUCTION) — mode: $MODE."
{
  echo "### Target — PRODUCTION"
  echo "Database \`$db\` on \`$host:$port\` — gokesari.com · mode **$MODE** · $checked"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
