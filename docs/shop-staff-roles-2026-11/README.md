# Module 10 — Shop staff roles and permissions (23-Nov-2026)

Shop-side only: who a shop owner lets help run **their** shop, and what each person may do there.
This is not the platform's own staff roles (RBAC v2, `rbac_v2_*`, staff team members) — those are untouched.

Flag: **`shop_staff_roles_enabled`** — seeded **OFF** by migration 0185. With it off everything behaves as before:
staff can only edit product photos and descriptions (Module 1), and every migrated route answers exactly as
`requireShopAccess` did.

## What existed (Module 1)

- `shop_staff` table (shop, user, scope `CATALOGUE`, status ACTIVE/REVOKED).
- `src/server/services/shop-staff.ts`: catalogue access (all-or-nothing), add an existing account by mobile/email,
  remove, owner-only management, a database check on every request (removal is immediate).
- API `/api/shops/[id]/staff` (GET, POST) and `/api/shops/[id]/staff/[staffId]` (DELETE); pages `/shop/staff`
  and `/shop/staff-access`; audit `shop_staff.added/removed`; notifications `shop.staff_added/removed`.
- `shop_delivery_staff` (delivery helpers without accounts) — left as it is.

## Gaps closed

| # | Requirement | Status |
|---|---|---|
| 1 | Permission catalogue + preset roles | DEVELOPED — `src/lib/shop-staff/permissions.ts` |
| 2 | Migration: role, permissions, INVITED/SUSPENDED, invite fields | DEVELOPED — `drizzle/0185_shop_staff_roles.sql` |
| 3 | `shopStaffCan` + `requireShopPermission`, routes migrated | DEVELOPED — list below |
| 4 | Invite flow (existing account / new person by e-mail) | DEVELOPED |
| 5 | Suspend / reactivate / revoke / change role, audited, immediate | DEVELOPED (revoke ENHANCED) |
| 6 | Per-staff activity log for the owner | DEVELOPED |
| 7 | Staff board shows only allowed sections; staff manager page with matrix | DEVELOPED (see "Not finished") |

### Permissions

`<resource>.<action>` for resources catalogue, inventory, orders, billing, delivery, customers, settings, staff,
reports × actions view, create, edit, delete, approve, cancel, export — plus two flags:

- `financial_visibility` — every `billing.*` permission also needs it;
- `config_access` — `settings.create/edit/delete` also need it.

Preset roles (the owner is implicit and has everything):

| Role | Grants |
|---|---|
| MANAGER | everything in catalogue, inventory, orders, billing, delivery, customers, reports; settings.view; staff view/create/edit; financial visibility. **Not** settings changes (unless given `settings.edit` + `config_access` as extra grants) and not staff removal. May add/change staff only with permissions they hold, never a MANAGER. |
| CATALOGUE_MANAGER | catalogue view/create/edit/delete, inventory.view (every pre-0185 row maps here — same photo/description access as before) |
| ORDER_MANAGER | orders view/edit/approve/cancel, delivery.view, customers.view |
| BILLING_MANAGER | billing view/create/edit/export, reports view/export, orders.view, financial visibility |
| INVENTORY_MANAGER | inventory view/create/edit, catalogue.view |
| DELIVERY_MANAGER | delivery view/create/edit/approve/cancel, orders.view |
| CUSTOMER_SUPPORT | customers view/edit, orders.view |
| CUSTOM | exactly the permissions ticked (stored in `shop_staff.permissions`) |

For preset roles `permissions` holds **extra** grants on top of the role. CUSTOM per person was simpler than a
`shop_staff_custom_roles` table, so no such table was added.

### The guard

`requireShopPermission(shopId, permission | permission[], { anyPermission })` in
`src/server/authz/shop-permission.ts` passes, in order: the owner → a role holding `anyPermission`
(operators/admins, same as `requireShopAccess`) → with the flag on, an **ACTIVE** staff row in **this** shop whose role
grants the permission (and its flag). Everything else is 403 and logged (`authz.denied`). The staff row is read on
every request, so pause, role change and removal apply at once. A staff action that changes something writes
`shop_staff.action` against the shop (read by the activity log). `assertStaffAllows` decides per action after a
list was used. `shopStaffCan` / `shopStaffAccess` (`src/server/services/shop-staff-access.ts`) answer the same
question without throwing (owner or staff; no operator override).

### Routes migrated to `requireShopPermission`

| Route | Staff permission |
|---|---|
| PATCH `/api/orders/[id]/status` | `orders.edit`; status CANCELLED by the shop side: `orders.cancel` |
| POST `/api/orders/[id]/fulfilment` | accept / reject: `orders.approve`; start, pick, substitute, remove, ready: `orders.edit` |
| GET / POST `/api/orders/[id]/fulfilment-plan` | `orders.view` / `orders.edit` |
| POST `/api/orders/[id]/fulfilment-plan/handover` | `delivery.edit` (operator-only "confirm" still checked in the service) |
| GET / POST `/api/orders/[id]/assign` | `delivery.view` / `delivery.create`; stop search `delivery.cancel`; manual reassign stays operations-only |
| GET `/api/shops/[id]/orders` (new) | `orders.view` |
| GET / PATCH `/api/shops/[id]/inventory` | `inventory.view` / `inventory.edit` |
| PATCH `/api/shop-products/[id]/stock-settings` | `inventory.edit` |
| PATCH `/api/shop-products/[id]` | stock / availability only: `inventory.edit`; anything else `catalogue.edit`. A staff price change becomes a price request for the owner's approval (existing rule for non-owners). |
| DELETE `/api/shop-products/[id]` | `catalogue.delete` |
| POST `/api/shops/[id]/products` | `catalogue.create` |
| PATCH `/api/shops/[id]/prices` | `catalogue.edit` |
| GET / POST `/api/shops/[id]/delivery-staff`, PATCH `…/[staffId]` | `delivery.view` / `delivery.create` / `delivery.edit` |
| GET `/api/analytics/kpis?shopId=` | `reports.view` |
| GET `/api/shops/[id]/wallet` | `billing.view` (+ financial visibility) |
| GET `/api/shops/[id]/gst/gstr1` | `billing.export` (+ financial visibility) |
| PATCH `/api/shops/[id]` | `settings.edit` (+ config access) |
| POST `/api/shops/[id]/staff` (flag on) | `staff.create` |

Two services had their own owner check behind the route (`setStockThresholds`, `setShopStockDefaults` in
`inventory-alerts.ts`); they take `{ staffAuthorised: true }` only when the guard let a staff member in.

Catalogue photo/description routes keep `requireShopCatalogueAccess` (Module 1): an ACTIVE row whose role grants
`catalogue.edit` — for every row that existed before 0185 that is the same answer as before.

### Still owner-only (`requireShopAccess`, unchanged)

`/api/shops/[id]/bank-account`, `banner`, `logo`, `close`, `cancellation-fee`, `categories`, `catalogue-search`,
`barcode-lookup`, `documents/*`, `legal-documents`, `gst`, `gst/einvoice-declaration`, `pan`, `price-template`,
`profile-setup`, `puja/*`, `removed-listings`, `starter-shelf`, `listing-price-requests/*`, `verifications/*`,
`wallet/topup`, `wallet/verify`; `/api/invoices/[id]/einvoice*`, `/api/invoices/[id]/eway-bill*`,
`/api/credit-notes/[id]/einvoice`, `/api/excel-uploads*`, `/api/price-requests`, `/api/products`,
`/api/shop-payments`; `/api/orders/[id]/cancel` (customer cancellation with refund choice) is unchanged.
Bank, documents, KYC, wallet top-up and e-invoice stay with the owner on purpose; the rest can be moved one line
at a time with the same guard.

## Invitations

- Owner (or a manager with `staff.create`) invites by mobile number or e-mail plus a role
  (`POST /api/shops/[id]/staff { identifier, role, permissions? }`). Nothing is granted while the row is INVITED.
- **Existing account**: in-app notification `shop.staff_invited` (e-mail by the person's preferences); they accept
  on "Shops I help with" (`/shop/staff-access`).
- **No account**: must be an e-mail address (SMS has no vendor). An e-mail with a one-time link
  `/staff-invite?token=…` is sent after commit (random 32-byte token; only its SHA-256 is stored; 7 days). They sign
  in with the normal e-mailed code using that address and accept on the link page or on `/shop/staff-access`, which
  also lists invitations sent to their e-mail address. Acceptance requires the signed-in account's e-mail to match.
- `POST /api/shop-staff/invitations/accept { token } | { staffId }`, `GET /api/shop-staff/invitations`.
- Mobile-only invitations of people without an account are refused with a clear message.

## Managing staff

`PATCH /api/shops/[id]/staff/[staffId]` `{ role, permissions? }` or `{ suspended: true|false }`;
`DELETE` removes (also a paused member, or cancels an invitation). Audit actions added:
`shop_staff.invited`, `.invite_accepted`, `.invite_cancelled`, `.role_changed`, `.suspended`, `.reactivated`,
`.action`. Notifications added: `shop.staff_invited`, `.staff_role_changed`, `.staff_suspended`,
`.staff_reactivated`, `.staff_invite_accepted` (to the owner).

Activity: `GET /api/shops/[id]/staff/[staffId]/activity` and page `/shop/staff/[staffId]/activity` — the person's
audit entries since joining on the shop itself (including every `shop_staff.action`), its orders and its listings.

## UI

- `/shop/staff` (owner): flag off → the old screen; flag on → `ShopStaffRolesManager`: invite with role, extra
  permission grid, role matrix, change role, pause / restore, remove / cancel invitation, activity link.
- `/shop/staff-access` (staff): flag on → open invitations with Accept, and for a shop a board
  (`StaffShopBoard`) with only the sections the role allows: recent orders (amounts only with financial
  visibility), catalogue (product photos list + bulk upload), stock counts, and cards for the other allowed areas.
- `/staff-invite?token=` — the e-mailed link's page (outside /shop so a signed-out visitor can read it).

## Migration 0185

Additive and safe to re-run (checked by running it twice on a local database). `role` (default
CATALOGUE_MANAGER), `permissions text[]`, `invite_email`, `invite_token_hash`, `invite_expires_at`, `invited_by`,
`accepted_at`, `suspended_at`, `suspended_by`, `role_changed_at`; `user_id` made nullable (e-mail invitations);
unique indexes for one open row per person per shop, one open e-mail invitation per shop, unique token hash; flag row
OFF. `scope` is kept. Rollback: `scripts/rollback-0185.sql`.

## Tests

- `tests/unit/shop-staff-roles.test.ts` — permission matrix, guard allow/deny per role, financial/config flags,
  cross-shop isolation, suspended/revoked/invited refused on the next request, role change, audit, flag OFF.
- `tests/integration/shop-staff-roles.test.ts` — real PostgreSQL and route handlers: flag OFF unchanged, invite →
  accept (account and e-mail), per-role allow/deny on migrated routes, cross-shop, pause/restore/role/remove,
  manager limits, activity log.

## Not finished / blocked

- The full Seller Central pages (`/shop/orders`, `/shop/inventory`, …) still open the **owner's** shop only; staff
  get the read-only board plus the APIs. Wiring each Seller Central page to a staff member's shop is follow-up UI
  work. A manager manages staff through the API (the `/shop/staff` page is the owner's).
- Invitations to a mobile number of someone without an account: blocked on an SMS vendor (owner decision).
- Hindi/Marathi strings for the new screens: the staff screens it extends are English-only today, so the new ones are too.
