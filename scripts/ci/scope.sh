#!/usr/bin/env bash
# Decides which CI jobs a push or pull request needs (.github/workflows/ci.yml),
# so GitHub Actions minutes go on changes that can break something.
#
# Writes app=yes|no and mobile=yes|no to $GITHUB_OUTPUT (stdout when unset).
# Whenever it cannot tell, it answers yes: a wasted run is cheaper than a
# missed one.
#
#   no, no   the same tree already passed CI on a push (a release merge into
#            main of a staging commit CI passed, or the release PR itself),
#            or only documentation changed
#   app      anything outside mobile/ and the documentation
#   mobile   anything under mobile/
#
# Documentation is docs/** and *.md, except docs/product-master/, which
# tests/unit/pmd-docs.test.ts and tests/integration/pmd-feed.test.ts read.
# Changes to this script or ci.yml run both jobs.
#
# Needs: a checkout with the commit's parents (fetch-depth: 2), and GH_TOKEN
# with actions: read for the "already passed" check. Inputs from the workflow:
# EVENT (github.event_name) and BEFORE (github.event.before, pushes only).
set -uo pipefail

emit() {
  echo "CI scope: app=$1 mobile=$2 ($3)"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    { echo "app=$1"; echo "mobile=$2"; } >> "$GITHUB_OUTPUT"
  fi
  exit 0
}

EVENT="${EVENT:-}"
BEFORE="${BEFORE:-}"
ZERO=0000000000000000000000000000000000000000

case "$EVENT" in
  push|pull_request) ;;
  *) emit yes yes "event '$EVENT': run everything" ;;
esac

# 1. Same tree as a commit CI already passed on a push. A pull request's merge
#    ref and a merge commit both have the incoming commit as second parent.
if second=$(git rev-parse --verify --quiet HEAD^2); then
  if [ "$(git rev-parse "HEAD^{tree}")" = "$(git rev-parse "$second^{tree}")" ]; then
    passed=$(gh run list --repo "${GITHUB_REPOSITORY:-}" --workflow ci.yml --commit "$second" \
      --event push --status success --limit 1 --json databaseId --jq 'length' 2>/dev/null || echo 0)
    if [ "$passed" = "1" ]; then
      emit no no "same files as ${second:0:7}, which already passed CI"
    fi
  fi
fi

# 2. What changed.
if [ "$EVENT" = "pull_request" ]; then
  base=HEAD^1 # the merge ref's first parent is the base branch
elif [ -n "$BEFORE" ] && [ "$BEFORE" != "$ZERO" ] \
  && { git cat-file -e "$BEFORE^{commit}" 2>/dev/null \
       || git fetch --no-tags --quiet --depth=1 origin "$BEFORE" 2>/dev/null; }; then
  base=$BEFORE
else
  emit yes yes "push with no usable previous commit: run everything"
fi

if ! files=$(git diff --name-only "$base" HEAD); then
  emit yes yes "could not list the changed files: run everything"
fi
if [ -z "$files" ]; then
  emit yes yes "no file changes found: run everything"
fi

app=no
mobile=no
while IFS= read -r f; do
  case "$f" in
    .github/workflows/ci.yml|scripts/ci/*) emit yes yes "CI itself changed ($f)" ;;
    docs/product-master/*) app=yes ;;
    docs/*|*.md) ;;
    mobile/*) mobile=yes ;;
    *) app=yes ;;
  esac
done <<< "$files"

emit "$app" "$mobile" "$(wc -l <<< "$files" | tr -d ' ') changed files"
