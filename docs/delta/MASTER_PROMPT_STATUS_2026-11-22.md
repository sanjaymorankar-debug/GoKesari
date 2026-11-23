# Delta run: Master Prompt Status Report and registers

**Prompt received:** 22-Nov-2026, 22.54 IST · **Survey:** 22.57–23.01 IST · All times IST (UTC + 5:30)
**Conflict Register:** [CONFLICT_REGISTER_2026-11-22.md](CONFLICT_REGISTER_2026-11-22.md)

## Overall verdict: PARTIALLY DEVELOPED, and actively in progress elsewhere

The master prompt's seven-role scope (RBAC v2: Accountant, Support Manager, Support
User, Operations Manager, Operations User, plus the CA and shop owner) **is being
built right now by other sessions**. There are commits at 22.23, 22.56 and 22.57
IST today, and uncommitted edits in `/Users/agtci/GoKesari-rbac-ops`. Every
remaining item from the gap workbook is one of the following: already merged,
in flight, blocked on an owner input, deferred by the owner, or on the delta
prompt's own conflict list (Part D.2).

**This run found no NEW-UNCLAIMED feature, so it built nothing.** It created no
branch, commit, migration, flag or mobile change. Per Part C, "if unsure, CONFLICT-HOLD".

**Input gap:** the master prompt (attachment 1) was not received; only the gap
workbook is in the repo. Its Parts 3–8 were read through
`docs/rbac/01-assessment.md` (the brief as received 22-Nov 21.56) and the gap
workbook.

---

## 1. Step 1: repository survey (Part B)

| Check | Result |
|---|---|
| `git fetch --all --prune --tags` | Done 22.58. `origin/staging` moved `c068411f → c34ef9e8` (PR #484). |
| Local checkout `/Users/agtci/GoKesari` | Branch `main` at `aabc8ac4`, far behind `origin/main` `bd927331`. Left untouched. |
| Uncommitted / untracked | Untracked only: `.claude/launch.json`, 2 workbooks in `docs/gokesari-audit/`, `docs/testing/manual/`, `scripts/qa/build-manual-workbook.ts`, `tests/Load_Testing/`. Not touched. |
| Stashes | 1: `stash@{0}` "SD screenshots overwritten by the 31 Oct staging run" (from `qa/opg-phase1-staging`). Not touched. |
| Worktrees | `GoKesari-rbac` → `feature/rbac-v2-phases-3-7`; `GoKesari-rbac-ops` → `feature/rbac-v2-operations` (4 modified files in `src/server/rbac-operations/`); `.claude/worktrees/gs-analysis` → `fix/482-guest-access-2026-11-22`. |
| Remote branches | 238 in total; 145 have had no commit for over 14 days; 70 are `claude/*` session branches. All `claude/*` branches are older than 14 days with no open PR (STALE). |
| Open PRs | **1: #485** `feature/rbac-unified-roles → staging`, "RBAC v2 Phase 2…", label `ready-for-staging`, updated 22.29. No drafts. |
| Merged PRs, last 60 days | 200+ (the list limit was reached). Latest: #484 (22.50, staging), #481 (19.12, main). |
| CI running / queued (23.00) | CI on `staging` (in progress, 22.50); Staging queue for `fix/482-guest-access` (pending, 22.50) and earlier (in progress, 22.08); CI on `feature/rbac-unified-roles` (in progress, 22.29). |
| Commit-message search | Master-prompt hits only on the RBAC branches: `0c7074a4` Phase 1, `128a6284` Phase 2, `cbb39541` Phase 3, `7292a0e4` Phases 4/5/7, `89f1b78a` + `aee92e90` Phase 6. No SEC-0x/DEF-0x/WP6–10 commits after 19-Oct. |

### Active branches (last 14 days, top 16 by date)

| Branch | Last commit (IST) | vs origin/staging (behind / ahead) | vs origin/main (behind / ahead) |
|---|---|---|---|
| feature/rbac-v2-operations | 22-Nov 22.57 | 2 / 4 | 17 / 19 |
| feature/rbac-v2-phases-3-7 | 22-Nov 22.56 | 2 / 4 | 17 / 19 |
| staging | 22-Nov 22.50 | 0 / 0 | 17 / 17 |
| feature/rbac-unified-roles (PR #485) | 22-Nov 22.23 | 2 / 2 | 17 / 17 |
| fix/482-guest-access-2026-11-22 | 22-Nov 22.08 | 1 / 0 | 17 / 16 |
| feat/smart-list-shop-photo-whatsapp-2026-11-22 | 22-Nov 20.25 | 5 / 0 | 17 / 12 |
| main | 22-Nov 19.12 | 17 / 17 | 0 / 0 |
| qa/staging-rider-returns-support-2026-11-22 | 22-Nov 18.45 | 16 / 0 | 17 / 1 |
| feat/dealer-docs-online-verify-2026-11-22 | 22-Nov 16.47 | 18 / 0 | 18 / 0 |
| feat/doctor-registration-rule-off-2026-11-22 | 22-Nov 15.21 | 20 / 0 | 20 / 0 |
| feat/franchise-free-or-paid-2026-11-22 | 22-Nov 14.09 | 26 / 0 | 26 / 0 |
| docs/df09-owner-90-days-2026-11-22 | 22-Nov 14.08 | 26 / 0 | 26 / 0 |
| release/2026-11-22-doc-rules-471 | 22-Nov 13.01 | 27 / 0 | 27 / 0 |
| feat/shop-document-rules-admin-2026-11-22 | 22-Nov 11.58 | 28 / 0 | 28 / 0 |
| release/2026-11-22-referral-moves-470 | 22-Nov 11.57 | 33 / 0 | 33 / 0 |
| feat/referral-code-moves-2026-11-22 | 22-Nov 10.26 | 38 / 0 | 38 / 0 |

All branches are authored by sanjaymorankar-debug (the sessions commit as the owner's account).

## 2. Master Prompt Status Report

| Master Part | Feature | Verdict | Evidence | Branch / PR | Last activity (IST) |
|---|---|---|---|---|---|
| 3 (RBAC Ph 1) | Existing-code assessment | DONE on branch | `0c7074a4`, `docs/rbac/01-assessment.md` | PR #485 | 22-Nov 22.10 |
| 3 (RBAC Ph 2) | 5 new roles, permission matrix, denied logging, role-scoped flags, approval engine, two-admin approval, staff board | IN-FLIGHT | `128a6284`, migration `0170`, `src/server/approvals/` | PR #485 (in the staging queue) | 22-Nov 22.29 |
| 3 / 4 (Ph 3) | Accountant: journals, periods, rate proposals | IN-FLIGHT | `cbb39541` | feature/rbac-v2-phases-3-7 | 22-Nov 22.56 |
| 5 (Ph 4) | Support Manager / Support User desk, SLA, assignment | IN-FLIGHT | `7292a0e4`, `tests/integration/rbac-v2-support.test.ts` | feature/rbac-v2-phases-3-7 | 22-Nov 22.56 |
| 5 (Ph 5) | Shop-owner change requests and change history | IN-FLIGHT | `7292a0e4` | feature/rbac-v2-phases-3-7 | 22-Nov 22.56 |
| 6 (Ph 6) | Operations Manager / User: tasks, zones, customer assists, reports | IN-FLIGHT | `89f1b78a`, `aee92e90`, plus uncommitted work | feature/rbac-v2-operations | 22-Nov 22.57 |
| 6 (Ph 7) | Operations → Support handover | IN-FLIGHT | `7292a0e4` | feature/rbac-v2-phases-3-7 | 22-Nov 22.56 |
| 3 | Admin maker-checker user invite | IN-FLIGHT | Assessment §4 item 5; four-eye in PR #485 | PR #485 | 22-Nov 22.29 |
| 7 / 8 (Ph 8) | Mobile parity (path prefixes, APK) | IN-FLIGHT | `/staff` prefix in `mobile/app.config.ts` (PR #485) | PR #485 + later phases | 22-Nov 22.29 |
| 8 (Ph 9) | Regression, Test → Prod, reports | IN-FLIGHT (pending, claimed) | `docs/rbac/README.md` status table | same sessions | n/a |
| Roadmap 7 | Pickup QR, offer expiry/re-offer, broadcast, load-based dispatch | DONE-MERGED (flags OFF) | Gap sheet 2 row 7; sheet 4 (GAP-001, GA-005, GAP-004) | main | before 19-Oct |
| Roadmap 7 | GAP-003 signature capture | DEFERRED (owner, Phase 2) | Gap sheet 3; no code on main | n/a | n/a |
| Roadmap 6 | Accept/reject SLA, substitution, auto-assign on READY | DONE-MERGED | GS-034..036, NEW-007, D-147 fix 09-Nov | main | 09-Nov |
| n/a | Consolidated development tracker | IN-FLIGHT | `docs/rbac/tracker.json`, `scripts/rbac/build-tracker.ts` | PR #485 | 22-Nov 22.29 |

## 3. In-Flight Development Register

| # | Item | Where | Owner | Status | Note for the owner |
|---|---|---|---|---|---|
| IF-01 | RBAC v2 Phase 2 | PR #485 | RBAC session | ready-for-staging; CI running | Stop gate G1 (two-admin approval switch-on) is your decision |
| IF-02 | RBAC v2 Phases 3, 4, 5, 7 + documents | feature/rbac-v2-phases-3-7 (worktree `GoKesari-rbac`) | RBAC session | Committing; no PR yet | G2 rate workflow (additive path), G3 ticket-status mapping |
| IF-03 | RBAC v2 Phase 6 Operations | feature/rbac-v2-operations (worktree `GoKesari-rbac-ops`) | RBAC ops session | Committing; uncommitted edits | Overlaps CF-008 (WP7) |
| IF-04 | Guest access fix for #482 | fix/482-guest-access (PR #484 merged 22.50) | Smart-shopping session | Staging queue running | Production in the 23.00 window |
| IF-05 | Smart shopping list | PR #482 | Smart-shopping session | Release path; 7 rows blocked on keys | ANTHROPIC_API_KEY, WhatsApp keys |
| IF-06 | QA re-tests (41 fixed defects), rider returns/support | qa/staging-rider-returns-support | QA sessions | Branch activity at 18.45 | n/a |
| IF-07 | Franchise (4 rows), Health (3), Puja (1), Smart (1), Guest (9) In Progress rows | Trackers in `Devlopment_Trackers` | Other sessions | In Progress | Rows left untouched |

Open owner questions raised by the RBAC sessions (answer there, not here): Q1–Q9 in `docs/rbac/01-assessment.md` §9.

## 4. Classification of every feature (Part C / Part H)

| Class | Count | Items |
|---|---|---|
| DONE-MERGED | 258 of 267 baseline + new scope that is live | 247 completed on 19-Oct, plus 11 closed since (GAP-008, 010, 011, 012, 013, 014, 016, 017, 018, 019, PLT-015). Roadmap phases 1a, 1b, 2 (build), 3, 5, 6, 11. Built-but-OFF items (34; sheet 4) count here: switching them on is the owner's act. |
| IN-FLIGHT | 7 | IF-01 … IF-07 (the RBAC master prompt Parts 3–8 are all inside IF-01–IF-03) |
| BLOCKED | 14 | See section 6 |
| DEFERRED | 2 | GS-023 (dropped, owner); GAP-003 signature capture (Phase 2, owner) |
| CONFLICT-HOLD | 16 | CF-001 … CF-016 |
| NEW-UNCLAIMED | **0** | n/a |
| COMPLETED (this run) | **0** | n/a |

## 5. Delta Build, Wiring, zero-deletion proof, migrations (Part I items 4–7)

- **Delta Build Register:** empty. No feature was built.
- **Wiring Register:** empty. No existing file was touched.
- **Zero-deletion proof:** no `feat/delta-*` branch exists, so there is no diff to measure. The only new files are these two documents under `docs/delta/` (uncommitted) and the tracker workbook in `Devlopment_Trackers`.
- **New migrations / rollback scripts:** none.
- **Mobile (G.1):** no mobile change, no version bump. Store publishing stays BLOCKED (PLT-017, NEW-043).

## 6. Blocked-dependency list (exact owner input required)

| # | Item | Input required from the owner |
|---|---|---|
| B-01 | SMS sign-in OTP, SMS/WhatsApp (WP9, GS-074) | DLT registration + SMS vendor account and keys |
| B-02 | Email capacity (GAP-009) | Choose a transactional e-mail provider or a higher limit; SPF/DKIM for the domain |
| B-03 | GST/HSN report and Billing v2 switch-on (NEW-027, 7 flags) | CA answers B2/B3 (HSN, GST rates, bill-of-supply wording, numbering); GSP choice |
| B-04 | Online payments live (GS-028 etc.) | Cashfree ₹1 live tests, dashboard webhooks, IP whitelisting, payout keys |
| B-05 | Bank payouts, fee invoices (GAP-005/006) | Payout keys + GSTIN / legal entity details |
| B-06 | Shop prepaid wallet (NEW-033/034) | Lawyer's review |
| B-07 | Legal docs / bank check rules (NEW-040/041/049/050) | Cashfree Verification Suite keys + switch-on |
| B-08 | Pickup QR (GAP-001) | `PICKUP_QR_SECRET` + switch-on |
| B-09 | Smart list AI + WhatsApp | `ANTHROPIC_API_KEY` on test/prod; Meta WhatsApp keys |
| B-10 | iPhone TestFlight (PLT-017) | `EXPO_TOKEN`, Apple Developer keys, App Store Connect record |
| B-11 | Store publishing (NEW-043) | Play Console + App Store accounts; publish decision |
| B-12 | Production order-lifecycle run (QA-009) | A production shop + rider, and the owner paying a real top-up |
| B-13 | Vocestry voice shopping | A public API from the vendor (none exists) |
| B-14 | Legal: retention, Shop Act, Grievance Officer | Lawyer / owner details |

## 7. Testing report (Part G.3)

| Test ID | Feature | Env | Command | Result | Time (IST) |
|---|---|---|---|---|---|
| DT-01 | Delta build regression | Local | `npm test` | **Not Run**: nothing was built, so no change to test | n/a |
| DT-02 | Flags-OFF smoke on staging | Test | post-deploy check | **Not Run**: no delta deployment | n/a |
| DT-03 | Flags-ON on staging | Test | n/a | **Not Run**: no delta deployment | n/a |
| DT-04 | Read-only prod smoke | Prod | n/a | **Not Run**: awaiting deployment authorization | n/a |
| CF-001 … CF-016 | Conflict features | n/a | n/a | **Not Developed: Pending Owner Feedback** | n/a |

Independent QA by ChatGPT remains separate.

## 8. Staging deployment and rollback

There is nothing to deploy from this run. The RBAC sessions own their own staging
and rollback steps (`docs/rbac/02-phase2-foundation.md`; `scripts/rollback-0170.sql`).

## 9. Closing summary

**Counts:** DONE-MERGED 258 (+ live new scope) · IN-FLIGHT 7 · BLOCKED 14 · DEFERRED 2 · CONFLICT-HOLD 16 · COMPLETED 0.

**Top 10 conflict features by business priority**

1. CF-013 Guest shopping / Smart overlap: customer growth
2. CF-015 R2/R3 defects: user-visible quality
3. CF-004 RECONCILED / CHARGEBACK: money accuracy once Cashfree is live
4. CF-001 SEC-06: security
5. CF-007 WP6 referral help by PIN: shop sign-ups
6. CF-011 D-144 logo upload: shop look
7. CF-006 Society rider join requests
8. CF-002 OPERATOR remap: after RBAC v2 is live
9. CF-003 Order-state additions: after D8
10. CF-009 Hindi/Marathi inner pages

**Decisions needed for the next run**

1. Send the master prompt text (attachment 1), above all the definition of SEC-06.
2. Fill in Owner Decision / Feedback / Target Release in the Conflict Register.
3. D8 (order and payment states) and the settlement model (CF-003, CF-004).
4. Product decisions: society rider join (CF-006), turn-by-turn navigation (CF-005), tile board #34 (CF-016).
5. Guest shopping D-02/D-03 after #482 is on production (CF-013).
6. Name the Hindi/Marathi reviewers (CF-009).
7. RBAC stop gates G1–G3 and Q1–Q9, raised by the RBAC sessions.
