# GoKesari

GoKesari (gokesari.com) is a marketplace for local shops in India: customers
order from nearby shops of many types — dairy, bakery, grocery, medical, puja
samagri, newspapers and more — with wallet and online payments, daily
subscriptions, delivery by GoKesari's riders, shop onboarding and payouts, and
a dealer / franchise network that grows the shops. test.gokesari.com is the
staging site.

> It began in Aug 2026 as the "Dairy & Bakery Marketplace" (wallet payments,
> Kesari/Green shop classification, online/offline product control, the daily
> milk subscription engine). Those rules still hold and are described below;
> everything since is in the module docs under [docs/](docs/).

- **Design and the rules behind it:** [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Running the sites** (server, deploys, migrations, env, backups, rollback): [DEPLOYMENT.md](./DEPLOYMENT.md)
- **How work reaches the sites:** a PR into `staging`, labelled
  `ready-for-staging`, goes through the [staging queue](docs/staging-queue/README.md);
  production releases (staging → `main`) go one at a time in the owner's 23.00 IST window.
- **Rules for coding sessions:** [CLAUDE.md](./CLAUDE.md) and [AGENTS.md](./AGENTS.md)

## How it runs (since 17-Nov-2026)

| Site | Branch | Database | Server slot |
|---|---|---|---|
| gokesari.com | `main` | PostgreSQL 18, `gokesari` | `gokesari-prod` |
| test.gokesari.com | `staging` | PostgreSQL 18, `gokesari_test` | `gokesari-staging` |

Both sites run on GoKesari's own server (`gk-db-1`, Mumbai). Its deploy agent
(`gk-deploy`) builds each new commit of the branch and switches blue/green with
no downtime; systemd timers call the three cron entry points every minute
([docs/cron-schedule.md](docs/cron-schedule.md)). Neon, Hostinger's Node.js
hosting and the seller / customer database split are no longer used
([ARCHITECTURE.md §1.2](./ARCHITECTURE.md#12-hosting-and-data-since-17-nov-2026)).

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 ·
PostgreSQL 18 · Drizzle ORM · Auth.js (Google OAuth + e-mailed sign-in code) ·
Zod · Cashfree · Vitest · Playwright · Node.js 24

> Drizzle is used instead of Prisma. The reason is documented in
> [ARCHITECTURE.md §1.1](./ARCHITECTURE.md#11-deviation-drizzle-instead-of-prisma).

## Quick start (local)

```bash
# 1. PostgreSQL (any local instance)
createdb gokesari_dev
createdb gokesari_dev_test

# 2. Configure: create .env with at least DATABASE_URL, AUTH_SECRET and
#    CRON_SECRET (table below; every variable is validated in src/lib/env.ts)

# 3. Schema + reference data
npm install
npm run db:migrate
npm run db:seed           # add -- --minimal for reference data only

# 4. Run
npm run dev               # http://localhost:3000
```

Sign in at `/signin`. In development an email-only form is available (disabled
in production builds); on the sites, Google or an e-mailed sign-in code.

The seed creates five demo shops in Pune, 18 categories and 40 products,
including one deliberately **offline-only** product (Malai Paneer at Kesari
Dairy Farm) so the online/offline rule is visible immediately.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `TEST_DATABASE_URL` | tests | Separate database for integration tests |
| `AUTH_SECRET` | yes | Auth.js session encryption. Generate with `openssl rand -base64 32` |
| `AUTH_URL` | prod | Canonical app URL, e.g. `https://gokesari.com` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | prod | Google OAuth client. Without these, Google sign-in is hidden |
| `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` | prod | Payment gateway. Without these the app runs in MOCK payment mode |
| `CASHFREE_ENV` | no | `sandbox` (default) or `production` |
| `PAYMENT_GATEWAY` | sites | Gateway for online order payments: `CASHFREE` on gokesari.com, `SANDBOX` (default; the built-in test payment page) or Cashfree sandbox keys on test.gokesari.com. See [docs/payments-gateway-2026-10.md](docs/payments-gateway-2026-10.md) |
| `CRON_SECRET` | yes | Bearer token guarding the daily-order endpoint |
| `BOOTSTRAP_ADMIN_EMAILS` | first deploy | Comma-separated emails granted ADMIN on first sign-in only — meant to be removed once that's done |
| `PERMANENT_ADMIN_EMAILS` | recommended | Comma-separated emails re-promoted to ADMIN on *every* session, not just first sign-in — for the accounts that must never be lockable-out even by an accidental or malicious role change. Meant to stay set (unlike `BOOTSTRAP_ADMIN_EMAILS`). No default — set it yourself; there is no hard-coded fallback (see the audit's SEC-03) |
| `PAN_ENCRYPTION_KEY` | before PAN/KYC are collected | Base64, exactly 32 bytes (`openssl rand -base64 32`). AES-256-GCM key that encrypts shop PANs and delivery-partner KYC/bank details at rest. Without it those values are refused, never stored in plaintext. **Back it up separately from the database — losing or changing it makes every encrypted value unrecoverable** |
| `SUBSCRIPTION_CUTOFF_HOUR` | no | Delivery cutoff hour, default `20` |
| `APP_TIMEZONE` | no | IANA zone for delivery dates, default `Asia/Kolkata` |

An empty value (`FOO=`) is treated as unset. This table is the core set; the
full list (KYC, e-mail and mailbox pool, OCR, mobile deep links, …) is in
[DEPLOYMENT.md §2](DEPLOYMENT.md#2-configure-environment-variables) and
`src/lib/env.ts`. On the server each site's values are in its env file
(`gk-site env …`), never in the repository.

## The daily order engine

Subscriptions materialise into orders through one idempotent job,
`daily-orders`, which the `daily` cron entry point runs at 05:00 IST:

```bash
curl -X POST https://<host>/api/cron/daily \
     -H "Authorization: Bearer $CRON_SECRET"
```

On the sites the server's `gk-cron@<site>-daily` timer makes this call
([docs/cron-schedule.md](docs/cron-schedule.md)). It is safe to run
repeatedly: a `UNIQUE(subscription_id, delivery_date)` index means a second run
for the same day is a no-op, so retries, overlapping runs and manual replays
cannot double-charge. To backfill one day, call the job alone:
`POST /api/cron/daily-orders` with `{"date":"YYYY-MM-DD"}`.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Seed reference + demo data (`-- --minimal` for reference only) |
| `npm run db:studio` | Browse the database |
| `npm test` | Unit + integration tests (needs `TEST_DATABASE_URL`) |
| `npm run test:e2e` | Playwright end-to-end tests (needs a running dev server) |
| `npm run typecheck` | TypeScript, no emit |

## Roles

| Role | Can |
|---|---|
| **Customer** | Browse, cart, order, wallet, subscriptions, daily quantity changes |
| **Shop Owner** | Register a shop, manage own products/prices/stock, receive orders, view own sales |
| **Delivery partner** | Rider: accept and deliver orders, wallet and payouts |
| **Operator** / **Operator (limited)** | Approve/reject shops, set Kesari/Green, manage catalogue and orders / onboard shops for their owners (own shops only) |
| **Dealer** | Authorised dealers, franchisees and their team: own shops, commission, payouts |
| **CA** | TDS settings and records, read-only payouts |
| **Staff roles** (RBAC v2) | Accountant, Support manager / user, Operations manager / user, dealership staff — each area behind an `rbac_v2_*` flag ([docs/rbac/](docs/rbac/README.md)) |
| **Administrator** | Everything, plus roles, wallet adjustments, system config, audit logs; with four-eye on, sensitive changes need a second admin |

A new user becomes a **Customer** with a wallet automatically. Roles are
never accepted from a request — `OPERATOR` and `ADMIN` cannot be self-assigned.
Registering a shop promotes a Customer to Shop Owner.

**Shop owners cannot change their own Kesari/Green classification.** That is
operator/admin only, and every change is recorded with who, when and why.

## Key domain rules

**Money is integer paise; quantities are integer milli-units.** `₹70.00` is
`7000`; `2 L` is `2000`. No float ever touches a monetary value, and `±0.5 L`
steps stay exact.

**A product is purchasable online only if** the shop is `APPROVED`, the offering
is active and available, online selling is enabled, an online price exists, and
stock suffices. Enforced server-side on add-to-cart, checkout and every
subscription generation — and backed by database CHECK constraints.

**Completed orders keep their price forever.** Order lines snapshot the product
name and unit price, so a later price change affects only future orders.

**Subscription schedule resolution order:** subscription live → within
start/end window → not inside a pause window → weekday is scheduled → then a
per-date override may adjust or skip it. An override never creates a delivery on
an unscheduled day, and because it is scoped to one date the schedule reverts
automatically the next day.

**Dealer commission is per payee and frozen per shop.** Who earns what on a
shop is frozen when it is approved. Since 23-Nov-2026 the rates come from the
**dealer scheme engine** (admin-editable, versioned schemes;
[docs/dealer-platform/](docs/dealer-platform/README.md)). New dealers start on
**Free Dealership v2** (migration 0179); the 3-level TIERED model (20/4/3, at
most main dealer → team lead → agent) applies to dealers on it or moved to it by
an admin. A **paid franchise** buys a zone ([docs/franchise/](docs/franchise/README.md));
the territory dealer was retired on 21-Nov-2026 (territories are sold only as
franchise zones). Each payee is paid to their own verified bank account, one
payout per PAN per month. The earlier models are in
[docs/dealer-programme/](docs/dealer-programme/) and
[docs/referrals-dealer-2026-11/](docs/referrals-dealer-2026-11/).

## Testing

```bash
npm test                                    # unit + integration tests (needs TEST_DATABASE_URL)
CHROMIUM_PATH=/path/to/chrome npm run test:e2e   # E2E tests, desktop + mobile
```

Integration tests run against real PostgreSQL, which is the point: the
concurrency, idempotency and constraint guarantees below cannot be proven
against a mock.

CI runs the suite on every PR. The automated QA plan (UI + API checks in
`tests/qa`, against the local server, test.gokesari.com or gokesari.com) and its
results register are in [docs/testing/](docs/testing/).

What the original wallet and subscription suite proves:

- Concurrent wallet debits serialise — 10 simultaneous ₹100 debits against ₹1,000 leave exactly ₹0, no lost updates
- Overdraw is impossible — 5 concurrent ₹100 debits against ₹250 yield exactly 2 successes and 3 rejections
- The ledger chain stays contiguous under 20 concurrent writes
- A replayed operation never double-charges, including 10 fired concurrently
- Forged, mismatched and cross-user payment signatures are all rejected before any credit
- Re-running the daily job (including 5 concurrent runs) creates one order and one deduction
- Skip and pause produce zero orders and zero deductions
- A price change applies to future days only; past order lines are frozen
- An insufficient balance takes no money, consumes no stock, marks the day, and can be retried after top-up
- Offline-only products cannot enter a cart or be ordered
- A shop owner cannot reclassify their own shop even with the route guard bypassed

## Mobile app

`mobile/` is the Android and iPhone app: a native shell that shows this site,
so every feature here is in the app as soon as it is deployed. It is built in
Expo's cloud — see [mobile/README.md](./mobile/README.md). The website side of
it is small: Google sign-in for the app (`src/server/mobile-auth.ts`,
`src/app/mobile-auth/`) and the deep-link files under `src/app/.well-known/`.

## Project layout

```
src/
  server/
    db/          schema (every table), client
    services/    the original business logic — pure, testable, no React
    <domain>/    newer modules: payments, payouts, dealers, franchise, health,
                 consult, puja, tax, kyc, rbac-v2, cron, …
    authz/       permission matrix and guards
    api/         route-handler plumbing, rate limiting
  app/           pages per area (shops, cart, admin, shop, dealer, health, …)
                 and api/ route handlers — parse, authorize, delegate, respond
  components/    presentational only
  lib/           money, dates, errors, env
drizzle/         plain-SQL migrations
mobile/          the Android/iPhone app (separate Expo project)
scripts/         server kits (vps-app, vps-db), release checks, backfills
docs/            one folder per module or project, with its decisions and test results
tests/
  unit/          pure logic
  integration/   real PostgreSQL
  e2e/           Playwright, desktop + mobile
  qa/            the automated QA plan
```
