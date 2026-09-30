# GoKesari — Database Change Plan

*No schema change has been made by this audit. This plan governs how future changes should be made, and lists the specific additive changes each roadmap item needs.*

## 1. Existing schema (baseline)

PostgreSQL 16, one database, two schemas, 76 tables/enums total, 16 forward-only Drizzle SQL migrations applied in order (`0000`…`0015`, 2026-08-18 → 2026-09-19). No down-migrations exist anywhere in the project — this has been the policy since the first migration, not something introduced here.

| Migration | Date | Adds |
|---|---|---|
| `0000_luxuriant_morgan_stark` | 08-18 | Initial schema: users/auth, shops, catalogue, cart, orders, wallet, subscriptions, notifications, audit — ~30 tables |
| `0001_expand_shop_types` | 08-19 | Expands `shop_type` enum to 44 values |
| `0002_broken_red_wolf` | 08-20 | Price-approval workflow, Excel uploads, registration fees, referrals, shop payments (9 tables) |
| `0003_shop_registration_number` | 08-20 | `shops.registration_number` sequence + backfill |
| `0004_organic_strong_guy` | 08-20 | Product approval status |
| `0005_glamorous_eternals` | 08-20 | Excel upload column tweak |
| `0006_bitter_lila_cheney` | 08-20 | Vouchers (4 tables) |
| `0007_chemical_goblin_queen` | 08-20 | Payments column tweak |
| `0008_green_turbo` | 08-21 | Grievances, consents |
| `0009_overjoyed_annihilus` | 08-23 | Payments column tweak |
| `0010_magenta_jackpot` | 08-24 | Maps usage log |
| `0011_windy_chat` | 08-24 | Delivery partners |
| `0012_curly_bushwacker` | 08-24 | Delivery orders, earnings config, earnings ledger |
| `0013_overconfident_clint_barton` | 08-25 | GST/PAN verification enums + columns |
| `0014_charming_omega_red` | 09-07 | Brands, product images, MRP history, subcategories, stock alerts |
| `0015_product_master_platform` | 09-19 | The entire `pmd` schema (~29 tables) |

**State verified in this audit:** all 16 applied cleanly to a fresh local Postgres 16 cluster (53 `public` tables, 136 `pmd` tables — the `pmd` schema has its own internal structure beyond top-level tables). Per prior session notes (not re-verified live here): the **test** database (Neon) has all 16 applied with 1,179 promoted products; **live** has migrations through `0014` only — `0015`/`pmd` has never been applied to live, and live's marketplace catalogue is empty/unused. Confirm this with the user before any live-database work.

## 2. Change policy (unchanged from the project's own established practice)

1. **Backup before every migration.** `pg_dump "$DATABASE_URL" -Fc` (already the nightly-backup command in `DEPLOYMENT.md` §7) — run an ad hoc one immediately before applying any new migration to test or live.
2. **Additive by default.** New table, new nullable column, new enum value, new index. Every gap in this audit that touches the schema (§3 below) fits this shape — none requires dropping or renaming an existing column, table, or ID scheme.
3. **Expand-then-contract for anything that looks destructive.** If a later phase genuinely needs to remove a column (e.g., the plaintext KYC columns in finding SEC-02 once encrypted equivalents exist and are backfilled), add the new column, backfill, switch the code, and drop the old column only in a **subsequent, separate** release — never in the same migration that adds the replacement.
4. **Test on the disposable local cluster or a Neon branch first**, then staging, then (only after explicit approval) live. Never point `db:migrate`'s ambient `DATABASE_URL` at Neon by accident — see the project's own note on this (`.env` holds Neon URLs; override explicitly for anything local).
5. **Every new migration gets a one-line comment matching the existing convention** (see e.g. `0011_windy_chat.sql`'s header) explaining what it adds and why.
6. **Rollback plan is written before the migration is applied**, not after something goes wrong — see §5.

## 3. Additive changes needed, by roadmap item

None of these have been written yet. Ordered to match the priority in the gap analysis (P0 first).

| Change | For gap(s) | Shape |
|---|---|---|
| Encrypted KYC/bank columns on `delivery_partners` | SEC-02 | New nullable `*_encrypted` columns alongside the existing plaintext ones; backfill script; drop plaintext columns in a later release |
| `inventory_movements` reason value for restock-on-cancel | DEF-01 | No schema change — `restockOnline` and its ledger insert already exist; this is a service-code wiring fix |
| `SHOP_NEW_ORDER` notification type | DEF-02 | No schema change — `notifications.type` is free text, not an enum |
Transaction + row locks for `assignNearestPartner` | DEF-03 (narrowed scope) | No schema change — enforce "one active assignment per partner" inside the transaction with row locks for Phase 1b. Do **not** add a partial unique index on `delivery_orders (delivery_partner_id, status)` yet — see the `delivery_offers` row below; once D11 is decided, the "at most one active assignment" constraint belongs on whichever table ends up being the offer ledger, not bolted onto `delivery_orders` first and then moved |
| **`delivery_offers` table (or: replace `delivery_orders_order_id_unique`)** — **decision D11, added by the Opus review** | DEF-09; blocks the "offer expiry + re-offer excluding rejecters" part of the delivery-lifecycle gap (now Phase 7) and Phase 8's Reliability/Load-Balance scoring inputs | `delivery_orders_order_id_unique` (`schema.ts:1430-1435`) is unconditional, so today's reassignment overwrites the prior offer in place rather than recording history. Recommended (per the review): a new append-only `delivery_offers` table (one row per offer attempt: order, partner, status, timestamps) — genuinely additive, gives DEF-03's "no double-offer" constraint a natural partial-unique-index home, and gives Phase 8 its reliability data. The alternative — relaxing or replacing the unique index on `delivery_orders` directly — is **not additive** once that table holds live rows, and needs reverse SQL written in advance per §5 below if ever taken |
| ~~`orders.cancellation_fee_paise`~~ — not needed | DEF-08, decision **D10** (resolved 2026-09-22) | D10 landed on withholding the *existing* `deliveryFeePaise` on an `OUT_FOR_DELIVERY` cancel, not charging a new fee — so the DEF-08 fix needs **no schema change**: `cancelOrder` computes the refund from columns the order already has (`subtotalPaise`, `deliveryFeePaise`) based on status at cancel time |
| Shop service radius | CUS-15, SHP-07 | New nullable `shops.service_radius_km integer` |
| Product detail / price comparison | CUS-09, CUS-10 | No schema change — new read queries over existing `products`/`shop_products` |
| Society entity + verification | SOC-01/02 (needs decision D5) | New tables: `societies`, `society_blocks` (or similar), modelled on `shops`'/`shop_classification_history`'s shape (status enum, approval columns, audit) |
| Society address depth | CUS-03 | New nullable `addresses.society_id`, `block`, `flat` |
| Society worker authorization | SOC-03 | New tables: `society_workers` (membership + status), `society_worker_history` (immutable), modelled on `shop_classification_history` |
| New role `SOCIETY_ADMIN` | RBAC-07 | `ALTER TYPE user_role ADD VALUE 'SOCIETY_ADMIN'` (additive; Postgres enum values can only be added, never removed within a transaction that also uses the new value — see §4) |
| Order state extension (decision D8) | ORD-05, SHP-16 | `ALTER TYPE order_status ADD VALUE ...` for `SHOP_PENDING`, `ACCEPTED`, `REJECTED`, `RETURNED`, `DISPUTED`, `PARTIALLY_REFUNDED` |
| Master (parent) order | ORD-03 | New `master_orders` table; nullable `orders.master_order_id` |
| Tax fields used on orders | ORD-07 | New `orders.tax_breakdown jsonb` or per-line tax columns on `order_items`; `products.hsn_code`/`gst_rate_bp` already exist and would finally be read |
| Direct order payment (decision D1) | PAY-06 | New `payments.purpose` enum value `ORDER` (currently a hard-coded single-value `text` column — needs converting to a real enum or widening the literal union) |
| Settlement ledger (decision D6) | FIN-01/02 | New append-only `settlement_entries` (or similar) table; new `payouts`/`payout_batches` tables, modelled on `shop_payments`'s immutable-ledger-plus-reversal shape |
| Stock-threshold and MRP screens | INV-03, CAT-07/08 | **No schema change** — `shop_products.low_stock_threshold`/`reorder_level`, `products.mrp_paise`/`gtin`/`hsn_code`, and `stock_alerts`/`product_mrp_history` already exist from migration `0014`; only service wiring and UI are missing |
| Marketing consent + suppression (decision D9) | MKT-03 | New `marketing_suppressions` table; `user_consents.consent_type = 'MARKETING_COMMUNICATIONS'` already exists as a value |

## 4. A specific constraint worth flagging: enum additions

Postgres cannot add a value to an `ENUM` type and use that same value in the **same transaction** (`ALTER TYPE ... ADD VALUE` must be committed before the value is usable). Drizzle's migration generator handles this correctly when it detects an enum change (splits it into its own migration), but any hand-written SQL for the `user_role`, `order_status`, or similar enum extensions must follow the same two-step shape: one migration that only adds the enum value, applied and committed, before any migration that writes rows using it.

## 5. Rollback

No down-migrations exist in this project (confirmed: `DEPLOYMENT.md` §9 states this as policy, and no `drizzle/*down*` files exist). Rollback of a **code** deploy is redeploying the previous commit — always safe, since new columns/tables are additive and old code simply doesn't reference them.

Rollback of a **schema** change needs hand-written reverse SQL, written and tested *before* the forward migration is applied to test or live — not improvised afterward. For every migration in §3 above, the reverse is one of:
- Drop the new table (safe if nothing has written to it yet).
- Drop the new column (safe if nothing has written to it yet; **not** safe once real data exists in it — that's a real data-loss action requiring the same confirmation discipline as any destructive step).
- An enum value, once added, **cannot be removed** without recreating the type — if a new enum value turns out to be wrong, the practical rollback is "stop using it in code," not "remove it from the database."

For a rollback that needs restoring from backup (not just redeploying), the app must go into maintenance mode first — restoring over a live wallet system loses real transactions, exactly as `DEPLOYMENT.md` §9 already warns.

## 6. What this audit did NOT do

No migration was written or applied to any Neon database (test or live). All schema verification in this audit ran against a disposable local Postgres 16 cluster (`127.0.0.1:54329`, started and stopped by `scripts/pmd/local-pg.ps1`, never touched by anything outside this project). Applying any of §3's changes to test or live requires the same explicit go-ahead the user has required for every prior database action on this project (see the project's own established practice: pilot → validate → explicit go-ahead → apply to staging → apply to live only on a further explicit instruction).
