#!/usr/bin/env bash
# Production-database workflow: refuses to migrate production with anything the
# TEST database does not already have. Every migration in the release's journal
# must already be applied on test (migrations are applied in order, so comparing
# the newest is enough). Read-only on the test database.
# Usage: tested-on-test.sh <path to the release's drizzle/meta/_journal.json>
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }

journal=${1:?usage: tested-on-test.sh <journal.json>}
[ -n "${TEST_DATABASE_URL:-}" ] || fail "Secret TEST_DATABASE_URL is not set, so the release cannot be checked against the test database. Stopped."

# The URL must really be the test database (same check as the test workflow's guard).
host=$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$TEST_DATABASE_URL")
if [ -n "${TEST_HOST:-}" ] && [ "$host" != "$TEST_HOST" ]; then
  fail "TEST_DATABASE_URL points at '$host', not the test host '$TEST_HOST'. Stopped."
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
