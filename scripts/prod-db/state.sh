#!/usr/bin/env bash
# Production-database workflow: reports which migrations production has and
# which of the release's it still lacks, to the job summary. Read-only.
# With --expect-latest it fails unless production has the release's newest.
# Usage: state.sh <path to the release's drizzle/meta/_journal.json> [--expect-latest]
set -euo pipefail

journal=${1:?usage: state.sh <journal.json> [--expect-latest]}

recorded=$(psql "$PROD_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "select case when to_regclass('drizzle.__drizzle_migrations') is null then '0 0'
  else (select count(*) || ' ' || coalesce(max(created_at), 0) from drizzle.__drizzle_migrations) end")
count=${recorded%% *}
newest=${recorded#* }

# Release migrations newer than production's newest, oldest first.
pending=$(node -e '
  const j = require(require("path").resolve(process.argv[1]));
  const newest = BigInt(process.argv[2]);
  for (const e of j.entries) if (BigInt(e.when) > newest) console.log(e.tag);
' "$journal" "$newest")
release=$(node -e 'const e = require(require("path").resolve(process.argv[1])).entries.at(-1); console.log(e.when + " " + e.tag)' "$journal")
release_when=${release%% *}
release_tag=${release#* }

{
  echo "### Production database state"
  echo "| Check | Value |"
  echo "|---|---|"
  echo "| Migrations recorded | $count |"
  echo "| Newest applied | \`$newest\` |"
  echo "| Newest in the release (${SOURCE:-release}) | \`$release_when\` ($release_tag) |"
  if [ -n "$pending" ]; then
    echo "| Not yet on production | $(echo "$pending" | paste -sd ' ' - | sed 's/ /, /g') |"
  else
    echo "| Not yet on production | none |"
  fi
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "${2:-}" = "--expect-latest" ] && [ "$newest" != "$release_when" ]; then
  echo "::error::Production is on migration $newest; the release's newest is $release_when ($release_tag)."
  exit 1
fi
