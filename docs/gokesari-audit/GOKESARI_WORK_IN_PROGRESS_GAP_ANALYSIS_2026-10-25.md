# GoKesari: work in progress and gap analysis

As of 25 Oct 2026, 03:50 UTC (09:20 IST). Covers local (this cloud session and the owner's Mac), staging (test.gokesari.com) and main (gokesari.com). Workbook with the same content: `GOKESARI_WORK_IN_PROGRESS_GAP_ANALYSIS_2026-10-25.xlsx`.

## 1. Where each line stands

| Where | Branch / place | Commit | Latest migration | Note |
|---|---|---|---|---|
| gokesari.com (production) | main | 4a32386 | 0091 | Release #249 (25 Oct 01:48 UTC). Hostinger deploys main. |
| test.gokesari.com (staging) | staging | 438ab04 | 0091 | Merge of #253 (25 Oct 03:27 UTC). Hostinger deploys staging. |
| Local: this cloud session | claude/laughing-brown-c0vkcu (PR #251) | f952207 | 0091 | Working tree clean, nothing unpushed. staging merged in. |
| Local: owner's Mac | (not visible from the cloud) | - | - | Two sessions left Mac-only work to commit (section 5). |

## 2. Gap: local vs staging vs main

| Change | Kind | Local / open PR | staging (test) | main (prod) | Gap / action |
|---|---|---|---|---|---|
| Dates in India time everywhere: client components (React #418) and server pages (UTC times) | Code + test | PR #251 | No | No | Merge #251 into staging, test, then release |
| Voucher Excel upload refuses a past end date (TC-FLD-114, D-105) | Code + test | PR #251 | No | No | Same as above; re-test TC-FLD-114 after deploy |
| Owner decisions 25 Oct: D-103, D-57, D-91, D-25, D-96, D-23, D-69 | Code + migrations 0092-0094 | PR #254 | No | No | Merge #254; migrations run on test first, then production |
| Seven open bugs GAP-011 to GAP-019 (#250) | Code | - | Yes | No | Release staging -> main (no release PR open) |
| QA: staging re-tests of cart/checkout races D-102 (#252) | Docs | - | Yes | No | Goes with the next release |
| QA: production retest after #248; incident note E-02 (#253) | Docs | - | Yes | No | Goes with the next release; E-02 is Open (owner decision) |
| Feature status report 21 Oct (#223, merged straight into main) | Docs | - | No | Yes | Bring main back into staging (docs only) |
| Cart concurrent adds D-102 (#241, #243) and IST vouchers D-101 (#246) | Code | - | Yes | Yes | None - in both |
| .claude/settings.json permission allowlist (branch claude/permissions-allowlist) | Config | Owner's Mac only | No | No | Not on GitHub: run the commit on the Mac, open a PR |
| GoKesari spreadsheets on the Mac (session 'Moving local code to Claude Cloud', 1 Oct) | Docs | Owner's Mac only | No | No | Unanswered: copy into docs/ and push, or drop |

## 3. Open pull requests

| PR | Title | Base | State | CI | Mergeable | Migrations | Session |
|---|---|---|---|---|---|---|---|
| #251 | Dates in India time everywhere (React #418, UTC on server pages) + voucher upload past end date (TC-FLD-114) | staging | Draft | Green on 991fd2a; re-running on f952207 (staging merged in) | Yes (conflict in qa-defects.json resolved) | None | Pin India time in all client-side date formatting (this session) |
| #254 | Owner decisions of 25 Oct: D-103, D-57, D-91, D-25, D-96, D-23, D-69 | staging | Draft | test-split green; test running (03:40 UTC) | Yes; no conflict with #251 | 0092, 0093, 0094 | Feature status review and update #PR250+ |
| (none) | Release staging -> main | main | Not opened | - | - | - | 3 commits waiting (section 2) |

## 4. Branches on GitHub with work not in staging

| Branch | Commits not in staging | Last commit | PR | Verdict |
|---|---|---|---|---|
| claude/laughing-brown-c0vkcu | 3 (+ merge) | 25 Oct | #251 open | Active - this session |
| claude/peaceful-pascal-jai8w2 | 8 | 25 Oct | #254 open | Active - waiting for CI |
| claude/trusting-allen-97xhex | 1 | 19 Oct | #212 closed, not merged | Superseded: staging fixes the same partition-identity problem differently (#211). Safe to delete |
| claude/serene-gates-7cymxj | 2 | 9 Oct | #121 squash-merged | Already in staging (sign-in consent box, 9 Oct report). Safe to delete |
| claude/busy-euler-5ipjns | 1 | 9 Oct | - | Same patch already in staging. Safe to delete |
| claude/tile-board-ui | 1 (WIP) | 9 Oct | none | Superseded by the shipped Tile Board (#112, #114). Safe to delete |
| claude/awesome-dijkstra-fmccpl | 18 | 3 Oct | #26 closed, not merged | Abandoned PostgreSQL -> MySQL port; the site stays on PostgreSQL. Delete or keep as archive |
| claude/amazing-cannon-5n3fro | 1 | 2 Oct | #27 closed, not merged | Old docs fix (deployment docs pointed at bkesari). Check docs, then delete |

## 5. Sessions in progress or waiting

| Session | Status | Last update (UTC) | Branch | State on GitHub | Waiting on | Suggested action |
|---|---|---|---|---|---|---|
| Pin India time in all client-side date formatting (this session) | Running | 25 Oct 03:40 | claude/laughing-brown-c0vkcu | PR #251 open | CI, then your review | Mark #251 ready and merge |
| Feature status review and update #PR250+ | Idle - review ready | 25 Oct 03:22 | claude/peaceful-pascal-jai8w2 | PR #254 open | CI | Review #254; plan migrations 0092-0094 |
| Fix cart add race (D-99): 500 and lost units | Idle - review ready | 25 Oct 02:27 | claude/serene-curie-pwjjh2 | #240 closed, #252 merged | Its scheduled TC-FLD-114 voucher re-test at 19:00 UTC today | Let the re-test run after #251 is on test.gokesari.com |
| Gokesari.com test automation | Idle - done | 25 Oct 03:27 | claude/hopeful-cerf-x2gaow | #253 merged | - | Nothing; can be archived |
| Frequent "allow once" prompts | Idle - done (Mac step left) | 25 Oct 03:40 | claude/permissions-allowlist (Mac) | Not on GitHub | You: run the given commands on the Mac | Commit .claude/settings.json on the Mac and open a PR (yet to commit) |
| PostgreSQL frequent downtime | Idle - needs input | 24 Oct 21:30 | - | No code | You: which site, and what 'down' looks like | Answer it; it can then read Neon operations and logs |
| List all site cookies in the Cookie Policy | Idle - done | 25 Oct 01:48 | claude/confident-goldberg-c86f6q | #236, #249 merged | - | Archive |
| MySQL to PostgreSQL migration (release #245) | Idle - done | 24 Oct 20:30 | claude/focused-carson-4pa1e2 | #245 closed (superseded by #242) | - | Archive |
| Hostinger plugin installation (www redirect #224) | Idle - done | 24 Oct 21:07 | claude/hostinger-plugin-install-4js2f8 | #224 merged | - | Archive |
| Hostinger plugin installation (20 Oct) | Idle - needs input | 20 Oct 19:08 | - | No code | Approval of a .claude/settings.json edit | Superseded by the allowlist session; archive |
| DB Split | Idle - done | 21 Oct 00:44 | claude/vigilant-wright-0oyy7r | #222 merged | - | Archive |
| Inventory & Accounting module for shop owners | Idle - needs input | 15 Oct 18:27 | claude/nice-cori-6p1wb2 | #171, #172, #182 merged; released via #179 | An open 'Should I do it?' question | Read its last message; answer or archive |
| GitHub billing messages issue | Idle - needs input | 11 Oct 02:39 | claude/pensive-sagan-7kcr92 | - | PROD_DATABASE_URL secret / prod DB password reset | Confirm it was done (prod releases have run since), then archive |
| Older sessions, 3-14 Oct (crons not firing x2, Google Maps key, domain access, db:migrate output, deployment SQL scripts, mobile app, current location/login) | Idle - needs input / review ready | 3-14 Oct | various | Merged or no code | Old questions | Very likely overtaken by later releases; check, then archive |
| Older Mac sessions, 28 Sep-1 Oct (mobile login/OTP 'push staging?', Turbopack crash, git merge steps, gokesari.com not opening, moving local code to the cloud) | Idle | 28 Sep-2 Oct | Mac / various | - | Old questions; spreadsheets on the Mac | Archive; decide on the Mac spreadsheets |
| 27 other GoKesari sessions, 6-21 Oct | Idle - done | 6-21 Oct | various | Their PRs merged | - | Nothing pending; can be archived |

## Recommended next steps

1. Merge #251 (CI re-running on the staging merge) and #254 into staging. Run migrations 0092-0094 on test.gokesari.com; they run on build (MIGRATE_ON_BUILD).
2. Re-test on test.gokesari.com: TC-FLD-114 (also the Excel upload), TC-CART-001, dates on order, wallet and admin pages, and #254's D-items.
3. Open one release PR staging -> main covering #250, #251, #252, #253 and #254. Apply production migrations in an approved window, one deploy at a time (E-02).
4. Bring main's 21 Oct status report (#223) back into staging so the two stay level.
5. On the Mac: commit the .claude/settings.json allowlist (claude/permissions-allowlist), and decide on the GoKesari spreadsheets from the 1 Oct session.
6. Delete the 6 stale branches in section 4, and archive the finished sessions in section 5.

## Notes

- Scope: GoKesari only. Sessions for other projects (Ladwani, Education, ATIP, Bkesari) are left out of this list as CLAUDE.md requires.
- Comparisons use the full git history (the cloud clone was shallow at first and showed false gaps of 100+ commits).
- 'Commits not in staging' counts changes whose patch is not already in staging (git cherry), so squash-merged work counts as merged.
- Which commit each site actually runs was not checked: the sites have no version endpoint, and the Hostinger connector needs authorising in claude.ai connector settings. The table assumes each site runs the head of its branch.
- Release order: E-02 (25 Oct) showed two overlapping deploys stopped gokesari.com for about 14 minutes. Release one PR at a time, and check the site after each deploy.
- 34 branches named by sessions are no longer on GitHub: deleted after their PR merged, or the session wrote no code (checked for the two unclear GoKesari ones).
