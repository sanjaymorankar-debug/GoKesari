#!/usr/bin/env bash
# Staging queue — test.gokesari.com (docs/staging-queue/README.md).
#
# Several Claude sessions (chat windows) finish work at different times. Each
# one opens a PR into `staging` and adds the label `ready-for-staging`; it
# does NOT merge it. This script, run by .github/workflows/staging-queue.yml,
# then promotes those PRs ONE AT A TIME, with no manual step in between:
#
#   1. pick the oldest PR labelled ready-for-staging (lowest number);
#   2. wait for its CI; bring it up to date with staging when it is behind
#      (CI then runs again on the new head) and wait again;
#   3. wait until nothing else is running on staging, then merge it;
#   4. wait for staging's own runs for that merge (CI, "Test database"
#      migration), for Hostinger to deploy it to test.gokesari.com (the build
#      version in /sw.js changes), for the site to answer (post-deploy check)
#      and for the guest QA tier against test.gokesari.com;
#   5. passed → label staging-verified and go straight to the next PR;
#      failed → label staging-failed, open a "Staging queue paused" issue and
#      stop. While paused, only PRs labelled staging-fix are merged; when a fix
#      verifies, the pause issue is closed and the queue carries on by itself.
#
# A PR whose CI fails or that has a merge conflict is labelled staging-blocked
# and skipped (nothing was merged, so the queue does not pause). Re-add
# ready-for-staging after fixing it — the queue removes staging-blocked then.
#
# Status lives in one GitHub issue labelled staging-queue-tracker (times in
# IST), so no tracker commit ever triggers another deploy. Production (`main`)
# is never touched: staging → main stays the owner's approval gate (CLAUDE.md).
#
# Env: GH_TOKEN (required: a token whose actions trigger workflows — see the
# README), GITHUB_REPOSITORY, QUEUE_RUN_URL, QUEUE_QA_SCRIPT (optional),
# DRY_RUN=1 (print what would happen, write nothing).
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
BASE="${QUEUE_BASE:-staging}"
SITE="${QUEUE_SITE:-https://test.gokesari.com}"
SELF_JOB="${QUEUE_JOB_NAME:-staging-queue}"
SELF_WORKFLOW="${QUEUE_WORKFLOW_NAME:-Staging queue}"
CI_WAIT="${QUEUE_CI_WAIT:-5400}"         # s: PR checks must finish within
RUNS_WAIT="${QUEUE_RUNS_WAIT:-3600}"     # s: staging's own runs must finish within
DEPLOY_WAIT="${QUEUE_DEPLOY_WAIT:-1800}" # s: Hostinger must deploy within
QA_SCRIPT="${QUEUE_QA_SCRIPT:-}"
RUN_URL="${QUEUE_RUN_URL:-}"
DRY_RUN="${DRY_RUN:-0}"
QUEUE_DIR="${QUEUE_DIR:-$(cd "$(dirname "$0")" && pwd)}" # holds post-deploy-check.sh
MAX_PRS="${QUEUE_MAX_PRS:-20}"           # per run; the next trigger carries on

READY=ready-for-staging FIX=staging-fix HOLD=staging-hold
TESTING=staging-testing VERIFIED=staging-verified
BLOCKED=staging-blocked FAILED=staging-failed
PAUSED=staging-queue-paused TRACKER=staging-queue-tracker

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
ist() { TZ=Asia/Kolkata date "+%d %b %Y %I:%M %p IST"; }
log() { echo "[$(TZ=Asia/Kolkata date +%H:%M:%S) IST] $*" >&2; }
note() { log "$*"; echo "- $(TZ=Asia/Kolkata date +%H:%M) IST — $*" >> "$summary"; }

if [ -z "${GH_TOKEN:-}" ]; then
  msg="Secret STAGING_QUEUE_TOKEN is not set. The queue needs it to merge and so that the merge starts staging's CI and \"Test database\" runs (merges made with the default GITHUB_TOKEN start no workflows). Setup: docs/staging-queue/README.md."
  # Not a failure of the change that was pushed: warn once per run, no red X.
  echo "::warning::$msg"; echo "⚠️ $msg" >> "$summary"; exit 0
fi

api() { gh api -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }
write() { # write calls are skipped in a dry run
  if [ "$DRY_RUN" = 1 ]; then log "DRY RUN: gh api $*"; echo '{}'; else api "$@"; fi
}

ensure_labels() {
  local spec name color
  for spec in "$READY:0e8a16" "$FIX:5319e7" "$HOLD:bfdadc" "$TESTING:fbca04" "$VERIFIED:1d76db" \
              "$BLOCKED:d93f0b" "$FAILED:b60205" "$PAUSED:b60205" "$TRACKER:c5def5"; do
    name="${spec%%:*}" color="${spec##*:}"
    api "repos/$REPO/labels/$name" >/dev/null 2>&1 ||
      write "repos/$REPO/labels" -f name="$name" -f color="$color" >/dev/null 2>&1 || true
  done
}
add_label() { write "repos/$REPO/issues/$1/labels" -f "labels[]=$2" >/dev/null; }
remove_label() { write -X DELETE "repos/$REPO/issues/$1/labels/$2" >/dev/null 2>&1 || true; }
comment() { write "repos/$REPO/issues/$1/comments" -f body="$2" >/dev/null; }

# ---------------------------------------------------------------- the queue
pause_issue() { # number of the open pause issue, or empty
  api "repos/$REPO/issues?state=open&labels=$PAUSED&per_page=1" --jq '.[0].number // empty'
}
candidates() { # $1 = label to require; oldest first
  api "repos/$REPO/pulls?state=open&base=$BASE&per_page=100" --jq "
    [ .[] | select(.draft | not)
          | select(any(.labels[]; .name == \"$1\"))
          | select(all(.labels[]; .name != \"$HOLD\" and .name != \"$FAILED\")) ]
    | sort_by(.number) | .[].number"
}

# Checks on a commit, GitHub Actions only (Hostinger's preview statuses are
# ignored), newest run per check name, this queue's own job left out.
# Prints: success | failure:<names> | pending | none
checks_state() {
  api "repos/$REPO/commits/$1/check-runs?per_page=100" --jq "
    [ .check_runs[] | select(.app.slug == \"github-actions\") | select(.name != \"$SELF_JOB\") ]
    | group_by(.name) | map(max_by(.id))
    | if length == 0 then \"none\"
      elif any(.[]; .status != \"completed\") then \"pending\"
      elif any(.[]; (.conclusion | IN(\"success\",\"skipped\",\"neutral\")) | not)
        then \"failure:\" + ([ .[] | select((.conclusion | IN(\"success\",\"skipped\",\"neutral\")) | not) | .name ] | join(\", \"))
      else \"success\" end"
}
wait_checks() { # $1 sha → prints final state
  local start=$SECONDS state
  while :; do
    state="$(checks_state "$1")"
    case "$state" in
      success|failure:*) echo "$state"; return ;;
      none) [ $((SECONDS - start)) -ge 900 ] && { echo "failure:no CI run started within 15 min"; return; } ;;
    esac
    [ $((SECONDS - start)) -ge "$CI_WAIT" ] && { echo "failure:checks still running after $((CI_WAIT / 60)) min"; return; }
    sleep 30
  done
}

# Workflow runs on staging other than this queue (push or by hand).
busy_runs() {
  api "repos/$REPO/actions/runs?branch=$BASE&per_page=30" --jq "
    [ .workflow_runs[] | select(.status != \"completed\") | select(.name != \"$SELF_WORKFLOW\") | .name ] | unique | join(\", \")"
}
wait_staging_idle() {
  local start=$SECONDS busy
  while :; do
    busy="$(busy_runs || true)"
    [ -z "$busy" ] && return 0
    [ $((SECONDS - start)) -ge "$RUNS_WAIT" ] && { log "staging still busy ($busy); going ahead"; return 0; }
    log "staging busy: $busy — waiting"; sleep 60
  done
}

# Every run started by the push of the merge commit (CI, Test database,
# app builds…). Prints success | failure:<names>
wait_merge_runs() {
  local sha="$1" start=$SECONDS out
  while :; do
    out="$(api "repos/$REPO/actions/runs?head_sha=$sha&per_page=50" --jq "
      [ .workflow_runs[] | select(.name != \"$SELF_WORKFLOW\") ] | group_by(.name) | map(max_by(.id))
      | if length == 0 then \"none\"
        elif any(.[]; .status != \"completed\") then \"pending\"
        elif any(.[]; (.conclusion | IN(\"success\",\"skipped\",\"neutral\")) | not)
          then \"failure:\" + ([ .[] | select((.conclusion | IN(\"success\",\"skipped\",\"neutral\")) | not) | .name ] | join(\", \"))
        else \"success:\" + (map(.name) | join(\", \")) end")"
    case "$out" in
      success:*) log "staging runs passed: ${out#success:}"; echo success; return ;;
      failure:*) echo "$out"; return ;;
      none) if [ $((SECONDS - start)) -ge 240 ]; then
              echo "::warning::No workflow started for merge $sha — is STAGING_QUEUE_TOKEN a personal token? (README)" >&2
              echo success; return
            fi ;;
    esac
    [ $((SECONDS - start)) -ge "$RUNS_WAIT" ] && { echo "failure:staging runs still running after $((RUNS_WAIT / 60)) min"; return; }
    sleep 30
  done
}

site_version() { # build version baked into /sw.js (GK_BUILD_VERSION)
  curl -sS -m 20 -A "GoKesari staging queue" "$SITE/sw.js" 2>/dev/null |
    sed -n 's/^const VERSION = "\(.*\)";$/\1/p' | head -1
}
wait_deploy() { # $1 version before the merge, $2 epoch of the merge
  local before="$1" merged="$2" start=$SECONDS v t
  while :; do
    v="$(site_version || true)"
    if [ -n "$v" ] && [ "$v" != "$before" ]; then
      t="$(date -d "$v" +%s 2>/dev/null || echo "$merged")"
      if [ "$t" -ge $((merged - 60)) ]; then log "test site now runs build $v"; return 0; fi
    fi
    [ $((SECONDS - start)) -ge "$DEPLOY_WAIT" ] && return 1
    sleep 30
  done
}

# ---------------------------------------------------------------- tracker
tracker_issue() {
  local n
  n="$(api "repos/$REPO/issues?state=open&labels=$TRACKER&per_page=1" --jq '.[0].number // empty')"
  if [ -z "$n" ] && [ "$DRY_RUN" != 1 ]; then
    n="$(api "repos/$REPO/issues" -f title="Staging queue — status (test.gokesari.com)" \
          -f body="Created by the staging queue." -f "labels[]=$TRACKER" --jq .number)"
  fi
  echo "$n"
}
update_tracker() { # $1 = state line
  local n body rows
  n="$(tracker_issue)"; [ -z "$n" ] && return 0
  rows="$(api "repos/$REPO/pulls?state=open&base=$BASE&per_page=100" --jq "
    def ist: (sub(\"\\\\.[0-9]+Z$\"; \"Z\") | fromdateiso8601 + 19800 | strftime(\"%d %b %I:%M %p\"));
    def st: [ .labels[].name ] as \$l
      | if (\$l | index(\"$TESTING\")) then \"🧪 merged, testing on staging\"
        elif (\$l | index(\"$FAILED\")) then \"❌ failed on staging\"
        elif (\$l | index(\"$BLOCKED\")) then \"⛔ blocked (CI / conflict)\"
        elif (\$l | index(\"$HOLD\")) then \"⏸ on hold\"
        elif (\$l | index(\"$FIX\")) then \"🛠 fix, queued first\"
        elif (\$l | index(\"$READY\")) then \"⏳ queued\"
        else \"🚧 in progress (not labelled ready)\" end;
    sort_by(.number) | .[] | \"| #\(.number) | \(.title | gsub(\"\\\\|\"; \"/\")) | \(.head.ref) | \(st) | \(.updated_at | ist) |\"")"
  local done_rows
  done_rows="$(api "repos/$REPO/issues?state=closed&labels=$VERIFIED&sort=updated&direction=desc&per_page=10" --jq "
    def ist: (fromdateiso8601 + 19800 | strftime(\"%d %b %I:%M %p\"));
    .[] | \"| #\(.number) | \(.title | gsub(\"\\\\|\"; \"/\")) | ✅ verified on staging | \(.updated_at | ist) |\"")"
  body="## Staging queue — test.gokesari.com

**State:** $1
**Updated:** $(ist)${RUN_URL:+ · [run]($RUN_URL)}

Sessions: open the PR into \`staging\`, add **\`$READY\`**, don't merge it yourself. A fix for a paused queue gets **\`$FIX\`**. Rules: docs/staging-queue/README.md.

### Open PRs into staging (merge order = PR number)
| PR | Title | Branch | Status | Last change (IST) |
|---|---|---|---|---|
${rows:-| – | nothing open | | | |}

### Recently verified on staging
| PR | Title | Status | When (IST) |
|---|---|---|---|
${done_rows:-| – | none yet | | |}

Production (\`main\`) is not part of this queue: staging → main stays the owner's approval."
  write -X PATCH "repos/$REPO/issues/$n" -f body="$body" >/dev/null || true
}

# ---------------------------------------------------------------- one PR
# Returns 0 = verified, 1 = failed on staging (queue pauses), 2 = skipped.
process_pr() {
  local n="$1" pr head sha ref state behind merged_sha merged_at before runs qa_log
  pr="$(api "repos/$REPO/pulls/$n")"
  [ "$(jq -r .state <<<"$pr")" = open ] || return 2
  sha="$(jq -r .head.sha <<<"$pr")"; ref="$(jq -r .head.ref <<<"$pr")"
  note "#$n ($ref): checking"
  # ready-for-staging is removed whenever a PR is blocked, so a PR carrying
  # both labels was queued again after a fix: clear the old block.
  remove_label "$n" "$BLOCKED"

  # Up to date with staging? (Only then do the checks cover what will land.)
  behind="$(api "repos/$REPO/compare/$BASE...$sha" --jq .behind_by)"
  if [ "$behind" -gt 0 ]; then
    note "#$n is $behind commit(s) behind $BASE — updating the branch"
    if ! write -X PUT "repos/$REPO/pulls/$n/update-branch" -f expected_head_sha="$sha" >/dev/null 2>&1; then
      add_label "$n" "$BLOCKED"; remove_label "$n" "$READY"
      comment "$n" "⛔ **Staging queue** ($(ist)): could not bring this branch up to date with \`$BASE\` (merge conflict). Resolve it, then add \`$READY\` again."
      return 2
    fi
    [ "$DRY_RUN" = 1 ] && return 2
    local start=$SECONDS
    while head="$(api "repos/$REPO/pulls/$n" --jq .head.sha)"; [ "$head" = "$sha" ]; do
      [ $((SECONDS - start)) -ge 300 ] && break; sleep 10
    done
    sha="$head"
  fi

  state="$(wait_checks "$sha")"
  if [ "$state" != success ]; then
    add_label "$n" "$BLOCKED"; remove_label "$n" "$READY"
    comment "$n" "⛔ **Staging queue** ($(ist)): not merged — checks on \`${sha:0:7}\`: ${state#failure:}. Fix it, then add \`$READY\` again."
    note "#$n blocked: ${state#failure:}"; return 2
  fi

  local m start=$SECONDS
  while m="$(api "repos/$REPO/pulls/$n" --jq '.mergeable')"; [ "$m" = null ]; do
    [ $((SECONDS - start)) -ge 120 ] && break; sleep 5
  done
  if [ "$m" = false ]; then
    add_label "$n" "$BLOCKED"; remove_label "$n" "$READY"
    comment "$n" "⛔ **Staging queue** ($(ist)): merge conflict with \`$BASE\`. Resolve it, then add \`$READY\` again."
    return 2
  fi

  wait_staging_idle
  before="$(site_version || true)"
  if [ "$DRY_RUN" = 1 ]; then note "DRY RUN: would merge #$n at ${sha:0:7} and test $SITE"; return 2; fi

  merged_at=$(date +%s)
  merged_sha="$(api -X PUT "repos/$REPO/pulls/$n/merge" -f merge_method=merge -f sha="$sha" --jq .sha)" || {
    comment "$n" "⛔ **Staging queue** ($(ist)): GitHub refused the merge. Will retry on the next trigger."
    return 2
  }
  remove_label "$n" "$READY"; add_label "$n" "$TESTING"
  note "#$n merged into $BASE as ${merged_sha:0:7}"
  update_tracker "🧪 testing #$n on $SITE"
  comment "$n" "🧪 **Staging queue** ($(ist)): merged into \`$BASE\` as \`${merged_sha:0:7}\`. Testing on $SITE now${RUN_URL:+ ([run]($RUN_URL))}."

  local fail=""
  runs="$(wait_merge_runs "$merged_sha")"
  [ "$runs" = success ] || fail="staging runs: ${runs#failure:}"
  if [ -z "$fail" ] && ! wait_deploy "$before" "$merged_at"; then
    fail="$SITE did not show a new build within $((DEPLOY_WAIT / 60)) min (Hostinger deploy)"
  fi
  if [ -z "$fail" ] && ! bash "$QUEUE_DIR/post-deploy-check.sh" "$SITE" --rounds 3 --every 45 --deadline 600 >&2; then
    fail="$SITE did not keep answering after the deploy (post-deploy check)"
  fi
  if [ -z "$fail" ] && [ -n "$QA_SCRIPT" ]; then
    qa_log="$(mktemp)"
    if ! bash "$QA_SCRIPT" "$merged_sha" "$SITE" "$n" 2>&1 | tee "$qa_log" >&2; then
      fail="guest QA tier failed on $SITE: $(grep -E '^\s+[0-9]+ failed|✘' "$qa_log" | head -5 | tr '\n' ' ')"
    fi
  fi

  remove_label "$n" "$TESTING"
  if [ -z "$fail" ]; then
    add_label "$n" "$VERIFIED"
    comment "$n" "✅ **Staging queue** ($(ist)): verified on $SITE — staging CI and migrations passed, the deploy is live, the site kept answering and the guest QA tier passed. Signed-in QA and production stay with the session/owner."
    note "#$n verified on $SITE"; return 0
  fi
  add_label "$n" "$FAILED"
  comment "$n" "❌ **Staging queue** ($(ist)): **failed on $SITE** — $fail. The queue is paused. Push a fix as a new PR into \`$BASE\` labelled \`$FIX\` (it goes first and un-pauses the queue when it passes)${RUN_URL:+ · [run]($RUN_URL)}."
  note "#$n FAILED: $fail"
  echo "$fail"; return 1
}

# ---------------------------------------------------------------- main
ensure_labels
note "queue started (base $BASE, site $SITE$([ "$DRY_RUN" = 1 ] && echo ', DRY RUN'))"
processed=0 rc=0
while [ "$processed" -lt "$MAX_PRS" ]; do
  paused="$(pause_issue)"
  if [ -n "$paused" ]; then mapfile -t list < <(candidates "$FIX")
  else mapfile -t list < <(candidates "$FIX"; candidates "$READY"); fi
  # first one not seen in this run (a skipped PR stays labelled only if dry run)
  next=""
  for c in "${list[@]}"; do
    [ -n "$c" ] || continue
    case " ${seen:-} " in *" $c "*) continue ;; esac
    next="$c"; break
  done
  if [ -z "$next" ]; then
    [ -n "$paused" ] && update_tracker "⛔ PAUSED — see #$paused (waiting for a PR labelled \`$FIX\`)" || update_tracker "✅ idle — nothing queued"
    break
  fi
  seen="${seen:-} $next"
  update_tracker "▶️ running — checking #$next"
  out="$(mktemp)"
  set +e; process_pr "$next" > "$out"; res=$?; set -e
  reason="$(tail -1 "$out")"
  processed=$((processed + 1))
  if [ "$res" = 0 ] && [ -n "$paused" ]; then
    write -X PATCH "repos/$REPO/issues/$paused" -f state=closed >/dev/null
    comment "$paused" "✅ Fix #$next verified on $SITE ($(ist)). Queue resumed."
  fi
  if [ "$res" = 1 ]; then
    if [ -z "$paused" ]; then
      write "repos/$REPO/issues" -f title="Staging queue paused — #$next failed on test.gokesari.com" \
        -f "labels[]=$PAUSED" -f body="PR #$next was merged into \`$BASE\` and failed on $SITE ($(ist)):

$reason

Nothing else is merged into staging until this is resolved. Either:
- open a fix PR into \`$BASE\` and label it \`$FIX\` — the queue merges and tests it first, and closes this issue when it passes; or
- if the failure was not caused by the change (e.g. the host was down), close this issue — the queue continues on its next trigger.
${RUN_URL:+
Run: $RUN_URL}" >/dev/null
    else
      comment "$paused" "❌ Fix attempt #$next also failed ($(ist)): $reason"
    fi
    update_tracker "⛔ PAUSED — #$next failed on staging"
    rc=1; break
  fi
done
exit "$rc"
