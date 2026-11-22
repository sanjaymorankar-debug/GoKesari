# Unified Role-Based Management (RBAC v2)

The owner's brief was received 22-Nov-2026 at 21.56 IST. All times below are IST.

| Document | What it holds |
|---|---|
| [01-assessment.md](01-assessment.md) | Phase 1: what exists, the role and permission matrix, gaps, plan, stop gates |
| [02-phase2-foundation.md](02-phase2-foundation.md) | Phase 2: roles, permissions, approval engine, four-eye, flags — DB and API changes, rollback |
| [03-phase3-accounting.md](03-phase3-accounting.md) | Phase 3: journals, periods, rate proposals |
| [04-support-and-change-requests.md](04-support-and-change-requests.md) | Phases 4, 5, 7: support desk, shop-owner change requests, handover |
| [05-documents.md](05-documents.md) | Document management (§9) |
| [database-and-api.md](database-and-api.md) | Every DB change (Additive / Altering), the approval types, all APIs |
| [deployment-and-rollback.md](deployment-and-rollback.md) | Release units, flag switch-on order, rollback, mobile |
| [changed-files.md](changed-files.md) | Files changed |
| [testing-report.md](testing-report.md) | Test runs per feature, on the local DB, test.gokesari.com and gokesari.com |

## Status

| Phase | Scope | Development | Testing (Test server) | Testing (Production) |
|---|---|---|---|---|
| 1 | Existing code assessment | Completed 22-Nov 22.10 | n/a | n/a |
| 2 | Roles, permission matrix, denied logging, role-scoped flags, approval engine, two-Admin approval + bootstrap rule, emergency suspension, Admin → Approvals, staff board | Completed 22-Nov 22.50 (PR into staging) | Not Started | Not Started |
| 3 | Accounting: journals, periods, rate proposals (Accountant → CA → Admin) | Completed 22-Nov 22.59 | Not Started | Not Started |
| 4 | Support: Manager queue + dashboard, Support User assigned work, bulk price list | Completed 22-Nov 22.59 | Not Started | Not Started |
| 5 | Shop-owner change requests (per item, reminders, expiry, superseded) | Completed 22-Nov 22.59 | Not Started | Not Started |
| 6 | Operations: tasks, zones, customer assists, daily / weekly reports ([06-operations.md](06-operations.md)) | Completed 22-Nov 23.20 (parallel session, merged) | Not Started | Not Started |
| 7 | Operations → Support handover and traceability | Completed 22-Nov 22.59 | Not Started | Not Started |
| 7+ | Document management (§9) | Completed 22-Nov 22.59 | Not Started | Not Started |
| 8 | Mobile parity (WebView: path prefixes; APK build) | Completed 22-Nov 22.59 | Not Started | Not Started |
| 9 | Regression, Test → Production, reports | Pending | Not Started | Not Started |

A feature is "Done" only when Development is Completed and both Testing statuses are Passed.

## Rules this work follows

- **Additive only.** New enum values, tables, nullable columns and flags. No existing table changes type, and no existing permission is removed.
- **Behind flags, seeded OFF.** Every area is behind its own `rbac_v2_*` flag, and each flag can be limited to some roles (`feature_flags.role_scope`). With every flag off the site behaves as before.
  - Two additions apply whether or not a flag is on: permission refusals are now audit-logged, and the new roles exist for an admin to assign.
- **Release path.** Each phase is one PR into `staging` through the staging queue (`ready-for-staging`). Production goes out in the 23.00 IST window, one release at a time, with a post-deploy check.
- **Stop gates** are in [01-assessment.md §8](01-assessment.md#8-stop-gates-found-owner-decision-needed--work-continues-around-them):
  - Two-admin approval is built but switching it on is the owner's call.
  - Rate changes are an additive path; the existing direct admin rate edit stays.
  - Ticket statuses are mapped onto the existing CHECK; it is not altered.
