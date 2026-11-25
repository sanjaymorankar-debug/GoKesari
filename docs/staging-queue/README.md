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
| 1. Checks | the PR's CI (GitHub Actions) is green. If the branch is behind `staging`, the queue updates it and waits for CI again, so what was tested is what lands. **Except (option A, see "Speed" below):** if nothing `staging` gained since the PR branched off changes a file the PR changes, they don't both change `drizzle/`, and staging's own push runs on its head passed, the PR is merged as it is. Staging's CI on the merge (step 4) then tests the two together. |
| 2. Staging idle | no other push-triggered workflow is still running on `staging`. |
| 3. Merge | merge commit into `staging`; the PR gets `staging-testing`. |
| 4. Staging runs | every **push run of the merge commit** (CI on staging, "Test database" migration, app builds) passes. Runs on the same commit that the push did not start — the CI of an open `staging` → `main` release PR, or a hand-run tool such as "Sandbox payment" — are not counted, so an open release PR no longer holds the queue (it did on 7 Nov 2026, #363). |
| 5. Deploy | test.gokesari.com serves a build made after the merge (the build version in `/sw.js` changes). Since 17-Nov-2026 the server's `gk-deploy` agent builds it, about 5 minutes after the merge (Hostinger's auto-deploy before that). If no new build shows within 30 minutes, look at `sudo gk-deploy status` and `journalctl -u gk-deploy` on the server. |
| 6. Site answers | `scripts/release/post-deploy-check.sh` — 3 healthy rounds, 45 s apart. |
| 7. Guest QA | `tests/qa/guest` (production-safe tier) against test.gokesari.com, one retry per check. Results: the run's `staging-queue-qa-*` artifact. |

Then:

- **passed** → `staging-verified`, and the next PR starts at once. The
  exception is a run that has been going for **4 hours**: it starts no new
  PR and hands over. The next run carries on, started by a push to `staging`,
  a label, or the hourly schedule. GitHub stops a run at 350 minutes, and one
  PR can take up to about 90, so the PR in hand always gets its verdict. (On
  20-Nov-2026 a run was cut off during #420's guest QA.) `QUEUE_RUN_BUDGET`
  (seconds) changes the 4 hours;
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
  Only a real merge conflict counts: if GitHub refuses to update the branch
  for any other reason (token, the branch moved meanwhile, GitHub down), the
  PR keeps `ready-for-staging` and the run fails instead.
- **GitHub refuses a write** (label, comment, branch update, merge, tracker)
  → the run fails with a red X and the error in its log and summary. Each run
  first checks that the token can write and stops at once if it cannot; a
  write refused later ends the run after the PR in hand (no new PR is
  started). PRs not dealt with keep `ready-for-staging` and are picked up by
  the next run. (On 3 Nov 2026 the token could read but not write for 5½
  hours, and every run still ended green while #334, #336 and #339 sat
  unmerged.)
- **Merge conflict in the migration journal only** → the queue fixes it
  itself; see "Migration numbers" below.

## Migration numbers

`tests/unit/migration-journal.test.ts` wants the Drizzle journal contiguous:
entry *i* is `drizzle/NNNN_….sql` with NNNN = *i*. A PR cannot reserve a
number, so PRs opened at the same time all take the next free one. Whichever
lands first keeps it; every other one then conflicts on
`drizzle/meta/_journal.json`. On 24–25 Nov 2026, PAY-2 (#531) had to be
renumbered by hand five times, 0185 → 0190, as #513, #512, #523/#524 and
#525 landed ahead of it.

Since 25 Nov 2026 the queue handles this itself. When a PR's branch cannot be
brought up to date and the **only** conflicting file is the journal, the queue:

1. merges `staging` into the PR branch in a scratch clone;
2. runs `scripts/db/renumber-migrations.mjs origin/staging`, which:
   - moves the PR's own migrations past staging's last one;
   - renames their `.sql` files, any `drizzle/meta/NNNN_snapshot.json` the
     PR added, and its `scripts/rollback-NNNN*.sql`;
   - rewrites the full tags (`0187_foo`, `rollback-0187`) in files the PR
     changed;
   - rewrites bare numbers too, but only in files the PR added;
3. pushes that merge to the PR branch, comments what it renumbered (🔢), and
   carries on with the new head: CI, merge and test as usual.

The same happens when `staging` moves while the PR's checks are running. The
PR stays queued and the next run picks it up.

The queue does not do this for a PR from a fork, which it cannot push to, or
for a conflict in any other file. Those PRs are `staging-blocked` as before.
The session that owns the PR should **pull before pushing again**. If the
queue's comment lists an old number still mentioned in a file the PR only
modified, check that mention by hand.

Sessions can use the same script locally:

```bash
git fetch origin staging && git merge origin/staging   # stops on _journal.json
node scripts/db/renumber-migrations.mjs origin/staging  # add --dry-run to preview
git commit --no-edit
```

The live status is the issue labelled **`staging-queue-tracker`** (open PRs,
their place and state, recently verified PRs, all times IST). It is an issue,
not a file, so updating it never triggers another deploy.

## Speed: option A (owner's choice, 20-Nov-2026)

**Measured on 20-Nov-2026** from the queue's run logs for the last 15
verified PRs (17–20 Nov: #406, #408, #410–#413, #416–#419, #421, #423,
#426, #428, #433). Medians for code PRs, in minutes:

| Part | Median (range) |
|---|---|
| (a) The PR's own CI again after the queue updated a branch that was behind (#406, #418, #419, #421, #423) | 32.7 (22.7–36.2) |
| (b) Staging's push runs of the merge commit (CI; "Test database" takes 1–2) | 29.2 (23.3–33.0) |
| (c) The server's deploy (`gk-deploy`) | 0 extra: done about 6 min after the merge, while (b) still runs |
| (d) Post-deploy check | 1.7 |
| (e) Guest QA | 12.6 (11.8–17.5) |
| Merge → verified | 44.2 (37.4–51.1) |

When several PRs wait, each one is behind by the time its turn comes, so it
pays (a) and then (b) to (e). That is about 70–79 min per PR, and five PRs
take about 6 hours. Inside CI, "Unit and integration tests" alone takes 23 of
its roughly 32 minutes.

**The options put to the owner:**

- **A.** Merge a PR that is behind as it is when staging's changes touch none
  of its files.
- **B.** Test 2–3 PRs together.
- **C.** A second test site on the server.
- **D.** Skip staging's CI when the merged tree already passed, and update the
  next PR early.

**The owner chose A** (20-Nov-2026, 20.30 IST). What it does:

- **When it applies:** a PR that is behind `staging` is merged as it is, with
  no branch update and no second CI run, when all of these hold:
  - staging's own push runs on its head passed (a run named `CI` among them);
  - nothing staging gained since the PR branched off changes a file the PR
    changes (both names of a renamed file count);
  - they don't both change `drizzle/`;
  - neither file list was cut off at GitHub's 300.
- **When it doesn't:** if any of these is in doubt (or an API call fails), the
  branch is updated as before. The queue merges only onto the staging head it
  checked; if staging moved meanwhile, the PR waits for the next run.
- **Expected time:** about 45 min per PR when several wait (from about 75),
  so five PRs take about 3¾ hours.
- **What it gives up:** the PR's own CI no longer tests the PR together with
  staging's newer changes; staging's CI on the merge commit does that instead
  (step 4). A break between the two that shares no file is caught after the
  merge, not before it. An example is a function renamed on staging that the
  PR calls from a file staging did not touch. The PR then gets
  `staging-failed`, the queue pauses, and the owning session opens a
  `staging-fix` PR (until now such a PR was `staging-blocked` before merging).
  The PR's comment says when it was merged as it was.
- **Turning it off:** set the repository variable
  **`STAGING_QUEUE_SKIP_UPDATE`** to `0` (Settings → Secrets and variables →
  Actions → Variables). Every behind PR is then updated as before; no code
  change is needed.
- **Fixed alongside A (owner, 20-Nov-2026):** the queue job stops at
  350 minutes. On 20-Nov-2026 the run that started at 00.18 IST was cut off at
  06.08 IST, during #420's guest QA, so #420 was merged but got no verdict.
  - A run now starts no new PR after 4 hours (see "Then:" above).
  - #420 was given its verdict by hand. Its staging CI had passed, the site
    ran its build, the post-deploy check had passed, and 44 guest checks had
    passed with none failing. #421 then passed the full guest QA on top of it.

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

Without the secret every run stops with a warning and changes nothing. With a
token that cannot write (expired, or read-only permissions) every run fails at
its first step with "STAGING_QUEUE_TOKEN cannot write to …" or "… has no write
access …": renew the token with the permissions above and update the secret.

## Tests

`scripts/release/staging-queue.test.sh` runs the queue script against a fake
`gh` (403 / 422 answers, dry runs, the 7 Nov 2026 runs of `f971899` with
the release PR's CI still running — `scripts/release/fixtures/` — and when
option A merges a behind PR as it is or updates it, and a journal-only
conflict renumbered against a local bare repository; nothing goes to GitHub).
`tests/unit/renumber-migrations.test.ts` covers the renumbering script itself.
CI runs it in the
`scope` job; locally it needs bash 4+ and jq (macOS: `brew install bash jq`).

## Triggers

A PR labelled `ready-for-staging` / `staging-fix`, and every push to
`staging`. Once this workflow is also on `main` (it travels with the next
production release): an hourly safety net, closing a pause issue, and
Actions → Staging queue → Run workflow (with a dry-run option). Only one queue
run works at a time; it keeps going until nothing is left.
