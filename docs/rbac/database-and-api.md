# RBAC v2 — database and API reference

## Database changes

Every change is **Additive**: new tables, new enum values, new nullable columns, new indexes and new rows. No existing column changes type, nothing is renamed or dropped, and no existing row is rewritten.

| Migration | Change | Type | Rollback |
|---|---|---|---|
| 0170 | `user_role` gains ACCOUNTANT, SUPPORT_MANAGER, SUPPORT_USER, OPERATIONS_MANAGER, OPERATIONS_USER | Additive | Cannot be dropped; inert while unassigned |
| 0170 | `feature_flags.role_scope text[]` (NULL means every role) | Additive | Left in place (nullable) |
| 0170 | Six `rbac_v2_*` rows in `feature_flags`, all OFF | Additive | `rollback-0170.sql` |
| 0170 | `approval_requests`, `approval_request_items`, `approval_decisions` (append-only trigger) | Additive | `rollback-0170.sql` |
| 0171 | `fin_periods`, `fin_journal_entries` (sequence `fin_journal_entry_number_seq`, guard trigger), `fin_journal_lines` (guard trigger), `rate_change_proposals` | Additive | `rollback-0171.sql` |
| 0172 | `staff_team_members` | Additive | `rollback-0172.sql` |
| 0172 | `support_tickets` + `manager_user_id`, `sub_status` (with a CHECK on this new column only), `change_request_id`, `ops_task_id`, `raised_by_staff` (all nullable) + index `support_tickets_assignee_live_idx` | Additive | `rollback-0172.sql` |
| 0172 | `shop_mrp_history` (append-only trigger; FK to `shops`, cascade) | Additive | `rollback-0172.sql` |
| 0173 | `staff_documents`, `staff_document_versions` (trigger blocks UPDATE) | Additive | `rollback-0173.sql` |
| rule (no migration) | `rbacV2`: `highValueJournalPaise`, `reminderHours`, `expiryDays`, `slaHoursByPriority`, `confirmHours` | Additive (defaults in code) | — |

**Foreign keys.** Users are never referenced by foreign key from the new tables, and seller ↔ customer links are checked in the services, as the project rules require. The only foreign keys are:
- to `shops`: `shop_mrp_history`, `staff_documents`;
- inside the new tables: request items and decisions, journal lines, and document versions.

## Approval engine (one engine for every maker-checker type)

| Type | Maker | Checker | Applies through |
|---|---|---|---|
| `USER_ROLE_SET`, `USER_ROLE_REVOKE`, `USER_PRIVILEGES_SET`, `USER_REACTIVATE` | Admin 1 | Admin 2 | `setUserRole`, `revokeRole`, `updateUserPrivileges`, `reinstateUser` |
| `USER_SUSPEND_CONFIRM` (emergency suspension, confirm within 24 h) | Admin 1 | Admin 2 | suspension already applied; a rejection lifts it |
| `FEATURE_FLAG_SET`, `FEATURE_FLAG_ROLE_SCOPE_SET` | Admin 1 | Admin 2 | `setFeatureFlag`, `setFeatureFlagRoleScope` |
| `RULE_SET`, `RULE_RESET`, `COMMISSION_RATE_SET`, `REGISTRATION_FEE_SET` | Admin 1 | Admin 2 | `setRule`, `resetRule`, `setCommissionRate`, `setRegistrationFee` |
| `JOURNAL_ENTRY` | Accountant | CA | post the entry |
| `JOURNAL_ENTRY_HIGH_VALUE` (≥ ₹50,000) | Accountant | CA, then Admin | post the entry |
| `RATE_CHANGE` | Accountant | CA, then Admin (activates) | the existing setter, now or when scheduled |
| `SHOP_CHANGE` | Support User | Shop owner, item by item | `updateShop`, `updateShopProduct`, `createShopProduct`, shop MRP |
| `MASTER_DATA_CORRECTION` | Support User | Admin | records the decision; the admin corrects it in Product master |
| `DOCUMENT_DELETE` | Admin 1 | Admin 2 | removes the versions; the document is marked DELETED |
| Operations task assignment (Phase 6) | — | none (brief: no maker-checker) | — |

**Engine rules:**
- Nobody approves their own request.
- A rejection needs a comment.
- The decision commits first, and the change is applied afterwards. A failed apply leaves the request FAILED with the error.
- The decision history is append-only.

**Bootstrap rule.** While fewer than two admins are active, the Super Admin (`SUPER_ADMIN_EMAIL`, default ceo@agtci.com) may approve alone. Each such approval is marked `single_admin`, audited as `approval.single_admin`, and e-mailed to the Super Admin.

## API (all enforced on the server; hiding in the UI is cosmetic)

| Area | Endpoints |
|---|---|
| Approvals | `GET /api/approvals?status=PENDING\|ALL` · `GET /api/approvals/{id}` · `POST /api/approvals/{id}/decide` · `POST /api/approvals/{id}/cancel` |
| Four-eye (flag `rbac_v2_four_eye_admin`) | These existing endpoints answer `202 { pendingApproval, approvalId, message }` while the flag is on: `PATCH /api/users/{id}/role`, `DELETE /api/users/{id}/roles`, `PATCH /api/users/{id}/privileges`, `POST /api/users/{id}/reinstate`, `PUT /api/admin/feature-flags`, `PUT\|DELETE /api/admin/settings`, `POST /api/finance/commission-rates`, `POST /api/registration-fees`. `POST /api/users/{id}/suspend` still applies at once and opens a confirmation request. |
| Accounting | see [03-phase3-accounting.md](03-phase3-accounting.md) |
| Support, change requests, teams | see [04-support-and-change-requests.md](04-support-and-change-requests.md) |
| Documents | `GET\|POST /api/staff/documents` · `GET /api/staff/documents/{id}/link` · `POST /api/staff/documents/{id}/verify` · `POST /api/staff/documents/{id}/delete` · `GET /api/staff/documents/file?t=` (signed link) |
| Cron | hourly job `rbac-v2` (`src/server/rbac-v2/sweep.ts`): scheduled rate activations, change-request superseded / reminders / expiry, overdue-ticket and confirmation alerts. It is a no-op while the flags are off. |

## Audit actions added

- `authz.denied`
- `approval.submitted`, `approval.decided`, `approval.applied`, `approval.single_admin`
- `user.emergency_suspended`
- `fin_period.closed`, `fin_period.reopened`
- `fin_journal.drafted`, `fin_journal.posted`
- `rate_proposal.submitted`, `rate_proposal.activated`
- `staff_team.changed`
- `staff_document.uploaded`, `staff_document.link_issued`, `staff_document.verified`, `staff_document.deleted`

`audit_logs` stays append-only (trigger from 0018). No role, Admin included, can edit or delete it.
