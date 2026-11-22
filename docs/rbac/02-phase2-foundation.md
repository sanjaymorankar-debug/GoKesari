# Phase 2 — RBAC foundation (built 22-Nov-2026, IST)

## What was built

| Feature | Where | Flag |
|---|---|---|
| Five staff roles: ACCOUNTANT, SUPPORT_MANAGER, SUPPORT_USER, OPERATIONS_MANAGER, OPERATIONS_USER | `user_role` enum (0170), `src/server/authz/permissions.ts` | none. A role does nothing until an admin assigns it. |
| CA extended (additive): finance view, payments view, journal approve, period close, rate approve | `CA_PERMISSIONS` | the screens arrive in Phase 3 under `rbac_v2_accounting` |
| Shop owner: `shop-change:decide:own` (additive) | `SHOP_OWNER_PERMISSIONS` | `rbac_v2_shop_change_requests` (Phase 5) |
| 21 new capabilities (see below) | `PERMISSIONS` "RBAC v2" block | — |
| Every refused permission, role or shop-ownership check is written to `audit_logs` as `authz.denied` (at most 20 per user per minute) | `src/server/authz/guards.ts` `logDenied` | always on (logging only; responses unchanged) |
| Role-scoped feature flags | `feature_flags.role_scope`, `isFeatureEnabledForRole`, `setFeatureFlagRoleScope` | — |
| Generic approval engine: one table set and one service for every maker-checker type | `src/server/approvals/engine.ts`, tables `approval_requests`, `approval_request_items`, `approval_decisions` (append-only trigger) | — |
| Two-admin approval of role changes, role removal, privileges, reactivation and flag changes | routes `api/users/[id]/{role,roles,privileges,reinstate}`, `api/admin/feature-flags` → `src/server/approvals/admin-actions.ts` | `rbac_v2_four_eye_admin` (OFF) |
| Bootstrap rule: while fewer than 2 admins are active, the Super Admin (`SUPER_ADMIN_EMAIL`, default ceo@agtci.com) may approve alone. The approval is marked `single_admin`, audited as `approval.single_admin`, and e-mailed. | engine `assertMayDecide` | with the above |
| Emergency suspension: applies at once and opens `USER_SUSPEND_CONFIRM` (confirm within 24 h). Rejecting it lifts the suspension; an overdue one is shown in red on Admin → Approvals. | `api/users/[id]/suspend`, `emergencySuspend` | with the above |
| Admin → Approvals page (Settings → more) | `src/app/admin/approvals`, `src/components/approvals-queue.tsx` | page always reachable for admins; empty while the flag is off |
| Approvals API | `GET /api/approvals`, `GET /api/approvals/{id}`, `POST /api/approvals/{id}/decide`, `POST /api/approvals/{id}/cancel` | — |
| Staff Tile Board `/staff`: one screen per role, tiles filtered by permission and by flags for the role | `src/app/staff/page.tsx`, `src/lib/board/rbac-menus.ts` | tiles of unbuilt areas hidden by their flags |
| Operations User reuses Operator-Limited onboarding (own shops only) | `operator-limited.ts` `WORKS_HERE`, `/operator` pages | — |
| Android app opens `/staff` in the app | `mobile/app.config.ts` | needs the next APK build; iOS already opens every path |

### Engine rules (tested)

- **Nobody approves their own request.** The one exception is the bootstrap rule above.
- **Checker types:**
  - `ADMIN`: any other admin.
  - `CA`: any other CA.
  - `CA_THEN_ADMIN`: a CA, then an admin who is neither the requester nor that CA.
  - `SHOP_OWNER`: the owner of the request's shop only. They may decide item by item, and the request becomes `PARTIALLY_APPROVED`.
- **Rejections need a comment.** This applies to a whole rejection and to each rejected item.
- **The approval commits first; the change is applied after.** It is applied by the same existing service function, acting as the requesting admin, and the result is recorded as `APPLY` or `APPLY_FAILED`. A failed apply leaves the request `FAILED` with the error, and nothing is half-applied.
- **The decision history is append-only.** `approval_decisions` has UPDATE and DELETE blocked by trigger.

### New capabilities (all held by ADMIN, which holds every capability)

| Capability | Staff roles holding it |
|---|---|
| `approval:decide:admin`, `approval:view:any`, `rate-proposal:activate` | admin only |
| `shop-cost:view` | none (no role by default) |
| `staff:board` | all six staff roles |
| `staff-team:view` | Support Manager, Operations Manager |
| `journal:prepare`, `rate-proposal:submit` | Accountant |
| `journal:approve`, `fin-period:close`, `rate-proposal:approve` | CA |
| `support-queue:manage` | Support Manager |
| `support-ticket:work:assigned`, `shop-change:propose`, `master-data-correction:propose` | Support User |
| `shop-change:decide:own` | Shop owner |
| `ops-team:manage`, `ops-report:view` | Operations Manager |
| `ops-task:work:own`, `customer-onboard:assist` | Operations User |

## Database changes (`drizzle/0170_rbac_v2_foundation.sql`)

| Change | Type |
|---|---|
| `user_role` + 5 values | Additive |
| `feature_flags.role_scope text[]` NULL | Additive |
| 6 `rbac_v2_*` rows in `feature_flags`, `enabled = false` | Additive (insert, `ON CONFLICT DO NOTHING`) |
| `approval_requests`, `approval_request_items`, `approval_decisions` + trigger `approval_decisions_append_only` | Additive |

Safe to re-run.

## Rollback

Each step is the fallback if the one before does not resolve it:

1. **Switch off.** Turn off `rbac_v2_four_eye_admin` (and any other `rbac_v2_*` flag). Every admin action applies at once again. If two-admin approval is on, switching it off itself needs a second admin, or the Super Admin alone in bootstrap.
2. **Revert the code.** Revert the PR. With the code gone, the tables are simply unused.
3. **Drop the data.** Run `scripts/rollback-0170.sql`. It drops the engine tables and the flag rows; export `approval_decisions` first. The 5 enum values cannot be dropped from a PostgreSQL enum; with nobody holding them they are inert. Move anyone who holds one back to their previous role before reverting the code.
