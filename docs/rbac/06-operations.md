# Phase 6 — Operations (built 22-Nov-2026, IST)

Owner's brief §5 (Operations Manager) and §6 (Operations User). This phase was built in its own session, split off from the main RBAC session at 22.40 IST by agreement. The branch is `feature/rbac-v2-operations`, cut from Phase 2 (`feature/rbac-unified-roles`).

Everything here sits behind the flag **`rbac_v2_operations`**. Migration 0170 seeds it **OFF**, and it can be limited to some roles with `feature_flags.role_scope`. While it is off, every API in this phase answers "not available", the `/staff/operations` screens send the viewer back to `/staff`, and the rest of the site behaves as before.

## What was built

| Feature | Who | Where |
|---|---|---|
| Tasks: create and assign (kinds: shop onboarding, customer onboarding, follow-up, documents, other; priority; due date; optional shop and zone) | Operations Manager | `createOpsTask`; `POST /api/staff/operations/tasks` |
| The assignee is notified when a task is assigned or reassigned (in-app + e-mail, `staff.task_assigned`). The notice is sent after the change commits. | — | `notify(STAFF_TASK_ASSIGNED)` |
| Work a task: start, note, follow-up date, done (an outcome is required) | Assignee (or manager) | `updateOpsTask`; `PATCH /api/staff/operations/tasks/{id}` |
| Cancel or reopen a task (a reason is required); reassign | Operations Manager only | same `PATCH`; `POST /api/staff/operations/tasks/{id}` |
| Task history: every change is one row; UPDATE and DELETE are blocked by a trigger | everyone who can see the task | `ops_task_events` |
| Team: members, their zones, open, overdue and done-in-7-days counts | Operations Manager | `listOpsTeam`; `GET /api/staff/operations/team` |
| Zones: give an Operations User a franchise zone, or take it away (the row is ended, never deleted) | Operations Manager | `assignZone` / `endZoneAssignment`; `POST` / `DELETE /api/staff/operations/team` |
| Customer onboarding assist: record an enquiry, mark "helped to sign in" or "not interested". The assist is linked automatically to the account the customer opens. | Operations User (own); Manager (all) | `createCustomerAssist` …; `/api/staff/operations/customers` |
| Operations User "Today" screen: own tasks (open, overdue, due today, follow-ups due, done today), own onboarded shops (live, pending, documents missing, fee unpaid), own customers, own zones | Operations User | `getOpsUserDashboard`; `/staff/operations` |
| Shop onboarding monitor: registered, new, pending, under verification, auto-approved, manually approved, rejected, active and inactive; by franchise zone, dealer, team lead and agent; daily (14 days) and weekly (8 weeks) trends | Operations Manager | `getShopOnboardingMonitor`; `GET …/reports?kind=shops` |
| Customer onboarding monitor: total, new today, new this week, active and inactive; by source (Operations-assisted, dealer code, referral, direct) and by zone | Operations Manager | `getCustomerOnboardingMonitor`; `GET …/reports?kind=customers` |
| Daily and weekly report: shops contacted, registered, verified and activated; customers onboarded; follow-ups; tasks done; pending registrations; overdue tasks. Per Operations User and per zone, in IST days and Monday-to-Sunday weeks. | Operations Manager | `getOpsActivityReport`; `GET …/reports?kind=activity` |
| Excel download of all of the above (11 sheets) | Operations Manager | `buildOpsReportWorkbook`; `GET …/reports?kind=excel` |
| Screens: one Theme 1 tile page per role, with tabs. Manager tabs: Overview, Tasks, Team & zones, Reports, Customers. User tabs: Today, My tasks, Customers. Plus a task page. | both | `src/app/staff/operations/**`, `src/components/staff/operations-desk.tsx` |
| For Phase 7 (other session): `getOpsTask(id)` returns `{ id, assigneeUserId, shopId }`. The task page also links to `/support?new=1&shopId=…&opsTaskId=…` when `rbac_v2_support` is on for the viewer. | — | `src/server/rbac-operations/tasks.ts` |

Shop onboarding itself is **unchanged**. An Operations User registers shops through the existing `/operator` flow (`operator-limited.ts`, Phase 2 `WORKS_HERE`), with the owner's consent code. Auto-approval on GST/PAN plus payment runs exactly as before. Phase 6 only reads shops (`onboarded_by_user_id`, status, lifecycle, `auto_approved_at`) and points tasks at them.

## Backend enforcement (brief §11)

`src/server/rbac-operations/access.ts` `requireOps()` runs first in every function:

1. **The flag.** `rbac_v2_operations` must be on for the actor's role.
2. **The capability.** Each function needs one of these:

   | Need | Capability | Held by |
   |---|---|---|
   | manage | `ops-team:manage` | Operations Manager, Admin |
   | report | `ops-report:view` | Operations Manager, Admin |
   | work | `ops-task:work:own` | Operations User |
   | assist | `customer-onboard:assist` | Operations User |

   A refusal is audit-logged as `authz.denied`, through the Phase 2 `logDenied`.
3. **Data scope.** An Operations User reads and works only tasks assigned to them, and only customer assists they recorded. Shop search covers only shops they onboarded. Reaching for anyone else's record is refused and logged.

Tests: `tests/integration/rbac-v2-operations.test.ts` (20 tests) covers:
- the flag off, and a role-scoped flag;
- refusals for the Customer, Support User and Accountant roles, and for an Operations User reaching manager functions;
- own-task scope;
- cancel and reopen limited to the manager;
- reassignment and its notification;
- append-only history;
- zones;
- assist linking by e-mail and by mobile, and no claim on an existing account;
- the monitors and their breakdowns;
- the day and week report, the Excel export, and the IST week bounds;
- the Operations User dashboard scope.

Local run on 22-Nov-2026 at 22.58 IST: **39/39 passed**, together with Phase 2's 19 tests.

## Database (`drizzle/0175_rbac_v2_operations.sql`) — all Additive

| Change | Type |
|---|---|
| `ops_zone_assignments` (user, franchise zone, assigned/ended by and at, active; one active row per user + zone) | Additive |
| `ops_tasks` (kind, title, notes, status, priority, assignee, creator, optional shop / customer / assist / zone, due, follow-up, completed, outcome) | Additive |
| `ops_task_events` + trigger `ops_task_events_append_only` (UPDATE/DELETE raise) | Additive |
| `ops_customer_assists` (Operations User, customer name, e-mail or mobile, pincode, zone derived from `franchise_areas`, status, linked account) | Additive |

No foreign keys to users, shops or zones (single-database rule: links are checked in the service). No existing table, column or row is changed. Safe to re-run.

**Migration order.** Drizzle applies a migration only if its journal `when` is later than the last one applied. 0175 uses `when = 1793267500000`. The other session's 0171–0174 must either land on a database first, or carry a smaller `when` and be merged before this PR. When this branch is rebased, check that 0175's `when` is the largest in the journal.

## Decisions (made instead of stopping; brief §0.2)

| ID | Time (IST) | Decision |
|---|---|---|
| D6-01 | 22-Nov 22.45 | **Operations team.** Until the shared `staff_team_members` table (other session, 0172) is merged, "the team" is every active Operations User. Each manager sees all Operations Users. Switching to `staff_team_members` is a change to `listOpsTeam` only. |
| D6-02 | 22-Nov 22.45 | **Customer onboarding with OTP.** The login mechanism is not touched (brief §0.3). The customer signs in on their own phone with GoKesari's normal e-mailed code. The assist is then linked to an account whose e-mail or mobile matches and that was created after the assist. No account is created and no message is sent from the Operations screens. The link is made when assists are read (lists, dashboard, reports), so there is no sign-up hook and no cron. |
| D6-03 | 22-Nov 22.45 | **Report status definitions.** "Under verification" = pending approval with documents and fee done (lifecycle VERIFIED). "Pending" = documents or fee still outstanding. "Auto-approved" = `auto_approved_at` set. "Manually approved" = approved by a person. A customer is "active" if they placed an order in the last 90 days. A customer's zone comes from the franchise zone of their default (else latest) address pincode. |
| D6-04 | 22-Nov 22.45 | **"Shops contacted".** These are distinct shops on tasks the user acted on in the period. There is no separate call log; a follow-up event counts as a follow-up call. |
| D6-05 | 22-Nov 22.45 | **Reports are computed live when asked.** No snapshot table and no cron (brief §5.4: "event-driven, not a fixed cron where avoidable"). **PDF is not built.** The Excel export covers the same data. A PDF download is listed as open. |
| D6-06 | 22-Nov 22.45 | **Audit.** The task history (`ops_task_events`, append-only) and the zone rows (ended, never deleted) are this phase's audit trail. No new `AUDIT_ACTIONS` were added, which keeps `services/audit.ts` free of a merge clash with the other session. |
| D6-07 | 22-Nov 22.45 | **Menus.** The screens live under `/staff/operations`, as agreed with the main RBAC session. That session edits the "ops" tile in `src/lib/board/rbac-menus.ts`. |
| D6-08 | 22-Nov 22.45 | **Mobile.** The Android app already opens `/staff/*` in the app (Phase 2, `mobile/app.config.ts`), and iOS opens every path. `/staff/operations` therefore works in both apps with no app change, from the next APK build for Android. GPS and photo capture during shop onboarding stay with the existing `/operator` onboarding flow. Phase 6 adds no camera or location code. |

## Open items

- **PDF export** of the Operations report (Excel is built).
- **Real team membership** from `staff_team_members` (D6-01), once 0172 is merged.
- **Menu tile.** The other session updates the "ops" tile in `rbac-menus.ts` to point at `/staff/operations` (D6-07).
- **Testing on test.gokesari.com and on gokesari.com.** Both are Not Started. The PR goes into the staging queue after PR #485 is staging-verified, as agreed.

## Rollback

Each step is the fallback if the one before does not resolve it:

1. **Switch the flag off.** Turn off `rbac_v2_operations` (or narrow its role scope). Every Operations API answers "not available" and the screens redirect.
2. **Revert the code.** Revert the PR. The four tables are then unused.
3. **Drop the tables.** Run `scripts/rollback-0175.sql` after exporting `ops_task_events` if its history must be kept. This drops the four tables and the trigger function.
