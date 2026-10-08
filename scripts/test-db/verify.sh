#!/usr/bin/env bash
# Test-database workflow: checks the database is on the newest migration in
# drizzle/meta/_journal.json and that the event layer (0058) is in place, then
# writes a report to the job summary. Exits non-zero when it is behind.
# Usage: verify.sh [--expect-latest]
set -euo pipefail

psqlq() { psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tA "$@"; }

expected=$(node -e 'const j=require("./drizzle/meta/_journal.json"); const e=j.entries.at(-1); console.log(e.when + " " + e.tag)')
expected_when=${expected%% *}
expected_tag=${expected#* }

recorded=$(psqlq -c "select case when to_regclass('drizzle.__drizzle_migrations') is null then '0 0'
  else (select count(*) || ' ' || coalesce(max(created_at), 0) from drizzle.__drizzle_migrations) end")
count=${recorded%% *}
newest=${recorded#* }

event_tables=$(psqlq -c "select count(*) from (values ('domain_events'), ('dispute_comments'), ('dispute_attachments')) t(n)
  where to_regclass('public.' || n) is not null")

{
  echo "### Database state"
  echo "| Check | Value |"
  echo "|---|---|"
  echo "| Migrations recorded | $count |"
  echo "| Newest applied | \`$newest\` |"
  echo "| Newest in this branch | \`$expected_when\` ($expected_tag) |"
  echo "| Event-layer tables (of 3) | $event_tables |"
  echo
  echo "### Business rules on this database"
  echo '```'
  psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "select key, value from platform_settings
    where key in ('shopAcceptance','dispatch','notifications','disputes','sellerVerification','tracking') order by key"
  echo '```'
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "${1:-}" = "--expect-latest" ] && [ "$newest" != "$expected_when" ]; then
  echo "::error::The test database is on migration $newest; this branch's newest is $expected_when ($expected_tag)."
  exit 1
fi
