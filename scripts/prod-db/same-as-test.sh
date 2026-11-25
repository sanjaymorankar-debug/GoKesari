#!/usr/bin/env bash
# Production-database workflow: every migration production is about to receive
# must be exactly the one the TEST database already ran — the same SQL, byte for
# byte. Drizzle records each applied migration's SHA-256 (of the .sql file) in
# drizzle.__drizzle_migrations.hash; this compares the release's pending files
# with the hashes on the test database. tested-on-test.sh only compares the
# newest timestamp; this also catches a migration edited after staging ran it.
# Read-only on both databases. Runs after guard.sh and tested-on-test.sh, which
# check that the two URLs are production and the test database.
# Usage: same-as-test.sh <path to the release's drizzle folder>
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }

dir=${1:?usage: same-as-test.sh <drizzle folder>}
[ -n "${PROD_DATABASE_URL:-}" ] || fail "PROD_DATABASE_URL is not set. Stopped."
[ -n "${TEST_DATABASE_URL:-}" ] || fail "TEST_DATABASE_URL is not set. Stopped."

newest=$(psql "$PROD_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select case when to_regclass('drizzle.__drizzle_migrations') is null then 0
  else (select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations) end")
test_hashes=$(psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select hash from drizzle.__drizzle_migrations")

# Pending tags (newer than production's newest), oldest first.
pending=$(node -e '
  const j = require(require("path").resolve(process.argv[1], "meta/_journal.json"));
  const newest = BigInt(process.argv[2]);
  for (const e of j.entries) if (BigInt(e.when) > newest) console.log(e.tag);
' "$dir" "$newest")

bad=""
checked=0
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  file="$dir/$tag.sql"
  [ -f "$file" ] || fail "Migration file $tag.sql is listed in the journal but missing. Stopped."
  hash=$(sha256sum "$file" | cut -d' ' -f1)
  checked=$((checked + 1))
  if ! grep -qxF "$hash" <<< "$test_hashes"; then
    bad="${bad:+$bad, }$tag"
  fi
done <<< "$pending"

{
  echo "### Same as the test database"
  echo "Pending migrations checked: $checked${bad:+ · different from test: **$bad**}"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

[ -z "$bad" ] || fail "These migrations are not byte-for-byte what the test database ran: $bad. Let the staging queue migrate and test them first. Stopped."
