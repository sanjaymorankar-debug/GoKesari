# Seller DB / Customer DB split (Task 1)

Status, 13 Oct 2026: **tooling built and tested; the split itself is waiting on the
seller database details.** The site keeps running on its single database
(`DB_SPLIT_MODE=single`, the default) until the cut-over steps below are done.
Nothing in this release moves data or changes how the site reads or writes.

| Document | What it is |
|---|---|
| this README | Design, ownership, relationships, how to run it, cut-over and rollback |
| [RELATIONSHIPS.md](RELATIONSHIPS.md) | Generated: every table's database, and all 111 relationships that cross the two databases |
| [SAMPLE_VERIFICATION_REPORT_local.md](SAMPLE_VERIFICATION_REPORT_local.md) | A real run of the migration on a local copy of the test schema: 190 tables, every row and checksum equal, no broken link |

## 1. The two databases

| Database | Owns | Tables |
|---|---|---|
| **gokesari_seller** | Shops and their owners' shop records, KYC and documents (seller verification, legal documents, the new document uploads), the product catalogue and the product-master schema `pmd`, inventory, pricing, the shop wallet, settlements (payouts), shop registration and its referral codes and commissions, accounting integrations | 90 (63 public + 27 `pmd`) |
| **gokesari_customer** | Customers, addresses, carts, orders and everything after an order (payments, invoices, credit notes, delivery, returns, disputes, ratings), the customer wallet, vouchers, coupons, subscriptions, societies, campaigns — **plus the platform core**: users and sign-in, roles, settings, audit log, events, notifications, delivery partners | 100 |

The platform core sits in the customer database because it is today's
database: users, sign-in sessions and settings never move, so sign-in and
admin are untouched by the split. The seller database reads the few core
tables it needs (`users`, `platform_settings`, `roles`, `user_role_grants`)
through postgres_fdw.

Ownership lives in code, in one place: `src/server/db/split/ownership.ts`.
A unit test fails if a table is added to the schema without an owner.

## 2. Relationships across the two databases

PostgreSQL can't enforce a foreign key between two databases. The 444 foreign
keys today split into:

- **333 inside one database** — kept as real foreign keys (the migration
  re-creates and re-validates them after loading).
- **111 across the two databases** — listed in [RELATIONSHIPS.md](RELATIONSHIPS.md).
  The important ones:

  | Child (customer DB) | → Parent (seller DB) |
  |---|---|
  | `orders.shop_id` | `shops.id` |
  | `order_items.shop_product_id`, `substitute_shop_product_id` | `shop_products.id` |
  | `cart_items.shop_product_id` | `shop_products.id` |
  | `subscriptions.shop_id`, `shop_product_id` | `shops.id`, `shop_products.id` |
  | `payments.shop_id`, `tax_invoices.shop_id`, `order_ratings.shop_id`, `order_disputes.shop_id`, `return_requests.shop_id` … | `shops.id` |

  | Child (seller DB) | → Parent (customer/core DB) |
  |---|---|
  | `shops.owner_id` and every `*_by` reviewer column | `users.id` |
  | `shop_wallet_transactions.order_id`, `payment_id` | `orders.id`, `payments.id` |
  | `shop_sla_events.order_id`, `shop_suspension_orders.order_id` | `orders.id` |

How they stay correct:

1. **Stable shared keys.** Every link is a UUID (`shop_id`, `shop_product_id`,
   `product_id`, `order_id`, `user_id`). The migration copies them unchanged;
   nothing is renumbered.
2. **Service-layer checks** — `src/server/db/split/integrity.ts`:
   `assertShopExists`, `assertShopProductsBelongToShop` (every line of an
   order belongs to that order's shop), `assertOrderExists`,
   `assertUserExists`. Each is a primary-key lookup in the database that owns
   the parent.
3. **Cross-database reads** — `src/server/db/split/cross-reads.ts`
   (`getOrderWithShopAndProducts`: order and lines from the customer database,
   shop and products from the seller database, joined in code by UUID, with
   any broken link reported), and **postgres_fdw** for SQL reads and reports:
   `seller_remote.shops / shop_products / products / product_categories /
   product_images / shop_wallets` inside the customer database, and
   `core_remote.users / platform_settings / roles / user_role_grants` inside
   the seller database.
4. **Verification** — `scripts/db-split/run.ts verify` counts, for every one of
   the 111 links, the child values whose parent is missing. It must be 0.
5. **Deletes.** Today some of these keys cascade or restrict (the "On
   delete" column in RELATIONSHIPS.md — e.g. deleting a shop deletes its cart
   items). Shops are soft-deleted (`deleted_at`) in normal use. Before Phase 3
   switches any delete path, the service layer must do the other database's
   part (cascade or refuse) explicitly; `verify` catches anything missed.

**Order status stays real-time and event-driven.** Orders, their status
history and the event outbox (`domain_events`) all live in the customer
database, in the same transaction as today, so order status changes, delivery
OTPs and notifications work exactly as now. The seller side sees order
changes through the same events.

## 3. Connection settings (env)

| Variable | Default | Meaning |
|---|---|---|
| `DB_SPLIT_MODE` | `single` | `single`: everything in `DATABASE_URL` (today). `shadow`: still served from `DATABASE_URL` while the two new databases are filled and verified. `split`: seller reads go to `SELLER_DATABASE_URL` through `src/server/db/split` (Phase 2) |
| `SELLER_DATABASE_URL` | — | **PLACEHOLDER** — gokesari_seller. To be shared by the owner for test.gokesari.com |
| `CUSTOMER_DATABASE_URL` | `DATABASE_URL` | gokesari_customer |

GitHub secrets for the workflow (Settings → Environments → `test` / `production`):
`TEST_SELLER_DATABASE_URL`, `TEST_CUSTOMER_DATABASE_URL`,
`PROD_SELLER_DATABASE_URL`, `PROD_CUSTOMER_DATABASE_URL` (the source is the
existing `TEST_DATABASE_URL` / `PROD_DATABASE_URL`). Keys come from the
environment only — never from code.

## 4. Running the migration

The source database is **only read** — never changed. So the migration can be
repeated, and the site keeps running on the source throughout.

From GitHub (Actions → **Database split** → Run workflow, branch `staging`, target `test`):

1. `plan` — read-only; prints ownership and the cross-database links.
2. `dry-run` — checks the three databases are reachable and distinct.
3. `migrate` — builds both schemas with the site's own migrations, drops the
   tables the other database owns, copies every row with `COPY` (foreign keys
   and triggers held off during the load, then re-created and re-validated;
   sequences carried over), then writes the **verification report** (row
   count + order-independent checksum per table, and missing parents per
   cross-database link) to the run summary and as an artifact. A difference
   fails the run.
4. `fdw` — sets up postgres_fdw both ways.
5. `verify` — re-run the report at any time.

Production: the same, from `main`, target `production`, `confirm = SPLIT
PRODUCTION`; refused unless the test split verifies cleanly.

Locally:

```bash
export SOURCE_DATABASE_URL=postgresql://…/dairy_bakery_test
export SELLER_DATABASE_URL=postgresql://…/gokesari_seller
export CUSTOMER_DATABASE_URL=postgresql://…/gokesari_customer
npx tsx scripts/db-split/run.ts plan
npx tsx scripts/db-split/run.ts migrate --apply --report report.md   # add --allow-remote for a non-local host
npx tsx scripts/db-split/run.ts verify
npx tsx scripts/db-split/run.ts fdw --apply
SOURCE_DATABASE_URL=… npx tsx scripts/db-split/relationships.ts      # regenerate RELATIONSHIPS.md
```

## 5. Cut-over plan (expand → verify → switch → contract)

| Phase | What happens | Site behaviour | Status |
|---|---|---|---|
| 0. Build | Ownership map, tooling, integrity/cross-read layer, workflow, tests | unchanged | **done (this release)** |
| 1. Copy + verify (test) | Run `migrate` and `fdw` on test.gokesari.com's databases; report must be PASS | unchanged (`single`) | **blocked: seller DB details** |
| 2. Keep in sync (shadow) | Logical replication from the source to both new databases (`CREATE PUBLICATION … FOR TABLE <owned tables>` on the source, `CREATE SUBSCRIPTION` on each target; Neon: enable logical replication on the project). `verify` daily | unchanged (`shadow`) | after Phase 1 |
| 3. Switch reads, then writes | Services move to `sellerDb()` / `customerDb()` one area at a time (catalogue reads → shop pages → seller writes), each behind `DB_SPLIT_MODE=split` on test first, with the integrity checks before every cross-database write | seller data served from gokesari_seller | separate release, per area |
| 4. Contract | Stop replication; keep the source as a read-only archive for 30 days, then retire it | — | last |

Production follows each phase only after it has run cleanly on test.

## 6. Backup and rollback

- **Before any production step**: Neon restore point (the workflow records the
  time), plus the source is never written to by the migration.
- **Rollback of Phases 1–2**: set `DB_SPLIT_MODE=single` (already the
  default) — the site never stopped using the source. Drop the two new
  databases (or re-run `migrate --replace`). No data can be lost because the
  source was only read.
- **Rollback of Phase 3**: set `DB_SPLIT_MODE` back to `shadow`; the source
  is still kept current by replication until Phase 4.
- Rollback script for this release's schema change (the document uploads
  table, unrelated to the split): `scripts/rollback-0075.sql`.

## 7. Tests

- `tests/unit/db-split-ownership.test.ts` — every table has exactly one owner;
  core entities are where the brief puts them.
- `tests/integration/db-split.test.ts` — on the CI PostgreSQL: builds both
  databases from the test schema, copies a shop → product → order fixture,
  checks every row count and checksum, that the source is untouched, that
  every cross-database link resolves (and that a deleted shop is caught),
  reads `orders ⋈ seller_remote.shops ⋈ seller_remote.products` through
  postgres_fdw, and runs the service-layer checks.

## 8. Known limits

- SQL functions that read tables on both sides (e.g. `shop_sells_food`) need
  the fdw tables (or a service call) once the site runs `split`; Phase 3
  covers them area by area.
- Database triggers that write to a table in the other database (e.g. status
  history) are re-pointed in Phase 3; in Phases 1–2 the targets are written
  only by the copy and by replication, which doesn't fire triggers.
