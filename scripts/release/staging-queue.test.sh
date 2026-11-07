#!/usr/bin/env bash
# Tests for the staging queue's error handling (staging-queue.sh), against a
# fake `gh`: nothing goes to GitHub. Each case gives the fake GitHub its
# answers, runs the queue, and checks its exit status, the calls it made and
# what it printed. CI runs this in the "scope" job (.github/workflows/ci.yml).
#
#   bash scripts/release/staging-queue.test.sh
#
# Needs bash 4+ and jq, as the queue itself does (macOS: brew install bash jq).
set -uo pipefail

if [ "${BASH_VERSINFO[0]}" -lt 4 ] || ! command -v jq >/dev/null; then
  echo "staging-queue.test.sh needs bash 4+ and jq (macOS: brew install bash jq)" >&2; exit 2
fi

QUEUE="$(cd "$(dirname "$0")" && pwd)/staging-queue.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# ---------------------------------------------------------------- fake gh
# Answers from $FAKE_ROUTES: lines "METHOD path-glob HTTP-status body", first
# match wins; anything else is a 404. Logs each call to $FAKE_CALLS as
# "METHOD path field…". On an error it behaves like gh: the body on stdout,
# "gh: <message> (HTTP <status>)" on stderr, exit 1.
cat > "$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = api ] || { echo "fake gh: only 'gh api' is supported" >&2; exit 64; }
shift
method="" path="" filter="" fields=()
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -H) shift 2 ;;
    -f|-F) fields+=("$2"); shift 2 ;;
    --jq) filter="$2"; shift 2 ;;
    *) path="$1"; shift ;;
  esac
done
[ -n "$method" ] || { [ ${#fields[@]} -gt 0 ] && method=POST || method=GET; }
echo "$method $path ${fields[*]//$'\n'/ }" >> "$FAKE_CALLS"
status=404 body='{"message":"Not Found"}'
while read -r m p s b; do
  if [ "$m" = "$method" ] && [[ "$path" == $p ]]; then status="$s" body="$b"; break; fi
done < "$FAKE_ROUTES"
if [ "$status" -ge 400 ]; then
  echo "$body"
  echo "gh: $(jq -r '.message // "error"' <<<"$body") (HTTP $status)" >&2
  exit 1
fi
if [ -n "$filter" ]; then jq -r "$filter" <<<"$body"; else echo "$body"; fi
EOF
chmod +x "$WORK/bin/gh"

# A GitHub that accepts everything, with PR #7 (labelled ready-for-staging,
# 2 commits behind staging) open. Cases put their own answers in front.
read -r -d '' GITHUB <<'EOF'
GET repos/acme/shop 200 {"permissions":{"admin":false,"push":true,"pull":true}}
POST repos/acme/shop/labels 422 {"message":"Validation Failed","errors":[{"resource":"Label","code":"already_exists","field":"name"}]}
GET repos/acme/shop/labels/* 200 {"name":"label"}
GET repos/acme/shop/issues?state=open&labels=staging-queue-paused* 200 []
GET repos/acme/shop/issues?state=open&labels=staging-queue-tracker* 200 [{"number":340}]
GET repos/acme/shop/issues?state=closed* 200 []
GET repos/acme/shop/pulls?state=open* 200 [{"number":7,"draft":false,"title":"Feature x","head":{"sha":"aaaa111","ref":"feature/x"},"updated_at":"2026-11-03T12:00:00Z","labels":[{"name":"ready-for-staging"}]}]
GET repos/acme/shop/pulls/7 200 {"number":7,"state":"open","head":{"sha":"aaaa111","ref":"feature/x"},"mergeable":true}
GET repos/acme/shop/compare/staging...aaaa111 200 {"behind_by":2}
GET repos/acme/shop/commits/aaaa111/check-runs* 200 {"check_runs":[{"id":1,"name":"test","status":"completed","conclusion":"success","app":{"slug":"github-actions"}}]}
GET repos/acme/shop/actions/runs?branch=staging* 200 {"workflow_runs":[]}
PUT repos/acme/shop/pulls/7/update-branch 202 {"message":"Updating pull request branch."}
PATCH repos/acme/shop/issues/* 200 {}
POST repos/acme/shop/issues/*/labels 200 []
DELETE repos/acme/shop/issues/*/labels/* 200 []
POST repos/acme/shop/issues/*/comments 201 {}
EOF
UP_TO_DATE='GET repos/acme/shop/compare/staging...aaaa111 200 {"behind_by":0}'
NOTHING_OPEN='GET repos/acme/shop/pulls?state=open* 200 []'
FORBIDDEN='{"message":"Resource not accessible by personal access token","documentation_url":"https://docs.github.com/rest","status":"403"}'

# ---------------------------------------------------------------- runner
CASE="" STATUS=0 OUT="" CALLS="" passed=0 failed=0 case_failed=0
run_case() { # $1 = name, $2 = answers in front of $GITHUB, then VAR=value… for the queue
  CASE="$1" case_failed=0
  local dir="$WORK/$1" t=()
  mkdir -p "$dir"; : > "$dir/calls"; : > "$dir/summary"
  printf '%s\n%s\n' "$2" "$GITHUB" > "$dir/routes"
  shift 2
  command -v timeout >/dev/null && t=(timeout 120)
  ${t[@]+"${t[@]}"} env PATH="$WORK/bin:$PATH" FAKE_ROUTES="$dir/routes" FAKE_CALLS="$dir/calls" \
    GH_TOKEN=fake GITHUB_REPOSITORY=acme/shop GITHUB_STEP_SUMMARY="$dir/summary" DRY_RUN=0 \
    QUEUE_SITE=http://127.0.0.1:9 QUEUE_QA_SCRIPT= QUEUE_RUN_URL= QUEUE_CI_WAIT=5 \
    QUEUE_RUNS_WAIT=5 QUEUE_DEPLOY_WAIT=5 "$@" bash "$QUEUE" > "$dir/out" 2>&1
  STATUS=$?
  OUT="$(cat "$dir/out" "$dir/summary")" CALLS="$(cat "$dir/calls")"
}
check() { # $1 = what, then a command that must succeed
  local what="$1"; shift
  if "$@"; then passed=$((passed + 1)); return; fi
  failed=$((failed + 1)) case_failed=1
  echo "FAIL [$CASE] $what" >&2
}
end_case() {
  [ "$case_failed" = 0 ] && { echo "ok   $CASE"; return; }
  printf '%s\n' "--- exit $STATUS; output:" "$OUT" "--- calls:" "$CALLS" "---" >&2
}
exits() { [ "$STATUS" = "$1" ]; }
said() { grep -qF -- "$1" <<<"$OUT"; }
called() { grep -qE -- "$1" <<<"$CALLS"; }
not_called() { ! called "$1"; }
WRITES='^(POST|PUT|PATCH|DELETE) '

# ---------------------------------------------------------------- cases
run_case idle "$NOTHING_OPEN"
check "exits 0" exits 0
check "updates the tracker issue" called '^PATCH repos/acme/shop/issues/340 '
end_case

# Q-2: the token's user cannot push.
run_case no-push 'GET repos/acme/shop 200 {"permissions":{"admin":false,"push":false,"pull":true}}'
check "exits 1" exits 1
check "says why" said "STAGING_QUEUE_TOKEN has no write access to acme/shop"
check "writes nothing" not_called "$WRITES"
end_case

# Q-2, 3 Nov 2026: the token can read, but GitHub refuses every write.
run_case read-only-token "POST repos/acme/shop/labels 403 $FORBIDDEN
POST repos/acme/shop/issues* 403 $FORBIDDEN
PATCH repos/acme/shop/issues/* 403 $FORBIDDEN
DELETE repos/acme/shop/issues/* 403 $FORBIDDEN
PUT repos/acme/shop/pulls/* 403 $FORBIDDEN"
check "exits 1" exits 1
check "says why" said "STAGING_QUEUE_TOKEN cannot write to acme/shop (HTTP 403: Resource not accessible by personal access token)"
check "stops after the write check" not_called '^(PUT|PATCH|DELETE) |^POST repos/acme/shop/issues'
end_case

# Q-2: the write check passes, then GitHub refuses a write: the run fails and
# no PR is started.
run_case write-refused "PATCH repos/acme/shop/issues/* 403 $FORBIDDEN"
check "exits 1" exits 1
check "reports the refused write" said "GitHub refused a write: gh api -X PATCH repos/acme/shop/issues/340 → HTTP 403: Resource not accessible by personal access token"
check "starts no PR" not_called '^(PUT|DELETE) |^POST repos/acme/shop/issues/7/'
end_case

# Q-3: no tracker issue yet, and GitHub refuses to open one.
run_case tracker-not-opened "$NOTHING_OPEN
GET repos/acme/shop/issues?state=open&labels=staging-queue-tracker* 200 []
POST repos/acme/shop/issues 403 $FORBIDDEN"
check "exits 1" exits 1
check "reports it" said "could not find or open the issue labelled staging-queue-tracker"
check "never patches an issue" not_called '^PATCH '
end_case

# Q-4: GitHub refuses to update the branch (403): #7 stays queued, run fails.
run_case update-branch-403 "PUT repos/acme/shop/pulls/7/update-branch 403 $FORBIDDEN"
check "exits 1" exits 1
check "logs the error" said "#7 left queued: could not update its branch (HTTP 403: Resource not accessible by personal access token)"
check "does not block #7" not_called 'labels\[\]=staging-blocked'
check "keeps ready-for-staging" not_called '^DELETE repos/acme/shop/issues/7/labels/ready-for-staging'
check "does not comment on #7" not_called '^POST repos/acme/shop/issues/7/comments'
end_case

# Q-4: the branch moved since it was read (422, no conflict): the same.
run_case update-branch-stale "PUT repos/acme/shop/pulls/7/update-branch 422 {\"message\":\"expected head sha didn't match current head ref.\"}"
check "exits 1" exits 1
check "logs the error" said "#7 left queued: could not update its branch (HTTP 422: expected head sha didn't match current head ref.)"
check "does not block #7" not_called 'labels\[\]=staging-blocked'
check "keeps ready-for-staging" not_called '^DELETE repos/acme/shop/issues/7/labels/ready-for-staging'
end_case

# Q-4: a real merge conflict blocks #7, and the run still succeeds.
run_case update-branch-conflict 'PUT repos/acme/shop/pulls/7/update-branch 422 {"message":"merge conflict between base and head"}'
check "exits 0" exits 0
check "blocks #7" called '^POST repos/acme/shop/issues/7/labels labels\[\]=staging-blocked'
check "removes ready-for-staging" called '^DELETE repos/acme/shop/issues/7/labels/ready-for-staging'
check "asks its session to resolve the conflict" called '^POST repos/acme/shop/issues/7/comments body=.*\(merge conflict\)'
end_case

# Q-4: other wording, but GitHub says #7 cannot merge: also a conflict.
run_case update-branch-unmergeable 'PUT repos/acme/shop/pulls/7/update-branch 422 {"message":"Validation Failed"}
GET repos/acme/shop/pulls/7 200 {"number":7,"state":"open","head":{"sha":"aaaa111","ref":"feature/x"},"mergeable":false}'
check "exits 0" exits 0
check "blocks #7" called '^POST repos/acme/shop/issues/7/labels labels\[\]=staging-blocked'
end_case

# GitHub refuses the merge with 403: not labelled testing, run fails.
run_case merge-403 "$UP_TO_DATE
PUT repos/acme/shop/pulls/7/merge 403 $FORBIDDEN"
check "exits 1" exits 1
check "reports the refused merge" said "GitHub refused a write: gh api -X PUT repos/acme/shop/pulls/7/merge → HTTP 403"
check "does not label #7 testing" not_called 'labels\[\]=staging-testing'
check "keeps ready-for-staging" not_called '^DELETE repos/acme/shop/issues/7/labels/ready-for-staging'
end_case

# 405 (not mergeable right now) is retried on the next trigger, as before.
run_case merge-405 "$UP_TO_DATE
PUT repos/acme/shop/pulls/7/merge 405 {\"message\":\"Pull Request is not mergeable\"}"
check "exits 0" exits 0
check "comments the refusal" called '^POST repos/acme/shop/issues/7/comments body=.*GitHub refused the merge \(HTTP 405: Pull Request is not mergeable\)'
end_case

# DRY_RUN=1 writes nothing and reports what it would do.
run_case dry-run-behind "" DRY_RUN=1
check "exits 0" exits 0
check "writes nothing" not_called "$WRITES"
check "reports the branch update" said "DRY RUN: gh api -X PUT repos/acme/shop/pulls/7/update-branch -f expected_head_sha=aaaa111"
end_case

run_case dry-run-up-to-date "$UP_TO_DATE" DRY_RUN=1
check "exits 0" exits 0
check "writes nothing" not_called "$WRITES"
check "reports the merge" said "DRY RUN: would merge #7 at aaaa111"
end_case

# 7 Nov 2026 (#363): the merge's push CI had passed, but the release PR
# (staging → main) ran its CI on the same sha and was still running. Only push
# runs count, in "staging busy" and in the merge's runs: the queue goes on to
# the deploy step instead of timing out on step 4.
RUNS_F971899="$(jq -c . "$(dirname "$QUEUE")/fixtures/actions-runs-f971899.json")"
MERGED_F971899='PUT repos/acme/shop/pulls/7/merge 200 {"sha":"f971899b7d74979fbe58d6d14b6ad5b2bdfb583c","merged":true}'
run_case release-pr-ci-running "$UP_TO_DATE
$MERGED_F971899
GET repos/acme/shop/actions/runs?branch=staging* 200 $RUNS_F971899
GET repos/acme/shop/actions/runs?head_sha=f971899b7d74979fbe58d6d14b6ad5b2bdfb583c* 200 $RUNS_F971899"
check "staging not busy with release-PR CI" eval '! said "staging busy"'
check "passes the merge's push runs" said "staging runs passed: CI, Sandbox payment"
check "does not wait on the release PR" eval '! said "staging runs still running"'
check "goes on to the deploy step" said "did not show a new build"
end_case

# A push run of the merge still running is still waited for.
PUSH_CI_RUNNING="$(jq -c '.workflow_runs |= map(if .event == "push" and .name == "CI" then .status = "in_progress" | .conclusion = null else . end)' <<<"$RUNS_F971899")"
run_case push-ci-running "$UP_TO_DATE
$MERGED_F971899
GET repos/acme/shop/actions/runs?head_sha=f971899b7d74979fbe58d6d14b6ad5b2bdfb583c* 200 $PUSH_CI_RUNNING"
check "times out on step 4" said "staging runs: staging runs still running after"
end_case

echo "$passed passed, $failed failed"
[ "$failed" = 0 ]
