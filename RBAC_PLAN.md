# RBAC & Shop Operations — Implementation Plan

Status: **Implemented.** Phases 1–12 built on top of baseline `517bad2` (`staging`).

See "What was built" at the end of this document for the delivered surface and
the decisions taken where the brief was ambiguous.

---

## Phase 1 — What already exists

The application is more mature than the brief assumes. A working, server-enforced
RBAC system is already in place. **Most of §1, §5, §17, §19, §20 is already built.**

### Authentication
- **Auth.js v5** (`next-auth@5.0.0-beta`) with the Drizzle adapter, Google OAuth
  provider — `src/server/auth.ts`.
- Database sessions (`sessions` table), not JWT-only.
- Role is attached to the session server-side and **never read from a request
  body** (`schema.ts:148`). Bootstrap admins self-heal on session refresh.

### Existing roles — 4, not 3
```
CUSTOMER | SHOP_OWNER | OPERATOR | ADMIN     (user_role enum)
```
`CUSTOMER` is the marketplace buyer role and underpins cart/orders/wallet/
subscriptions. **It must stay** — the brief's "exactly three roles" is read as
*three operational roles*, layered above the existing customer role.

### Existing authorization — already server-side
- `src/server/authz/permissions.ts` — 40-permission capability matrix, per-role
  `Set` lookups, `can()` / `canAny()`.
- `src/server/authz/guards.ts` — `requireUser`, `requirePermission`,
  `requireRole`, and crucially **`requireShopAccess()`**, which already answers
  capability and ownership as separate checks. **IDOR protection (§20) exists.**
- Route pattern is already `parse → authorize → service → respond`
  (`src/server/api/handler.ts`); business logic never sits in route files.

### Existing data model (28 tables) — relevant subset
| Table | Covers |
|---|---|
| `users`, `roles`, `permissions`, `role_permissions` | §18 Users/Roles/Permissions |
| `shops` | §18 Shop — incl. `shop_type` (44 types) **and** separate `classification` (KESARI/GREEN) |
| `shop_classification_history` | §5, §18 — already immutable with `changed_by`/`reason` |
| `products`, `product_categories`, `shop_products` | §18 Products / Shop Products |
| `product_price_history` | §18 Price History — already immutable, records old→new + actor |
| `payments` | §18 Payments — **but wallet top-ups only** |
| `audit_logs` | §18, §19 — actor, role, action, entity, old/new JSON, IP, UA |
| `inventory_movements` | append-only stock ledger |

**§5's "do not confuse shop type with classification" is already satisfied** —
they are two separate columns with two separate enums.

### Money & quantity conventions (must be respected by all new code)
- Money is **always integer paise** in `bigint`. ₹70.00 → `7000`. Never a float.
- Quantity is **always integer milli-units**. 2 L → `2000`.

### Existing tests
`vitest` + real PostgreSQL (no mocks), 83 tests. CI (`​.github/workflows/ci.yml`)
runs migrate → typecheck → lint → test → build against Postgres 16 on every push
to `main`/`staging`.

---

## Phase 2 — Gap analysis

### Already done — reuse, do not rebuild
§1 roles · §5 classification + history · §17 matrix (mostly) · §19 audit
infrastructure · §20 IDOR guards · §18 Users/Roles/Shops/Products/PriceHistory

### Missing — must build
| # | Gap | Brief |
|---|---|---|
| G1 | **Price-update approval workflow.** No `price_update_requests` table. Operator price edits currently go **live instantly** via `updateShopProduct()`. | §2.4, §7, §10 |
| G2 | **Excel upload.** No library, no tables, no validation, no preview. | §2.3, §6, §8, §9, §21, §24 |
| G3 | **Registration fee.** No fee config, no fee history. | §12 |
| G4 | **Shop registration fields.** No registration number, registration date, fee snapshot, referral code, or payment status on `shops`. | §2.5, §4.1 |
| G5 | **Registration-fee payments.** `payments.purpose` is `["WALLET_TOPUP"]` only; no shop-scoped payment, no partial-payment tracking. | §3, §4.2, §15 |
| G6 | **Referral codes.** No table. | §4.3 |
| G7 | **Operator "Add Shop" on behalf of an owner.** `registerShop()` hardcodes `ownerId: actor.id`. | §4.1 |
| G8 | **Shop-owner registration & payment views.** | §2.5, §3 |
| G9 | **Admin fee filters + fee report.** | §13, §14 |
| G10 | **Audit-log viewer UI.** Table exists; no UI. | §11 |
| G11 | **Role-specific navigation + dashboard KPIs.** `/operator` currently just redirects to `/admin`. | §22, §23 |

### Behaviour change this brief requires (flagging explicitly)
`PATCH /api/shop-products/[id]` today lets **anyone** holding
`SHOP_PRODUCT_MANAGE_ANY` (operator/admin) change a price instantly. Per §7/§10
an operator's change must instead land in `PENDING_OWNER_APPROVAL`. This is a
deliberate change to existing behaviour — owners keep instant updates, admins
keep override.

### Interpretation decisions
1. **Owner price edits go live immediately**; operator edits require owner
   approval. (§10 + §17 matrix: "Approve Operator Price Update — Owner YES,
   Operator NO, Admin YES".)
2. **Owner Excel uploads apply directly**; operator Excel uploads create pending
   requests. §2.3's "approval mechanism" is satisfied by mandatory
   **preview-and-confirm**, not a second approver — an owner approving their own
   upload is a no-op.
3. `CUSTOMER` role is retained (see Phase 1).
4. Excel library: **ExcelJS**. SheetJS/`xlsx` is not reliably published to the
   npm registry and has a history of advisories.

---

## Phase 3–12 — Build sequence

Each phase ends with: `npm run typecheck` → `npx eslint` → `npm test` → fix
before proceeding. Every phase is independently shippable.

### Phase 3 — Permissions & schema foundation
New permissions:
```
PRICE_REQUEST_SUBMIT / _APPROVE_OWN / _APPROVE_ANY / _OVERRIDE
EXCEL_UPLOAD_OWN / _ANY
REGISTRATION_FEE_MANAGE            (ADMIN only)
SHOP_REGISTRATION_MANAGE           (OPERATOR + ADMIN)
PAYMENT_VIEW_OWN / _VIEW_ANY / _RECORD
REFERRAL_MANAGE                    (OPERATOR + ADMIN)
AUDIT_LOG_VIEW_LIMITED             (OPERATOR)
```
New tables (migration `0002`):
`price_update_requests`, `price_update_batches`, `excel_uploads`,
`excel_upload_items`, `registration_fees`, `registration_fee_history`,
`shop_payments`, `referral_codes`, `referral_redemptions`.
New `shops` columns: `registration_number` (unique), `registration_date`,
`registration_fee_paise` (**snapshot** — §12 immutability), `referral_code_id`,
`fee_payment_status`, `amount_paid_paise`.

### Phase 4 — Shop Owner
Owner dashboard: registration details (read-only protected fields), fee, payment
history, per-product price update, pending-operator-updates approve/reject.

### Phase 5 — Operator
Add-shop-on-behalf (G7), registration fee entry, payment recording, referral code
create/assign, classification change (already exists — wire into operator UI).

### Phase 6 — Admin
Fee configuration + history, user/role management (exists), overrides, full
360° shop view.

### Phase 7 — Excel
Template download, upload, server-side validation (type, size, columns, rows,
prices, duplicates, unknown products, formula-injection), preview with
old-vs-new diff and counts, transactional apply.

### Phase 8 — Price approval workflow
Wire operator/Excel changes into `price_update_requests`; owner approve/reject
individually or in bulk; admin override. All audited.

### Phase 9 — Registration fee & payments
Immutable `shop_payments`; reversal/refund/adjustment instead of edit or delete.
Fee changes never rewrite historical snapshots.

### Phase 10 — Dashboards, filters, reports
Role-specific nav; KPIs per §23; admin fee filters per §13; fee report + CSV
export per §14.

### Phase 11 — Audit logging
Extend `AUDIT_ACTIONS` for every §19 action; audit-log viewer (full for admin,
limited for operator).

### Phase 12 — Regression
Full suite + new tests: role isolation, IDOR, Excel validation, approval
workflow, fee immutability, payment immutability, filters, overrides.
Then the §28 end-to-end acceptance scenario for all three roles.

---

## What was built

### Migrations
- `0002_broken_red_wolf.sql` — 9 new tables, 7 new shop columns, `products.code`
  (sequence-allocated SKU, backfilled for existing rows).
- `0003_shop_registration_number.sql` — `shops.registration_number` sequence,
  backfill, NOT NULL.

### New tables
`registration_fees`, `registration_fee_history`, `referral_codes`,
`referral_redemptions`, `shop_payments`, `excel_uploads`, `excel_upload_items`,
`price_update_batches`, `price_update_requests`.

### New services (`src/server/services/`)
| File | Enforces |
|---|---|
| `price-requests.ts` | §2.4, §7, §10 — the approval workflow |
| `excel.ts` | §2.3, §6, §8, §9, §21 — validate → preview → apply |
| `registration-fees.ts` | §12 — fee schedule + snapshot immutability |
| `shop-payments.ts` | §3, §15 — immutable ledger, reversal not deletion |
| `referrals.ts` | §4.3 — codes, attribution, performance |
| `audit-log-query.ts` | §11, §17 — graded audit visibility |

### New API routes
`/api/price-requests` (+ `/decide`, `/[id]/override`),
`/api/excel-uploads` (+ `/[id]/apply`),
`/api/shops/[id]/price-template`,
`/api/registration-fees`,
`/api/shop-payments` (+ `/[id]/reverse`),
`/api/referral-codes`.

### New UI
`/shop/prices` (owner price screen), plus components:
`pending-price-approvals`, `excel-price-upload`, `registration-panel`,
`registration-fee-manager`, `shop-finance-manager`, `referral-manager`,
`audit-log-view`. The admin console gained approvals, fee report, fee config,
referrals and audit sections, each gated on capability.

### Behaviour changes to existing code
1. **`PATCH /api/shop-products/[id]`** — a price change from someone who is not
   the shop owner now returns `202` with `pendingApproval: true` and leaves the
   live price alone. Non-price fields in the same patch still apply immediately.
2. **`registerShop()`** — accepts an `options.privileged` flag. Only then are
   `ownerId`, `registrationFeePaise`, `referralCode` and `registrationDate`
   honoured, so a self-service applicant cannot escalate by crafting a body.
3. **`updateShopProduct()`** — gained an optional `client` parameter so the
   approval flow can apply a price inside its own transaction.
4. **`vitest.config.ts`** — `maxWorkers: 1`. Without it, a finished test file's
   idle connection held `AccessShareLock` and deadlocked the next file's
   `TRUNCATE`. This was pre-existing flakiness, surfaced by running against
   remote Postgres.

### Decisions taken where the brief was ambiguous
1. `CUSTOMER` retained as a fourth role — "exactly three roles" read as three
   *operational* roles above the existing buyer role, which the whole
   cart/order/wallet/subscription surface depends on.
2. Owner price edits and owner Excel uploads apply immediately; operator ones
   queue. §2.3's "approval mechanism" for an owner's own upload is satisfied by
   mandatory preview-and-confirm — an owner approving their own upload is a
   no-op.
3. Excel prices are read as **rupees** and stored as integer paise.
4. `shops.amount_paid_paise` is denormalised but recomputed by `SUM` over the
   ledger inside the same transaction, so it cannot drift.
5. ExcelJS over SheetJS — `xlsx` is not reliably published to the npm registry.

### Not built
- CSV/XLSX **export** of the fee report (§14 says "if the existing application
  supports exports"; it has no export infrastructure, so this was left out).
- A separate operator "Add Shop" form UI. The API accepts operator-created
  registrations (`POST /api/shops` with `ownerId`), but the shop-register form
  is still the self-service one.

---

## Test environment note

No local PostgreSQL or Docker is available on this machine, and the Neon
database currently in use is **staging with live data** — the test suite
truncates tables, so it must never point there. Before Phase 3 coding begins,
either a separate Neon database/branch is created for `TEST_DATABASE_URL`, or
verification relies on GitHub Actions CI (which already provisions Postgres 16
per push).

## Addendum — CA role and named dealer permissions (03-Nov-2026, gap report D4)

Source: owner brief of 02-Nov-2026 (21.33 IST), [docs/referrals-dealer-2026-11/GAP_REPORT.md](docs/referrals-dealer-2026-11/GAP_REPORT.md) Part D.

| Role | New in | Permissions |
|---|---|---|
| `CA` (Chartered Accountant) | migration 0140 (`user_role` value on both databases) | customer basics, `statutory:manage` (dated statutory and TDS rows; only the CA confirms a TDS row), `tds:commission:manage` (certificates, challans, 26Q data, Form 16A), `dealers:payouts:read` (read-only ledger, payouts and payout reports with CSV / XLSX) |

New named permissions:
- `dealers:payouts:read` — ADMIN, OPERATOR, CA. Read-only; approving, paying, cancelling and changing commission rules stay ADMIN only, checked in the services (`requireAdmin`).
- `tds:commission:manage` — ADMIN, CA.

A CA is never given `referral:manage` (dealer administration), `wallet:adjust` or any approval. An admin grants the role in Admin → Users → privileges ("Chartered Accountant"). The CA opens Admin → TDS on commission at `/admin/tds-commission` (the CA's board is the customer board; the page is reached by its link, which the CA guide gives).
