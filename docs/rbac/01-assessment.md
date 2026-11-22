# Unified Role-Based Management (v2) — Phase 1 assessment

Written 22-Nov-2026, 22.10 IST, on branch `feature/rbac-unified-roles` (cut from
`origin/staging` at `c068411f`, PR #482). Brief: "GoKesari – Unified Role-Based
Management System (v2)", prompt of 22-Nov-2026 21.56 IST.

Read-only review. No code has been changed. Paths are repository-relative;
`schema` = `src/server/db/schema.ts`, `perms` = `src/server/authz/permissions.ts`.

---

## 0. Corrections to the brief's assumptions

| Brief says | Code / project record says | Consequence |
|---|---|---|
| "Sellers and customers are held in separate databases … respect this split" | The split was removed: test.gokesari.com moved back on 02-Nov, gokesari.com on 04-Nov-2026 (CLAUDE.md, `docs/db-fdw-removal-2026-11/`). One database per site (`DATABASE_URL`, self-hosted PostgreSQL on the VPS since 16/17-Nov). | New tables go in the one database. Seller ↔ customer tables still carry **no foreign keys between them**; links are checked in the service, as today. |
| Feature branch → `main` | Finished work goes into `staging` through the staging queue (label `ready-for-staging`), then to `main` in the 23.00 IST release window, one release at a time. | Followed. Nothing here can go to production tonight. |
| Build native Android + iOS screens | The app (`mobile/`, Expo SDK 57, v1.13.0) is **one WebView of the website** for every role. No role has native screens. | Every website page reaches both apps **without an app update**. App work is limited to the deep-link prefix list in `mobile/app.config.ts` (mirrored in `src/lib/deep-links.ts` and `mobile/src/deep-links.ts`) and the iOS `apple-app-site-association`. A store build is needed only if that list changes. |
| CA is a new role | `CA` exists (migration 0140). It covers TDS settings and statutory reports and has read-only payouts. It has **no dashboard**. | Extend, do not add. |
| A WhatsApp notification channel | SMS and WhatsApp run in **mock** mode (`src/server/messaging/sms-whatsapp.ts`). Meta WhatsApp is live only for shop-order alerts. | Shop-owner change requests use in-app, push and e-mail. WhatsApp is added through `notify()` channels and stays mock until the owner turns it on. |

---

## 1. Existing functionality

### 1.1 Roles and authorisation (strong base, reuse)
- **Role enum** `user_role` (schema:115) has 9 values: CUSTOMER, SHOP_OWNER, OPERATOR, ADMIN, DELIVERY_PARTNER, SOCIETY_ADMIN, OPERATOR_LIMITED, DEALER, CA.
- **Active role and grants.** `users.role` is the active role. `user_role_grants` (schema:5967) lists every role a user may switch to; source values include ADMIN and BOOTSTRAP. Service: `src/server/services/roles.ts`.
- **Capability matrix.** `perms` holds about 150 static permissions per role. Checks go through `can()` / `canAny()`, and `ADMIN` = every permission.
- **Guards.** `src/server/authz/guards.ts` provides `requirePermission`, `requireRole` and `requireShopAccess`, which checks capability and ownership separately. Route pattern is parse → authorise → service (`src/server/api/handler.ts`).
- **Gap:** permissions are static code, not per-role database rows. A failed permission check throws `forbidden()` **without an audit row**. The only exception is `OPLTD_ACCESS_DENIED` in `operator-limited.ts:99`.

### 1.2 User administration
- **Services:**
  - `src/server/services/users.ts`: `setUserRole` (:55, no self-change), `suspendUser` (:118, reason required; admins cannot be suspended), `reinstateUser` (:186), `updateUserPrivileges` (:335, never leaves zero admins).
  - `roles.ts`: `assignRoleByAdmin` (:197).
- **APIs:** `src/app/api/users/[id]/{role,roles,privileges,…}` need USER_SET_ROLE or USER_SUSPEND, which only ADMIN holds.
- **Bootstrap admins:** `BOOTSTRAP_ADMIN_EMAILS` and `PERMANENT_ADMIN_EMAILS` (`src/lib/env.ts:247,260`, applied in `src/server/auth.ts`).
- **Gaps:**
  - There is no "create an internal user" or invite flow. An account appears at first sign-in as CUSTOMER and an admin promotes it.
  - Every user, role and suspension change is a **single-admin** action.

### 1.3 Maker-checker today (each flow built separately; no generic engine)

| Flow | Where | Self-approval blocked? |
|---|---|---|
| Referral code / member move | `referral_move_requests` (0162), `src/server/dealers/referral-moves.ts:204` | Yes ("A different admin must approve") |
| Payout batches | `src/server/payouts/batches.ts:79`, rule `payouts.makerChecker` | Yes |
| Dealer auto-payout | `src/server/dealers/auto-payout.ts:79` | Yes |
| Operator-proposed shop prices | `price_update_batches` / `price_update_requests` (schema:4446/4478), `price-requests.ts`. The owner decides per item; status SUPERSEDED exists. | Owner decides. No reminders or expiry. |
| Shop MRP dispute | `mrp_corrections` (schema:2893), `mrp-governance.ts:170` | Operator or admin decides |
| Statutory rates | `statutory_rates.confirmed_by_ca` | CA confirms |
| Settlements | FINANCE_PREPARE → FINANCE_MANAGE | Nominal (both admin-only) |

### 1.4 Tickets, disputes and grievances (reuse the helpdesk)
- **Helpdesk tables:** `support_tickets` (schema:9170, migration 0081), with messages (internal flag), attachments, events, canned replies and CSAT.
- **Ticket fields:**
  - SLA: `acknowledge_by`, `resolve_by`, breach stamps.
  - Escalation: `escalation_level`.
  - Links: `order_id`, `shop_id`, `dispute_id`, `grievance_id`.
- **Service:** `src/server/aftercare/support-tickets.ts` handles create, assign, escalate, status, reply and attach, plus the hourly SLA sweep.
- **Statuses** (DB CHECK `support_tickets_status_valid`): OPEN, ACKNOWLEDGED, IN_PROGRESS, AWAITING_CUSTOMER, AWAITING_SHOP, RESOLVED, CLOSED, REOPENED, ESCALATED.
- **Categories:** code list only, no DB CHECK: ORDER, DELIVERY, CANCELLATION, REFUND_PAYMENT, PRODUCT_QUALITY, WALLET, ACCOUNT, SHOP_PAYOUT, GRIEVANCE, OTHER, BOOKING.
- **Separate case systems:** disputes (`order_disputes`, L1/L2) and grievances (statutory register) are separate. Tickets already link to both.
- **Gaps:**
  - No manager/team ownership.
  - Assignable staff are hard-coded to OPERATOR or ADMIN (`listAssignableStaff`, :1044).
  - No link to a change request or to an Operations task.

### 1.5 Onboarding
- **Operator (Limited)** onboards a shop on the owner's behalf with the owner's e-mail OTP consent (`src/server/services/operator-limited.ts`). It is scoped by `shops.onboarded_by_user_id`. Board: `/operator`.
- **Dealer-assisted onboarding:** `src/server/dealers/assisted.ts`.
- **Auto-approval (do not touch):**
  - Chain: `autoApproveShopIfReady` (`shops.ts:936`) → `approveOnGovVerification` → `gov-auto-approval.ts`.
  - It is called from payments, seller-verification, wizard and operator-limited code.
- **Reporting:**
  - Exists:
    - `getOnboardingFunnel` (SELF / DEALER / OPERATOR source).
    - Dealer coverage, activation and team reports (`src/server/dealers/analytics.ts`, `team-report.ts`).
    - Franchise zone reports (`src/server/franchise/dashboard.ts`).
    - Geography: `geo_areas`, `franchise_zones`, `franchise_areas`.
    - Dealer hierarchy: `dealer_salespeople` with TEAM_LEAD/AGENT.
  - **Gaps:**
    - No single report by zone + dealer + team lead + agent with daily and weekly trend.
    - Customer registration source is only GOKESARI or FRIEND referral (`customer_signup_referrals`). Dealer-assisted and operations-assisted customer sign-ups are not recorded.

### 1.6 Shop data, products, prices
- **Master MRP:** `products.mrp_paise`, with history, through `changeMasterMrp`.
- **Shop-level MRP:** `shop_listing_details.mrp_paise`, "never written to the master", through `setShopMrp` (`shop-product-setup.ts:417`). This already honours the brief's "MRP scope rule". There is **no history** for shop MRP.
- **Shop prices, HSN and GST:** on `shop_products`. Price history is in `product_price_history`.
- **Bulk upload:** `shop-bulk-upload.ts` provides the template, row checks, error file, confirm and apply. Barcode (GTIN check digit) and HSN validators are in `src/server/product-import/normalise.ts`.
- **Purchase cost:** not held per shop product in the marketplace tables. It exists only in the shop-side billing inventory.

### 1.7 Documents
- **Tables:** shop legal documents, files, rules and waivers (`shop_legal_documents`, `shop_legal_document_files`, `shop_document_*`), seller verification files.
- **Storage:** app-encrypted `bytea`, served only through authenticated routes. The file type is checked by magic bytes (PDF/JPEG/PNG/WebP), with a 5 MB cap.
- **Gaps:**
  - No explicit version number; a re-upload adds a row.
  - No virus scan.
  - No product-level documents.
  - No signed time-limited links (only consult files have them).

### 1.8 Feature flags, notifications, dashboards
- **Feature flags:** `feature_flags` + `feature_flag_changes` (`src/server/services/feature-flags.ts`) — admin-only, reason required, audited, and limited by district. **No per-role scope.**
- **Notifications:** `notify()` (`src/server/services/notifications.ts:116`) queues after commit:
  - In-app: live.
  - E-mail: live.
  - Push: Expo, switched on by rule.
  - SMS and WhatsApp: mock.
- **Tile Board ("Theme 1"):** role menus in `src/lib/board/menus.ts`, filtered by permission. Counts come from `board-counts.ts`, components from `src/components/board/*`.
- **Existing boards:**
  - Admin and Operator: `/admin`.
  - Operator (Limited): `/operator`.
  - Dealer: `/dealer`.
  - Franchise: `/franchise/my`.
  - **CA has none.**

### 1.9 Accounting
- **Platform ledger:** `finance_ledger_entries`, append-only by convention with no trigger. `financial_adjustments` and `reconciliation_records` sit beside it.
- **Shop-side double entry (billing v2):** `acc_ledger_entries`.
- **Platform invoices and statutory:** `platform_invoices`, `statutory_*`, `commission_tds_*`.
- **Not present:** financial periods or period close, a platform journal-entry maker/checker, bank-statement reconciliation.
- **Rates (all single-admin writes, audited):**
  - Commission: `commission_rates` via `setCommissionRate`.
  - Registration fee: `registration_fees` + history.
  - Franchise fee: `franchise_config_versions`.
  - Delivery charge: rule `shopWallet`.
  - Referral and dealer commission settings.
  - No separate "platform fee" field exists.

---

## 2. Existing vs required roles

Live account counts are not in the repository. They are counted read-only on
each server at Phase 9 with
`SELECT role, count(*) FROM users WHERE status='ACTIVE' GROUP BY role;` and
recorded in the testing report. The column below is marked *count at Phase 9*.

| Required role | Closest existing role | Existing features | Missing features | Action | Migration of existing users |
|---|---|---|---|---|---|
| Admin | `ADMIN` | Every permission; user, role and suspension management; feature flags; audit view; bootstrap and permanent admins | Create internal user (invite by e-mail); two-Admin approval; single-admin bootstrap flag + e-mail to ceo@agtci.com; emergency suspension with 24 h confirmation | **Extend** | None. Admins keep every permission. Four-eye sits behind a flag (see gate G1). |
| Chartered Accountant | `CA` | TDS / statutory settings and reports; read-only dealer payouts | Dashboard; view finance, ledgers, settlements, wallets, refunds and audit (read); approve journal entries and rate proposals; period close/reopen; statements | **Extend** | Existing CA accounts keep their permissions and gain the new view/approve set (additive). |
| Accountant | none (admin holds FINANCE_PREPARE) | — | Role, dashboard, journal-entry drafts, registers, GST/TDS report preparation, bank reconciliation, rate proposals | **New** (`ACCOUNTANT`) | None (new). |
| Support Manager | `OPERATOR` (does support among many things) | Helpdesk manage, assign, escalate and SLA sweep; disputes and grievances | Role scoped to support only; team queue; workload per user; review/close; SLA configuration | **New** (`SUPPORT_MANAGER`) on the existing helpdesk | None. OPERATOR unchanged. |
| Support User | `OPERATOR` (shop and product edit) | Shop and product edit for any shop (OPERATOR); price requests to owner | Scope to assigned shops/tickets; masked bank; change-request (not direct) edits for every shop/product field; product documents | **New** (`SUPPORT_USER`) | None. OPERATOR unchanged. |
| Operations Manager | none (admin sees the onboarding funnel) | Onboarding funnel; dealer and franchise reports | Role; zone/dealer/TL/agent report with daily/weekly trend; customer onboarding report; task assignment; Excel/PDF export | **New** (`OPERATIONS_MANAGER`) | None. |
| Operations User | `OPERATOR_LIMITED` | Owner-consent onboarding, documents, fee link, own-shop scope, board `/operator` | Customer-assisted onboarding (OTP); zone assignment; tasks and follow-ups; GPS/photo capture; raise ticket to Support | **New** (`OPERATIONS_USER`) = OPERATOR_LIMITED's permissions + new ones | Existing OPERATOR_LIMITED accounts **stay as they are** (no loss). An admin may grant them OPERATIONS_USER as an extra role through `user_role_grants`. |
| *(existing)* Operator | `OPERATOR` | Broad staff role (shops, catalogue, orders, refunds, support, riders…) | — | **Keep separate, unchanged** | No change. Removing or narrowing it is stop gate 3. A later, owner-approved move of operator accounts to Support or Operations roles is listed as Q3. |
| *(existing)* Customer, Shop Owner, Rider, Dealer / Franchise, Team Lead, Agent, Society | same | as today | Shop Owner only: "Pending Changes for Approval" and history | Reuse (Shop Owner extended) | None. |

**Operator decision:** OPERATOR stays a separate role, unchanged. The new
Support and Operations roles are narrower roles built beside it. No existing
account loses access, and nothing is migrated automatically.

---

## 3. Permission matrix (new permissions; existing ones untouched)

New capability keys use the existing `area:action[:scope]` naming. `V`=View,
`C`=Create, `E`=Edit, `S`=Submit, `A`=Approve, `R`=Reject, `As`=Assign,
`Ra`=Reassign, `X`=Export, `D`=Delete.

| Capability | Admin | CA | Acct | SupMgr | SupUser | OpsMgr | OpsUser |
|---|---|---|---|---|---|---|---|
| `staff-user` (internal users) | V C E S | – | – | V (own team) | – | V (own team) | – |
| `approval` (four-eye queue) | V A R (not own) | – | – | – | – | – | – |
| `finance` (read) | V | V X | V X | – | – | – | – |
| `journal` | V | V A R | V C E S | – | – | – | – |
| `period` | V | V close/reopen | V | – | – | – | – |
| `rate-proposal` | V activate | V A R | V C S | – | – | – | – |
| `ticket` | everything | – | – | V C E As Ra X close | V E (assigned) S | V C | V C (own) |
| `shop-change-request` | V A R (master data) | – | – | V | V C S (assigned shops) | – | – |
| `product-upload` | V | – | – | V | C S (to owner) | – | – |
| `ops-task` | V | – | – | – | – | V C As Ra X | V E (own) |
| `onboarding-report` | V X | – | – | – | – | V X | V (own) |
| `shop-document` | V C D (four-eye) | – | – | V | V C | V | V C (own shops) |

Data scope is enforced in the services, not only by role:
- Support User: tickets assigned to them, and the shops on those tickets.
- Operations User: their zones and tasks, plus shops with `onboarded_by_user_id` = self.
- Managers: their team.

---

## 4. Gap analysis → build list (minimum change)

| # | Gap | Approach |
|---|---|---|
| 1 | New roles | Add 5 enum values (`ALTER TYPE … ADD VALUE`, additive), permission lists, labels, ROLE_HOME and board menus. |
| 2 | Generic approval engine | **New** `approval_requests` + `approval_request_items` + `approval_decisions` (append-only trigger), one service `src/server/approvals/`. Each request has a type and a handler registry. Covers four-eye admin actions, journal entries, rate proposals, master-data corrections, document deletion and shop-owner change requests (checker = owner). Existing flows (referral moves, payouts, price requests) are **left as they are**. |
| 3 | Permission-denied logging | `requirePermission` / `requireAnyPermission` / `requireRole` write an audit row `authz.denied` (fire-and-forget; never changes the response). |
| 4 | Per-role feature flags | Add a nullable `role_scope text[]` to `feature_flags` (additive). New flags `rbac_v2_<area>` are seeded OFF. |
| 5 | Internal user invite | Admin creates a pending invite (e-mail + role). It goes through four-eye when the flag is on. The role is applied on the invitee's first sign-in through the existing sign-in (**no auth change**). |
| 6 | Accounting | New tables: `fin_periods`, `fin_journal_entries` + lines (maker/checker through the engine, reversal-only after posting), `rate_change_proposals` (activation calls the **existing** setter: `setCommissionRate`, registration-fee and franchise setters). Bank-reconciliation import comes later in Phase 3. |
| 7 | Tickets | Reuse `support_tickets`. Additive nullable columns: `manager_user_id`, `sub_status` (PENDING_INFORMATION / ON_HOLD / REJECTED), `ops_task_id`. New categories are code-only (no DB CHECK). Assignable staff extended to the Support roles. |
| 8 | Shop-owner change requests | Engine type `SHOP_CHANGE`, one request with many items. Applies through the existing writers (`updateShop`, `setShopMrp`, `updateShopProduct`) on owner approval. Reminders at 24 h and 72 h, expiry at 7 d (event-driven sweep on the existing cron runner). Conflict check marks the request SUPERSEDED. |
| 9 | Shop MRP history | New append-only `shop_mrp_history` (additive). |
| 10 | Operations | New `ops_zone_assignments`, `ops_tasks` (+ follow-ups) and `customer_onboarding_assists` (OTP-confirmed), plus a report service over the existing funnel, dealer, franchise and geo tables. |
| 11 | Documents | New `document_versions` view/table for version numbers on top of the existing files. Product documents table. Deletion through four-eye. Signed short-lived download tokens (reuse the consult files pattern). |
| 12 | Dashboards | 6 new Tile Board menus (CA, Accountant, SupMgr, SupUser, OpsMgr, OpsUser) in `menus.ts`, plus the shop-owner "Pending changes" tile. |
| 13 | Mobile | Add any new top-level path (`/accounts`, `/support-desk`, `/ops`) to the deep-link prefix lists. An app store build is needed only for that. |

---

## 5. Files expected to change (Phase 2 first)

- **Edited:**
  - `src/server/db/schema.ts`
  - `src/server/authz/permissions.ts`
  - `src/server/authz/guards.ts` (denied logging only)
  - `src/server/services/roles.ts` (`STAFF_ROLES`)
  - `src/server/services/feature-flags.ts` (+ keys)
  - `src/server/services/audit.ts` (+ actions)
  - `src/lib/board/menus.ts`
  - `src/components/role-switcher.tsx` (ROLE_HOME)
  - `src/server/aftercare/support-tickets.ts` (assignable staff; Phase 4)
  - `mobile/app.config.ts`, `src/lib/deep-links.ts`, `mobile/src/deep-links.ts` (path prefixes)
- **New:**
  - `drizzle/0170_rbac_v2_roles.sql`, `0171_rbac_v2_approvals.sql`, … and `scripts/rollback-01xx.sql` for each.
  - `src/server/approvals/*`
  - `src/app/api/approvals/**`, `src/app/admin/approvals/**`
  - `src/app/accounts/**`, `src/app/support-desk/**`, `src/app/ops/**`
  - Tests in `src/server/**/__tests__`.
- **Not touched:** auth (`src/server/auth.ts`, `otp/`, `mobile-auth.ts`), orders, payments, wallet, commission calculation, settlements, dealer/franchise logic, `shops.ts` auto-approval, `gov-auto-approval.ts`.

## 6. Database changes

| Change | Type |
|---|---|
| `user_role` + ACCOUNTANT, SUPPORT_MANAGER, SUPPORT_USER, OPERATIONS_MANAGER, OPERATIONS_USER | Additive (new enum values; no row changes) |
| `feature_flags.role_scope text[]` NULL | Additive |
| `feature_flags` key list + `rbac_v2_*` rows seeded OFF | Additive (inserts) |
| `approval_requests`, `approval_request_items`, `approval_decisions` (append-only trigger) | Additive |
| `staff_invites` | Additive |
| `fin_periods`, `fin_journal_entries`, `fin_journal_lines`, `rate_change_proposals` | Additive |
| `support_tickets.manager_user_id`, `.sub_status`, `.ops_task_id`, `.change_request_id` (all NULL) | Additive |
| `shop_mrp_history`, `product_documents`, `document_versions` | Additive |
| `ops_zone_assignments`, `ops_tasks`, `ops_task_followups`, `customer_onboarding_assists` | Additive |
| Widening `support_tickets_status_valid` CHECK with NEW, ASSIGNED, AWAITING_SHOP_OWNER… | **Altering — not done.** Replaced by `sub_status` plus a mapping (see §8 G3). |

Every migration is written `IF NOT EXISTS` (safe to re-run) and has
`scripts/rollback-NNNN.sql`. Enum values cannot be dropped in PostgreSQL; their
rollback is "unused + flag off".

## 7. Regression risks and impacted flows

| Risk | Mitigation |
|---|---|
| A `Record<UserRole, …>` map elsewhere breaks typecheck when roles are added (ROLE_PERMISSIONS, ROLE_LABELS, ROLE_HOME, menus) | `tsc` finds every one; each new role gets customer-level defaults. |
| Code that treats "not CUSTOMER/SHOP_OWNER" as staff | grep `role !==` / `role ===` and add tests for each new role being refused staff areas. |
| Denied-permission logging floods `audit_logs` | One row per denial with no retries; skipped for unauthenticated users; rate-capped per user per minute. |
| Ticket assignment list change | Additive (more roles become assignable); existing OPERATOR/ADMIN unchanged. |
| Change requests applying through existing writers | Apply only via the same service functions the owner uses (same validation: price ≤ MRP and so on). Flag off = no path. |
| Auto-approval | Not touched. Operations verification acts only on shops already in PENDING. A regression test asserts the auto-approval path is unchanged. |

## 8. Stop gates found (owner decision needed — work continues around them)

**G1 — Two-Admin approval on admin user actions (gate 3: narrows the Admin role).**
- **Change:** user creation, role change, suspension and flag changes go into the approval queue instead of applying at once.
- **Why:** brief §3.1 and §10.
- **Impact:** one admin can no longer act alone. Today production has a small number of admins, so the bootstrap rule applies. Emergency suspension stays immediate.
- **Rollback:** flag `rbac_v2_four_eye_admin` off.
- **Alternative considered:** queue only new-role grants (CA, Accountant, Support, Ops) and leave existing admin actions direct. Rejected as the end state because the brief asks for all of them, but available.
- **Proceeding with:** build the engine and the routing, with the **flag OFF on both sites**. Switching it on is the owner's call.

**G2 — Rate-change workflow (gate 4: commission and fee settings).**
- **Change:** Accountant proposes → CA approves → Admin activates (with an effective date), calling the existing setters.
- **Impact:** none on calculation. The existing direct admin edit remains.
- **Rollback:** flag off.
- **Alternative:** force every rate edit through the proposal. That removes the direct admin edit (gates 3 and 4), so **not done** unless the owner asks.
- **Proceeding with:** additive path only, flag OFF.

**G3 — Ticket lifecycle names (gate 2 if the CHECK is altered).**
- **Brief:** New → Assigned → In Progress → Awaiting Shop Owner → Resolved → Closed, plus side statuses.
- **Proceeding with:** a mapping onto the existing CHECK, with no altering migration:

  | Brief status | Stored as |
  |---|---|
  | New | OPEN |
  | Assigned | ACKNOWLEDGED + assignee |
  | In Progress | IN_PROGRESS |
  | Awaiting Shop Owner | AWAITING_SHOP |
  | Resolved | RESOLVED |
  | Closed | CLOSED |
  | Reopened | REOPENED |
  | Escalated | ESCALATED |
  | Pending Information / On Hold / Rejected | additive `sub_status` |

  The screens show the brief's names.
- **Alternative:** widen the CHECK constraint. That is an altering migration and waits for owner approval.

No change to authentication is needed: invites apply the role at normal sign-in (gate 1 not triggered).

## 9. Open questions and the assumption used

| # | Question | Assumption proceeding with |
|---|---|---|
| Q1 | Switch on four-eye for admin actions (G1)? | Built, flag OFF. |
| Q2 | Force every rate change through Accountant → CA (G2)? | No; additive path, flag OFF. |
| Q3 | Should existing OPERATOR accounts later move to Support/Operations roles? | No automatic move; OPERATOR stays. |
| Q4 | Super Admin for the bootstrap rule | `ceo@agtci.com`, taken from the brief. It must also be in `PERMANENT_ADMIN_EMAILS` on each site, otherwise single-admin mode is refused. |
| Q5 | Purchase cost for Support Users | Not in marketplace tables; shown only if billing-v2 inventory has it and the permission `shop-cost:view` is granted (no role has it by default). |
| Q6 | High-value journal threshold | ₹50,000 default, held as a rule (`rbacV2.highValueJournalPaise`); changing it goes through four-eye. |
| Q7 | WhatsApp for change requests | Via `notify()` channels; stays mock until the owner turns WhatsApp on. |
| Q8 | Production timing | Behind flags, OFF. Each phase goes through the staging queue, then the 23.00 IST window. Production verification uses designated test accounts only. |
| Q9 | Virus scanning | No scanner exists. Magic-byte type check remains. A ClamAV scan on the VPS is proposed for Phase 4 (needs a package install on the server: owner OK). |

## 10. Size and sequence

This is a large build (nine phases, roughly 30 new tables and about 25 new
pages). It is planned as **one PR per phase** into `staging`, each behind its
own `rbac_v2_*` flags, so each can go to production in the 23.00 IST window
with its flags OFF and be switched on after testing:

1. Phase 2: roles, permissions, denied logging, per-role flags, approval engine, staff invites, four-eye (flag off).
2. Phase 3: accounting.
3. Phase 4 + 5: support, tickets, change requests, shop-owner approval.
4. Phase 6 + 7: operations, handover.
5. Phase 8: mobile path prefixes (plus a store build only if needed).
6. Phase 9: regression, production verification, reports.
