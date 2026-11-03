#!/usr/bin/env bash
# Guest QA tier for one staging-queue step (docs/staging-queue/README.md).
#   staging-queue-qa.sh <merged sha> <site> <pr number>
# Checks the merged commit out in its own worktree (the queue's own scripts
# keep running from the runner's temp folder), installs it and runs the
# production-safe guest tier (tests/qa/guest) against the site, retrying a
# failed check once so one slow page does not pause the queue. Results are
# collected and left in $QUEUE_RESULTS for the workflow to upload.
set -euo pipefail
sha="$1" site="$2" pr="$3"
host="${site#https://}"
dir="${RUNNER_TEMP:-/tmp}/qa-$pr"
results="${QUEUE_RESULTS:-${RUNNER_TEMP:-/tmp}/queue-results}"
repo_dir="${GITHUB_WORKSPACE:-$PWD}"

git -C "$repo_dir" fetch -q --depth=1 origin "$sha"
rm -rf "$dir"; git -C "$repo_dir" worktree prune
git -C "$repo_dir" worktree add -f --detach "$dir" "$sha" >/dev/null
cd "$dir"

npm ci --no-audit --no-fund --loglevel=error
npx playwright install --with-deps chromium >/dev/null

rc=0
E2E_BASE_URL="$site" npx playwright test -c playwright.qa.config.ts tests/qa/guest \
  --reporter=line --retries=1 || rc=$?
npx tsx scripts/qa/collect.ts --host "$host" --label "staging-queue-pr$pr" \
  --note "Staging queue, guest tier after merging #$pr (${sha:0:7})" >/dev/null 2>&1 || true

mkdir -p "$results/pr$pr"
cp -r test-results/qa "$results/pr$pr/" 2>/dev/null || true
cp -r docs/testing/qa-runs "$results/pr$pr/" 2>/dev/null || true
exit "$rc"
