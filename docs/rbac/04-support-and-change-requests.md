# Phases 4, 5, 7 — Support desk, shop-owner change requests, Operations → Support handover

Built 22-Nov-2026 (IST). Flags: `rbac_v2_support`, `rbac_v2_shop_change_requests` (both OFF). Screens: **/staff/support** (Dashboard, Queue, My tickets, Raised by me, Raise a ticket), **/staff/support/shop/{shopId}?ticket=** (Support User's shop workbench), **/shop/changes** (shop owner), **/admin/staff-teams** (admin).

## Support desk (Phase 4) — built on the existing help desk (`support_tickets`)

| Brief | Built as |
|---|---|
| Support Manager sees all tickets, assigns / reassigns, priority, due date, escalate, close / reopen | Holds the existing SUPPORT_TICKET_MANAGE (queue, disputes, grievances) + new SUPPORT_QUEUE_MANAGE: assign to a Support User, priority, due date (never later than the statutory help-desk deadline), side status. Dashboard: New, Assigned, In progress, Pending / On hold, Awaiting shop owner, Resolved, Overdue, average resolution time, workload per Support User. |
| Support User works only assigned shops / tickets | `ticketAccess` gives staff access to a ticket **only** when it is assigned to them; the shop workbench opens only from such a ticket. No SHOP_UPDATE_ANY / SHOP_PRODUCT_MANAGE_ANY: every change is a change request. Bank numbers are not shown; purchase cost is not shown (no role holds `shop-cost:view`). |
| Lifecycle New → Assigned → In Progress → Awaiting Shop Owner → Resolved → Closed; side: Pending Information, On Hold, Escalated, Reopened, Rejected | Mapped onto the existing status CHECK (not altered — stop gate 2): OPEN (New / Assigned by assignee), ACKNOWLEDGED, IN_PROGRESS, AWAITING_SHOP, RESOLVED, CLOSED, REOPENED, ESCALATED, + nullable `sub_status` PENDING_INFORMATION / ON_HOLD / REJECTED. Screens show the brief's names (`briefStatusLabel`). |
| Categories (shop registration … general) | `STAFF_TICKET_CATEGORIES` for staff-raised tickets; customer and shop forms keep their own list. |
| SLA by priority, overdue escalates to the Support Manager | Rule `rbacV2.slaHoursByPriority` (LOW 120 h, NORMAL 48 h, HIGH 24 h, URGENT 4 h) sets the due time, capped by the statutory deadline; the hourly `rbac-v2` job notifies the ticket's manager (or every Support Manager) once per overdue ticket. The existing help-desk escalation keeps running. |
| Teams | `staff_team_members` (SUPPORT / OPERATIONS); Admin → Staff teams. |
| Bulk upload with template, row validation, error report | `/api/staff/shops/{id}/changes/template` (CSV with the shop's current values) → upload CSV / XLSX → good rows become **one** change request with many items; bad rows come back in an error report (row, product, reason). Selling price ≤ MRP checked per row. |
| Barcode / HSN validation | Existing validators (`src/server/product-import/normalise.ts`) keep running in product import; master fields (barcode, HSN, name…) go through a MASTER_DATA_CORRECTION request decided by an admin. |

## Shop-owner change requests (Phase 5)

- **Stored, not applied.** Support's edits become one `SHOP_CHANGE` approval request (checker: the shop's owner), one item per field (old value, proposed value, who, when, reason, linked ticket).
- **Owner decides item by item** on /shop/changes (web and, through the app's WebView, Android and iOS): old vs new side by side, who proposed it, reason; approve or reject each item (rejection needs a comment), approve all or reject all; History tab.
- **Applied through the owner's own writers** (`updateShop`, `updateShopProduct`, `createShopProduct`, shop MRP), acting as the owner — every existing rule (price ≤ MRP, pricing CHECKs, category rules) still applies.
- **MRP is shop-only** (`shop_listing_details.mrp_paise`), every change recorded in append-only `shop_mrp_history`. The master product data is never written here.
- **Superseded**: if the owner changed the field after the proposal, the item is not applied (checked at apply and by the hourly job) and the Support User is told.
- **Reminders** at 24 h and 72 h (rule `rbacV2.reminderHours`), **expiry** after 7 days (`expiryDays`): nothing applied, ticket → Pending Information, Support Manager and Support User told.
- **Ticket moves by itself**: AWAITING_SHOP while waiting; RESOLVED when everything was applied; IN_PROGRESS (rework) when anything was rejected or superseded.
- **Change history** = `approval_requests` + `approval_request_items` (previous, proposed, final applied value, status, decided by / at, rejection comment) + append-only `approval_decisions` (submit, approve, reject, apply, supersede, remind, expire), linked to the ticket.

GSTIN / PAN are not proposable: they change only through government verification (existing flow). FSSAI and other licences are handled as documents (see 05-documents.md).

## Operations → Support handover (Phase 7)

1. An Operations User raises a ticket from the shop (`/staff/support?tab=raise&shopId=…&opsTaskId=…`) — shop pre-selected, category, description. Allowed for shops they onboarded, or the shop of an Operations task assigned to them (`registerOpsTaskLookup`, provided by Phase 6).
2. It lands in the Support Manager's queue at once (notification).
3. The manager assigns a Support User; the Operations User is told.
4. Support works it; a data change creates a change request and the ticket goes to Awaiting Shop Owner (Operations told).
5. The owner decides → Resolved (Operations told: "please confirm") or In Progress.
6. The Operations User confirms → Closed; after rule `rbacV2.confirmHours` (48 h) the Support Manager is asked to confirm instead.

Traceability: `support_tickets.ops_task_id` → ticket → `shop_id` → change request (`change_request_id`, items with product ids) → documents (`staff_documents.ticket_id`) → owner decision (`approval_decisions`) → resolution.

## API

| Method | Path | Who |
|---|---|---|
| GET | `/api/staff/support/tickets?view=mine\|raised` | Support User (mine), any staff (raised) |
| POST | `/api/staff/support/tickets` | Operations, Support, admin (scope checked) |
| PATCH | `/api/staff/support/tickets/{id}` | Support Manager |
| POST | `/api/staff/support/tickets/{id}/confirm` | whoever raised it, or a Support Manager |
| GET / POST / DELETE | `/api/staff/teams` | admin, or the team's manager |
| GET / POST | `/api/staff/shops/{id}/changes` | list: owner, Support · propose: Support User (assigned ticket) |
| GET | `/api/staff/shops/{id}/changes/template` | Support |
| POST | `/api/staff/shops/{id}/changes/bulk` (multipart) | Support User |
| POST | `/api/staff/master-data` | Support User → admin decides |
| POST | `/api/approvals/{id}/decide` `{decision, comment, items[]}` | the shop owner (per item) |
