# RBAC v2 — Testing report

Report date: 22-Nov-2026, 23.56 IST. All times are IST.

| Server | Status |
|---|---|
| Local / CI | Done — results below |
| test.gokesari.com | **Not Started.** The code is not on staging yet: #485 is queued in the staging queue and #487 waits for it. |
| gokesari.com | **Not Started.** Production follows staging verification, in the 23.00 IST window. |

## 1. Runs

| # | When (IST) | Where | Code | Scope | Result |
|---|---|---|---|---|---|
| R1 | 22-Nov 22.19 | Local PostgreSQL 18, migrated 0001–0170 | Phase 2 | `rbac-v2.test.ts` | **19 / 19 passed** |
| R2 | 22-Nov 22.33 | Local | Phase 2 | Regression: every suite touching roles, users, flags, guards, permissions, operator-limited and helpdesk (53 files) | **700 / 700 passed** |
| R3 | 22-Nov 22.48 | Local, migrated to 0171 | Phase 3 | `rbac-v2` + `rbac-v2-accounting` | **31 / 31 passed** (after 3 test-harness fixes: wrapped DB error text, missing table resets, message wording) |
| R4 | 22-Nov 22.56 | Local, migrated to 0173 | Phases 4, 5, 7, documents | `rbac-v2-support`, `rbac-v2-documents` | **15 / 15 passed** |
| R5 | 22-Nov 22.58 | Local | Phases 3–5 | Regression: helpdesk, catalogue, prices, shops, finance, settings, tile board (22 files) | **360 / 361.** The one failure was the intended menu count (shop board +1, "Pending changes"); the test was updated, then **43 / 43** |
| R6 | 22-Nov 23.13 → 23.51 | **GitHub CI** (Postgres 16, full suite) | #487 head 3883ef9b (Phases 1–7 + documents) | **All 321 files, 4,099 tests** | **4,097 passed, 2 failed** (see §3) |
| R7 | 22-Nov 23.55 | Local, **fresh database** migrated 0001–0174 | 567a22fc (fixes for R6) | Both R6 failures + every RBAC v2 suite (7 files) | **78 / 78 passed** |
| R8 | pending | GitHub CI | #487 head 567a22fc | Full suite | Re-run triggered by the push; Auto-fix reports any failure |

Also run at each step:
- `tsc --noEmit`: clean.
- eslint on changed files: clean, after fixing 4 impure-render findings.
- Android APK builds (preview and production): passed on #485 and #487.

## 2. Test cases per feature (automated; the test file named in each section)

### Phase 2 — roles, permissions, approval engine (`tests/integration/rbac-v2.test.ts`)

| Case | Result |
|---|---|
| The five new roles exist in `user_role` | Pass |
| No new staff role holds any admin-level capability (15 capabilities, each checked for each new role) | Pass |
| Accounting maker / checker split: Accountant prepares, CA approves, only Admin activates | Pass |
| Support Manager queue vs Support User assigned work; only the shop owner decides own changes | Pass |
| Operations User has every Operator-Limited capability but cannot edit approved shop data | Pass |
| Nothing removed from existing roles (CA, Operator, Operator-Limited, Shop owner) | Pass |
| Every role has a permission list | Pass |
| Two-admin: self-approval blocked; a different admin approves; role applied; history SUBMIT → APPROVE → APPLY | Pass |
| A non-admin checker is refused; a rejection needs a comment | Pass |
| Only the requester can cancel | Pass |
| Bootstrap: the Super Admin approves alone while fewer than 2 admins are active; marked single-admin, audited, e-mailed | Pass |
| Bootstrap switches off with a second admin, and never applies to another admin | Pass |
| Emergency suspension applies at once; rejecting the confirmation lifts it | Pass |
| A failed apply is recorded as FAILED with the reason | Pass |
| CA → Admin two-stage approval; the Accountant cannot approve their own | Pass |
| Shop owner partial approval; rejected items never apply | Pass |
| `approval_decisions` refuses UPDATE and DELETE | Pass |
| Refused permission check → one `authz.denied` audit row | Pass |
| Role-scoped flags: off by default, scope limits roles, admin-only, change logged | Pass |

### Phase 3 — accounting (`tests/integration/rbac-v2-accounting.test.ts`)

| Case | Result |
|---|---|
| Refused while `rbac_v2_accounting` is off for the role | Pass |
| An unbalanced entry is refused; a CA or Support User cannot prepare entries | Pass |
| Accountant submits → CA posts; no self-approval; DB refuses edit, line change and delete of a posted entry | Pass |
| A rejected entry is corrected and resubmitted; a withdrawn one returns to draft | Pass |
| High value (≥ ₹50,000): CA, then a different admin | Pass |
| Corrections only by reversal; the trial balance nets to zero | Pass |
| Periods: only the CA closes; nothing is drafted, submitted or posted into a closed month; reopening needs a reason | Pass |
| Rate proposal: commission activated only after CA + admin; untouched before | Pass |
| A future commission is scheduled; the sweep activates it when due | Pass |
| Delivery charge goes through rule `shopWallet`; a rejection leaves it unchanged | Pass |
| Only an Accountant proposes rates | Pass |
| Four-eye on a commission change by one admin | Pass |

### Phases 4, 5, 7 — support desk, change requests, handover (`tests/integration/rbac-v2-support.test.ts`)

| Case | Result |
|---|---|
| A Support User sees only tickets assigned to them; another Support User gets "not found"; no proposal without an assigned ticket; no manager actions | Pass |
| An Operations User raises tickets only for shops they work on | Pass |
| Nothing changes until approved; per-item decision; the rejected item stays as it was; shop-only MRP history appended and append-only; ticket → In Progress | Pass |
| A selling price above MRP is refused | Pass |
| All approved → ticket Resolved; only the raiser (or a manager) confirms → Closed | Pass |
| Superseded when the owner edits the same field; nothing applied from it | Pass |
| Reminders at 24 h and 72 h, once each; expiry after 7 days → Pending Information, nothing applied, no late approval | Pass |
| Master data correction is decided by an admin only | Pass |
| Bulk price list: good rows → one request with many items; bad rows reported with row numbers | Pass |
| Bulk: price above MRP is a row error | Pass |
| Support Manager dashboard: workload per team member; refused to a Support User | Pass |

### Documents (`tests/integration/rbac-v2-documents.test.ts`)

| Case | Result |
|---|---|
| File type from the bytes (an .exe named .pdf is refused); versions kept; a new version resets verification; versions immutable | Pass |
| Only people working on the shop (and its owner) see or add documents; verification by manager or admin only | Pass |
| Download only through a valid, unexpired signed link (a tampered or expired link is refused) | Pass |
| Deletion: never below admin; an admin's request needs a second admin; the versions are removed | Pass |

### Phase 6 — operations (`tests/integration/rbac-v2-operations.test.ts`, built by the parallel session)

**23 cases, all passing.** They cover:
- **Flag and role scope:** refused while `rbac_v2_operations` is off; the flag's role scope is honoured; other roles are refused and each refusal is logged.
- **Tasks:** assign, notify and record history; only active Operations Users and existing shops get tasks; the assignee works a task through to done; each Operations User sees only their own tasks; only a manager cancels or reopens; reassignment notifies the new assignee and moves the scope; task history is append-only.
- **Team scope:** an Operations Manager sees only their own team, an admin sees everyone; Operations Users not yet in a team are listed, and a manager with no team sees nobody.
- **Zones and workload:** zones are assigned, listed and ended with history kept; each member's workload is shown.
- **Customer assists:**
  - an assist links to the account the customer opens afterwards, by e-mail or mobile;
  - a customer who already had an account is not claimed;
  - contact details are validated, and assists stay with their owner.
- **Reports:**
  - shop counts by zone, dealer, team lead and agent;
  - customers by source;
  - the day per Operations User and per zone;
  - Excel export;
  - PDF table layout;
  - IST days and Monday–Sunday weeks.
- **Operations User dashboard:** shows only the user's own tasks, shops and customers.

### Regression of existing GoKesari flows

Full CI suite, R6:
- Covers customer, shop owner, dealer / franchise, rider, order, payment, wallet, auto-approval, notifications, helpdesk, billing and more.
- **4,097 of 4,099 tests passed.** No existing behaviour test failed.
- Both failures were project-consistency checks broken by this PR (§3), fixed and re-run in R7.

## 3. Defects found and fixed

| # | Found (IST) | Where | Defect | Fix | Status |
|---|---|---|---|---|---|
| D1 | 22-Nov 22.42 | R3 | Posted-entry trigger messages are wrapped by drizzle, so the test regex missed them | Test reads the cause | Fixed |
| D2 | 22-Nov 22.42 | R3 | Accounting tables have no FK to users, so they were not reset between tests | Added to `RESET_TABLES` | Fixed |
| D3 | 22-Nov 22.58 | R5 | Shop board menu count 48 → 49 ("Pending changes") | Test updated with the reason | Fixed |
| D4 | 22-Nov 23.51 | R6 (CI) | Migration journal must be contiguous; Phase 6 used 0175 (gap at 0174) | Renumbered to 0174 (`when` unchanged) | Fixed in 567a22fc; R7 passed |
| D5 | 22-Nov 23.51 | R6 (CI) | Cron schedule test pins the job list; new hourly job `rbac-v2` | Added to the expected list | Fixed in 567a22fc; R7 passed |
| D6 | 22-Nov 22.30–22.59 | eslint | `Date.now()` during server render (4 places), `window.location.href` assignment | Moved to server functions / `istToday()` / `location.assign` | Fixed |

## 4. Open items

| Item | Owner / next step |
|---|---|
| Test-server run (test.gokesari.com) | After #485 and #487 deploy. Owner approved all six flags ON on staging (22-Nov), four-eye included. Then signed-in QA with the staging test accounts given the new roles. |
| Production run (gokesari.com) | After staging verification, in the 23.00 IST window, with designated test accounts only. Flags stay OFF unless the owner says otherwise. |
| R8 CI re-run on 567a22fc | Running; Auto-fix watches it |
| Manual / visual checks of the new screens on phone width (Tile Board one-screen rule) | With the test-server run |
| Not built (recorded) | Bank-statement reconciliation; franchise-fee / platform-fee proposals; virus scanner (Q9, needs a server package — owner) |
