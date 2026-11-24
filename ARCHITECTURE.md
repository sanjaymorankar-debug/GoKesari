# GoKesari — Architecture & Decisions

> **Updated 24-Nov-2026.** This file began as the design of the first build, a
> "Dairy & Bakery Marketplace" (Aug 2026). The core rules in §2 and §5–§9
> (money, wallet, subscriptions, online/offline selling, security) still hold.
> Sections that described the hosting of that time (Hostinger Node.js hosting,
> Neon, and in Oct–Nov 2026 the split seller / customer databases) are replaced
> by §1.2 and §11; the history is in the records linked there.

GoKesari (gokesari.com, staging test.gokesari.com) is a local-shop marketplace
for India: customers order from nearby shops of many types (dairy, bakery,
grocery, medical, puja samagri, newspapers, …), shops are onboarded and paid
out by GoKesari, riders deliver, and dealers / franchisees grow the shop
network for a commission. One Next.js app serves the website, the admin and
staff back office, and the Android / iPhone app (a native shell around the
site, `mobile/`).

## 1. Technology decisions

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 (App Router) + React 19 + TypeScript (strict) | Server Components + Route Handlers give one deployable unit; server-side authz by default. |
| Runtime | Node.js 24 on our own server (§1.2) | Pinned by the server kit (`scripts/vps-app/10-install.sh`). |
| Styling | Tailwind CSS v4 | Utility-first, responsive, no runtime cost. |
| Database | PostgreSQL 18, one database per site | Transactional integrity, row locking, partial/unique indexes — required for wallet correctness. |
| ORM | **Drizzle ORM** (deviation — see §1.1) | Pure TypeScript, explicit SQL control for `FOR UPDATE` locking and isolation levels. |
| Auth | Auth.js (NextAuth v5): Google OAuth, plus an e-mailed sign-in code / link | Database-resolved role on every request (`src/server/auth.ts`). |
| Validation | Zod v4 | Every external input parsed at the server boundary. |
| Client state | Zustand (UI only) | Cart/wallet/subscription state is **server-owned**; Zustand holds ephemeral UI state only. |
| Payments | Gateway chosen by `PAYMENT_GATEWAY`: **`CASHFREE` on gokesari.com** (since 19-Nov-2026), **`SANDBOX` on test.gokesari.com** (the app's built-in test payment page; owner, 24-Nov-2026; Admin → Finance → Cashfree set-up shows the live value) | Server-side confirmation with the gateway's own API; webhook signature verification; the site refuses a gateway environment that does not match it ([docs/payments-gateway-2026-10.md](docs/payments-gateway-2026-10.md), [docs/payments-cashfree-audit-2026-11/](docs/payments-cashfree-audit-2026-11/README.md)). |
| Tests | Vitest (unit + integration against real Postgres), Playwright (E2E and the QA suite in `tests/qa`) | Integration tests run real SQL so concurrency/idempotency claims are actually proven. |

### 1.1 Deviation: Drizzle instead of Prisma

The brief prefers Prisma. Prisma was installed first and **could not be used**: it requires
Rust engine binaries fetched from `binaries.prisma.sh`, which is unreachable from this build
environment (HTTP 403 at the network proxy). `prisma init`, `generate` and `migrate` all fail.

Drizzle ORM was adopted because it is pure TypeScript with zero binary dependencies. Beyond
unblocking the build it is a better fit here:

- **Explicit transaction control.** Wallet integrity needs `SELECT … FOR UPDATE` and settable
  isolation levels. Drizzle exposes both directly; Prisma abstracts them away.
- **Deployment simplicity.** No platform-specific engine binary to ship with the build.
- **Migrations are plain SQL** files under `drizzle/`, reviewable in PRs and runnable by any DBA.

Trade-off accepted: less schema-level magic (no automatic nested writes). Business logic lives in
explicit service functions anyway, so this is not a real loss.

### 1.2 Hosting and data (since 17-Nov-2026)

Both sites run on GoKesari's own server, **`gk-db-1`** (Hostinger KVM 4, Mumbai):

| Site | Database (PostgreSQL 18) | Website slot | Deploys from |
|---|---|---|---|
| gokesari.com | port 5432, `gokesari` | `gokesari-prod` | `main` |
| test.gokesari.com | port 5433, `gokesari_test` | `gokesari-staging` | `staging` |

- **One database per site** (`DATABASE_URL`), every table in it; the app reaches it over the
  local Unix socket. The product master uses the same database through `await appSql()`
  (`src/server/pmd/db.ts`).
- **Seller and customer tables still have no foreign keys between them** — a leftover of the
  split below. Services check those links and delete dependants explicitly.
- **External side effects stay out of `db.transaction`** (payment gateway, SMS, e-mail, push,
  uploads): they run after commit or through an idempotent outbox.
- **Deploys:** the server's `gk-deploy` agent builds each new commit of the branch and switches
  blue/green with no downtime, one deploy at a time (§11, [DEPLOYMENT.md §3](DEPLOYMENT.md)).
- **Backups:** pgBackRest (point-in-time) plus nightly encrypted dumps, on the server
  ([RUNBOOK](docs/neon-to-vps-2026-11/RUNBOOK.md)).

History (superseded, kept for the record):

| Period | Layout | Record |
|---|---|---|
| Until 17-Nov-2026 | Hostinger Node.js Web App Hosting, built by Hostinger from `main` / `staging` | [docs/app-to-vps-2026-11/](docs/app-to-vps-2026-11/) |
| Until 17-Nov-2026 | Neon PostgreSQL (moved from Ohio to Singapore on 28-Oct-2026) | [docs/db-region-move-2026-10/](docs/db-region-move-2026-10/), [docs/neon-to-vps-2026-11/](docs/neon-to-vps-2026-11/) |
| 19-Oct – 04-Nov-2026 | Seller / customer **database split** joined by postgres_fdw (`SELLER_DATABASE_URL`, `DB_SPLIT_MODE`) — removed; do not reintroduce its rules | [docs/db-split-2026-10/](docs/db-split-2026-10/), [docs/db-fdw-removal-2026-11/](docs/db-fdw-removal-2026-11/), [docs/neon-cost-cut-2026-11/](docs/neon-cost-cut-2026-11/) |

## 2. Money and quantity representation

Two rules that prevent an entire class of financial bug:

- **All money is integer paise** (`bigint`, JS `number` mode). `₹70.00` is stored as `7000`.
  Floating point never touches a monetary value. Formatting to `₹` happens only at the view layer.
- **All quantities are integer milli-units** (thousandths). `2 L` is `2000`; `0.5 L` is `500`.
  Lets customers use `±0.5 L` steps with exact arithmetic.

Line total = `unitPricePaise × quantityMilli / 1000`, computed server-side with integer math.

## 3. Module map

```
src/
  server/
    db/            schema (one file, every table), client, upsert helper
    services/      the original business logic: shops, products, cart, orders, wallet,
                   subscriptions, notifications, reports, audit, …
    <domain>/      newer modules, one folder each — e.g. payments, payouts, rider-wallet,
                   dealers, franchise, health, consult, puja, tax / gst / invoicing /
                   statutory, kyc, documents, registration, rbac-v2 (+ rbac-*), whatsapp,
                   email, notifications, pmd (product master), cron
    authz/         role → permission matrix, guards
    config/        admin-editable rules (Admin → Settings); feature flags are rows in the database
  app/             pages and route handlers (thin: parse → authorize → call service → respond);
                   one folder per area: admin, shop, dealer, franchise, health, consult,
                   puja, staff, operator, delivery-partner, …; api/ holds the route handlers
  components/      presentational, no business logic
  lib/             money, dates, errors, formatting, env (src/lib/env.ts validates every variable)
drizzle/           plain-SQL migrations (0000 … ), applied only by the database workflows
mobile/            the Android / iPhone app (Expo), a shell around the site
tests/             unit, integration (real Postgres), e2e, qa (the automated test plan)
```

Each larger module has its own folder under `docs/` with a README and, where the owner made
choices, a `DECISIONS.md`. Newer features ship **behind a rule or feature flag, off by default**,
and are switched on per site from the admin pages.

**Rule:** UI components never compute prices, totals, balances or permissions. They render what a
service returned.

## 4. Roles & permissions

The first build had four roles: `CUSTOMER`, `SHOP_OWNER`, `OPERATOR`, `ADMIN`. The `user_role`
enum (`src/server/db/schema.ts`) has since grown, always additively:

| Added | Roles |
|---|---|
| First build | `CUSTOMER`, `SHOP_OWNER`, `OPERATOR`, `ADMIN` |
| Oct 2026 | `DELIVERY_PARTNER` (riders), `SOCIETY_ADMIN`, `OPERATOR_LIMITED` (onboards shops for their owners), `DEALER`, `CA` (TDS settings, read-only payouts) |
| RBAC v2, 22–23-Nov-2026 | Staff roles `ACCOUNTANT`, `SUPPORT_MANAGER`, `SUPPORT_USER`, `OPERATIONS_MANAGER`, `OPERATIONS_USER`, plus dealership / franchise staff roles (0181); approval engine with optional four-eye (second admin) approval — [docs/rbac/](docs/rbac/README.md) |

A person can hold more than one role through role grants; each RBAC v2 area is behind its own
`rbac_v2_*` flag.

Authorization is a **capability matrix** (`src/server/authz/permissions.ts`) checked server-side on
every mutation. Role is read from the database session, never from the client. Ownership checks
(is this shop mine?) are separate from capability checks and both must pass.

Self-assignment of `OPERATOR`/`ADMIN` is impossible: role is never accepted from any request body.
New users (Google or e-mail sign-in) are created as `CUSTOMER` with a wallet, inside one transaction.

Guarded invariants:
- Shop owners cannot change their own Kesari/Green classification (operator/admin only).
- Shop owners can only touch rows where `shop.ownerId = session.user.id`.
- Operators get operational capabilities but not system config, role management, or user deletion.

## 5. Order lifecycle

```
PENDING → CONFIRMED → PREPARING → READY → OUT_FOR_DELIVERY → DELIVERED
        ↘ CANCELLED / PAYMENT_FAILED / WALLET_INSUFFICIENT
                    ↘ REFUND_PENDING → REFUNDED
```

Transitions are validated by a state machine; illegal transitions are rejected server-side.
Carts spanning multiple shops are **split into one order per shop** at checkout.

## 6. Wallet architecture (financial integrity)

- One wallet per customer, `balancePaise bigint NOT NULL CHECK (balance >= 0)`.
- Every balance change writes an **immutable** `wallet_transactions` row recording
  `previousBalance`, `amount`, `newBalance`, type, and references. Rows are never updated or deleted.
- All mutations run inside `db.transaction()` opening with
  `SELECT … FROM wallets WHERE user_id = $1 FOR UPDATE` so concurrent deductions serialize.
  READ COMMITTED (the default) is deliberate: the row lock already provides the necessary
  serialisation, and it avoids the spurious serialisation failures — and retry loops —
  that REPEATABLE READ would introduce under load.
- **Idempotency:** `wallet_transactions.idempotency_key` is `UNIQUE`. A retried operation collides
  on the unique index and returns the original transaction instead of double-charging.
- The DB `CHECK` constraint is the last line of defence — a negative balance is impossible even if
  application logic is wrong.
- Wallet is credited **only** after the server independently confirms payment with
  Cashfree's own API (never from anything the client reports). `payments.gateway_payment_id`
  is `UNIQUE`, so a replayed webhook cannot credit twice.

## 7. Subscription architecture

```
Subscription (recurring intent: product, shop, qty/day, frequency, window)
   ├─ SubscriptionDailyOverride  (per-date qty change, or SKIP)
   └─ SubscriptionOrder          (materialised delivery for one date) → Order
```

Effective quantity for a date:
1. If a `PAUSED` window covers the date → no delivery.
2. Else if an override exists for that date → `SKIP` (no delivery) or its quantity.
3. Else → the subscription's standing quantity.

Overrides apply to exactly one date, so the schedule reverts automatically the next day.

**Daily order engine** (`generateDailyOrders`) is idempotent by construction: a `UNIQUE(subscription_id,
delivery_date)` index on `subscription_orders` means a second run of the same day is a no-op. It is
run at 05:00 IST by the `daily` cron entry point (`POST /api/cron/daily`, guarded by a `CRON_SECRET`
bearer token), which the server's `gk-cron@<site>-daily` timer calls (§11). `POST
/api/cron/daily-orders` still runs it alone, for a manual run or a backfill.

Pricing: each generated order snapshots the shop product's **current** online price into the order
item. Completed orders therefore keep their historical price forever; price changes only affect
future generations.

Insufficient balance → order is created with status `WALLET_INSUFFICIENT`, no deduction occurs, the
customer is notified, and the day can be retried after a top-up.

## 8. Online / offline selling

`shop_products` carries independent `onlineSaleEnabled` / `offlineSaleEnabled` flags and separate
`onlinePricePaise` / `offlinePricePaise`. A product is purchasable online only if **all** hold:

```
shop.status = APPROVED ∧ shopProduct.isActive ∧ shopProduct.isAvailable
∧ onlineSaleEnabled ∧ onlinePricePaise IS NOT NULL ∧ (¬trackInventory ∨ onlineStock ≥ qty)
```

Enforced by `assertOnlinePurchasable()` in the service layer — called on add-to-cart, checkout and
every subscription order generation. A DB `CHECK` also forbids `onlineSaleEnabled` without a price.

## 9. Security model

- Google OAuth or an e-mailed one-time sign-in code / link; no passwords stored.
- Role, price, balance, ownership and totals are **always** recomputed server-side.
- Zod-validated inputs; parameterised queries throughout (no string-built SQL).
- Rate limiting on auth, payment and cron endpoints.
- Audit log on: shop approval/rejection, classification change, price change, availability change,
  wallet adjustment, refund, role change, subscription modification, order status change.
- Secrets only in env vars; none in the client bundle.

## 10. Testing strategy

| Level | Tool | Covers |
|---|---|---|
| Unit | Vitest | money math, effective-quantity resolution, order state machine, permission matrix |
| Integration | Vitest + real Postgres | wallet concurrency, duplicate payment callbacks, negative-balance prevention, subscription idempotency, online/offline enforcement, authz |
| E2E | Playwright | the §55 acceptance scenario end to end |
| QA plan | Playwright (`tests/qa`, `playwright.qa.config.ts`) | the automated test plan, UI + API, run against the local server, test.gokesari.com or gokesari.com |

Integration tests run against the database in `TEST_DATABASE_URL` and truncate between cases.
CI (`.github/workflows/ci.yml`) runs them on every PR; the staging queue adds the deploy, the
post-deploy check and the guest QA tier on test.gokesari.com.

## 11. Background jobs, releases and environments

**Events first, cron as the safety net.** Everything a customer, shop or rider does is handled in
the request that causes it. Three cron entry points cover only what no event can start (a deadline
passing, a retry, a gateway reply that never came, timed sends, the 05:00 IST subscription orders,
payouts): `/api/cron/every-minute`, `/api/cron/hourly` and `/api/cron/daily`
(`src/server/cron/schedule.ts`). On the server they are systemd timers
`gk-cron@<site>-<job>`, every minute on both sites. Jobs and times:
[docs/cron-schedule.md](docs/cron-schedule.md), [docs/crontab.txt](docs/crontab.txt).

**Release path.**

1. A PR into `staging` is labelled `ready-for-staging`; the "Staging queue" workflow merges labelled
   PRs one at a time and tests each on test.gokesari.com ([docs/staging-queue/](docs/staging-queue/README.md)).
2. Migrations run only through the GitHub database workflows ("Test database" on a push to
   `staging`; "Production database" by hand, before the merge into `main`), never during a build.
3. Production releases (a merge of `staging` into `main`) go one at a time, in the owner's
   23.00 IST window, and each is followed by the Post-deploy check ([DEPLOYMENT.md §3](DEPLOYMENT.md)).

**Per-site settings.** Each site's environment is in its env file on the server
(`gk-site env …`). Test data only on staging (`PAYMENT_GATEWAY=SANDBOX`, Cashfree sandbox keys, KYC sandbox keys, e-mail redirected
to the testing inbox); live keys only on production. The app refuses a mismatched pairing for
payments and KYC.
