# Staging queue — test.gokesari.com

Several Claude sessions (chat windows) often finish GoKesari work at the same
time. Before this queue each session merged its own PR into `staging`
whenever it was done, so two or three changes could land on test.gokesari.com
minutes apart and nobody tested one before the next arrived (on 3 Nov 2026,
#329 was merged by one session while #325 and #330 waited in others).

The queue merges finished PRs into `staging` **one at a time** and tests each
one on test.gokesari.com before it merges the next. Nobody has to watch it.

Files: `.github/workflows/staging-queue.yml`, `scripts/release/staging-queue.sh`,
`scripts/release/staging-queue-qa.sh`.

## For every session (the only rule)

1. Finish the work on a branch and open the PR into `staging`.
2. Add the label **`ready-for-staging`**.
3. **Do not merge it yourself.** The queue merges it, tests it and comments the
   result on the PR (times in IST).

4. **Stay subscribed to the PR until it is `staging-verified`** and act on the
   queue's comments yourself, without asking the owner:
   - `staging-blocked` → fix on the same branch, push, add `ready-for-staging`
     again;
   - `staging-failed` → new branch from `origin/staging`, fix, open a PR into
     `staging` titled `Fix #<n>: …` labelled `staging-fix` (don't merge it),
     and stay on that PR the same way. The failure comment lists the failing
     checks and links the run.

A PR that is still being worked on simply has no label; the queue ignores it.
`staging-hold` keeps a labelled PR out of the queue for now.

## What the queue does with each PR

Oldest PR first (lowest number; `staging-fix` PRs go before everything):

| Step | What has to hold |
|---|---|
| 1. Checks | the PR's CI (GitHub Actions) is green. If the branch is behind `staging`, the queue updates it and waits for CI again, so what was tested is what lands. |
| 2. Staging idle | no other workflow is still running on `staging`. |
| 3. Merge | merge commit into `staging`; the PR gets `staging-testing`. |
| 4. Staging runs | every workflow the merge starts (CI on staging, "Test database" migration, app builds) passes. |
| 5. Deploy | test.gokesari.com serves a build made after the merge (the build version in `/sw.js` changes). |
| 6. Site answers | `scripts/release/post-deploy-check.sh` — 3 healthy rounds, 45 s apart. |
| 7. Guest QA | `tests/qa/guest` (production-safe tier) against test.gokesari.com, one retry per check. Results: the run's `staging-queue-qa-*` artifact. |

Then:

- **passed** → `staging-verified`, and the next PR starts at once;
- **failed** → `staging-failed`, a **"Staging queue paused"** issue is opened
  and nothing else is merged. The comment on the PR tells the owning session
  what failed and how to fix it; the session opens the fix PR labelled
  **`staging-fix`**, the queue merges and tests only fixes while paused, and
  closes the pause issue itself when one passes — no owner step. If the owning
  session has already ended, the pause issue (GitHub e-mails it) is the cue to
  tell any GoKesari session "fix the staging queue failure". If the
  failure was not caused by the change (host down), close the issue instead.
- **CI red or merge conflict before merging** → `staging-blocked`, the
  `ready-for-staging` label is removed and the queue moves on (nothing was
  merged, so it does not pause). Fix it and add `ready-for-staging` again.

The live status is the issue labelled **`staging-queue-tracker`** (open PRs,
their place and state, recently verified PRs, all times IST). It is an issue,
not a file, so updating it never triggers another deploy.

## What it does not do

- **Production.** `staging` → `main` stays the owner's approval and the
  one-release-at-a-time rule in CLAUDE.md / DEPLOYMENT.md §3.
- **Signed-in QA.** The signed-in tier needs the staging accounts' e-mailed
  sign-in codes, which a GitHub runner cannot read. Run it from a Claude
  session (`gokesari-qa` agent, `gokesari-qa-signin`) after a PR is verified.
- **Mobile store releases and the feature tracker.** Each session still updates
  the Android/iOS apps and the tracker before labelling its PR.

## One-time setup (owner)

Merges made with the workflow's own `GITHUB_TOKEN` start no other workflows,
so staging's CI and the "Test database" migration would never run. The queue
therefore uses a personal token:

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new token.
   - Repository access: only `sanjaymorankar-debug/gokesari`.
   - Permissions: **Contents** read and write, **Pull requests** read and
     write, **Issues** read and write, **Actions** read, **Commit statuses**
     read (Metadata read is added automatically).
   - Expiry: up to 1 year; note the date.
2. Repository → Settings → Secrets and variables → Actions → New repository
   secret: name **`STAGING_QUEUE_TOKEN`**, value the token.

Without the secret every run stops with a warning and changes nothing.

## Triggers

A PR labelled `ready-for-staging` / `staging-fix`, and every push to
`staging`. Once this workflow is also on `main` (it travels with the next
production release): an hourly safety net, closing a pause issue, and
Actions → Staging queue → Run workflow (with a dry-run option). Only one queue
run works at a time; it keeps going until nothing is left.
